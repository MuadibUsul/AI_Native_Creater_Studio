import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  ApiFailure,
  CONTENT_CORE_ERROR_REASONS,
  CONTENT_CORE_VERSION,
  ERROR_CODES,
  contentCoreConsistencySchema,
  contentCoreMigrationSchema,
  contentCoreSchema,
  contentCoreStateSchema,
  type ContentCoreConsistency,
  type ContentCoreMigration,
  type ContentCoreState,
} from '@ancs/contracts';
import { claims, contentBlocks, contentCores, contentDocuments, projectSources } from '@ancs/db';
import type { DomainDeps } from './deps.js';

/**
 * Content Core 迁移（P11-01 / 规范 §92—93；计划 §8）。
 *
 * - **派生而非改写**：核心模型 1:1 映射既有 claims / project_sources / content_documents——
 *   不推断 relations（恒空 + note）、不编造 thesis（缺失即 null + note）、facts = factuality==='fact' 投影；
 * - **原文档保留**：全程只读旧结构；核心行追加（project 唯一）；
 * - **幂等**：`inputsDigest` = 迁移输入 canonical JSON 的 sha256；重跑摘要一致 → **复用**（不重写、
 *   不产生新行）；旧数据变化 → 以最新输入重建（迁移记录始终反映最近一次）；
 * - **一致性可核对**：`consistency` 存迁移时计数 + digest；`getProjectContentCoreState` 返回**实时**
 *   原始侧计数供对照（迁移后原始侧漂移可被发现——"迁移前后一致"的直接证据）。
 */

const canonicalize = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) => {
    if (Array.isArray(item)) return item;
    if (typeof item === 'object' && item !== null) {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)));
    }
    return item;
  });

const digestOf = (value: unknown): string => createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');

export async function migrateProjectToContentCore(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string },
): Promise<ContentCoreMigration> {
  // 原始侧（只读；迁移不改写任何旧结构）
  const documentRows = await deps.db
    .select()
    .from(contentDocuments)
    .where(and(eq(contentDocuments.workspaceId, input.workspaceId), eq(contentDocuments.projectId, input.projectId)));
  const claimRows = await deps.db
    .select()
    .from(claims)
    .where(and(eq(claims.workspaceId, input.workspaceId), eq(claims.projectId, input.projectId)));
  const sourceRows = await deps.db
    .select()
    .from(projectSources)
    .where(and(eq(projectSources.workspaceId, input.workspaceId), eq(projectSources.projectId, input.projectId)));

  if (documentRows.length === 0 && claimRows.length === 0 && sourceRows.length === 0) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, '项目无可迁移内容（无文档/声明/来源）', 422, {
      reason: CONTENT_CORE_ERROR_REASONS.NOTHING_TO_MIGRATE,
    });
  }

  // 迁移输入（决定 digest 的全部字段；文本一律原样——不改写）
  const migrationInputs = {
    documents: documentRows
      .map((row) => ({ id: row.id, title: row.title, sourceType: row.sourceType }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    claims: claimRows
      .map((row) => ({
        id: row.id,
        documentId: row.documentId,
        blockId: row.blockId,
        text: row.text,
        factuality: row.factuality,
        sourceIds: row.sourceIds,
        extraction: row.extraction,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    sources: sourceRows
      .map((row) => ({ id: row.id, title: row.title, url: row.url, publisher: row.publisher, excerpt: row.excerpt, snapshotKind: row.snapshotKind }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
  const inputsDigest = digestOf(migrationInputs);

  // 幂等：已有核心且输入未变 → 复用（不重写；迁移记录反映既有事实）
  const existingRows = await deps.db
    .select()
    .from(contentCores)
    .where(eq(contentCores.projectId, input.projectId))
    .limit(1);
  const existing = existingRows[0];
  if (existing !== undefined) {
    const existingConsistency = existing.consistency as ContentCoreConsistency;
    if (existingConsistency.inputsDigest === inputsDigest && existing.schemaVersion === CONTENT_CORE_VERSION) {
      return contentCoreMigrationSchema.parse({
        core: existing.core,
        consistency: existingConsistency,
        reused: true,
        migratedAt: existing.migratedAt.toISOString(),
      });
    }
  }

  // 文档块计数（原文档保留——核心只记引用与规模摘要）
  const blockRows = await deps.db
    .select({ documentId: contentBlocks.documentId })
    .from(contentBlocks)
    .where(eq(contentBlocks.workspaceId, input.workspaceId));
  const blockCounts = new Map<string, number>();
  for (const row of blockRows) {
    blockCounts.set(row.documentId, (blockCounts.get(row.documentId) ?? 0) + 1);
  }

  // 核心（1:1 映射；不推断）
  const notes: string[] = ['迁移为派生映射：声明/来源/文档 1:1 保留，原文档未改动'];
  notes.push('relations 迁移不推断（恒空）——关系建立属后续编辑能力');
  const facts = claimRows
    .filter((row) => row.factuality === 'fact')
    .map((row) => ({ factId: `fact_${row.id}`, claimId: row.id, text: row.text, sourceIds: row.sourceIds }));
  const referencedBy = new Map<string, number>();
  for (const row of claimRows) {
    for (const sourceId of row.sourceIds as string[]) referencedBy.set(sourceId, (referencedBy.get(sourceId) ?? 0) + 1);
  }
  const core = contentCoreSchema.parse({
    schemaVersion: CONTENT_CORE_VERSION,
    projectId: input.projectId,
    thesis: null,
    claims: claimRows.map((row) => {
      const extraction = (row.extraction ?? {}) as { method?: unknown };
      const method = extraction['method'];
      return {
        claimId: row.id,
        documentId: row.documentId,
        blockId: row.blockId,
        text: row.text,
        factuality: row.factuality,
        sourceIds: row.sourceIds as string[],
        extractionMethod: method === 'DETERMINISTIC' || method === 'LLM' || method === 'MANUAL' ? method : null,
      };
    }),
    facts,
    relations: [],
    evidence: sourceRows.map((row) => ({
      sourceId: row.id,
      title: row.title.slice(0, 500),
      url: row.url.slice(0, 1000),
      publisher: row.publisher.slice(0, 200),
      excerpt: row.excerpt.slice(0, 500),
      snapshotKind: row.snapshotKind.slice(0, 40),
      referencedByClaims: referencedBy.get(row.id) ?? 0,
    })),
    documents: documentRows.map((row) => ({
      documentId: row.id,
      title: row.title.slice(0, 300),
      sourceType: row.sourceType.slice(0, 40),
      blockCount: blockCounts.get(row.id) ?? 0,
      claimCount: claimRows.filter((claim) => claim.documentId === row.id).length,
    })),
    notes: notes.map((note) => note.slice(0, 300)),
  });

  const consistency = contentCoreConsistencySchema.parse({
    documentCount: documentRows.length,
    claimCount: claimRows.length,
    factCount: facts.length,
    sourceCount: sourceRows.length,
    inputsDigest,
    checked: ['CLAIMS_PRESERVED_1TO1', 'SOURCES_PRESERVED_1TO1', 'DOCUMENTS_PRESERVED_BY_REFERENCE', 'FACTS_ARE_FACTUALITY_FACT_SUBSET', 'RELATIONS_NOT_INFERRED'],
  });

  const now = new Date();
  if (existing !== undefined) {
    // 输入变化 → 以最新输入重建（更新唯一行；迁移记录 = 最近一次）
    const updated = await deps.db
      .update(contentCores)
      .set({
        schemaVersion: CONTENT_CORE_VERSION,
        core,
        consistency,
        migratedClaimCount: claimRows.length,
        migratedSourceCount: sourceRows.length,
        migratedDocumentCount: documentRows.length,
        migratedAt: now,
      })
      .where(eq(contentCores.id, existing.id))
      .returning();
    const row = updated[0];
    if (row === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'content core update failed', 500);
    return contentCoreMigrationSchema.parse({ core, consistency, reused: false, migratedAt: row.migratedAt.toISOString() });
  }

  const inserted = await deps.db
    .insert(contentCores)
    .values({
      id: `ccr_${createHash('sha256').update(input.projectId).digest('hex').slice(0, 16)}_${now.getTime().toString(36)}`,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      schemaVersion: CONTENT_CORE_VERSION,
      core,
      consistency,
      migratedClaimCount: claimRows.length,
      migratedSourceCount: sourceRows.length,
      migratedDocumentCount: documentRows.length,
      migratedAt: now,
    })
    .returning();
  const row = inserted[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'content core insert failed', 500);
  return contentCoreMigrationSchema.parse({ core, consistency, reused: false, migratedAt: row.migratedAt.toISOString() });
}

/** 核心状态（核心 + 一致性摘要 + **实时**原始侧计数——迁移后原始侧漂移可直接对照发现）。 */
export async function getProjectContentCoreState(deps: DomainDeps, input: { workspaceId: string; projectId: string }): Promise<ContentCoreState> {
  const [coreRows, documentCountRows, claimCountRows, sourceCountRows] = await Promise.all([
    deps.db.select().from(contentCores).where(eq(contentCores.projectId, input.projectId)).limit(1),
    deps.db.select({ id: contentDocuments.id }).from(contentDocuments).where(and(eq(contentDocuments.workspaceId, input.workspaceId), eq(contentDocuments.projectId, input.projectId))),
    deps.db.select({ id: claims.id }).from(claims).where(and(eq(claims.workspaceId, input.workspaceId), eq(claims.projectId, input.projectId))),
    deps.db.select({ id: projectSources.id }).from(projectSources).where(and(eq(projectSources.workspaceId, input.workspaceId), eq(projectSources.projectId, input.projectId))),
  ]);
  const row = coreRows[0];
  return contentCoreStateSchema.parse({
    core: row === undefined ? null : (row.core as ContentCoreState['core']),
    consistency: row === undefined ? null : (row.consistency as ContentCoreConsistency),
    liveCounts: {
      documentCount: documentCountRows.length,
      claimCount: claimCountRows.length,
      sourceCount: sourceCountRows.length,
    },
    migratedAt: row?.migratedAt.toISOString() ?? null,
  });
}
