import { describe, expect, it } from 'vitest';
import { auditFixture } from './audit.js';
import { GOLDEN_FRENCH_DEBT_DIR, loadFixtureBundle } from './load.js';
import type { FixtureBundle } from './fixture-schema.js';

/** 规范 §80 要求的样例要素 → 本 fixture 的场景类型映射。 */
const S80_REQUIRED_SCENE_TYPES = [
  'HOST_FULL', // Host Hook
  'BIG_NUMBER', // Big Number
  'DUAL_LINE_CHART', // 法国/德国收益率对比图
  'SPREAD_AREA_CHART', // Spread chart
  'TIMELINE',
  'CAUSAL_LOOP',
  'MAP_STATIC', // Map
  'NEWS_HEADLINE',
  'SOURCE_CARD',
  'QUOTE_CARD', // Quote
  'CUSTOM_MOTION',
  'AI_VIDEO', // 少量 AI Video
  'SUMMARY',
];

describe('Golden Fixture：french-debt 完整性', () => {
  it('四个文件均通过结构校验（loader 内已 Zod 校验）且规模合理', async () => {
    const bundle = await loadFixtureBundle(GOLDEN_FRENCH_DEBT_DIR);
    expect(bundle.content.blocks.length).toBeGreaterThanOrEqual(20);
    expect(bundle.content.claims.length).toBeGreaterThanOrEqual(10);
    expect(bundle.sources.length).toBeGreaterThanOrEqual(8);
    expect(bundle.datasets.length).toBeGreaterThanOrEqual(4);
    expect(bundle.expected.chapters.length).toBeGreaterThanOrEqual(4);
  });

  it('审计零问题：来源哈希 / 引用可解析 / 事实有来源 / 无合成数据冒充 / 无溢出警告', async () => {
    const bundle = await loadFixtureBundle(GOLDEN_FRENCH_DEBT_DIR);
    expect(auditFixture(bundle)).toEqual([]);
  });

  it('§80 必备场景类型齐备', async () => {
    const bundle = await loadFixtureBundle(GOLDEN_FRENCH_DEBT_DIR);
    const present = new Set(bundle.expected.requiredScenes.map((s) => s.sceneType));
    const missing = S80_REQUIRED_SCENE_TYPES.filter((t) => !present.has(t));
    expect(missing).toEqual([]);
  });

  it('预期时长与格式符合 V1 默认（8—10 分钟 / 16:9 / 1920×1080 / 30fps）', async () => {
    const bundle = await loadFixtureBundle(GOLDEN_FRENCH_DEBT_DIR);
    expect(bundle.expected.targetDurationSeconds).toEqual({ min: 480, max: 600 });
    expect(bundle.expected.format).toEqual({ aspectRatio: '16:9', width: 1920, height: 1080, fps: 30 });
  });

  it('领域不变量：利差序列与两国收益率序列逐点自洽（±1bp）', async () => {
    const bundle: FixtureBundle = await loadFixtureBundle(GOLDEN_FRENCH_DEBT_DIR);
    const spread = bundle.datasets.find((d) => d.id === 'ds_spread_2024')?.series.find((s) => s.id === 'fr_de_10y_spread');
    const yields = bundle.datasets.find((d) => d.id === 'ds_yields_2024');
    const oat = yields?.series.find((s) => s.id === 'oat_10y');
    const bund = yields?.series.find((s) => s.id === 'bund_10y');
    expect(spread).toBeDefined();
    expect(oat).toBeDefined();
    expect(bund).toBeDefined();

    for (const point of spread?.points ?? []) {
      const oatPoint = oat?.points.find((p) => p.t === point.t);
      const bundPoint = bund?.points.find((p) => p.t === point.t);
      expect(oatPoint, `OAT 缺少时间点 ${point.t}`).toBeDefined();
      expect(bundPoint, `Bund 缺少时间点 ${point.t}`).toBeDefined();
      const impliedSpread = ((oatPoint?.v ?? 0) - (bundPoint?.v ?? 0)) * 100;
      expect(Math.abs(impliedSpread - point.v), `${point.t} 利差自洽性`).toBeLessThanOrEqual(1);
    }
  });

  it('AI Video 约束符合 §9.4（占比 ≤ 20%，数量 ≤ 1）', async () => {
    const bundle = await loadFixtureBundle(GOLDEN_FRENCH_DEBT_DIR);
    const aiVideo = bundle.expected.requiredScenes.find((s) => s.sceneType === 'AI_VIDEO');
    const maxRatio = aiVideo?.constraints?.['maxRatioOfDuration'];
    const maxCount = aiVideo?.constraints?.['maxCount'];
    expect(typeof maxRatio).toBe('number');
    expect(maxRatio as number).toBeLessThanOrEqual(0.2);
    expect(maxCount as number).toBeLessThanOrEqual(1);
  });

  it('事实可追溯：每条 fact Claim 有来源，且含数据的 Claim 绑定到真实数据集', async () => {
    const bundle = await loadFixtureBundle(GOLDEN_FRENCH_DEBT_DIR);
    const facts = bundle.content.claims.filter((c) => c.factuality === 'fact');
    expect(facts.length).toBeGreaterThanOrEqual(8);
    for (const claim of facts) {
      expect(claim.sourceIds.length, `${claim.id} 必须有来源`).toBeGreaterThanOrEqual(1);
    }
    const withData = bundle.content.claims.filter((c) => (c.structuredData ?? []).length > 0);
    expect(withData.length).toBeGreaterThanOrEqual(4);
  });
});
