import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';
import { intentRevisionSchema } from './selection.js';

/**
 * N05-01 实时会话与短期凭证适配（V03-26／V03-49／V03-53）+ 增量设计 §6—§8 的流式协议。
 *
 * 纪律：
 * - **长期 Key 永不下发**：会话只返回短期凭证（`ephemeralCredential`），且响应结构里没有任何 Provider
 *   Key/Secret 字段；凭证有 TTL 与作用域，只能用于语音流；
 * - **权限不信任客户端会话配置**：会话创建与每次操作都由服务端按 workspace/project 权限校验；
 * - **代际隔离**：会话有 `generation`，旧代际（或已撤销/过期会话）的晚到事件一律拒绝；
 * - **partial 只读**：转写中/修订中的文字属于**可撤销预备**，不得写工程（不落 edit_events、不动 revision），
 *   只有 `SEALED` 的 IntentRevision 才能进入正式编辑与付费制作。
 */

export const VOICE_SESSION_STATUSES = ['OPEN', 'CLOSED', 'EXPIRED', 'REVOKED'] as const;
export const voiceSessionStatusSchema = z.enum(VOICE_SESSION_STATUSES);
export type VoiceSessionStatus = z.infer<typeof voiceSessionStatusSchema>;

export const VOICE_TRANSPORTS = ['SERVER_RELAY', 'PROVIDER_SIDEBAND', 'BROWSER_SPEECH_FALLBACK'] as const;
export const voiceTransportSchema = z.enum(VOICE_TRANSPORTS);
export type VoiceTransport = z.infer<typeof voiceTransportSchema>;

/** 能力标志：**未列出一律视为不支持**（不得把未知能力展示为支持）。 */
export const VOICE_CAPABILITY_FLAGS = [
  'STREAMING_PARTIALS',
  'SERVER_VAD',
  'WORD_TIMESTAMPS',
  'BARGE_IN',
  'SERVER_SIDE_TOOLS',
] as const;
export const voiceCapabilityFlagSchema = z.enum(VOICE_CAPABILITY_FLAGS);
export type VoiceCapabilityFlag = z.infer<typeof voiceCapabilityFlagSchema>;

export const voiceCapabilitiesSchema = z.object({
  transport: voiceTransportSchema,
  supported: z.array(voiceCapabilityFlagSchema),
  unsupported: z.array(voiceCapabilityFlagSchema),
}).strict();

export type VoiceCapabilities = z.infer<typeof voiceCapabilitiesSchema>;

/** 未在实际适配器能力表中出现的标志一律视为不支持。 */
export const voiceSupports = (capabilities: VoiceCapabilities, flag: VoiceCapabilityFlag): boolean =>
  capabilities.supported.includes(flag) && !capabilities.unsupported.includes(flag);

/** 短期凭证：只有作用域与有效期，不含任何长期 Key。 */
export const ephemeralCredentialSchema = z.object({
  kind: z.literal('EPHEMERAL_SESSION'),
  token: z.string().min(16).max(512),
  scopes: z.array(z.enum(['voice:stream', 'voice:tools'])),
  expiresAt: isoDateTimeSchema,
}).strict();

export type EphemeralCredential = z.infer<typeof ephemeralCredentialSchema>;

export const voiceSessionSchema = z.object({
  sessionId: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  /** 会话绑定的选择锚点（指代与作用域的权威来源；可为空 = 尚未选择） */
  selectionAnchorId: opaqueIdSchema.nullable().default(null),
  status: voiceSessionStatusSchema,
  /** 代际：客户端重连/服务端重建会话时递增，旧代际事件一律拒绝 */
  generation: z.number().int().positive(),
  /** 时钟纪元（本地反馈与云端事件用同一时间基准对齐） */
  clockEpoch: z.number().int().nonnegative(),
  capabilities: voiceCapabilitiesSchema,
  issuedAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
}).strict();

export type VoiceSession = z.infer<typeof voiceSessionSchema>;

export const VOICE_STREAM_EVENT_KINDS = [
  /** 转写中（可修订，只读预备） */
  'TRANSCRIPT_PARTIAL',
  /** 修订既有转写（改口：产生新的转写修订号，旧修订被取代） */
  'TRANSCRIPT_REVISED',
  /** 目标高亮（解析中的候选） */
  'TARGET_HIGHLIGHT',
  /** 意图草案已锁定 */
  'INTENT_DRAFT',
] as const;
export const voiceStreamEventKindSchema = z.enum(VOICE_STREAM_EVENT_KINDS);
export type VoiceStreamEventKind = z.infer<typeof voiceStreamEventKindSchema>;

/**
 * 事件信封（增量设计 §8.4）：序号只在**定义的生产者/会话流内**有序，
 * 不能把不同连接的序号当成全局有序；晚到事件带旧 `generation` 必须被拒。
 */
export const voiceEventEnvelopeSchema = z.object({
  eventId: opaqueIdSchema,
  /** 事件种类（转写中/修订/目标高亮/意图草案） */
  kind: voiceStreamEventKindSchema,
  sessionId: opaqueIdSchema,
  clockEpoch: z.number().int().nonnegative(),
  seq: z.number().int().positive(),
  generation: z.number().int().positive(),
  utteranceId: opaqueIdSchema.nullable().default(null),
  requestId: z.string().min(1).max(120),
  intentRevision: z.number().int().positive().nullable().default(null),
  producer: z.enum(['CLIENT', 'SERVER', 'PROVIDER']),
  occurredAt: isoDateTimeSchema,
  payloadSchemaVersion: z.string().min(1).max(32),
  payload: z.record(z.string(), z.unknown()),
}).strict();

export type VoiceEventEnvelope = z.infer<typeof voiceEventEnvelopeSchema>;

export const createVoiceSessionRequestSchema = z.object({
  selectionAnchorId: opaqueIdSchema.nullable().default(null),
  /** 请求的客户端传输偏好（服务端按适配器能力裁决，不信任客户端声明作为权限依据） */
  preferredTransport: voiceTransportSchema.optional(),
}).strict();

/**
 * 创建会话时才返回短期凭证（**只返回一次**，之后读取会话不再回带任何凭证材料）：
 * 长期 Provider Key 永不下发，短期凭证也不重复下发。
 */
export const createVoiceSessionResponseSchema = z.object({
  session: voiceSessionSchema,
  credential: ephemeralCredentialSchema,
}).strict();

export const appendVoiceEventRequestSchema = z.object({
  event: voiceEventEnvelopeSchema,
}).strict();

/** 转写修订：改口产生新修订，旧修订被取代（同一 `utteranceId` 内单向前进）。 */
export const voiceTranscriptRevisionSchema = z.object({
  utteranceId: opaqueIdSchema,
  revision: z.number().int().positive(),
  text: z.string().max(4_000),
  isFinal: z.boolean(),
  supersedesRevision: z.number().int().positive().nullable().default(null),
  updatedAt: isoDateTimeSchema,
}).strict();

export type VoiceTranscriptRevision = z.infer<typeof voiceTranscriptRevisionSchema>;

export const appendVoiceEventResponseSchema = z.object({
  accepted: z.literal(true),
  /** 服务端记录的转写修订（partial/revision 事件才有） */
  transcript: voiceTranscriptRevisionSchema.nullable().default(null),
  /** partial 只读：明确告知客户端"尚未写工程" */
  projectUntouched: z.literal(true),
}).strict();

export const VOICE_ERROR_REASONS = {
  SESSION_NOT_FOUND: 'VOICE_SESSION_NOT_FOUND',
  SESSION_NOT_OPEN: 'VOICE_SESSION_NOT_OPEN',
  SESSION_EXPIRED: 'VOICE_SESSION_EXPIRED',
  SESSION_REVOKED: 'VOICE_SESSION_REVOKED',
  STALE_GENERATION: 'VOICE_STALE_GENERATION',
  UNSUPPORTED_CAPABILITY: 'VOICE_UNSUPPORTED_CAPABILITY',
  CREDENTIAL_UNAVAILABLE: 'VOICE_CREDENTIAL_SIGNING_UNAVAILABLE',
  UTTERANCE_NOT_SEALABLE: 'VOICE_UTTERANCE_NOT_SEALABLE',
  ANCHOR_MISMATCH: 'VOICE_ANCHOR_MISMATCH',
} as const;

export type VoiceErrorReason = (typeof VOICE_ERROR_REASONS)[keyof typeof VOICE_ERROR_REASONS];

export const sealUtteranceRequestSchema = z.object({
  utteranceId: opaqueIdSchema,
  transcriptRevision: z.number().int().positive(),
  interpretedAction: z.string().min(1).max(64),
  targetBindings: intentRevisionSchema.shape.targetBindings,
  explicitConstraints: z.array(z.string().min(1).max(200)).max(32).default([]),
  assumptions: z.array(z.string().min(1).max(200)).max(32).default([]),
}).strict();

export type SealUtteranceRequest = z.infer<typeof sealUtteranceRequestSchema>;

/** seal 的响应就是规范 IntentRevision（送入 planRangeEdit 的唯一入口）。 */
export const sealUtteranceResponseSchema = z.object({
  intentRevision: intentRevisionSchema,
  /** seal 之前的所有 partial 都是只读预备；seal 不改工程，正式变更仍走统一编辑协议 */
  projectUntouched: z.literal(true),
}).strict();
