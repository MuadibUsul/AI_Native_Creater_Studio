import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { frameRateSchema, mediaRangeSchema, mediaTimeSchema } from './common/media-time.js';
import { isoDateTimeSchema } from './common/time.js';
import { renderPlanCaptionSchema } from './render-plan.js';

/**
 * V6 §7.4：改哪里渲染哪里——低清预览。
 *
 * - 预览 = 当前版本或某个提案（试改）的 RenderPlan，用与终渲染同一个后端渲成 540p 级的 MP4；
 * - 画面按固定时间窗切片渲染，每个窗口按切片内容哈希缓存，未变化的窗口直接复用（流复制拼接）；
 *   声音整条渲染（避免接缝），字幕不烧录、由浏览器按 `captions` 叠加；
 * - 同一序列 + 同一计划哈希的预览只渲一次（采用刚预览过的提案时直接命中）。
 */

export const PREVIEW_RENDER_JOB_TYPE = 'PREVIEW_RENDER';
export const PREVIEW_SEGMENT_SECONDS = 2;

export const PREVIEW_SOURCES = ['REVISION', 'PROPOSAL'] as const;
export const PREVIEW_STATUSES = ['QUEUED', 'RENDERING', 'READY', 'FAILED'] as const;
export const previewStatusSchema = z.enum(PREVIEW_STATUSES);
export type PreviewStatus = z.infer<typeof previewStatusSchema>;

export const requestSequencePreviewSchema = z.object({
  /** 为空 = 当前版本；否则预览该提案（试改，工程不变） */
  proposalId: opaqueIdSchema.nullable().default(null),
}).strict();
export type RequestSequencePreview = z.input<typeof requestSequencePreviewSchema>;

export const previewClipSchema = z.object({
  clipId: opaqueIdSchema,
  trackId: opaqueIdSchema,
  kind: z.enum(['VIDEO', 'AUDIO']),
  sourceVersionId: opaqueIdSchema,
  sequenceRange: mediaRangeSchema,
}).strict();
export type PreviewClip = z.infer<typeof previewClipSchema>;

export const sequencePreviewSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  sequenceId: opaqueIdSchema,
  source: z.enum(PREVIEW_SOURCES),
  projectRevision: z.number().int().nonnegative(),
  proposalId: opaqueIdSchema.nullable(),
  planHash: z.string().regex(/^[0-9a-f]{64}$/),
  status: previewStatusSchema,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  frameRate: frameRateSchema,
  duration: mediaTimeSchema,
  /** 浏览器叠加的字幕（与计划同源） */
  captions: z.array(renderPlanCaptionSchema),
  /** 这份预览里的片段（与计划同源；试改预览时即试改后的时间线，供时间带显示与指认） */
  clips: z.array(previewClipSchema),
  /** READY 时的短期签名播放地址（不是永久文件地址） */
  playbackUrl: z.string().url().nullable(),
  segments: z.object({
    total: z.number().int().nonnegative(),
    reused: z.number().int().nonnegative(),
    rendered: z.number().int().nonnegative(),
  }).strict(),
  renderMs: z.number().int().nonnegative().nullable(),
  error: z.record(z.string(), z.unknown()).nullable(),
  createdAt: isoDateTimeSchema,
  completedAt: isoDateTimeSchema.nullable(),
}).strict();
export type SequencePreview = z.infer<typeof sequencePreviewSchema>;

export const previewRenderJobInputSchema = z.object({ previewId: opaqueIdSchema }).strict();
export type PreviewRenderJobInput = z.infer<typeof previewRenderJobInputSchema>;

export const PREVIEW_ERROR_REASONS = {
  NOT_FOUND: 'PREVIEW_NOT_FOUND',
  UNSUPPORTED: 'PREVIEW_UNSUPPORTED_CONTENT',
  PROPOSAL_STALE: 'PREVIEW_PROPOSAL_STALE',
  RENDER_FAILED: 'PREVIEW_RENDER_FAILED',
} as const;
