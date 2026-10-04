import { describe, expect, it } from 'vitest';
import { auditFixture } from './audit.js';
import { loadNegativeCases } from './load.js';

const cases = await loadNegativeCases();

describe('合成负面测试数据（文件内均带 SYNTHETIC 标注）', () => {
  it('用例数量与标注检查', () => {
    expect(cases.length).toBeGreaterThanOrEqual(6);
    for (const testCase of cases) {
      expect(testCase.label.toUpperCase()).toContain('SYNTHETIC');
      expect(testCase.purpose.length).toBeGreaterThan(0);
    }
  });

  it('用例 ID 唯一', () => {
    const ids = cases.map((c) => c.caseId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const testCase of cases) {
    it(`用例 ${testCase.caseId}：恰好触发预期问题码 [${testCase.expectedIssueCodes.join(', ')}]`, () => {
      const issues = auditFixture(testCase.bundle);
      const actualCodes = [...new Set(issues.map((i) => i.code))].sort();
      const expectedCodes = [...testCase.expectedIssueCodes].sort();
      expect(actualCodes).toEqual(expectedCodes);
    });
  }
});
