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
export type ContentBlock = z.infer<typeof contentBlockSchema>;
export type Claim = z.infer<typeof claimSchema>;
export type ContentExtractions = z.infer<typeof contentExtractionsSchema>;
