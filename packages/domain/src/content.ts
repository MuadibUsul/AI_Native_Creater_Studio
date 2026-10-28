import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import {
  ApiFailure,
  CONTENT_INPUT_ERROR_REASONS,
  DOCUMENT_IMPORT_MAX_BYTES,
  DOCUMENT_PARSE_ERROR_REASONS,
  DocumentParseError,
  ERROR_CODES,
  contentDocumentSchema,
  contentDocumentRecordSchema,
  contentSourceSchema,
  MAX_ARTICLE_CHARS,
  studioArticleDraftSchema,
  type ArticleFetcher,
  type ContentBlock,
  type ContentDocument,
  type ContentDocumentRecord,
  type ContentSource,
  type ContentSourceType,
  type CreateContentRequest,
  type DocumentKind,
  type DocumentParser,
  type ParsedDocumentElement,
  type StudioArticleDraft,
  type UpdateSourceRequest,
} from '@ancs/contracts';
import { contentBlocks, contentDocuments, projectSources, projects } from '@ancs/db';
import { assertSafeUrl, decodeContentBytes, detectLanguage, extractBlocksFromHtml, extractBlocksFromText } from './content-extract.js';
import type { DomainDeps } from './deps.js';

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
    sourceType: ContentSourceType;
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

/**
 * 抓取文章页并抽出正文块（URL 文章导入与"从链接导入文章"共用）：
 * 先做 URL 形态与 SSRF 校验（逐跳复检仍由适配器负责），只接受 HTML / 纯文本，大小有上限，空正文明确报错。
 */
async function fetchArticleBlocks(deps: DomainDeps, url: string): Promise<{
  fetched: { finalUrl: string; contentType: string | null; bytes: Uint8Array };
  decoded: ReturnType<typeof decodeContentBytes>;
  blocks: ContentBlock[];
}> {
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
  if (fetched.bytes.byteLength > DEFAULT_MAX_BYTES) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, '文章超过大小上限', 413, {
      reason: CONTENT_INPUT_ERROR_REASONS.TOO_LARGE,
      maxBytes: DEFAULT_MAX_BYTES,
    });
  }

  const decoded = decodeContentBytes(fetched.bytes, contentType);
  const blocks = isPlain(contentType) ? extractBlocksFromText(decoded.text, 'PASTED_TEXT') : extractBlocksFromHtml(decoded.text);
  if (blocks.length === 0) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, '页面没有可读正文（空正文）', 422, {
      reason: CONTENT_INPUT_ERROR_REASONS.EMPTY_CONTENT,
      url: fetched.finalUrl,
      contentType,
    });
  }
  return { fetched, decoded, blocks };
}

/** 网页标题里常见的几个实体 */
const decodeEntities = (text: string): string => text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ');

/** 中日韩文字与全角标点之间不该有空格（HTML 行内标签抽取时会留下空格） */
const CJK = '\\u3000-\\u303F\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uFF00-\\uFFEF';
const CJK_GAP = new RegExp(`([${CJK}])\\s+(?=[${CJK}])`, 'g');
const tidyLine = (text: string): string => text.replace(/\s+/g, ' ').replace(CJK_GAP, '$1').trim();

/** 正文块 → 文章原文（标题、段落、引用、列表逐行；表格、图片、图表不进讲述原文） */
function articleTextFromBlocks(blocks: readonly ContentBlock[]): string[] {
  const lines: string[] = [];
  for (const block of blocks) {
    if (block.type === 'heading' || block.type === 'paragraph' || block.type === 'quote') {
      const text = tidyLine(block.text ?? '');
      if (text) lines.push(text);
    } else if (block.type === 'list') {
      for (const item of block.items ?? []) {
        const text = tidyLine(item);
        if (text) lines.push(`· ${text}`);
      }
    }
  }
  return lines;
}

/**
 * V6 文章讲述：从链接导入文章原文（不写库）。用户在新建页核对后，原文随工程进入 AI 导演的上下文；
 * 超过 MAX_ARTICLE_CHARS 时按段截断，并如实标出。
 */
export async function fetchStudioArticle(deps: DomainDeps, input: { url: string }): Promise<StudioArticleDraft> {
  const { fetched, decoded, blocks } = await fetchArticleBlocks(deps, input.url.trim());
  const lines = articleTextFromBlocks(blocks);
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = line.length + (kept.length > 0 ? 2 : 0);
    if (used + cost > MAX_ARTICLE_CHARS) break;
    kept.push(line);
    used += cost;
  }
  if (kept.length === 0) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, '页面没有可读正文（空正文）', 422, {
      reason: CONTENT_INPUT_ERROR_REASONS.EMPTY_CONTENT,
      url: fetched.finalUrl,
      contentType: fetched.contentType,
    });
  }
  // 标题：正文里的第一个标题；没有时取网页 <title>
  const pageTitle = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(decoded.text)?.[1]?.replace(/<[^>]+>/g, ' ') ?? '';
  const heading = tidyLine(blocks.find((block) => block.type === 'heading')?.text ?? '') || tidyLine(decodeEntities(pageTitle));
  return studioArticleDraftSchema.parse({
    title: heading.slice(0, 200),
    text: kept.join('\n\n'),
    sourceUrl: fetched.finalUrl,
    publisher: hostAsPublisher(fetched.finalUrl).slice(0, 200),
    paragraphs: kept.length,
    truncated: kept.length < lines.length,
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
  const { fetched, decoded, blocks } = await fetchArticleBlocks(deps, url);

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

/* ---------- P10-01：文档导入（Markdown / PDF / DOCX / Newsletter） ---------- */

/**
 * 按扩展名 + 内容类型 + 魔数识别文档种类（纯函数；**不猜测**——无法识别返回 null → 415）。
 * HTML 不走本函数（Newsletter HTML 直接经既有 HTML 抽取；.eml 归 EMAIL）。
 */
export function detectDocumentKind(input: { filename: string; contentType: string; bytes: Uint8Array }): DocumentKind | null {
  const filename = input.filename.toLowerCase();
  const contentType = input.contentType.toLowerCase().split(';')[0]?.trim() ?? '';
  const extension = filename.includes('.') ? (filename.split('.').pop() ?? '') : '';
  const isPdfMagic = input.bytes.length >= 5 && input.bytes[0] === 0x25 && input.bytes[1] === 0x50 && input.bytes[2] === 0x44 && input.bytes[3] === 0x46 && input.bytes[4] === 0x2d;
  const isZipMagic = input.bytes.length >= 2 && input.bytes[0] === 0x50 && input.bytes[1] === 0x4b;

  if (isPdfMagic || extension === 'pdf' || contentType === 'application/pdf') return 'PDF';
  if (extension === 'eml' || contentType === 'message/rfc822') return 'EMAIL';
  if (isZipMagic || extension === 'docx' || contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'DOCX';
  if (extension === 'md' || extension === 'markdown' || contentType === 'text/markdown') return 'MARKDOWN';
  return null;
}

/** 解析元素 → ContentBlock（稳定 ID；表格保留 columns/rows）。 */
function elementsToBlocks(elements: ParsedDocumentElement[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  let counter = 0;
  const nextId = (): string => {
    counter += 1;
    return `blk_${String(counter)}`;
  };
  for (const element of elements) {
    switch (element.type) {
      case 'heading':
        blocks.push({ id: nextId(), type: 'heading', level: Math.min(6, Math.max(1, element.level)), text: element.text });
        break;
      case 'paragraph':
        blocks.push({ id: nextId(), type: 'paragraph', text: element.text });
        break;
      case 'quote':
        blocks.push({ id: nextId(), type: 'quote', text: element.text });
        break;
      case 'list':
        blocks.push({ id: nextId(), type: 'list', items: element.items });
        break;
      case 'table':
        blocks.push({ id: nextId(), type: 'table', table: { columns: element.columns, rows: element.rows } });
        break;
    }
  }
  return blocks;
}

const trimNote = (note: string): string => (note.length > 200 ? `${note.slice(0, 197)}...` : note);

const parseFailure = (error: DocumentParseError): ApiFailure =>
  new ApiFailure(ERROR_CODES.VALIDATION_FAILED, `文档解析失败：${error.message}`, 422, {
    reason: error.reason === DOCUMENT_PARSE_ERROR_REASONS.ENCRYPTED ? CONTENT_INPUT_ERROR_REASONS.DOCUMENT_ENCRYPTED : CONTENT_INPUT_ERROR_REASONS.DOCUMENT_PARSE_FAILED,
    parseReason: error.reason,
    ...error.details,
  });

/**
 * 文档字节 → ContentDocument（P10-01 / 验收："错误文件、扫描 PDF、缺页、嵌入对象有明确处理；不伪造提取成功"）。
 *
 * - 识别失败 → 415 UNKNOWN_DOCUMENT_KIND；超限 → 413 TOO_LARGE（服务端上限，客户端声明不可信）；
 * - 解析失败（损坏/加密）→ 422 DOCUMENT_PARSE_FAILED / DOCUMENT_ENCRYPTED（带 parseReason）；
 * - **扫描件 PDF（无文本层）→ 422 SCANNED_PDF_NO_TEXT**（绝不返回"空成功"）；
 * - 缺页/嵌入对象/未支持构造 → normalization.notes 逐条（≤200 字），来源与内容哈希落 project_sources；
 * - Newsletter：`.eml` → 取 text/html（附件列明不提取）；`.html` → 既有 HTML 抽取。
 */
export async function createContentFromDocument(
  deps: DomainDeps,
  input: {
    workspaceId: string;
    projectId: string;
    createdBy: string | null;
    filename: string;
    contentType: string;
    bytes: Uint8Array;
    parser: DocumentParser | undefined;
    /** Newsletter HTML（.html/.htm）：不经解析器，走既有 HTML 抽取 */
    html?: string;
  },
): Promise<ContentDocumentRecord> {
  await assertProjectWritable(deps, input.workspaceId, input.projectId);

  if (input.bytes.byteLength === 0) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, '文档为空（0 字节）', 400, { reason: CONTENT_INPUT_ERROR_REASONS.EMPTY_INPUT });
  }
  if (input.bytes.byteLength > DOCUMENT_IMPORT_MAX_BYTES) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, '文档超过大小上限', 413, {
      reason: CONTENT_INPUT_ERROR_REASONS.TOO_LARGE,
      maxBytes: DOCUMENT_IMPORT_MAX_BYTES,
      receivedBytes: input.bytes.byteLength,
    });
  }

  const kind = detectDocumentKind({ filename: input.filename, contentType: input.contentType, bytes: input.bytes });
  const notes: string[] = [];
  let blocks: ContentBlock[];
  let titleHint: string | null = null;
  let languageText = '';
  let documentKindLabel: string;

  if (input.html !== undefined) {
    documentKindLabel = 'NEWSLETTER_HTML';
    blocks = extractBlocksFromHtml(input.html);
    languageText = input.html;
    notes.push('Newsletter HTML 经内置 HTML 抽取（脚本/样式不入正文）');
  } else {
    if (input.parser === undefined) {
      throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, '文档解析器未配置（服务端未装配 document parser）', 501);
    }
    if (kind === null) {
      throw new ApiFailure(ERROR_CODES.UNSUPPORTED_MEDIA_TYPE, `不支持的文档类型：${input.filename}（${input.contentType || '未知类型'}）——支持 Markdown/PDF/DOCX/EML/HTML`, 415, {
        reason: CONTENT_INPUT_ERROR_REASONS.UNKNOWN_DOCUMENT_KIND,
        filename: input.filename.slice(0, 200),
        contentType: input.contentType.slice(0, 100),
      });
    }
    documentKindLabel = kind;
    try {
      if (kind === 'EMAIL') {
        const email = await input.parser.parseEmail({ bytes: input.bytes });
        for (const warning of email.warnings) notes.push(trimNote(warning));
        for (const attachment of email.attachments) notes.push(trimNote(`附件未提取：${attachment.filename}（${attachment.contentType ?? '未知类型'}）`));
        titleHint = email.subject;
        if (email.from !== null) notes.push(trimNote(`发件人：${email.from}`));
        if (email.html !== null) {
          blocks = extractBlocksFromHtml(email.html);
          languageText = email.html;
        } else if (email.text !== null) {
          blocks = extractBlocksFromText(email.text, 'PASTED_TEXT');
          languageText = email.text;
        } else {
          blocks = [];
        }
      } else {
        const parsed =
          kind === 'MARKDOWN'
            ? await input.parser.parseMarkdown({ bytes: input.bytes })
            : kind === 'DOCX'
              ? await input.parser.parseDocx({ bytes: input.bytes })
              : await input.parser.parsePdf({ bytes: input.bytes });
        for (const warning of parsed.warnings) notes.push(trimNote(warning));
        if (!parsed.hasExtractableText) {
          throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'PDF 无文本层（疑似扫描件）：无法提取正文——需 OCR（后续/人工），本系统不会伪造提取结果', 422, {
            reason: CONTENT_INPUT_ERROR_REASONS.SCANNED_PDF_NO_TEXT,
            pageCount: parsed.pageCount,
            pagesWithoutText: parsed.pagesWithoutText,
          });
        }
        titleHint = parsed.titleHint;
        blocks = elementsToBlocks(parsed.elements);
        languageText = parsed.elements
          .map((element) =>
            element.type === 'heading' || element.type === 'paragraph' || element.type === 'quote'
              ? element.text
              : element.type === 'list'
                ? element.items.join(' ')
                : element.columns.join(' '),
          )
          .join('\n');
        if (parsed.pageCount !== null) notes.push(trimNote(`PDF 共 ${String(parsed.pageCount)} 页；无文本页：${parsed.pagesWithoutText.length === 0 ? '无' : parsed.pagesWithoutText.join(',')}`));
      }
    } catch (error) {
      if (error instanceof ApiFailure) throw error;
      if (error instanceof DocumentParseError) throw parseFailure(error);
      throw error;
    }
  }

  if (blocks.length === 0) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, '文档没有可读正文（抽取结果为空）', 422, {
      reason: CONTENT_INPUT_ERROR_REASONS.EMPTY_CONTENT,
      filename: input.filename.slice(0, 200),
    });
  }

  const firstHeading = blocks.find((block) => block.type === 'heading')?.text;
  const firstParagraph = blocks.find((block) => block.type === 'paragraph')?.text;
  const baseName = input.filename.replace(/\.[^.]+$/, '');
  const title = (typeof firstHeading === 'string' && firstHeading.trim() !== '' ? firstHeading : null) ?? (titleHint !== null && titleHint.trim() !== '' ? titleHint : baseName.slice(0, 120));
  const excerpt = (firstParagraph ?? blocks[0]?.text ?? '').slice(0, 500);
  const contentHash = sha256Hex(Buffer.from(input.bytes).toString('base64'));
  const sourceId = `src_${randomUUID()}`;
  const sourceType: ContentSourceType = documentKindLabel === 'NEWSLETTER_HTML' || documentKindLabel === 'EMAIL' ? 'NEWSLETTER_IMPORT' : 'DOCUMENT_IMPORT';

  // 出处（§85）：本地文档不以 URL 伪装——用内容寻址 URN 标识该次导入（可核对哈希）
  await deps.db.insert(projectSources).values({
    id: sourceId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    url: `urn:ancs:document:${contentHash.slice(0, 32)}`,
    title,
    publisher: `本地文件导入（${input.filename.slice(0, 100)}）`,
    author: null,
    publishedAt: null,
    contentHash,
    excerpt: excerpt !== '' ? excerpt : title,
    snapshotKind: 'document_upload',
  });

  return persistDocument(deps, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    createdBy: input.createdBy,
    sourceType,
    sourceId,
    title,
    language: detectLanguage(languageText),
    author: null,
    sourceUrl: null,
    publishedAt: null,
    blocks,
    normalization: {
      sourceType,
      fetchedUrl: null,
      finalUrl: null,
      charset: kind === 'MARKDOWN' ? 'utf-8' : null,
      title,
      blockCount: blocks.length,
      claims: 0,
      tables: blocks.filter((block) => block.type === 'table').length,
      figures: 0,
      notes: [
        `documentKind=${documentKindLabel}`,
        `filename=${input.filename.slice(0, 100)}`,
        `bytes=${String(input.bytes.byteLength)}`,
        `sha256=${contentHash.slice(0, 16)}`,
        ...notes,
      ].map(trimNote),
    },
  });
}
