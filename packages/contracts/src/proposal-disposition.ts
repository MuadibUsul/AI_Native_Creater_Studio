import { opaqueIdSchema } from './common/ids.js';
import { z } from 'zod';

/**
 * N06-05：候选处置语义（"方向对再改" / "采用" / "后面也这样" / "拒绝"）的**权威契约 + 确定性解析**。
 *
 * 纪律（增量设计 §6.2、§8.5）：
 * - **沉默绝不等于确认**：无表态 → `NONE` 且 `requiresConfirmation=true`，不得据此采用；
 * - **"再慢一点"是继续微调，不是采用** → `REFINE`，调用方不得把它当 `ADOPT`；
 * - **多个候选且无唯一目标** → `requiresDisambiguation=true` 且 `targetProposalId=null`，必须消歧；
 * - 真实 NLU 由语音/LLM 层给出 `uiAction`（显式动作优先），本函数提供**确定性兜底**与统一口径，
 *   绝不用模糊猜测覆盖显式动作。
 */

export const PROPOSAL_DISPOSITIONS = ['ADOPT', 'REFINE', 'APPLY_MORE', 'DISCARD', 'NONE'] as const;
export const proposalDispositionSchema = z.enum(PROPOSAL_DISPOSITIONS);
export type ProposalDisposition = z.infer<typeof proposalDispositionSchema>;

export const PROPOSAL_DISPOSITION_REASONS = {
  SILENCE: 'SILENCE',
  UNRECOGNIZED: 'UNRECOGNIZED_UTTERANCE',
  UNIQUE_CANDIDATE: 'UNIQUE_CANDIDATE',
  EXPLICIT_TARGET: 'EXPLICIT_TARGET',
  NO_CANDIDATE: 'NO_CANDIDATE',
  TARGET_NOT_A_CANDIDATE: 'TARGET_NOT_A_CANDIDATE',
  MULTIPLE_CANDIDATES: 'MULTIPLE_CANDIDATES',
} as const;
export type ProposalDispositionReason = (typeof PROPOSAL_DISPOSITION_REASONS)[keyof typeof PROPOSAL_DISPOSITION_REASONS];

export interface ProposalDispositionCandidate {
  proposalId: string;
  /** 候选代际（越大越新；用于"最新意图"消歧提示） */
  generation: number;
}

export interface ResolveProposalDispositionInput {
  /** 语音/文本表达（可空 = 沉默） */
  utterance?: string | null;
  /** UI 显式动作（优先于文本；由对比回放组件的按钮产生） */
  uiAction?: Exclude<ProposalDisposition, 'NONE'> | null;
  /** 用户点选的候选（消歧的唯一权威来源） */
  explicitTargetId?: string | null;
  candidates: readonly ProposalDispositionCandidate[];
}

export interface ProposalDispositionResolution {
  disposition: ProposalDisposition;
  /** 解析出的目标候选（未确定则为 null） */
  targetProposalId: string | null;
  /** 沉默/无法识别：必须显式确认（不得因沉默采用） */
  requiresConfirmation: boolean;
  /** 多个候选且无唯一目标：必须先消歧 */
  requiresDisambiguation: boolean;
  candidateIds: string[];
  reason: ProposalDispositionReason;
}

// 顺序敏感：先判"拒绝"，再判"后面也这样"，再判"继续微调"，最后才判"采用"。
const DISCARD_MARKERS = ['不要', '不用了', '算了', '别', '取消', '丢掉', '丢弃', '放弃', 'reject', 'discard', 'never mind'];
const APPLY_MORE_MARKERS = ['后面也这样', '后面都这样', '其余照此', '都这样', '照此', '同样处理', 'apply to all', 'same for the rest', 'do the same'];
const REFINE_MARKERS = ['再', '稍微', '一点', '试试', '改', '调整', '换个', '慢一点', '快一点', '重一点', '轻一点', 'refine', 'tweak', 'adjust', 'try again', 'not quite'];
const ADOPT_MARKERS = ['就用这个', '用这个', '采用', '就这样', '可以了', '确认', '定稿', '好的就这样', 'adopt', 'use this', 'apply this', 'keep it', 'looks good'];

const matchMarker = (text: string, markers: readonly string[]): boolean => {
  const normalized = text.trim().toLowerCase();
  return markers.some((marker) => normalized.includes(marker.toLowerCase()));
};

/** 从表达（或显式动作）解析处置；不产生任何副作用。 */
export function resolveProposalDisposition(input: ResolveProposalDispositionInput): ProposalDispositionResolution {
  const candidateIds = input.candidates.map((candidate) => candidate.proposalId);
  const base = { candidateIds, targetProposalId: null as string | null, requiresConfirmation: false, requiresDisambiguation: false };

  // 1) 决定处置（显式 UI 动作优先于文本）
  let disposition: ProposalDisposition;
  if (input.uiAction !== undefined && input.uiAction !== null) {
    disposition = input.uiAction;
  } else {
    const utterance = input.utterance ?? '';
    if (utterance.trim() === '') disposition = 'NONE';
    else if (matchMarker(utterance, DISCARD_MARKERS)) disposition = 'DISCARD';
    else if (matchMarker(utterance, APPLY_MORE_MARKERS)) disposition = 'APPLY_MORE';
    else if (matchMarker(utterance, REFINE_MARKERS)) disposition = 'REFINE';
    else if (matchMarker(utterance, ADOPT_MARKERS)) disposition = 'ADOPT';
    else disposition = 'NONE';
  }

  // 沉默/无法识别 → 必须显式确认（不采用）
  if (disposition === 'NONE') {
    const reason = (input.utterance ?? '').trim() === ''
      ? PROPOSAL_DISPOSITION_REASONS.SILENCE
      : PROPOSAL_DISPOSITION_REASONS.UNRECOGNIZED;
    return { ...base, disposition, requiresConfirmation: true, reason };
  }

  // 2) 解析目标（显式目标 > 唯一候选 > 需消歧）；reason 描述**结果闸门**。
  if (input.explicitTargetId !== undefined && input.explicitTargetId !== null) {
    if (!candidateIds.includes(input.explicitTargetId)) {
      return { ...base, disposition, requiresDisambiguation: true, reason: PROPOSAL_DISPOSITION_REASONS.TARGET_NOT_A_CANDIDATE };
    }
    return { ...base, disposition, targetProposalId: input.explicitTargetId, reason: PROPOSAL_DISPOSITION_REASONS.EXPLICIT_TARGET };
  }
  if (candidateIds.length === 0) {
    return { ...base, disposition, requiresConfirmation: true, reason: PROPOSAL_DISPOSITION_REASONS.NO_CANDIDATE };
  }
  if (candidateIds.length === 1) {
    return { ...base, disposition, targetProposalId: candidateIds[0]!, reason: PROPOSAL_DISPOSITION_REASONS.UNIQUE_CANDIDATE };
  }
  return { ...base, disposition, requiresDisambiguation: true, reason: PROPOSAL_DISPOSITION_REASONS.MULTIPLE_CANDIDATES };
}

/** 候选（投影给处置解析用）。 */
export const proposalDispositionCandidateSchema = z.object({
  proposalId: opaqueIdSchema,
  generation: z.number().int().min(1),
}).strict();
