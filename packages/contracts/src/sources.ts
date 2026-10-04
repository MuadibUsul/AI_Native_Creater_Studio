import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateOrDateTimeSchema } from './common/time.js';

/**
 * SourceSnapshot 契约（规范 §85，按计划 §4.1 统一为 camelCase）。
 *
 * contentHash 语义：sha256(utf8(excerpt)) —— 对"存储摘录"的哈希，不是对线上页面内容的实时哈希。
 * snapshotKind：live_fetch（真实抓取快照，P04-02 起支持）/ fixture_reconstruction（测试场景重构）。
 */

export const SNAPSHOT_KINDS = ['live_fetch', 'fixture_reconstruction'] as const;

export const sourceSnapshotSchema = z.object({
  sourceId: opaqueIdSchema,
  url: z.string().min(1),
  title: z.string().min(1),
  publisher: z.string().min(1),
  author: z.string().optional(),
  publishedAt: isoDateOrDateTimeSchema.optional(),
  retrievedAt: isoDateOrDateTimeSchema,
  contentHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'contentHash 必须为 sha256 十六进制（64 位小写）'),
  excerpt: z.string().min(1),
  excerptReference: z.string().optional(),
  snapshotAssetId: z.string().optional(),
  snapshotKind: z.enum(SNAPSHOT_KINDS),
  note: z.string().optional(),
});

export type SourceSnapshot = z.infer<typeof sourceSnapshotSchema>;
