import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import {
  ApiFailure,
  CONTENT_INPUT_ERROR_REASONS,
  ERROR_CODES,
  contentDocumentSchema,
  contentDocumentRecordSchema,
  contentSourceSchema,
  type ArticleFetcher,
  type ContentBlock,
  type ContentDocument,
  type ContentDocumentRecord,
  type ContentSource,
  type CreateContentRequest,
  type UpdateSourceRequest,
} from '@ancs/contracts';
import { contentBlocks, contentDocuments, projectSources, projects } from '@ancs/db';
import { assertSafeUrl, decodeContentBytes, detectLanguage, extractBlocksFromHtml, extractBlocksFromText } from './content-extract.js';
import type { DomainDeps } from './channels.js';

/**
 * 内容归一化服务（P04-01 / 规范 §7；计划 P04-01）。
 *
 * - 任何输入（URL 文章 / 粘贴正文 / 手写脚本）都先转统一 ContentDocument——**不得直接发给 LLM**；
 * - CLAIMS/CITATIONS/TABLES/FIGURES 的抽取填充属 P04-02（本任务建立结构与表，`claims` 留空数组）；
 * - 抓取是 I/O（ArticleFetcher 注入，逐跳 SSRF 校验由实现方保证）；
 * - **明确结果**：URL 异常 / 安全限制 / 空正文 / 错误编码 / 过大 / 不支持类型 → 具体 code + reason（计划验收）。
 */

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

function requireFetcher(deps: DomainDeps): ArticleFetcher {
  if (deps.articleFetcher === undefined) {
    throw new ApiFailure(ERROR_CODES.INTERNAL, '文章抓取器未配置（DomainDeps.articleFetcher）', 500);
  }
  return deps.articleFetcher;
}

const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * 把"内容哈希"块 ID 作用域到本文档：`blk_<docShort>_<digest>[_n]`。
 * 原因：块 ID 是主键，而内容哈希在不同文档间会重复（同一标题/段落出现在多篇文档）——
 * 文档内保持稳定（供 Citation/Scene 引用），跨文档保证唯一。
 */
function scopeBlocks(documentId: string, blocks: ContentBlock[]): ContentBlock[] {
  const prefix = documentId.replace(/^doc_/, '').replace(/[^a-f0-9]/gi, '').slice(0, 12);
  return blocks.map((block) => ({
    ...block,
    id: block.id.startsWith('blk_') ? `blk_${prefix}_${block.id.slice(4)}` : `${prefix}_${block.id}`,
  }));
}

async function assertProjectWritable(deps: DomainDeps, workspaceId: string, projectId: string): Promise<void> {
  const rows = await deps.db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
    .limit(1);
  if (rows.length === 0) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'project not found', 404);
}

const isHtml = (contentType: string | null): boolean =>
  contentType !== null && /(text\/html|application\/xhtml\+xml)/i.test(contentType);
const isPlain = (contentType: string | null): boolean => contentType !== null && /(text\/plain|text\/markdown)/i.test(contentType);

function hostAsPublisher(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
}

/** 归一化后落库（文档头 + 块；同事务）。 */
async function persistDocument(
  deps: DomainDeps,
  input: {
    workspaceId: string;
    projectId: string;
    createdBy: string | null;
    sourceType: 'URL_ARTICLE' | 'PASTED_TEXT' | 'MANUAL_SCRIPT';
    sourceId: string | null;
    title: string;
    language: string;
    author: string | null;
    sourceUrl: string | null;
    publishedAt: string | null;
    blocks: ContentBlock[];
    normalization: ContentDocumentRecord['normalization'];
  },
): Promise<ContentDocumentRecord> {
  const documentId = `doc_${randomUUID()}`;
  const scopedBlocks = scopeBlocks(documentId, input.blocks);
  const document: ContentDocument = contentDocumentSchema.parse({
    schemaVersion: '0.1',
    id: documentId,
    title: input.title,
    language: input.language,
    ...(input.author !== null ? { author: input.author } : {}),
    ...(input.sourceUrl !== null ? { sourceUrl: input.sourceUrl } : {}),
    ...(input.publishedAt !== null ? { publishedAt: input.publishedAt } : {}),
    blocks: scopedBlocks,
    claims: [],
    citations: [],
    tables: scopedBlocks
      .filter((block) => block.type === 'table')
      .map((block, index) => ({ id: `tbl_${String(index + 1)}_${block.id.slice(4, 16)}`, blockId: block.id })),
    figures: scopedBlocks
      .filter((block) => block.type === 'image')
      .map((block, index) => ({
        id: `fig_${String(index + 1)}_${block.id.slice(4, 16)}`,
        ...(block.text !== undefined && block.text !== '' ? { caption: block.text } : {}),
      })),
    attachments: [],
  });

  const now = new Date();
  const rows = await deps.db.transaction(async (tx) => {
    const inserted = await tx
      .insert(contentDocuments)
      .values({
        id: documentId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        title: document.title,
        language: document.language,
        author: input.author,
        sourceUrl: input.sourceUrl,
        publishedAt: input.publishedAt,
        normalization: input.normalization,
        createdBy: input.createdBy,
      })
      .returning();
    const documentRow = inserted[0];
    if (!documentRow) throw new ApiFailure(ERROR_CODES.INTERNAL, 'content document insert failed', 500);

    for (const [position, block] of document.blocks.entries()) {
      await tx.insert(contentBlocks).values({
        id: block.id,
        documentId,
        workspaceId: input.workspaceId,
        position,
        blockType: block.type,
        level: block.level ?? null,
        text: block.text ?? null,
        items: block.items ?? null,
        table: block.table ?? null,
        note: block.note ?? null,
      });
    }
    return documentRow;
  });
  void now;

  return contentDocumentRecordSchema.parse({
    document,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    sourceId: input.sourceId,
    normalization: input.normalization,
    createdAt: rows.createdAt.toISOString(),
    updatedAt: rows.updatedAt.toISOString(),
  });
}

/** URL 文章 → ContentDocument（+ Source 与快照事实）。 */
export async function createContentFromUrl(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; createdBy: string | null; input: CreateContentRequest },
): Promise<ContentDocumentRecord> {
  const url = input.input.url;
  if (url === undefined || url.trim() === '') {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'URL_ARTICLE 需要 url', 400, { reason: CONTENT_INPUT_ERROR_REASONS.INVALID_URL });
  }
  await assertProjectWritable(deps, input.workspaceId, input.projectId);
  // 归一化前置守卫：无论适配器是否自觉，先做 URL 形态与 SSRF 校验（逐跳复检仍由适配器负责）
  assertSafeUrl(url);
  const fetcher = requireFetcher(deps);
  const fetched = await fetcher.fetch({ url, maxBytes: DEFAULT_MAX_BYTES, timeoutMs: DEFAULT_TIMEOUT_MS });

  const contentType = fetched.contentType;
  const isText = isHtml(contentType) || isPlain(contentType) || contentType === null;
  if (!isText) {
    throw new ApiFailure(ERROR_CODES.UNSUPPORTED_MEDIA_TYPE, '仅支持 HTML/纯文本文章（其他类型请作为资产上传）', 415, {
      reason: CONTENT_INPUT_ERROR_REASONS.UNSUPPORTED_CONTENT_TYPE,
      contentType,
    });
  }
  const bytes = fetched.bytes;
  if (bytes.byteLength > DEFAULT_MAX_BYTES) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, '文章超过大小上限', 413, {
      reason: CONTENT_INPUT_ERROR_REASONS.TOO_LARGE,
      maxBytes: DEFAULT_MAX_BYTES,
    });
  }

  const decoded = decodeContentBytes(bytes, contentType);
  const blocks = isPlain(contentType) ? extractBlocksFromText(decoded.text, 'PASTED_TEXT') : extractBlocksFromHtml(decoded.text);
  if (blocks.length === 0) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, '页面没有可读正文（空正文）', 422, {
      reason: CONTENT_INPUT_ERROR_REASONS.EMPTY_CONTENT,
      url: fetched.finalUrl,
      contentType,
    });
  }

  const firstHeading = blocks.find((block) => block.type === 'heading')?.text;
  const firstParagraph = blocks.find((block) => block.type === 'paragraph')?.text;
  const title = input.input.title ?? firstHeading ?? (firstParagraph !== undefined ? firstParagraph.slice(0, 80) : hostAsPublisher(fetched.finalUrl));
  const excerpt = (firstParagraph ?? blocks[0]?.text ?? '').slice(0, 500);
  const sourceId = `src_${randomUUID()}`;

  // Source 与快照事实（contentHash = 存储摘录的 sha256，§85 契约注释）
  await deps.db.insert(projectSources).values({
    id: sourceId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    url: fetched.finalUrl,
    title,
    publisher: hostAsPublisher(fetched.finalUrl),
    author: input.input.author ?? null,
    publishedAt: input.input.publishedAt ?? null,
    contentHash: sha256Hex(excerpt !== '' ? excerpt : title),
    excerpt: excerpt !== '' ? excerpt : title,
    snapshotKind: 'live_fetch',
  });

  return persistDocument(deps, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    createdBy: input.createdBy,
    sourceType: 'URL_ARTICLE',
    sourceId,
    title,
    language: input.input.language ?? detectLanguage(decoded.text),
    author: input.input.author ?? null,
    sourceUrl: fetched.finalUrl,
    publishedAt: input.input.publishedAt ?? null,
    blocks,
    normalization: {
      sourceType: 'URL_ARTICLE',
      fetchedUrl: url,
      finalUrl: fetched.finalUrl,
      charset: decoded.charset,
      title,
      blockCount: blocks.length,
      claims: 0,
      tables: blocks.filter((block) => block.type === 'table').length,
      figures: blocks.filter((block) => block.type === 'image').length,
      notes: [`charset来源=${decoded.charsetSource}`],
    },
  });
}

/** 粘贴正文 / 手写脚本 → ContentDocument。 */
export async function createContentFromText(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; createdBy: string | null; input: CreateContentRequest },
): Promise<ContentDocumentRecord> {
  const text = input.input.text ?? '';
  const sourceType = input.input.sourceType === 'MANUAL_SCRIPT' ? 'MANUAL_SCRIPT' : 'PASTED_TEXT';
  if (text.trim() === '') {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, '输入为空（空正文）', 422, { reason: CONTENT_INPUT_ERROR_REASONS.EMPTY_INPUT });
  }
  await assertProjectWritable(deps, input.workspaceId, input.projectId);

  const blocks = extractBlocksFromText(text, sourceType);
  if (blocks.length === 0) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, '解析后没有可读内容（空正文）', 422, {
      reason: CONTENT_INPUT_ERROR_REASONS.EMPTY_CONTENT,
    });
  }
  const firstHeading = blocks.find((block) => block.type === 'heading')?.text;
  const firstParagraph = blocks.find((block) => block.type === 'paragraph')?.text;
  const title = input.input.title ?? firstHeading ?? (firstParagraph !== undefined ? firstParagraph.slice(0, 80) : '未命名内容');

  return persistDocument(deps, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    createdBy: input.createdBy,
    sourceType,
    sourceId: null,
    title,
    language: input.input.language ?? detectLanguage(text),
    author: input.input.author ?? null,
    sourceUrl: null,
    publishedAt: input.input.publishedAt ?? null,
    blocks,
    normalization: {
      sourceType,
      fetchedUrl: null,
      finalUrl: null,
      charset: 'utf-8',
      title,
      blockCount: blocks.length,
      claims: 0,
      tables: blocks.filter((block) => block.type === 'table').length,
      figures: 0,
      notes: [],
    },
  });
}

/** 统一入口（按 sourceType 分派）。 */
export async function createContent(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; createdBy: string | null; input: CreateContentRequest },
): Promise<ContentDocumentRecord> {
  return input.input.sourceType === 'URL_ARTICLE' ? createContentFromUrl(deps, input) : createContentFromText(deps, input);
}

/** 文档详情（含块；组装为 ContentDocument）。 */
export async function getContentDocument(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; documentId: string },
): Promise<ContentDocumentRecord> {
  const rows = await deps.db
    .select()
    .from(contentDocuments)
    .where(
      and(
        eq(contentDocuments.id, input.documentId),
        eq(contentDocuments.projectId, input.projectId),
        eq(contentDocuments.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'content document not found', 404);

  const blocks = await loadBlocks(deps, row.id);
  const document = contentDocumentSchema.parse({
    schemaVersion: row.schemaVersion,
    id: row.id,
    title: row.title,
    language: row.language,
    ...(row.author !== null ? { author: row.author } : {}),
    ...(row.sourceUrl !== null ? { sourceUrl: row.sourceUrl } : {}),
    ...(row.publishedAt !== null ? { publishedAt: row.publishedAt } : {}),
    blocks,
    claims: [],
    citations: [],
    tables: blocks.filter((block) => block.type === 'table').map((block, index) => ({ id: `tbl_${String(index + 1)}_${block.id.slice(4, 12)}`, blockId: block.id })),
    figures: blocks
      .filter((block) => block.type === 'image')
      .map((block, index) => ({
        id: `fig_${String(index + 1)}_${block.id.slice(4, 16)}`,
        ...(block.text !== undefined && block.text !== '' ? { caption: block.text } : {}),
      })),
    attachments: [],
  });
  return contentDocumentRecordSchema.parse({
    document,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    sourceId: row.sourceId,
    normalization: row.normalization,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

async function loadBlocks(deps: DomainDeps, documentId: string): Promise<ContentBlock[]> {
  const rows = await deps.db.select().from(contentBlocks).where(eq(contentBlocks.documentId, documentId)).orderBy(contentBlocks.position);
  return rows.map((row) =>
    ({
      id: row.id,
      type: row.blockType,
      ...(row.level !== null ? { level: row.level } : {}),
      ...(row.text !== null ? { text: row.text } : {}),
      ...(row.items !== null ? { items: row.items as string[] } : {}),
      ...(row.table !== null ? { table: row.table as { columns: string[]; rows: string[][] } } : {}),
      ...(row.note !== null ? { note: row.note } : {}),
    }) as ContentBlock,
  );
}

export async function listContentDocuments(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string },
): Promise<ContentDocumentRecord[]> {
  const rows = await deps.db
    .select({ id: contentDocuments.id })
    .from(contentDocuments)
    .where(and(eq(contentDocuments.projectId, input.projectId), eq(contentDocuments.workspaceId, input.workspaceId)))
    .orderBy(desc(contentDocuments.createdAt));
  const documents: ContentDocumentRecord[] = [];
  for (const row of rows) {
    documents.push(await getContentDocument(deps, { ...input, documentId: row.id }));
  }
  return documents;
}

const toSourceDto = (row: typeof projectSources.$inferSelect): ContentSource =>
  contentSourceSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    url: row.url,
    title: row.title,
    publisher: row.publisher,
    author: row.author,
    publishedAt: row.publishedAt,
    retrievedAt: row.retrievedAt.toISOString(),
    contentHash: row.contentHash,
    excerpt: row.excerpt,
    snapshotKind: row.snapshotKind,
    note: row.note,
  });

export async function listProjectSources(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string },
): Promise<ContentSource[]> {
  const rows = await deps.db
    .select()
    .from(projectSources)
    .where(and(eq(projectSources.projectId, input.projectId), eq(projectSources.workspaceId, input.workspaceId)))
    .orderBy(desc(projectSources.createdAt));
  return rows.map(toSourceDto);
}

/** Sources 编辑：只改元数据（标题/作者/发布方/时间/备注）；抓取内容与哈希是快照事实，不可改。 */
export async function updateSource(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; sourceId: string; input: UpdateSourceRequest },
): Promise<ContentSource> {
  const rows = await deps.db
    .select()
    .from(projectSources)
    .where(
      and(
        eq(projectSources.id, input.sourceId),
        eq(projectSources.projectId, input.projectId),
        eq(projectSources.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'source not found', 404);

  const updated = await deps.db
    .update(projectSources)
    .set({
      ...(input.input.title !== undefined ? { title: input.input.title } : {}),
      ...(input.input.author !== undefined ? { author: input.input.author } : {}),
      ...(input.input.publisher !== undefined ? { publisher: input.input.publisher } : {}),
      ...(input.input.publishedAt !== undefined ? { publishedAt: input.input.publishedAt } : {}),
      ...(input.input.note !== undefined ? { note: input.input.note } : {}),
      updatedAt: new Date(),
    })
    .where(eq(projectSources.id, row.id))
    .returning();
  const next = updated[0];
  if (!next) throw new ApiFailure(ERROR_CODES.INTERNAL, 'source update failed', 500);
  return toSourceDto(next);
}
