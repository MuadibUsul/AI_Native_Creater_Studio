import { describe, expect, it } from 'vitest';
import { MEDIA_AUDIO_ANALYSIS_PROCESSOR_VERSION, generatedMediaAudioAnalysisSchema } from './media-audio-analysis.js';

const timeBase = { numerator: 1, denominator: 48_000 };
const evidence = (start: string, end: string) => ({ sourceStartPts: start, sourceEndPts: end, timeBase, windowRef: `audio:${start}-${end}` });
const base = {
  schemaVersion: '1.0' as const,
  processorVersion: MEDIA_AUDIO_ANALYSIS_PROCESSOR_VERSION,
  adapter: 'scripted-test-only',
  modelVersion: 'fixture-audio-v1',
  durationMs: 4_000,
  audioEvents: [{ id: 'music-1', eventType: 'MUSIC' as const, label: '音乐', channel: null, confidencePermille: 900, evidenceWindows: [evidence('48000', '96000')], sourceStartPts: '48000', sourceEndPts: '192000', timeBase, streamIndex: 2 }],
  musicBeats: [
    { id: 'beat-1', musicSegmentId: 'music-1', beatOrdinal: 0, downbeat: true, tempoBpm: 120, channel: null, confidencePermille: 820, evidenceWindows: [evidence('48000', '49000')], sourceStartPts: '48000', sourceEndPts: '49000', timeBase, streamIndex: 2 },
    { id: 'beat-2', musicSegmentId: 'music-1', beatOrdinal: 1, downbeat: false, tempoBpm: 96, channel: null, confidencePermille: 780, evidenceWindows: [evidence('96000', '97000')], sourceStartPts: '96000', sourceEndPts: '97000', timeBase, streamIndex: 2 },
  ],
};

describe('media audio analysis contract', () => {
  it('keeps per-beat tempo, audio stream identity and source evidence', () => {
    const parsed = generatedMediaAudioAnalysisSchema.parse(base);
    expect(parsed.musicBeats.map((beat) => beat.tempoBpm)).toEqual([120, 96]);
    expect(parsed.musicBeats[0]).toMatchObject({ streamIndex: 2, sourceStartPts: '48000', downbeat: true });
  });

  it('allows non-music material to have no beat result', () => {
    expect(generatedMediaAudioAnalysisSchema.parse({ ...base, audioEvents: [{ ...base.audioEvents[0], id: 'ambient-1', eventType: 'AMBIENT', label: '环境声' }], musicBeats: [] }).musicBeats).toEqual([]);
  });

  it('rejects missing evidence, duplicate ids and beats linked to non-music events', () => {
    expect(generatedMediaAudioAnalysisSchema.safeParse({ ...base, audioEvents: [{ ...base.audioEvents[0], evidenceWindows: [] }] }).success).toBe(false);
    expect(generatedMediaAudioAnalysisSchema.safeParse({ ...base, musicBeats: [{ ...base.musicBeats[0], id: 'music-1' }] }).success).toBe(false);
    expect(generatedMediaAudioAnalysisSchema.safeParse({ ...base, audioEvents: [{ ...base.audioEvents[0], eventType: 'AMBIENT' }] }).success).toBe(false);
  });
});
