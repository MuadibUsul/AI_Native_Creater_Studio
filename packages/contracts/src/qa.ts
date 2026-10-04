import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';

/**
 * 发布前 QA 契约（P07-05 / 规范 §86、§87；计划 §8 P07-05）。
 *
 * 口径：
 * - **同一个检查引擎**服务两处：渲染前预检（对当前项目状态）与 Final QA（对**冻结快照 + 产物字节**）；
 * - 技术 QA 以**独立复核**为准（重新解析产物、重新计算校验和、重新推导字幕时间——不信任渲染回执）；
 * - AI/Visual QA（§86 SHOULD：缩略帧评估）不在 V1 交付——检查项显式 SKIP 并记录（不静默略过）；
 * - 判定：任一 BLOCKER 失败 → verdict=FAIL；否则 PASS。PASS → Render=READY（等待人工批准，§87；批准/导出属 P07-06）。
 */

/** 检查分类：PRE_RENDER（渲染前/内容前置）× TECHNICAL（产物技术核验） */
export const QA_CATEGORIES = ['PRE_RENDER', 'TECHNICAL'] as const;
export const qaCategorySchema = z.enum(QA_CATEGORIES);
export type QaCategory = z.infer<typeof qaCategorySchema>;

export const QA_SEVERITIES = ['BLOCKER', 'WARNING'] as const;
export const qaSeveritySchema = z.enum(QA_SEVERITIES);
export type QaSeverity = z.infer<typeof qaSeveritySchema>;

export const QA_STATUSES = ['PASS', 'FAIL', 'SKIP'] as const;
export const qaStatusSchema = z.enum(QA_STATUSES);
export type QaStatus = z.infer<typeof qaStatusSchema>;

/** 检查项 ID（稳定标识；UI/报告/测试按此对齐） */
export const QA_CHECK_IDS = [
  // —— 前置/内容（预检与 Final QA 共用） ——
  /** 快照/项目内存在场景 */
  'SCENES_PRESENT',
  /** 无未解决的占位场景（§86：未解决 placeholder 不允许进入 Final） */
  'SCENE_STATUS_NO_PLACEHOLDER',
  /** 无 needs_review 场景（§86：阻止自动发布） */
  'SCENES_NOT_NEEDS_REVIEW',
  /** 图表场景必须有数据绑定（§10.3：不得编造图形数据） */
  'CHART_DATA_BINDINGS',
  /** 场景引用的来源必须存在（可追溯） */
  'SOURCE_REFERENCES_PRESENT',
  /** 场景素材绑定均有冻结版本（缺素材 → 阻止） */
  'ASSET_BINDINGS_FROZEN',
  /** 媒体类场景（IMAGE_FULL/REAL_BROLL/AI_VIDEO）必须已绑定素材（未解决占位不允许进入 Final，§86） */
  'MEDIA_SCENE_ASSETS_BOUND',
  /** Master Narration 存在（Audio-First） */
  'MASTER_NARRATION_PRESENT',
  /** 无未完成 Provider 生成任务（§86：未完成 Provider Job 不允许发布） */
  'NO_PENDING_PROVIDER_JOBS',
  // —— 技术核验（仅 Final QA） ——
  /** 产物齐备（VIDEO/SRT/VTT/MANIFEST 四件套） */
  'ARTIFACTS_PRESENT',
  /** 产物校验和与入库记录一致 */
  'ARTIFACT_CHECKSUM_MATCH',
  /** 分辨率/fps 与渲染档位一致 */
  'VIDEO_RESOLUTION_FPS',
  /** 时长与 Manifest 声明一致（±容差） */
  'VIDEO_DURATION_MATCHES_MANIFEST',
  /** 音轨存在（§86） */
  'AUDIO_TRACK_PRESENT',
  /** 字幕时间不越界（末 cue ≤ 成片时长） */
  'SUBTITLE_TIMING_BOUNDS',
  /** 字幕行宽在安全区（越界 → warning，不静默裁切） */
  'SUBTITLE_WIDTH_SAFE',
  /** 音频响度/峰值范围（需 FFmpeg ebur128——V1 显式 SKIP，不静默略过） */
  'AUDIO_LOUDNESS_RANGE',
  /** AI/Visual QA（§86 SHOULD：缩略帧抽样评估——V1 显式 SKIP） */
  'AI_VISUAL_QA',
] as const;
export const qaCheckIdSchema = z.enum(QA_CHECK_IDS);
export type QaCheckId = z.infer<typeof qaCheckIdSchema>;

export const qaCheckSchema = z.object({
  id: qaCheckIdSchema,
  category: qaCategorySchema,
  severity: qaSeveritySchema,
  status: qaStatusSchema,
  message: z.string().max(600).nullable().default(null),
  details: z.record(z.string(), z.unknown()).default({}),
});

export type QaCheck = z.infer<typeof qaCheckSchema>;

export const QA_REPORT_VERSION = 'render-qa-v1';

export const qaReportSchema = z.object({
  schemaVersion: z.literal(QA_REPORT_VERSION),
  /** 报告范围：预检（项目当前状态）或 Final QA（绑定某次 Render） */
  scope: z.enum(['PRE_RENDER', 'FINAL_RENDER']),
  workspaceId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  renderId: opaqueIdSchema.nullable().default(null),
  verdict: z.enum(['PASS', 'FAIL']),
  checks: z.array(qaCheckSchema),
  /** 统计（BLOCKER 失败数 / WARNING 失败数 / SKIP 数） */
  summary: z.object({
    blockersFailed: z.number().int().nonnegative(),
    warningsFailed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  }),
  createdAt: isoDateTimeSchema,
  createdBy: z.string().nullable().default(null),
});

export type QaReport = z.infer<typeof qaReportSchema>;

export const QA_ERROR_REASONS = {
  /** Render 不在 QA 状态（已判定/未完成渲染） */
  RENDER_NOT_IN_QA: 'RENDER_NOT_IN_QA',
  /** 媒体探测不可用（未注入 probe；fail-closed） */
  PROBE_UNAVAILABLE: 'PROBE_UNAVAILABLE',
  /** 产物缺失（存储中不可得） */
  ARTIFACT_MISSING: 'ARTIFACT_MISSING',
} as const;

export type QaErrorReason = (typeof QA_ERROR_REASONS)[keyof typeof QA_ERROR_REASONS];

/** 媒体探测结果（@remotion/media-parser 或等价实现；domain 不依赖渲染栈——经接口注入） */
export const mediaProbeResultSchema = z.object({
  width: z.number().int().positive().nullable().default(null),
  height: z.number().int().positive().nullable().default(null),
  fps: z.number().positive().nullable().default(null),
  durationMs: z.number().nonnegative().nullable().default(null),
  hasAudio: z.boolean(),
  audioCodec: z.string().nullable().default(null),
  videoCodec: z.string().nullable().default(null),
});

export type MediaProbeResult = z.infer<typeof mediaProbeResultSchema>;

/** 视频产物探测接口（实现：apps/render-worker 的 media-parser 适配器；worker 以进程隔离 CLI 调用） */
export interface RenderMediaProbe {
  readonly kind: string;
  probe(input: { bytes: Uint8Array; mimeType: string }): Promise<MediaProbeResult>;
}

/** 时长容差（秒级核验；输出容器与 manifest 声明的允许偏差） */
export const QA_DURATION_TOLERANCE_MS = 350;
