import { index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces.js';
import { projects } from './projects.js';

/**
 * Master Narration 与 Alignment（P06-03 / 规范 §5.1）。
 *
 * - **追加式（append-only）**：每次合成/局部重合成写入新行（不原地篡改；当前 = 最新 createdAt）；
 *   Alignment 是后续一切 timing 的权威基础，必须可追溯（与 ProjectVersion 同一纪律）；
 * - alignment（segments + words + cues）以 JSONB 保存：读取总是整体消费（逐条 timing 驱动画面/字幕）；
 * - 分段音频只存 storage_key（§75 第 5 条：不把 Provider/Object URL 当永久标识）；
 * - **不保存任何 Provider 私有 style 参数**（§94：映射层不经此表）。
 */

export const masterNarrations = pgTable(
  'master_narrations',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    narrativePlanId: text('narrative_plan_id').notNull(),
    narrativePlanRevision: integer('narrative_plan_revision').notNull(),
    /** 拼接后的 Master 音频资产（WAV 可拼接时；否则 null，交由渲染管线） */
    assetId: text('asset_id'),
    assetVersionId: text('asset_version_id'),
    mimeType: text('mime_type'),
    sizeBytes: integer('size_bytes'),
    checksumSha256: text('checksum_sha256'),
    totalDurationMs: integer('total_duration_ms').notNull(),
    /** PROVIDER_TIMESTAMPS | ALIGNMENT_PROVIDER */
    alignmentMethod: text('alignment_method').notNull(),
    /** 段级对齐（含词级时间戳、缓存键、reused 标记） */
    segments: jsonb('segments').notNull().default([]),
    /** narration cues（驱动画面/字幕/Avatar） */
    cues: jsonb('cues').notNull().default([]),
    /** 身份引用（版本固定；不含 Provider 私有参数） */
    voiceIdentityId: text('voice_identity_id'),
    voiceIdentityVersion: integer('voice_identity_version'),
    speechProfileId: text('speech_profile_id'),
    speechProfileVersion: integer('speech_profile_version'),
    /** 旁白语言（null = 源语言；多语言派生版 = 目标语言——P12-04；缓存复用按语言隔离） */
    language: text('language'),
    /** 变体（MASTER = 视频母带；PODCAST = 纯音频派生——P12-05；getCurrent 只认 MASTER） */
    variant: text('variant').notNull().default('MASTER'),
    /** 缓存统计（局部重建审计：reused / synthesized） */
    cacheStats: jsonb('cache_stats').notNull().default({}),
    warnings: jsonb('warnings').notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('master_narrations_project_idx').on(table.projectId, table.createdAt),
    index('master_narrations_plan_idx').on(table.narrativePlanId, table.narrativePlanRevision),
  ],
);
