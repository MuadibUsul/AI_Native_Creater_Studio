import { DEFAULT_DUCKING } from './mixdown.js';
import { mixPlanSchema } from './mixdown.js';
import type { CaptionStyle, MixInputTrack, MixPlan, SubtitleFormat, SubtitleOutput } from './mixdown.js';
import type { NarrationCue } from './alignment.js';

/**
 * 混音计划与字幕生成的**纯计算**（P06-06；平台中立：contracts 不依赖 react/remotion/DB，
 * domain（服务层）与 web/remotion-core（预览与成片）共用同一实现）。
 *
 * 纪律：
 * - 本模块**不接触 TTS/网络**：音量/淡入淡出/ducking 只是增益包络计算——"音量调整不重做 TTS"是结构性保证；
 * - **无重叠双人声**：旁白区间只来自 Alignment cues（单一来源）；混音输入不允许 NARRATION 轨（由 service 校验）；
 * - 字幕由时间数据确定性生成（SRT/VTT 时间码规范固定）；越界只报 warning，绝不静默裁切。
 */

const clampGain = (value: number): number => Math.max(0, Math.min(2, value));

export interface MixPlanInput {
  projectId: string;
  durationMs: number;
  cues: readonly NarrationCue[];
  tracks: readonly MixInputTrack[];
  ducking?: { level: number; attackMs: number; releaseMs: number };
  /** 旁白自身的基准音量（默认 1；Master 音量） */
  narrationVolume?: number;
}

/** 生成混音计划（每轨增益关键帧；ducking 在旁白区间压低非旁白轨）。 */
export function planAudioMix(input: MixPlanInput): MixPlan {
  const ducking = {
    level: input.ducking?.level ?? DEFAULT_DUCKING.level,
    attackMs: input.ducking?.attackMs ?? DEFAULT_DUCKING.attackMs,
    releaseMs: input.ducking?.releaseMs ?? DEFAULT_DUCKING.releaseMs,
  };
  const intervals = [...input.cues]
    .map((cue) => ({ startMs: cue.startMs, endMs: cue.startMs + cue.durationMs }))
    .sort((left, right) => left.startMs - right.startMs);

  const warnings: string[] = [];
  const narrationVolume = clampGain(input.narrationVolume ?? 1);
  const narrationTrack = {
    trackId: 'narration:master',
    kind: 'NARRATION' as const,
    baseVolume: narrationVolume,
    ducking: false,
    keyframes: [
      { startMs: 0, endMs: Math.max(1, input.durationMs), fromGain: narrationVolume, toGain: narrationVolume, reason: 'BASE' as const },
    ],
  };

  const tracks = [];
  for (const track of input.tracks) {
    // 类型层面已排除 NARRATION（contracts 的 refine）；运行时双保险（外部数据绕过校验时拒绝第二人声）
    if ((track.kind as string) === 'NARRATION') {
      throw new Error('混音输入不得包含 NARRATION 轨（旁白唯一来源为 Master Narration）');
    }
    const base = clampGain(track.volume);
    const keyframes: MixPlan['tracks'][number]['keyframes'] = [];
    const fadeIn = Math.max(0, track.fadeInMs);
    const fadeOut = Math.max(0, track.fadeOutMs);
    if (fadeIn > 0) keyframes.push({ startMs: 0, endMs: fadeIn, fromGain: 0, toGain: base, reason: 'FADE_IN' });
    keyframes.push({ startMs: fadeIn, endMs: Math.max(fadeIn, input.durationMs - fadeOut), fromGain: base, toGain: base, reason: 'BASE' });
    if (fadeOut > 0) {
      keyframes.push({ startMs: Math.max(fadeIn, input.durationMs - fadeOut), endMs: input.durationMs, fromGain: base, toGain: 0, reason: 'FADE_OUT' });
    }
    if (track.ducking && intervals.length > 0) {
      // ducking：每个旁白区间起止前后按 attack/release 插入斜坡（区间内压至 level × base）
      for (const interval of intervals) {
        const attackStart = Math.max(0, interval.startMs - ducking.attackMs);
        keyframes.push({ startMs: attackStart, endMs: interval.startMs, fromGain: base, toGain: clampGain(base * ducking.level), reason: 'DUCKING' });
        keyframes.push({
          startMs: interval.startMs,
          endMs: interval.endMs,
          fromGain: clampGain(base * ducking.level),
          toGain: clampGain(base * ducking.level),
          reason: 'DUCKING',
        });
        keyframes.push({
          startMs: interval.endMs,
          endMs: interval.endMs + ducking.releaseMs,
          fromGain: clampGain(base * ducking.level),
          toGain: base,
          reason: 'DUCKING',
        });
      }
      keyframes.sort((left, right) => left.startMs - right.startMs);
    }
    tracks.push({ trackId: track.id, kind: track.kind, baseVolume: base, ducking: track.ducking, keyframes });
  }

  if (input.tracks.some((track) => track.kind === 'MUSIC') && intervals.length === 0) {
    warnings.push('存在 MUSIC 轨但没有旁白区间（Master Narration 未生成或为空）：ducking 不生效，BGM 可能覆盖人声场景。');
  }

  return mixPlanSchema.parse({
    projectId: input.projectId,
    durationMs: input.durationMs,
    narrationIntervals: intervals,
    tracks: [narrationTrack, ...tracks],
    ducking,
    warnings,
  });
}

/* ---------- 字幕（SRT/VTT） ---------- */

/** 视觉宽度（CJK=1；拉丁/数字/空格 ≈ 0.55），用于断行与安全区估算。 */
export const visualWidthOf = (text: string): number =>
  [...text].reduce((sum, char) => sum + (/[\u2e80-\u9fff\uff00-\uffef]/.test(char) ? 1 : 0.55), 0);

export interface CaptionCue {
  startMs: number;
  durationMs: number;
  text: string;
}

/** 断行（按视觉宽度；标点避免行首悬挂；最多 maxLines 行——超出报 warning 由调用方处理）。 */
export function wrapCaption(text: string, style: CaptionStyle): { lines: string[]; truncated: boolean } {
  const chars = [...text];
  const lines: string[] = [];
  let current = '';
  let width = 0;
  const noLineStart = new Set(['，', '。', '、', '；', '：', '？', '！', '）', '」', '』', ',', '.', ';', ':', '?', '!', ')']);
  for (const char of chars) {
    const charWidth = visualWidthOf(char);
    if (width + charWidth > style.maxCharsPerLine && current !== '') {
      // 避免把标点留在行首：把行尾最后一个字符挪到下一行
      if (noLineStart.has(char)) {
        const moved = current.slice(-1);
        current = current.slice(0, -1);
        lines.push(current);
        current = `${moved}${char}`;
        width = visualWidthOf(current);
        continue;
      }
      lines.push(current);
      current = char;
      width = charWidth;
      continue;
    }
    current += char;
    width += charWidth;
  }
  if (current !== '') lines.push(current);
  const maxLines = style.maxLines;
  if (lines.length <= maxLines) return { lines, truncated: false };
  // 超出 maxLines：合并尾部到末行（不丢失文字；由 warning 提示承载过密）
  const head = lines.slice(0, maxLines - 1);
  head.push(lines.slice(maxLines - 1).join(''));
  return { lines: head, truncated: true };
}

const pad = (value: number, length = 2): string => String(value).padStart(length, '0');

/** 毫秒 → SRT 时间码（00:00:00,000） */
export function toSrtTime(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(millis, 3)}`;
}

/** 毫秒 → VTT 时间码（00:00:00.000） */
export function toVttTime(ms: number): string {
  return toSrtTime(ms).replace(',', '.');
}

/** 生成字幕输出（SRT/VTT）；越界 cue 计入 stats 并给出 warning（不静默裁切）。 */
export function buildSubtitles(
  input: { format: SubtitleFormat; cues: readonly CaptionCue[]; style: CaptionStyle; safeWidthChars?: number },
): SubtitleOutput {
  const safeWidthChars = input.safeWidthChars ?? input.style.maxCharsPerLine;
  const warnings: string[] = [];
  let maxLines = 0;
  let maxLineVisualWidth = 0;
  let overSafeWidthCues = 0;
  const blocks: string[] = [];

  input.cues.forEach((cue, index) => {
    const wrapped = wrapCaption(cue.text, input.style);
    maxLines = Math.max(maxLines, wrapped.lines.length);
    for (const line of wrapped.lines) maxLineVisualWidth = Math.max(maxLineVisualWidth, visualWidthOf(line));
    if (wrapped.truncated) {
      overSafeWidthCues += 1;
      warnings.push(`第 ${String(index + 1)} 行字幕超出 ${String(input.style.maxLines)} 行上限（已合并末行，请缩短文本或调大 maxLines）`);
    }
    const time =
      input.format === 'SRT'
        ? `${toSrtTime(cue.startMs)} --> ${toSrtTime(cue.startMs + cue.durationMs)}`
        : `${toVttTime(cue.startMs)} --> ${toVttTime(cue.startMs + cue.durationMs)}`;
    if (input.format === 'SRT') {
      blocks.push(`${String(index + 1)}\n${time}\n${wrapped.lines.join('\n')}`);
    } else {
      blocks.push(`${time}\n${wrapped.lines.join('\n')}`);
    }
  });

  if (maxLineVisualWidth > safeWidthChars) {
    warnings.push(`最宽行视觉宽度 ${maxLineVisualWidth.toFixed(1)} 超过样式上限 ${String(safeWidthChars)}：请缩短文本或调大 maxCharsPerLine（字幕不得越界）`);
  }

  const content = input.format === 'SRT' ? `${blocks.join('\n\n')}\n` : `WEBVTT\n\n${blocks.join('\n\n')}\n`;
  return {
    format: input.format,
    content,
    cueCount: input.cues.length,
    stats: { maxLines, maxLineVisualWidth: Number(maxLineVisualWidth.toFixed(2)), overSafeWidthCues },
    warnings,
  };
}
