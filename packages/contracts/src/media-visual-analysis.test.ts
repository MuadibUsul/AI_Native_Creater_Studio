import { describe, expect, it } from 'vitest';
import { MEDIA_VISUAL_ANALYSIS_PROCESSOR_VERSION, generatedMediaVisualAnalysisSchema, mediaIndexRecordSchema } from './index.js';

const anchor = { sourceStartPts: '100', sourceEndPts: '900', timeBase: { numerator: 1, denominator: 1000 } };
const evidenceFrames = [{ pts: '120', timeBase: { numerator: 1, denominator: 1000 }, frameRef: 'frame:120' }];
const keyframes = [{ pts: '120', box: [0.1, 0.1, 0.2, 0.4], state: 'VISIBLE', confidencePermille: 900 }];

describe('N02-12 visual analysis contracts', () => {
  it('accepts anonymous tracks, occlusion state, evidence frames and action candidates', () => {
    const parsed = generatedMediaVisualAnalysisSchema.parse({
      schemaVersion: '1.0', processorVersion: MEDIA_VISUAL_ANALYSIS_PROCESSOR_VERSION, adapter: 'fixture', modelVersion: 'fixture-v1', sampledFrameCount: 8, durationMs: 2000,
      objectTracks: [{ id: 'phone-1', label: '手机', confidencePermille: 880, lifecycle: 'CONTINUOUS', keyframes, evidenceFrames, ...anchor }],
      personTracks: [{ id: 'person-1', label: 'person', identityState: 'UNKNOWN', confidencePermille: 760, lifecycle: 'OCCLUDED', keyframes: [...keyframes, { ...keyframes[0], pts: '800', state: 'UNCERTAIN', confidencePermille: 430 }], evidenceFrames, ...anchor }],
      actionEvents: [{ id: 'action-1', label: '举起手机', subjectTrackId: 'person-1', confidencePermille: 820, evidenceFrames, ...anchor }],
      visualEvents: [], motionIntensity: [{ id: 'motion-1', valuePermille: 640, method: 'optical-flow-v1', evidenceFrames, ...anchor }],
    });
    expect(parsed.personTracks[0]).toMatchObject({ identityState: 'UNKNOWN', lifecycle: 'OCCLUDED', keyframes: expect.arrayContaining([expect.objectContaining({ state: 'UNCERTAIN' })]) });
  });

  it('rejects inferred names and requires unknown identity for machine person tracks', () => {
    const base = { id: 'person-1', label: 'person', confidencePermille: 800, lifecycle: 'CONTINUOUS', keyframes, evidenceFrames, ...anchor };
    const result = generatedMediaVisualAnalysisSchema.safeParse({ schemaVersion: '1.0', processorVersion: MEDIA_VISUAL_ANALYSIS_PROCESSOR_VERSION, adapter: 'fixture', modelVersion: 'fixture-v1', sampledFrameCount: 1, durationMs: 1000, objectTracks: [], personTracks: [{ ...base, identityState: 'INFERRED', displayName: '张三' }], actionEvents: [], visualEvents: [], motionIntensity: [] });
    expect(result.success).toBe(false);
  });

  it('keeps person records anonymous in the unified index payload', () => {
    const record = mediaIndexRecordSchema.parse({
      id: 'mie_person', workspaceId: 'ws_1', sourceAssetVersionId: 'av_1', streamId: 'video:0', sourceRange: { startPts: '100', endPts: '900', timeBase: { numerator: 1, denominator: 1000 } },
      kind: 'PERSON_TRACK', payloadSchemaVersion: '1.0', payload: { label: 'person', trackId: 'person-1', identityState: 'UNKNOWN', lifecycle: 'OCCLUDED', regionKeyframes: keyframes },
      evidenceRefs: [{ type: 'FRAME', refId: 'frame:120', sourceRange: null }], observedBy: 'fixture', observedAt: '2026-10-09T00:00:00.000Z', basis: 'MODEL_INFERRED', confidenceValue: 0.8,
      confidenceMethod: 'fixture', calibrationStatus: 'UNCALIBRATED', toolId: 'fixture', toolVersion: '1', modelVersion: 'fixture-v1', analysisConfigHash: 'a'.repeat(64), indexVersion: 1,
      supersedesRecordId: null, correctionRecordId: null, privacyClass: 'WORKSPACE', accessPolicyRef: 'workspace:read', lifecycleState: 'ACTIVE',
    });
    expect(record.payload).toMatchObject({ identityState: 'UNKNOWN', lifecycle: 'OCCLUDED' });
  });
});
