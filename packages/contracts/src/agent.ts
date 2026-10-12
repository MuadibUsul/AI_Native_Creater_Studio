import { z } from 'zod';
import { strategyKnobValuesSchema } from './strategy.js';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';
import type { ProviderImplementation } from './provider-kind.js';

/**
 * V6 §6、§8：通用导演 Agent 的契约。
 *
 * - **统一工具目录：** 每个能力以同一形状暴露给 AI（名称、能力、效果、权限、是否计费、输入 JSON Schema）。
 *   导演与调度代码不按视频类型或策略分支；新增组件 = 在目录注册一个工具（裁决 0018）。
 * - **模型端口：** 与供应商无关的消息/内容块/用量形状。供应商专有块（如思考块）以 `opaque` 原样保存并按原序回放，
 *   保证同一会话可在崩溃后从日志续跑而不改写历史。
 * - **一次对话轮次（turn）** 经工作流引擎执行（外部付费调用只经工作流，V5 约束）；轮次内的改动先进入草稿，
 *   结束时成为一个提案（试改），由用户采用或撤回。
 */

export const AGENT_TURN_WORKFLOW = 'AGENT_TURN';
export const AGENT_TURN_WORKFLOW_VERSION = 1;

export const AGENT_LOCALES = ['zh-CN', 'en'] as const;
export const agentLocaleSchema = z.enum(AGENT_LOCALES);
export type AgentLocale = z.infer<typeof agentLocaleSchema>;

// ---------------------------------------------------------------------------
// 统一工具目录
// ---------------------------------------------------------------------------

/** READ：只读；DRAFT_EDIT：改本轮草稿（成为可撤销的提案）；GENERATE：付费生成（先报预估成本）。 */
export const AGENT_TOOL_EFFECTS = ['READ', 'DRAFT_EDIT', 'GENERATE'] as const;
export const agentToolEffectSchema = z.enum(AGENT_TOOL_EFFECTS);
export type AgentToolEffect = z.infer<typeof agentToolEffectSchema>;

export const AGENT_TOOL_PERMISSIONS = ['project:read', 'project:write'] as const;
export const agentToolPermissionSchema = z.enum(AGENT_TOOL_PERMISSIONS);

export const agentToolNameSchema = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/, 'tool name must be snake_case');

export const agentToolDescriptorSchema = z.object({
  name: agentToolNameSchema,
  /** 能力标识（如 timeline.edit、footage.inspect），用于能力声明、评测与计量归类 */
  capability: z.string().regex(/^[a-z][a-z0-9_.]{1,79}$/),
  /** 给模型读的说明（英文，模型侧语言中立；回应用户时按会话语言） */
  description: z.string().min(1).max(4000),
  effect: agentToolEffectSchema,
  permission: agentToolPermissionSchema,
  /** 是否产生外部计费（GENERATE 必为 true） */
  metered: z.boolean(),
  inputSchema: z.record(z.string(), z.unknown()),
}).strict();
export type AgentToolDescriptor = z.infer<typeof agentToolDescriptorSchema>;

// ---------------------------------------------------------------------------
// 模型端口（供应商无关）
// ---------------------------------------------------------------------------

/** 图像（base64，JPEG/PNG/WebP）：素材抽帧给模型"看"。单张上限约 1.5 MB（base64 2 MB）。 */
export const AGENT_IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const agentImageSchema = z.object({
  mediaType: z.enum(AGENT_IMAGE_MEDIA_TYPES),
  data: z.string().min(1).max(2_000_000).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'image data must be base64'),
}).strict();
export type AgentImage = z.infer<typeof agentImageSchema>;

export const agentContentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().max(200_000) }).strict(),
  z.object({ type: z.literal('image'), image: agentImageSchema }).strict(),
  z.object({ type: z.literal('tool_use'), id: z.string().min(1).max(200), name: z.string().min(1).max(64), input: z.unknown() }).strict(),
  z.object({
    type: z.literal('tool_result'),
    toolUseId: z.string().min(1).max(200),
    content: z.string().max(200_000),
    isError: z.boolean(),
    /** 工具返回给模型看的图像（如素材抽帧），按顺序跟在文字结果之后 */
    images: z.array(agentImageSchema).max(16).optional(),
  }).strict(),
  /** 供应商专有块（思考块等）：原样保存、原序回放，不得修改 */
  z.object({ type: z.literal('opaque'), provider: z.string().min(1).max(64), payload: z.unknown() }).strict(),
]);
export type AgentContentBlock = z.infer<typeof agentContentBlockSchema>;

export const agentModelMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.array(agentContentBlockSchema).min(1),
}).strict();
export type AgentModelMessage = z.infer<typeof agentModelMessageSchema>;

export const AGENT_STOP_REASONS = ['end_turn', 'tool_use', 'max_tokens', 'refusal', 'pause_turn', 'other'] as const;
export const agentStopReasonSchema = z.enum(AGENT_STOP_REASONS);
export type AgentStopReason = z.infer<typeof agentStopReasonSchema>;

export const agentModelUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadInputTokens: z.number().int().nonnegative(),
  cacheCreationInputTokens: z.number().int().nonnegative(),
}).strict();
export type AgentModelUsage = z.infer<typeof agentModelUsageSchema>;

export const AGENT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AgentEffort = (typeof AGENT_EFFORTS)[number];

export interface AgentModelToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** 取消信号（结构化类型：契约包不依赖 DOM/Node 类型库；运行时传入 AbortSignal）。 */
export interface AgentAbortSignal {
  readonly aborted: boolean;
}

export interface AgentModelRequest {
  /** 固定前缀（提示缓存）：系统提示与工具目录必须逐字节稳定 */
  system: string;
  tools: readonly AgentModelToolSpec[];
  messages: readonly AgentModelMessage[];
  maxOutputTokens: number;
  effort: AgentEffort;
  signal?: AgentAbortSignal;
}

export interface AgentModelResponse {
  /** 实际服务的模型 id（计量与评测按它归类） */
  model: string;
  content: AgentContentBlock[];
  stopReason: AgentStopReason;
  usage: AgentModelUsage;
}

/** 模型适配器（真实：Anthropic；测试/演示：SCRIPTED）。凭据只在服务端，不进日志与错误返回。 */
export interface AgentModelAdapter {
  readonly providerId: string;
  readonly implementation: ProviderImplementation;
  readonly model: string;
  respond(request: AgentModelRequest): Promise<AgentModelResponse>;
}

/** 模型调用失败的分类（工作流据此决定重试；付费调用不无限重试）。 */
export const AGENT_MODEL_FAILURE_KINDS = ['RATE_LIMITED', 'OVERLOADED', 'TRANSIENT', 'AUTH', 'BAD_REQUEST', 'CONTEXT_TOO_LONG'] as const;
export type AgentModelFailureKind = (typeof AGENT_MODEL_FAILURE_KINDS)[number];

export class AgentModelFailure extends Error {
  readonly kind: AgentModelFailureKind;
  readonly status: number | null;
  constructor(kind: AgentModelFailureKind, message: string, status: number | null = null) {
    super(message);
    this.name = 'AgentModelFailure';
    this.kind = kind;
    this.status = status;
  }

  get retryable(): boolean {
    return this.kind === 'RATE_LIMITED' || this.kind === 'OVERLOADED' || this.kind === 'TRANSIENT';
  }
}

/**
 * 素材抽帧端口（V6-1b，Worker 实现：流式物化源/代理文件 + FFmpeg 单帧解码）。
 * 时间为十进制秒文本（素材内时间）；返回顺序与请求一致。
 */
export interface AgentFrameSampler {
  sample(input: { storageKey: string; times: readonly string[]; maxWidth: number }): Promise<AgentImage[]>;
}

// ---------------------------------------------------------------------------
// 计量（美元按"微美元"整数记账；价格为规划用公开价，以供应商账单为准）
// ---------------------------------------------------------------------------

/** 每百万 token 的微美元单价。cacheWrite 为 5 分钟 TTL 写入价（1.25× 输入价）。 */
export interface AgentModelPrice {
  inputMicrosPerMTok: number;
  outputMicrosPerMTok: number;
  cacheReadMicrosPerMTok: number;
  cacheWriteMicrosPerMTok: number;
}

export const AGENT_MODEL_PRICES: Readonly<Record<string, AgentModelPrice>> = {
  'claude-opus-5-5': { inputMicrosPerMTok: 4_000_000, outputMicrosPerMTok: 20_000_000, cacheReadMicrosPerMTok: 200_000, cacheWriteMicrosPerMTok: 5_000_000 },
  'claude-sonnet-5-5': { inputMicrosPerMTok: 2_000_000, outputMicrosPerMTok: 10_000_000, cacheReadMicrosPerMTok: 200_000, cacheWriteMicrosPerMTok: 2_500_000 },
  'claude-haiku-5-5': { inputMicrosPerMTok: 100_000, outputMicrosPerMTok: 500_000, cacheReadMicrosPerMTok: 10_000, cacheWriteMicrosPerMTok: 125_000 },
};

/**
 * 一次模型调用的成本（微美元，向上取整）。未知模型返回 null（不臆造价格；计量面显示"未定价"）。
 */
export function agentModelCostMicros(model: string, usage: AgentModelUsage): number | null {
  const price = AGENT_MODEL_PRICES[model];
  if (price === undefined) return null;
  const total = BigInt(usage.inputTokens) * BigInt(price.inputMicrosPerMTok)
    + BigInt(usage.outputTokens) * BigInt(price.outputMicrosPerMTok)
    + BigInt(usage.cacheReadInputTokens) * BigInt(price.cacheReadMicrosPerMTok)
    + BigInt(usage.cacheCreationInputTokens) * BigInt(price.cacheWriteMicrosPerMTok);
  return Number((total + 999_999n) / 1_000_000n);
}

// ---------------------------------------------------------------------------
// 会话与轮次 API
// ---------------------------------------------------------------------------

/** 用户在发话时指着的东西（V6 §5.1）：时间范围（秒文本，精确解析）与/或片段。 */
export const agentPointerSchema = z.object({
  /** 序列时间范围（十进制秒文本，例如 "12.4"） */
  timeRange: z.object({ start: z.string().max(20), end: z.string().max(20) }).strict().nullable().default(null),
  clipIds: z.array(opaqueIdSchema).max(50).default([]),
}).strict();
export type AgentPointer = z.infer<typeof agentPointerSchema>;

export const createAgentSessionRequestSchema = z.object({
  sequenceId: opaqueIdSchema,
  locale: agentLocaleSchema.default('zh-CN'),
}).strict();
export type CreateAgentSessionRequest = z.input<typeof createAgentSessionRequestSchema>;

export const agentSessionSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  sequenceId: opaqueIdSchema,
  locale: agentLocaleSchema,
  createdBy: z.string().nullable(),
  createdAt: isoDateTimeSchema,
}).strict();
export type AgentSession = z.infer<typeof agentSessionSchema>;

export const startAgentTurnRequestSchema = z.object({
  message: z.string().trim().min(1).max(4000),
  pointer: agentPointerSchema.default({ timeRange: null, clipIds: [] }),
  /** 可选的策略（V6 §6.6）：只作为风格参考进入上下文，不改变工具与编排 */
  strategyPackId: z.string().min(1).max(120).nullable().default(null),
  /** 选用策略时的旋钮取值（缺省用策略包的默认值） */
  strategyKnobs: strategyKnobValuesSchema,
  /** 讨论一条审片批注（V6-4）：AI 只给修改方案、不改时间线；指向取自批注 */
  reviewNoteId: opaqueIdSchema.nullable().default(null),
}).strict();
export type StartAgentTurnRequest = z.input<typeof startAgentTurnRequestSchema>;

/**
 * 轮次用途（同一个通用导演、同一个工具目录）：
 * EDIT = 说一句话改作品；DISCUSS_NOTE = 讨论一条审片批注的修改方案（不改时间线）；
 * APPLY_REVIEW = 把一轮审片里已确定的批注一次做完（成为一个试改提案）。
 */
export const AGENT_TURN_PURPOSES = ['EDIT', 'DISCUSS_NOTE', 'APPLY_REVIEW'] as const;
export const agentTurnPurposeSchema = z.enum(AGENT_TURN_PURPOSES);
export type AgentTurnPurpose = z.infer<typeof agentTurnPurposeSchema>;

export const AGENT_TURN_STATUSES = ['RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'] as const;
export const agentTurnStatusSchema = z.enum(AGENT_TURN_STATUSES);
export type AgentTurnStatus = z.infer<typeof agentTurnStatusSchema>;

export const agentToolCallRecordSchema = z.object({
  name: z.string(),
  ok: z.boolean(),
  /** 一行人类可读摘要（不含原始素材内容） */
  summary: z.string().max(500),
}).strict();

export const agentTurnSchema = z.object({
  id: opaqueIdSchema,
  sessionId: opaqueIdSchema,
  workflowRunId: opaqueIdSchema.nullable(),
  status: agentTurnStatusSchema,
  purpose: agentTurnPurposeSchema,
  /** DISCUSS_NOTE：讨论的批注；APPLY_REVIEW：执行的审片轮 */
  reviewNoteId: opaqueIdSchema.nullable(),
  reviewRoundId: opaqueIdSchema.nullable(),
  message: z.string(),
  pointer: agentPointerSchema,
  /** AI 的简短回应（按会话语言） */
  reply: z.string().nullable(),
  /** 本轮改动形成的提案（无改动为 null）；采用/撤回走提案接口 */
  proposalId: opaqueIdSchema.nullable(),
  /** 本轮延续的试改（会话里仍未采用的提案）：草稿从它出发，新提案取代它 */
  continuesProposalId: opaqueIdSchema.nullable(),
  /** 本轮选用的策略（可选） */
  strategyPackId: z.string().nullable(),
  strategyKnobs: z.record(z.string(), z.string()),
  toolCalls: z.array(agentToolCallRecordSchema),
  usage: agentModelUsageSchema,
  /** 本轮模型调用成本（微美元；含未定价模型时为 null） */
  costMicros: z.number().int().nonnegative().nullable(),
  error: z.record(z.string(), z.unknown()).nullable(),
  createdAt: isoDateTimeSchema,
  completedAt: isoDateTimeSchema.nullable(),
}).strict();
export type AgentTurn = z.infer<typeof agentTurnSchema>;

/** 每条视频的 AI 成本（V6 §10：实测校正估算）。含未定价模型调用时总额为 null（不填零）。 */
export const projectAgentCostSchema = z.object({
  projectId: opaqueIdSchema,
  turns: z.number().int().nonnegative(),
  usage: agentModelUsageSchema,
  costMicros: z.number().int().nonnegative().nullable(),
  unpricedCalls: z.number().int().nonnegative(),
}).strict();
export type ProjectAgentCost = z.infer<typeof projectAgentCostSchema>;

export const AGENT_ERROR_REASONS = {
  SESSION_NOT_FOUND: 'AGENT_SESSION_NOT_FOUND',
  TURN_IN_PROGRESS: 'AGENT_TURN_IN_PROGRESS',
  MODEL_NOT_CONFIGURED: 'AGENT_MODEL_NOT_CONFIGURED',
  MODEL_FAILED: 'AGENT_MODEL_FAILED',
  MODEL_REFUSED: 'AGENT_MODEL_REFUSED',
  BUDGET_EXCEEDED: 'AGENT_BUDGET_EXCEEDED',
  ITERATION_LIMIT: 'AGENT_ITERATION_LIMIT',
} as const;
