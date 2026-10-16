import { describe, expect, it } from 'vitest';
import { checkProviderInventory, type ProviderInventoryEntry } from './provider-kind.js';

/** V5-M3：生产进程不得静默装配 Mock/脚本化驱动（代码审查 R-5）。 */
describe('checkProviderInventory：生产装配守卫', () => {
  const inventory: ProviderInventoryEntry[] = [
    { capability: 'llm', driver: 'mock', implementation: 'MOCK' },
    { capability: 'asr', driver: 'deepgram', implementation: 'REAL' },
    { capability: 'distribution', driver: 'scripted', implementation: 'SCRIPTED' },
  ];

  it('生产 + 非真实驱动 + 未显式许可 → 一条问题，列出全部非真实驱动', () => {
    const issues = checkProviderInventory({ NODE_ENV: 'production' }, inventory);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.variable).toBe('ANCS_ALLOW_MOCK_PROVIDERS');
    expect(issues[0]?.message).toContain('llm=mock:MOCK');
    expect(issues[0]?.message).toContain('distribution=scripted:SCRIPTED');
    expect(issues[0]?.message).not.toContain('deepgram');
  });

  it('显式许可、非生产或全部真实 → 通过', () => {
    expect(checkProviderInventory({ NODE_ENV: 'production', ANCS_ALLOW_MOCK_PROVIDERS: '1' }, inventory)).toEqual([]);
    expect(checkProviderInventory({ NODE_ENV: 'development' }, inventory)).toEqual([]);
    expect(checkProviderInventory({}, inventory)).toEqual([]);
    expect(checkProviderInventory({ NODE_ENV: 'production', ANCS_ALLOW_MOCK_PROVIDERS: '0' }, [inventory[1]!])).toEqual([]);
  });
});
