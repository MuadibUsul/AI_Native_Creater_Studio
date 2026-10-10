import { describe, expect, it } from 'vitest';
import { PROPOSAL_DISPOSITION_REASONS, resolveProposalDisposition } from './proposal-disposition.js';

/**
 * N06-05：处置解析的四条纪律 —— 沉默不确认、"再慢一点"不是采用、多候选要消歧、显式动作优先。
 */
const candidates = [{ proposalId: 'prop_1', generation: 1 }, { proposalId: 'prop_2', generation: 2 }];
const single = [{ proposalId: 'prop_1', generation: 1 }];

describe('N06-05 resolveProposalDisposition', () => {
  it('沉默（空表达、无动作）→ NONE 且必须显式确认，绝不采用', () => {
    const resolution = resolveProposalDisposition({ utterance: '   ', candidates });
    expect(resolution.disposition).toBe('NONE');
    expect(resolution.requiresConfirmation).toBe(true);
    expect(resolution.targetProposalId).toBeNull();
    expect(resolution.reason).toBe(PROPOSAL_DISPOSITION_REASONS.SILENCE);
  });

  it('“再慢一点”是继续微调（REFINE），不是采用', () => {
    const resolution = resolveProposalDisposition({ utterance: '再慢一点', candidates, explicitTargetId: 'prop_2' });
    expect(resolution.disposition).toBe('REFINE');
    expect(resolution.disposition).not.toBe('ADOPT');
    expect(resolution.targetProposalId).toBe('prop_2');
  });

  it('“不要这个了”是拒绝（DISCARD），不被微调标记误判', () => {
    const resolution = resolveProposalDisposition({ utterance: '不要这个了', candidates, explicitTargetId: 'prop_1' });
    expect(resolution.disposition).toBe('DISCARD');
  });

  it('“后面也这样”是 APPLY_MORE（作用范围扩展），仍需明确目标', () => {
    const resolution = resolveProposalDisposition({ utterance: '后面也这样', candidates, explicitTargetId: 'prop_2' });
    expect(resolution.disposition).toBe('APPLY_MORE');
    expect(resolution.targetProposalId).toBe('prop_2');
  });

  it('多个候选且“用这个”无唯一目标 → 必须消歧，不猜目标', () => {
    const resolution = resolveProposalDisposition({ utterance: '用这个', candidates });
    expect(resolution.disposition).toBe('ADOPT');
    expect(resolution.requiresDisambiguation).toBe(true);
    expect(resolution.targetProposalId).toBeNull();
    expect(resolution.candidateIds).toEqual(['prop_1', 'prop_2']);
    expect(resolution.reason).toBe(PROPOSAL_DISPOSITION_REASONS.MULTIPLE_CANDIDATES);
  });

  it('唯一候选 → 直接解析到该候选', () => {
    const resolution = resolveProposalDisposition({ utterance: '就这样', candidates: single });
    expect(resolution.disposition).toBe('ADOPT');
    expect(resolution.targetProposalId).toBe('prop_1');
    expect(resolution.requiresDisambiguation).toBe(false);
  });

  it('显式 UI 动作优先于文本（文本可能来自识别错误）', () => {
    const resolution = resolveProposalDisposition({ utterance: '再慢一点', uiAction: 'ADOPT', candidates: single });
    expect(resolution.disposition).toBe('ADOPT');
    expect(resolution.targetProposalId).toBe('prop_1');
    expect(resolution.reason).toBe(PROPOSAL_DISPOSITION_REASONS.UNIQUE_CANDIDATE);
  });

  it('指向不存在的目标 → 要消歧而不是默默选一个', () => {
    const resolution = resolveProposalDisposition({ utterance: '采用', candidates: single, explicitTargetId: 'prop_x' });
    expect(resolution.requiresDisambiguation).toBe(true);
    expect(resolution.targetProposalId).toBeNull();
    expect(resolution.reason).toBe(PROPOSAL_DISPOSITION_REASONS.TARGET_NOT_A_CANDIDATE);
  });

  it('无法识别的表达 → 要确认，不猜', () => {
    const resolution = resolveProposalDisposition({ utterance: '嗯……让我想想', candidates });
    expect(resolution.disposition).toBe('NONE');
    expect(resolution.requiresConfirmation).toBe(true);
    expect(resolution.reason).toBe(PROPOSAL_DISPOSITION_REASONS.UNRECOGNIZED);
  });
});

/**
 * 评审复现用例（外部评审 2026-10 指出子串匹配会把"采纳"误判为"丢弃"）。
 * 这些是**真实口语**，必须作为回归用例常驻。
 */
describe('N06-05 处置解析回归：含"别/再"的常见词不得被误判', () => {
  it('「特别好，就用这个」→ ADOPT（"别"在"特别"里，不是否定）', () => {
    const resolution = resolveProposalDisposition({ utterance: '特别好，就用这个', candidates: single });
    expect(resolution.disposition).toBe('ADOPT');
  });

  it('「区别不大，用这个」→ ADOPT（"别"在"区别"里）', () => {
    const resolution = resolveProposalDisposition({ utterance: '区别不大，用这个', candidates: single });
    expect(resolution.disposition).toBe('ADOPT');
  });

  it('「就这样吧，再好不过了」→ ADOPT（"再"不是微调指令）', () => {
    const resolution = resolveProposalDisposition({ utterance: '就这样吧，再好不过了', candidates: single });
    expect(resolution.disposition).toBe('ADOPT');
  });

  it('「不可以，别这样」→ DISCARD（否定 + 明确否定短语）', () => {
    const resolution = resolveProposalDisposition({ utterance: '不可以，别这样', candidates: single });
    expect(resolution.disposition).toBe('DISCARD');
  });

  it('「别这样」→ DISCARD；「别人用的方案」不误判为丢弃', () => {
    expect(resolveProposalDisposition({ utterance: '别这样', candidates: single }).disposition).toBe('DISCARD');
    expect(resolveProposalDisposition({ utterance: '这跟别人用的方案不一样，就这样', candidates: single }).disposition).toBe('ADOPT');
  });

  it('「就这样，再快一点」是复合意图 → 必须确认，不静默采纳', () => {
    const resolution = resolveProposalDisposition({ utterance: '就这样，再快一点', candidates: single });
    expect(resolution.dispositions).toContain('ADOPT');
    expect(resolution.dispositions).toContain('REFINE');
    expect(resolution.isCompound).toBe(true);
    expect(resolution.requiresConfirmation).toBe(true);
    expect(resolution.targetProposalId).toBe('prop_1');
  });

  it('否定式微调不被当成采纳：「不要再用这个了」→ DISCARD', () => {
    expect(resolveProposalDisposition({ utterance: '不要再用这个了', candidates: single }).disposition).toBe('DISCARD');
  });

  it('ASR 口语与错字仍能识别关键短语（「就用这个吧」/「采纳吧」）', () => {
    expect(resolveProposalDisposition({ utterance: '就用这个吧', candidates: single }).disposition).toBe('ADOPT');
    expect(resolveProposalDisposition({ utterance: '采纳吧', candidates: single }).disposition).toBe('ADOPT');
  });
});
