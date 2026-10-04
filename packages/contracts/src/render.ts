import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';
import { moneySchema } from './common/money.js';

/**
 * Render 契约（P07-03 / 规范 §28、§39；计划 §4.5、§8 P07-03）。
 *
 * 纪律（§39.2 / 验收"渲染中编辑不改变该次 Render 输入"）：
 * - **Render 输入 = 不可变快照引用**（projectVersionId + master narration + 资产版本清单），
 *   绝不引用"当前状态"——渲染中编辑当前项目只产生新 revision，不影响在途渲染；
 * - render_profile 固定档位（禁自由字段）；manifest hash 在产物侧固化（P07-04）；
 * - 状态机单向：QUEUED → RENDERING → QA → READY / FAILED / CANCELLED。
 */

export const RENDER_PROFILES = ['DRAFT_720', 'STUDIO_1080', 'PREMIUM_4K', 'SHORT_1080x1920'] as const;
export const renderProfileSchema = z.enum(RENDER_PROFILES);
export type RenderProfile = z.infer<typeof renderProfileSchema>;

/** 档位 → 输出规格（宽/高/fps；QA 按此核验，§86）。 */
export const RENDER_PROFILE_SPECS: Readonly<Record<RenderProfile, { width: number; height: number; fps: number }>> = {
  DRAFT_720: { width: 1280, height: 720, fps: 30 },
  STUDIO_1080: { width: 1920, height: 1080, fps: 30 },
  PREMIUM_4K: { width: 3840, height: 2160, fps: 30 },
  SHORT_1080x1920: { width: 1080, height: 1920, fps: 30 },
};

export const RENDER_STATUSES = ['QUEUED', 'RENDERING', 'QA', 'READY', 'FAILED', 'CANCELLED'] as const;
export const renderStatusSchema = z.enum(RENDER_STATUSES);
export type RenderStatus = z.infer<typeof renderStatusSchema>;

export const RENDER_ERROR_REASONS = {
  /** 版本不存在/跨工作区 */
  VERSION_NOT_FOUND: 'VERSION_NOT_FOUND',
  /** 快照缺 Master Narration（Audio-First：无对齐不成片） */
  MASTER_NARRATION_MISSING: 'MASTER_NARRATION_MISSING',
  /** 快照内场景为空 */
  NO_SCENES: 'NO_SCENES',
  /** 不允许的状态迁移（如 READY → RENDERING） */
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  /** QA 未通过（P07-05 消费） */
  QA_FAILED: 'QA_FAILED',
} as const;

export type RenderErrorReason = (typeof RENDER_ERROR_REASONS)[keyof typeof RENDER_ERROR_REASONS];

/** 渲染输入清单（快照引用集；全部为不可变对象 id/版本，无"当前"指针） */
export const renderInputSchema = z.object({
  /** 不可变项目版本（sceneGraph/身份/样式快照） */
  projectVersionId: opaqueIdSchema,
  /** Master Narration 行（含 Alignment/cues 与 master 音频资产版本） */
  masterNarrationId: opaqueIdSchema.nullable().default(null),
  /** 素材版本清单（版本级引用，§4.3 不变量 8） */
  assetVersionIds: z.array(opaqueIdSchema).default([]),
  format: z.object({ width: z.number().int().positive(), height: z.number().int().positive(), fps: z.number().int().positive() }),
});

export type RenderInput = z.infer<typeof renderInputSchema>;

export const renderRecordSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  profile: renderProfileSchema,
  status: renderStatusSchema,
  input: renderInputSchema,
  /** 成本（估计/实际；货币为定点字符串——渲染本身不经 Provider，但记录资源成本口径） */
  estimatedCost: moneySchema.nullable().default(null),
  manifestHash: z.string().nullable().default(null),
  /** 产物资产（MP4/SRT/VTT；P07-04 填充） */
  outputAssetIds: z.array(opaqueIdSchema).default([]),
  error: z.record(z.string(), z.unknown()).nullable().default(null),
  createdBy: z.string().nullable().default(null),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export type RenderRecord = z.infer<typeof renderRecordSchema>;

export const createRenderRequestSchema = z.object({
  profile: renderProfileSchema,
  /** 不提供则自动创建 FINAL_RENDER 版本快照；提供则必须属于本项目（渲染既有版本） */
  projectVersionId: opaqueIdSchema.optional(),
});

export type CreateRenderRequest = z.input<typeof createRenderRequestSchema>;
