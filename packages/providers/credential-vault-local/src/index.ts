import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { encryptedSecretSchema, type CredentialCipher, type EncryptedSecret } from '@ancs/contracts';

/**
 * 本地凭据保险库（P03-04）：AES-256-GCM envelope encryption。
 *
 * 用途与边界（诚实记录）：
 * - 开发/测试与单机部署的**真实**加密实现（真实密钥、真实 GCM 认证标签、真实轮换）；
 * - 生产应使用云 KMS（AWS KMS / GCP KMS）做密钥托管——适配器接口相同（CredentialCipher），
 *   属真实凭据阶段（§13.5 第 8 条）；
 * - 密钥来自环境变量 `ANCS_CREDENTIAL_KEYS`（形如 `v1:<base64 32 字节>,v2:<base64>`）：
 *   新写入使用**最新版本**，解密按密文内的 keyVersion 选择历史密钥（支持轮换）；
 * - 未配置密钥 → 构造即失败（fail-closed；绝不静默降级为明文）；
 * - **任何错误/日志都不包含 Secret 或密钥材料**（错误消息只提及版本与算法）。
 */

const KEY_BYTES = 32;
const NONCE_BYTES = 12;

export interface CredentialVaultOptions {
  /** 形如 'v1:<base64>,v2:<base64>'；最后一个为当前写入版本 */
  keys: string;
}

export function parseCredentialKeys(raw: string): Map<string, Buffer> {
  const keys = new Map<string, Buffer>();
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (trimmed === '') continue;
    const separator = trimmed.indexOf(':');
    if (separator <= 0) throw new Error('ANCS_CREDENTIAL_KEYS 格式错误（期望 vN:<base64>）');
    const version = trimmed.slice(0, separator);
    const base64 = trimmed.slice(separator + 1);
    if (!/^v\d+$/.test(version)) throw new Error(`凭据密钥版本号非法（期望 vN，实际 ${version}）`);
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length !== KEY_BYTES) {
      throw new Error(`凭据密钥 ${version} 长度非法（期望 ${String(KEY_BYTES)} 字节的 base64）`);
    }
    keys.set(version, buffer);
  }
  if (keys.size === 0) throw new Error('ANCS_CREDENTIAL_KEYS 未配置有效密钥（fail-closed）');
  return keys;
}

export class LocalCredentialVault implements CredentialCipher {
  readonly kind = 'local-aes-256-gcm';
  private readonly keys: Map<string, Buffer>;
  private readonly current: string;

  constructor(options: CredentialVaultOptions) {
    this.keys = parseCredentialKeys(options.keys);
    this.current = [...this.keys.keys()].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))).at(-1) ?? 'v1';
  }

  currentKeyVersion(): string {
    return this.current;
  }

  async encrypt(plaintext: string): Promise<EncryptedSecret> {
    if (plaintext.length === 0) throw new Error('拒绝加密空 Secret');
    const key = this.keys.get(this.current);
    if (key === undefined) throw new Error(`当前密钥版本缺失：${this.current}`);
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return encryptedSecretSchema.parse({
      algorithm: 'AES-256-GCM',
      keyVersion: this.current,
      ciphertext: ciphertext.toString('base64'),
      nonce: nonce.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
    });
  }

  async decrypt(encrypted: EncryptedSecret): Promise<string> {
    const parsed = encryptedSecretSchema.parse(encrypted);
    const key = this.keys.get(parsed.keyVersion);
    if (key === undefined) {
      throw new Error(`凭据密钥版本 ${parsed.keyVersion} 不可用（请提供历史密钥以解密）`);
    }
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parsed.nonce, 'base64'));
    decipher.setAuthTag(Buffer.from(parsed.authTag, 'base64'));
    // GCM 认证失败（篡改/密钥不符）会在此抛错——错误信息不含任何 Secret 内容
    const plaintext = Buffer.concat([decipher.update(Buffer.from(parsed.ciphertext, 'base64')), decipher.final()]);
    return plaintext.toString('utf8');
  }

  /** 展示用掩码（UI 只显示它；§17.3） */
  static maskToken(secret: string): string {
    const tail = secret.slice(-4);
    return `••••${tail}`;
  }
}

/** API/Worker 共用的环境装配；显式密钥优先，否则从服务端主密钥做用途隔离派生。 */
export function createCredentialVaultFromEnv(env: NodeJS.ProcessEnv = process.env): LocalCredentialVault {
  const configured = env['ANCS_CREDENTIAL_KEYS'] ?? '';
  const baseSecret = env['BETTER_AUTH_SECRET'];
  const keys =
    configured.trim() !== ''
      ? configured
      : baseSecret !== undefined && baseSecret.length >= 16
        ? `v1:${createHmac('sha256', baseSecret).update('credential-vault-v1').digest('base64')}`
        : '';
  if (keys === '') {
    throw new Error('启动失败：ANCS_CREDENTIAL_KEYS（或 BETTER_AUTH_SECRET 派生）未配置——凭据保险库 fail-closed');
  }
  return new LocalCredentialVault({ keys });
}
