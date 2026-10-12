import type { AgentPointer, RealtimeAttention, RealtimePointerSample, RealtimeWord } from '@ancs/contracts';

/**
 * V6 §5.2 共同注意力：指代按**发话那一刻**绑定（纯函数，无 I/O）。
 *
 * - "这个/这里/this/here"：取说出这个词时（允许 0.3 秒内紧跟着的点击）用户指着的东西；
 *   没有明确选择时，用当时的播放位置（前后各 1 秒）；
 * - "从这里到这里"：两处指代各自绑定，合并成一个时间范围；
 * - 没有指代词：用开口那一刻的明确选择；什么都没指 → 作用于整条视频；
 * - 以"但是/不对/除了…"这类未闭合的词结尾的话先不交给 AI（等后半句，V4 增量设计 §7.3）。
 * 这里不猜：词级时间缺失时只用开口时的选择，并如实标注证据种类。
 */

const ZH_DEICTIC = ['这一段', '这一块', '这个', '这里', '这儿', '这段', '这边', '这块', '这句', '这张', '那个', '那里', '那儿', '那段', '那边', '那句', '刚才'];
const EN_DEICTIC = new Set(['this', 'here', 'these', 'there', 'that', 'those']);
const ZH_UNCLOSED = ['但是', '不过', '除了', '不对', '不是', '而且', '然后', '还有', '或者', '以及', '另外'];
const EN_UNCLOSED = ['but', 'except', 'and', 'or', 'then', 'not', 'also', 'actually', 'no wait', 'wait'];
/** 点击可以略晚于说出指代词（边说边点） */
const GRACE_SECONDS = 0.3;
const PLAYHEAD_SPAN_SECONDS = 1;

const CJK = /[㐀-鿿豈-﫿]/;

/** 中文转写去掉字与字之间的空格（部分供应商逐字返回）；英文按空格连接。 */
export function joinTranscript(parts: readonly string[], locale: string): string {
  const tokens = parts.join(' ').split(/\s+/).filter((token) => token.length > 0);
  if (locale !== 'zh-CN') return tokens.join(' ');
  let out = '';
  for (const token of tokens) {
    const previous = out.at(-1) ?? '';
    // 两个非中文的词之间保留空格（例如夹在中文里的 "B roll"），其余拼接
    out += out.length === 0 || CJK.test(previous) || CJK.test(token[0] ?? '') ? token : ` ${token}`;
  }
  return out;
}

/** 一句话以未闭合的连接/否定词结尾（或停在逗号上）→ 还没说完。 */
export function isUnclosedUtterance(text: string, locale: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (/[,，、]$/.test(trimmed)) return true;
  const bare = trimmed.replace(/[.。!！?？…\s]+$/u, '');
  if (locale === 'zh-CN') return ZH_UNCLOSED.some((word) => bare.endsWith(word));
  const lower = bare.toLowerCase();
  return EN_UNCLOSED.some((word) => lower === word || lower.endsWith(` ${word}`));
}

/** 指代词及其在音频里的开始时间（按出现顺序）。 */
export function findDeicticWords(words: readonly RealtimeWord[], locale: string): { word: string; at: number }[] {
  if (locale !== 'zh-CN') {
    return words
      .map((word) => ({ word: word.text.toLowerCase().replace(/[^a-z']/g, ''), at: word.start }))
      .filter((word) => EN_DEICTIC.has(word.word));
  }
  // 中文：把词拼成一串，记录每个字属于哪个词，再按最长匹配找指代词
  let joined = '';
  const owner: number[] = [];
  words.forEach((word, index) => {
    for (const char of word.text.replace(/\s+/g, '')) { joined += char; owner.push(index); }
  });
  const found: { word: string; at: number }[] = [];
  let cursor = 0;
  while (cursor < joined.length) {
    const term = ZH_DEICTIC.find((candidate) => joined.startsWith(candidate, cursor));
    if (term === undefined) { cursor += 1; continue; }
    const word = words[owner[cursor] ?? 0];
    found.push({ word: term, at: word?.start ?? 0 });
    cursor += term.length;
  }
  return found;
}

const isExplicit = (pointer: AgentPointer): boolean => pointer.timeRange !== null || pointer.clipIds.length > 0;

/** 某一时刻（秒）的指向样本：取时钟不晚于该时刻（加宽限）的最后一个样本。 */
export function pointerSampleAt(samples: readonly RealtimePointerSample[], seconds: number, sampleRate: number, graceSeconds = GRACE_SECONDS): RealtimePointerSample | null {
  const limit = (seconds + graceSeconds) * sampleRate;
  let chosen: RealtimePointerSample | null = null;
  for (const sample of samples) {
    if (sample.atSample <= limit && (chosen === null || sample.atSample >= chosen.atSample)) chosen = sample;
  }
  return chosen;
}

const decimal = (value: number): string => (Math.round(value * 1000) / 1000).toFixed(3);

function playheadRange(playhead: string | null): AgentPointer | null {
  if (playhead === null) return null;
  const at = Number(playhead);
  if (!Number.isFinite(at) || at < 0) return null;
  return { timeRange: { start: decimal(Math.max(0, at - PLAYHEAD_SPAN_SECONDS)), end: decimal(at + PLAYHEAD_SPAN_SECONDS) }, clipIds: [] };
}

/** 两处指向合并（"从这里到这里"）：时间取并集范围，片段取并集。 */
function mergePointers(left: AgentPointer, right: AgentPointer): AgentPointer {
  const ranges = [left.timeRange, right.timeRange].filter((range): range is { start: string; end: string } => range !== null);
  const timeRange = ranges.length === 0 ? null : {
    start: decimal(Math.min(...ranges.map((range) => Number(range.start)))),
    end: decimal(Math.max(...ranges.map((range) => Number(range.end)))),
  };
  return { timeRange, clipIds: [...new Set([...left.clipIds, ...right.clipIds])] };
}

const EMPTY: AgentPointer = { timeRange: null, clipIds: [] };

export function bindAttention(input: {
  words: readonly RealtimeWord[];
  samples: readonly RealtimePointerSample[];
  sampleRate: number;
  locale: string;
  /** 开口时间（秒）；缺词级时间时用这句话第一段结果的开始时间 */
  utteranceStart: number;
}): RealtimeAttention {
  const deictic = findDeicticWords(input.words, input.locale);
  const bound = deictic.map((hit) => {
    const sample = pointerSampleAt(input.samples, hit.at, input.sampleRate);
    if (sample !== null && isExplicit(sample.pointer)) return { hit, sample, pointer: sample.pointer, evidence: 'DEICTIC_WORD' as const };
    const fromPlayhead = sample === null ? null : playheadRange(sample.playhead);
    return fromPlayhead === null ? null : { hit, sample, pointer: fromPlayhead, evidence: 'PLAYHEAD_AT_WORD' as const };
  }).filter((item): item is NonNullable<typeof item> => item !== null);

  if (bound.length > 0) {
    const first = bound[0]!;
    // 同一个指向重复说（"这个……这个"）不改变结果；两处不同的指向合并成范围
    const distinct = bound.filter((item, index) => bound.findIndex((other) => JSON.stringify(other.pointer) === JSON.stringify(item.pointer)) === index);
    const pointer = distinct.slice(1).reduce((merged, item) => mergePointers(merged, item.pointer), first.pointer);
    return {
      pointer,
      evidence: distinct.every((item) => item.evidence === 'PLAYHEAD_AT_WORD') ? 'PLAYHEAD_AT_WORD' : 'DEICTIC_WORD',
      word: first.hit.word,
      atSeconds: Math.round(first.hit.at * 1000) / 1000,
      label: distinct.length === 1 ? first.sample?.label ?? null : null,
    };
  }
  const atStart = pointerSampleAt(input.samples, input.utteranceStart, input.sampleRate, 0);
  if (atStart !== null && isExplicit(atStart.pointer)) {
    return { pointer: atStart.pointer, evidence: 'SELECTION_AT_START', word: null, atSeconds: Math.round(input.utteranceStart * 1000) / 1000, label: atStart.label };
  }
  return { pointer: EMPTY, evidence: 'NONE', word: null, atSeconds: null, label: null };
}
