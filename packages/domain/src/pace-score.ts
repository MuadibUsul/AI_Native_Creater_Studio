/**
 * 节奏谱 B0（Proposal 0.2 §4.4，裁决 0020 第 9 条）：只算两项——切点密度（每分钟剪辑数）与语速（每秒词数），
 * 按固定窗口（默认 5 秒，配置项，待实测）给出实测曲线；与导演在蓝图里设定的目标比较，偏差超过阈值的窗口列入报告。
 *
 * - 纯函数，无 I/O；时间单位是时间线上的毫秒（分析视图）；
 * - 只提供依据与建议：偏差进交付报告与导演的自检结果，不自动改片（"指标驱动的机械剪辑"是 0.2 列出的失败模式）；
 * - 语速按识别出的词（中文为识别器给出的词或字）计数，只在有人说话的窗口给出，跨语种不可直接比较。
 */

export interface PaceInput {
  lengthMs: number;
  /** 画面剪辑点（时间线上的毫秒；0 与片尾不算） */
  cutsMs: readonly number[];
  /** 时间线上的词（已按片段映射） */
  words: readonly { startMs: number; endMs: number }[];
}

export interface PaceWindow {
  startMs: number;
  endMs: number;
  cuts: number;
  cutsPerMinute: number;
  words: number;
  /** 这个窗口里没人说话时为 null */
  wordsPerSecond: number | null;
}

export interface PaceScore {
  windowMs: number;
  windows: PaceWindow[];
  overall: { cutsPerMinute: number; wordsPerSecond: number | null };
}

export interface PaceTarget {
  cutsPerMinute: number | null;
  wordsPerSecond: number | null;
}

export interface PaceDeviation {
  windowIndex: number;
  startMs: number;
  endMs: number;
  component: 'cutDensity' | 'speechRate';
  measured: number;
  target: number;
  /** 相对偏差（实测 / 目标 − 1） */
  delta: number;
  direction: 'FASTER' | 'SLOWER';
}

const round = (value: number, digits = 2): number => Math.round(value * 10 ** digits) / 10 ** digits;

export function measurePace(input: PaceInput, options: { windowMs?: number; minLastWindowMs?: number } = {}): PaceScore {
  const windowMs = Math.max(1000, Math.round(options.windowMs ?? 5000));
  const minLast = options.minLastWindowMs ?? 2000;
  const length = Math.max(0, Math.round(input.lengthMs));
  const cuts = input.cutsMs.filter((at) => at > 0 && at < length);
  const words = input.words.filter((word) => word.endMs > word.startMs);
  const windows: PaceWindow[] = [];
  for (let start = 0; start < length; start += windowMs) {
    const end = Math.min(length, start + windowMs);
    // 最后一段太短：并入前一个窗口，避免一两秒的尾巴把密度放大
    if (end - start < minLast && windows.length > 0) {
      const previous = windows.pop()!;
      windows.push(windowOf(previous.startMs, end, cuts, words));
      break;
    }
    windows.push(windowOf(start, end, cuts, words));
  }
  const totalWords = words.length;
  const speechSpan = words.length === 0 ? 0 : words.reduce((total, word) => total + (word.endMs - word.startMs), 0);
  return {
    windowMs,
    windows,
    overall: {
      cutsPerMinute: length === 0 ? 0 : round((cuts.length * 60_000) / length),
      wordsPerSecond: speechSpan === 0 ? null : round((totalWords * 1000) / Math.max(speechSpan, 1000)),
    },
  };
}

function windowOf(start: number, end: number, cuts: readonly number[], words: readonly { startMs: number; endMs: number }[]): PaceWindow {
  const span = Math.max(1, end - start);
  const inside = cuts.filter((at) => at >= start && at < end).length;
  // 词按中点归属窗口；语速 = 词数 / 窗口里有人说话的时长（不少于 1 秒，避免一个词把语速放大）
  const spoken = words.filter((word) => {
    const middle = (word.startMs + word.endMs) / 2;
    return middle >= start && middle < end;
  });
  const speech = spoken.reduce((total, word) => total + (Math.min(word.endMs, end) - Math.max(word.startMs, start)), 0);
  return {
    startMs: start,
    endMs: end,
    cuts: inside,
    cutsPerMinute: round((inside * 60_000) / span),
    words: spoken.length,
    wordsPerSecond: spoken.length === 0 ? null : round((spoken.length * 1000) / Math.max(speech, 1000)),
  };
}

/** 与目标比较：相对偏差超过阈值（默认 50%，配置项）的窗口；目标为空的分量不比较。 */
export function paceDeviations(score: PaceScore, target: PaceTarget, options: { threshold?: number } = {}): PaceDeviation[] {
  const threshold = options.threshold ?? 0.5;
  const deviations: PaceDeviation[] = [];
  score.windows.forEach((window, windowIndex) => {
    const check = (component: PaceDeviation['component'], measured: number | null, goal: number | null) => {
      if (measured === null || goal === null || goal <= 0) return;
      const delta = measured / goal - 1;
      if (Math.abs(delta) <= threshold) return;
      deviations.push({ windowIndex, startMs: window.startMs, endMs: window.endMs, component, measured, target: goal, delta: round(delta), direction: delta > 0 ? 'FASTER' : 'SLOWER' });
    };
    check('cutDensity', window.cutsPerMinute, target.cutsPerMinute);
    check('speechRate', window.wordsPerSecond, target.wordsPerSecond);
  });
  return deviations;
}
