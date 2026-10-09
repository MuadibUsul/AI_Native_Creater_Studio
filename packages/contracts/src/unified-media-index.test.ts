import { describe, expect, it } from 'vitest';
import {
  UNIFIED_MEDIA_INDEX_KINDS,
  mediaIndexRecordSchema,
  unifiedMediaIndexPageSchema,
  unifiedMediaIndexQuerySchema,
} from './unified-media-index.js';

const base = {
  id: 'umi_1',
  workspaceId: 'ws_1',
  sourceAssetVersionId: 'av_1',
  streamId: 'video:0',
  sourceRange: { startPts: '0', endPts: '1000', timeBase: { numerator: 1, denominator: 1000 } },
  payloadSchemaVersion: '1.0',
  evidenceRefs: [{ type: 'SOURCE_RANGE', refId: 'av_1:0-1000', sourceRange: { startPts: '0', endPts: '1000', timeBase: { numerator: 1, denominator: 1000 } } }],
  observedBy: 'ffmpeg-source-media-indexer',
  observedAt: '2026-10-09T00:00:00.000Z',
  basis: 'MEASURED',
  confidenceValue: 1,
  confidenceMethod: null,
  calibrationStatus: 'NOT_APPLICABLE',
  toolId: 'ffmpeg',
  toolVersion: 'source-index-v1',
  modelVersion: null,
  analysisConfigHash: 'a'.repeat(64),
  indexVersion: 1,
  supersedesRecordId: null,
  correctionRecordId: null,
  privacyClass: 'WORKSPACE',
  accessPolicyRef: 'workspace:read',
  lifecycleState: 'ACTIVE',
} as const;

describe('unified media index contracts', () => {
  it('accepts category-specific measured and inferred records', () => {
    expect(mediaIndexRecordSchema.parse({ ...base, kind: 'THUMBNAIL', payload: { sourceStartMs: 0, sourceEndMs: 1000 } })).toBeDefined();
    expect(mediaIndexRecordSchema.parse({ ...base, id: 'umi_2', streamId: 'audio:1', kind: 'TRANSCRIPT_SEGMENT', basis: 'MODEL_INFERRED', confidenceValue: 0.92, confidenceMethod: 'ASR_PROVIDER_CONFIDENCE', calibrationStatus: 'UNCALIBRATED', payload: { text: '你好', speakerId: null, language: 'zh-CN', reviewState: 'UNREVIEWED' } })).toBeDefined();
  });

  it('rejects payloads from another category and storage secrets', () => {
    expect(mediaIndexRecordSchema.safeParse({ ...base, kind: 'THUMBNAIL', payload: { text: 'wrong' } }).success).toBe(false);
    expect(mediaIndexRecordSchema.safeParse({ ...base, kind: 'THUMBNAIL', payload: { sourceStartMs: 0, sourceEndMs: 1000 }, storageKey: 'private/object.mp4' }).success).toBe(false);
  });

  it('requires a complete positive source-range query', () => {
    expect(unifiedMediaIndexQuerySchema.safeParse({ sourceStartPts: '0' }).success).toBe(false);
    expect(unifiedMediaIndexQuerySchema.safeParse({ sourceStartPts: '10', sourceEndPts: '10', timeBaseNumerator: 1, timeBaseDenominator: 1000 }).success).toBe(false);
    expect(unifiedMediaIndexQuerySchema.parse({ sourceStartPts: '0', sourceEndPts: '10', timeBaseNumerator: '1', timeBaseDenominator: '1000' })).toMatchObject({ limit: 50, timeBaseNumerator: 1, timeBaseDenominator: 1000 });
  });

  it('requires one explicit capability row for every category', () => {
    const capabilities = UNIFIED_MEDIA_INDEX_KINDS.map((kind) => ({ kind, supported: false, status: 'UNSUPPORTED', coveragePermille: 0, recordCount: 0, errorSummary: null, toolId: null, toolVersion: null, modelVersion: null }));
    expect(unifiedMediaIndexPageSchema.safeParse({ sourceAssetVersionId: 'av_1', indexVersion: 1, capabilities, items: [], nextCursor: null }).success).toBe(true);
    expect(unifiedMediaIndexPageSchema.safeParse({ sourceAssetVersionId: 'av_1', indexVersion: 1, capabilities: capabilities.slice(1), items: [], nextCursor: null }).success).toBe(false);
    expect(unifiedMediaIndexPageSchema.safeParse({ sourceAssetVersionId: 'av_1', indexVersion: 1, capabilities: capabilities.map((row) => ({ ...row, kind: 'THUMBNAIL' })), items: [], nextCursor: null }).success).toBe(false);
  });
});
