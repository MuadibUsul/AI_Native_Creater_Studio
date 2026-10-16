import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  connectionStatusSchema,
  encryptedSecretSchema,
  providerConnectionSchema,
  providerRouteDecisionSchema,
  testConnectionResponseSchema,
  workspaceProviderSettingSchema,
  type CredentialMode,
  type CredentialSelectionMode,
  type EncryptedSecret,
  type ProviderConnection,
  type ProviderRouteDecision,
  type ProviderTestHook,
  type TestConnectionResponse,
  type WorkspaceProviderSetting,
} from '@ancs/contracts';
import { outboxEvents, providerConnections, workspaceProviderSettings } from '@ancs/db';
import { evaluateModelAvailability, getCurrentCatalog } from './catalog.js';
import { assertByokAllowed } from './plans.js';
import type { DomainDeps } from './deps.js';

/**
 * Provider 凭据与路由（P03-04 / 规范 §17.2、§17.3；计划 P03-04）。
 *
 * - **KMS / envelope encryption**：经 `CredentialCipher`（本地 AES-256-GCM 驱动或云 KMS）；
 * - **连接测试**：离线校验（可解密 + 非空 + 可掩码）恒执行；注册了 ProviderTestHook 时执行真实连接测试；
 * - **轮换 / 撤销**：rotate 换密文与 keyVersion（保留可解密的历史密钥）；revoke 后 Router 立即不再选用；
 * - **Managed / BYOK 选择**（§17.2）：Workspace 级按类别的 selectionMode（AUTOMATIC 默认 =
 *   有 BYOK 用 BYOK，否则平台托管）+ 平台凭据注册表判定；**无可用凭据 → 明确拒绝（501）**；
 * - **不可外泄**：DTO 只含掩码与元数据；解密后的 Secret 只经 `resolveCredentialForExecution`
 *   返回给服务端执行链路（绝不进 API 响应/日志/错误）。
 */

const MASK_TAIL_LENGTH = 4;

function requireCipher(deps: DomainDeps) {
  if (deps.credentials === undefined) {
    throw new ApiFailure(ERROR_CODES.INTERNAL, '凭据密文服务未配置（DomainDeps.credentials）', 500);
  }
  return deps.credentials;
}

const mask = (secret: string): string => `••••${secret.slice(-MASK_TAIL_LENGTH)}`;

const toConnectionDto = (row: typeof providerConnections.$inferSelect): ProviderConnection =>
  providerConnectionSchema.parse({
    id: row.id,
    isWorkspaceOwned: row.workspaceId !== null,
    providerId: row.providerId,
    kind: row.kind,
    label: row.label,
    maskedToken: row.maskedToken,
    status: row.status,
    keyVersion: row.keyVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    rotatedAt: row.rotatedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
    lastTestStatus: row.lastTestStatus,
    lastTestMode: row.lastTestMode,
  });

async function loadConnectionRow(
  deps: DomainDeps,
  input: { workspaceId: string; connectionId: string },
): Promise<typeof providerConnections.$inferSelect> {
  const rows = await deps.db
    .select()
    .from(providerConnections)
    .where(and(eq(providerConnections.id, input.connectionId), eq(providerConnections.workspaceId, input.workspaceId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'provider connection not found', 404);
  return row;
}

/** 建立 BYOK 连接：加密后落库；返回的 DTO 只含掩码（§17.3）。 */
export async function createConnection(
  deps: DomainDeps,
  input: {
    workspaceId: string;
    userId?: string | null;
    input: { providerId: string; kind: string; label: string; secret: string };
  },
): Promise<ProviderConnection> {
  // P09-01：BYOK 权益强制执行（自带 Provider 凭据 = BYOK；套餐不允许则 403）
  await assertByokAllowed(deps, { workspaceId: input.workspaceId });

  const cipher = requireCipher(deps);

  // 连接必须对应当前 Catalog 中的 Provider（防止拼写错误造成"永不可用"的死配置）
  const catalog = await getCurrentCatalog(deps);
  const providerExists = catalog.catalog?.entries.some((entry) => entry.providerId === input.input.providerId) ?? false;
  if (!providerExists) {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'Provider 不在当前 Catalog 中（先建立目录再连接）', 501, {
      providerId: input.input.providerId,
      catalogVersion: catalog.catalog?.version ?? null,
    });
  }

  const encrypted = await cipher.encrypt(input.input.secret);
  const inserted = await deps.db
    .insert(providerConnections)
    .values({
      id: `pcn_${randomUUID()}`,
      workspaceId: input.workspaceId,
      providerId: input.input.providerId,
      kind: input.input.kind,
      label: input.input.label,
      encryptedSecret: encrypted,
      maskedToken: mask(input.input.secret),
      keyVersion: encrypted.keyVersion,
      status: 'ACTIVE',
      createdBy: input.userId ?? null,
    })
    .returning();
  const row = inserted[0];
  if (!row) throw new ApiFailure(ERROR_CODES.INTERNAL, 'connection insert failed', 500);

  await deps.db.insert(outboxEvents).values({
    id: `obx_${randomUUID()}`,
    workspaceId: input.workspaceId,
    type: 'provider.connection.created',
    payload: { connectionId: row.id, providerId: row.providerId, kind: row.kind, actorId: input.userId ?? null, actorType: 'USER' },
  });
  return toConnectionDto(row);
}

export async function listConnections(deps: DomainDeps, input: { workspaceId: string }): Promise<ProviderConnection[]> {
  const rows = await deps.db
    .select()
    .from(providerConnections)
    .where(eq(providerConnections.workspaceId, input.workspaceId))
    .orderBy(desc(providerConnections.createdAt));
  return rows.map(toConnectionDto);
}

export async function getConnection(
  deps: DomainDeps,
  input: { workspaceId: string; connectionId: string },
): Promise<ProviderConnection> {
  return toConnectionDto(await loadConnectionRow(deps, input));
}

/** 轮换：写入新密文（新 keyVersion），保留 rotatedAt（§17.3 可 rotate）。 */
export async function rotateConnection(
  deps: DomainDeps,
  input: { workspaceId: string; connectionId: string; newSecret: string },
): Promise<ProviderConnection> {
  const cipher = requireCipher(deps);
  const row = await loadConnectionRow(deps, input);
  if (connectionStatusSchema.parse(row.status) === 'REVOKED') {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '连接已撤销，无法轮换（请重新建立连接）', 409, { status: row.status });
  }
  const encrypted = await cipher.encrypt(input.newSecret);
  const now = new Date();
  const updated = await deps.db
    .update(providerConnections)
    .set({
      encryptedSecret: encrypted,
      maskedToken: mask(input.newSecret),
      keyVersion: encrypted.keyVersion,
      status: 'ACTIVE',
      rotatedAt: now,
      updatedAt: now,
    })
    .where(and(eq(providerConnections.id, row.id), eq(providerConnections.workspaceId, input.workspaceId)))
    .returning();
  const next = updated[0];
  if (!next) throw new ApiFailure(ERROR_CODES.INTERNAL, 'connection rotate failed', 500);
  await deps.db.insert(outboxEvents).values({
    id: `obx_${randomUUID()}`,
    workspaceId: input.workspaceId,
    type: 'provider.connection.rotated',
    payload: { connectionId: row.id, providerId: row.providerId, keyVersion: encrypted.keyVersion, actorType: 'USER', actorId: null },
  });
  return toConnectionDto(next);
}

/** 撤销：立即从 Router 候选中消失（status=REVOKED + revoked_at）。 */
export async function revokeConnection(
  deps: DomainDeps,
  input: { workspaceId: string; connectionId: string },
): Promise<ProviderConnection> {
  const row = await loadConnectionRow(deps, input);
  const now = new Date();
  const updated = await deps.db
    .update(providerConnections)
    .set({ status: 'REVOKED', revokedAt: now, updatedAt: now })
    .where(and(eq(providerConnections.id, row.id), eq(providerConnections.workspaceId, input.workspaceId)))
    .returning();
  const next = updated[0];
  if (!next) throw new ApiFailure(ERROR_CODES.INTERNAL, 'connection revoke failed', 500);
  await deps.db.insert(outboxEvents).values({
    id: `obx_${randomUUID()}`,
    workspaceId: input.workspaceId,
    type: 'provider.connection.revoked',
    payload: { connectionId: row.id, providerId: row.providerId, actorType: 'USER', actorId: null },
  });
  return toConnectionDto(next);
}

/**
 * 连接测试：离线校验（可解密）恒执行；注册了 ProviderTestHook（真实 Provider 或 P03-07 Mock）时执行
 * **真实连接测试**并记录模式（LIVE / OFFLINE_VALIDATION）。任何失败信息都**不含 Secret**。
 */
export async function testConnection(
  deps: DomainDeps,
  input: { workspaceId: string; connectionId: string; testHooks?: readonly ProviderTestHook[] },
): Promise<TestConnectionResponse> {
  const cipher = requireCipher(deps);
  const row = await loadConnectionRow(deps, input);
  if (row.status === 'REVOKED') {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '连接已撤销，无法测试', 409, { status: row.status });
  }
  if (row.encryptedSecret === null) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '该连接没有可用的密文（平台登记行不可测试）', 409);
  }

  let ok = true;
  let message = '离线校验通过（密文可解密、非空）';
  let mode: 'OFFLINE_VALIDATION' | 'LIVE' = 'OFFLINE_VALIDATION';
  let secret: string | null = null;
  try {
    secret = await cipher.decrypt(encryptedSecretSchema.parse(row.encryptedSecret) as EncryptedSecret);
  } catch {
    ok = false;
    message = '离线校验失败：密文无法解密（密钥版本缺失或数据损坏）';
  }

  if (ok && secret !== null) {
    const hook = input.testHooks?.find((candidate) => candidate.providerId === row.providerId);
    if (hook !== undefined) {
      mode = 'LIVE';
      const result = await hook.test(secret, { providerId: row.providerId, kind: row.kind });
      ok = result.ok;
      // 钩子返回的消息可能含上游错误文案：仅保留前 500 字符，且**不得**包含 Secret（由钩子保证）
      message = result.message.slice(0, 500);
    }
  }

  const now = new Date();
  const updated = await deps.db
    .update(providerConnections)
    .set({
      lastTestedAt: now,
      lastTestStatus: ok ? 'OK' : 'FAILED',
      lastTestMode: mode,
      status: ok ? 'ACTIVE' : 'INVALID',
      updatedAt: now,
    })
    .where(and(eq(providerConnections.id, row.id), eq(providerConnections.workspaceId, input.workspaceId)))
    .returning();
  const next = updated[0];
  if (!next) throw new ApiFailure(ERROR_CODES.INTERNAL, 'connection test update failed', 500);
  return testConnectionResponseSchema.parse({
    connection: toConnectionDto(next),
    test: { ok, mode, message },
  });
}

/** Workspace 级按类别的托管模式设置（§17.2 覆盖）。 */
export async function upsertWorkspaceProviderSetting(
  deps: DomainDeps,
  input: {
    workspaceId: string;
    kind: string;
    selectionMode: CredentialSelectionMode;
    connectionId?: string | null;
  },
): Promise<WorkspaceProviderSetting> {
  let connectionId = input.connectionId ?? null;
  if (connectionId !== null) {
    const connection = await loadConnectionRow(deps, { workspaceId: input.workspaceId, connectionId });
    if (connection.status !== 'ACTIVE') {
      throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '连接不可用（已撤销或校验失败）', 409, { status: connection.status });
    }
  }
  if (input.selectionMode !== 'BYOK') connectionId = null;

  const now = new Date();
  const existing = await deps.db
    .select()
    .from(workspaceProviderSettings)
    .where(
      and(
        eq(workspaceProviderSettings.workspaceId, input.workspaceId),
        eq(workspaceProviderSettings.kind, input.kind),
        isNull(workspaceProviderSettings.scopeIdentityId),
      ),
    )
    .limit(1);
  if (existing[0] !== undefined) {
    const updated = await deps.db
      .update(workspaceProviderSettings)
      .set({ selectionMode: input.selectionMode, connectionId, updatedAt: now })
      .where(eq(workspaceProviderSettings.id, existing[0].id))
      .returning();
    const row = updated[0];
    if (!row) throw new ApiFailure(ERROR_CODES.INTERNAL, 'setting update failed', 500);
    return toSettingDto(row);
  }
  const inserted = await deps.db
    .insert(workspaceProviderSettings)
    .values({
      id: `wps_${randomUUID()}`,
      workspaceId: input.workspaceId,
      kind: input.kind,
      selectionMode: input.selectionMode,
      connectionId,
    })
    .returning();
  const row = inserted[0];
  if (!row) throw new ApiFailure(ERROR_CODES.INTERNAL, 'setting insert failed', 500);
  return toSettingDto(row);
}

const toSettingDto = (row: typeof workspaceProviderSettings.$inferSelect): WorkspaceProviderSetting =>
  workspaceProviderSettingSchema.parse({
    kind: row.kind,
    selectionMode: row.selectionMode,
    connectionId: row.connectionId,
    updatedAt: row.updatedAt.toISOString(),
  });

export async function listWorkspaceProviderSettings(
  deps: DomainDeps,
  input: { workspaceId: string },
): Promise<WorkspaceProviderSetting[]> {
  const rows = await deps.db
    .select()
    .from(workspaceProviderSettings)
    .where(eq(workspaceProviderSettings.workspaceId, input.workspaceId));
  return rows.map(toSettingDto);
}

/** 凭据判定结果（Router 内部使用） */
interface CredentialResolution {
  mode: CredentialMode;
  connectionId: string | null;
  reason: string;
}

/**
 * 按类别 + Provider 解析凭据（§17.2 决策）：
 * - 设置 BYOK → 必须存在该 Provider 的 ACTIVE 连接（缺失即**拒绝**，不静默回落）；
 * - 设置 PLATFORM_MANAGED → 需要平台凭据可用（缺失即拒绝）；
 * - AUTOMATIC（默认）→ 有 BYOK 连接用 BYOK，否则平台凭据，再否则拒绝。
 */
async function resolveCredentialForProvider(
  deps: DomainDeps,
  input: { workspaceId: string; providerId: string; kind: string },
): Promise<CredentialResolution | { rejection: string }> {
  const settings = await deps.db
    .select()
    .from(workspaceProviderSettings)
    .where(
      and(
        eq(workspaceProviderSettings.workspaceId, input.workspaceId),
        eq(workspaceProviderSettings.kind, input.kind),
        isNull(workspaceProviderSettings.scopeIdentityId),
      ),
    )
    .limit(1);
  const selectionMode = (settings[0]?.selectionMode ?? 'AUTOMATIC') as CredentialSelectionMode;

  const connectionRows = await deps.db
    .select()
    .from(providerConnections)
    .where(
      and(
        eq(providerConnections.workspaceId, input.workspaceId),
        eq(providerConnections.providerId, input.providerId),
        eq(providerConnections.status, 'ACTIVE'),
        eq(providerConnections.kind, input.kind),
      ),
    )
    .orderBy(desc(providerConnections.createdAt))
    .limit(1);
  const byok = connectionRows[0];
  const platformAvailable = deps.platformCredentials?.has(input.providerId) ?? false;

  if (selectionMode === 'BYOK') {
    if (byok === undefined) return { rejection: 'BYOK_SELECTED_BUT_CONNECTION_MISSING' };
    return { mode: 'BYOK', connectionId: byok.id, reason: 'WORKSPACE_BYOK_SELECTED' };
  }
  if (selectionMode === 'PLATFORM_MANAGED') {
    if (!platformAvailable) return { rejection: 'PLATFORM_CREDENTIAL_MISSING' };
    return { mode: 'PLATFORM_MANAGED', connectionId: null, reason: 'WORKSPACE_PLATFORM_SELECTED' };
  }
  // AUTOMATIC：有 BYOK 用 BYOK，否则平台托管（§17.2 的默认决策）
  if (byok !== undefined) return { mode: 'BYOK', connectionId: byok.id, reason: 'BYOK_PREFERRED_AUTOMATIC' };
  if (platformAvailable) return { mode: 'PLATFORM_MANAGED', connectionId: null, reason: 'PLATFORM_FALLBACK_AUTOMATIC' };
  return { rejection: 'NO_BYOK_AND_NO_PLATFORM_CREDENTIAL' };
}

/**
 * Router 决策（P03-04；REQ-16-01 的维度子集）：
 * 1) Catalog 按能力筛选（含核验时效/地区，P03-03 门控）；
 * 2) 逐候选解析凭据（§17.2）与类别设置；
 * 3) 选出第一个全部通过的候选（按 Catalog 顺序 = 优先级）；全被拒 → 501 并附逐候选原因（可审计）。
 */
export async function resolveProviderRoute(
  deps: DomainDeps,
  input: { workspaceId: string; capability: string; region?: string; now?: Date },
): Promise<ProviderRouteDecision> {
  const catalog = await getCurrentCatalog(deps);
  const entries = catalog.catalog?.entries ?? [];
  const rejected: ProviderRouteDecision['rejected'] = [];

  for (const entry of entries) {
    for (const model of entry.models) {
      const availability = evaluateModelAvailability(entry.providerId, model, {
        capability: input.capability,
        ...(input.region !== undefined ? { region: input.region } : {}),
        ...(input.now !== undefined ? { now: input.now } : {}),
      });
      if (!availability.callable) {
        rejected.push({
          providerId: entry.providerId,
          modelId: model.modelId,
          availabilityReasons: availability.reasons,
          credentialReason: null,
        });
        continue;
      }
      const credential = await resolveCredentialForProvider(deps, {
        workspaceId: input.workspaceId,
        providerId: entry.providerId,
        kind: entry.kind,
      });
      if ('rejection' in credential) {
        rejected.push({
          providerId: entry.providerId,
          modelId: model.modelId,
          availabilityReasons: [],
          credentialReason: credential.rejection,
        });
        continue;
      }
      return providerRouteDecisionSchema.parse({
        capability: input.capability,
        catalogVersion: catalog.catalog?.version ?? null,
        decision: {
          providerId: entry.providerId,
          modelId: model.modelId,
          kind: entry.kind,
          credentialMode: credential.mode,
          connectionId: credential.connectionId,
          reason: credential.reason,
        },
        rejected,
      });
    }
  }

  throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, '没有可用候选：真实调用被阻止（目录/凭据均需就绪）', 501, {
    capability: input.capability,
    catalogVersion: catalog.catalog?.version ?? null,
    catalogExists: catalog.exists,
    rejected,
  });
}

/**
 * 执行链路取用凭据（**仅服务端**；Worker/Provider 适配器调用）。
 * 返回明文 Secret —— 调用方必须立即使用、绝不记录/外发；并更新 last_used_at。
 */
export async function resolveCredentialForExecution(
  deps: DomainDeps,
  input: { workspaceId: string; providerId: string; kind: string },
): Promise<{ mode: CredentialMode; connectionId: string | null; secret: string | null }> {
  const resolution = await resolveCredentialForProvider(deps, {
    workspaceId: input.workspaceId,
    providerId: input.providerId,
    kind: input.kind,
  });
  if ('rejection' in resolution) {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, '无可用凭据：真实调用被阻止', 501, { reason: resolution.rejection });
  }
  if (resolution.mode === 'PLATFORM_MANAGED') {
    // 平台托管的 Secret 由运行环境/KMS 解析（不落库、不经本函数返回给调用方以外的地方）
    return { mode: 'PLATFORM_MANAGED', connectionId: null, secret: deps.platformCredentials?.resolve?.(input.providerId) ?? null };
  }
  const cipher = requireCipher(deps);
  const connection = await loadConnectionRow(deps, { workspaceId: input.workspaceId, connectionId: resolution.connectionId ?? '' });
  if (connection.encryptedSecret === null) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '连接缺少密文', 409);
  }
  const secret = await cipher.decrypt(encryptedSecretSchema.parse(connection.encryptedSecret) as EncryptedSecret);
  await deps.db
    .update(providerConnections)
    .set({ lastUsedAt: new Date() })
    .where(and(eq(providerConnections.id, connection.id), eq(providerConnections.workspaceId, input.workspaceId)));
  return { mode: 'BYOK', connectionId: connection.id, secret };
}
