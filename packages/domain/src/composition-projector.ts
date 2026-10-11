import { randomUUID } from 'node:crypto';
import { and, asc, eq, getTableColumns, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import {
  compositionAnimationBindings,
  compositionAudioRegions,
  compositionCaptionSpans,
  compositionEffectInstances,
  compositionVisualObjects,
  projectObjectLocks,
  projectOpLog,
  projectSequences,
  projects,
  referenceEdges,
  sequenceClips,
  sequenceTracks,
} from '@ancs/db';
import { ApiFailure, ERROR_CODES } from '@ancs/contracts';

/**
 * 组合投影器（V5 §6.2，M2）：组合表的**唯一写入方**，并把每批写入追加到 `project_op_log`。
 *
 * - 写入立即执行（同一事务内后续读取可见），同时记录物化变更（`put` 完整行 / `delete` id）；
 * - `commit` 追加一行日志并维护引用图（`reference_edges`）；
 * - 首次写入前惰性写入 `BASELINE`（日志启用前的组合状态），保证"日志折叠 = 投影表"；
 * - 调用方必须先持有项目行锁（`select ... for update`），日志位置与 revision 因此线性化。
 * 其他模块不得直接写这些表（arch-check R11）。
 */

export const PROJECTED_TABLES = {
  sequence: projectSequences,
  track: sequenceTracks,
  clip: sequenceClips,
  visualObject: compositionVisualObjects,
  effect: compositionEffectInstances,
  animation: compositionAnimationBindings,
  caption: compositionCaptionSpans,
  audioRegion: compositionAudioRegions,
  objectLock: projectObjectLocks,
} as const;

export type ProjectedEntity = keyof typeof PROJECTED_TABLES;
type ProjectedTable<E extends ProjectedEntity> = (typeof PROJECTED_TABLES)[E];
export type ProjectedRow<E extends ProjectedEntity> = ProjectedTable<E>['$inferSelect'];
export type ProjectedInsert<E extends ProjectedEntity> = ProjectedTable<E>['$inferInsert'];

/** 父在前：插入/重建按此顺序，清空按逆序（不依赖外键级联）。 */
export const PROJECTED_ENTITY_ORDER: readonly ProjectedEntity[] = [
  'sequence', 'track', 'clip', 'visualObject', 'effect', 'animation', 'caption', 'audioRegion', 'objectLock',
];

export type ProjectionChange =
  | { entity: ProjectedEntity; type: 'put'; row: Record<string, unknown> }
  | { entity: ProjectedEntity; type: 'delete'; id: string };

export type OpLogSource = 'EDIT' | 'COMPENSATION' | 'DIRECT' | 'MIGRATION';

export interface ProjectorScope {
  workspaceId: string;
  projectId: string;
}

export interface OpLogActor {
  type: string;
  id: string | null;
}

interface ScopedColumns {
  table: PgTable;
  id: PgColumn;
  workspaceId: PgColumn;
  projectId: PgColumn;
  timestampKeys: readonly string[];
}

const columnsOf = (entity: ProjectedEntity): ScopedColumns => {
  const table = PROJECTED_TABLES[entity] as unknown as PgTable;
  const columns = getTableColumns(table) as Record<string, PgColumn>;
  return {
    table,
    id: columns['id']!,
    workspaceId: columns['workspaceId']!,
    projectId: columns['projectId']!,
    timestampKeys: Object.entries(columns).filter(([, column]) => column.columnType === 'PgTimestamp').map(([key]) => key),
  };
};

const SCOPED = new Map<ProjectedEntity, ScopedColumns>(PROJECTED_ENTITY_ORDER.map((entity) => [entity, columnsOf(entity)]));
const scoped = (entity: ProjectedEntity): ScopedColumns => SCOPED.get(entity)!;

/** 行 → 可入 jsonb 的形状（Date → ISO 字符串；其余原样）。 */
export function serializeProjectedRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value]));
}

/** jsonb 形状 → 可写回表的行（时间戳列还原为 Date）。 */
export function deserializeProjectedRow(entity: ProjectedEntity, row: Record<string, unknown>): Record<string, unknown> {
  const { timestampKeys } = scoped(entity);
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    timestampKeys.includes(key) && typeof value === 'string' ? new Date(value) : value,
  ]));
}

const inScope = (entity: ProjectedEntity, scope: ProjectorScope): SQL => {
  const columns = scoped(entity);
  return and(eq(columns.workspaceId, scope.workspaceId), eq(columns.projectId, scope.projectId))!;
};

/** 读出项目当前全部投影行（按实体顺序、id 排序；用于基线与校验）。 */
export async function readProjectionRows(tx: NodePgDatabase, scope: ProjectorScope): Promise<Map<ProjectedEntity, Map<string, Record<string, unknown>>>> {
  const result = new Map<ProjectedEntity, Map<string, Record<string, unknown>>>();
  for (const entity of PROJECTED_ENTITY_ORDER) {
    const columns = scoped(entity);
    const rows = await tx.select().from(columns.table).where(inScope(entity, scope)).orderBy(asc(columns.id)) as Record<string, unknown>[];
    result.set(entity, new Map(rows.map((row) => [String(row['id']), serializeProjectedRow(row)])));
  }
  return result;
}

const assertRowScope = (entity: ProjectedEntity, row: Record<string, unknown>, scope: ProjectorScope): void => {
  if (row['workspaceId'] !== scope.workspaceId || row['projectId'] !== scope.projectId) {
    throw new ApiFailure(ERROR_CODES.INTERNAL, `projector scope mismatch for ${entity}`, 500);
  }
};

export class CompositionProjector {
  readonly changes: ProjectionChange[] = [];
  private nextPosition: number | null = null;

  constructor(readonly tx: NodePgDatabase, readonly scope: ProjectorScope) {}

  /** 打开投影器并锁定项目行（直接写入与迁移路径使用；编辑路径已在事务开头加锁）。 */
  static async open(tx: NodePgDatabase, scope: ProjectorScope): Promise<CompositionProjector> {
    const locked = await tx.execute(sql`select id from projects where id = ${scope.projectId} and workspace_id = ${scope.workspaceId} for update`);
    if (locked.rows.length === 0) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'project not found', 404);
    return new CompositionProjector(tx, scope);
  }

  /**
   * 日志启用前已有的组合状态写为 BASELINE（只在该项目尚无日志时发生一次）。
   * `revision` 为基线对应的项目 revision：首次写入前读取当前值；在 commit 时才补齐（本批无组合写入）则用本批 baseRevision。
   */
  private async ensureBaseline(revision?: number): Promise<number> {
    if (this.nextPosition !== null) return this.nextPosition;
    const rows = await this.tx.select({ max: sql<number | null>`max(${projectOpLog.position})` })
      .from(projectOpLog).where(eq(projectOpLog.projectId, this.scope.projectId));
    const max = rows[0]?.max;
    if (max !== null && max !== undefined) {
      this.nextPosition = Number(max) + 1;
      return this.nextPosition;
    }
    const current = await readProjectionRows(this.tx, this.scope);
    const baseline: ProjectionChange[] = [];
    for (const [entity, byId] of current) for (const row of byId.values()) baseline.push({ entity, type: 'put', row });
    const baselineRevision = revision ?? await this.currentRevision();
    await this.tx.insert(projectOpLog).values({
      id: `opl_${randomUUID()}`,
      workspaceId: this.scope.workspaceId,
      projectId: this.scope.projectId,
      position: 1,
      revision: baselineRevision,
      baseRevision: baselineRevision,
      source: 'BASELINE',
      operations: [],
      changes: baseline,
      actorType: 'SYSTEM',
      actorId: null,
    });
    await maintainReferenceEdges(this.tx, this.scope, baseline, 1);
    this.nextPosition = 2;
    return this.nextPosition;
  }

  private async currentRevision(): Promise<number> {
    const rows = await this.tx.select({ revision: projects.revision }).from(projects).where(eq(projects.id, this.scope.projectId)).limit(1);
    const revision = rows[0]?.revision;
    if (revision === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'project not found', 404);
    return revision;
  }

  async insert<E extends ProjectedEntity>(entity: E, values: ProjectedInsert<E>): Promise<ProjectedRow<E>> {
    const [row] = await this.insertMany(entity, [values]);
    return row!;
  }

  async insertMany<E extends ProjectedEntity>(entity: E, values: readonly ProjectedInsert<E>[]): Promise<ProjectedRow<E>[]> {
    if (values.length === 0) return [];
    for (const value of values) assertRowScope(entity, value as Record<string, unknown>, this.scope);
    await this.ensureBaseline();
    const rows = await this.tx.insert(scoped(entity).table).values(values as never).returning() as Record<string, unknown>[];
    for (const row of rows) this.changes.push({ entity, type: 'put', row: serializeProjectedRow(row) });
    return rows as ProjectedRow<E>[];
  }

  /** 主键已存在则跳过（可重入的迁移步骤用）；只记录实际插入的行。 */
  async insertManyIfAbsent<E extends ProjectedEntity>(entity: E, values: readonly ProjectedInsert<E>[]): Promise<ProjectedRow<E>[]> {
    if (values.length === 0) return [];
    for (const value of values) assertRowScope(entity, value as Record<string, unknown>, this.scope);
    await this.ensureBaseline();
    const columns = scoped(entity);
    const rows = await this.tx.insert(columns.table).values(values as never).onConflictDoNothing({ target: columns.id }).returning() as Record<string, unknown>[];
    for (const row of rows) this.changes.push({ entity, type: 'put', row: serializeProjectedRow(row) });
    return rows as ProjectedRow<E>[];
  }

  /** 按 id 更新本项目内的一行；不存在返回 null。 */
  async update<E extends ProjectedEntity>(entity: E, id: string, set: Partial<ProjectedInsert<E>>): Promise<ProjectedRow<E> | null> {
    await this.ensureBaseline();
    const columns = scoped(entity);
    const rows = await this.tx.update(columns.table).set(set as never)
      .where(and(eq(columns.id, id), inScope(entity, this.scope))).returning() as Record<string, unknown>[];
    const row = rows[0];
    if (row === undefined) return null;
    this.changes.push({ entity, type: 'put', row: serializeProjectedRow(row) });
    return row as ProjectedRow<E>;
  }

  async delete(entity: ProjectedEntity, id: string): Promise<boolean> {
    return (await this.deleteWhere(entity, eq(scoped(entity).id, id))) > 0;
  }

  /** 删除本项目内满足条件的行（无条件 = 该实体全部行）。 */
  async deleteWhere(entity: ProjectedEntity, condition?: SQL): Promise<number> {
    await this.ensureBaseline();
    const columns = scoped(entity);
    const where = condition === undefined ? inScope(entity, this.scope) : and(condition, inScope(entity, this.scope));
    const rows = await this.tx.delete(columns.table).where(where).returning({ id: columns.id }) as { id: string }[];
    for (const row of rows) this.changes.push({ entity, type: 'delete', id: row.id });
    return rows.length;
  }

  /** 对象锁按 (project, objectKind, objectId) 唯一：存在则更新维度/原因，否则插入。 */
  async putObjectLock(values: ProjectedInsert<'objectLock'>): Promise<ProjectedRow<'objectLock'>> {
    assertRowScope('objectLock', values as Record<string, unknown>, this.scope);
    await this.ensureBaseline();
    const rows = await this.tx.insert(projectObjectLocks).values(values).onConflictDoUpdate({
      target: [projectObjectLocks.projectId, projectObjectLocks.objectKind, projectObjectLocks.objectId],
      set: { dimensions: values.dimensions, reason: values.reason ?? null, updatedAt: values.updatedAt ?? new Date() },
    }).returning();
    const row = rows[0]!;
    this.changes.push({ entity: 'objectLock', type: 'put', row: serializeProjectedRow(row) });
    return row;
  }

  /**
   * 追加日志行并维护引用图。
   * EDIT/COMPENSATION 每个被接受的批次都记录（即使只改了 Scene），使 revision 与日志一一对应；
   * DIRECT/MIGRATION 无变更时不记录。返回日志位置（未记录时为 null）。
   */
  async commit(meta: {
    source: OpLogSource;
    operations: unknown;
    baseRevision: number;
    revision: number;
    actor: OpLogActor;
  }): Promise<number | null> {
    if (this.changes.length === 0 && (meta.source === 'DIRECT' || meta.source === 'MIGRATION')) return null;
    const position = await this.ensureBaseline(meta.baseRevision);
    await this.tx.insert(projectOpLog).values({
      id: `opl_${randomUUID()}`,
      workspaceId: this.scope.workspaceId,
      projectId: this.scope.projectId,
      position,
      revision: meta.revision,
      baseRevision: meta.baseRevision,
      source: meta.source,
      operations: meta.operations,
      changes: this.changes,
      actorType: meta.actor.type,
      actorId: meta.actor.id,
    });
    await maintainReferenceEdges(this.tx, this.scope, this.changes, position);
    this.nextPosition = position + 1;
    this.changes.length = 0;
    return position;
  }

  /** 直接写入（非编辑请求）：项目 revision +1 后记录为 DIRECT。 */
  async commitDirect(operations: unknown, actor: OpLogActor): Promise<number | null> {
    if (this.changes.length === 0) return null;
    const base = await this.currentRevision();
    await this.tx.update(projects).set({ revision: base + 1, updatedAt: new Date() }).where(eq(projects.id, this.scope.projectId));
    return this.commit({ source: 'DIRECT', operations, baseRevision: base, revision: base + 1, actor });
  }
}

// ── 引用图 ───────────────────────────────────────────────

/** 当前维护的引用：片段 → 素材版本。 */
const referenceTargetsOf = (change: ProjectionChange): { fromKind: string; toKind: string; toId: string | null } | null => {
  if (change.entity !== 'clip') return null;
  if (change.type === 'delete') return { fromKind: 'CLIP', toKind: 'ASSET_VERSION', toId: null };
  const target = change.row['assetVersionId'];
  return { fromKind: 'CLIP', toKind: 'ASSET_VERSION', toId: typeof target === 'string' ? target : null };
};

/** 按每个对象在本批中的**最终**状态开/关引用边（批内是原子的，中间态不留边）。 */
export async function maintainReferenceEdges(
  tx: NodePgDatabase,
  scope: ProjectorScope,
  changes: readonly ProjectionChange[],
  position: number,
): Promise<void> {
  const finalByObject = new Map<string, { fromKind: string; fromId: string; toKind: string; toId: string | null }>();
  for (const change of changes) {
    const target = referenceTargetsOf(change);
    if (target === null) continue;
    const fromId = change.type === 'delete' ? change.id : String(change.row['id']);
    finalByObject.set(`${target.fromKind}:${fromId}`, { ...target, fromId });
  }
  for (const edge of finalByObject.values()) {
    const open = await tx.select({ id: referenceEdges.id, toId: referenceEdges.toId }).from(referenceEdges).where(and(
      eq(referenceEdges.projectId, scope.projectId),
      eq(referenceEdges.fromKind, edge.fromKind),
      eq(referenceEdges.fromId, edge.fromId),
      eq(referenceEdges.toKind, edge.toKind),
      isNull(referenceEdges.closedPosition),
    ));
    const stale = open.filter((row) => row.toId !== edge.toId).map((row) => row.id);
    if (stale.length > 0) {
      await tx.update(referenceEdges).set({ closedPosition: position }).where(inArray(referenceEdges.id, stale));
    }
    if (edge.toId !== null && !open.some((row) => row.toId === edge.toId)) {
      await tx.insert(referenceEdges).values({
        id: `ref_${randomUUID()}`,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        fromKind: edge.fromKind,
        fromId: edge.fromId,
        toKind: edge.toKind,
        toId: edge.toId,
        openedPosition: position,
      });
    }
  }
}

/**
 * 直接写入（不经编辑请求的构造型 API，如 createSequence/createTrack）：
 * 在单事务内锁项目行 → 写入 → revision +1 → 记录为 DIRECT 日志行。
 */
export async function writeCompositionDirect<T>(
  db: NodePgDatabase,
  scope: ProjectorScope,
  operation: Record<string, unknown>,
  write: (projector: CompositionProjector) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const projector = await CompositionProjector.open(tx as unknown as NodePgDatabase, scope);
    const result = await write(projector);
    await projector.commitDirect([operation], { type: 'SYSTEM', id: null });
    return result;
  });
}

// ── 重建与校验（日志是权威，投影表可由日志完整重建） ─────────────────

export type ProjectionRows = Map<ProjectedEntity, Map<string, Record<string, unknown>>>;

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, canonicalValue(item)]));
  }
  return value;
};
const canonicalJson = (value: unknown): string => JSON.stringify(canonicalValue(value));

const emptyProjection = (): ProjectionRows => new Map(PROJECTED_ENTITY_ORDER.map((entity) => [entity, new Map()]));

/** 按位置折叠项目操作日志；该项目尚无日志时返回 null（投影即自身基线）。 */
export async function foldOpLog(tx: NodePgDatabase, scope: ProjectorScope): Promise<{ entries: number; rows: ProjectionRows } | null> {
  const entries = await tx.select({ position: projectOpLog.position, source: projectOpLog.source, changes: projectOpLog.changes })
    .from(projectOpLog)
    .where(and(eq(projectOpLog.workspaceId, scope.workspaceId), eq(projectOpLog.projectId, scope.projectId)))
    .orderBy(asc(projectOpLog.position));
  if (entries.length === 0) return null;
  entries.forEach((entry, index) => {
    if (entry.position !== index + 1 || (index === 0) !== (entry.source === 'BASELINE')) {
      throw new ApiFailure(ERROR_CODES.INTERNAL, `op log is not contiguous at position ${String(entry.position)}`, 500);
    }
  });
  const rows = emptyProjection();
  for (const entry of entries) {
    for (const change of entry.changes as ProjectionChange[]) {
      const table = rows.get(change.entity);
      if (table === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, `op log has unknown entity ${String(change.entity)}`, 500);
      if (change.type === 'put') table.set(String(change.row['id']), change.row);
      else table.delete(change.id);
    }
  }
  return { entries: entries.length, rows };
}

export interface ProjectionDifference {
  entity: ProjectedEntity;
  id: string;
  /** MISSING = 日志有、表没有；UNEXPECTED = 表有、日志没有；DIFFERENT = 内容不同 */
  kind: 'MISSING' | 'UNEXPECTED' | 'DIFFERENT';
}

export function diffProjectionRows(expected: ProjectionRows, actual: ProjectionRows): ProjectionDifference[] {
  const differences: ProjectionDifference[] = [];
  for (const entity of PROJECTED_ENTITY_ORDER) {
    const want = expected.get(entity) ?? new Map();
    const have = actual.get(entity) ?? new Map();
    for (const [id, row] of want) {
      const current = have.get(id);
      if (current === undefined) differences.push({ entity, id, kind: 'MISSING' });
      else if (canonicalJson(current) !== canonicalJson(row)) differences.push({ entity, id, kind: 'DIFFERENT' });
    }
    for (const id of have.keys()) if (!want.has(id)) differences.push({ entity, id, kind: 'UNEXPECTED' });
  }
  return differences;
}

/** 只读校验：日志折叠结果与投影表逐行比较。 */
export async function verifyCompositionProjection(
  db: NodePgDatabase,
  scope: ProjectorScope,
): Promise<{ logged: boolean; entries: number; differences: ProjectionDifference[] }> {
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as NodePgDatabase;
    await txDb.execute(sql`set transaction isolation level repeatable read`);
    const folded = await foldOpLog(txDb, scope);
    if (folded === null) return { logged: false, entries: 0, differences: [] };
    return { logged: true, entries: folded.entries, differences: diffProjectionRows(folded.rows, await readProjectionRows(txDb, scope)) };
  });
}

/**
 * 运维修复：以日志为准把投影表改回折叠结果（只改有差异的行，不追加日志）。
 * 不清空重建：外部表（如选区锚点）对序列有级联外键，整表删除会误删它们。
 */
export async function rebuildCompositionProjection(
  db: NodePgDatabase,
  scope: ProjectorScope,
): Promise<{ logged: boolean; repaired: ProjectionDifference[] }> {
  return db.transaction(async (tx) => {
    const txDb = tx as unknown as NodePgDatabase;
    await CompositionProjector.open(txDb, scope);
    const folded = await foldOpLog(txDb, scope);
    if (folded === null) return { logged: false, repaired: [] };
    const differences = diffProjectionRows(folded.rows, await readProjectionRows(txDb, scope));
    const rowOf = (difference: ProjectionDifference) => deserializeProjectedRow(difference.entity, folded.rows.get(difference.entity)!.get(difference.id)!);

    for (const entity of [...PROJECTED_ENTITY_ORDER].reverse()) {
      const ids = differences.filter((item) => item.entity === entity && item.kind === 'UNEXPECTED').map((item) => item.id);
      if (ids.length > 0) await txDb.delete(scoped(entity).table).where(and(inArray(scoped(entity).id, ids), inScope(entity, scope)));
    }
    // 轨道位置唯一：先把要改的既有轨道移出取值范围，再插入缺失行、写回最终内容。
    for (const difference of differences.filter((item) => item.entity === 'track' && item.kind === 'DIFFERENT')) {
      await txDb.update(sequenceTracks).set({ position: sql`${sequenceTracks.position} + 1000000` })
        .where(and(eq(sequenceTracks.id, difference.id), inScope('track', scope)));
    }
    for (const entity of PROJECTED_ENTITY_ORDER) {
      const missing = differences.filter((item) => item.entity === entity && item.kind === 'MISSING').map(rowOf);
      if (missing.length > 0) await txDb.insert(scoped(entity).table).values(missing as never);
    }
    for (const difference of differences.filter((item) => item.kind === 'DIFFERENT')) {
      const { id: _id, ...set } = rowOf(difference);
      await txDb.update(scoped(difference.entity).table).set(set as never)
        .where(and(eq(scoped(difference.entity).id, difference.id), inScope(difference.entity, scope)));
    }
    return { logged: true, repaired: differences };
  });
}
