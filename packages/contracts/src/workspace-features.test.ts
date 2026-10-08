import { describe, expect, it } from 'vitest';
import { setWorkspaceFeatureRequestSchema, workspaceFeatureSchema } from './workspace-features.js';

describe('workspace feature contracts', () => {
  const valid = {
    key: 'V04_MEDIA_EDITING',
    label: '素材剪辑',
    description: '纯素材导入、预览与非破坏性剪辑。',
    platforms: ['WEB'],
    minimumCapabilityLevel: 'INTERNAL_VALIDATED',
    releaseGate: 'G0',
    releaseReady: false,
    requestedEnabled: true,
    effectiveState: 'READ_ONLY',
    reason: 'RELEASE_GATE_BLOCKED',
    updatedAt: '2026-10-08T12:00:00.000Z',
  } as const;

  it('accepts a blocked opt-in and rejects unknown keys or contradictory enums', () => {
    expect(workspaceFeatureSchema.parse(valid).effectiveState).toBe('READ_ONLY');
    expect(() => workspaceFeatureSchema.parse({ ...valid, key: 'UNREGISTERED' })).toThrow();
    expect(() => workspaceFeatureSchema.parse({ ...valid, effectiveState: 'READY' })).toThrow();
  });

  it('requires an exact boolean preference payload', () => {
    expect(setWorkspaceFeatureRequestSchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(() => setWorkspaceFeatureRequestSchema.parse({ enabled: 'true' })).toThrow();
    expect(() => setWorkspaceFeatureRequestSchema.parse({ enabled: true, releaseReady: true })).toThrow();
  });
});
