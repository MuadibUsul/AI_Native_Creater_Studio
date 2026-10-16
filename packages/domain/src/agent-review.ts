/**
 * V6 §6.4 自检与修正：AI 对自己剪出的草稿按**通用质量标准**自查（纯函数，可单测）。
 *
 * 只做与类型和策略无关的通用检查（裁决 0018）：黑场、静音、闪帧、画面空洞、成片长度与内容不符、
 * 句中剪断、画面没有声音、重复用同一段素材。结果是给 AI 的建议（时间是显示用的毫秒），
 * 不改工程；是否修改由 AI 决定，故意保留的要说明。分析层缺失时如实报告"无法检查"。
 */

export type ReviewSeverity = 'warning' | 'info';

export interface ReviewFinding {
  kind: 'EMPTY_TIMELINE' | 'BLACK_STRETCH' | 'SILENT_STRETCH' | 'FLASH_CLIP' | 'PICTURE_GAP' | 'LENGTH_MISMATCH' | 'CUT_MID_SENTENCE' | 'MISSING_SOUND' | 'REPEATED_SHOT';
  severity: ReviewSeverity;
  /** 时间线上的位置（毫秒，显示用） */
  atMs: [number, number];
  clipId: string | null;
  message: string;
}

export interface ReviewClip {
  id: string;
  trackId: string;
  footageId: string | null;
  sourceMs: [number, number];
  atMs: [number, number];
  linkedClipIds: string[];
}

export interface ReviewTrack {
  id: string;
  kind: string;
  position: number;
  hidden: boolean;
  muted: boolean;
}

export interface ReviewFootage {
  hasAudio: boolean;
  /** null = 该层没有分析结果（无法检查） */
  blackMs: [number, number][] | null;
  silenceMs: [number, number][] | null;
  sentencesMs: [number, number][] | null;
}

export interface ReviewInput {
  lengthMs: number;
  frameMs: number;
  tracks: ReviewTrack[];
  clips: ReviewClip[];
  footage: Record<string, ReviewFootage>;
}

export interface ReviewResult {
  findings: ReviewFinding[];
  stats: {
    lengthMs: number;
    contentEndMs: number;
    videoClips: number;
    shotMs: { min: number; median: number; max: number } | null;
    cutsPerMinute: number | null;
  };
  /** 因为缺少分析层而没法做的检查 */
  notChecked: string[];
}

const overlap = (a: [number, number], b: [number, number]): number => Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));

/** 源时间 → 时间线时间（线性映射；变速片段按比例）。 */
function toTimeline(clip: ReviewClip, sourceMs: number): number {
  const sourceSpan = clip.sourceMs[1] - clip.sourceMs[0];
  const timelineSpan = clip.atMs[1] - clip.atMs[0];
  const rate = sourceSpan <= 0 ? 1 : timelineSpan / sourceSpan;
  return Math.round(clip.atMs[0] + (sourceMs - clip.sourceMs[0]) * rate);
}

const BLACK_MIN_MS = 200;
const SILENCE_MIN_MS = 1000;
const FLASH_MAX_MS = 250;
const SENTENCE_MARGIN_MS = 300;

export function reviewTimeline(input: ReviewInput): ReviewResult {
  const findings: ReviewFinding[] = [];
  const notChecked = new Set<string>();
  const trackById = new Map(input.tracks.map((track) => [track.id, track]));
  const visibleVideo = input.clips.filter((clip) => {
    const track = trackById.get(clip.trackId);
    return track?.kind === 'VIDEO' && !track.hidden;
  });
  const audible = input.clips.filter((clip) => {
    const track = trackById.get(clip.trackId);
    return track?.kind === 'AUDIO' && !track.muted;
  });
  const contentEndMs = input.clips.reduce((end, clip) => Math.max(end, clip.atMs[1]), 0);

  if (input.clips.length === 0) {
    findings.push({ kind: 'EMPTY_TIMELINE', severity: 'warning', atMs: [0, input.lengthMs], clipId: null, message: 'The timeline has no clips.' });
  }

  for (const clip of visibleVideo) {
    const duration = clip.atMs[1] - clip.atMs[0];
    if (duration < FLASH_MAX_MS) {
      findings.push({ kind: 'FLASH_CLIP', severity: 'warning', atMs: clip.atMs, clipId: clip.id, message: `Clip is only ${String(duration)} ms long; it will read as a flash frame unless intended.` });
    }
    const footage = clip.footageId === null ? undefined : input.footage[clip.footageId];
    if (footage === undefined) continue;
    if (footage.blackMs === null) notChecked.add('black frames (footage not analyzed)');
    for (const black of footage.blackMs ?? []) {
      const shared = overlap(black, clip.sourceMs);
      if (shared < BLACK_MIN_MS) continue;
      const from = Math.max(black[0], clip.sourceMs[0]);
      const to = Math.min(black[1], clip.sourceMs[1]);
      findings.push({ kind: 'BLACK_STRETCH', severity: 'warning', atMs: [toTimeline(clip, from), toTimeline(clip, to)], clipId: clip.id, message: `About ${String(shared)} ms of black picture from the footage is used here.` });
    }
    if (footage.sentencesMs === null) {
      if (footage.hasAudio) notChecked.add('cuts inside spoken sentences (no transcript)');
    } else {
      for (const edge of [clip.sourceMs[0], clip.sourceMs[1]]) {
        const cut = footage.sentencesMs.find((sentence) => sentence[0] + SENTENCE_MARGIN_MS < edge && edge < sentence[1] - SENTENCE_MARGIN_MS);
        if (cut !== undefined) {
          const at = toTimeline(clip, edge);
          findings.push({ kind: 'CUT_MID_SENTENCE', severity: 'warning', atMs: [at, at], clipId: clip.id, message: `The ${edge === clip.sourceMs[0] ? 'in' : 'out'} point cuts a spoken sentence (${String(cut[0])}-${String(cut[1])} ms in the footage).` });
        }
      }
    }
    if (footage.hasAudio) {
      const covered = audible.some((other) => overlap(other.atMs, clip.atMs) > 0);
      if (!covered) {
        findings.push({ kind: 'MISSING_SOUND', severity: 'info', atMs: clip.atMs, clipId: clip.id, message: 'This footage has sound but nothing is audible under it; bring its audio or add music if silence is not intended.' });
      }
    }
  }

  for (const clip of audible) {
    const footage = clip.footageId === null ? undefined : input.footage[clip.footageId];
    if (footage === undefined) continue;
    if (footage.silenceMs === null) { notChecked.add('silent stretches (footage not analyzed)'); continue; }
    for (const silence of footage.silenceMs) {
      const shared = overlap(silence, clip.sourceMs);
      if (shared < SILENCE_MIN_MS) continue;
      const from = Math.max(silence[0], clip.sourceMs[0]);
      const to = Math.min(silence[1], clip.sourceMs[1]);
      findings.push({ kind: 'SILENT_STRETCH', severity: 'info', atMs: [toTimeline(clip, from), toTimeline(clip, to)], clipId: clip.id, message: `About ${String(shared)} ms of near-silence from the footage is used here.` });
    }
  }

  // 主视频轨（最下层可见视频轨）上的画面空洞：内容终点之前没有任何可见画面
  const covered = [...visibleVideo].map((clip) => clip.atMs).sort((left, right) => left[0] - right[0]);
  let cursor = 0;
  for (const span of covered) {
    if (span[0] - cursor >= input.frameMs) findings.push({ kind: 'PICTURE_GAP', severity: 'warning', atMs: [cursor, span[0]], clipId: null, message: `No picture for ${String(span[0] - cursor)} ms.` });
    cursor = Math.max(cursor, span[1]);
  }
  if (input.clips.length > 0 && Math.abs(input.lengthMs - contentEndMs) >= input.frameMs) {
    findings.push({
      kind: 'LENGTH_MISMATCH', severity: 'warning', atMs: [Math.min(contentEndMs, input.lengthMs), Math.max(contentEndMs, input.lengthMs)], clipId: null,
      message: input.lengthMs > contentEndMs ? `The video runs ${String(input.lengthMs - contentEndMs)} ms past the last content (empty tail).` : 'Content extends past the video length.',
    });
  }

  // 同一素材的同一段被用了两次
  for (let left = 0; left < visibleVideo.length; left += 1) {
    for (let right = left + 1; right < visibleVideo.length; right += 1) {
      const a = visibleVideo[left]!;
      const b = visibleVideo[right]!;
      if (a.footageId === null || a.footageId !== b.footageId) continue;
      const shared = overlap(a.sourceMs, b.sourceMs);
      const shorter = Math.min(a.sourceMs[1] - a.sourceMs[0], b.sourceMs[1] - b.sourceMs[0]);
      if (shorter > 0 && shared / shorter > 0.5) {
        findings.push({ kind: 'REPEATED_SHOT', severity: 'info', atMs: b.atMs, clipId: b.id, message: `Reuses the same part of the footage as clip ${a.id}.` });
      }
    }
  }

  const durations = visibleVideo.map((clip) => clip.atMs[1] - clip.atMs[0]).sort((left, right) => left - right);
  const median = durations.length === 0 ? 0 : durations.length % 2 === 1
    ? durations[(durations.length - 1) / 2]!
    : Math.round((durations[durations.length / 2 - 1]! + durations[durations.length / 2]!) / 2);
  return {
    findings: findings.sort((left, right) => left.atMs[0] - right.atMs[0]),
    stats: {
      lengthMs: input.lengthMs,
      contentEndMs,
      videoClips: visibleVideo.length,
      shotMs: durations.length === 0 ? null : { min: durations[0]!, median, max: durations.at(-1)! },
      cutsPerMinute: contentEndMs <= 0 || visibleVideo.length < 2 ? null : Math.round(((visibleVideo.length - 1) / (contentEndMs / 60_000)) * 10) / 10,
    },
    notChecked: [...notChecked].sort(),
  };
}
