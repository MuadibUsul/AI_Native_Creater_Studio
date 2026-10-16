import { randomUUID } from 'node:crypto';
import { desc } from 'drizzle-orm';
import {
  ApiFailure,
  CATALOG_ERROR_REASONS,
  DEFAULT_MAX_VERIFICATION_AGE_DAYS,
  ERROR_CODES,
  catalogResponseSchema,
  capabilitySelectionSchema,
  modelAvailabilitySchema,
  providerCatalogSchema,
  type CapabilitySelection,
  type CatalogResponse,
  type ModelAvailability,
  type ProviderCatalog,
  type ProviderModel,
} from '@ancs/contracts';
import { providerCatalogVersions } from '@ancs/db';
import type { DomainDeps } from './deps.js';

/**
 * Provider Catalog（P03-03 / 计划 P03-03）。
 *
 * 职责：
 * - **版本化配置**：能力 / 模型 / 价格 / 限额 / 地区 / 保留策略 + **核验时间（verifiedAt）**；
 *   任何变更写入新版本（平台级、不可变；当前版本 = MAX(version)）；
 * - **Router 按能力筛选**：`selectByCapability` 返回带可用性判定的候选（能力 + 状态 + 核验时效 + 地区）；
 * - **无有效配置时明确阻止真实调用**：`requireCallableModel` 在条目缺失/未核验/已弃用/核验过期/
 *   地区不允许时抛 501 CAPABILITY_UNAVAILABLE（附原因），绝不静默降级到"随便找个 Provider"。
 *
 * 说明：内置"种子 Catalog"仅包含**尚未核验**的条目占位（status=UNVERIFIED）——在真实账号核验
 * （P03-04/P06）之前，任何真实调用都会被上述门控阻止（这是刻意的 fail-closed 状态）。
 */

const VERIFICATION_AGE_MS_PER_DAY = 24 * 60 * 60 * 1000;

const toCatalogDto = (row: typeof providerCatalogVersions.$inferSelect): ProviderCatalog =>
  providerCatalogSchema.parse({
    version: row.version,
    entries: (row.catalog as { entries?: unknown }).entries ?? [],
    createdAt: row.createdAt.toISOString(),
    note: row.note,
    createdBy: row.createdBy,
  });

/** 当前 Catalog（无版本时为 null——不是错误，由调用方决定如何呈现）。 */
export async function getCurrentCatalog(deps: DomainDeps): Promise<CatalogResponse> {
  const rows = await deps.db
    .select()
    .from(providerCatalogVersions)
    .orderBy(desc(providerCatalogVersions.version))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return catalogResponseSchema.parse({
      catalog: null,
      exists: false,
      note: 'Provider Catalog 尚未建立（种子目录创建后可见；未核验条目不参与真实调用）',
    });
  }
  return catalogResponseSchema.parse({ catalog: toCatalogDto(row), exists: true, note: '' });
}

/** 建立新的 Catalog 版本（不可变；version = MAX + 1）。 */
export async function createCatalogVersion(
  deps: DomainDeps,
  input: { entries: ProviderCatalog['entries']; note?: string; createdBy?: string | null },
): Promise<ProviderCatalog> {
  // 入参校验（entries → models 的完整契约校验在 providerCatalogSchema）
  const validated = providerCatalogSchema.parse({
    version: 1, // 占位；真实版本号在事务内分配
    entries: input.entries,
    createdAt: new Date().toISOString(),
    note: input.note ?? null,
    createdBy: input.createdBy ?? null,
  });

  return deps.db.transaction(async (tx) => {
    const latest = await tx
      .select({ max: providerCatalogVersions.version })
      .from(providerCatalogVersions)
      .orderBy(desc(providerCatalogVersions.version))
      .limit(1);
    const version = (latest[0]?.max ?? 0) + 1;
    const inserted = await tx
      .insert(providerCatalogVersions)
      .values({
        id: `cat_${randomUUID()}`,
        version,
        catalog: { entries: validated.entries },
        note: input.note ?? null,
        createdBy: input.createdBy ?? null,
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new ApiFailure(ERROR_CODES.INTERNAL, 'catalog insert failed', 500);
    return toCatalogDto(row);
  });
}

/** 模型条目可用性（单条事实来源：能力筛选与 requireCallableModel 共用）。 */
export function evaluateModelAvailability(
  providerId: string,
  model: ProviderModel,
  input: { capability: string; region?: string; now?: Date; maxVerificationAgeDays?: number },
): ModelAvailability {
  const now = input.now ?? new Date();
  const maxAgeDays = input.maxVerificationAgeDays ?? DEFAULT_MAX_VERIFICATION_AGE_DAYS;
  const verifiedAt = new Date(model.verifiedAt);
  const ageMs = now.getTime() - verifiedAt.getTime();
  const ageDays = Math.max(0, Math.floor(ageMs / VERIFICATION_AGE_MS_PER_DAY));
  const reasons: string[] = [];

  if (!model.capabilities.includes(input.capability)) reasons.push('CAPABILITY_NOT_SUPPORTED');
  if (model.status === 'UNVERIFIED') reasons.push('STATUS_UNVERIFIED');
  if (model.status === 'DEPRECATED') reasons.push('STATUS_DEPRECATED');
  if (ageMs > maxAgeDays * VERIFICATION_AGE_MS_PER_DAY) reasons.push('STALE_VERIFICATION');
  if (input.region !== undefined) {
    const regionAllowed = model.regions.length === 0 || model.regions.includes(input.region);
    if (!regionAllowed) reasons.push('REGION_NOT_ALLOWED');
  }

  return modelAvailabilitySchema.parse({
    providerId,
    modelId: model.modelId,
    callable: reasons.length === 0,
    reasons,
    verifiedAt: model.verifiedAt,
    verificationAgeDays: ageDays,
  });
}

/** Router 按能力筛选（callableOnly 默认 true：只返回可真实调用的候选）。 */
export async function selectByCapability(
  deps: DomainDeps,
  input: { capability: string; region?: string; callableOnly?: boolean; now?: Date; maxVerificationAgeDays?: number },
): Promise<CapabilitySelection> {
  const current = await getCurrentCatalog(deps);
  const candidates: CapabilitySelection['candidates'] = [];
  for (const entry of current.catalog?.entries ?? []) {
    for (const model of entry.models) {
      if (!model.capabilities.includes(input.capability)) continue;
      const availability = evaluateModelAvailability(entry.providerId, model, {
        capability: input.capability,
        ...(input.region !== undefined ? { region: input.region } : {}),
        ...(input.now !== undefined ? { now: input.now } : {}),
        ...(input.maxVerificationAgeDays !== undefined ? { maxVerificationAgeDays: input.maxVerificationAgeDays } : {}),
      });
      if (input.callableOnly !== false && !availability.callable) continue;
      candidates.push(availability);
    }
  }
  return capabilitySelectionSchema.parse({
    capability: input.capability,
    ...(input.region !== undefined ? { region: input.region } : {}),
    callableOnly: input.callableOnly !== false,
    candidates,
  });
}

/**
 * 真实调用的门控（"无有效配置时明确阻止真实调用"）：
 * 找不到条目 / 未核验 / 已弃用 / 核验过期 / 地区不允许 → 501 CAPABILITY_UNAVAILABLE（附原因与版本）。
 */
export async function requireCallableModel(
  deps: DomainDeps,
  input: { providerId: string; modelId: string; capability: string; region?: string; now?: Date },
): Promise<{ model: ProviderModel; providerId: string }> {
  const current = await getCurrentCatalog(deps);
  if (current.catalog === null) {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'Provider Catalog 缺失：真实调用被阻止（请先建立并核验目录）', 501, {
      reason: CATALOG_ERROR_REASONS.CATALOG_MISSING,
    });
  }
  const entry = current.catalog.entries.find((candidate) => candidate.providerId === input.providerId);
  const model = entry?.models.find((candidate) => candidate.modelId === input.modelId);
  if (entry === undefined || model === undefined) {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'Provider 模型不在当前 Catalog 中：真实调用被阻止', 501, {
      reason: CATALOG_ERROR_REASONS.MODEL_NOT_FOUND,
      providerId: input.providerId,
      modelId: input.modelId,
      catalogVersion: current.catalog.version,
    });
  }
  const availability = evaluateModelAvailability(entry.providerId, model, {
    capability: input.capability,
    ...(input.region !== undefined ? { region: input.region } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  if (!availability.callable) {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'Provider 模型当前不可调用：真实调用被阻止', 501, {
      reason: CATALOG_ERROR_REASONS.MODEL_NOT_CALLABLE,
      providerId: input.providerId,
      modelId: input.modelId,
      availability,
      catalogVersion: current.catalog.version,
    });
  }
  return { model, providerId: entry.providerId };
}

/**
 * 种子 Catalog（V1 诚实状态）：条目均为 **UNVERIFIED**（尚无真实账号核验，P03-04/P06），
 * 因此 `requireCallableModel` 会拒绝一切真实调用——这是刻意的 fail-closed，不是功能缺失。
 */
export function buildSeedCatalogEntries(): ProviderCatalog['entries'] {
  const unverifiedAt = '2026-10-01T00:00:00.000Z';
  const price = { unit: 'CALL' as const, unitPrice: { amount: '0', currency: 'USD' }, minimumUnits: 0, note: '未核验：仅为占位' };
  const limits = { maxConcurrency: null, maxInputSeconds: null, maxInputCharacters: null, maxRequestsPerMinute: null };
  return [
    {
      providerId: 'llm.primary',
      providerName: 'LLM（主）',
      kind: 'LLM',
      connectionRequired: true,
      capabilities: ['text.generate'],
      models: [
        {
          modelId: 'placeholder-llm-1',
          displayName: 'LLM 占位模型（未核验）',
          status: 'UNVERIFIED',
          capabilities: ['text.generate'],
          price,
          limits,
          regions: [],
          dataRetention: 'UNKNOWN',
          residency: [],
          verifiedAt: unverifiedAt,
          deprecatedAt: null,
          metadata: { note: '待 P03-04/P06 用真实账号核验后替换' },
        },
      ],
      metadata: {},
    },
    {
      providerId: 'tts.primary',
      providerName: 'TTS（主）',
      kind: 'TTS',
      connectionRequired: true,
      capabilities: ['speech.synthesize'],
      models: [
        {
          modelId: 'placeholder-tts-1',
          displayName: 'TTS 占位模型（未核验）',
          status: 'UNVERIFIED',
          capabilities: ['speech.synthesize'],
          price,
          limits,
          regions: [],
          dataRetention: 'UNKNOWN',
          residency: [],
          verifiedAt: unverifiedAt,
          deprecatedAt: null,
          metadata: {},
        },
      ],
      metadata: {},
    },
  ];
}
