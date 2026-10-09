import { describe, expect, it } from 'vitest';
import { safeProviderErrorCategory } from './security-ops.js';

describe('N15-03 Provider status safe projection', () => {
  it('returns only fixed categories and never copies untrusted error text', () => {
    const canary = 'private-signing-key-canary'; // secrets:check-ignore: non-secret test canary
    expect(safeProviderErrorCategory({ code: 'PROVIDER_FAILED', message: canary })).toBe('PROVIDER_FAILED');
    expect(safeProviderErrorCategory({ category: 'RESULT_URL_EXPIRED', url: `https://user:${canary}@example.test` })).toBe('RESULT_URL_EXPIRED');
    expect(safeProviderErrorCategory({ message: canary })).toBe('OTHER');
    expect(safeProviderErrorCategory({ code: canary })).toBe('OTHER');
    expect(safeProviderErrorCategory(canary)).toBe('OTHER');
    expect(safeProviderErrorCategory(null)).toBeNull();
  });
});
