import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  PACK_ERROR_REASONS,
  packAnalyzeResultSchema,
  packEnablementSchema,
  packInstallationSchema,
  packManifestSchema,
  projectPackBindingSchema,
  restrictedPluginContextSchema,
  workspacePackViewSchema,
  type ContentAtom,
  type PackAnalyzeResult,
  type PackEnablement,
  type PackInstallation,
  type PackManifest,
  type PackPlugin,
  type ProjectPackBinding,
  type RestrictedPluginContext,
  type WorkspacePackView,
} from '@ancs/contracts';
import { packEnablements, packInstallations, projectPackBindings } from '@ancs/db';
import type { DomainDeps } from './channels.js';
import { assertPackEnabled } from './plans.js';
import { evaluateChannelFit, listAtoms } from './atoms.js';
import { getProjectContentCoreState } from './content-core.js';

/**
 * Pack 生命周期与受限运行时（P11-03 / 规范 §92；计划 §8）。
 *
 * - **安装**（平台级）：官方 Pack 随启动幂等安装（packId+version 唯一；manifest 快照固化）；
 * - **启用**（workspace 级）：**权益白名单强制**（entitlements.packs 不含该 Pack → 403 PACK_NOT_ENTITLED）；
 * - **绑定**（project 级）：**版本锁定**——analyze 只对绑定版本运行；
 * - **受限上下文**：能力门控（未声明 read_content_core → core/atoms 为空）；**永不提供 DB/Secret**；
 * - analyze 全链闸门：绑定 → 安装 → 启用 → 权益 → 插件实例（501 PLUGIN_NOT_REGISTERED = 注册表缺实例）。
 */

const requirePlugins = (deps: DomainDeps): readonly PackPlugin[] => deps.packPlugins ?? [];

/* ---------- 安装（幂等；manifest 快照固化） ---------- */

export async function installPack(
  deps: DomainDeps,
  input: { manifest: unknown; official?: boolean },
): Promise<{ installation: PackInstallation; reused: boolean }> {
  const manifest = packManifestSchema.parse(input.manifest);
  const existing = await deps.db
    .select()
    .from(packInstallations)
    .where(and(eq(packInstallations.packId, manifest.packId), eq(packInstallations.version, manifest.version)))
    .limit(1);
  if (existing[0] !== undefined) {
    return { installation: toInstallationDto(existing[0]), reused: true };
  }
  const inserted = await deps.db
    .insert(packInstallations)
    .values({
      id: `pki_${randomUUID()}`,
      packId: manifest.packId,
      version: manifest.version,
      name: manifest.name,
      capabilities: manifest.capabilities,
      outputFormats: manifest.outputFormats,
      official: input.official === false ? 'false' : 'true',
      status: 'INSTALLED',
      manifest,
    })
    .returning();
  const row = inserted[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'pack installation failed', 500);
  return { installation: toInstallationDto(row), reused: false };
}

const toInstallationDto = (row: typeof packInstallations.$inferSelect): PackInstallation =>
  packInstallationSchema.parse({
    id: row.id,
    packId: row.packId,
    version: row.version,
    name: row.name,
    capabilities: row.capabilities,
    outputFormats: row.outputFormats,
    official: row.official === 'true',
    status: row.status,
    installedAt: row.installedAt.toISOString(),
  });

/** 官方 Pack 随启动幂等安装（plugins 来自装配；每次取最新版本清单）。 */
export async function ensurePacksInstalled(deps: DomainDeps): Promise<{ installed: string[] }> {
  const installed: string[] = [];
  for (const plugin of requirePlugins(deps)) {
    const result = await installPack(deps, { manifest: plugin.manifest, official: true });
    installed.push(`${result.installation.packId}@${result.installation.version}${result.reused ? ' (reused)' : ''}`);
  }
  return { installed };
}

/* ---------- 启用 / 停用（workspace 级；权益门） ---------- */

const toEnablementDto = (row: typeof packEnablements.$inferSelect): PackEnablement =>
  packEnablementSchema.parse({
    workspaceId: row.workspaceId,
    packId: row.packId,
    version: row.version,
    enabledAt: row.enabledAt.toISOString(),
  });

async function latestInstallation(deps: DomainDeps, packId: string): Promise<PackInstallation> {
  const rows = await deps.db
    .select()
    .from(packInstallations)
    .where(and(eq(packInstallations.packId, packId), eq(packInstallations.status, 'INSTALLED')))
    .orderBy(desc(packInstallations.installedAt))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new ApiFailure(ERROR_CODES.NOT_FOUND, `Pack「${packId}」未安装`, 404, { reason: PACK_ERROR_REASONS.PACK_NOT_INSTALLED, packId });
  }
  return toInstallationDto(row);
}

export async function enablePackForWorkspace(
  deps: DomainDeps,
  input: { workspaceId: string; packId: string },
): Promise<PackEnablement> {
  const installation = await latestInstallation(deps, input.packId);
  // **权益白名单**（P09-01 packs 维度；FREE 种子 packs:[] → 明确 403）
  await assertPackEnabled(deps, { workspaceId: input.workspaceId, packId: input.packId });

  const existing = await deps.db
    .select()
    .from(packEnablements)
    .where(and(eq(packEnablements.workspaceId, input.workspaceId), eq(packEnablements.packId, input.packId)))
    .limit(1);
  if (existing[0] !== undefined) {
    const updated = await deps.db
      .update(packEnablements)
      .set({ version: installation.version, enabledAt: new Date() })
      .where(eq(packEnablements.id, existing[0].id))
      .returning();
    const row = updated[0];
    if (row === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'pack enablement update failed', 500);
    return toEnablementDto(row);
  }
  const inserted = await deps.db
    .insert(packEnablements)
    .values({
      id: `pke_${randomUUID()}`,
      workspaceId: input.workspaceId,
      packId: input.packId,
      version: installation.version,
    })
    .returning();
  const row = inserted[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'pack enablement insert failed', 500);
  return toEnablementDto(row);
}

export async function disablePackForWorkspace(deps: DomainDeps, input: { workspaceId: string; packId: string }): Promise<void> {
  await deps.db
    .delete(packEnablements)
    .where(and(eq(packEnablements.workspaceId, input.workspaceId), eq(packEnablements.packId, input.packId)));
}

/** 工作区 Pack 视图（安装清单 + 启用状态）。 */
export async function listWorkspacePacks(deps: DomainDeps, input: { workspaceId: string }): Promise<WorkspacePackView[]> {
  const installations = await deps.db
    .select()
    .from(packInstallations)
    .where(eq(packInstallations.status, 'INSTALLED'))
    .orderBy(packInstallations.packId, desc(packInstallations.installedAt));
  const enablements = await deps.db.select().from(packEnablements).where(eq(packEnablements.workspaceId, input.workspaceId));
  const enabledByPack = new Map(enablements.map((row) => [row.packId, row]));
  const latestByPack = new Map<string, typeof packInstallations.$inferSelect>();
  for (const row of installations) {
    if (!latestByPack.has(row.packId)) latestByPack.set(row.packId, row);
  }
  const views: WorkspacePackView[] = [];
  for (const [packId, row] of latestByPack) {
    const enablement = enabledByPack.get(packId);
    views.push(
      workspacePackViewSchema.parse({
        installation: toInstallationDto(row),
        enabled: enablement !== undefined,
        enabledVersion: enablement?.version ?? null,
      }),
    );
  }
  return views;
}

/* ---------- 绑定（project 级；版本锁定） ---------- */

const toBindingDto = (row: typeof projectPackBindings.$inferSelect): ProjectPackBinding =>
  projectPackBindingSchema.parse({
    projectId: row.projectId,
    packId: row.packId,
    version: row.version,
    boundAt: row.boundAt.toISOString(),
  });

export async function bindProjectPack(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; packId: string },
): Promise<ProjectPackBinding> {
  const enablementRows = await deps.db
    .select()
    .from(packEnablements)
    .where(and(eq(packEnablements.workspaceId, input.workspaceId), eq(packEnablements.packId, input.packId)))
    .limit(1);
  const enablement = enablementRows[0];
  if (enablement === undefined) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, `Pack「${input.packId}」未为该工作区启用：请先启用再绑定项目`, 409, {
      reason: PACK_ERROR_REASONS.PACK_ENABLEMENT_REQUIRED,
      packId: input.packId,
    });
  }
  const existing = await deps.db
    .select()
    .from(projectPackBindings)
    .where(and(eq(projectPackBindings.projectId, input.projectId), eq(projectPackBindings.packId, input.packId)))
    .limit(1);
  if (existing[0] !== undefined) {
    const updated = await deps.db
      .update(projectPackBindings)
      .set({ version: enablement.version, boundAt: new Date() })
      .where(eq(projectPackBindings.id, existing[0].id))
      .returning();
    const row = updated[0];
    if (row === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'pack binding update failed', 500);
    return toBindingDto(row);
  }
  const inserted = await deps.db
    .insert(projectPackBindings)
    .values({
      id: `pkb_${randomUUID()}`,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      packId: input.packId,
      version: enablement.version,
    })
    .returning();
  const row = inserted[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'pack binding insert failed', 500);
  return toBindingDto(row);
}

/* ---------- 受限上下文 + analyze ---------- */

/**
 * 构建受限上下文（能力门控）：manifest 声明了 read_content_core 才给核心摘要/Atom；
 * **上下文只含显式授予的数据面——无 DB、无 Secret**。
 */
async function buildRestrictedContext(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; manifest: PackManifest; packVersion: string },
): Promise<RestrictedPluginContext> {
  const granted = new Set<string>(input.manifest.capabilities);
  const canReadCore = granted.has('read_content_core');
  let core: RestrictedPluginContext['data']['core'] = null;
  let atoms: ContentAtom[] = [];
  if (canReadCore) {
    const state = await getProjectContentCoreState(deps, { workspaceId: input.workspaceId, projectId: input.projectId });
    core = {
      inputsDigest: state.consistency?.inputsDigest ?? '0'.repeat(64),
      counts: {
        documentCount: state.liveCounts.documentCount,
        claimCount: state.liveCounts.claimCount,
        factCount: state.consistency?.factCount ?? 0,
        sourceCount: state.liveCounts.sourceCount,
      },
    };
    atoms = await listAtoms(deps, { workspaceId: input.workspaceId, projectId: input.projectId });
  }
  let fit: RestrictedPluginContext['data']['fit'] = null;
  if (input.manifest.defaultChannelKey !== null) {
    fit = await evaluateChannelFit(deps, { workspaceId: input.workspaceId, projectId: input.projectId, channelKey: input.manifest.defaultChannelKey }).catch(() => null);
  }
  return restrictedPluginContextSchema.parse({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    grantedCapabilities: [...granted],
    limits: null,
    packId: input.manifest.packId,
    packVersion: input.packVersion,
    data: { core, atoms, fit },
  });
}

/** analyze 全链闸门：绑定 → 安装 → 启用 → 权益 → 插件实例 → 受限上下文 → OutputPlan。 */
export async function runPackAnalyze(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; packId: string },
): Promise<PackAnalyzeResult> {
  // 1) 绑定（版本锁定）
  const bindingRows = await deps.db
    .select()
    .from(projectPackBindings)
    .where(and(eq(projectPackBindings.projectId, input.projectId), eq(projectPackBindings.packId, input.packId)))
    .limit(1);
  const binding = bindingRows[0];
  if (binding === undefined) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, `Pack「${input.packId}」未绑定该项目：请先绑定（版本锁定）`, 409, {
      reason: PACK_ERROR_REASONS.PACK_NOT_BOUND,
      packId: input.packId,
    });
  }

  // 2) 安装（按绑定版本）
  const installationRows = await deps.db
    .select()
    .from(packInstallations)
    .where(and(eq(packInstallations.packId, input.packId), eq(packInstallations.version, binding.version)))
    .limit(1);
  const installationRow = installationRows[0];
  if (installationRow === undefined) {
    throw new ApiFailure(ERROR_CODES.NOT_FOUND, `Pack「${input.packId}@${binding.version}」未安装`, 404, {
      reason: PACK_ERROR_REASONS.PACK_NOT_INSTALLED,
    });
  }

  // 3) 启用 + 4) 权益
  const enablementRows = await deps.db
    .select()
    .from(packEnablements)
    .where(and(eq(packEnablements.workspaceId, input.workspaceId), eq(packEnablements.packId, input.packId)))
    .limit(1);
  if (enablementRows[0] === undefined) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, `Pack「${input.packId}」未为该工作区启用`, 409, {
      reason: PACK_ERROR_REASONS.PACK_ENABLEMENT_REQUIRED,
    });
  }
  await assertPackEnabled(deps, { workspaceId: input.workspaceId, packId: input.packId });

  // 5) 插件实例（运行时注册；缺失 = 501 明确失败，绝不静默）
  const manifest = packManifestSchema.parse(installationRow.manifest);
  const plugin = requirePlugins(deps).find((candidate) => candidate.manifest.packId === manifest.packId && candidate.manifest.version === manifest.version);
  if (plugin === undefined) {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, `插件实例未注册：${manifest.packId}@${manifest.version}`, 501, {
      reason: PACK_ERROR_REASONS.PLUGIN_NOT_REGISTERED,
    });
  }

  // 6) 受限上下文 + analyze
  const context = await buildRestrictedContext(deps, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    manifest,
    packVersion: binding.version,
  });
  const plan = await plugin.analyze(context);
  return packAnalyzeResultSchema.parse({ plan, context });
}
