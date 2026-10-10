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
