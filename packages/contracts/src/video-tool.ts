import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { agentImageSchema, agentToolDescriptorSchema, agentToolNameSchema, agentTurnPurposeSchema, type AgentToolDescriptor } from './agent.js';

/**
 * V7 工具桥 `video-tool.v1`（裁决 0021，方案 §3.3、§6.2、§6.3）。
 *
 * DSH Fork 里的视频工具插件只经这座桥调用 ANCS 现有的统一工具目录：
 * - **ANCS 是唯一权威**：工具实现、每一轮的编辑草稿、权限、花费门禁、提案都在 ANCS。DSH 只拿到工具结果，不持有草稿副本；
 * - **严格且带版本**：不认识的字段与版本一律拒绝。破坏性变化发布 `v2` 并行支持，不改 v1；
 * - **幂等**：`commandId` 是 DSH 侧这次工具调用的标识。同一 `commandId` 再来一次，重放上次的结果，不再执行；
 *   同一 `commandId` 换了参数，按冲突拒绝；
 * - **GENERATE 在 ANCS 只是报价**（`quote_generation`）。真正的付费生成要用户在界面上确认，桥上不会发生扣费。
 *   方案建议的 `QUOTE` 效果不新增：旧的公开枚举不变（方案 §3.3）。
 */

export const VIDEO_TOOL_PROTOCOL_VERSION = 'video-tool.v1';

/** 参数（JSON 序列化后）上限：超过即拒绝，不截断 */
export const VIDEO_TOOL_MAX_ARGS_BYTES = 256 * 1024;
/** 给模型的文字结果上限（字符）：超过即视为畸形结果（方案 T24），不截断 */
export const VIDEO_TOOL_MAX_CONTENT_CHARS = 1_000_000;

const protocolVersionSchema = z.literal(VIDEO_TOOL_PROTOCOL_VERSION);
/** DSH 侧工具调用标识；只允许安全字符，避免进入日志或键名时被误解析 */
const commandIdSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/, 'commandId uses letters, digits and _ . : -');
const correlationIdSchema = z.string().min(1).max(128);

// ---------------------------------------------------------------------------
// 工具描述
// ---------------------------------------------------------------------------

export const videoToolDescriptorSchema = agentToolDescriptorSchema.extend({
  protocolVersion: protocolVersionSchema,
  /** 只读工具可与同一批的其它只读调用并行；改草稿、写计划、报价一律串行（草稿是整份替换） */
  concurrencySafe: z.boolean(),
  /** 单次调用的截止时间。超时后 DSH 不得重新执行，只能按 commandId 查询结果 */
  timeoutMs: z.number().int().min(1_000).max(600_000),
}).strict();
export type VideoToolDescriptor = z.infer<typeof videoToolDescriptorSchema>;

/** 看画面要抽帧（可能等代理），其余工具在库内完成 */
const DEFAULT_TIMEOUT_MS = 120_000;
const LOOK_TIMEOUT_MS = 300_000;

/** 由 ANCS 工具描述派生桥上的描述；名称、能力、说明、效果、权限、计量和输入 Schema 原样保留。 */
export function videoToolDescriptorOf(descriptor: AgentToolDescriptor): VideoToolDescriptor {
  return videoToolDescriptorSchema.parse({
    ...descriptor,
    protocolVersion: VIDEO_TOOL_PROTOCOL_VERSION,
    concurrencySafe: descriptor.effect === 'READ',
    timeoutMs: descriptor.name.startsWith('look_at_') ? LOOK_TIMEOUT_MS : DEFAULT_TIMEOUT_MS,
  });
}

// ---------------------------------------------------------------------------
// 调用
// ---------------------------------------------------------------------------

export const videoToolInvocationSchema = z.object({
  protocolVersion: protocolVersionSchema,
  correlationId: correlationIdSchema,
  commandId: commandIdSchema,
  /** ANCS 的 Agent 会话与轮次；必须与桥令牌里的声明一致 */
  sessionId: opaqueIdSchema,
  turnId: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  /**
   * 调用方看到的工程版本。与 ANCS 当前版本不一致时（用户在这一轮期间改过作品），
   * 按现有规则把草稿换到最新版本上重验，不覆盖人的改动
   */
  expectedProjectRevision: z.number().int().nonnegative(),
  toolName: agentToolNameSchema,
  args: z.record(z.string(), z.unknown()),
}).strict().superRefine((value, context) => {
  if (new TextEncoder().encode(JSON.stringify(value.args)).length > VIDEO_TOOL_MAX_ARGS_BYTES) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['args'], message: `args exceed ${String(VIDEO_TOOL_MAX_ARGS_BYTES)} bytes` });
  }
});
export type VideoToolInvocation = z.infer<typeof videoToolInvocationSchema>;

// ---------------------------------------------------------------------------
// 结果
// ---------------------------------------------------------------------------

/**
 * OK = 工具成功；
 * TOOL_ERROR = 工具运行了，返回给模型的是错误。与 legacy 的 `isError` 相同，模型可据此修正，
 *   轮次用途门禁也走这一种，与 legacy 一致：工具目录不变，只是这一步不执行；
 * REJECTED = 桥拒绝执行，工具没有运行（原因见 rejectReason）。
 */
export const VIDEO_TOOL_RESULT_STATUSES = ['OK', 'TOOL_ERROR', 'REJECTED'] as const;
export const videoToolResultStatusSchema = z.enum(VIDEO_TOOL_RESULT_STATUSES);

export const VIDEO_TOOL_REJECT_REASONS = [
  /** 协议版本不支持或信封不合法 */
  'UNSUPPORTED_PROTOCOL',
  /** 没有令牌、令牌无效或过期 */
  'UNAUTHENTICATED',
  /** 信封里的工作区 / 工程 / 会话 / 轮次与令牌不一致 */
  'SCOPE_MISMATCH',
  /** 这一轮已经结束或被取消，晚到的调用只留审计、不执行 */
  'TURN_NOT_RUNNING',
  'UNKNOWN_TOOL',
  /** 参数超过上限 */
  'ARGS_TOO_LARGE',
  /** 同一 commandId 换了参数 */
  'COMMAND_CONFLICT',
] as const;
export const videoToolRejectReasonSchema = z.enum(VIDEO_TOOL_REJECT_REASONS);
export type VideoToolRejectReason = z.infer<typeof videoToolRejectReasonSchema>;

export const videoToolResultSchema = z.object({
  protocolVersion: protocolVersionSchema,
  commandId: commandIdSchema,
  correlationId: correlationIdSchema,
  status: videoToolResultStatusSchema,
  rejectReason: videoToolRejectReasonSchema.nullable(),
  /** 结果来自重放（同一 commandId 之前已执行完） */
  replayed: z.boolean(),
  /** 给模型的结果（JSON 文本），与 legacy 工具结果相同 */
  content: z.string().max(VIDEO_TOOL_MAX_CONTENT_CHARS),
  /** 一行人类可读摘要（进轮次记录，不含素材原文） */
  summary: z.string().max(500),
  /** 给模型看的图像，按顺序跟在文字之后（看素材 / 看成片） */
  images: z.array(agentImageSchema).max(16),
  /** 执行后的工程版本（ANCS 读取，不由 DSH 递增） */
  projectRevision: z.number().int().nonnegative(),
  /** 本轮草稿的概况：内容只在 ANCS */
  draft: z.object({
    baseRevision: z.number().int().nonnegative(),
    operations: z.number().int().nonnegative(),
    changed: z.boolean(),
  }).strict(),
  traceId: z.string().min(1).max(128),
}).strict().superRefine((value, context) => {
  if ((value.status === 'REJECTED') !== (value.rejectReason !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['rejectReason'], message: 'rejectReason is set exactly when status is REJECTED' });
  }
  if (value.status === 'REJECTED' && value.draft.changed) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['draft', 'changed'], message: 'a rejected call cannot change the draft' });
  }
});
export type VideoToolResult = z.infer<typeof videoToolResultSchema>;

// ---------------------------------------------------------------------------
// 幂等记录：DSH 重试前先查，不重复执行
// ---------------------------------------------------------------------------

/**
 * NOT_STARTED / RUNNING / COMMITTED（已执行完，可重放）/ FAILED（基础设施失败，没有改动）/
 * UNKNOWN（执行中断、结果不明：不自动重跑，按 ANCS 的草稿与提案状态核对后再决定）
 */
export const VIDEO_TOOL_EXECUTION_STATES = ['NOT_STARTED', 'RUNNING', 'COMMITTED', 'FAILED', 'UNKNOWN'] as const;
export const videoToolExecutionStateSchema = z.enum(VIDEO_TOOL_EXECUTION_STATES);

export const videoToolExecutionSchema = z.object({
  protocolVersion: protocolVersionSchema,
  commandId: commandIdSchema,
  turnId: opaqueIdSchema,
  toolName: agentToolNameSchema,
  /** 规范化参数（键排序 JSON）的 SHA-256 */
  argsHash: z.string().regex(/^[0-9a-f]{64}$/),
  state: videoToolExecutionStateSchema,
  /** COMMITTED 时为执行结果，其余为 null */
  result: videoToolResultSchema.nullable(),
}).strict().superRefine((value, context) => {
  if ((value.state === 'COMMITTED') !== (value.result !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['result'], message: 'result is present exactly when state is COMMITTED' });
  }
});
export type VideoToolExecution = z.infer<typeof videoToolExecutionSchema>;

// ---------------------------------------------------------------------------
// 桥令牌声明（设计见 docs/V07/bridge-auth.md；签发与校验在 P2 落地）
// ---------------------------------------------------------------------------

/** 令牌最长有效期：与轮次的最长运行时间对齐，到期后这一轮的 DSH 调用一律拒绝 */
export const VIDEO_BRIDGE_TOKEN_MAX_TTL_SECONDS = 6 * 3600;

export const videoBridgeTokenClaimsSchema = z.object({
  v: z.literal(1),
  aud: z.literal('ancs-video-bridge'),
  workspaceId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  sessionId: opaqueIdSchema,
  turnId: opaqueIdSchema,
  /** 轮次用途：桥按它执行与 legacy 相同的门禁（批注讨论只读、自主制作不报价） */
  purpose: agentTurnPurposeSchema,
  /** 签发与到期（Unix 秒） */
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
  /** 令牌 ID（审计与撤销） */
  jti: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
}).strict().superRefine((value, context) => {
  if (value.exp <= value.iat) context.addIssue({ code: z.ZodIssueCode.custom, path: ['exp'], message: 'exp must be after iat' });
  if (value.exp - value.iat > VIDEO_BRIDGE_TOKEN_MAX_TTL_SECONDS) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['exp'], message: `token lifetime exceeds ${String(VIDEO_BRIDGE_TOKEN_MAX_TTL_SECONDS)} s` });
  }
});
export type VideoBridgeTokenClaims = z.infer<typeof videoBridgeTokenClaimsSchema>;
