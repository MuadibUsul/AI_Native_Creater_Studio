import { z } from 'zod';

/**
 * Golden Fixture 结构（P00-04）。
 *
 * TODO(P01-01/P04-02): 与正式契约合并。
 *   原因：P00-04 需要先把金样结构固化下来；ContentDocument 正式契约在 P01-01（公共契约）与
 *   P04-01/P04-02（输入归一化、证据与数据）中定义，SourceSnapshot 在 §85/P04-02 中定稿。
 *   依赖：P01-01、P04-01、P04-02。
 *   预期接口：本文件的 schema 由 packages/contracts 的正式 schema 取代；fixture 数据文件保持兼容迁移。
 *
 * 字段命名沿用规范原文：ContentDocument（§7）为 camelCase；SourceSnapshot（§85）为 snake_case。
 */

// ---------- ContentDocument（§7） ----------

export const contentBlockSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['heading', 'paragraph', 'quote', 'list', 'table', 'image', 'chart', 'embed']),
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

export const claimSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  factuality: z.enum(['fact', 'analysis', 'opinion', 'uncertain']),
  sourceIds: z.array(z.string()),
  structuredData: z
    .array(z.object({ datasetId: z.string(), seriesId: z.string().optional() }))
    .optional(),
});

export const citationSchema = z.object({
  id: z.string().min(1),
  claimId: z.string().min(1),
  sourceId: z.string().min(1),
  locator: z.string().optional(),
});

export const contentDocumentSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  language: z.string().min(1),
  author: z.string().optional(),
  sourceUrl: z.string().optional(),
  publishedAt: z.string().optional(),
  blocks: z.array(contentBlockSchema).min(1),
  claims: z.array(claimSchema),
  citations: z.array(citationSchema),
  tables: z.array(
    z.object({
      id: z.string().min(1),
      blockId: z.string().min(1),
      caption: z.string().optional(),
      datasetId: z.string().optional(),
    }),
  ),
  figures: z.array(z.object({ id: z.string().min(1), caption: z.string().optional() })),
  attachments: z.array(z.object({ id: z.string().min(1), kind: z.string().min(1) })),
});

export type ContentDocument = z.infer<typeof contentDocumentSchema>;
export type ContentBlock = z.infer<typeof contentBlockSchema>;
export type Claim = z.infer<typeof claimSchema>;

// ---------- SourceSnapshot（§85 + fixture 扩展字段） ----------

export const sourceSnapshotSchema = z.object({
  source_id: z.string().min(1),
  url: z.string().min(1),
  title: z.string().min(1),
  publisher: z.string().min(1),
  author: z.string().optional(),
  published_at: z.string().optional(),
  retrieved_at: z.string().min(1),
  content_hash: z.string().regex(/^[0-9a-f]{64}$/, 'content_hash 必须为 sha256 十六进制'),
  excerpt: z.string().min(1),
  excerpt_reference: z.string().optional(),
  snapshot_asset_id: z.string().optional(),
  /** fixture_reconstruction：摘录为测试场景重构；live_fetch：真实抓取快照（P04 起支持） */
  snapshot_kind: z.enum(['live_fetch', 'fixture_reconstruction']),
  note: z.string().optional(),
});

export type SourceSnapshot = z.infer<typeof sourceSnapshotSchema>;

// ---------- StructuredDataset ----------

export const datasetSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  unit: z.string().min(1),
  sourceIds: z.array(z.string()).min(1),
  /** true 表示完全合成的数据；禁止被当作事实图表绑定（AC-15 / §10.3） */
  synthetic: z.boolean(),
  note: z.string().optional(),
  series: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        points: z
          .array(
            z.object({
              t: z.string().min(1),
              v: z.number(),
              accuracy: z.enum(['anchor', 'reconstructed']),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
});

export type StructuredDataset = z.infer<typeof datasetSchema>;

// ---------- Expected structure ----------

export const fixtureExpectedSchema = z.object({
  scenario: z.string().min(1),
  language: z.string().min(1),
  targetDurationSeconds: z.object({ min: z.number().positive(), max: z.number().positive() }),
  format: z.object({
    aspectRatio: z.string().min(1),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().int().positive(),
  }),
  chapters: z.array(z.object({ id: z.string().min(1), title: z.string().min(1), intent: z.string().min(1) })),
  requiredScenes: z.array(
    z.object({
      sceneType: z.string().min(1),
      semanticType: z.string().min(1),
      role: z.string().min(1),
      narrationLine: z.string().optional(),
      datasetId: z.string().optional(),
      seriesIds: z.array(z.string()).optional(),
      sourceId: z.string().optional(),
      constraints: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
  qaExpectations: z.record(z.string(), z.unknown()),
});

export type FixtureExpected = z.infer<typeof fixtureExpectedSchema>;

// ---------- Bundle ----------

export interface FixtureBundle {
  content: ContentDocument;
  sources: SourceSnapshot[];
  datasets: StructuredDataset[];
  expected: FixtureExpected;
}

export const sourcesFileSchema = z.object({
  meta: z.record(z.string(), z.unknown()),
  sources: z.array(sourceSnapshotSchema),
});

export const datasetsFileSchema = z.object({
  meta: z.record(z.string(), z.unknown()),
  datasets: z.array(datasetSchema),
});

export const negativeCaseSchema = z.object({
  caseId: z.string().min(1),
  label: z.string().min(1),
  purpose: z.string().min(1),
  expectedIssueCodes: z.array(z.string()).min(1),
  bundle: z.object({
    content: contentDocumentSchema,
    sources: z.array(sourceSnapshotSchema),
    datasets: z.array(datasetSchema),
    expected: fixtureExpectedSchema,
  }),
});

export type NegativeCase = z.infer<typeof negativeCaseSchema>;
