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
  /** 主要处置（`dispositions[0]`；无识别结果时为 NONE） */
  disposition: ProposalDisposition;
  /** 命中的全部处置（复合意图按优先级排列；长度 > 1 即复合） */
  dispositions: ProposalDisposition[];
  /** 是否复合意图（如"就这样，再快一点"）→ 一律要求显式确认，不静默采纳 */
  isCompound: boolean;
  /** 解析置信度（0—1）：显式 UI 动作 1；无歧义单一短语 0.9；复合 0.6；沉默/无法识别 0 */
  confidence: number;
  /** 命中的短语证据（供 UI 显示"我理解成了什么"） */
  evidence: string[];
  /** 解析出的目标候选（未确定则为 null） */
  targetProposalId: string | null;
  /** 沉默/无法识别/低置信/复合：必须显式确认（不得因沉默采用） */
  requiresConfirmation: boolean;
  /** 多个候选且无唯一目标：必须先消歧 */
  requiresDisambiguation: boolean;
  candidateIds: string[];
  reason: ProposalDispositionReason;
}

/** 低置信阈值：低于此值一律要求显式确认（误采纳的代价高于误丢弃）。 */
export const PROPOSAL_DISPOSITION_CONFIDENCE_THRESHOLD = 0.7;

/**
 * 短语级标记（**不得使用单字标记**）。
 * 历史缺陷：单字标记 `别` / `再` 会让「特别好」「区别不大」（含"别"）被误判为 DISCARD，
 * 「就这样吧，再好不过了」（含"再"）被误判为 REFINE。见测试中的评审回归用例。
 */
const DISCARD_PHRASES = [
  '不要', '不用了', '不采用', '别这样', '别再', '别用', '别改', '别弄', '别动',
  '算了', '取消这个', '取消掉', '重新来', '丢掉', '丢弃', '放弃', '不想要',
  'reject', 'discard', 'never mind', 'start over',
];
/** 惯用语例外：含这些词时其中的"不要/别"不表示拒绝（先剔除再匹配）。 */
const NEGATION_EXCEPTIONS = ['不要紧', '别客气', '不赖'];
const APPLY_MORE_PHRASES = [
  '后面也这样', '后面都这样', '其余照此', '都这样', '照此', '同样处理', '后面照做', '全都这样',
  'apply to all', 'same for the rest', 'do the same',
];
const ADOPT_PHRASES = [
  '就用这个', '就用它', '就这个', '用这个', '用它', '采用', '采纳', '就这样', '就按这个', '可以了',
  '确认', '定稿', '好的就这样', '就用这个吧', '选这个', '要这个',
  'adopt', 'use this', 'apply this', 'keep it', 'looks good', 'go with this',
];
const REFINE_PHRASES = [
  '再慢一点', '再快一点', '再慢些', '再快些', '再小一点', '再大一点', '再柔和', '再亮', '再暗',
  '稍微', '一点点', '试试', '改一下', '调整一下', '换个', '重一点', '轻一点', '再改', '再调',
  'refine', 'tweak', 'adjust', 'try again', 'not quite',
];
/** 紧贴在短语前的否定词：命中即视为该短语被否定（只查**紧邻字符**，避免"特别好/区别"误伤）。 */
const IMMEDIATE_NEGATIONS = ['不', '没', '别', '毋', '勿'];

const matchPhrase = (text: string, phrase: string): boolean => {
  const lowered = text.toLowerCase();
  const target = phrase.toLowerCase();
  let from = 0;
  for (;;) {
    const at = lowered.indexOf(target, from);
    if (at === -1) return false;
    const immediate = lowered.slice(Math.max(0, at - 1), at);
    if (!IMMEDIATE_NEGATIONS.includes(immediate)) return true;
    from = at + 1;
  }
};

const collectMatches = (text: string, phrases: readonly string[]): string[] =>
  phrases.filter((phrase) => matchPhrase(text, phrase));

/** 从表达（或显式动作）解析处置；不产生任何副作用。 */
export function resolveProposalDisposition(input: ResolveProposalDispositionInput): ProposalDispositionResolution {
  const candidateIds = input.candidates.map((candidate) => candidate.proposalId);
  const base = {
    candidateIds, targetProposalId: null as string | null, requiresConfirmation: false, requiresDisambiguation: false,
    dispositions: [] as ProposalDisposition[], isCompound: false, confidence: 0, evidence: [] as string[],
  };

  // 1) 决定处置（显式 UI 动作优先于文本）。
  let matched: ProposalDisposition[] = [];
  let evidence: string[] = [];
  let confidence = 0;
  const explicitAction = input.uiAction ?? null;
  if (explicitAction !== null) {
    matched = [explicitAction];
    evidence = ['UI_ACTION'];
    confidence = 1;
  } else {
    const raw = input.utterance ?? '';
    // 惯用语例外先剔除，避免"不要紧"被当作拒绝。
    const utterance = NEGATION_EXCEPTIONS.reduce((acc, exception) => acc.replaceAll(exception, ''), raw);
    if (utterance.trim() !== '') {
      // 优先级：拒绝 → 后面也这样 → 采用 → 继续微调（明确的采纳先于泛化的微调词）。
      const discard = collectMatches(utterance, DISCARD_PHRASES);
      const applyMore = collectMatches(utterance, APPLY_MORE_PHRASES);
      const adopt = collectMatches(utterance, ADOPT_PHRASES);
      const refine = collectMatches(utterance, REFINE_PHRASES);
      matched = [
        ...(discard.length > 0 ? (['DISCARD'] as const) : []),
        ...(applyMore.length > 0 ? (['APPLY_MORE'] as const) : []),
        ...(adopt.length > 0 ? (['ADOPT'] as const) : []),
        ...(refine.length > 0 ? (['REFINE'] as const) : []),
      ];
      evidence = [...discard, ...applyMore, ...adopt, ...refine];
      confidence = matched.length === 0 ? 0 : matched.length === 1 ? 0.9 : 0.6;
    }
  }

  // 沉默/无法识别 → 必须显式确认（不采用）
  if (matched.length === 0) {
    const reason = (input.utterance ?? '').trim() === ''
      ? PROPOSAL_DISPOSITION_REASONS.SILENCE
      : PROPOSAL_DISPOSITION_REASONS.UNRECOGNIZED;
    return { ...base, disposition: 'NONE', requiresConfirmation: true, reason, confidence: 0 };
  }

  const dispositions = matched;
  const disposition = dispositions[0]!;
  const isCompound = dispositions.length > 1;

  // 2) 解析目标（显式目标 > 唯一候选 > 需消歧）；reason 描述**结果闸门**。
  const gate = (targetProposalId: string | null, requiresDisambiguation: boolean, requiresConfirmation: boolean, reason: ProposalDispositionReason) => ({
    ...base, disposition, dispositions, isCompound, confidence, evidence,
    targetProposalId, requiresDisambiguation,
    // 复合意图一律要求显式确认；低置信同样要求确认
    requiresConfirmation: requiresConfirmation || isCompound || confidence < PROPOSAL_DISPOSITION_CONFIDENCE_THRESHOLD,
    reason,
  });

  if (input.explicitTargetId !== undefined && input.explicitTargetId !== null) {
    if (!candidateIds.includes(input.explicitTargetId)) {
      return gate(null, true, false, PROPOSAL_DISPOSITION_REASONS.TARGET_NOT_A_CANDIDATE);
    }
    return gate(input.explicitTargetId, false, false, PROPOSAL_DISPOSITION_REASONS.EXPLICIT_TARGET);
  }
  if (candidateIds.length === 0) {
    return gate(null, false, true, PROPOSAL_DISPOSITION_REASONS.NO_CANDIDATE);
  }
  if (candidateIds.length === 1) {
    return gate(candidateIds[0]!, false, false, PROPOSAL_DISPOSITION_REASONS.UNIQUE_CANDIDATE);
  }
  return gate(null, true, false, PROPOSAL_DISPOSITION_REASONS.MULTIPLE_CANDIDATES);
}

/** 候选（投影给处置解析用）。 */
export const proposalDispositionCandidateSchema = z.object({
  proposalId: opaqueIdSchema,
  generation: z.number().int().min(1),
}).strict();
