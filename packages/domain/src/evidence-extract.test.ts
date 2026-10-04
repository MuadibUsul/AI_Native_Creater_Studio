import { describe, expect, it } from 'vitest';
import {
  checkChartBinding,
  classifyFactuality,
  extractClaimCandidates,
  extractNumericMentions,
  extractTimelineMentions,
  extractionFingerprint,
  normalizeUnit,
  planFactVisual,
  splitSentences,
} from './evidence-extract.js';

/**
 * 证据抽取的确定性部分（P04-02 单元验收）：
 * 单位归一、数值/时间线抽取、Claim 候选与事实性判定、**缺数据降级阶梯**、数据集绑定门控。
 */

describe('单位归一与数值抽取（保留原始文本）', () => {
  it('normalizeUnit：百分比/货币量级/倍数/绝对值 + 原始单位保留', () => {
    expect(normalizeUnit('5.25', '%')).toMatchObject({ value: 5.25, canonical: 'PERCENT', unit: '%', rawUnit: '%' });
    expect(normalizeUnit('2', '个百分点')).toMatchObject({ value: 2, canonical: 'PERCENT', unit: '个百分点' });
    expect(normalizeUnit('50', 'bp')).toMatchObject({ value: 0.5, canonical: 'PERCENT', unit: 'bp' }); // 1bp = 0.01%
    expect(normalizeUnit('1.2', '亿美元')).toMatchObject({ value: 120_000_000, canonical: 'CURRENCY', unit: 'USD' });
    expect(normalizeUnit('3', '万亿')).toMatchObject({ value: 3_000_000_000_000, canonical: 'ABSOLUTE' });
    expect(normalizeUnit('4', '倍')).toMatchObject({ canonical: 'RATIO' });
    expect(normalizeUnit('12', undefined)).toMatchObject({ value: 12, canonical: 'ABSOLUTE', rawUnit: null });
  });

  it('extractNumericMentions：千分位、负号、偏移；纯年份不计入数值事实', () => {
    const mentions = extractNumericMentions({ id: 'blk_x', type: 'paragraph', text: '营收 1,234.5 亿美元，下降 -2.1%，2024 年数据。' });
    expect(mentions.some((mention) => mention.value === 123_450_000_000)).toBe(true);
    expect(mentions.some((mention) => mention.value === -2.1)).toBe(true);
    expect(mentions.some((mention) => mention.raw.includes('1,234.5'))).toBe(true);
    expect(mentions.every((mention) => mention.offset >= 0)).toBe(true);
    // 纯年份（2024）不出现在数值事实中（属时间线）
    expect(mentions.some((mention) => mention.raw.trim() === '2024')).toBe(false);
  });

  it('extractTimelineMentions：年份/季度/日期归一 + 描述截断', () => {
    const mentions = extractTimelineMentions({ id: 'blk_t', type: 'paragraph', text: '2024年6月美联储会议决定维持利率。2023Q1 经济增速放缓。' });
    expect(mentions.map((mention) => mention.date)).toEqual(['2024-6', '2023-Q1']);
    expect(mentions[0]?.description).toContain('美联储会议');
  });
});

describe('Claim 候选抽取与事实性判定', () => {
  it('splitSentences/classifyFactuality：观点、不确定、分析、事实四类', () => {
    expect(classifyFactuality('我认为这个政策值得肯定。')).toBe('opinion');
    expect(classifyFactuality('明年可能降息两次。')).toBe('uncertain');
    expect(classifyFactuality('通胀下降意味着压力缓解。')).toBe('analysis');
    expect(classifyFactuality('利率维持在 5.25%。')).toBe('fact');
    expect(splitSentences('第一句。第二句！第三句？').map((sentence) => sentence.text)).toEqual(['第一句。', '第二句！', '第三句？']);
  });

  it('extractClaimCandidates：含数值的句子与观点/不确定句成为候选；纯叙述与标题被跳过', () => {
    const candidates = extractClaimCandidates([
      { id: 'blk_h', type: 'heading', text: '市场周报' },
      { id: 'blk_p', type: 'paragraph', text: '利率维持在 5.25%。市场情绪保持平稳。分析师预计明年可能降息。' },
    ]);
    const texts = candidates.map((candidate) => candidate.text);
    expect(texts.some((text) => text.includes('5.25%'))).toBe(true); // 有数值证据
    expect(texts.some((text) => text.includes('可能降息'))).toBe(true); // 不确定句
    expect(texts.some((text) => text.includes('市场情绪保持平稳'))).toBe(false); // 纯叙述交给 Narrative
    expect(candidates.every((candidate) => candidate.confidence === 1)).toBe(true);
  });
});

describe('数据集绑定门控与降级阶梯（§10.3：缺数据不得编造）', () => {
  it('checkChartBinding：synthetic / 无来源 / 空数据一律不可绑定并给出原因', () => {
    const real = { synthetic: false, sourceIds: ['src_1'], series: [{ id: 's1', name: 'x', points: [{ t: '2024', v: 1 }] }] };
    expect(checkChartBinding(real)).toMatchObject({ bindable: true, pointCount: 1, dataSourceIds: ['src_1'] });

    expect(checkChartBinding({ ...real, synthetic: true }).reasons).toContain('SYNTHETIC_DATASET_NOT_BINDABLE');
    expect(checkChartBinding({ ...real, sourceIds: [] }).reasons).toContain('DATASET_REQUIRES_SOURCE');
    expect(checkChartBinding({ ...real, series: [{ id: 's1', name: 'x', points: [] }] }).reasons).toContain('DATASET_EMPTY');
  });

  it('planFactVisual 降级阶梯：CHART → QUOTE → SOURCE_CARD → TEXTUAL_EXPLANATION → REQUEST_DATA', () => {
    const chart = planFactVisual({ hasTraceableSource: true, claimText: '利率 5.25%', bindableDataset: { id: 'ds_1', sourceIds: ['src_1'] }, quotedText: '原文', quoteSourceId: 'src_1' });
    expect(chart).toMatchObject({ strategy: 'CHART', datasetId: 'ds_1', dataSourceIds: ['src_1'] });

    const quote = planFactVisual({ hasTraceableSource: true, claimText: '利率 5.25%', bindableDataset: null, quotedText: '原文', quoteSourceId: 'src_1' });
    expect(quote).toMatchObject({ strategy: 'QUOTE', quoteSourceId: 'src_1' });

    const sourceCard = planFactVisual({ hasTraceableSource: true, claimText: '利率 5.25%', bindableDataset: null, quotedText: null, quoteSourceId: 'src_1' });
    expect(sourceCard.strategy).toBe('SOURCE_CARD');

    const textual = planFactVisual({ hasTraceableSource: false, claimText: '利率 5.25%', bindableDataset: null, quotedText: null, quoteSourceId: null });
    expect(textual.strategy).toBe('TEXTUAL_EXPLANATION');

    const requestData = planFactVisual({ hasTraceableSource: false, claimText: '   ', bindableDataset: null, quotedText: null, quoteSourceId: null });
    expect(requestData).toMatchObject({ strategy: 'REQUEST_DATA' });
    expect(requestData.requestHint).toContain('补充');
  });

  it('extractionFingerprint：内容不变 → 指纹不变（抽取幂等的依据）', () => {
    const blocks = [
      { id: 'blk_a', type: 'paragraph' as const, text: '利率 5.25%' },
      { id: 'blk_b', type: 'list' as const, items: ['甲', '乙'], text: '甲乙' },
    ];
    expect(extractionFingerprint(blocks)).toBe(extractionFingerprint([...blocks]));
    expect(extractionFingerprint(blocks)).not.toBe(extractionFingerprint([{ id: 'blk_a', type: 'paragraph' as const, text: '利率 5.5%' }]));
  });
});
