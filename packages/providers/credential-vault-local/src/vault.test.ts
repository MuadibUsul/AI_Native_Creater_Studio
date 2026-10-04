import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encryptedSecretSchema } from '@ancs/contracts';
import { LocalCredentialVault, parseCredentialKeys } from './index.js';

/**
 * 本地凭据保险库（P03-04）：AES-256-GCM envelope encryption 的单元验证。
 * - 加解密往返、篡改检测（GCM 认证失败）、密钥轮换（旧密文仍可解密）、fail-closed、错误不含 Secret。
 */

const key = (): string => randomBytes(32).toString('base64');
const SECRET = 'sk-test-secret-value-1234567890'; // secrets:check-ignore：测试专用假凭据（断言不外泄）

describe('LocalCredentialVault', () => {
  it('加密 → 解密往返；密文封套字段完整；密文不含明文', async () => {
    const vault = new LocalCredentialVault({ keys: `v1:${key()}` });
    const envelope = await vault.encrypt(SECRET);
    expect(envelope.algorithm).toBe('AES-256-GCM');
    expect(envelope.keyVersion).toBe('v1');
    expect(JSON.stringify(envelope)).not.toContain(SECRET);
    expect(await vault.decrypt(envelope)).toBe(SECRET);
    expect(vault.currentKeyVersion()).toBe('v1');
  });

  it('GCM 认证：篡改密文/标签/版本一律解密失败，且错误信息不含 Secret', async () => {
    const vault = new LocalCredentialVault({ keys: `v1:${key()}` });
    const envelope = await vault.encrypt(SECRET);

    const tamperedCiphertext = { ...envelope, ciphertext: Buffer.from(randomBytes(envelope.ciphertext.length)).toString('base64') };
    await expect(vault.decrypt(tamperedCiphertext)).rejects.toThrow();
    const tamperedTag = { ...envelope, authTag: Buffer.from(randomBytes(16)).toString('base64') };
    await expect(vault.decrypt(tamperedTag)).rejects.toThrow();
    const unknownVersion = { ...envelope, keyVersion: 'v9' };
    const failure = await vault.decrypt(unknownVersion).catch((error: unknown) => error);
    expect(String(failure)).toContain('v9');
    expect(String(failure)).not.toContain(SECRET);
  });

  it('密钥轮换：新写入用最新版本；携带旧版本的密文仍可解密（历史密钥保留）', async () => {
    const k1 = key();
    const k2 = key();
    const v1Only = new LocalCredentialVault({ keys: `v1:${k1}` });
    const legacyEnvelope = await v1Only.encrypt(SECRET);

    const rotatedVault = new LocalCredentialVault({ keys: `v1:${k1},v2:${k2}` });
    expect(rotatedVault.currentKeyVersion()).toBe('v2');
    const freshEnvelope = await rotatedVault.encrypt(SECRET);
    expect(freshEnvelope.keyVersion).toBe('v2');
    // 旧密文仍可解密（轮换不破坏已存数据）
    expect(await rotatedVault.decrypt(legacyEnvelope)).toBe(SECRET);
    expect(encryptedSecretSchema.parse(freshEnvelope).keyVersion).toBe('v2');
  });

  it('fail-closed：无密钥/密钥长度非法即构造失败；空 Secret 拒绝加密', async () => {
    expect(() => new LocalCredentialVault({ keys: '' })).toThrow(/fail-closed/);
    expect(() => new LocalCredentialVault({ keys: 'v1:short' })).toThrow(/长度非法/);
    expect(() => parseCredentialKeys('vX:AAAA')).toThrow(/版本号非法/);
    const vault = new LocalCredentialVault({ keys: `v1:${key()}` });
    await expect(vault.encrypt('')).rejects.toThrow(/空 Secret/);
  });
});
