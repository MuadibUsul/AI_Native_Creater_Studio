import { createHash } from 'node:crypto';
import {
  EVIDENCE_ERROR_REASONS,
  factVisualDecisionSchema,
  type ChartBindingCheck,
  type FactVisualDecision,
  type NumericMention,
} from '@ancs/contracts';
import type { ContentBlock } from '@ancs/contracts';

/**
 * 证据抽取与事实可视化策略（P04-02）——**确定性部分**（无 I/O、无 LLM，可单测）。
 *
 * 纪律（规范 §10.3 MUST）：
 * - 数据图表只能绑定结构化数据或可追踪 Source；
 * - 关键数据缺失时**不得编造图形数据**——`planFactVisual` 给出降级阶梯
 *   （CHART → SOURCE_CARD → QUOTE → TEXTUAL_EXPLANATION → REQUEST_DATA）；
 * - 数值抽取保留**原始文本**（可复核），归一化只做比较基准换算，不改变数值事实。
 */

const NUMBER_PATTERN = /(-?\d{1,3}(?:,\d{3})*(?:\.\d+)?|-?\d+(?:\.\d+)?)\s*(万亿|亿|万|千|%|％|个百分点|bps|bp|倍|美元|USD|EUR|CNY|元|亿美元|万亿元)?/g;

const UNIT_MAP: Readonly<Record<string, { canonical: NumericMention['canonical']; factor: number; unit: string }>> = {
  '%': { canonical: 'PERCENT', factor: 1, unit: '%' },
  '％': { canonical: 'PERCENT', factor: 1, unit: '%' },
  个百分点: { canonical: 'PERCENT', factor: 1, unit: '个百分点' },
  bp: { canonical: 'PERCENT', factor: 0.01, unit: 'bp' },
  bps: { canonical: 'PERCENT', factor: 0.01, unit: 'bp' },
  倍: { canonical: 'RATIO', factor: 1, unit: '倍' },
  美元: { canonical: 'CURRENCY', factor: 1, unit: 'USD' },
  USD: { canonical: 'CURRENCY', factor: 1, unit: 'USD' },
  EUR: { canonical: 'CURRENCY', factor: 1, unit: 'EUR' },
  CNY: { canonical: 'CURRENCY', factor: 1, unit: 'CNY' },
  元: { canonical: 'CURRENCY', factor: 1, unit: 'CNY' },
  亿美元: { canonical: 'CURRENCY', factor: 100_000_000, unit: 'USD' },
  万亿元: { canonical: 'CURRENCY', factor: 1_000_000_000_000, unit: 'CNY' },
  万: { canonical: 'ABSOLUTE', factor: 10_000, unit: 'ABSOLUTE' },
  亿: { canonical: 'ABSOLUTE', factor: 100_000_000, unit: 'ABSOLUTE' },
  万亿: { canonical: 'ABSOLUTE', factor: 1_000_000_000_000, unit: 'ABSOLUTE' },
  千: { canonical: 'ABSOLUTE', factor: 1_000, unit: 'ABSOLUTE' },
};

/** 单位归一（保留原始单位文本；`value` 为归一后的比较值）。 */
export function normalizeUnit(rawValue: string, rawUnit: string | undefined): {
  value: number;
  canonical: NumericMention['canonical'];
  unit: string;
  rawUnit: string | null;
} {
  const numeric = Number(rawValue.replace(/,/g, ''));
  if (rawUnit === undefined || rawUnit === '') {
    return { value: numeric, canonical: 'ABSOLUTE', unit: 'ABSOLUTE', rawUnit: null };
  }
  const mapped = UNIT_MAP[rawUnit];
  if (mapped === undefined) {
    return { value: numeric, canonical: 'ABSOLUTE', unit: rawUnit, rawUnit };
  }
  return { value: numeric * mapped.factor, canonical: mapped.canonical, unit: mapped.unit, rawUnit: rawUnit };
}

/** 年份/日期提及（时间线；年份单独处理，避免与普通数字混淆）。 */
export function extractTimelineMentions(block: ContentBlock): { date: string; description: string }[] {
  const text = block.text ?? block.items?.join(' · ') ?? '';
  const mentions: { date: string; description: string }[] = [];
  const datePattern = /(\d{4}年(?:\d{1,2}月)?(?:\d{1,2}日)?|\d{4}-\d{2}(?:-\d{2})?|\d{4}Q[1-4]|\d{4})/g;
  let match: RegExpExecArray | null;
  while ((match = datePattern.exec(text)) !== null) {
    const raw = match[1] ?? '';
    const canonical = raw
      .replace(/年/, '-')
      .replace(/月/, '-')
      .replace(/日/, '')
      .replace(/-$/, '')
      .replace(/Q(\d)/, '-Q$1');
    // 描述 = 该日期所在的分句（截断 80 字）
    const start = Math.max(0, text.lastIndexOf('。', match.index) + 1);
    const end = text.indexOf('。', match.index);
    const sentence = text.slice(start, end === -1 ? text.length : end).trim();
    mentions.push({ date: canonical, description: sentence.slice(0, 80) });
  }
  return mentions;
}

/** 数值提及抽取（保留原始文本与偏移；供 citation locator 与图表复核）。 */
export function extractNumericMentions(block: ContentBlock): NumericMention[] {
  const text = block.text ?? block.items?.join(' · ') ?? '';
  const mentions: NumericMention[] = [];
  let match: RegExpExecArray | null;
  NUMBER_PATTERN.lastIndex = 0;
  while ((match = NUMBER_PATTERN.exec(text)) !== null) {
    const raw = (match[0] ?? '').trim();
    // 纯年份（1900-2099，无单位）不算数值事实（属时间线）
    if (/^(19|20)\d{2}$/.test(raw.trim())) continue;
    const normalized = normalizeUnit(match[1] ?? '0', match[2]);
    mentions.push({
      blockId: block.id,
      raw,
      value: normalized.value,
      canonical: normalized.canonical,
      unit: normalized.unit,
      rawUnit: normalized.rawUnit,
      offset: match.index,
    });
  }
  return mentions;
}

const UNCERTAINTY_WORDS = ['可能', '预计', '或', '或许', '疑似', '不确定', '大约', '约', '有望', '或将', 'may', 'might', 'could', 'possibly', 'expected'];
const OPINION_WORDS = ['我认为', '值得', '应该', '看好', '不看好', '优于', '糟糕', '我认为', '比想象', 'i think', 'in my view'];
const ANALYSIS_WORDS = ['因为', '原因是', '意味着', '表明', '这说明', '推导', '因此', '由于', '反映', '暗示'];

/** 句子切分（中英文标点；保留偏移）。 */
export function splitSentences(text: string): { text: string; start: number }[] {
  const sentences: { text: string; start: number }[] = [];
  const pattern = /[^。！？!?\n]+[。！？!?]?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const raw = (match[0] ?? '').trim();
    if (raw.length < 4) continue; // 过短片段（标题词/噪声）不作为 Claim 候选（中文短句 4 字即有效）
    sentences.push({ text: raw, start: match.index });
  }
  return sentences;
}

/** Claim 事实性判定（保守启发式：默认 fact，出现不确定/观点词即降级类型）。 */
export function classifyFactuality(sentence: string): 'fact' | 'analysis' | 'opinion' | 'uncertain' {
  const lower = sentence.toLowerCase();
  if (OPINION_WORDS.some((word) => lower.includes(word))) return 'opinion';
  if (UNCERTAINTY_WORDS.some((word) => lower.includes(word))) return 'uncertain';
  if (ANALYSIS_WORDS.some((word) => sentence.includes(word) || lower.includes(word))) return 'analysis';
  return 'fact';
}

export interface ClaimCandidate {
  text: string;
  factuality: 'fact' | 'analysis' | 'opinion' | 'uncertain';
  blockId: string;
  /** 来源块内偏移（citation locator 使用） */
  start: number;
  end: number;
  numericMentions: NumericMention[];
  /** 确定性方法抽取 → confidence 1.0（可复核） */
  confidence: number;
}

/** 从块序列抽取 Claim 候选（确定性；数值句优先，避免把纯叙述都做成 Claim）。 */
export function extractClaimCandidates(blocks: ContentBlock[]): ClaimCandidate[] {
  const candidates: ClaimCandidate[] = [];
  for (const block of blocks) {
    if (block.type === 'heading') continue; // 标题不是 Claim
    const text = block.text ?? block.items?.join(' · ') ?? '';
    if (text.trim() === '') continue;
    const mentions = extractNumericMentions(block);
    for (const sentence of splitSentences(text)) {
      const numericInSentence = mentions.filter((mention) => mention.offset >= sentence.start && mention.offset < sentence.start + sentence.text.length);
      const factuality = classifyFactuality(sentence.text);
      // 只保留"有数值证据"或"明确不确定/观点"的句子为候选；纯叙述留给 Narrative（P04-03）处理
      if (numericInSentence.length === 0 && factuality === 'fact') continue;
      candidates.push({
        text: sentence.text,
        factuality,
        blockId: block.id,
        start: sentence.start,
        end: sentence.start + sentence.text.length,
        numericMentions: numericInSentence,
        confidence: 1,
      });
    }
  }
  return candidates;
}

/** 数据集可绑定校验（图表 Scene 只能绑定非 synthetic、非空、有来源的数据集）。 */
export function checkChartBinding(dataset: {
  synthetic: boolean;
  sourceIds: string[];
  series: { id: string; name: string; points: unknown[] }[];
}): ChartBindingCheck {
  const reasons: string[] = [];
  const pointCount = dataset.series.reduce((sum, series) => sum + series.points.length, 0);
  if (dataset.synthetic) reasons.push(EVIDENCE_ERROR_REASONS.SYNTHETIC_DATASET_NOT_BINDABLE);
  if (dataset.sourceIds.length === 0) reasons.push(EVIDENCE_ERROR_REASONS.DATASET_REQUIRES_SOURCE);
  if (pointCount === 0) reasons.push(EVIDENCE_ERROR_REASONS.DATASET_EMPTY);
  return {
    bindable: reasons.length === 0,
    reasons,
    dataSourceIds: dataset.sourceIds,
    pointCount,
  };
}

export interface FactVisualInput {
  /** Claim 是否有可追溯来源（citation/sourceIds） */
  hasTraceableSource: boolean;
  /** Claim 文本（降级时作为文本解释或引文） */
  claimText: string;
  /** 可绑定的数据集（已过 checkChartBinding；null = 无数据） */
  bindableDataset: { id: string; sourceIds: string[] } | null;
  /** 引文（Quote 策略用） */
  quotedText: string | null;
  quoteSourceId: string | null;
}

/**
 * 事实可视化策略（§10.3 降级阶梯）：
 *   有可绑定数据集 → CHART（附 data_source_ids）；
 *   否则有引文 → QUOTE；有可追溯来源 → SOURCE_CARD；
 *   有 Claim 文本（无可追溯来源）→ TEXTUAL_EXPLANATION；
 *   什么都没有 → REQUEST_DATA（提示补数据，**绝不编造数列**）。
 */
export function planFactVisual(input: FactVisualInput): FactVisualDecision {
  if (input.bindableDataset !== null) {
    return factVisualDecisionSchema.parse({
      strategy: 'CHART',
      reason: '存在可绑定的结构化数据集（非 synthetic、非空、有来源）',
      datasetId: input.bindableDataset.id,
      dataSourceIds: input.bindableDataset.sourceIds,
    });
  }
  if (input.quotedText !== null) {
    return factVisualDecisionSchema.parse({
      strategy: 'QUOTE',
      reason: '无可用数据集：降级为引文（保留原文与来源）',
      quoteSourceId: input.quoteSourceId,
      quoteText: input.quotedText,
    });
  }
  if (input.hasTraceableSource) {
    return factVisualDecisionSchema.parse({
      strategy: 'SOURCE_CARD',
      reason: '无可用数据集：降级为来源卡（可追溯但不呈现数值图形）',
      quoteSourceId: input.quoteSourceId,
    });
  }
  if (input.claimText.trim() !== '') {
    return factVisualDecisionSchema.parse({
      strategy: 'TEXTUAL_EXPLANATION',
      reason: '无可追溯来源：仅允许文本解释，不得生成图表数据',
    });
  }
  return factVisualDecisionSchema.parse({
    strategy: 'REQUEST_DATA',
    reason: '关键数据缺失：不得编造图形数据，需用户补充数据或来源',
    requestHint: '请补充可追溯的数据来源（或上传数据表）后再生成事实图表',
  });
}

/** 稳定的抽取指纹（重复运行抽取的幂等键；内容不变 → 指纹不变）。 */
export function extractionFingerprint(blocks: ContentBlock[]): string {
  const payload = blocks.map((block) => `${block.type}:${block.text ?? ''}:${block.items?.join('|') ?? ''}:${block.table ? JSON.stringify(block.table) : ''}`).join('\n');
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}
