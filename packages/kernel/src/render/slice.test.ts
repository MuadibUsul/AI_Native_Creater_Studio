import { describe, expect, it } from 'vitest';
import { legacyMillisecondsToMediaTime, type MediaRange, type RenderPlan, type RenderPlanVideoSegment } from '@ancs/contracts';
import { audioOnlyRenderPlan, renderPlanHash, renderPlanWindows, sliceRenderPlanVideo } from '../index.js';

/** V6-1d：RenderPlan 时间窗切片（改哪里渲染哪里的纯函数基础）。 */

const mt = (ms: number) => legacyMillisecondsToMediaTime(ms);
const range = (start: number, end: number): MediaRange => ({ start: mt(start), end: mt(end) });
const frames = (count: number) => ({ ticks: String(count), timebase: { num: 1, den: 30 } });

const segment = (clipId: string, sequence: [number, number], source: [number, number], sourceVersionId = 'av_a'): RenderPlanVideoSegment => ({
  clipId, sourceVersionId, sourceStreamId: null, sequenceRange: range(...sequence), sourceRange: range(...source),
  timeMapping: { kind: 'LINEAR', rate: { num: 1, den: 1 }, direction: 'FORWARD', preservePitch: true },
  transform: { position: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, rotationDeg: 0, anchor: { x: 0.5, y: 0.5 } },
  crop: { left: 0, top: 0, right: 0, bottom: 0 },
  opacity: 1,
});

function plan(segments: RenderPlanVideoSegment[], extra: Partial<RenderPlan> = {}): RenderPlan {
  const body: Omit<RenderPlan, 'planHash'> = {
    irVersion: 'render-plan/1.0', projectId: 'prj_1', sequenceId: 'seq_1', documentRevision: 7,
    frameRate: { num: 30, den: 1 }, duration: mt(5000),
    sources: [
      { assetVersionId: 'av_a', assetId: 'ast_a', checksumSha256: 'a'.repeat(64), hasAudio: true },
      { assetVersionId: 'av_b', assetId: 'ast_b', checksumSha256: 'b'.repeat(64), hasAudio: false },
    ],
    videoLayers: [{ trackId: 'trk_v1', trackPosition: 0, segments }],
    audio: [{
      kind: 'CLIP_AUDIO', id: 'clp_audio', trackId: 'trk_a1', sourceVersionId: 'av_a', sourceStreamId: null,
      sequenceRange: range(0, 5000), sourceRange: range(10_000, 15_000), channelMapping: null, gainDb: 0, pan: 0, fadeIn: mt(500), fadeOut: mt(0), audible: true,
    }],
    captions: [{ captionId: 'cap_1', trackId: 'trk_c1', sequenceRange: range(0, 1000), text: '你好', languageTag: 'zh-CN', style: { schemaVersion: '1.0', values: {} } }],
    graphicsElementIds: [], animatedTargets: [],
    requirements: ['MULTI_TRACK_COMPOSITE', 'AUDIO_GAIN_FADE_PAN'],
    excludedTrackIds: [], warnings: [],
    ...extra,
  };
  return { ...body, planHash: renderPlanHash(body) };
}

describe('renderPlanWindows', () => {
  it('按帧网格切窗，最后一窗止于成片终点（帧时基）', () => {
    expect(renderPlanWindows(plan([]), 60)).toEqual([
      { start: frames(0), end: frames(60) },
      { start: frames(60), end: frames(120) },
      { start: frames(120), end: frames(150) },
    ]);
    // 非整帧时长：最后一窗止于原始终点
    const odd = renderPlanWindows({ frameRate: { num: 30, den: 1 }, duration: mt(2_010) }, 60);
    expect(odd).toHaveLength(2);
    expect(odd[1]).toEqual({ start: frames(60), end: mt(2_010) });
    expect(() => renderPlanWindows(plan([]), 0)).toThrow(RangeError);
  });
});

describe('sliceRenderPlanVideo', () => {
  it('裁到窗口并平移到 0 起：源范围按映射同步裁切；不含音频与字幕；只列用到的源', () => {
    const full = plan([segment('clp_1', [1000, 3000], [10_000, 12_000]), segment('clp_2', [3000, 5000], [0, 2000], 'av_b')]);
    const slice = sliceRenderPlanVideo(full, { start: frames(60), end: frames(90) });
    expect(slice.duration).toEqual(frames(30));
    expect(slice.audio).toEqual([]);
    expect(slice.captions).toEqual([]);
    expect(slice.requirements).toEqual(['MULTI_TRACK_COMPOSITE']);
    expect(slice.sources.map((source) => source.assetVersionId)).toEqual(['av_a']);
    expect(slice.videoLayers[0]?.segments).toHaveLength(1);
    const [only] = slice.videoLayers[0]!.segments;
    expect(only?.sequenceRange).toEqual({ start: frames(0), end: frames(30) });
    expect(only?.sourceRange).toEqual({ start: mt(11_000), end: mt(12_000) });
    expect(slice.planHash).toBe(renderPlanHash(slice));
  });

  it('窗口外的改动不改变该窗口的哈希；窗口内的改动会改变（缓存复用的依据）', () => {
    const base = plan([segment('clp_1', [0, 2000], [0, 2000]), segment('clp_2', [2000, 5000], [5000, 8000])]);
    const window = { start: frames(0), end: frames(60) };
    const changedLater = plan([segment('clp_1', [0, 2000], [0, 2000]), segment('clp_2', [2000, 5000], [6000, 9000])], { documentRevision: 8 });
    const changedHere = plan([segment('clp_1', [0, 2000], [500, 2500]), segment('clp_2', [2000, 5000], [5000, 8000])]);
    expect(sliceRenderPlanVideo(changedLater, window).planHash).toBe(sliceRenderPlanVideo(base, window).planHash);
    expect(sliceRenderPlanVideo(changedHere, window).planHash).not.toBe(sliceRenderPlanVideo(base, window).planHash);
    // 字幕与音频的改动不影响视频切片
    const captionsOnly = plan([segment('clp_1', [0, 2000], [0, 2000]), segment('clp_2', [2000, 5000], [5000, 8000])], { captions: [] });
    expect(sliceRenderPlanVideo(captionsOnly, window).planHash).toBe(sliceRenderPlanVideo(base, window).planHash);
  });

  it('空窗口（无画面）得到合法的黑场切片', () => {
    const slice = sliceRenderPlanVideo(plan([segment('clp_1', [0, 1000], [0, 1000])]), { start: frames(60), end: frames(120) });
    expect(slice.videoLayers).toEqual([]);
    expect(slice.sources).toEqual([]);
  });
});

describe('audioOnlyRenderPlan', () => {
  it('整条声音、清空画面与字幕；画面改动不改变音频哈希', () => {
    const base = plan([segment('clp_1', [0, 5000], [0, 5000])]);
    const audio = audioOnlyRenderPlan(base);
    expect(audio.videoLayers).toEqual([]);
    expect(audio.captions).toEqual([]);
    expect(audio.audio).toEqual(base.audio);
    expect(audio.requirements).toEqual(['AUDIO_GAIN_FADE_PAN']);
    expect(audio.sources.map((source) => source.assetVersionId)).toEqual(['av_a']);
    expect(audio.duration).toEqual(frames(150));
    const recut = plan([segment('clp_1', [0, 2500], [0, 2500]), segment('clp_9', [2500, 5000], [100, 2600], 'av_b')]);
    expect(audioOnlyRenderPlan(recut).planHash).toBe(audio.planHash);
  });
});
