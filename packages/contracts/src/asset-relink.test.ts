import { describe, expect, it } from 'vitest';
import {
  applyAssetRelinkRequestSchema,
  assetRelinkComparisonSchema,
  assetRelinkStateSchema,
} from './assets.js';

describe('N02-08 asset relink contracts', () => {
  it('accepts explicit comparison/state without exposing storage keys', () => {
    const state = assetRelinkStateSchema.parse({
      assetId: 'ast_1',
      versions: [{ assetVersionId: 'av_1', versionNumber: 1, current: true, availability: 'MISSING', checksumSha256: 'a'.repeat(64), durationMs: 5_000, tracks: [], activeClipReferences: 2 }],
    });
    const comparison = assetRelinkComparisonSchema.parse({
      mode: 'REPLACEMENT', targetVersionId: 'av_1', candidateAssetId: 'ast_2', candidateVersionId: 'av_2', candidateChecksumSha256: 'b'.repeat(64), checksumMatches: false,
      duration: { targetMs: 5_000, candidateMs: 5_100, deltaMs: 100, matches: false },
      tracks: { target: [], candidate: [], matches: true }, activeClipReferences: 2, affectedProjectIds: ['prj_1'], confirmationText: '确认替换', reviewRequired: true,
    });
    expect(JSON.stringify({ state, comparison })).not.toContain('storageKey');
  });

  it('requires a bounded confirmation phrase and candidate checksum', () => {
    expect(applyAssetRelinkRequestSchema.parse({ targetVersionId: 'av_1', candidateAssetId: 'ast_2', expectedCandidateChecksumSha256: 'b'.repeat(64), confirmationText: '确认替换' })).toBeTruthy();
    expect(() => applyAssetRelinkRequestSchema.parse({ targetVersionId: 'av_1', candidateAssetId: 'ast_2', expectedCandidateChecksumSha256: 'bad', confirmationText: '确认' })).toThrow();
  });
});
