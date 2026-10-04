import { describe, expect, it } from 'vitest';
import { SEMANTIC_TYPES, STANDARD_SCENE_TYPES } from '@ancs/contracts';
import { datasetShape, missingSemanticTypes, recognizeSemanticType, ruleForSemanticType, VISUAL_GRAMMAR_RULES, type RecognitionInput } from './visual-grammar.js';

/**
 * P04-04 单元验收（规范 §10.1、§10.2）：
 * - 映射表覆盖全部语义类型（基础 23 + 财经 12 = 35），允许集合非空且落在 V1 标准 20 类内；
 * - 语义 → 允许类型固定（"对固定语义输入得到允许类型" = 识别结果必有允许集合，且默认建议在集合内）；
 * - 确定性识别优先级：数据形状 > 结构/财经关键词 > 引文/来源/实体 > 数值 > 时间线 > 安全兜底 HOST_STATEMENT。
 */

const empty: RecognitionInput = {
  claimText: '',
  numericMentions: [],
  datasets: [],
  timelineMentions: 0,
  hasQuote: false,
  hasSource: false,
  entityKinds: [],
};

const number = (canonical: 'PERCENT' | 'CURRENCY' | 'RATIO' | 'ABSOLUTE' | 'YEAR', raw = '1'): RecognitionInput['numericMentions'][number] => ({
  raw,
  canonical,
  unit: canonical === 'PERCENT' ? '%' : canonical,
});

const timeSeries = (points: number, id = 'ds_1', bindable = true): RecognitionInput['datasets'][number] =>
  datasetShape({
    id,
    unit: '%',
    bindable,
    series: [
      {
        points: Array.from({ length: points }, (_, index) => ({ t: String(2020 + index), v: index + 1 })),
      },
    ],
  });

const pairedSeries = (points: number, id = 'ds_pair', bindable = true): RecognitionInput['datasets'][number] =>
  datasetShape({
    id,
    unit: '%',
    bindable,
    series: [
      { points: Array.from({ length: points }, (_, index) => ({ t: String(2020 + index), v: index + 1 })) },
      { points: Array.from({ length: points }, (_, index) => ({ t: String(2020 + index), v: 10 - index })) },
    ],
  });

const categorical = (points: number, id = 'ds_cat', bindable = true): RecognitionInput['datasets'][number] =>
  datasetShape({
    id,
    unit: 'USD',
    bindable,
    series: [
      {
        points: Array.from({ length: points }, (_, index) => ({ t: `项目${String.fromCharCode(65 + index)}`, v: index + 1 })),
      },
    ],
  });

describe('VISUAL_GRAMMAR_RULES 映射表', () => {
  it('覆盖全部语义类型（基础 + 财经扩展）', () => {
    expect(SEMANTIC_TYPES.length).toBe(34);
    expect(missingSemanticTypes()).toEqual([]);
    expect(VISUAL_GRAMMAR_RULES.length).toBe(SEMANTIC_TYPES.length);
  });

  it('每个语义都有非空允许集合，且全部落在 V1 标准场景类型内', () => {
    const standard = new Set<string>(STANDARD_SCENE_TYPES);
    for (const rule of VISUAL_GRAMMAR_RULES) {
      expect(rule.allowedSceneTypes.length, rule.semanticType).toBeGreaterThan(0);
      for (const sceneType of rule.allowedSceneTypes) {
        expect(standard.has(sceneType), `${rule.semanticType} → ${sceneType}`).toBe(true);
      }
      for (const preferred of rule.preferredSceneTypes) {
        expect(rule.allowedSceneTypes, `${rule.semanticType} preferred`).toContain(preferred);
      }
    }
  });

  it('事实图表类语义要求数据集/来源门控，数值类要求可追溯来源', () => {
    const requiresData = VISUAL_GRAMMAR_RULES.filter((rule) => rule.requiresData).map((rule) => rule.semanticType);
    expect(requiresData).toContain('TREND');
    expect(requiresData).toContain('YIELD_SPREAD');
    expect(requiresData).toContain('YIELD_CURVE');
    const numberRule = ruleForSemanticType('NUMBER');
    expect(numberRule.requiresSource).toBe(true);
    expect(numberRule.requiresData).toBe(false);
    expect(ruleForSemanticType('QUOTE').requiresSource).toBe(true);
  });
});

describe('recognizeSemanticType 确定性识别', () => {
  it('时间序数据集（≥3 点）→ TREND / 财经变体', () => {
    expect(recognizeSemanticType({ ...empty, claimText: '经济持续增长', datasets: [timeSeries(5)] }).semanticType).toBe('TREND');
    expect(
      recognizeSemanticType({ ...empty, claimText: '利率持续下行', datasets: [timeSeries(5)] }).semanticType,
    ).toBe('PRICE_SERIES');
    expect(
      recognizeSemanticType({ ...empty, claimText: '期限利差走阔', datasets: [pairedSeries(4)] }).semanticType,
    ).toBe('YIELD_SPREAD');
    expect(
      recognizeSemanticType({ ...empty, claimText: '供需缺口扩大', datasets: [pairedSeries(4)] }).semanticType,
    ).toBe('SUPPLY_DEMAND');
    expect(
      recognizeSemanticType({ ...empty, claimText: '收益率曲线倒挂', datasets: [timeSeries(4)] }).semanticType,
    ).toBe('YIELD_CURVE');
    expect(recognizeSemanticType({ ...empty, claimText: 'K线连续放量', datasets: [timeSeries(4)] }).semanticType).toBe('CANDLE_SERIES');
  });

  it('双序列同轴对比 → COMPARISON；小数据集 → RANKING', () => {
    expect(recognizeSemanticType({ ...empty, claimText: '两公司营收走势', datasets: [pairedSeries(3)] }).semanticType).toBe('COMPARISON');
    expect(recognizeSemanticType({ ...empty, claimText: '各机构排名', datasets: [categorical(5)] }).semanticType).toBe('RANKING');
  });

  it('数据集 + 多指标 → KPI_SET（非时间序也可）', () => {
    const input: RecognitionInput = {
      ...empty,
      claimText: '三项指标',
      datasets: [categorical(8)],
      numericMentions: [number('PERCENT'), number('CURRENCY'), number('ABSOLUTE')],
    };
    expect(recognizeSemanticType(input).semanticType).toBe('KPI_SET');
  });

  it('非绑定数据集不参与形状识别（synthetic 等）', () => {
    expect(recognizeSemanticType({ ...empty, claimText: '经济持续增长', datasets: [timeSeries(5, 'ds_x', false)] }).semanticType).toBe('HOST_STATEMENT');
  });

  it('结构/因果/地理/流程关键词', () => {
    expect(recognizeSemanticType({ ...empty, claimText: '因为通胀回落' }).semanticType).toBe('CAUSE_EFFECT');
    expect(recognizeSemanticType({ ...empty, claimText: '形成正反馈循环' }).semanticType).toBe('FEEDBACK_LOOP');
    expect(recognizeSemanticType({ ...empty, claimText: '分三步的流程' }).semanticType).toBe('PROCESS');
    expect(recognizeSemanticType({ ...empty, claimText: '上下游网络' }).semanticType).toBe('NETWORK');
    expect(recognizeSemanticType({ ...empty, claimText: '美国与欧洲' }).semanticType).toBe('GEOGRAPHY');
  });

  it('财经关键词（无数据集时）', () => {
    expect(recognizeSemanticType({ ...empty, claimText: '央行加息路径', numericMentions: [number('PERCENT')] }).semanticType).toBe('POLICY_PATH');
    expect(recognizeSemanticType({ ...empty, claimText: '资产负债表扩张' }).semanticType).toBe('BALANCE_SHEET');
    expect(recognizeSemanticType({ ...empty, claimText: '关税壁垒上升' }).semanticType).toBe('TRADE_FLOW');
    expect(recognizeSemanticType({ ...empty, claimText: '外资流出', numericMentions: [number('CURRENCY')] }).semanticType).toBe('CAPITAL_FLOW');
    expect(recognizeSemanticType({ ...empty, claimText: '同比涨幅明显', numericMentions: [number('PERCENT')] }).semanticType).toBe('PERCENT_CHANGE');
    expect(recognizeSemanticType({ ...empty, claimText: '若降息情景', numericMentions: [] }).semanticType).toBe('SCENARIO_COMPARE');
  });

  it('其他语义关键词：文档/视频/概念/总结/流动（不抢占更具体的财经语义）', () => {
    expect(recognizeSemanticType({ ...empty, claimText: '最新财报披露' }).semanticType).toBe('DOCUMENT');
    expect(recognizeSemanticType({ ...empty, claimText: '现场录像显示' }).semanticType).toBe('VIDEO_EVIDENCE');
    expect(recognizeSemanticType({ ...empty, claimText: '这个原理的本质' }).semanticType).toBe('CONCEPT');
    expect(recognizeSemanticType({ ...empty, claimText: '综上，三个判断' }).semanticType).toBe('SUMMARY');
    expect(recognizeSemanticType({ ...empty, claimText: '信息沿链条传导' }).semanticType).toBe('FLOW');
    // 「资金流动」含 FLOW 词「流动」，但 CAPITAL_FLOW 更具体 → 财经语义优先
    expect(recognizeSemanticType({ ...empty, claimText: '资金流动加速', numericMentions: [number('CURRENCY')] }).semanticType).toBe('CAPITAL_FLOW');
    // 嵌入块 → 视频证据；图表块 → 指标集
    expect(recognizeSemanticType({ ...empty, claimText: '片头', blockKinds: ['embed'] }).semanticType).toBe('VIDEO_EVIDENCE');
    expect(recognizeSemanticType({ ...empty, claimText: '图 1', blockKinds: ['chart'] }).semanticType).toBe('KPI_SET');
  });

  it('引文/来源/实体/图片块', () => {
    expect(recognizeSemanticType({ ...empty, claimText: '某官员表态', hasQuote: true }).semanticType).toBe('QUOTE');
    expect(recognizeSemanticType({ ...empty, claimText: '来自报告的判断', hasSource: true }).semanticType).toBe('SOURCE');
    expect(recognizeSemanticType({ ...empty, claimText: '他宣布了计划', entityKinds: ['PERSON'] }).semanticType).toBe('PERSON');
    expect(recognizeSemanticType({ ...empty, claimText: '该公司宣布', entityKinds: ['ORG'] }).semanticType).toBe('COMPANY');
    expect(recognizeSemanticType({ ...empty, claimText: '现场照片', blockKinds: ['image'] }).semanticType).toBe('IMAGE_EVIDENCE');
  });

  it('纯数值：单值 → NUMBER / PERCENT_CHANGE；多值 → KPI_SET', () => {
    expect(recognizeSemanticType({ ...empty, claimText: '规模达到 100 万', numericMentions: [number('ABSOLUTE', '100 万')] }).semanticType).toBe('NUMBER');
    expect(recognizeSemanticType({ ...empty, claimText: '占比 5.25%', numericMentions: [number('PERCENT', '5.25%')] }).semanticType).toBe('PERCENT_CHANGE');
    expect(
      recognizeSemanticType({
        ...empty,
        claimText: '三项',
        numericMentions: [number('PERCENT'), number('CURRENCY'), number('RATIO')],
      }).semanticType,
    ).toBe('KPI_SET');
  });

  it('时间线 ≥2 → TIMELINE；空信号 → HOST_STATEMENT（安全兜底，绝不编造）', () => {
    expect(recognizeSemanticType({ ...empty, claimText: '回顾历程', timelineMentions: 2 }).semanticType).toBe('TIMELINE');
    const fallback = recognizeSemanticType({ ...empty, claimText: '我们继续关注' });
    expect(fallback.semanticType).toBe('HOST_STATEMENT');
    expect(fallback.rule).toBe('fallback_host');
    expect(fallback.reasons.length).toBeGreaterThan(0);
  });

  it('识别结果必有允许集合，且默认建议场景类型在允许集合内（固定语义 → 允许类型）', () => {
    const samples: RecognitionInput[] = [
      empty,
      { ...empty, claimText: '经济持续增长', datasets: [timeSeries(5)] },
      { ...empty, claimText: '期限利差', datasets: [pairedSeries(4)] },
      { ...empty, claimText: '同比涨幅', numericMentions: [number('PERCENT')] },
      { ...empty, claimText: '因为通胀' },
      { ...empty, claimText: '美国与欧洲' },
      { ...empty, claimText: '现场照片', blockKinds: ['image'] },
    ];
    for (const sample of samples) {
      const { semanticType } = recognizeSemanticType(sample);
      const rule = ruleForSemanticType(semanticType);
      expect(rule.allowedSceneTypes.length).toBeGreaterThan(0);
      const suggested = rule.preferredSceneTypes[0] ?? rule.allowedSceneTypes[0];
      expect(rule.allowedSceneTypes).toContain(suggested);
    }
  });
});

describe('datasetShape 序列特征', () => {
  it('识别年份/季度/日期时间序，聚合点数与序列数', () => {
    const shape = datasetShape({
      id: 'ds',
      unit: '%',
      bindable: true,
      series: [{ points: [{ t: '2023', v: 1 }, { t: '2024Q1', v: 2 }, { t: '2025-03-01', v: 3 }] }],
    });
    expect(shape.timeOrdered).toBe(true);
    expect(shape.pointCount).toBe(3);
    expect(shape.seriesCount).toBe(1);
    expect(shape.bindable).toBe(true);
  });

  it('类别标签不算时间序；对齐的双序列为 paired', () => {
    const shape = datasetShape({
      id: 'ds',
      unit: 'USD',
      bindable: true,
      series: [
        { points: [{ t: 'A', v: 1 }, { t: 'B', v: 2 }] },
        { points: [{ t: 'A', v: 3 }, { t: 'B', v: 4 }] },
      ],
    });
    expect(shape.timeOrdered).toBe(false);
    expect(shape.hasPairedSeries).toBe(true);
    expect(shape.pointCount).toBe(4);
  });

  it('未对齐的双序列不是 paired（不得误导为对比图）', () => {
    const shape = datasetShape({
      id: 'ds',
      unit: 'USD',
      bindable: true,
      series: [
        { points: [{ t: '2020', v: 1 }, { t: '2021', v: 2 }] },
        { points: [{ t: '2021', v: 3 }, { t: '2022', v: 4 }] },
      ],
    });
    expect(shape.hasPairedSeries).toBe(false);
  });
});
