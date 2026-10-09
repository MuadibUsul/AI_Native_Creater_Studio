import { describe, expect, it } from 'vitest';
import { MEDIA_ANALYSIS_STAGES, mediaAnalysisGraphSchema, rebuildMediaAnalysisStageRequestSchema } from './media-analysis.js';

const stages = MEDIA_ANALYSIS_STAGES.map((stage) => ({
  id: `mas_${stage}`, stage, dependencies: stage === 'PROBE' ? [] : ['PROBE'], status: stage === 'PROBE' ? 'READY' : 'DISABLED',
  coveragePermille: stage === 'PROBE' ? 1000 : 0, checkpoint: { cursor: stage === 'PROBE' ? '2000' : null, completedUnits: stage === 'PROBE' ? 2000 : 0, totalUnits: 2000 },
  detectorConfigHash: 'a'.repeat(64), inputFingerprint: 'b'.repeat(64), jobId: null, budgetMicros: null, spentMicros: 0, errorSummary: null, reusable: stage === 'PROBE', updatedAt: '2026-10-09T00:00:00.000Z',
}));

describe('media analysis graph contracts', () => {
  it('requires every stage exactly once with explicit disabled and checkpoint states', () => {
    expect(mediaAnalysisGraphSchema.safeParse({ assetId: 'ast_1', sourceAssetVersionId: 'av_1', playable: true, deterministicEditingReady: true, stages }).success).toBe(true);
    expect(mediaAnalysisGraphSchema.safeParse({ assetId: 'ast_1', sourceAssetVersionId: 'av_1', playable: true, deterministicEditingReady: true, stages: stages.map((row) => ({ ...row, stage: 'PROBE' })) }).success).toBe(false);
  });

  it('rejects unchecked checkpoints and invalid detector hashes', () => {
    expect(mediaAnalysisGraphSchema.safeParse({ assetId: 'ast_1', sourceAssetVersionId: 'av_1', playable: true, deterministicEditingReady: true, stages: stages.map((row, index) => index === 0 ? { ...row, checkpoint: { ...row.checkpoint, arbitrary: true } } : row) }).success).toBe(false);
    expect(rebuildMediaAnalysisStageRequestSchema.safeParse({ detectorConfigHash: 'short' }).success).toBe(false);
  });
});
