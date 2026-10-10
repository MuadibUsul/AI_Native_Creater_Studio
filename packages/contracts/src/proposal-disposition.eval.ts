import { describe, expect, it } from 'vitest';
import { resolveProposalDisposition, type ProposalDisposition, type ProposalDispositionCandidate } from './proposal-disposition.js';

/**
 * N06-05 **意图识别评测集**（与单测分开跑：`pnpm test:eval`）。
 *
 * 为什么单列一类：单测断言"某个实现细节对不对"，评测度量"**质量**在回归中是否退化"。
 * 关键指标是 **误采纳率（false-adopt rate）**——把"继续微调/拒绝/沉默"误判成"采纳"会改动用户作品，
 * 代价远高于误丢弃（用户还能再说一次）。因此阈值对误采纳更严。
 *
 * 覆盖：采纳 / 继续微调 / 后面也这样 / 拒绝 / 沉默与犹豫 / 否定 / 惯用语 / 复合意图 /
 * ASR 同音错字与口语省略 / 多候选消歧 / 显式 UI 动作。
 *
 * 说明：当前实现是**确定性兜底**（正式的 LLM 结构化分类见 verification 文档的回放路径）。
 * 本评测集的冻结版本会随后续真实用户日志扩充；新增用例必须来自真实口语或真实失败样本。
 */

interface EvalCase {
  id: string;
  utterance: string;
  expect: ProposalDisposition;
  /** 期望必须显式确认（沉默/犹豫/复合/低置信） */
  expectConfirmation?: boolean;
  expectCompound?: boolean;
  candidates?: string[];
  explicitTargetId?: string;
  uiAction?: Exclude<ProposalDisposition, 'NONE'>;
}

const single: ProposalDispositionCandidate[] = [{ proposalId: 'prop_1', generation: 1 }];
const two: ProposalDispositionCandidate[] = [
  { proposalId: 'prop_1', generation: 1 },
  { proposalId: 'prop_2', generation: 2 },
];

const CASES: EvalCase[] = [
  // ── 采纳（ADOPT）────────────────────────────────────────────
  { id: 'adopt-01', utterance: '就用这个', expect: 'ADOPT' },
  { id: 'adopt-02', utterance: '用这个', expect: 'ADOPT' },
  { id: 'adopt-03', utterance: '就用这个吧', expect: 'ADOPT' },
  { id: 'adopt-04', utterance: '采用', expect: 'ADOPT' },
  { id: 'adopt-05', utterance: '采纳吧', expect: 'ADOPT' },
  { id: 'adopt-06', utterance: '就这样', expect: 'ADOPT' },
  { id: 'adopt-07', utterance: '就这样吧', expect: 'ADOPT' },
  { id: 'adopt-08', utterance: '可以了', expect: 'ADOPT' },
  { id: 'adopt-09', utterance: '确认', expect: 'ADOPT' },
  { id: 'adopt-10', utterance: '定稿', expect: 'ADOPT' },
  { id: 'adopt-11', utterance: '好的就这样', expect: 'ADOPT' },
  { id: 'adopt-12', utterance: '特别不错，就用这个吧', expect: 'ADOPT' },
  { id: 'adopt-13', utterance: '特别好，就用这个', expect: 'ADOPT' },
  { id: 'adopt-14', utterance: '区别不大，用这个', expect: 'ADOPT' },
  { id: 'adopt-15', utterance: '和别人的方案比，就用这个', expect: 'ADOPT' },
  { id: 'adopt-16', utterance: '就这样吧，再好不过了', expect: 'ADOPT' },
  { id: 'adopt-17', utterance: '嗯，看起来不错，用这个', expect: 'ADOPT' },
  { id: 'adopt-18', utterance: '这个版本可以了', expect: 'ADOPT' },
  { id: 'adopt-19', utterance: '就用这个，别再改了', expect: 'DISCARD', expectCompound: true, expectConfirmation: true },
  { id: 'adopt-20', utterance: 'OK 用这个', expect: 'ADOPT' },
  { id: 'adopt-21', utterance: 'use this', expect: 'ADOPT' },
  { id: 'adopt-22', utterance: 'looks good, keep it', expect: 'ADOPT' },
  { id: 'adopt-23', utterance: '采纳这个方案', expect: 'ADOPT' },
  { id: 'adopt-24', utterance: '要这个', expect: 'ADOPT' },
  { id: 'adopt-25', utterance: '选这个吧', expect: 'ADOPT' },

  // ── 继续微调（REFINE）——不得被当成采纳 ─────────────────────
  { id: 'refine-01', utterance: '再慢一点', expect: 'REFINE' },
  { id: 'refine-02', utterance: '再快一点', expect: 'REFINE' },
  { id: 'refine-03', utterance: '稍微亮一点', expect: 'REFINE' },
  { id: 'refine-04', utterance: '再柔和一些', expect: 'REFINE' },
  { id: 'refine-05', utterance: '换个角度试试', expect: 'REFINE' },
  { id: 'refine-06', utterance: '改一下开头', expect: 'REFINE' },
  { id: 'refine-07', utterance: '调整一下顺序', expect: 'REFINE' },
  { id: 'refine-08', utterance: '再改改', expect: 'REFINE' },
  { id: 'refine-09', utterance: '再调一下', expect: 'REFINE' },
  { id: 'refine-10', utterance: '重一点', expect: 'REFINE' },
  { id: 'refine-11', utterance: '轻一点', expect: 'REFINE' },
  { id: 'refine-12', utterance: 'not quite, tweak it', expect: 'REFINE' },
  { id: 'refine-13', utterance: '可以，但再快一点', expect: 'REFINE' },
  { id: 'refine-14', utterance: '方向对，再慢一点', expect: 'REFINE' },

  // ── 后面也这样（APPLY_MORE）───────────────────────────────
  { id: 'more-01', utterance: '后面也这样', expect: 'APPLY_MORE' },
  { id: 'more-02', utterance: '后面都这样处理', expect: 'APPLY_MORE' },
  { id: 'more-03', utterance: '其余照此', expect: 'APPLY_MORE' },
  { id: 'more-04', utterance: '都这样', expect: 'APPLY_MORE' },
  { id: 'more-05', utterance: '同样处理剩下的', expect: 'APPLY_MORE' },
  { id: 'more-06', utterance: 'apply to all', expect: 'APPLY_MORE' },

  // ── 拒绝（DISCARD）────────────────────────────────────────
  { id: 'discard-01', utterance: '不要这个', expect: 'DISCARD' },
  { id: 'discard-02', utterance: '不要了', expect: 'DISCARD' },
  { id: 'discard-03', utterance: '不要再用这个了', expect: 'DISCARD' },
  { id: 'discard-04', utterance: '不用了', expect: 'DISCARD' },
  { id: 'discard-05', utterance: '不采用', expect: 'DISCARD' },
  { id: 'discard-06', utterance: '算了', expect: 'DISCARD' },
  { id: 'discard-07', utterance: '别这样', expect: 'DISCARD' },
  { id: 'discard-08', utterance: '别再用这个', expect: 'DISCARD' },
  { id: 'discard-09', utterance: '别改了', expect: 'DISCARD' },
  { id: 'discard-10', utterance: '取消这个', expect: 'DISCARD' },
  { id: 'discard-11', utterance: '丢掉吧', expect: 'DISCARD' },
  { id: 'discard-12', utterance: '放弃这个方案', expect: 'DISCARD' },
  { id: 'discard-13', utterance: '不想要', expect: 'DISCARD' },
  { id: 'discard-14', utterance: '重新来', expect: 'DISCARD' },
  { id: 'discard-15', utterance: '不可以，别这样', expect: 'DISCARD' },
  { id: 'discard-16', utterance: '这个不行，不要', expect: 'DISCARD' },
  { id: 'discard-17', utterance: 'discard this', expect: 'DISCARD' },
  { id: 'discard-18', utterance: 'never mind', expect: 'DISCARD' },

  // ── 惯用语：不能被"不要/别"误伤 ────────────────────────────
  { id: 'idiom-01', utterance: '不要紧，就这样', expect: 'ADOPT' },
  { id: 'idiom-02', utterance: '不要紧，用这个', expect: 'ADOPT' },
  { id: 'idiom-03', utterance: '别客气，就用这个', expect: 'ADOPT' },
  { id: 'idiom-04', utterance: '不赖，可以了', expect: 'ADOPT' },
  { id: 'idiom-05', utterance: '特别顺利，就这样', expect: 'ADOPT' },
  { id: 'idiom-06', utterance: '这是别人给的素材，用这个', expect: 'ADOPT' },
  { id: 'idiom-07', utterance: '区别不大，就这样吧', expect: 'ADOPT' },
  { id: 'idiom-08', utterance: '个别地方还行，可以了', expect: 'ADOPT' },

  // ── 沉默 / 犹豫 / 噪声 → 必须确认，绝不采纳 ─────────────────
  { id: 'silence-01', utterance: '', expect: 'NONE', expectConfirmation: true },
  { id: 'silence-02', utterance: '   ', expect: 'NONE', expectConfirmation: true },
  { id: 'silence-03', utterance: '嗯……', expect: 'NONE', expectConfirmation: true },
  { id: 'silence-04', utterance: '让我想想', expect: 'NONE', expectConfirmation: true },
  { id: 'silence-05', utterance: '这个嘛', expect: 'NONE', expectConfirmation: true },
  { id: 'silence-06', utterance: '（沉默）', expect: 'NONE', expectConfirmation: true },
  { id: 'silence-07', utterance: '啊？', expect: 'NONE', expectConfirmation: true },
  { id: 'silence-08', utterance: '再说吧', expect: 'NONE', expectConfirmation: true },
  { id: 'silence-09', utterance: '先放着', expect: 'NONE', expectConfirmation: true },
  { id: 'silence-10', utterance: '我看看别的', expect: 'NONE', expectConfirmation: true },

  // ── 复合意图 → 必须确认 ───────────────────────────────────
  { id: 'compound-01', utterance: '就这样，再快一点', expect: 'ADOPT', expectCompound: true, expectConfirmation: true },
  { id: 'compound-02', utterance: '采用吧，然后把后面也这样', expect: 'APPLY_MORE', expectCompound: true, expectConfirmation: true },
  { id: 'compound-03', utterance: '不要这个，换个试试', expect: 'DISCARD', expectCompound: true, expectConfirmation: true },
  { id: 'compound-04', utterance: '用这个，再慢一点', expect: 'ADOPT', expectCompound: true, expectConfirmation: true },

  // ── ASR 同音错字 / 口语省略 ───────────────────────────────
  { id: 'asr-01', utterance: '就用者个吧', expect: 'NONE', expectConfirmation: true },
  { id: 'asr-02', utterance: '救用这个', expect: 'ADOPT' },
  { id: 'asr-03', utterance: '菜纳吧', expect: 'NONE', expectConfirmation: true },
  { id: 'asr-04', utterance: '旧这样', expect: 'NONE', expectConfirmation: true },
  { id: 'asr-05', utterance: '就不要这个了', expect: 'DISCARD' },
  { id: 'asr-06', utterance: '我就用这个', expect: 'ADOPT' },
  { id: 'asr-07', utterance: '那就用这个吧', expect: 'ADOPT' },
  { id: 'asr-08', utterance: '哎呀算了', expect: 'DISCARD' },
  { id: 'asr-09', utterance: '这个这个，可以了', expect: 'ADOPT' },
  { id: 'asr-10', utterance: '嗯嗯就这样', expect: 'ADOPT' },

  // ── 多候选消歧 ────────────────────────────────────────────
  { id: 'disambig-01', utterance: '用这个', expect: 'ADOPT', candidates: two.map((c) => c.proposalId) },
  { id: 'disambig-02', utterance: '用这个', expect: 'ADOPT', candidates: ['prop_1', 'prop_2'], explicitTargetId: 'prop_2' },
  { id: 'disambig-03', utterance: '用这个', expect: 'ADOPT', candidates: ['prop_1'], explicitTargetId: 'prop_missing', expectConfirmation: true },

  // ── 显式 UI 动作永远优先 ──────────────────────────────────
  { id: 'ui-01', utterance: '再慢一点', uiAction: 'ADOPT', expect: 'ADOPT' },
  { id: 'ui-02', utterance: '用这个', uiAction: 'REFINE', expect: 'REFINE' },
  { id: 'ui-03', utterance: '别改了', uiAction: 'DISCARD', expect: 'DISCARD' },
  { id: 'ui-04', utterance: '就用这个', uiAction: 'APPLY_MORE', expect: 'APPLY_MORE' },
];

interface CaseResult { readonly testCase: EvalCase; readonly got: ProposalDisposition; readonly confirmed: boolean; readonly compound: boolean; readonly disambiguated: boolean }

const runCase = (testCase: EvalCase): CaseResult => {
  const candidates = testCase.candidates === undefined
    ? single
    : testCase.candidates.map((proposalId) => ({ proposalId, generation: 1 }));
  const resolution = resolveProposalDisposition({
    utterance: testCase.utterance,
    candidates,
    ...(testCase.explicitTargetId === undefined ? {} : { explicitTargetId: testCase.explicitTargetId }),
    ...(testCase.uiAction === undefined ? {} : { uiAction: testCase.uiAction }),
  });
  const confirmed = resolution.requiresConfirmation
    || resolution.requiresDisambiguation
    || resolution.disposition === 'NONE'
    || resolution.targetProposalId === null;
  return { testCase, got: resolution.disposition, confirmed, compound: resolution.isCompound, disambiguated: resolution.requiresDisambiguation };
};

const results = CASES.map(runCase);
const correct = results.filter((result) => {
  if (result.got !== result.testCase.expect) return false;
  if (result.testCase.expectConfirmation === true && !result.confirmed) return false;
  if (result.testCase.expectCompound === true && !result.compound) return false;
  return true;
});
const accuracy = correct.length / CASES.length;
// 误采纳：期望**不是**采纳，却解析成了采纳（会改动用户作品，代价最高）。
const nonAdoptCases = results.filter((result) => result.testCase.expect !== 'ADOPT');
const falseAdopt = nonAdoptCases.filter((result) => result.got === 'ADOPT');
const falseAdoptRate = nonAdoptCases.length === 0 ? 0 : falseAdopt.length / nonAdoptCases.length;
// 误丢弃：期望采纳，却被判成拒绝（代价较低，但会打断用户）。
const falseDiscard = results.filter((result) => result.testCase.expect === 'ADOPT' && result.got === 'DISCARD');

describe('N06-05 意图识别评测集（质量趋势，不阻塞 CI）', () => {
  it(`用例规模：${String(CASES.length)} 条（目标随真实日志扩充；误采纳优先）`, () => {
    expect(CASES.length).toBeGreaterThanOrEqual(100);
  });

  it(`主处置准确率 ${(accuracy * 100).toFixed(1)}%（阈值 ≥ 95%）`, () => {
    const failures = results.filter((result) => !correct.includes(result));
    expect(failures.map((failure) => `${failure.testCase.id}:「${failure.testCase.utterance}」期望 ${failure.testCase.expect} 实得 ${failure.got}`)).toEqual([]);
    expect(accuracy).toBeGreaterThanOrEqual(0.95);
  });

  it(`误采纳率 ${(falseAdoptRate * 100).toFixed(1)}%（阈值 ≤ 2%）`, () => {
    expect(falseAdopt.map((result) => `${result.testCase.id}:「${result.testCase.utterance}」`)).toEqual([]);
    expect(falseAdoptRate).toBeLessThanOrEqual(0.02);
  });

  it('误丢弃（把"采纳"判成"拒绝"）为 0', () => {
    expect(falseDiscard.map((result) => `${result.testCase.id}:「${result.testCase.utterance}」`)).toEqual([]);
  });

  it('复合意图与沉默一律要求显式确认（不静默采纳、也不静默丢弃）', () => {
    const silentOrCompound = results.filter((result) =>
      result.testCase.expectCompound === true || result.got === 'NONE');
    const unconfirmed = silentOrCompound.filter((result) => !result.confirmed);
    expect(unconfirmed.map((result) => `${result.testCase.id}:「${result.testCase.utterance}」`)).toEqual([]);
  });
});
