import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import {
  ApiFailure,
  CMS_ERROR_REASONS,
  ERROR_CODES,
  cmsIngestionRecordSchema,
  type CmsEventContent,
  type CmsIngestionRecord,
} from '@ancs/contracts';
import { channels, cmsIngestions } from '@ancs/db';
import type { DomainDeps } from './channels.js';
import { createContent, createContentFromDocument } from './content.js';
import { createProject } from './projects.js';

/**
 * CMS 摄取服务（P13-06 / §4.2、§88；计划 §8 P13）。
 *
 * - **同一事件重放不重复建项目**：contentHash = 内容字节 sha256；唯一索引
 *   (workspace, source, externalId, contentHash) 命中 → 返回既有摄取（deduped=true）；
 * - **正文变化产生新来源版本**：同 externalId 新 contentHash → 摄取进同一项目为
 *   新 ContentDocument（旧来源版本不被覆盖）；
 * - 机器路径复用人工链路：项目创建（P02-01）/ URL 抓取（P04-01）/ HTML 文档导入（P10-01）。
 */

const toDto = (row: typeof cmsIngestions.$inferSelect): CmsIngestionRecord =>
  cmsIngestionRecordSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    source: row.source,
    externalId: row.externalId,
    contentHash: row.contentHash,
    projectId: row.projectId,
    documentId: row.documentId,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  });

/** CMS 摄取列表（新→旧；状态查询）。 */
export async function listCmsIngestions(
  deps: DomainDeps,
  input: { workspaceId: string },
): Promise<CmsIngestionRecord[]> {
  const rows = await deps.db
    .select()
    .from(cmsIngestions)
    .where(eq(cmsIngestions.workspaceId, input.workspaceId))
    .orderBy(desc(cmsIngestions.createdAt));
  return rows.map(toDto);
}

/** 摄取 CMS 事件（机器建项目 + 内容入库 + 幂等/版本语义）。 */
export async function ingestCmsEvent(
  deps: DomainDeps,
  input: { workspaceId: string; source: string; externalId: string; title: string; channelId: string; content: CmsEventContent; createdBy?: string | null },
): Promise<{ ingestion: CmsIngestionRecord; deduped: boolean; projectId: string; documentId: string; newSourceVersion: boolean }> {
  // 1) 内容字节与哈希（URL 先抓取——hash 基于内容而非链接）
  let bytes: Uint8Array;
  let sourceUrl: string | null = null;
  if (input.content.kind === 'URL') {
    if (deps.articleFetcher === undefined) {
      throw new ApiFailure(ERROR_CODES.INTERNAL, '文章抓取器未配置（DomainDeps.articleFetcher）', 500);
    }
    sourceUrl = input.content.url;
    const fetched = await deps.articleFetcher.fetch({ url: sourceUrl }).catch((error: unknown) => {
      throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, `文章抓取失败：${error instanceof Error ? error.message : String(error)}`.slice(0, 200), 502, {
        reason: CMS_ERROR_REASONS.FETCH_FAILED,
        url: sourceUrl,
      });
    });
    bytes = fetched.bytes;
  } else {
    bytes = new TextEncoder().encode(input.content.html);
  }
  if (bytes.byteLength === 0) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'CMS 事件内容为空（0 字节）', 422, { reason: CMS_ERROR_REASONS.EMPTY_CONTENT });
  }
  const contentHash = createHash('sha256').update(bytes).digest('hex');

  // 2) 重放：同 (workspace, source, externalId, contentHash) → 返回既有摄取（不重复建项目/文档）
  const replayRows = await deps.db
    .select()
    .from(cmsIngestions)
    .where(
      and(
        eq(cmsIngestions.workspaceId, input.workspaceId),
        eq(cmsIngestions.source, input.source),
        eq(cmsIngestions.externalId, input.externalId),
        eq(cmsIngestions.contentHash, contentHash),
      ),
    )
    .limit(1);
  const replay = replayRows[0];
  if (replay !== undefined) {
    return { ingestion: toDto(replay), deduped: true, projectId: replay.projectId, documentId: replay.documentId, newSourceVersion: false };
  }

  // 3) 项目复用：同 externalId 的既有摄取 → 同项目（新来源版本）；首次 → 机器建项目
  const previousRows = await deps.db
    .select()
    .from(cmsIngestions)
    .where(and(eq(cmsIngestions.workspaceId, input.workspaceId), eq(cmsIngestions.source, input.source), eq(cmsIngestions.externalId, input.externalId)))
    .orderBy(desc(cmsIngestions.createdAt))
    .limit(1);
  const previous = previousRows[0];
  let projectId: string;
  if (previous !== undefined) {
    projectId = previous.projectId;
  } else {
    const channelRows = await deps.db
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.id, input.channelId), eq(channels.workspaceId, input.workspaceId)))
      .limit(1);
    if (channelRows[0] === undefined) {
      throw new ApiFailure(ERROR_CODES.NOT_FOUND, '栏目不存在或不属于该工作区', 404, { reason: CMS_ERROR_REASONS.CHANNEL_NOT_FOUND });
    }
    const project = await createProject(deps, {
      workspaceId: input.workspaceId,
      createdBy: input.createdBy ?? undefined,
      input: { title: input.title, channelId: input.channelId },
    });
    projectId = project.id;
  }

  // 4) 内容摄取（复用人工链路：URL → P04-01 抓取；HTML → P10-01 文档导入）
  let documentId: string;
  if (input.content.kind === 'URL') {
    const document = await createContent(deps, {
      workspaceId: input.workspaceId,
      projectId,
      createdBy: input.createdBy ?? null,
      input: { sourceType: 'URL_ARTICLE', url: sourceUrl as string, title: input.title },
    });
    documentId = document.document.id;
  } else {
    const document = await createContentFromDocument(deps, {
      workspaceId: input.workspaceId,
      projectId,
      createdBy: input.createdBy ?? null,
      filename: `${input.externalId}.html`,
      contentType: 'text/html',
      bytes,
      parser: undefined,
      html: input.content.html,
    });
    documentId = document.document.id;
  }

  // 5) 摄取记录落库（唯一索引兜底并发；冲突 = 并发重放 → 重读返回既有）
  const inserted = await deps.db
    .insert(cmsIngestions)
    .values({
      id: `cmsi_${randomUUID()}`,
      workspaceId: input.workspaceId,
      source: input.source,
      externalId: input.externalId,
      contentHash,
      projectId,
      documentId,
      status: previous !== undefined ? 'NEW_SOURCE_VERSION' : 'INGESTED',
    })
    .onConflictDoNothing()
    .returning();
  const row = inserted[0];
  if (row === undefined) {
    const existingRows = await deps.db
      .select()
      .from(cmsIngestions)
      .where(
        and(
          eq(cmsIngestions.workspaceId, input.workspaceId),
          eq(cmsIngestions.source, input.source),
          eq(cmsIngestions.externalId, input.externalId),
          eq(cmsIngestions.contentHash, contentHash),
        ),
      )
      .limit(1);
    const existing = existingRows[0];
    if (existing === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'cms ingestion read failed', 500);
    return { ingestion: toDto(existing), deduped: true, projectId: existing.projectId, documentId: existing.documentId, newSourceVersion: false };
  }
  return {
    ingestion: toDto(row),
    deduped: false,
    projectId,
    documentId,
    newSourceVersion: previous !== undefined,
  };
}
