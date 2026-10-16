import { and, desc, eq, ilike, inArray, isNull, or } from 'drizzle-orm';
import {
  ApiFailure,
  BUILTIN_COMPONENT_CATALOG,
  ERROR_CODES,
  SEARCH_ERROR_REASONS,
  searchEntityKindSchema,
  searchResponseSchema,
  type SearchResponse,
  type SearchResultItem,
} from '@ancs/contracts';
import { assets, projectSources, projects, scenes } from '@ancs/db';
import type { DomainDeps } from './deps.js';

/**
 * 工作区搜索（P10-06 / 规范 §62；REQ-62-01）。
 *
 * - **租户内**：PROJECT/SCENE/SOURCE/ASSET 一律按 workspaceId 限定；COMPONENT 为内置目录（非租户数据）；
 * - **删除状态**：项目软删（projects.deletedAt）与其场景/来源不入结果；资产软删（assets.deletedAt）排除；
 * - MVP 使用 PG `ILIKE`（REQ-62-01 允许；专用搜索引擎随规模引入）——命中字段随结果返回（可解释）。
 */

const PER_KIND_LIMIT = 10;
const TOTAL_LIMIT = 40;

const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (match) => `\\${match}`);

export async function searchWorkspace(
  deps: DomainDeps,
  input: { workspaceId: string; query: string; kinds?: string[]; limit?: number },
): Promise<SearchResponse> {
  const query = input.query.trim();
  if (query.length < 2) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, '搜索词过短（至少 2 个字符）', 400, { reason: SEARCH_ERROR_REASONS.QUERY_TOO_SHORT, minLength: 2 });
  }
  const kinds = (input.kinds === undefined || input.kinds.length === 0 ? searchEntityKindSchema.options : input.kinds.map((kind) => searchEntityKindSchema.parse(kind))) as readonly string[];
  const perKind = Math.min(Math.max(input.limit ?? PER_KIND_LIMIT, 1), 25);
  const pattern = `%${escapeLike(query)}%`;
  const items: SearchResultItem[] = [];
  const totals: Record<string, number> = {};

  if (kinds.includes('PROJECT')) {
    const rows = await deps.db
      .select({ id: projects.id, title: projects.title, status: projects.status, updatedAt: projects.updatedAt })
      .from(projects)
      .where(and(eq(projects.workspaceId, input.workspaceId), isNull(projects.deletedAt), ilike(projects.title, pattern)))
      .orderBy(desc(projects.updatedAt))
      .limit(perKind);
    totals['PROJECT'] = rows.length;
    for (const row of rows) {
      items.push({ kind: 'PROJECT', id: row.id, title: row.title, subtitle: row.status, projectId: row.id, path: `/w/${input.workspaceId}/p/${row.id}/storyboard`, matchedFields: ['title'] });
    }
  }

  if (kinds.includes('SCENE')) {
    const rows = await deps.db
      .select({ id: scenes.id, projectId: scenes.projectId, sceneType: scenes.sceneType, narration: scenes.narration, visualIntent: scenes.visualIntent, position: scenes.position })
      .from(scenes)
      .innerJoin(projects, eq(projects.id, scenes.projectId))
      .where(and(eq(scenes.workspaceId, input.workspaceId), isNull(projects.deletedAt), or(ilike(scenes.narration, pattern), ilike(scenes.visualIntent, pattern), ilike(scenes.sceneType, pattern))))
      .orderBy(scenes.projectId, scenes.position)
      .limit(perKind);
    totals['SCENE'] = rows.length;
    for (const row of rows) {
      const matched: string[] = [];
      if (row.narration.toLowerCase().includes(query.toLowerCase())) matched.push('narration');
      if (row.visualIntent.toLowerCase().includes(query.toLowerCase())) matched.push('visualIntent');
      if (row.sceneType.toLowerCase().includes(query.toLowerCase())) matched.push('sceneType');
      const title = row.narration.trim() !== '' ? row.narration.trim().slice(0, 120) : row.visualIntent.trim() !== '' ? row.visualIntent.trim().slice(0, 120) : row.sceneType;
      items.push({ kind: 'SCENE', id: row.id, title, subtitle: row.sceneType, projectId: row.projectId, path: `/w/${input.workspaceId}/p/${row.projectId}/editor/${row.id}`, matchedFields: matched });
    }
  }

  if (kinds.includes('SOURCE')) {
    const rows = await deps.db
      .select({ id: projectSources.id, projectId: projectSources.projectId, title: projectSources.title, publisher: projectSources.publisher, excerpt: projectSources.excerpt })
      .from(projectSources)
      .innerJoin(projects, eq(projects.id, projectSources.projectId))
      .where(
        and(
          eq(projectSources.workspaceId, input.workspaceId),
          isNull(projects.deletedAt),
          or(ilike(projectSources.title, pattern), ilike(projectSources.publisher, pattern), ilike(projectSources.excerpt, pattern), ilike(projectSources.url, pattern)),
        ),
      )
      .limit(perKind);
    totals['SOURCE'] = rows.length;
    for (const row of rows) {
      items.push({ kind: 'SOURCE', id: row.id, title: row.title, subtitle: row.publisher, projectId: row.projectId, path: `/w/${input.workspaceId}/p/${row.projectId}/script`, matchedFields: ['title/publisher/excerpt/url'] });
    }
  }

  if (kinds.includes('ASSET')) {
    // MVP：取工作区未删资产（上限 300）后在内存中按 assetType / metadata.title 过滤——
    // 与 REQ-62-01 的"MVP 可 PG FTS、未来专用搜索"口径一致；超大库再引入 jsonb 索引/专用引擎。
    const rows = await deps.db
      .select({ id: assets.id, projectId: assets.projectId, assetType: assets.assetType, origin: assets.origin, metadata: assets.metadata })
      .from(assets)
      .where(and(eq(assets.workspaceId, input.workspaceId), isNull(assets.deletedAt)))
      .orderBy(desc(assets.updatedAt))
      .limit(300);
    const lowered = query.toLowerCase();
    const matchedRows = rows
      .map((row) => {
        const metadata = row.metadata as Record<string, unknown>;
        const title = typeof metadata['title'] === 'string' ? metadata['title'] : null;
        const matchedFields: string[] = [];
        if (row.assetType.toLowerCase().includes(lowered)) matchedFields.push('assetType');
        if (title !== null && title.toLowerCase().includes(lowered)) matchedFields.push('metadata.title');
        return { row, title, matchedFields };
      })
      .filter((entry) => entry.matchedFields.length > 0)
      .slice(0, perKind);
    totals['ASSET'] = matchedRows.length;
    for (const { row, title, matchedFields } of matchedRows) {
      items.push({
        kind: 'ASSET',
        id: row.id,
        title: (title ?? row.assetType).slice(0, 200),
        subtitle: `${row.assetType} · ${row.origin}`,
        projectId: row.projectId,
        path: row.projectId === null ? null : `/w/${input.workspaceId}/p/${row.projectId}/assets`,
        matchedFields,
      });
    }
  }

  if (kinds.includes('COMPONENT')) {
    const lowered = query.toLowerCase();
    const matched = BUILTIN_COMPONENT_CATALOG.filter(
      (entry) => entry.type.toLowerCase().includes(lowered) || entry.title.toLowerCase().includes(lowered) || entry.description.toLowerCase().includes(lowered),
    ).slice(0, perKind);
    totals['COMPONENT'] = matched.length;
    for (const entry of matched) {
      items.push({ kind: 'COMPONENT', id: entry.type, title: entry.title, subtitle: entry.type, projectId: null, path: null, matchedFields: ['type/title/description'] });
    }
  }

  const truncated = items.length > TOTAL_LIMIT;
  return searchResponseSchema.parse({ query, items: items.slice(0, TOTAL_LIMIT), totals, truncated });
}

/** 供 Graph 导出复用的场景引用来源收集（与 P10-05 同一口径：冻结/当前快照的 sourceBindings）。 */
export async function loadReferencedSources(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; sourceIds: readonly string[] },
): Promise<{ sourceId: string; title: string; url: string; publisher: string; author: string | null; excerpt: string; snapshotKind: string; referencedBySceneIds: string[] }[]> {
  const unique = [...new Set(input.sourceIds)];
  if (unique.length === 0) return [];
  const rows = await deps.db
    .select()
    .from(projectSources)
    .where(and(eq(projectSources.workspaceId, input.workspaceId), inArray(projectSources.id, unique)));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return unique
    .filter((sourceId) => byId.has(sourceId))
    .map((sourceId) => {
      const row = byId.get(sourceId);
      if (row === undefined) throw new Error('unreachable');
      return {
        sourceId,
        title: row.title.slice(0, 500),
        url: row.url.slice(0, 1000),
        publisher: row.publisher.slice(0, 200),
        author: row.author,
        excerpt: row.excerpt.slice(0, 500),
        snapshotKind: row.snapshotKind.slice(0, 40),
        referencedBySceneIds: [] as string[],
      };
    });
}
