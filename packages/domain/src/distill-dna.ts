import type { EditingDna, ReferenceMeasurement } from '@ancs/contracts';

/**
 * 剪辑 DNA 统计（V6-6 蒸馏器；纯函数）：把 1–5 条参考视频的测量合成一份可读、可比较的 DNA。
 *
 * - 只用真实测量：剪点、镜头时长、黑场过渡、节拍、色彩、响度、静音、语速；测不到的字段为空，并在可信度说明里列出。
 * - 多条参考视频时，镜头时长合并统计（同一博主的几条视频比一条更稳）；节奏曲线按每条视频的相对位置平均。
 * - 卡点：剪点在节拍 ±70 ms 内算"在拍上"；只统计有规律节拍（置信度 ≥ 0.3）的视频。
 */

export const BEAT_CONFIDENCE_THRESHOLD = 0.3;
export const BEAT_TOLERANCE_SECONDS = 0.07;
const MIN_SHOT_SECONDS = 0.12;

const round = (value: number, digits = 2): number => Math.round(value * 10 ** digits) / 10 ** digits;

export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

type EditSource = Pick<ReferenceMeasurement, 'cuts' | 'analyzedSeconds'> & { blackDips?: ReferenceMeasurement['blackDips'] };

/** 剪辑点：硬切 + 黑场过渡（取黑场中点；离硬切 0.2 秒以内的视为同一处）。 */
export function editPoints(measurement: EditSource): number[] {
  const cuts = measurement.cuts.filter((cut) => cut > 0 && cut < measurement.analyzedSeconds);
  const dips = (measurement.blackDips ?? []).map((dip) => (dip.start + dip.end) / 2)
    .filter((mid) => mid > 0 && mid < measurement.analyzedSeconds && !cuts.some((cut) => Math.abs(cut - mid) < 0.2));
  return [...cuts, ...dips].sort((left, right) => left - right);
}

/** 镜头时长：[0, 剪辑点…, 分析终点] 之间的间隔（过短的抖动合并掉）。 */
export function shotDurations(measurement: EditSource): number[] {
  const boundaries = [0, ...editPoints(measurement), measurement.analyzedSeconds];
  const durations: number[] = [];
  let last = 0;
  for (const boundary of boundaries.slice(1)) {
    const duration = boundary - last;
    if (duration < MIN_SHOT_SECONDS && durations.length > 0) continue;
    durations.push(duration);
    last = boundary;
  }
  return durations;
}

/** 节奏曲线：10 段，每段每分钟剪辑点（硬切 + 黑场过渡）次数。 */
export function pacingCurve(measurement: EditSource): number[] {
  const segment = measurement.analyzedSeconds / 10;
  const counts = new Array<number>(10).fill(0);
  for (const cut of editPoints(measurement)) counts[Math.min(9, Math.floor(cut / segment))]! += 1;
  return counts.map((count) => round((count / segment) * 60, 1));
}

/** 剪点在节拍上的比例（无规律节拍或剪点太少 → null）。 */
export function beatCutRatio(measurement: Pick<ReferenceMeasurement, 'cuts' | 'beats'>): { onBeat: number; cuts: number } | null {
  const beats = measurement.beats;
  if (beats === null || beats.confidence < BEAT_CONFIDENCE_THRESHOLD || beats.times.length < 8) return null;
  const first = beats.times[0]!;
  const last = beats.times.at(-1)!;
  const cuts = measurement.cuts.filter((cut) => cut >= first - BEAT_TOLERANCE_SECONDS && cut <= last + BEAT_TOLERANCE_SECONDS);
  if (cuts.length < 4) return null;
  let onBeat = 0;
  let index = 0;
  for (const cut of [...cuts].sort((left, right) => left - right)) {
    while (index + 1 < beats.times.length && beats.times[index + 1]! <= cut) index += 1;
    const near = Math.min(Math.abs(cut - beats.times[index]!), Math.abs((beats.times[index + 1] ?? Infinity) - cut));
    if (near <= BEAT_TOLERANCE_SECONDS) onBeat += 1;
  }
  return { onBeat, cuts: cuts.length };
}

export interface DistilledStats {
  references: number;
  analyzedSeconds: number;
  shots: number;
  shotMedian: number | null;
  shotP20: number | null;
  shotP80: number | null;
  /** 每分钟剪辑点（硬切 + 黑场过渡） */
  cutsPerMinute: number;
  pacing: number[];
  beatCutRatio: number | null;
  /** 随机剪点也会落在 ±70 ms 内的比例（对照用：卡点比例要明显高于它才算"卡点剪"） */
  beatChanceRatio: number | null;
  bpm: number | null;
  blackDipsPerMinute: number;
  sceneActivity: number | null;
  color: { luma: number; saturation: number; contrast: number; warmth: number } | null;
  loudness: { integratedLufs: number | null; silenceRatio: number } | null;
  speech: { ratio: number; wordsPerMinute: number | null } | null;
  hookSeconds: number | null;
  /** 截掉未分析的部分（超过分析上限的视频） */
  truncated: boolean;
}

const weightedMean = (items: readonly { value: number; weight: number }[]): number | null => {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  return total === 0 ? null : items.reduce((sum, item) => sum + item.value * item.weight, 0) / total;
};

export function distillStats(measurements: readonly ReferenceMeasurement[]): DistilledStats {
  if (measurements.length === 0) throw new Error('distillStats needs at least one measurement');
  const analyzedSeconds = measurements.reduce((sum, item) => sum + item.analyzedSeconds, 0);
  const durations = measurements.flatMap((item) => shotDurations(item)).sort((left, right) => left - right);
  const cuts = measurements.reduce((sum, item) => sum + editPoints(item).length, 0);
  const curves = measurements.map((item) => pacingCurve(item));
  const pacing = new Array<number>(10).fill(0).map((_, index) => round(curves.reduce((sum, curve) => sum + curve[index]!, 0) / curves.length, 1));
  const beatResults = measurements.map((item) => ({ item, result: beatCutRatio(item) })).filter((entry) => entry.result !== null);
  const onBeat = beatResults.reduce((sum, entry) => sum + entry.result!.onBeat, 0);
  const beatCuts = beatResults.reduce((sum, entry) => sum + entry.result!.cuts, 0);
  const beatItems = beatResults.map((entry) => entry.item.beats!);
  const bpm = beatItems.length === 0 ? null : round(beatItems.reduce((sum, beats) => sum + beats.bpm, 0) / beatItems.length, 0);
  const chance = bpm === null ? null : Math.min(1, (2 * BEAT_TOLERANCE_SECONDS) / (60 / bpm));
  const weight = (item: ReferenceMeasurement) => item.analyzedSeconds;
  const colored = measurements.filter((item) => item.color !== null);
  const color = colored.length === 0 ? null : {
    luma: round(weightedMean(colored.map((item) => ({ value: item.color!.luma, weight: weight(item) })))!, 3),
    saturation: round(weightedMean(colored.map((item) => ({ value: item.color!.saturation, weight: weight(item) })))!, 3),
    contrast: round(weightedMean(colored.map((item) => ({ value: item.color!.contrast, weight: weight(item) })))!, 3),
    warmth: round(weightedMean(colored.map((item) => ({ value: item.color!.warmth, weight: weight(item) })))!, 3),
  };
  const audible = measurements.filter((item) => item.audio !== null);
  const lufsItems = audible.filter((item) => item.audio!.integratedLufs !== null);
  const loudness = audible.length === 0 ? null : {
    integratedLufs: lufsItems.length === 0 ? null : round(weightedMean(lufsItems.map((item) => ({ value: item.audio!.integratedLufs!, weight: weight(item) })))!, 1),
    silenceRatio: round(weightedMean(audible.map((item) => ({ value: item.audio!.silenceRatio, weight: weight(item) })))!, 3),
  };
  const spoken = measurements.filter((item) => item.speech !== null);
  const wpmItems = spoken.filter((item) => item.speech!.wordsPerMinute !== null);
  const speech = spoken.length === 0 ? null : {
    ratio: round(weightedMean(spoken.map((item) => ({ value: item.speech!.ratio, weight: weight(item) })))!, 3),
    wordsPerMinute: wpmItems.length === 0 ? null : round(weightedMean(wpmItems.map((item) => ({ value: item.speech!.wordsPerMinute!, weight: weight(item) })))!, 0),
  };
  const hooks = measurements.map((item) => item.speech?.firstSentenceEnd ?? null).filter((value): value is number => value !== null && value <= 20);
  const active = measurements.filter((item) => item.sceneActivity !== null);
  return {
    references: measurements.length,
    analyzedSeconds: round(analyzedSeconds, 1),
    shots: durations.length,
    shotMedian: durations.length === 0 ? null : round(quantile(durations, 0.5)),
    shotP20: durations.length === 0 ? null : round(quantile(durations, 0.2)),
    shotP80: durations.length === 0 ? null : round(quantile(durations, 0.8)),
    cutsPerMinute: round((cuts / analyzedSeconds) * 60, 1),
    pacing,
    beatCutRatio: beatCuts === 0 ? null : round(onBeat / beatCuts, 2),
    beatChanceRatio: chance === null ? null : round(chance, 2),
    bpm,
    blackDipsPerMinute: round((measurements.reduce((sum, item) => sum + item.blackDips.length, 0) / analyzedSeconds) * 60, 2),
    sceneActivity: active.length === 0 ? null : round(weightedMean(active.map((item) => ({ value: item.sceneActivity!, weight: weight(item) })))!, 3),
    color,
    loudness,
    speech,
    hookSeconds: hooks.length === 0 ? null : round(hooks.reduce((sum, value) => sum + value, 0) / hooks.length, 1),
    truncated: measurements.some((item) => item.analyzedSeconds + 0.5 < item.durationSeconds),
  };
}

/** 色彩倾向一句话（英文，给 AI）。阈值用合成色块标定（见测试）。 */
export function describeColor(color: DistilledStats['color']): string | null {
  if (color === null) return null;
  const parts = [
    color.luma < 0.35 ? 'dark, low-key images' : color.luma > 0.6 ? 'bright, high-key images' : 'mid brightness',
    color.saturation < 0.15 ? 'muted, desaturated color' : color.saturation > 0.35 ? 'vivid, saturated color' : 'natural saturation',
    color.contrast > 0.75 ? 'high contrast' : color.contrast < 0.45 ? 'low contrast' : 'moderate contrast',
    color.warmth > 0.05 ? 'a warm cast' : color.warmth < -0.05 ? 'a cool cast' : 'neutral white balance',
  ];
  return parts.join(', ');
}

/** 声音习惯一句话（英文，给 AI）。 */
export function describeSound(stats: Pick<DistilledStats, 'loudness' | 'speech' | 'bpm' | 'beatCutRatio'>): string | null {
  const parts: string[] = [];
  if (stats.loudness !== null) {
    const lufs = stats.loudness.integratedLufs;
    if (lufs !== null) parts.push(lufs > -14 ? `loud mix (${String(lufs)} LUFS)` : lufs < -23 ? `quiet mix (${String(lufs)} LUFS)` : `moderate loudness (${String(lufs)} LUFS)`);
    parts.push(stats.loudness.silenceRatio < 0.03 ? 'almost no silence' : stats.loudness.silenceRatio > 0.15 ? 'leaves silent pauses' : 'occasional pauses');
  }
  if (stats.bpm !== null) parts.push(`steady beat around ${String(stats.bpm)} BPM`);
  if (stats.speech !== null) parts.push(stats.speech.ratio > 0.5 ? `talk-driven (speech ${String(Math.round(stats.speech.ratio * 100))}% of the time${stats.speech.wordsPerMinute === null ? '' : `, ${String(stats.speech.wordsPerMinute)} words/min`})` : `speech ${String(Math.round(stats.speech.ratio * 100))}% of the time`);
  return parts.length === 0 ? null : parts.join(', ');
}

/** 统计 → 策略包的剪辑 DNA（测不到的字段为空；文字字段可由模型撰写时补充画面类观察）。 */
export function editingDnaFromStats(stats: DistilledStats): EditingDna {
  const min = stats.shotP20 ?? 0.5;
  const max = Math.max(min, stats.shotP80 ?? min);
  return {
    shotSeconds: { typical: { min: round(min, 1), max: round(max, 1) }, median: stats.shotMedian === null ? null : round(Math.max(0.05, stats.shotMedian), 2) },
    beatCutRatio: stats.beatCutRatio,
    shotScaleVariety: null,
    transitionsPerMinute: stats.blackDipsPerMinute,
    speedRampsPerMinute: null,
    zoomsPerMinute: null,
    hookSeconds: stats.hookSeconds,
    captionStyle: null,
    soundHabits: describeSound(stats),
    colorTendency: describeColor(stats.color),
    cutsPerMinute: stats.cutsPerMinute,
    pacing: stats.pacing,
    measured: { references: stats.references, analyzedSeconds: stats.analyzedSeconds, shots: stats.shots },
  };
}
