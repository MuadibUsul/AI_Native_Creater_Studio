import { describe, expect, it } from 'vitest';
import { ApiFailure, ERROR_CODES, type PackManifest } from '@ancs/contracts';
import { createBuiltInRegistry, ExtensionRegistry } from './index.js';

const testPack: PackManifest = {
  manifestVersion: '1.0',
  packId: 'test.pack.alpha',
  name: '测试 Pack',
  version: '0.1.0',
  capabilities: ['read_content_core', 'create_assets'],
  compatibility: { coreRange: '>=0.1.0 <1.0.0', sceneGraphSchemaVersion: '0.1' },
  defaultChannelKey: null,
  outputFormats: ['alpha_1x1', 'alpha_4x5'],
  quota: null,
  signature: null,
};

describe('ExtensionRegistry（§92.3）', () => {
  it('注册与列举：Pack 与输出格式并集（去重排序）', () => {
    const registry = new ExtensionRegistry();
    registry.registerPack(testPack);
    expect(registry.listPacks().map((p) => p.packId)).toEqual(['test.pack.alpha']);
    expect(registry.outputFormats()).toEqual(['alpha_1x1', 'alpha_4x5']);
    expect(registry.hasCapability('read_content_core')).toBe(true);
    expect(registry.hasCapability('network_access')).toBe(false);
  });

  it('重复注册同一 Pack → 409 ALREADY_EXISTS（生命周期属 P16-03）', () => {
    const registry = new ExtensionRegistry();
    registry.registerPack(testPack);
    expect(() => registry.registerPack(testPack)).toThrowError(ApiFailure);
    try {
      registry.registerPack(testPack);
    } catch (error) {
      expect(error).toMatchObject({ code: ERROR_CODES.ALREADY_EXISTS, httpStatus: 409 });
    }
  });

  it('非法清单被拒（packId 非反向域名式）', () => {
    const registry = new ExtensionRegistry();
    expect(() => registry.registerPack({ ...testPack, packId: 'NotValid' })).toThrowError();
    expect(registry.listPacks()).toEqual([]);
  });

  it('未安装能力明确返回不支持：requireOutputFormat → CAPABILITY_UNAVAILABLE / 501', () => {
    const registry = new ExtensionRegistry();
    registry.registerPack(testPack);

    expect(() => registry.requireOutputFormat('alpha_1x1')).not.toThrowError();

    try {
      registry.requireOutputFormat('shorts_9x16');
      throw new Error('应当抛出');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiFailure);
      expect(error).toMatchObject({ code: ERROR_CODES.CAPABILITY_UNAVAILABLE, httpStatus: 501 });
      expect((error as ApiFailure).details['outputFormat']).toBe('shorts_9x16');
    }
  });

  it('availability：装了返回 true，未装返回 false + 原因', () => {
    const registry = new ExtensionRegistry();
    registry.registerPack(testPack);
    expect(registry.availability('alpha_4x5')).toEqual({ format: 'alpha_4x5', available: true, reason: null });
    expect(registry.availability('carousel')).toMatchObject({ available: false });
    expect(registry.availability('carousel').reason).toContain('未安装');
  });

  it('内置注册表为空（诚实反映"未安装官方 Pack"）且 snapshot 通过契约校验', () => {
    const registry = createBuiltInRegistry();
    const snapshot = registry.snapshot();
    expect(snapshot.packs).toEqual([]);
    expect(snapshot.distributionProviders).toEqual([]);
    expect(snapshot.outputFormats).toEqual([]);
  });

  it('分发 Provider 注册与重复防护', () => {
    const registry = new ExtensionRegistry();
    registry.registerDistributionProvider({
      providerId: 'test-youtube',
      capabilities: { tier: 'P1_DIRECT_PUBLISH', capabilities: ['DIRECT_PUBLISH', 'SCHEDULING'], notes: null },
    });
    expect(registry.listDistributionProviders().map((p) => p.providerId)).toEqual(['test-youtube']);
    expect(() =>
      registry.registerDistributionProvider({
        providerId: 'test-youtube',
        capabilities: { tier: 'P4_EXPORT_PACKAGE', capabilities: [], notes: null },
      }),
    ).toThrowError(ApiFailure);
  });
});
