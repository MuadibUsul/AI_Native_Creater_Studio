import { describe, expect, it } from 'vitest';
import { compositionMigrationSchema, projectVersionCompositionProjectionSchema } from '@ancs/contracts';
import { canonicalCompositionJson, compositionDigestSha256 } from './composition-migration.js';

describe('N01-05 composition migration contracts', () => {
  it('canonicalizes recursively and produces a stable digest', () => {
    const left = { z: [{ b: 2, a: 1 }], a: { y: true, x: null } };
    const right = { a: { x: null, y: true }, z: [{ a: 1, b: 2 }] };
    expect(canonicalCompositionJson(left)).toBe(canonicalCompositionJson(right));
    expect(compositionDigestSha256(left)).toBe(compositionDigestSha256(right));
    expect(compositionDigestSha256(left)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects incomplete migration and projection records', () => {
    expect(() => compositionMigrationSchema.parse({ status: 'COMPLETE' })).toThrow();
    expect(() => projectVersionCompositionProjectionSchema.parse({ schemaVersion: '1.0' })).toThrow();
  });
});
