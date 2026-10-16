import { describe, expect, it } from 'vitest';
import { reviewTimeline, type ReviewClip, type ReviewFootage, type ReviewInput } from './agent-review.js';

/**
 * V6 §6.4 通用自检规则（纯函数）：黑场、静音、闪帧、画面空洞、长度不符、句中剪断、画面无声、重复用同一段；
 * 缺分析层时如实列为"无法检查"。
 */

const tracks: ReviewInput['tracks'] = [
  { id: 'v1', kind: 'VIDEO', position: 0, hidden: false, muted: false },
  { id: 'a1', kind: 'AUDIO', position: 1, hidden: false, muted: false },
];
const clip = (id: string, trackId: string, footageId: string, sourceMs: [number, number], atMs: [number, number]): ReviewClip => ({ id, trackId, footageId, sourceMs, atMs, linkedClipIds: [] });
const analyzed = (overrides: Partial<ReviewFootage> = {}): ReviewFootage => ({ hasAudio: true, blackMs: [], silenceMs: [], sentencesMs: [], ...overrides });
const kinds = (input: ReviewInput) => reviewTimeline(input).findings.map((finding) => [finding.kind, finding.atMs, finding.clipId]);

describe('AI 自检（通用质量规则）', () => {
  it('干净的草稿没有发现；统计镜头时长与剪切频率', () => {
    const result = reviewTimeline({
      lengthMs: 9000, frameMs: 33, tracks,
      clips: [
        clip('c1', 'v1', 'f1', [500, 3500], [0, 3000]), clip('c1a', 'a1', 'f1', [500, 3500], [0, 3000]),
        clip('c2', 'v1', 'f2', [500, 3500], [3000, 6000]), clip('c2a', 'a1', 'f2', [500, 3500], [3000, 6000]),
        clip('c3', 'v1', 'f3', [1000, 4000], [6000, 9000]), clip('c3a', 'a1', 'f3', [1000, 4000], [6000, 9000]),
      ],
      footage: { f1: analyzed(), f2: analyzed(), f3: analyzed() },
    });
    expect(result.findings).toEqual([]);
    expect(result.notChecked).toEqual([]);
    expect(result.stats).toEqual({ lengthMs: 9000, contentEndMs: 9000, videoClips: 3, shotMs: { min: 3000, median: 3000, max: 3000 }, cutsPerMinute: 13.3 });
  });

  it('黑场与静音按源时间映射到时间线；静音只算提示', () => {
    expect(kinds({
      lengthMs: 4000, frameMs: 33, tracks,
      clips: [clip('c1', 'v1', 'f1', [1000, 5000], [0, 4000]), clip('c1a', 'a1', 'f1', [1000, 5000], [0, 4000])],
      footage: { f1: analyzed({ blackMs: [[4000, 6000]], silenceMs: [[1500, 3000]] }) },
    })).toEqual([
      ['SILENT_STRETCH', [500, 2000], 'c1a'],
      ['BLACK_STRETCH', [3000, 4000], 'c1'],
    ]);
  });

  it('闪帧、画面空洞、空尾巴、重复用同一段、画面没有声音', () => {
    const result = reviewTimeline({
      lengthMs: 8000, frameMs: 33, tracks,
      clips: [
        clip('c1', 'v1', 'f1', [0, 2000], [0, 2000]),
        clip('c2', 'v1', 'f1', [500, 2500], [2500, 4500]),
        clip('c3', 'v1', 'f2', [0, 100], [4500, 4600]),
      ],
      footage: { f1: analyzed(), f2: analyzed({ hasAudio: false }) },
    });
    expect(result.findings.map((finding) => finding.kind)).toEqual(['MISSING_SOUND', 'PICTURE_GAP', 'MISSING_SOUND', 'REPEATED_SHOT', 'FLASH_CLIP', 'LENGTH_MISMATCH']);
    expect(result.findings.find((finding) => finding.kind === 'PICTURE_GAP')?.atMs).toEqual([2000, 2500]);
    expect(result.findings.find((finding) => finding.kind === 'LENGTH_MISMATCH')?.message).toContain('3400 ms past the last content');
  });

  it('句中剪断：入点或出点落在一句话中间（两侧都留 300 ms 以上）', () => {
    const result = reviewTimeline({
      lengthMs: 3000, frameMs: 33, tracks,
      clips: [clip('c1', 'v1', 'f1', [2000, 5000], [0, 3000]), clip('c1a', 'a1', 'f1', [2000, 5000], [0, 3000])],
      footage: { f1: analyzed({ sentencesMs: [[1000, 4000], [4200, 4900]] }) },
    });
    expect(result.findings.map((finding) => [finding.kind, finding.atMs])).toEqual([['CUT_MID_SENTENCE', [0, 0]]]);
  });

  it('缺分析层：列为无法检查，不伪造结论', () => {
    const result = reviewTimeline({
      lengthMs: 2000, frameMs: 33, tracks,
      clips: [clip('c1', 'v1', 'f1', [0, 2000], [0, 2000]), clip('c1a', 'a1', 'f1', [0, 2000], [0, 2000])],
      footage: { f1: { hasAudio: true, blackMs: null, silenceMs: null, sentencesMs: null } },
    });
    expect(result.findings).toEqual([]);
    expect(result.notChecked).toEqual(['black frames (footage not analyzed)', 'cuts inside spoken sentences (no transcript)', 'silent stretches (footage not analyzed)']);
  });

  it('空时间线', () => {
    expect(kinds({ lengthMs: 1000, frameMs: 33, tracks, clips: [], footage: {} })).toEqual([['EMPTY_TIMELINE', [0, 1000], null]]);
  });
});
