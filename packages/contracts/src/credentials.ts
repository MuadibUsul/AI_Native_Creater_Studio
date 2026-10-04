import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';
import { providerKindSchema } from './providers.js';

/**
 * Provider 凭据与路由契约（P03-04 / 规范 §17.2、§17.3、§75）。
 *
 * 纪律（§17.3 MUST）：
 * - 凭据只在后端使用；**绝不**下发到 Web/Mobile/Desktop 客户端；
 * - KMS / envelope encryption（本地驱动见 providers/credential-vault-local；云 KMS 待真实凭据阶段）；
 * - UI 只显示 **masked token**；日志绝不打印 Secret；
 * - 记录 created_at / last_used_at / revoked_at，且可 rotate；
 * - 决策优先级（§17.2）：Workspace 有该 Provider 的 BYOK → 用 BYOK；否则 Platform Managed；
 *   允许 Workspace 级按 Provider 类别覆盖；Creator Identity 允许在身份级选择（P06-02 接入）。
 */

export const CREDENTIAL_MODES = ['PLATFORM_MANAGED', 'BYOK'] as const;
export const credentialModeSchema = z.enum(CREDENTIAL_MODES);
export type CredentialMode = z.infer<typeof credentialModeSchema>;

/** 选择模式（Workspace/身份级设置）：AUTOMATIC = 有 BYOK 用 BYOK，否则 Managed（§17.2 默认决策） */
export const CREDENTIAL_SELECTION_MODES = ['AUTOMATIC', 'PLATFORM_MANAGED', 'BYOK'] as const;
export const credentialSelectionModeSchema = z.enum(CREDENTIAL_SELECTION_MODES);
export type CredentialSelectionMode = z.infer<typeof credentialSelectionModeSchema>;

export const CONNECTION_STATUSES = ['ACTIVE', 'REVOKED', 'INVALID'] as const;
export const connectionStatusSchema = z.enum(CONNECTION_STATUSES);
export type ConnectionStatus = z.infer<typeof connectionStatusSchema>;

export const CONNECTION_TEST_MODES = ['OFFLINE_VALIDATION', 'LIVE'] as const;
export const connectionTestModeSchema = z.enum(CONNECTION_TEST_MODES);
export type ConnectionTestMode = z.infer<typeof connectionTestModeSchema>;

export const CONNECTION_TEST_STATUSES = ['OK', 'FAILED'] as const;
export const connectionTestStatusSchema = z.enum(CONNECTION_TEST_STATUSES);
export type ConnectionTestStatus = z.infer<typeof connectionTestStatusSchema>;

/**
 * 连接 DTO：**不含任何 Secret 材料**（无密文、无明文、无密钥版本之外的元数据）。
 * `maskedToken` 为展示用提示（如 `••••abcd`），UI 只显示它。
 */
export const providerConnectionSchema = z.object({
  id: opaqueIdSchema,
  /** false = 平台托管（平台级凭据，可能不在本表内：由运行环境/KMS 解析） */
  isWorkspaceOwned: z.boolean(),
  providerId: z.string().min(1).max(100),
  kind: providerKindSchema,
  label: z.string().min(1).max(200),
  maskedToken: z.string().min(1).max(64),
  status: connectionStatusSchema,
  keyVersion: z.string().min(1).max(32),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  rotatedAt: isoDateTimeSchema.nullable().default(null),
  revokedAt: isoDateTimeSchema.nullable().default(null),
  lastUsedAt: isoDateTimeSchema.nullable().default(null),
  lastTestedAt: isoDateTimeSchema.nullable().default(null),
  lastTestStatus: connectionTestStatusSchema.nullable().default(null),
  lastTestMode: connectionTestModeSchema.nullable().default(null),
});

export type ProviderConnection = z.infer<typeof providerConnectionSchema>;

/** 创建/轮换：`secret` 只在请求体内出现一次，服务端立即加密，**绝不**回显。 */
export const createConnectionRequestSchema = z.object({
  providerId: z.string().min(1).max(100),
  kind: providerKindSchema,
  label: z.string().min(1).max(200),
  /** Provider API Key / Token（最小长度 8；不做格式强校验以免误伤不同 Provider 的格式） */
  secret: z.string().min(8).max(4096),
});

export type CreateConnectionRequest = z.infer<typeof createConnectionRequestSchema>;

export const rotateConnectionRequestSchema = z.object({
  secret: z.string().min(8).max(4096),
});

export type RotateConnectionRequest = z.infer<typeof rotateConnectionRequestSchema>;

export const testConnectionResponseSchema = z.object({
  connection: providerConnectionSchema,
  test: z.object({
    ok: z.boolean(),
    mode: connectionTestModeSchema,
    message: z.string().max(500).default(''),
  }),
});

export type TestConnectionResponse = z.infer<typeof testConnectionResponseSchema>;

/** Workspace 级按 Provider 类别的托管模式覆盖（§17.2） */
export const workspaceProviderSettingSchema = z.object({
  kind: providerKindSchema,
  selectionMode: credentialSelectionModeSchema,
  /** selectionMode=BYOK 时必填（且必须是本 workspace 的 ACTIVE 连接） */
  connectionId: opaqueIdSchema.nullable().default(null),
  updatedAt: isoDateTimeSchema,
});

export type WorkspaceProviderSetting = z.infer<typeof workspaceProviderSettingSchema>;

export const upsertWorkspaceProviderSettingRequestSchema = z.object({
  selectionMode: credentialSelectionModeSchema,
  connectionId: opaqueIdSchema.nullable().default(null),
});

export type UpsertWorkspaceProviderSettingRequest = z.infer<typeof upsertWorkspaceProviderSettingRequestSchema>;

/**
 * Router 决策（可审计）：选出唯一候选并解释其余候选为何被拒。
 * **不含 Secret**（只含 connectionId 引用）。
 */
export const routeRejectionSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  availabilityReasons: z.array(z.string().min(1)),
  credentialReason: z.string().min(1).nullable().default(null),
});

export const providerRouteDecisionSchema = z.object({
  capability: z.string().min(1),
  catalogVersion: z.number().int().positive().nullable().default(null),
  decision: z
    .object({
      providerId: z.string().min(1),
      modelId: z.string().min(1),
      kind: providerKindSchema,
      credentialMode: credentialModeSchema,
      /** BYOK 决策时给出连接引用（不含 Secret） */
      connectionId: opaqueIdSchema.nullable().default(null),
      reason: z.string().min(1),
    })
    .nullable()
    .default(null),
  rejected: z.array(routeRejectionSchema),
});

export type ProviderRouteDecision = z.infer<typeof providerRouteDecisionSchema>;

/** 加密负载（envelope encryption 的密文封套；仅存服务端，绝不外发） */
export const encryptedSecretSchema = z.object({
  algorithm: z.literal('AES-256-GCM'),
  keyVersion: z.string().min(1).max(32),
  /** base64（密文） */
  ciphertext: z.string().min(1),
  /** base64（nonce；12 字节） */
  nonce: z.string().min(1),
  /** base64（GCM tag；16 字节） */
  authTag: z.string().min(1),
});

export type EncryptedSecret = z.infer<typeof encryptedSecretSchema>;

/**
 * 凭据密文接口（KMS/envelope encryption）。实现：本地驱动（providers/credential-vault-local）；
 * 云 KMS（AWS KMS / GCP KMS）适配器属真实凭据阶段（§13.5 第 8 条），届时按同一接口替换。
 */
export interface CredentialCipher {
  readonly kind: string;
  /** 当前应使用的密钥版本（新写入用） */
  currentKeyVersion(): string;
  encrypt(plaintext: string): Promise<EncryptedSecret>;
  /** 使用密文内的 keyVersion 解密（支持轮换后旧密文） */
  decrypt(encrypted: EncryptedSecret): Promise<string>;
}

/** 连接测试钩子（离线校验之外的"真实连接测试"由 Provider 适配器提供；Mock 见 P03-07） */
export interface ProviderTestHook {
  /** Provider 标识（与 Catalog 的 providerId 对应） */
  providerId: string;
  test(secret: string, context: { providerId: string; kind: string }): Promise<{ ok: boolean; message: string }>;
}

/**
 * 平台托管凭据来源（运行时环境/KMS）：Router 用它判定 PLATFORM_MANAGED 是否可用；
 * `resolve` 仅在服务端执行链路调用（返回明文供适配器使用，绝不外发）。
 */
export interface PlatformCredentialRegistry {
  has(providerId: string): boolean;
  resolve?(providerId: string): string | null;
}
