import { describe, expect, it } from 'vitest';
import { generatedMediaTranscriptSchema, transcriptSpeakerSchema } from './media-transcript.js';

describe('media transcript contracts', () => {
  it('keeps unknown speakers anonymous and marks ASR text as inference', () => {
    expect(() => transcriptSpeakerSchema.parse({ id: 'speaker-1', displayName: '张三', identityState: 'UNKNOWN', confidencePermille: 600 })).toThrow();
    const parsed = generatedMediaTranscriptSchema.parse({
      schemaVersion: '1.0', processorVersion: 'source-transcript-v1', provider: 'scripted', model: 'fixture-v1', language: 'zh-CN',
      speakers: [{ id: 'speaker-1', displayName: null, identityState: 'UNKNOWN', confidencePermille: 600 }], terminology: [],
      words: [{ ordinal: 0, text: '价格是120元', speakerId: 'speaker-1', confidencePermille: 800, sourceStartPts: '0', sourceEndPts: '1000', timeBase: { numerator: 1, denominator: 1000 } }],
      segments: [{ id: 'mts_segment1', ordinal: 0, text: '价格是120元', speakerId: 'speaker-1', wordStartOrdinal: 0, wordEndOrdinal: 0, evidence: 'ASR_INFERENCE', reviewState: 'UNREVIEWED', sourceStartPts: '0', sourceEndPts: '1000', timeBase: { numerator: 1, denominator: 1000 } }],
    });
    expect(parsed.segments[0]?.evidence).toBe('ASR_INFERENCE');
    expect(parsed.speakers[0]?.displayName).toBeNull();
  });
});
