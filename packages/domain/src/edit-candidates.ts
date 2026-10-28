/**
 * 编辑候选层（裁决 0020 第 5 条，Proposal 0.1 §4 / AP-01）：从素材已有的分析结果派生"哪里可以切、哪里可以收紧、哪里不要切断"。
 *
 * - 纯函数，无 I/O；输入是一段素材里的词（带时间）、句子、镜头边界、静音与黑场，单位是素材内的毫秒（分析视图，不进权威时间线；
 *   真正下刀时导演给出十进制秒，由编辑内核按帧网格换成有理时间）；
 * - 只标注、不判定"有用 / 无用"：停顿、呼吸、语气词都可能有表演价值，是否删除由导演决定（0.1 §4.3）；
 * - 每个剪点给出安全窗口（在两个词之间、不切到字），每个可收紧的段落给出原因与文字证据；
 * - 句子整体列为"不要切断"的区间（切在句子中间会把一句话剪断）。
 */

export interface TimedWord {
  startMs: number;
  endMs: number;
  text: string;
  speaker: string | null;
}

export interface EditPointsInput {
  words: readonly TimedWord[];
  sentences: readonly { startMs: number; endMs: number }[];
  shotBoundariesMs: readonly number[];
  silencesMs: readonly (readonly [number, number])[];
  blacksMs: readonly (readonly [number, number])[];
  durationMs: number | null;
}

export interface EditPointsOptions {
  /** 两个词之间多长算一次停顿（默认 300 ms） */
  minPauseMs?: number;
  /** 多长的停顿列为可收紧（默认 700 ms） */
  longPauseMs?: number;
  /** 剪点离字的最小余量（默认 40 ms） */
  padMs?: number;
}

export type CutPointKind = 'SENTENCE_END' | 'PAUSE' | 'SPEAKER_CHANGE' | 'SHOT_BOUNDARY';

export interface CutPoint {
  atMs: number;
  kind: CutPointKind;
  /** 可以下刀的安全窗口（含两端）：在这个范围里切不会切到字 */
  windowMs: [number, number];
  /** 两个词之间的停顿长度；镜头边界为 null */
  pauseMs: number | null;
  /** 镜头边界落在说话中间（在这里切会切断语音） */
  insideSpeech: boolean;
  /** 前一个词（证据，参考数据） */
  before: string | null;
}

export type RemovalKind = 'LONG_PAUSE' | 'FILLER' | 'SILENCE' | 'BLACK' | 'LEAD_IN' | 'TAIL';

export interface RemovalCandidate {
  rangeMs: [number, number];
  kind: RemovalKind;
  /** 语气词原文（参考数据）；其他为 null */
  text: string | null;
}

export interface EditPoints {
  cutPoints: CutPoint[];
  removals: RemovalCandidate[];
  /** 不要切断的区间：整句话 */
  keepIntact: [number, number][];
}

/** 常见的独立语气词（只收没有实义、单独出现的；"那个""就是"这类有歧义的不收）。比较前去掉标点、转小写。 */
const FILLERS = new Set([
  '嗯', '嗯嗯', '呃', '呃呃', '额', '唔', '啊呃', '呃啊',
  'um', 'umm', 'uh', 'uhh', 'uhm', 'erm', 'er', 'hmm', 'mm', 'mmm',
]);

const normalizeToken = (text: string): string => text.toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '');

export function isFillerWord(text: string): boolean {
  return FILLERS.has(normalizeToken(text));
}

const byStart = <T extends { startMs: number }>(items: readonly T[]): T[] => [...items].sort((left, right) => left.startMs - right.startMs);

/** 每个句子的最后一个词的下标（句子里开始时间早于句末的最后一个词）。 */
function sentenceEndIndexes(words: readonly TimedWord[], sentences: readonly { startMs: number; endMs: number }[]): Set<number> {
  const ends = new Set<number>();
  for (const sentence of sentences) {
    let last = -1;
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index]!;
      if (word.startMs >= sentence.startMs - 1 && word.startMs < sentence.endMs) last = index;
    }
    if (last >= 0) ends.add(last);
  }
  return ends;
}

export function findEditPoints(input: EditPointsInput, options: EditPointsOptions = {}): EditPoints {
  const minPause = options.minPauseMs ?? 300;
  const longPause = options.longPauseMs ?? 700;
  const pad = options.padMs ?? 40;
  const words = byStart(input.words).filter((word) => Number.isFinite(word.startMs) && Number.isFinite(word.endMs) && word.endMs >= word.startMs);
  const sentenceEnds = sentenceEndIndexes(words, input.sentences);
  const cutPoints: CutPoint[] = [];
  const removals: RemovalCandidate[] = [];

  for (let index = 0; index + 1 < words.length; index += 1) {
    const current = words[index]!;
    const next = words[index + 1]!;
    const gap = next.startMs - current.endMs;
    const speakerChange = current.speaker !== null && next.speaker !== null && current.speaker !== next.speaker;
    const sentenceEnd = sentenceEnds.has(index);
    if (gap < minPause && !sentenceEnd && !speakerChange) continue;
    const windowStart = gap > 2 * pad ? current.endMs + pad : current.endMs;
    const windowEnd = gap > 2 * pad ? next.startMs - pad : Math.max(current.endMs, next.startMs);
    cutPoints.push({
      atMs: Math.round(Math.min(windowEnd, Math.max(windowStart, current.endMs + Math.min(Math.max(gap, 0) / 2, 200)))),
      kind: sentenceEnd ? 'SENTENCE_END' : speakerChange ? 'SPEAKER_CHANGE' : 'PAUSE',
      windowMs: [Math.round(windowStart), Math.round(windowEnd)],
      pauseMs: Math.max(0, Math.round(gap)),
      insideSpeech: false,
      before: current.text.slice(0, 40),
    });
    if (gap >= longPause) removals.push({ rangeMs: [Math.round(current.endMs + pad), Math.round(next.startMs - pad)], kind: 'LONG_PAUSE', text: null });
  }

  for (const word of words) {
    if (isFillerWord(word.text)) removals.push({ rangeMs: [Math.round(word.startMs), Math.round(word.endMs)], kind: 'FILLER', text: word.text.slice(0, 20) });
  }
  const first = words[0];
  const last = words.at(-1);
  if (first !== undefined && first.startMs - pad >= longPause) removals.push({ rangeMs: [0, Math.round(first.startMs - pad)], kind: 'LEAD_IN', text: null });
  if (last !== undefined && input.durationMs !== null && input.durationMs - last.endMs - pad >= longPause) {
    removals.push({ rangeMs: [Math.round(last.endMs + pad), Math.round(input.durationMs)], kind: 'TAIL', text: null });
  }
  for (const [start, end] of input.silencesMs) if (end > start) removals.push({ rangeMs: [Math.round(start), Math.round(end)], kind: 'SILENCE', text: null });
  for (const [start, end] of input.blacksMs) if (end > start) removals.push({ rangeMs: [Math.round(start), Math.round(end)], kind: 'BLACK', text: null });

  const duration = input.durationMs ?? Number.POSITIVE_INFINITY;
  for (const boundary of [...new Set(input.shotBoundariesMs)].sort((left, right) => left - right)) {
    if (!(boundary > 0 && boundary < duration)) continue;
    const speaking = words.find((word) => word.startMs < boundary && boundary < word.endMs);
    const previous = [...words].reverse().find((word) => word.endMs <= boundary);
    cutPoints.push({ atMs: Math.round(boundary), kind: 'SHOT_BOUNDARY', windowMs: [Math.round(boundary), Math.round(boundary)], pauseMs: null, insideSpeech: speaking !== undefined, before: previous?.text.slice(0, 40) ?? null });
  }

  cutPoints.sort((left, right) => left.atMs - right.atMs || left.kind.localeCompare(right.kind));
  removals.sort((left, right) => left.rangeMs[0] - right.rangeMs[0] || left.kind.localeCompare(right.kind));
  const keepIntact = byStart(input.sentences).filter((sentence) => sentence.endMs > sentence.startMs)
    .map((sentence): [number, number] => [Math.round(sentence.startMs), Math.round(sentence.endMs)]);
  return { cutPoints, removals, keepIntact };
}

// ---------------------------------------------------------------------------
// 原声字幕：把（已映射到时间线的）词分成字幕行
// ---------------------------------------------------------------------------

export interface CaptionLine {
  startMs: number;
  endMs: number;
  text: string;
}

export interface CaptionLineOptions {
  /** 每行最多字数（中文按字、英文按字符；默认中文 16、英文 42） */
  maxChars?: number;
  /** 每行最长时长（默认 6000 ms） */
  maxMs?: number;
  /** 每行最短显示（默认 800 ms，不压到下一行） */
  minMs?: number;
  /** 词之间停顿超过这个就换行（默认 600 ms） */
  breakPauseMs?: number;
  /** 去掉独立语气词（默认是） */
  skipFillers?: boolean;
}

const CJK = /[\u3000-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/u;
const SENTENCE_FINAL = /[。！？!?.…]$/u;
const TRAILING_SOFT = /[，、,;；:：\s]+$/u;

function joinWords(words: readonly TimedWord[]): string {
  let text = '';
  for (const word of words) {
    const token = word.text.trim();
    if (token.length === 0) continue;
    const needsSpace = text.length > 0 && !CJK.test(text.at(-1)!) && !CJK.test(token[0]!) && !/^[,.!?;:，。！？；：、)）]/u.test(token);
    text += needsSpace ? ` ${token}` : token;
  }
  return text.replace(TRAILING_SOFT, '');
}

/**
 * 词 → 字幕行：遇到句末、明显停顿、超长或超字数就换行；行尾留一点余量但不压到下一行；太短的行延长到最短显示。
 * `sentenceEndAfter`：在这些下标（含）之后的词处换行（句子边界，来自转写分句）。
 */
export function captionLinesFromWords(input: { words: readonly TimedWord[]; sentenceEndAfter?: ReadonlySet<number> }, options: CaptionLineOptions = {}): CaptionLine[] {
  const words = byStart(input.words).filter((word) => word.endMs > word.startMs && word.text.trim().length > 0);
  const kept = options.skipFillers === false ? words.map((word, index) => ({ word, index })) : words.flatMap((word, index) => (isFillerWord(word.text) ? [] : [{ word, index }]));
  const cjk = kept.filter(({ word }) => CJK.test(word.text)).length * 2 >= kept.length;
  const maxChars = options.maxChars ?? (cjk ? 16 : 42);
  const maxMs = options.maxMs ?? 6000;
  const minMs = options.minMs ?? 800;
  const breakPause = options.breakPauseMs ?? 600;
  const groups: TimedWord[][] = [];
  let current: TimedWord[] = [];
  let previousIndex = -1;
  for (const { word, index } of kept) {
    const previous = current.at(-1);
    const breakHere = previous !== undefined && (
      word.startMs - previous.endMs >= breakPause
      || (input.sentenceEndAfter?.has(previousIndex) ?? false)
      || SENTENCE_FINAL.test(previous.text.trim())
      || word.endMs - current[0]!.startMs > maxMs
      || joinWords([...current, word]).length > maxChars
    );
    if (breakHere) {
      groups.push(current);
      current = [];
    }
    current.push(word);
    previousIndex = index;
  }
  if (current.length > 0) groups.push(current);
  const lines = groups.map((group) => ({ startMs: Math.round(group[0]!.startMs), endMs: Math.round(group.at(-1)!.endMs), text: joinWords(group) }))
    .filter((line) => line.text.length > 0);
  // 行尾余量与最短显示：不越过下一行的开始
  return lines.map((line, index) => {
    const nextStart = lines[index + 1]?.startMs ?? Number.POSITIVE_INFINITY;
    const end = Math.min(Math.max(line.endMs + 200, line.startMs + minMs), nextStart);
    return { ...line, endMs: Math.max(line.endMs, Math.round(end)) };
  });
}
