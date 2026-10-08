import { describe, expect, it } from 'vitest';
import { MEDIA_INDEX_PROCESSOR_VERSION, generatedMediaIndexSchema, mediaIndexPageSchema } from './media-index.js';

describe('N02-04 media index contracts', () => {
  const entry = {
    kind: 'SHOT' as const,
    ordinal: 0,
    sourceStartPts: '0',
    sourceEndPts: '15360',
    timeBase: { numerator: 1, denominator: 15360 },
    confidencePermille: 700,
    payload: { sourceStartMs: 0, sourceEndMs: 1000, detectionBasis: 'FFMPEG_SCENE_SCORE_GT_0_3' },
    localFilename: null,
  };

  it('accepts exact source-time entries and rejects malformed ranges or extra fields', () => {
    expect(generatedMediaIndexSchema.parse({ schemaVersion: '1.0', processorVersion: MEDIA_INDEX_PROCESSOR_VERSION, durationMs: 1000, entries: [entry] }).entries[0]).toEqual(entry);
    expect(() => generatedMediaIndexSchema.parse({ schemaVersion: '1.0', processorVersion: MEDIA_INDEX_PROCESSOR_VERSION, durationMs: 1000, entries: [{ ...entry, sourceStartPts: '1.5' }] })).toThrow();
    expect(() => mediaIndexPageSchema.parse({ runId: 'mix_1', sourceAssetVersionId: 'av_1', processorVersion: MEDIA_INDEX_PROCESSOR_VERSION, status: 'READY', coveragePermille: 1000, checkpointMs: 1000, errorSummary: null, items: [{ ...entry, previewUrl: null, previewExpiresAt: null, storageKey: 'secret/path' }], nextCursor: null })).toThrow();
  });
});
