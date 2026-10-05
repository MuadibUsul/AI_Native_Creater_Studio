import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';

/**
 * Voice Clone 契约（P10-02 / 规范 §6.2、§14.3、§20.1—20.3、§95；计划 §8）。
 *
 * 硬约束（验收）：
 * - **未授权不提交**：Consent 记录（授权声明版本 + 文本哈希 + 主体类型）不存在/已撤销 → 拒绝提交（422）；
 * - **训练失败可恢复**：FAILED 且 retryable → 可重试（样本与 Consent 保留）；
 * - **退休 / 平台解绑 / Provider 删除可区分**：三个独立时间戳与状态（本地方向 vs Provider 方向），
 *   不混为一谈；
 * - **字段不得混同**（§14.3 MUST）：原始样本（voice_clone_samples）/ 授权状态（voice_consents）/
 *   provider_voice_id / retention policy / ownership metadata 各自独立字段；
 * - **禁止"任意名人 MP3 克隆"**：Consent 主体类型必须为 SELF 或 AUTHORIZED_OTHER（并记录声明版本）。
 */

export const VOICE_CLONE_KINDS = ['INSTANT', 'PROFESSIONAL'] as const;
export const voiceCloneKindSchema = z.enum(VOICE_CLONE_KINDS);
export type VoiceCloneKind = z.infer<typeof voiceCloneKindSchema>;

export const VOICE_CLONE_MODES = ['MANAGED', 'BYOK'] as const;
export const voiceCloneModeSchema = z.enum(VOICE_CLONE_MODES);

export const VOICE_CLONE_STATUSES = ['DRAFT', 'SUBMITTED', 'TRAINING', 'READY', 'FAILED', 'RETIRED', 'UNLINKED', 'PROVIDER_DELETED'] as const;
export const voiceCloneStatusSchema = z.enum(VOICE_CLONE_STATUSES);
export type VoiceCloneStatus = z.infer<typeof voiceCloneStatusSchema>;

/* ---------- 音质检测（噪声/削波/时长/有效语音比例） ---------- */

export const VOICE_QUALITY_VERDICTS = ['PASS', 'WARN', 'FAIL'] as const;
export const voiceQualityVerdictSchema = z.enum(VOICE_QUALITY_VERDICTS);
export type VoiceQualityVerdict = z.infer<typeof voiceQualityVerdictSchema>;

export const voiceQualityFindingSchema = z.object({
  code: z.string().min(1).max(64),
  severity: z.enum(['INFO', 'WARN', 'FAIL']),
  message: z.string().min(1).max(300),
});

export type VoiceQualityFinding = z.infer<typeof voiceQualityFindingSchema>;

export const voiceQualityReportSchema = z.object({
  verdict: voiceQualityVerdictSchema,
  /** 格式（仅 WAV PCM16 支持深度指标；其余格式明确不支持——不伪造检测） */
  format: z.string().min(1).max(40),
  durationMs: z.number().int().nonnegative().nullable().default(null),
  sampleRateHz: z.number().int().positive().nullable().default(null),
  channels: z.number().int().positive().nullable().default(null),
  /** 静音比（能量阈值以下的窗口占比） */
  silenceRatio: z.number().min(0).max(1).nullable().default(null),
  /** 削波比（|x| ≥ 0.99 的样本占比） */
  clippingRatio: z.number().min(0).max(1).nullable().default(null),
  /** 有效语音比（达到语音能量阈值的窗口占比） */
  effectiveSpeechRatio: z.number().min(0).max(1).nullable().default(null),
  peakDb: z.number().nullable().default(null),
  rmsDb: z.number().nullable().default(null),
  findings: z.array(voiceQualityFindingSchema).default([]),
  analyzedAt: isoDateTimeSchema,
});

export type VoiceQualityReport = z.infer<typeof voiceQualityReportSchema>;

/** 质量阈值（数据化；单测锁定） */
export const VOICE_QUALITY_THRESHOLDS = {
  /** 最短时长（毫秒）——过短无法克隆 */
  minDurationMs: 10_000,
  /** Professional 建议最短时长（低于则 WARN 引导补录） */
  professionalRecommendedMs: 60_000,
  /** 最长时长（毫秒）——过长属误传（整段音频） */
  maxDurationMs: 10 * 60 * 1000,
  /** 静音比上限（超过 = 多为静音） */
  maxSilenceRatio: 0.7,
  /** 削波比：>warn → WARN；>fail → FAIL */
  clippingWarnRatio: 0.02,
  clippingFailRatio: 0.1,
  /** 有效语音比下限（低于 = 有效语音不足） */
  minEffectiveSpeechRatio: 0.3,
  /** 采样率下限（低于 = 音质不足） */
  minSampleRateHz: 16_000,
} as const;

/* ---------- Consent（授权声明；独立于样本与克隆） ---------- */

export const VOICE_CONSENT_SUBJECT_TYPES = ['SELF', 'AUTHORIZED_OTHER'] as const;
export const voiceConsentSubjectTypeSchema = z.enum(VOICE_CONSENT_SUBJECT_TYPES);

export const voiceConsentSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  creatorIdentityId: opaqueIdSchema,
  subjectType: voiceConsentSubjectTypeSchema,
  /** 授权声明版本（域层持有文本；这里记录版本与文本哈希——可核对） */
  statementVersion: z.string().min(1).max(40),
  statementHash: z.string().regex(/^[0-9a-f]{64}$/),
  acceptedByUserId: opaqueIdSchema,
  acceptedAt: isoDateTimeSchema,
  /** 撤销时间（撤销后不得提交/继续训练） */
  revokedAt: isoDateTimeSchema.nullable().default(null),
  notes: z.string().max(500).nullable().default(null),
});

export type VoiceConsent = z.infer<typeof voiceConsentSchema>;

export const confirmVoiceConsentRequestSchema = z.object({
  subjectType: voiceConsentSubjectTypeSchema,
  notes: z.string().max(500).optional(),
});

/* ---------- 样本（独立表；bytes 存于对象存储，此表只存引用与检测报告） ---------- */

export const voiceCloneSampleSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  creatorIdentityId: opaqueIdSchema,
  assetId: opaqueIdSchema,
  assetVersionId: opaqueIdSchema,
  byteSize: z.number().int().positive(),
  contentType: z.string().min(1).max(120),
  quality: voiceQualityReportSchema,
  /** 被哪个 clone 使用（提交时回填；独立字段——样本与克隆不混同） */
  cloneId: opaqueIdSchema.nullable().default(null),
  createdAt: isoDateTimeSchema,
});

export type VoiceCloneSample = z.infer<typeof voiceCloneSampleSchema>;

export const addVoiceSampleRequestSchema = z.object({
  assetId: opaqueIdSchema,
  assetVersionId: opaqueIdSchema,
  /** 目标档位（Professional 引导：样本 < 60s 记 WARN 建议补录——不伪造通过） */
  kind: z.enum(['INSTANT', 'PROFESSIONAL']).default('INSTANT'),
});

/* ---------- 克隆 ---------- */

export const voiceCloneFailureSchema = z.object({
  code: z.string().min(1).max(64),
  message: z.string().min(1).max(300),
  at: isoDateTimeSchema,
  /** 训练失败可恢复：true = 可重试（样本与 Consent 保留） */
  retryable: z.boolean(),
});

export const voiceCloneSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  creatorIdentityId: opaqueIdSchema,
  kind: voiceCloneKindSchema,
  /** Provider 标识（如 'mock-voice'；真实接入随凭据） */
  provider: z.string().min(1).max(60),
  mode: voiceCloneModeSchema,
  status: voiceCloneStatusSchema,
  /** 汇总质量（取所用样本的最优判定） */
  qualityVerdict: voiceQualityVerdictSchema,
  /** 授权状态（独立字段；提交门槛） */
  consentId: opaqueIdSchema.nullable().default(null),
  /** Provider 侧标识（独立字段） */
  providerVoiceId: z.string().max(200).nullable().default(null),
  providerJobId: z.string().max(200).nullable().default(null),
  /** 保留策略（用户/运营声明；独立字段） */
  retentionPolicy: z.string().max(200).nullable().default(null),
  /** 归属元数据（独立字段；如 author/company/license-note） */
  ownershipMetadata: z.record(z.string(), z.unknown()).default({}),
  failure: voiceCloneFailureSchema.nullable().default(null),
  submittedAt: isoDateTimeSchema.nullable().default(null),
  trainedAt: isoDateTimeSchema.nullable().default(null),
  /** 本地退休（Provider 侧保留） */
  retiredAt: isoDateTimeSchema.nullable().default(null),
  /** 平台解绑（与 Creator Identity 断开关联；Provider 侧保留） */
  unlinkedAt: isoDateTimeSchema.nullable().default(null),
  /** Provider 侧删除（不可恢复；与本地状态可区分） */
  providerDeletedAt: isoDateTimeSchema.nullable().default(null),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export type VoiceClone = z.infer<typeof voiceCloneSchema>;

export const submitVoiceCloneRequestSchema = z.object({
  kind: voiceCloneKindSchema,
  provider: z.string().min(1).max(60),
  mode: voiceCloneModeSchema,
  retentionPolicy: z.string().max(200).optional(),
  ownershipMetadata: z.record(z.string(), z.unknown()).optional(),
});

export const voiceCloneStateSchema = z.object({
  clone: voiceCloneSchema.nullable(),
  samples: z.array(voiceCloneSampleSchema),
  consent: voiceConsentSchema.nullable(),
  /** 是否已绑定到 Creator Identity 的 VoiceIdentity（平台解绑后为 false） */
  boundToIdentity: z.boolean(),
});

export type VoiceCloneState = z.infer<typeof voiceCloneStateSchema>;

export const VOICE_CLONE_ERROR_REASONS = {
  /** 未登记/已撤销授权（**未授权不提交**） */
  CONSENT_REQUIRED: 'CONSENT_REQUIRED',
  /** 无合格样本（无 PASS 样本） */
  SAMPLES_REQUIRED: 'SAMPLES_REQUIRED',
  /** 样本格式不支持深度质量检测（当前仅 WAV PCM16；不伪造检测） */
  QUALITY_UNSUPPORTED_FORMAT: 'QUALITY_UNSUPPORTED_FORMAT',
  /** 样本质量不合格（FAIL——先修正/补录再提交） */
  QUALITY_FAILED: 'QUALITY_FAILED',
  /** BYOK 模式缺少对应 Provider 连接 */
  BYOK_CONNECTION_REQUIRED: 'BYOK_CONNECTION_REQUIRED',
  /** 克隆未装配 Provider（501 fail-closed） */
  CLONE_PROVIDER_UNAVAILABLE: 'CLONE_PROVIDER_UNAVAILABLE',
  /** 状态不允许该操作（如非 FAILED 重试、已删除再操作） */
  INVALID_STATE: 'INVALID_STATE',
} as const;

export type VoiceCloneErrorReason = (typeof VOICE_CLONE_ERROR_REASONS)[keyof typeof VOICE_CLONE_ERROR_REASONS];

/* ---------- Provider seam（真实适配器随凭据接入；Mock 同构） ---------- */

export interface VoiceCloneProviderInput {
  workspaceId: string;
  creatorIdentityId: string;
  kind: VoiceCloneKind;
  /** 声音名称（Provider 侧展示） */
  name: string;
  /** 样本字节（MANAGED：平台直传；BYOK：用用户连接凭据） */
  samples: { bytes: Uint8Array; contentType: string }[];
  /** BYOK：工作区连接引用（适配器自行解密使用；平台不持有明文） */
  connection?: { connectionId: string; provider: string };
}

export interface VoiceCloneProvider {
  readonly kind: string;
  createInstantClone(input: VoiceCloneProviderInput): Promise<{ providerVoiceId: string }>;
  createProfessionalClone(input: VoiceCloneProviderInput): Promise<{ providerJobId: string }>;
  getCloneStatus(input: { providerJobId: string }): Promise<{ state: 'TRAINING' | 'READY' | 'FAILED'; providerVoiceId?: string; error?: { code: string; message: string } }>;
  /** Provider 侧删除（不可恢复；与本地退休/解绑可区分） */
  deleteVoice(input: { providerVoiceId: string }): Promise<void>;
}
