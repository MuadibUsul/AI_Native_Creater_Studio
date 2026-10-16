import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  PACK_ARTIFACT_ERROR_REASONS,
  PACK_ERROR_REASONS,
  artifactPayloadSchema,
  artifactValidationResultSchema,
  packAnalyzeResultSchema,
  packArtifactSchema,
  packArtifactViewSchema,
  packEnablementSchema,
  packInstallationSchema,
  packManifestSchema,
  projectPackBindingSchema,
  restrictedPluginContextSchema,
  workspacePackViewSchema,
  type ArtifactValidationResult,
  type ContentAtom,
  type PackAnalyzeResult,
  type PackArtifactView,
  type PackEnablement,
  type PackInstallation,
  type PackManifest,
  type PackPlugin,
  type ProjectPackBinding,
  type RestrictedPluginContext,
  type WorkspacePackView,
} from '@ancs/contracts';
import { claims, derivationLineage, packArtifactValidations, packArtifacts, packEnablements, packInstallations, projectPackBindings, projectSources } from '@ancs/db';
import type { DomainDeps } from './deps.js';
import { assertPackEnabled } from './plans.js';
import { evaluateChannelFit, listAtoms, listChannelRecipes } from './atoms.js';
import { recordPlanLineage } from './lineage.js';
import { getProjectContentCoreState } from './content-core.js';
import { getProjectDetail } from './projects.js';

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
    .onConflictDoNothing()
    .returning();
  const row = inserted[0];
  if (row === undefined) {
    // 并发安装（其他进程刚插入同 packId+version）→ 复用既有行（幂等语义不变）
    const reread = await deps.db
      .select()
      .from(packInstallations)
      .where(and(eq(packInstallations.packId, manifest.packId), eq(packInstallations.version, manifest.version)))
      .limit(1);
    const existingRow = reread[0];
    if (existingRow === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'pack installation failed', 500);
    return { installation: toInstallationDto(existingRow), reused: true };
  }
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
 * 构建受限上下文（能力门控）：manifest 声明了 read_content_core 才给核心摘要/Atom/Claim→Source 索引/
 * Channel 快照/Recipe；**上下文只含显式授予的数据面——无 DB、无 Secret**。
 */
async function buildRestrictedContext(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; manifest: PackManifest; packVersion: string },
): Promise<RestrictedPluginContext> {
  const granted = new Set<string>(input.manifest.capabilities);
  const canReadCore = granted.has('read_content_core');
  let core: RestrictedPluginContext['data']['core'] = null;
  let atoms: ContentAtom[] = [];
  let claimSources: RestrictedPluginContext['data']['claimSources'] = [];
  let sources: RestrictedPluginContext['data']['sources'] = [];
  let channelSnapshot: RestrictedPluginContext['data']['channelSnapshot'] = null;
  if (canReadCore) {
    const [state, liveAtoms, detail, sourceRows] = await Promise.all([
      getProjectContentCoreState(deps, { workspaceId: input.workspaceId, projectId: input.projectId }),
      listAtoms(deps, { workspaceId: input.workspaceId, projectId: input.projectId }),
      getProjectDetail(deps, { workspaceId: input.workspaceId, projectId: input.projectId }),
      deps.db
        .select({ id: projectSources.id, title: projectSources.title, publisher: projectSources.publisher })
        .from(projectSources)
        .where(and(eq(projectSources.workspaceId, input.workspaceId), eq(projectSources.projectId, input.projectId))),
    ]);
    sources = sourceRows.map((row) => ({ sourceId: row.id, title: row.title, publisher: row.publisher }));
    core = {
      inputsDigest: state.consistency?.inputsDigest ?? '0'.repeat(64),
      counts: {
        documentCount: state.liveCounts.documentCount,
        claimCount: state.liveCounts.claimCount,
        factCount: state.consistency?.factCount ?? 0,
        sourceCount: state.liveCounts.sourceCount,
      },
    };
    atoms = liveAtoms;
    // Claim→Source 索引（Atom→Claim→Source 链闭合；只有 id 映射，不含正文）
    const claimRows = await deps.db
      .select({ id: claims.id, sourceIds: claims.sourceIds })
      .from(claims)
      .where(and(eq(claims.workspaceId, input.workspaceId), eq(claims.projectId, input.projectId)));
    claimSources = claimRows.map((row) => ({ claimId: row.id, sourceIds: (row.sourceIds ?? []) as string[] }));
    channelSnapshot = {
      channelId: detail.channelSnapshot.channelId,
      channelStyleVersion: String(detail.channelSnapshot.styleVersion),
      speechProfileId: null,
      speechProfileVersion: null,
    };
  }
  let fit: RestrictedPluginContext['data']['fit'] = null;
  let recipe: RestrictedPluginContext['data']['recipe'] = null;
  const activeRecipes = await listChannelRecipes(deps);
  if (input.manifest.defaultChannelKey !== null) {
    fit = await evaluateChannelFit(deps, { workspaceId: input.workspaceId, projectId: input.projectId, channelKey: input.manifest.defaultChannelKey }).catch(() => null);
    recipe = activeRecipes.find((candidate) => candidate.channelKey === input.manifest.defaultChannelKey && candidate.status === 'ACTIVE') ?? null;
  }
  return restrictedPluginContextSchema.parse({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    grantedCapabilities: [...granted],
    limits: null,
    packId: input.manifest.packId,
    packVersion: input.packVersion,
    data: { core, atoms, claimSources, sources, channelSnapshot, recipe, recipes: activeRecipes, fit },
  });
}

/**
 * 全链闸门解析（analyze/generate/validate 共用）：
 * 绑定（版本锁定）→ 安装（按绑定版本）→ 启用 → 权益白名单 → 插件实例。
 */
async function resolvePackRuntime(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; packId: string },
): Promise<{ manifest: PackManifest; plugin: PackPlugin; version: string }> {
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
  return { manifest, plugin, version: binding.version };
}

/** analyze 全链闸门：绑定 → 安装 → 启用 → 权益 → 插件实例 → 受限上下文 → OutputPlan。 */
export async function runPackAnalyze(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; packId: string },
): Promise<PackAnalyzeResult> {
  const { manifest, plugin, version } = await resolvePackRuntime(deps, input);

  // 6) 受限上下文 + analyze
  const context = await buildRestrictedContext(deps, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    manifest,
    packVersion: version,
  });
  const plan = await plugin.analyze(context);
  // 派生血缘（P11-04）：只追加 PLAN 行（输入快照；过期由列表读取时对照提示）
  await recordPlanLineage(deps, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    packId: manifest.packId,
    packVersion: manifest.version,
    channelKey: manifest.defaultChannelKey,
    coreInputsDigest: context.data.core?.inputsDigest ?? null,
    atomCount: context.data.atoms.length,
    claimCount: context.data.core?.counts.claimCount ?? 0,
    summary: plan.summary,
  });
  return packAnalyzeResultSchema.parse({ plan, context });
}

/* ---------- 产物（P12-01）：generate / validate（只追加） ---------- */

const toArtifactDto = (row: typeof packArtifacts.$inferSelect) =>
  packArtifactSchema.parse({
    artifactId: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    packId: row.packId,
    packVersion: row.packVersion,
    lineageId: row.lineageId,
    payloadKind: row.payloadKind,
    title: row.title,
    payload: row.payload,
    createdAt: row.createdAt.toISOString(),
  });

const toValidationDto = (row: {
  artifactId: string;
  ok: boolean;
  issues: unknown;
  validatedAt: Date;
}): ArtifactValidationResult =>
  artifactValidationResultSchema.parse({
    artifactId: row.artifactId,
    ok: row.ok,
    issues: row.issues,
    validatedAt: row.validatedAt.toISOString(),
  });

/**
 * generate 全链（P12-01；§92.1）：闸门同 analyze + **须先有 analyze 血缘行**（来源锚）→
 * 插件 generate 切面 → 产物**只追加**落库（**不写回源项目**）。
 */
export async function runPackGenerate(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; packId: string },
): Promise<PackArtifactView> {
  const { manifest, plugin, version } = await resolvePackRuntime(deps, input);

  // 来源锚：analyze 的 PLAN 血缘行（generate 不得凭空产出）
  const lineageRows = await deps.db
    .select()
    .from(derivationLineage)
    .where(and(eq(derivationLineage.workspaceId, input.workspaceId), eq(derivationLineage.projectId, input.projectId), eq(derivationLineage.packId, input.packId)))
    .orderBy(desc(derivationLineage.createdAt))
    .limit(1);
  const lineage = lineageRows[0];
  if (lineage === undefined) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '尚无 analyze 血缘行：请先 analyze 生成规划（来源锚）', 409, {
      reason: PACK_ARTIFACT_ERROR_REASONS.ANALYZE_REQUIRED,
      packId: input.packId,
    });
  }

  if (plugin.generate === undefined) {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, `插件未实现 generate 切面：${manifest.packId}@${manifest.version}`, 501, {
      reason: PACK_ARTIFACT_ERROR_REASONS.PLUGIN_GENERATE_NOT_IMPLEMENTED,
    });
  }
  const context = await buildRestrictedContext(deps, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    manifest,
    packVersion: version,
  });
  const payload = await plugin.generate(context);
  const inserted = await deps.db
    .insert(packArtifacts)
    .values({
      id: `art_${randomUUID()}`,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      packId: manifest.packId,
      packVersion: manifest.version,
      lineageId: lineage.id,
      payloadKind: payload.kind,
      title:
        payload.kind === 'DERIVED_SCENE_GRAPH'
          ? `${payload.topic.title}（${payload.format.aspectRatio} 派生）`
          : payload.kind === 'SOCIAL_VISUAL_SET'
            ? `${payload.topic.title}（图文集 ${String(payload.pages.length)} 页）`
            : `${payload.topic.title}（文字集 ${String(payload.units.length)} 单元）`,
      payload,
    })
    .returning();
  const row = inserted[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'artifact insert failed', 500);
  return packArtifactViewSchema.parse({ ...toArtifactDto(row), latestValidation: null });
}

/** 产物列表（新→旧；附最近一次校验结果——校验历史只追加，旧行不改写）。 */
export async function listProjectArtifacts(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string },
): Promise<PackArtifactView[]> {
  const rows = await deps.db
    .select()
    .from(packArtifacts)
    .where(and(eq(packArtifacts.workspaceId, input.workspaceId), eq(packArtifacts.projectId, input.projectId)))
    .orderBy(desc(packArtifacts.createdAt));
  if (rows.length === 0) return [];
  const validations = await deps.db
    .select()
    .from(packArtifactValidations)
    .where(and(eq(packArtifactValidations.workspaceId, input.workspaceId), eq(packArtifactValidations.projectId, input.projectId)))
    .orderBy(desc(packArtifactValidations.validatedAt));
  const latest = new Map<string, ArtifactValidationResult>();
  for (const validation of validations) {
    if (!latest.has(validation.artifactId)) latest.set(validation.artifactId, toValidationDto(validation));
  }
  return rows.map((row) => packArtifactViewSchema.parse({ ...toArtifactDto(row), latestValidation: latest.get(row.id) ?? null }));
}

/**
 * validate 全链（P12-01）：闸门同 analyze → 插件 validate 切面 →
 * 校验结果**只追加**（历史保留；重校验不改写旧行）。
 */
export async function runPackValidate(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; artifactId: string },
): Promise<ArtifactValidationResult> {
  const artifactRows = await deps.db
    .select()
    .from(packArtifacts)
    .where(and(eq(packArtifacts.id, input.artifactId), eq(packArtifacts.workspaceId, input.workspaceId), eq(packArtifacts.projectId, input.projectId)))
    .limit(1);
  const artifactRow = artifactRows[0];
  if (artifactRow === undefined) {
    throw new ApiFailure(ERROR_CODES.NOT_FOUND, '产物不存在', 404, { reason: PACK_ARTIFACT_ERROR_REASONS.ARTIFACT_NOT_FOUND });
  }
  const { manifest, plugin, version } = await resolvePackRuntime(deps, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    packId: artifactRow.packId,
  });
  if (plugin.validate === undefined) {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, `插件未实现 validate 切面：${manifest.packId}@${manifest.version}`, 501, {
      reason: PACK_ARTIFACT_ERROR_REASONS.PLUGIN_VALIDATE_NOT_IMPLEMENTED,
    });
  }
  const context = await buildRestrictedContext(deps, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    manifest,
    packVersion: version,
  });
  const payload = artifactPayloadSchema.parse(artifactRow.payload);
  const result = await plugin.validate(payload, context);
  const inserted = await deps.db
    .insert(packArtifactValidations)
    .values({
      id: `artval_${randomUUID()}`,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      artifactId: artifactRow.id,
      ok: result.ok,
      issues: result.issues,
    })
    .returning();
  const row = inserted[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'artifact validation insert failed', 500);
  return toValidationDto(row);
}
