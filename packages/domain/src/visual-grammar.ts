import {
  SEMANTIC_TYPES,
  VISUAL_GRAMMAR_VERSION,
  visualGrammarRuleSchema,
  type SemanticType,
  type VisualGrammarRule,
} from '@ancs/contracts';

/**
 * Visual Grammar 映射表与确定性识别（P04-04 / 规范 §10.1、§10.2）。
 *
 * - 映射表**数据驱动**（与 Catalog 同风格；V1 以 20 个标准场景类型为准，DEC-04）；
 * - 识别**确定性优先**：规则/词典 + 数据形状（序列特征）；LLM 仅作兜底且必须结构化（§52）；
 * - "对固定语义输入得到允许类型" = 识别出的 sceneType 必须落在该语义的 allowedSceneTypes 内。
 */

const S = (semanticType: SemanticType, allowedSceneTypes: string[], options: Partial<VisualGrammarRule> = {}): VisualGrammarRule =>
  visualGrammarRuleSchema.parse({
    semanticType,
    allowedSceneTypes,
    preferredSceneTypes: options.preferredSceneTypes ?? allowedSceneTypes.slice(0, 1),
    requiresData: options.requiresData ?? false,
    requiresSource: options.requiresSource ?? false,
    fallbackOrder: options.fallbackOrder ?? ['CHART', 'SOURCE_CARD', 'QUOTE', 'TEXTUAL_EXPLANATION', 'REQUEST_DATA'],
  });

/**
 * 语义 → 允许场景类型（§10.2 的映射收敛到 V1 的 20 个标准类型；清单外类型留待后续阶段，
 * 但允许集合仍显式列出以保持"固定语义 → 允许类型"可断言）。
 */
export const VISUAL_GRAMMAR_RULES: readonly VisualGrammarRule[] = [
  // 基础
  // 数值类：数字**逐字取自 Claim 文本**（非图表），因此要求可追溯来源（§10.3「结构化数据或可追踪 Source」），
  // 不要求数据集绑定；无来源时按阶梯降级（绝不把无出处的数字做成大字报）。
  // V1 收敛到 DEC-04 的 20 类：NUMBER_COMPARE / PERCENT_DELTA 组件属后续任务（P10-04），
  // 此处显式映射到 BIG_NUMBER（语义精度保留在 semanticType，不静默冒充缺失组件）。
  S('NUMBER', ['BIG_NUMBER'], { requiresSource: true }),
  S('KPI_SET', ['KPI_GRID', 'BIG_NUMBER'], { requiresSource: true }),
  S('TREND', ['LINE_CHART', 'DUAL_LINE_CHART', 'SPREAD_AREA_CHART'], { requiresData: true }),
  S('COMPARISON', ['DUAL_LINE_CHART', 'BAR_CHART'], { requiresData: true }),
  S('RANKING', ['BAR_CHART', 'KPI_GRID'], { requiresData: true }),
  S('TIMELINE', ['TIMELINE', 'CAUSAL_FLOW'], {}),
  S('CAUSE_EFFECT', ['CAUSAL_FLOW', 'SUMMARY'], {}),
  S('FEEDBACK_LOOP', ['CAUSAL_LOOP'], {}),
  S('FLOW', ['CAUSAL_FLOW'], {}),
  S('GEOGRAPHY', ['MAP_STATIC'], {}),
  S('NETWORK', ['CAUSAL_FLOW', 'SUMMARY'], {}),
  S('PROCESS', ['CAUSAL_FLOW', 'TIMELINE'], {}),
  S('QUOTE', ['QUOTE_CARD'], { requiresSource: true }),
  S('SOURCE', ['SOURCE_CARD', 'NEWS_HEADLINE', 'DOCUMENT_HIGHLIGHT'], { requiresSource: true }),
  S('PERSON', ['SOURCE_CARD', 'IMAGE_FULL'], {}),
  S('COMPANY', ['SOURCE_CARD', 'IMAGE_FULL'], {}),
  S('DOCUMENT', ['DOCUMENT_HIGHLIGHT', 'SOURCE_CARD'], {}),
  S('IMAGE_EVIDENCE', ['IMAGE_FULL', 'REAL_BROLL'], {}),
  S('VIDEO_EVIDENCE', ['REAL_BROLL'], {}),
  S('CONCEPT', ['SUMMARY', 'HOST_FULL'], {}),
  S('TRANSITION', ['CHAPTER_TITLE'], {}),
  S('SUMMARY', ['SUMMARY', 'HOST_FULL'], {}),
  // HOST_PIP / HOST_OVERLAY 属后续布局变体（P10-04）；V1 用 HOST_FULL / HOST_SIDE。
  S('HOST_STATEMENT', ['HOST_FULL', 'HOST_SIDE'], { preferredSceneTypes: ['HOST_FULL'] }),
  // 财经扩展（§10.1 财经清单）
  S('YIELD_SPREAD', ['SPREAD_AREA_CHART', 'LINE_CHART'], { requiresData: true }),
  S('YIELD_CURVE', ['LINE_CHART'], { requiresData: true }),
  S('PRICE_SERIES', ['LINE_CHART'], { requiresData: true }),
  S('CANDLE_SERIES', ['LINE_CHART'], { requiresData: true }),
  // PERCENT_DELTA 组件属后续任务（P10-04）；V1 以 BIG_NUMBER 承载百分比变化事实。
  S('PERCENT_CHANGE', ['BIG_NUMBER'], { requiresSource: true }),
  S('BALANCE_SHEET', ['KPI_GRID', 'BAR_CHART'], { requiresData: true }),
  S('SUPPLY_DEMAND', ['LINE_CHART', 'DUAL_LINE_CHART'], { requiresData: true }),
  S('TRADE_FLOW', ['MAP_STATIC', 'BAR_CHART'], { requiresData: true }),
  S('CAPITAL_FLOW', ['MAP_STATIC', 'BAR_CHART'], { requiresData: true }),
  S('POLICY_PATH', ['TIMELINE', 'LINE_CHART'], {}),
  S('SCENARIO_COMPARE', ['DUAL_LINE_CHART', 'BAR_CHART'], { requiresData: true }),
];

const RULE_BY_TYPE = new Map<SemanticType, VisualGrammarRule>(VISUAL_GRAMMAR_RULES.map((rule) => [rule.semanticType, rule]));

export function ruleForSemanticType(semanticType: SemanticType): VisualGrammarRule {
  const rule = RULE_BY_TYPE.get(semanticType);
  if (rule === undefined) throw new Error(`Visual Grammar 缺失语义类型映射：${semanticType}`);
  return rule;
}

/** 全部语义类型都必须有映射（契约/映射一致性，测试直接断言）。 */
export function missingSemanticTypes(): SemanticType[] {
  return SEMANTIC_TYPES.filter((semanticType) => !RULE_BY_TYPE.has(semanticType));
}

/** ---------- 确定性识别 ---------- */

export interface DatasetShape {
  id: string;
  unit: string;
  /** 时间序（t 为年份/日期/季度） */
  timeOrdered: boolean;
  pointCount: number;
  seriesCount: number;
  /** 单序列或多序列整体是否单调（趋势） */
  monotonic: boolean;
  /** 是否存在成对的差值语义（两条序列同 t） */
  hasPairedSeries: boolean;
}

export interface RecognitionInput {
  claimText: string;
  /** 数值提及（P04-02：归一化单位 + 原始文本） */
  numericMentions: { raw: string; canonical: 'PERCENT' | 'CURRENCY' | 'RATIO' | 'ABSOLUTE' | 'YEAR'; unit: string }[];
  /** 可用数据集形状（已过绑定门控的为 bindable） */
  datasets: (DatasetShape & { bindable: boolean })[];
  /** 时间线提及次数（P04-02） */
  timelineMentions: number;
  /** 是否有引文（claim 的 citation.quotedText） */
  hasQuote: boolean;
  /** 是否有可追溯来源 */
  hasSource: boolean;
  /** 实体提及（P04-02 extractions） */
  entityKinds: ('PERSON' | 'ORG' | 'COUNTRY' | 'OTHER')[];
  /** 块类型（quote 块 → QUOTE 语义的强信号） */
  blockKinds?: string[];
}

const containsAny = (text: string, words: string[]): string | null => words.find((word) => text.includes(word)) ?? null;

const FINANCE_KEYWORDS: { type: SemanticType; words: string[] }[] = [
  { type: 'YIELD_SPREAD', words: ['利差', '价差', '信用利差', '期限利差', 'spread'] },
  { type: 'YIELD_CURVE', words: ['收益率曲线', 'yield curve'] },
  { type: 'CANDLE_SERIES', words: ['k线', 'K线', '蜡烛图', '涨跌'] },
  { type: 'PRICE_SERIES', words: ['股价', '价格走势', '报价', '利率', '汇率', '指数'] },
  // 情景词先于政策路径判定：「若降息情景」是 SCENARIO_COMPARE，「加息路径」才是 POLICY_PATH。
  { type: 'SCENARIO_COMPARE', words: ['情景', '假设', '如果'] },
  { type: 'POLICY_PATH', words: ['路径', '加息', '降息', '政策节奏', '点阵图'] },
  { type: 'SUPPLY_DEMAND', words: ['供需', '供给', '需求'] },
  { type: 'TRADE_FLOW', words: ['贸易流', '进出口', '关税'] },
  { type: 'CAPITAL_FLOW', words: ['资本流', '资金流', '外资'] },
  { type: 'BALANCE_SHEET', words: ['资产负债表', '资产端', '负债端'] },
  { type: 'PERCENT_CHANGE', words: ['涨幅', '跌幅', '涨了', '跌了', '同比', '环比', '下降了', '上升了'] },
];

/**
 * 其他语义关键词（判定顺序在财经之后：更具体的财经语义优先）。
 * TRANSITION 不做块级识别（章节转场是 Director/结构的职责，P04-05 在场景图层面处理）。
 */
const MISC_KEYWORDS: { type: SemanticType; words: string[] }[] = [
  { type: 'DOCUMENT', words: ['财报', '白皮书', '公告', '研报', '文件披露'] },
  { type: 'VIDEO_EVIDENCE', words: ['视频', '录像', '影像'] },
  { type: 'CONCEPT', words: ['概念', '原理', '本质', '什么是'] },
  { type: 'SUMMARY', words: ['总结', '综上', '概括', '一句话'] },
  { type: 'FLOW', words: ['流动', '流向', '传导'] },
];

const STRUCTURE_KEYWORDS: { type: SemanticType; words: string[] }[] = [
  { type: 'FEEDBACK_LOOP', words: ['循环', '反馈', '自我强化', '螺旋'] },
  { type: 'CAUSE_EFFECT', words: ['因为', '由于', '导致', '使得', '结果是', '原因是', '之所以'] },
  { type: 'GEOGRAPHY', words: ['地区', '国家', '全球', '欧洲', '亚洲', '美国', '中国', '贸易伙伴'] },
  // 避免单字「先」等高频虚词（"先把镜头拉近"会误判为流程）；只保留明确的流程词。
  { type: 'PROCESS', words: ['流程', '步骤', '第一步', '第二步', '然后', '接下来'] },
  { type: 'NETWORK', words: ['网络', '关联方', '上下游', '生态'] },
];

/**
 * 确定性语义识别（优先数据形状，其次关键词，最后安全兜底 HOST_STATEMENT）。
 * 返回的语义类型**必须**能映射到允许场景类型（映射表覆盖全部语义类型，测试断言）。
 */
export function recognizeSemanticType(input: RecognitionInput): { semanticType: SemanticType; rule: string; confidence: number; reasons: string[] } {
  const text = input.claimText;
  const reasons: string[] = [];

  // 1) 数据形状优先（事实图表；§10.3 只绑定真实结构化数据）
  const bindable = input.datasets.filter((dataset) => dataset.bindable);
  if (bindable.length > 0) {
    const trend = bindable.find((dataset) => dataset.timeOrdered && dataset.pointCount >= 3);
    if (trend !== undefined) {
      // 时间序数据的分支顺序：利差（需双序列）→ 供需 → 收益率曲线/K线 → 价格/利率序列 → 双序列对比 → 趋势
      const spreadHint = containsAny(text, ['利差', '价差', 'spread']);
      if (spreadHint !== null && trend.seriesCount >= 2) {
        return { semanticType: 'YIELD_SPREAD', rule: 'dataset_spread', confidence: 0.9, reasons: [`双序列时间序数据集且文本含「${spreadHint}」`] };
      }
      const supplyHint = containsAny(text, ['供需', '供给', '需求']);
      if (supplyHint !== null) {
        return { semanticType: 'SUPPLY_DEMAND', rule: 'dataset_supply_demand', confidence: 0.75, reasons: [`时间序数据集 + 供需词「${supplyHint}」`] };
      }
      const curveHint = containsAny(text, ['收益率曲线', 'yield curve']);
      if (curveHint !== null) {
        return { semanticType: 'YIELD_CURVE', rule: 'dataset_yield_curve', confidence: 0.8, reasons: [`时间序数据集 + 「${curveHint}」`] };
      }
      const candleHint = containsAny(text, ['k线', 'K线', '蜡烛图']);
      if (candleHint !== null) {
        return { semanticType: 'CANDLE_SERIES', rule: 'dataset_candle', confidence: 0.8, reasons: [`时间序数据集 + 「${candleHint}」`] };
      }
      const financeHint = containsAny(text, ['利率', '汇率', '价格', '指数', '股价', '报价']);
      if (financeHint !== null) {
        return { semanticType: 'PRICE_SERIES', rule: 'dataset_price_series', confidence: 0.85, reasons: [`时间序数据集 + 财经词「${financeHint}」`] };
      }
      if (trend.hasPairedSeries && trend.seriesCount >= 2) {
        return { semanticType: 'COMPARISON', rule: 'dataset_dual_series', confidence: 0.8, reasons: ['两条时间序序列同轴可比'] };
      }
      return { semanticType: 'TREND', rule: 'dataset_trend', confidence: 0.85, reasons: [`时间序数据集（${String(trend.pointCount)} 点）`] };
    }
    const comparison = bindable.find((dataset) => dataset.seriesCount >= 2 && dataset.hasPairedSeries);
    if (comparison !== undefined) {
      return { semanticType: 'COMPARISON', rule: 'dataset_comparison', confidence: 0.8, reasons: ['两条以上同时间序列'] };
    }
    const small = bindable.find((dataset) => dataset.pointCount <= 6);
    if (small !== undefined) {
      return { semanticType: 'RANKING', rule: 'dataset_ranking', confidence: 0.7, reasons: [`小规模数据集（${String(small.pointCount)} 点，适合排序/对比条`] };
    }
  }
  const anyDataset = input.datasets.find((dataset) => dataset.bindable && dataset.pointCount >= 1);
  if (anyDataset !== undefined && input.numericMentions.length >= 3) {
    return { semanticType: 'KPI_SET', rule: 'dataset_kpi_set', confidence: 0.65, reasons: ['多指标数据可用于 KPI 网格'] };
  }

  // 2) 结构/因果/地理/流程关键词
  for (const candidate of STRUCTURE_KEYWORDS) {
    const hit = containsAny(text, candidate.words);
    if (hit !== null) {
      return { semanticType: candidate.type, rule: `keyword_${candidate.type.toLowerCase()}`, confidence: 0.7, reasons: [`关键词「${hit}」`] };
    }
  }

  // 3) 财经扩展关键词
  for (const candidate of FINANCE_KEYWORDS) {
    const hit = containsAny(text, candidate.words);
    if (hit !== null) {
      const hasNumbers = input.numericMentions.length > 0;
      return {
        semanticType: candidate.type,
        rule: `keyword_${candidate.type.toLowerCase()}`,
        confidence: hasNumbers ? 0.75 : 0.55,
        reasons: [`财经词「${hit}」${hasNumbers ? ' + 数值证据' : '（无数值证据，需数据或来源）'}`],
      };
    }
  }

  // 4) 文档/视频/概念/流动/总结关键词（放在财经之后：更具体的财经语义优先，避免「资金流动」误判为 FLOW）
  for (const candidate of MISC_KEYWORDS) {
    const hit = containsAny(text, candidate.words);
    if (hit !== null) {
      return { semanticType: candidate.type, rule: `keyword_${candidate.type.toLowerCase()}`, confidence: 0.6, reasons: [`关键词「${hit}」`] };
    }
  }

  // 5) 引文/来源/文档
  if (input.hasQuote || (input.blockKinds ?? []).includes('quote')) {
    return { semanticType: 'QUOTE', rule: 'quote_present', confidence: 0.85, reasons: ['存在引文'] };
  }
  if (input.hasSource && input.numericMentions.length === 0 && input.datasets.every((dataset) => !dataset.bindable)) {
    return { semanticType: 'SOURCE', rule: 'source_only', confidence: 0.6, reasons: ['只有来源、无可绑定数据'] };
  }

  // 6) 实体/媒体
  if (input.entityKinds.includes('PERSON') && input.numericMentions.length === 0) {
    return { semanticType: 'PERSON', rule: 'entity_person', confidence: 0.5, reasons: ['人物实体'] };
  }
  if (input.entityKinds.includes('ORG') && input.numericMentions.length === 0) {
    return { semanticType: 'COMPANY', rule: 'entity_org', confidence: 0.5, reasons: ['机构实体'] };
  }
  if ((input.blockKinds ?? []).includes('image')) {
    return { semanticType: 'IMAGE_EVIDENCE', rule: 'image_block', confidence: 0.6, reasons: ['存在图片块'] };
  }
  if ((input.blockKinds ?? []).includes('embed') || (input.blockKinds ?? []).includes('chart')) {
    const kind = (input.blockKinds ?? []).includes('embed') ? 'embed' : 'chart';
    return kind === 'embed'
      ? { semanticType: 'VIDEO_EVIDENCE', rule: 'embed_block', confidence: 0.6, reasons: ['存在视频/嵌入块'] }
      : { semanticType: 'KPI_SET', rule: 'chart_block', confidence: 0.5, reasons: ['存在图表块（按指标集规划）'] };
  }

  // 7) 纯数值：单值 vs 多值
  if (input.numericMentions.length >= 3) {
    return { semanticType: 'KPI_SET', rule: 'numeric_kpi_set', confidence: 0.6, reasons: [`${String(input.numericMentions.length)} 个数值 → KPI 网格`] };
  }
  if (input.numericMentions.length === 1) {
    const mention = input.numericMentions[0];
    if (mention?.canonical === 'PERCENT' || /\d+.?(涨|跌|升|降)/.test(text)) {
      return { semanticType: 'PERCENT_CHANGE', rule: 'numeric_percent', confidence: 0.6, reasons: ['百分比数值'] };
    }
    return { semanticType: 'NUMBER', rule: 'numeric_single', confidence: 0.6, reasons: ['单个数值 → 大字报数'] };
  }

  // 8) 时间线
  if (input.timelineMentions >= 2) {
    return { semanticType: 'TIMELINE', rule: 'timeline_mentions', confidence: 0.6, reasons: [`${String(input.timelineMentions)} 个时间提及`] };
  }

  // 9) 安全兜底：无数据无信号的叙述 → 主持人陈述（确定性、绝不编造）
  reasons.push('无数据/关键词信号：安全兜底为主持人陈述');
  return { semanticType: 'HOST_STATEMENT', rule: 'fallback_host', confidence: 0.3, reasons };
}

/** 数据集序列 → 形状特征（供识别使用）。 */
export function datasetShape(input: { id: string; unit: string; bindable: boolean; series: { points: { t: string; v: number }[] }[] }): DatasetShape & { bindable: boolean } {
  const timePattern = /^(19|20)\d{2}([-Q].*)?$/;
  const allPoints = input.series.flatMap((series) => series.points);
  const timeOrdered = allPoints.length > 0 && allPoints.every((point) => timePattern.test(point.t));
  const singleSeries = input.series[0]?.points ?? [];
  let monotonic = singleSeries.length >= 3;
  for (let index = 1; index < singleSeries.length && monotonic; index += 1) {
    const previous = singleSeries[index - 1]?.v ?? 0;
    const current = singleSeries[index]?.v ?? 0;
    if (index > 1) {
      const beforePrevious = singleSeries[index - 2]?.v ?? 0;
      if (Math.sign(current - previous) !== Math.sign(previous - beforePrevious)) monotonic = false;
    }
  }
  const tsSets = input.series.map((series) => new Set(series.points.map((point) => point.t)));
  const hasPairedSeries = input.series.length >= 2 && [...(tsSets[0] ?? [])].every((t) => tsSets.slice(1).every((set) => set.has(t)));
  return {
    id: input.id,
    unit: input.unit,
    bindable: input.bindable,
    timeOrdered,
    pointCount: allPoints.length,
    seriesCount: input.series.length,
    monotonic,
    hasPairedSeries,
  };
}

export { VISUAL_GRAMMAR_VERSION };
