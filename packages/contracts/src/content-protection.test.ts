import { describe, expect, it } from 'vitest';
import { resolveScopeGuard } from './content-protection.js';

/**
 * N06-07：“其他别动”约束下的总时长守卫 —— 等长放行，变长必须先解释或改等长方案。
 */
describe('N06-07 resolveScopeGuard', () => {
  it('未声明“其他别动”→ 不受约束，直接放行', () => {
    const result = resolveScopeGuard({ preservesEverythingElse: false, durationDeltaMs: 5_000, equalLengthAlternativeAvailable: false });
    expect(result.verdict).toBe('SAFE');
    expect(result.requiresExplanation).toBe(false);
  });

  it('声明“其他别动”且等长（delta=0）→ 放行', () => {
    const result = resolveScopeGuard({ preservesEverythingElse: true, durationDeltaMs: 0, equalLengthAlternativeAvailable: false });
    expect(result.verdict).toBe('SAFE');
    expect(result.requiresExplanation).toBe(false);
  });

  it('声明“其他别动”但总时长改变 → 必须解释，不得直接执行', () => {
    const result = resolveScopeGuard({ preservesEverythingElse: true, durationDeltaMs: -1_200, equalLengthAlternativeAvailable: false });
    expect(result.verdict).toBe('EXPLAIN_DURATION_CHANGE');
    expect(result.requiresExplanation).toBe(true);
    expect(result.recommendEqualLength).toBe(false);
  });

  it('声明“其他别动”且存在等长替代 → 建议改等长方案（同样必须先解释）', () => {
    const result = resolveScopeGuard({ preservesEverythingElse: true, durationDeltaMs: 2_000, equalLengthAlternativeAvailable: true });
    expect(result.verdict).toBe('EQUAL_LENGTH_PLAN_RECOMMENDED');
    expect(result.recommendEqualLength).toBe(true);
    expect(result.requiresExplanation).toBe(true);
  });

  it('变化方向不影响判定（提前/延后都受同一约束）', () => {
    const earlier = resolveScopeGuard({ preservesEverythingElse: true, durationDeltaMs: -800, equalLengthAlternativeAvailable: true });
    const later = resolveScopeGuard({ preservesEverythingElse: true, durationDeltaMs: 800, equalLengthAlternativeAvailable: true });
    expect(earlier.verdict).toBe(later.verdict);
  });
});
