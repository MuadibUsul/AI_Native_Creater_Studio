import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';

/**
 * 内容契约（规范 §7 ContentDocument + 计划 §4.4）：
 * 任何输入必须先转成统一结构，而不是直接发给 LLM。
 * V1 的内容结构必须保存：原始块及稳定 ID；Claim 的事实/分析/观点/不确定类型；
 * Source 与 Citation；表格、数值、单位、时间范围和实体；已抽取的因果、时间线、地理关系；
 * 无法结构化但仍有价值的原始内容引用。
 */

export const CONTENT_BLOCK_TYPES = ['heading', 'paragraph', 'quote', 'list', 'table', 'image', 'chart', 'embed'] as const;

export const contentBlockSchema = z.object({
  /** 稳定 ID（§4.4：原始块及稳定 ID） */
  id: opaqueIdSchema,
  type: z.enum(CONTENT_BLOCK_TYPES),
  level: z.number().int().min(1).max(6).optional(),
  text: z.string().optional(),
  items: z.array(z.string()).optional(),
  table: z
    .object({
      columns: z.array(z.string()).min(1),
      rows: z.array(z.array(z.string())),
    })
    .optional(),
  note: z.string().optional(),
});

export const CLAIM_FACTUALITIES = ['fact', 'analysis', 'opinion', 'uncertain'] as const;

export const claimSchema = z.object({
  id: opaqueIdSchema,
  text: z.string().min(1),
  factuality: z.enum(CLAIM_FACTUALITIES),
  sourceIds: z.array(opaqueIdSchema).default([]),
  /** 绑定到结构化数据集（图表数值只能来自真实数据，§10.3） */
  structuredData: z
    .array(z.object({ datasetId: opaqueIdSchema, seriesId: z.string().optional() }))
    .default([]),
});

export const citationSchema = z.object({
  id: opaqueIdSchema,
  claimId: opaqueIdSchema,
  sourceId: opaqueIdSchema,
  locator: z.string().optional(),
});

export const contentTableSchema = z.object({
  id: opaqueIdSchema,
  blockId: opaqueIdSchema,
  caption: z.string().optional(),
  datasetId: opaqueIdSchema.optional(),
});

export const contentFigureSchema = z.object({
  id: opaqueIdSchema,
  caption: z.string().optional(),
});

export const contentAttachmentSchema = z.object({
  id: opaqueIdSchema,
  kind: z.string().min(1),
});

/** ---------- 已抽取结构（计划 §4.4） ---------- */

export const ENTITY_KINDS = ['PERSON', 'ORG', 'COUNTRY', 'OTHER'] as const;

export const extractedEntitySchema = z.object({
  id: opaqueIdSchema,
  name: z.string().min(1),
  kind: z.enum(ENTITY_KINDS),
});

export const causalRelationSchema = z.object({
  id: opaqueIdSchema,
  cause: z.string().min(1),
  effect: z.string().min(1),
  claimIds: z.array(opaqueIdSchema).default([]),
});

export const timelineEventSchema = z.object({
  id: opaqueIdSchema,
  /** ISO 8601 日期或时间戳（事件粒度不一） */
  date: z.string().min(1),
  description: z.string().min(1),
  claimIds: z.array(opaqueIdSchema).default([]),
});

export const geoRelationSchema = z.object({
  id: opaqueIdSchema,
  /** ISO 3166-1 alpha-3 国家码 */
  countryCodes: z.array(z.string().min(3).max(3)).min(1),
  description: z.string().min(1),
});

export const numericFactSchema = z.object({
  id: opaqueIdSchema,
  value: z.number(),
  unit: z.string().min(1),
  /** 时间范围（例如年度指标） */
  timeRange: z.object({ from: z.string().min(1), to: z.string().min(1) }).nullable().default(null),
  claimIds: z.array(opaqueIdSchema).default([]),
});

export const contentExtractionsSchema = z.object({
  entities: z.array(extractedEntitySchema).default([]),
  causalRelations: z.array(causalRelationSchema).default([]),
  timelineEvents: z.array(timelineEventSchema).default([]),
  geography: z.array(geoRelationSchema).default([]),
  numericFacts: z.array(numericFactSchema).default([]),
});

export const contentDocumentSchema = z.object({
  schemaVersion: z.string().min(1),
  id: opaqueIdSchema,
  title: z.string().min(1),
  language: z.string().min(1),
  author: z.string().optional(),
  sourceUrl: z.string().optional(),
  publishedAt: z.string().optional(),
  blocks: z.array(contentBlockSchema).min(1),
  claims: z.array(claimSchema).default([]),
  citations: z.array(citationSchema).default([]),
  tables: z.array(contentTableSchema).default([]),
  figures: z.array(contentFigureSchema).default([]),
  attachments: z.array(contentAttachmentSchema).default([]),
  /** 已抽取的因果/时间线/地理/实体/数值事实（P04-02 起由管线填充） */
  extractions: contentExtractionsSchema.default(() => ({
    entities: [],
    causalRelations: [],
    timelineEvents: [],
    geography: [],
    numericFacts: [],
  })),
});

export type ContentDocument = z.infer<typeof contentDocumentSchema>;

/** ---------- 输入归一化契约（P04-01 / 规范 §7、§8；计划 P04-01） ---------- */

/** V1 文本输入形态（上传图片/视频/音频走资产链路，P02-04；P10-01 增文档导入与通讯导入） */
export const CONTENT_SOURCE_TYPES = ['URL_ARTICLE', 'PASTED_TEXT', 'MANUAL_SCRIPT', 'DOCUMENT_IMPORT', 'NEWSLETTER_IMPORT'] as const;
export const contentSourceTypeSchema = z.enum(CONTENT_SOURCE_TYPES);
export type ContentSourceType = z.infer<typeof contentSourceTypeSchema>;

/**
 * 输入归一化的**明确结果**（计划 P04-01 验收：URL 异常、安全限制、空正文、错误编码都要有明确结果）。
 * 每个原因对应一个可判定的错误（不放宽校验、不静默降级）。
 */
export const CONTENT_INPUT_ERROR_REASONS = {
  /** URL 形态非法（非 http/https、缺 host、超长） */
  INVALID_URL: 'INVALID_URL',
  /** 安全限制：目标为内网/回环/元数据地址/非允许端口（SSRF 防护） */
  BLOCKED_TARGET: 'BLOCKED_TARGET',
  /** 网络不可达/DNS 失败/HTTP 非 2xx */
  UNREACHABLE: 'UNREACHABLE',
  /** 超时 */
  TIMEOUT: 'TIMEOUT',
  /** 超出大小上限 */
  TOO_LARGE: 'TOO_LARGE',
  /** Content-Type 不是可抽取的文本/HTML */
  UNSUPPORTED_CONTENT_TYPE: 'UNSUPPORTED_CONTENT_TYPE',
  /** 抽取后正文为空（页面上没有可读内容） */
  EMPTY_CONTENT: 'EMPTY_CONTENT',
  /** 编码无法解析（未知 charset / 解码失败） */
  ENCODING_UNSUPPORTED: 'ENCODING_UNSUPPORTED',
  /** 输入为空（粘贴文本/手写脚本） */
  EMPTY_INPUT: 'EMPTY_INPUT',
  /** 文档格式不受支持（扩展名/内容类型无法识别为 Markdown/PDF/DOCX/Newsletter） */
  UNKNOWN_DOCUMENT_KIND: 'UNKNOWN_DOCUMENT_KIND',
  /** 文档解析失败（损坏/结构非法；**不伪造提取成功**） */
  DOCUMENT_PARSE_FAILED: 'DOCUMENT_PARSE_FAILED',
  /** 扫描件 PDF：无文本层（不伪造提取成功）——需 OCR（后续/人工） */
  SCANNED_PDF_NO_TEXT: 'SCANNED_PDF_NO_TEXT',
  /** 加密文档（PDF/DOCX 带密码）——无法提取 */
  DOCUMENT_ENCRYPTED: 'DOCUMENT_ENCRYPTED',
} as const;

export type ContentInputErrorReason = (typeof CONTENT_INPUT_ERROR_REASONS)[keyof typeof CONTENT_INPUT_ERROR_REASONS];

export const createContentRequestSchema = z
  .object({
    sourceType: contentSourceTypeSchema,
    /** URL_ARTICLE 必填 */
    url: z.string().min(1).max(2048).optional(),
    /** PASTED_TEXT / MANUAL_SCRIPT 必填 */
    text: z.string().max(2_000_000).optional(),
    /** 可选覆盖（否则从内容推断） */
    title: z.string().min(1).max(500).optional(),
    language: z.string().min(2).max(20).optional(),
    author: z.string().max(200).optional(),
    publishedAt: z.string().max(40).optional(),
  })
  .refine((value) => (value.sourceType === 'URL_ARTICLE' ? value.url !== undefined : value.text !== undefined), {
    message: 'URL_ARTICLE 需要 url；PASTED_TEXT/MANUAL_SCRIPT 需要 text',
  });

export type CreateContentRequest = z.infer<typeof createContentRequestSchema>;

/** 解析归一化结果（随文档返回，供 UI 显示"这次输入发生了什么"） */
export const contentNormalizationSchema = z.object({
  sourceType: contentSourceTypeSchema,
  /** 原始 URL（URL_ARTICLE）或 null */
  fetchedUrl: z.string().nullable().default(null),
  /** 最终 URL（重定向后） */
  finalUrl: z.string().nullable().default(null),
  charset: z.string().nullable().default(null),
  title: z.string().min(1),
  blockCount: z.number().int().nonnegative(),
  claims: z.number().int().nonnegative().default(0),
  tables: z.number().int().nonnegative().default(0),
  figures: z.number().int().nonnegative().default(0),
  notes: z.array(z.string().max(200)).default([]),
});

export type ContentNormalization = z.infer<typeof contentNormalizationSchema>;

export const contentDocumentRecordSchema = z.object({
  document: contentDocumentSchema,
  workspaceId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  sourceId: opaqueIdSchema.nullable().default(null),
  normalization: contentNormalizationSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export type ContentDocumentRecord = z.infer<typeof contentDocumentRecordSchema>;

/** 来源（project_sources；§85 SourceSnapshot 的持久化形态） */
export const contentSourceSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  url: z.string().min(1),
  title: z.string().min(1),
  publisher: z.string().min(1),
  author: z.string().nullable().default(null),
  publishedAt: z.string().nullable().default(null),
  retrievedAt: z.string().min(1),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  excerpt: z.string().min(1),
  /** live_fetch（在线抓取）| fixture_reconstruction（夹具重建）| document_upload（P10-01 本地文件导入） */
  snapshotKind: z.enum(['live_fetch', 'fixture_reconstruction', 'document_upload']),
  note: z.string().nullable().default(null),
});

export type ContentSource = z.infer<typeof contentSourceSchema>;

/** Sources 编辑（元数据可改；抓取内容与哈希不可改——那是快照事实） */
export const updateSourceRequestSchema = z
  .object({
    title: z.string().min(1).max(500),
    author: z.string().max(200).nullable(),
    publisher: z.string().min(1).max(200),
    publishedAt: z.string().max(40).nullable(),
    note: z.string().max(1000).nullable(),
  })
  .partial()
  .strict();

export type UpdateSourceRequest = z.infer<typeof updateSourceRequestSchema>;

/**
 * 文章抓取器（I/O 由宿主注入；domain 不直接访问网络——同 P03-06 的结果拉取器模式）。
 * 实现方必须：逐跳校验 SSRF（assertSafeUrl）、限制重定向次数/大小/超时、遵循 Content-Type/charset。
 */
export interface ArticleFetcher {
  readonly kind: string;
  fetch(input: { url: string; maxBytes?: number; timeoutMs?: number }): Promise<{
    finalUrl: string;
    contentType: string | null;
    bytes: Uint8Array;
  }>;
}
export type ContentBlock = z.infer<typeof contentBlockSchema>;
export type Claim = z.infer<typeof claimSchema>;
export type ContentExtractions = z.infer<typeof contentExtractionsSchema>;
