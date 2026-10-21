import { describe, expect, it } from 'vitest';
import { AUTONOMY_ERROR_REASONS, DEFAULT_AUTONOMY_POLICY, type AutonomyPolicy } from '@ancs/contracts';
import { autonomyMayAdopt, autonomyRemainingMicros, autonomySpendDecision } from './autonomy.js';

const signed = (patch: Partial<AutonomyPolicy>): AutonomyPolicy => ({
  ...DEFAULT_AUTONOMY_POLICY,
  budgetMicros: 10_000_000,
  signature: { userId: 'usr_1', signedAt: '2026-10-21T00:00:00.000Z', version: 1 },
  ...patch,
});

describe('自主制作花费门禁（裁决 0020）', () => {
  it('没有签署：任何花费都不允许，转请用户', () => {
    expect(autonomySpendDecision(DEFAULT_AUTONOMY_POLICY, { kind: 'MODEL', estimateMicros: 1, spentMicros: 0 }))
      .toEqual({ allowed: false, reason: AUTONOMY_ERROR_REASONS.NOT_SIGNED, askUser: true });
    expect(autonomyMayAdopt(DEFAULT_AUTONOMY_POLICY)).toBe(false);
    expect(autonomyRemainingMicros(DEFAULT_AUTONOMY_POLICY, 0)).toBe(0);
  });

  it('总预算是硬上限：任何档位都不得超过，且不转请示', () => {
    for (const approval of ['ASK_EACH', 'AUTO_SAFE', 'FULL'] as const) {
      const policy = signed({ approval, perGenerationMicros: 10_000_000 });
      expect(autonomySpendDecision(policy, { kind: 'MODEL', estimateMicros: 3_000_000, spentMicros: 7_000_000 })).toEqual({ allowed: true, remainingMicros: 0 });
      expect(autonomySpendDecision(policy, { kind: 'MODEL', estimateMicros: 3_000_001, spentMicros: 7_000_000 }))
        .toEqual({ allowed: false, reason: AUTONOMY_ERROR_REASONS.BUDGET_EXHAUSTED, askUser: false });
    }
    // 小数微美元按上取整（不让舍入把预算"挤"出一点）
    expect(autonomySpendDecision(signed({}), { kind: 'MODEL', estimateMicros: 0.4, spentMicros: 9_999_999.2 }).allowed).toBe(false);
  });

  it('付费生成：逐项与自动审批仍要用户逐次确认；完全授权受单项上限、形象授权与总预算约束', () => {
    const generation = { kind: 'GENERATION' as const, estimateMicros: 800_000, spentMicros: 0 };
    expect(autonomySpendDecision(signed({ approval: 'ASK_EACH' }), generation)).toMatchObject({ allowed: false, reason: AUTONOMY_ERROR_REASONS.GENERATION_NEEDS_CONFIRMATION, askUser: true });
    expect(autonomySpendDecision(signed({ approval: 'AUTO_SAFE', perGenerationMicros: 5_000_000 }), generation)).toMatchObject({ allowed: false, reason: AUTONOMY_ERROR_REASONS.GENERATION_NEEDS_CONFIRMATION });
    // 完全授权但没有授权单项上限：不代为确认
    expect(autonomySpendDecision(signed({ approval: 'FULL' }), generation)).toMatchObject({ allowed: false, reason: AUTONOMY_ERROR_REASONS.PER_GENERATION_LIMIT, askUser: true });
    expect(autonomySpendDecision(signed({ approval: 'FULL', perGenerationMicros: 500_000 }), generation)).toMatchObject({ allowed: false, reason: AUTONOMY_ERROR_REASONS.PER_GENERATION_LIMIT });
    expect(autonomySpendDecision(signed({ approval: 'FULL', perGenerationMicros: 1_000_000 }), generation)).toEqual({ allowed: true, remainingMicros: 9_200_000 });
    // 本人形象 / 声音：没有授权时不代为确认（身份档案授权另由生成流程校验）
    expect(autonomySpendDecision(signed({ approval: 'FULL', perGenerationMicros: 1_000_000 }), { ...generation, likeness: true }))
      .toMatchObject({ allowed: false, reason: AUTONOMY_ERROR_REASONS.LIKENESS_NOT_AUTHORIZED });
    expect(autonomySpendDecision(signed({ approval: 'FULL', perGenerationMicros: 1_000_000, allowOwnLikeness: true }), { ...generation, likeness: true }).allowed).toBe(true);
    // 单项不超但总预算已满：硬停
    expect(autonomySpendDecision(signed({ approval: 'FULL', perGenerationMicros: 1_000_000 }), { ...generation, spentMicros: 9_500_000 }))
      .toMatchObject({ allowed: false, reason: AUTONOMY_ERROR_REASONS.BUDGET_EXHAUSTED, askUser: false });
  });

  it('自主采用：只有签署且不是逐项审批的档位才由系统采用', () => {
    expect(autonomyMayAdopt(signed({ approval: 'ASK_EACH' }))).toBe(false);
    expect(autonomyMayAdopt(signed({ approval: 'AUTO_SAFE' }))).toBe(true);
    expect(autonomyMayAdopt(signed({ approval: 'FULL' }))).toBe(true);
    expect(autonomyMayAdopt({ ...signed({ approval: 'FULL' }), budgetMicros: null })).toBe(false);
    expect(autonomyRemainingMicros(signed({}), 2_500_000)).toBe(7_500_000);
    expect(autonomyRemainingMicros(signed({}), 12_000_000)).toBe(0);
  });
});
