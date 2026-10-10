import { describe, expect, it } from 'vitest';
import {
  ApiFailure,
  legacyMillisecondsToMediaTime,
  mediaRangeSchema,
  type VoiceCapabilities,
  type VoicePlaybackAnchor,
} from '@ancs/contracts';
import { alignVoiceUtterance, negotiateVoiceSessionCapabilities } from './index.js';

/** N05-02：能力协商 fail-closed 与转写时间对齐精度如实标注。 */

const mt = (ms: number) => legacyMillisecondsToMediaTime(ms);
const toMs = (time: { ticks: string; timebase: { num: number; den: number } }): number => (Number(time.ticks) * time.timebase.num * 1000) / time.timebase.den;

const caps = (overrides: Partial<VoiceCapabilities> = {}): VoiceCapabilities => ({
  transport: 'SERVER_RELAY',
  supported: ['STREAMING_PARTIALS', 'SERVER_VAD', 'WORD_TIMESTAMPS', 'BARGE_IN', 'SERVER_SIDE_TOOLS'],
  unsupported: [],
  ...overrides,
});

const playingAnchor = (): VoicePlaybackAnchor => ({ monotonicMs: 100_000, sequenceTime: mt(5_000), state: 'PLAYING' });
const clockSamples = [
  { audioContextTimeMs: 0, monotonicMs: 100_000 },
  { audioContextTimeMs: 2_000, monotonicMs: 102_000 },
];

describe('N05-02 能力协商（fail-closed）', () => {
  it('按偏好传输选择；请求已声明支持的能力通过', () => {
    const result = negotiateVoiceSessionCapabilities([caps()], { preferredTransport: 'SERVER_RELAY', required: ['SERVER_VAD', 'WORD_TIMESTAMPS'] });
    expect(result.capabilities.transport).toBe('SERVER_RELAY');
    expect(result.unsupported).toEqual([]);
  });

  it('请求声明不支持的能力 → 501（不把未知能力当支持）', () => {
    const fallback = caps({ transport: 'BROWSER_SPEECH_FALLBACK', supported: ['STREAMING_PARTIALS'], unsupported: ['SERVER_VAD', 'WORD_TIMESTAMPS', 'BARGE_IN', 'SERVER_SIDE_TOOLS'] });
    let caught: unknown;
    try {
      negotiateVoiceSessionCapabilities([fallback], { preferredTransport: 'BROWSER_SPEECH_FALLBACK', required: ['WORD_TIMESTAMPS'] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiFailure);
    expect((caught as ApiFailure).httpStatus).toBe(501);
    expect((caught as ApiFailure).details['unsupported']).toEqual(['WORD_TIMESTAMPS']);
  });

  it('没有匹配传输的适配器 → 501', () => {
    expect(() => negotiateVoiceSessionCapabilities([caps()], { preferredTransport: 'PROVIDER_SIDEBAND' })).toThrow(ApiFailure);
  });
});

describe('N05-02 转写时间对齐（精度如实标注）', () => {
  it('有音频位置 + 时钟 + 播放锚点 → AUDIO_RANGE，并按发话快照给出漂移诊断', () => {
    const alignment = alignVoiceUtterance({
      utteranceId: 'utt_1',
      transcriptRevision: 2,
      audioRange: mediaRangeSchema.parse({ start: mt(500), end: mt(1_500) }),
      wordTimingAvailable: false,
      clockSamples,
      playbackAnchors: [playingAnchor()],
      utteranceSequenceTime: mt(5_400),
    });
    expect(alignment.accuracy).toBe('AUDIO_RANGE');
    expect(alignment.sequenceRange).not.toBeNull();
    expect(toMs(alignment.sequenceRange!.start)).toBeCloseTo(5_500, 3);
    expect(toMs(alignment.sequenceRange!.end)).toBeCloseTo(6_500, 3);
    expect(alignment.driftMs).toBeCloseTo(100, 3);
  });

  it('供应商提供可验证词级时间 → WORD_EXACT', () => {
    const alignment = alignVoiceUtterance({
      utteranceId: 'utt_2', transcriptRevision: 1,
      audioRange: mediaRangeSchema.parse({ start: mt(500), end: mt(1_500) }),
      wordTimingAvailable: true, clockSamples, playbackAnchors: [playingAnchor()],
    });
    expect(alignment.accuracy).toBe('WORD_EXACT');
  });

  it('暂停播放或缺少音频位置 → 退到发话快照 UTTERANCE_SNAPSHOT（不猜区间）', () => {
    const paused: VoicePlaybackAnchor = { monotonicMs: 100_000, sequenceTime: mt(5_000), state: 'PAUSED' };
    const pausedAlignment = alignVoiceUtterance({
      utteranceId: 'utt_3', transcriptRevision: 1,
      audioRange: mediaRangeSchema.parse({ start: mt(500), end: mt(1_500) }),
      wordTimingAvailable: false, clockSamples, playbackAnchors: [paused], utteranceSequenceTime: mt(7_000),
    });
    expect(pausedAlignment.accuracy).toBe('UTTERANCE_SNAPSHOT');
    expect(pausedAlignment.sequenceRange).toBeNull();
    expect(pausedAlignment.sequencePoint).toMatchObject({ ticks: '7000' });

    const noAudio = alignVoiceUtterance({
      utteranceId: 'utt_4', transcriptRevision: 1, audioRange: null,
      wordTimingAvailable: false, clockSamples, playbackAnchors: [playingAnchor()], utteranceSequenceTime: mt(7_000),
    });
    expect(noAudio.accuracy).toBe('UTTERANCE_SNAPSHOT');
  });

  it('既无音频位置也无发话快照 → UNAVAILABLE（绝不伪造精确定位）', () => {
    const alignment = alignVoiceUtterance({
      utteranceId: 'utt_5', transcriptRevision: 1, audioRange: null,
      wordTimingAvailable: false, clockSamples: [], playbackAnchors: [],
    });
    expect(alignment.accuracy).toBe('UNAVAILABLE');
    expect(alignment.sequenceRange).toBeNull();
    expect(alignment.sequencePoint).toBeNull();
  });
});
