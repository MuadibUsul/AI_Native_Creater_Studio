import { describe, expect, it } from 'vitest';
import { assetLifecycleSchema, updateAssetRightsRequestSchema } from './assets.js';

describe('N02-07 asset lifecycle contracts', () => {
  it('requires an explicit self-owned declaration and validates publish rights', () => {
    const base = {
      type: 'USER_OWNED' as const,
      holder: 'Creator', attribution: null, sourceUrl: null, termsUrl: null, notes: null,
      permittedUses: ['EDIT', 'PUBLISH'] as const,
      expiresAt: null, sensitivityClass: 'INTERNAL' as const,
    };
    expect(updateAssetRightsRequestSchema.safeParse({ ...base, userOwnedDeclared: false }).success).toBe(false);
    expect(updateAssetRightsRequestSchema.parse({ ...base, userOwnedDeclared: true }).permittedUses).toEqual(['EDIT', 'PUBLISH']);
  });

  it('keeps lifecycle responses free of storage keys and signed URLs', () => {
    const lifecycle = assetLifecycleSchema.parse({
      asset: {
        id: 'ast_1', workspaceId: 'ws_1', projectId: null, sceneId: null, assetType: 'USER_UPLOAD', origin: 'USER_UPLOAD', provider: null, providerAssetId: null,
        status: 'READY', retentionClass: 'KEEP_USER_SOURCE', sensitivityClass: 'INTERNAL', privacyDeletionRequestedAt: null,
        license: { type: 'USER_OWNED', confirmedBy: 'usr_1', confirmedAt: '2026-10-09T00:00:00.000Z', userOwnedDeclared: true, permittedUses: ['EDIT', 'PUBLISH'] },
        metadata: {}, currentVersionId: 'av_1', createdAt: '2026-10-09T00:00:00.000Z', updatedAt: '2026-10-09T00:00:00.000Z',
      },
      licenseState: 'ACTIVE', references: [], derivations: [], gcProtected: false, gcProtectionReasons: [],
    });
    const serialized = JSON.stringify(lifecycle);
    expect(serialized).not.toContain('storageKey');
    expect(serialized).not.toContain('signedUrl');
  });
});
