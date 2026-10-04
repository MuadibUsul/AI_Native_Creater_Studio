import { describe, expect, it } from 'vitest';
import type { NarrativeGenerationRequest } from '@ancs/contracts';
import { VERBATIM_OVERLAP_THRESHOLD } from '@ancs/contracts';
import { estimateDurationMs, extractJsonPayload, maxNgramOverlap, repairNarrativePlan } from './narrative-repair.js';

/**
 * Narrative 的确定性部分（P04-03 单元验收）：
 * 有限修复（有界）、锁定保留、口语化检查（8-gram 重叠）、时长估算。
 */

const request: NarrativeGenerationRequest = {
  documentTitle: '利率周报',
  documentLanguage: 'zh',
  contentDigest: [
    { blockId: 'blk_a', kind: 'paragraph', text: '联邦基金利率维持在 5.25% 不变，为 2024 年以来的最高水平。' },
    { blockId: 'blk_b', kind: 'paragraph', text: '分析师预计 2025 年可能降息 2 个百分点。' },
  ],
  claims: [
    { claimId: 'clm_1', text: '联邦基金利率维持在 5.25% 不变。', factuality: 'fact', locked: false },
    { claimId: 'clm_2', text: '分析师预计 2025 年可能降息。', factuality: 'uncertain', locked: false },
  ],
  lockedNarrationBlocks: [{ id: 'nrb_9', text: '这是我们固定保留的开场白。' }],
  targetDurationMs: 120_000,
  tone: null,
  audience: null,
  platform: null,
};

const baseInput = { request, planId: 'npl_test', revision: 1, providerId: 'mock.llm', modelVersion: 'mock-1', promptVersion: 'narrative-v1' };

describe('有限修复（bounded repair，§52）', () => {
  it('合法 JSON：直接通过；锁定旁白逐字保留且标记 locked', () => {
    const content = JSON.stringify({
      title: 'T',
      thesis: 'Th',
      hook: 'H',
      chapters: [{ title: '开场', intent: '建立问题', narrationBlockIds: ['nrb_1'] }],
      narrationBlocks: [
        { id: 'nrb_1', text: '我们来看：利率维持在 5.25%。', chapterTitle: '开场', claimIds: ['clm_1'] },
        { id: 'nrb_9', text: '这是我们固定保留的开场白。', chapterTitle: '开场', claimIds: [] },
      ],
      ending: 'E',
      keyClaims: ['clm_1'],
      estimatedDuration: 60,
    });
    const outcome = repairNarrativePlan(content, baseInput);
    expect(outcome.plan.narrationBlocks).toHaveLength(2);
    expect(outcome.plan.narrationBlocks[0]?.claimIds).toEqual(['clm_1']);
    expect(outcome.plan.narrationBlocks[1]?.locked).toBe(true);
    expect(outcome.plan.estimatedDurationMs).toBe(60_000); // 秒 → 毫秒（记录修复）
    expect(outcome.repairs.some((repair) => repair.includes('折算'))).toBe(true);
    expect(outcome.plan.generation.promptVersion).toBe('narrative-v1');
  });

  it('代码围栏包裹的 JSON 可解析（extractJsonPayload 容忍前后噪声）', () => {
    const payload = extractJsonPayload('说明文字\n```json\n{"a":1}\n```\n结尾');
    expect(payload).toBe('{"a":1}');
    expect(extractJsonPayload('没有 JSON')).toBeNull();
    expect(extractJsonPayload('前缀 {"nested":{"x":1}} 后缀')).toBe('{"nested":{"x":1}}');
  });

  it('可有限修复：剔除未知字段、字符串数字折算、缺省字段派生（并逐条记录）', () => {
    const content = JSON.stringify({
      extraField: 'drop-me',
      narrationBlocks: [{ id: 'nrb_1', text: '我们来看：利率维持在 5.25%。', claimIds: ['clm_1', 'clm_not_exist'] }],
    });
    const outcome = repairNarrativePlan(content, baseInput);
    expect(outcome.repairs.some((repair) => repair.includes('extraField'))).toBe(true); // 未知字段
    expect(outcome.repairs.some((repair) => repair.includes('clm_not_exist'))).toBe(true); // 不存在的事实（不得引用）
    expect(outcome.repairs.some((repair) => repair.includes('thesis'))).toBe(true); // 缺省派生
    expect(outcome.repairs.some((repair) => repair.includes('chapters'))).toBe(true); // 兜底单章
    expect(outcome.plan.narrationBlocks[0]?.claimIds).toEqual(['clm_1']);
    expect(outcome.plan.title).toContain('利率周报');
  });

  it('锁定旁白被模型改写 → 回滚为锁定原文并记录；模型丢失锁定旁白 → 补回', () => {
    const rewritten = JSON.stringify({
      title: 'T',
      narrationBlocks: [{ id: 'nrb_9', text: '模型擅自改写的开场白。', claimIds: [] }],
    });
    const outcome = repairNarrativePlan(rewritten, baseInput);
    const lockedBlock = outcome.plan.narrationBlocks.find((block) => block.id === 'nrb_9');
    expect(lockedBlock?.text).toBe('这是我们固定保留的开场白。');
    expect(outcome.repairs.some((repair) => repair.includes('回滚'))).toBe(true);

    const missing = JSON.stringify({ title: 'T', narrationBlocks: [{ id: 'nrb_1', text: '我们来看事实。', claimIds: [] }] });
    const outcome2 = repairNarrativePlan(missing, baseInput);
    expect(outcome2.plan.narrationBlocks.some((block) => block.id === 'nrb_9' && block.locked)).toBe(true);
    expect(outcome2.repairs.some((repair) => repair.includes('补回'))).toBe(true);
  });

  it('结构性缺失 → 明确失败（不瞎猜）：无 narrationBlocks / 非 JSON', () => {
    expect(() => repairNarrativePlan('不是 JSON', baseInput)).toThrow(/JSON/);
    let code: string | undefined;
    try {
      repairNarrativePlan(JSON.stringify({ title: 'T' }), baseInput);
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe('REPAIR_LIMIT_EXCEEDED');
  });

  it('全部旁白逐字抄袭原文 → VERBATIM_NARRATION_REJECTED（§8.2）', () => {
    const verbatimText = request.contentDigest[0]?.text ?? '';
    const content = JSON.stringify({
      title: 'T',
      narrationBlocks: [
        { id: 'nrb_1', text: verbatimText, claimIds: [] },
        { id: 'nrb_2', text: request.contentDigest[1]?.text ?? '', claimIds: [] },
      ],
    });
    let code: string | undefined;
    try {
      repairNarrativePlan(content, baseInput);
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe('VERBATIM_NARRATION_REJECTED');
  });
});

describe('口语化检查与时长估算', () => {
  it('maxNgramOverlap：改写文本重叠低；复制文本重叠高（阈值 0.6）', () => {
    const source = '联邦基金利率维持在 5.25% 不变，为 2024 年以来的最高水平。';
    const rewritten = '我们来看一个重要事实：利率停在 5.25%，这是近年的高点。';
    const copied = '联邦基金利率维持在 5.25% 不变，为 2024 年以来的最高水平。';
    expect(maxNgramOverlap(rewritten, [source])).toBeLessThan(VERBATIM_OVERLAP_THRESHOLD);
    expect(maxNgramOverlap(copied, [source])).toBeGreaterThanOrEqual(VERBATIM_OVERLAP_THRESHOLD);
  });

  it('estimateDurationMs：220 字/分钟基准；空文本有下限', () => {
    expect(estimateDurationMs('字'.repeat(220))).toBe(60_000);
    expect(estimateDurationMs('字'.repeat(110))).toBe(30_000);
    expect(estimateDurationMs('短')).toBe(1000);
  });
});
