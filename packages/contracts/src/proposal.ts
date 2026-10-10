import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';
import { revisionSchema } from './common/revision.js';
import { editOperationSchema } from './edits.js';

/**
 * N06-01／N06-02／N06-04：私有候选（proposal branch）→ 确定性试改 → 原子采用。
 *
 * 纪律（增量设计 §6.2 三条通道、§8.5 候选采用完整性）：
 * - 候选是**私有**的：创建与试改都**不改确认版工程**（不写 edit_events、不推进 revision）；
 * - 试改是**确定性的**：用真实执行器在事务内跑一遍再回滚（同一操作集 → 同一结果），不是近似动画；
 * - 采用是**原子**的：绑定 `baseProjectRevision + intentRevision + selectionFingerprint + operationsHash`
 *   后由服务端重新校验（权限/锁/影响集/版本/预算），失败时不显示"已采用"且确认版保持完整；
 * - 晚到/过期候选只能被丢弃或取代，**不得**更新新候选。
 */

export const PROPOSAL_STATUSES = ['OPEN', 'COMMITTED', 'DISCARDED', 'SUPERSEDED'] as const;
export const proposalStatusSchema = z.enum(PROPOSAL_STATUSES);
export type ProposalStatus = z.infer<typeof proposalStatusSchema>;

export const PROPOSAL_ERROR_REASONS = {
  NOT_FOUND: 'PROPOSAL_NOT_FOUND',
  NOT_OPEN: 'PROPOSAL_NOT_OPEN',
  STALE_BASE: 'PROPOSAL_STALE_BASE',
  HASH_MISMATCH: 'PROPOSAL_HASH_MISMATCH',
  FINGERPRINT_MISMATCH: 'PROPOSAL_FINGERPRINT_MISMATCH',
  SUPERSEDED: 'PROPOSAL_SUPERSEDED',
  TRIAL_FAILED: 'PROPOSAL_TRIAL_FAILED',
  ADOPT_FAILED: 'PROPOSAL_ADOPT_FAILED',
} as const;

export type ProposalErrorReason = (typeof PROPOSAL_ERROR_REASONS)[keyof typeof PROPOSAL_ERROR_REASONS];

export const createProposalRequestSchema = z.object({
  /** 候选基于的工程 revision（采用时必须仍然成立） */
  baseProjectRevision: revisionSchema,
  /** 绑定的选择锚点（指纹进入采用校验；可为空 = 无选择上下文） */
  selectionAnchorId: opaqueIdSchema.nullable().default(null),
  /** 绑定的意图修订（语音/范围编辑入口产出；可为空） */
  intentRevisionId: opaqueIdSchema.nullable().default(null),
  operations: z.array(editOperationSchema).min(1).max(256),
}).strict();

export type CreateProposalRequest = z.infer<typeof createProposalRequestSchema>;

export const proposalSchema = z.object({
  proposalId: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  baseProjectRevision: revisionSchema,
  selectionAnchorId: opaqueIdSchema.nullable().default(null),
  /** 创建候选时的锚点指纹（采用时与锚点当前指纹比对） */
  selectionFingerprint: z.string().length(64).nullable().default(null),
  intentRevisionId: opaqueIdSchema.nullable().default(null),
  /** 操作集的规范哈希（采用时校验"用户看过的就是这一份"） */
  operationsHash: z.string().length(64),
  operations: z.array(editOperationSchema).min(1).max(256),
  status: proposalStatusSchema,
  /** 采用后得到的工程 revision */
  committedRevision: revisionSchema.nullable().default(null),
  createdAt: isoDateTimeSchema,
  committedAt: isoDateTimeSchema.nullable().default(null),
  discardedAt: isoDateTimeSchema.nullable().default(null),
}).strict();

export type Proposal = z.infer<typeof proposalSchema>;

/** 确定性试改结果：由真实执行器在事务内跑一遍再回滚得到（不是近似预览）。 */
export const proposalTrialSchema = z.object({
  proposalId: opaqueIdSchema,
  operationsHash: z.string().length(64),
  /** 试改后的工程 revision（**未落库**，仅供对照） */
  trialRevision: revisionSchema,
  /** 试改产生的事件摘要（操作名 + 目标 id + 前后范围摘要） */
  events: z.array(z.object({
    action: z.string().min(1).max(64),
    objectKind: z.string().max(32).nullable().default(null),
    objectId: z.string().max(64).nullable().default(null),
    summary: z.string().max(200).default(''),
  }).strict()).max(512),
  /** 试改后受影响的片段区间（供客户端局部回放/对照） */
  clipRanges: z.array(z.object({
    clipId: opaqueIdSchema,
    trackId: opaqueIdSchema,
    sequenceStartMs: z.number().int(),
    sequenceEndMs: z.number().int(),
    sourceStartMs: z.number().int(),
    sourceEndMs: z.number().int(),
  }).strict()).max(512),
  /** 结构性保证：试改未写入任何工程数据 */
  projectUntouched: z.literal(true),
}).strict();

export type ProposalTrial = z.infer<typeof proposalTrialSchema>;

export const adoptProposalRequestSchema = z.object({
  /** 用户看过的候选哈希（防止采用与看到的不一致） */
  expectedOperationsHash: z.string().length(64),
  /** 绑定的锚点指纹（可为空 = 候选未绑定锚点） */
  expectedSelectionFingerprint: z.string().length(64).nullable().default(null),
  /** 幂等键：重放返回同一结果，不产生第二次写入 */
  idempotencyKey: z.string().min(8).max(120),
}).strict();

export type AdoptProposalRequest = z.infer<typeof adoptProposalRequestSchema>;

export const adoptProposalResponseSchema = z.object({
  proposal: proposalSchema,
  projectRevision: revisionSchema,
  /** 采用是否真正生效（服务端校验失败时不会返回 true） */
  adopted: z.literal(true),
}).strict();
