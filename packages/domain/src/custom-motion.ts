import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import {
  ApiFailure,
  CUSTOM_MOTION_ERROR_REASONS,
  CUSTOM_MOTION_SCENE_TYPE,
  ERROR_CODES,
  MOTION_DEPENDENCY_WHITELIST,
  MOTION_GENERATE_JOB_TYPE,
  MOTION_PROMPT_VERSION,
  customMotionComponentSchema,
  customMotionComponentVersionSchema,
  motionComponentDraftSchema,
  motionGenerationInputSchema,
  motionValidationFixtureSchema,
  motionSampleFrames,
  motionValidationReportSchema,
  type CustomMotionComponent,
  type CustomMotionComponentVersion,
  type Job,
  type MotionGenerationInput,
  type MotionValidationFixture,
  type MotionValidator,
} from '@ancs/contracts';
import { customMotionComponentVersions, customMotionComponents, jobs, scenes } from '@ancs/db';
import type { DomainDeps } from './deps.js';
import { getProjectDetail } from './projects.js';
import { createJob, getJob } from './jobs.js';
import { assertCustomMotionBudget } from './plans.js';

/**
 * Custom Motion 生成服务（P07-02 / 规范 §11.2；计划 §8 P07-02）。
 *
 * 链路：CUSTOM_MOTION 场景 →（入队 MOTION_GENERATE）→ LLM 结构化输出（代码/依赖）
 *   → 四道门禁（静态分析 → 类型检查 → 沙箱评估 → 抽帧；由注入的 MotionValidator 实现）
 *   → **仅 APPROVED 版本化落库**（代码/依赖/输入/产物落自有存储）；拒绝只留在任务错误中。
 *
 * 纪律：
 * - 生成代码默认零依赖（MOTION_DEPENDENCY_WHITELIST 空集；模块加载词法一律被沙箱拒绝）；
 * - 版本不可变（append-only；同组件再生成 = 新版本行）；
 * - 校验的是"将要落库的那份代码"（report.sourceSha256 与落库 codeSha256 逐字节一致）。
 */

const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** 提示词（安全约束来自 §11.2 MUST：无网络/文件/进程/Secret/动态执行；沙箱为代码契约的权威描述） */
export function buildMotionDesignPrompts(input: {
  name: string;
  sceneType: string;
  narration: string;
  visualIntent: string;
  durationMs: number;
  aspectRatio: string;
  themeTokens: MotionGenerationInput['themeTokens'];
  props: Record<string, unknown>;
  brief: string | null;
}): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = `promptVersion: ${MOTION_PROMPT_VERSION}
你是 Motion Designer Agent：为单个视频场景生成一个独立的 Remotion/React 风格动效组件（Custom Motion）。

代码契约（沙箱执行，违反即被拒绝）：
1) 提交的 code 是**纯 JavaScript 脚本**（无 JSX、无 TypeScript 类型、无 import/require/export）；
2) 脚本必须在顶层调用 registerMotion({ name, component })；
3) component 是函数 (props) => ReactElement，只能用以下**注入全局**（其他全局不存在）：
   React.createElement、useState（只读取初值）、useMemo、useRef、useEffect（no-op）、
   useCurrentFrame()、useVideoConfig()、interpolate(input, inputRange, outputRange, {extrapolateLeft/Right})、
   spring()、AbsoluteFill、Math/JSON/Number/String/Boolean/Array/Object/isFinite/isNaN/parseFloat/parseInt；
4) 严禁出现（词法门禁直接拒绝）：fetch/XMLHttpRequest/WebSocket、import/require、fs/child_process、
   process/env、eval/Function/vm、globalThis/window/self、__proto__；
5) 动画必须**确定性**：只允许基于 useCurrentFrame() 计算（不得使用 Date.now/随机数）；
6) 视觉遵循传入的品牌 tokens（props.theme：color/font/spacing/radius）；
7) 画布由外层 AbsoluteFill 保证；组件可以再嵌套 AbsoluteFill 布局；文字使用 props.narration 或 brief 中的要点。

输出**仅一个 JSON 对象**（无 markdown 围栏、无多余文字）：
{"name": "<PascalCase 组件名>", "description": "<一句话>", "code": "<完整脚本字符串>", "dependencies": []}
dependencies 必须为空数组（V1 白名单 = 空集）。`;

  const userPrompt = `场景类型：${input.sceneType}
建议组件名：${input.name}
画幅：${input.aspectRatio}
时长：${String(input.durationMs)}ms
旁白：${input.narration === '' ? '（无）' : input.narration}
视觉意图：${input.visualIntent === '' ? '（无）' : input.visualIntent}
补充要求：${input.brief ?? '（无）'}
fixtureProps（组件将收到的最小输入样例，必须能容错渲染）：${JSON.stringify(input.props)}
品牌 tokens：${JSON.stringify(input.themeTokens ?? {})}`;

  return { systemPrompt, userPrompt };
}

/** 解析 LLM 输出为草稿（唯一被接受的形态；失败 = INVALID_LLM_OUTPUT）。 */
export function parseMotionDraft(content: string): ReturnType<typeof motionComponentDraftSchema.parse> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'Motion 生成：模型输出不是合法 JSON', 422, {
      reason: CUSTOM_MOTION_ERROR_REASONS.INVALID_LLM_OUTPUT,
    });
  }
  const draft = motionComponentDraftSchema.safeParse(parsed);
  if (!draft.success) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'Motion 生成：输出不符合结构化契约', 422, {
      reason: CUSTOM_MOTION_ERROR_REASONS.INVALID_LLM_OUTPUT,
      issues: draft.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
  }
  return draft.data;
}

/** 依赖白名单校验（§11.2-3："只允许白名单依赖"——V1 白名单为空集）。 */
export function assertDependenciesAllowed(dependencies: readonly string[]): void {
  const offenders = dependencies.filter((dependency) => !MOTION_DEPENDENCY_WHITELIST.includes(dependency));
  if (offenders.length > 0) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, `Motion 生成：声明了白名单之外的依赖：${offenders.join(', ')}`, 422, {
      reason: CUSTOM_MOTION_ERROR_REASONS.DEPENDENCY_NOT_ALLOWED,
      offenders,
      whitelist: [...MOTION_DEPENDENCY_WHITELIST],
    });
  }
}

/** 生成入口（入队；API 调用）——只做形态校验与任务创建，不触 LLM/沙箱。 */
export async function startCustomMotionGeneration(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; sceneId: string; brief?: string | null; requestedBy?: string | null },
): Promise<{ job: Job; dedupeKey: string; reused: boolean }> {
  const sceneRows = await deps.db
    .select()
    .from(scenes)
    .where(and(eq(scenes.id, input.sceneId), eq(scenes.projectId, input.projectId), eq(scenes.workspaceId, input.workspaceId)))
    .limit(1);
  const scene = sceneRows[0];
  if (scene === undefined) {
    throw new ApiFailure(ERROR_CODES.NOT_FOUND, '场景不存在（或跨工作区）', 404, { reason: CUSTOM_MOTION_ERROR_REASONS.SCENE_NOT_FOUND });
  }
  if (scene.sceneType !== CUSTOM_MOTION_SCENE_TYPE) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, `Motion 生成只服务 ${CUSTOM_MOTION_SCENE_TYPE} 场景（当前：${scene.sceneType}）`, 422, {
      reason: CUSTOM_MOTION_ERROR_REASONS.SCENE_NOT_FOUND,
      sceneType: scene.sceneType,
    });
  }
  // P09-01：Custom Motion 月度预算强制执行（生成入口）
  await assertCustomMotionBudget(deps, { workspaceId: input.workspaceId });

  const brief = input.brief ?? null;
  const dedupeKey = `motion:${input.projectId}:${input.sceneId}:${sha256Hex(brief ?? '').slice(0, 16)}`;

  // 去重：同（项目, 场景, brief）存在未终态任务 → 复用（重复点击不重复生成/计费）
  const active = await deps.db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.workspaceId, input.workspaceId),
        eq(jobs.type, MOTION_GENERATE_JOB_TYPE),
        sql`(${jobs.input} ->> 'dedupeKey') = ${dedupeKey}`,
        notInArray(jobs.status, ['SUCCEEDED', 'FAILED_FINAL', 'CANCELLED']),
      ),
    )
    .limit(1);
  if (active[0] !== undefined) {
    const job = await getJob(deps, { workspaceId: input.workspaceId, jobId: active[0].id });
    return { job, dedupeKey, reused: true };
  }

  const job = await createJob(deps, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    type: 'MOTION_GENERATE',
    input: { workspaceId: input.workspaceId, projectId: input.projectId, sceneId: input.sceneId, brief, requestedBy: input.requestedBy ?? null, dedupeKey },
    maxAttempts: 2,
    createdBy: input.requestedBy ?? null,
  });
  return { job, dedupeKey, reused: false };
}

export interface MotionSceneContext {
  id: string;
  revision: number;
  sceneType: string;
  narration: string;
  visualIntent: string;
  durationMs: number;
  props: Record<string, unknown>;
}

/** 验证 fixture（确定性：帧/画幅/时长固定；沙箱 smoke 与抽帧共用）。 */
export function buildMotionFixture(input: {
  scene: MotionSceneContext;
  fps: number;
  width: number;
  height: number;
  fixtureProps: Record<string, unknown>;
}): MotionValidationFixture {
  return motionValidationFixtureSchema.parse({
    props: input.fixtureProps,
    fps: input.fps,
    durationInFrames: Math.max(1, Math.round((input.scene.durationMs / 1000) * input.fps)),
    width: input.width,
    height: input.height,
  });
}

/** 组装生成输入（LLM 看到什么就存什么——可审计快照）。 */
export function buildMotionGenerationInput(input: {
  scene: MotionSceneContext;
  aspectRatio: string;
  fixture: MotionValidationFixture;
  themeTokens: MotionGenerationInput['themeTokens'];
  brief: string | null;
  llmModel: string;
}): MotionGenerationInput {
  const aspectRatio = (['16:9', '9:16', '1:1', '4:5'] as const).includes(input.aspectRatio as never)
    ? (input.aspectRatio as MotionGenerationInput['aspectRatio'])
    : '16:9';
  return motionGenerationInputSchema.parse({
    sceneId: input.scene.id,
    sceneRevision: input.scene.revision,
    sceneType: input.scene.sceneType,
    narration: input.scene.narration,
    visualIntent: input.scene.visualIntent,
    durationMs: input.scene.durationMs,
    aspectRatio,
    themeTokens: input.themeTokens,
    fixture: input.fixture,
    brief: input.brief,
    promptVersion: MOTION_PROMPT_VERSION,
    llmModel: input.llmModel,
  });
}

export interface RunCustomMotionResult {
  componentId: string;
  versionId: string;
  versionNumber: number;
  name: string;
  codeSha256: string;
  sourceStorageKey: string;
  framesStorageKey: string;
  frames: number;
  renderMs: number | null;
}

/**
 * 生成 + 门禁 + 落库（由 Worker 处理器调用；validator 注入——进程隔离实现见 apps/motion-worker）。
 * 校验失败 → 抛 ApiFailure（携带完整 report；**不落任何行/对象**）。
 */
export async function runCustomMotionGeneration(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; sceneId: string; brief: string | null; validator: MotionValidator; createdBy?: string | null },
): Promise<RunCustomMotionResult> {
  const adapter = deps.llm;
  if (adapter === undefined || adapter.completePrompt === undefined) {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'Motion 生成：当前 LLM 适配器不支持结构化补全（fail-closed）', 501, {
      reason: CUSTOM_MOTION_ERROR_REASONS.LLM_UNAVAILABLE,
    });
  }
  const storage = deps.storage;
  if (storage === undefined) {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'Motion 生成：产物必须落自有存储（fail-closed）', 501, {
      reason: CUSTOM_MOTION_ERROR_REASONS.STORAGE_UNAVAILABLE,
    });
  }

  const sceneRows = await deps.db
    .select()
    .from(scenes)
    .where(and(eq(scenes.id, input.sceneId), eq(scenes.projectId, input.projectId), eq(scenes.workspaceId, input.workspaceId)))
    .limit(1);
  const scene = sceneRows[0];
  if (scene === undefined) {
    throw new ApiFailure(ERROR_CODES.NOT_FOUND, '场景不存在（或跨工作区）', 404, { reason: CUSTOM_MOTION_ERROR_REASONS.SCENE_NOT_FOUND });
  }

  // 项目快照（样式版本/画幅/帧率）：主题与画幅来自创建时冻结的 Channel 快照（不受后续修改影响）
  const detail = await getProjectDetail(deps, { workspaceId: input.workspaceId, projectId: input.projectId });
  const themeTokens = detail.channelSnapshot.defaults.themeTokens;
  const resolutionParts = detail.resolution.split('x').map((part) => Number.parseInt(part, 10));
  const format = { fps: detail.fps, width: resolutionParts[0] ?? 1920, height: resolutionParts[1] ?? 1080 };
  const aspectRatio = detail.aspectRatio;

  const sceneProps = scene.props as Record<string, unknown>;
  const fixtureProps = { ...sceneProps, theme: themeTokens ?? undefined, narration: scene.narration };
  const sceneContext: MotionSceneContext = { id: scene.id, revision: scene.revision, sceneType: scene.sceneType, narration: scene.narration, visualIntent: scene.visualIntent, durationMs: scene.durationMs, props: sceneProps };
  const fixture = buildMotionFixture({ scene: sceneContext, fps: format.fps, width: format.width, height: format.height, fixtureProps });
  const sampleFrames = motionSampleFrames(fixture.durationInFrames);
  const proposedName = `Motion${scene.id.replace(/[^A-Za-z0-9]/g, '').slice(-8)}`;

  const { systemPrompt, userPrompt } = buildMotionDesignPrompts({
    name: proposedName,
    sceneType: scene.sceneType,
    narration: scene.narration,
    visualIntent: scene.visualIntent,
    durationMs: scene.durationMs,
    aspectRatio,
    themeTokens,
    props: fixtureProps,
    brief: input.brief,
  });
  const completion = await adapter.completePrompt({ purpose: 'motion_design', systemPrompt, userPrompt });
  const draft = parseMotionDraft(completion.content);
  assertDependenciesAllowed(draft.dependencies);

  // 门禁（validator 实现必须遵守 §11.2：隔离沙箱/无网络/零依赖/类型检查/静态分析/超时）
  const report = motionValidationReportSchema.parse(
    await input.validator.validate({ code: draft.code, name: draft.name, fixture, sampleFrames }),
  );
  const codeSha256 = sha256Hex(draft.code);
  if (report.sourceSha256 !== codeSha256) {
    throw new ApiFailure(ERROR_CODES.INTERNAL, 'Motion 门禁报告与代码字节不一致（验的不是将落库的版本）', 500, {
      reason: CUSTOM_MOTION_ERROR_REASONS.VALIDATION_REJECTED,
      expected: codeSha256,
      actual: report.sourceSha256,
    });
  }
  if (report.verdict !== 'APPROVED') {
    const failed = report.stages.filter((stage) => !stage.ok);
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, `Motion 门禁未通过（${failed.map((stage) => stage.stage).join(' → ') || '未知阶段'}）`, 422, {
      reason: CUSTOM_MOTION_ERROR_REASONS.VALIDATION_REJECTED,
      report,
    });
  }

  // 仅 APPROVED 落库：代码/依赖/输入/产物（版本化）
  const generationInput = buildMotionGenerationInput({
    scene: sceneContext,
    aspectRatio,
    fixture,
    themeTokens,
    brief: input.brief,
    llmModel: completion.modelVersion ?? 'unknown',
  });

  // 组件身份：同 (项目, 场景, 名称) 复用；否则新建
  const existingRows = await deps.db
    .select()
    .from(customMotionComponents)
    .where(and(eq(customMotionComponents.projectId, input.projectId), eq(customMotionComponents.sceneId, input.sceneId), eq(customMotionComponents.name, draft.name)))
    .limit(1);
  const componentId = existingRows[0]?.id ?? `cmc_${randomUUID()}`;
  const versionNumber = (existingRows[0]?.latestVersionNumber ?? 0) + 1;
  const versionId = `cmv_${randomUUID()}`;
  const baseKey = `workspaces/${input.workspaceId}/projects/${input.projectId}/motion/${componentId}/v${String(versionNumber)}`;
  const sourceStorageKey = `${baseKey}/source.js`;
  const framesStorageKey = `${baseKey}/frames.json`;
  const framesArtifact = {
    schemaVersion: 'motion-frames-v1',
    codeSha256,
    fixture,
    sampleFrames,
    frames: report.frames,
  };
  await storage.putObject(sourceStorageKey, new TextEncoder().encode(draft.code));
  await storage.putObject(framesStorageKey, new TextEncoder().encode(JSON.stringify(framesArtifact, null, 2)));

  await deps.db.transaction(async (tx) => {
    if (existingRows[0] === undefined) {
      await tx.insert(customMotionComponents).values({
        id: componentId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        sceneId: input.sceneId,
        name: draft.name,
        latestVersionNumber: 0,
      });
    }
    await tx.insert(customMotionComponentVersions).values({
      id: versionId,
      componentId,
      workspaceId: input.workspaceId,
      versionNumber,
      name: draft.name,
      description: draft.description,
      code: draft.code,
      codeSha256,
      dependencies: draft.dependencies,
      input: generationInput,
      validation: report,
      sourceStorageKey,
      framesStorageKey,
      createdBy: input.createdBy ?? null,
    });
    await tx
      .update(customMotionComponents)
      .set({ latestVersionNumber: versionNumber, updatedAt: new Date() })
      .where(eq(customMotionComponents.id, componentId));
  });

  return {
    componentId,
    versionId,
    versionNumber,
    name: draft.name,
    codeSha256,
    sourceStorageKey,
    framesStorageKey,
    frames: report.frames.length,
    renderMs: report.renderMs,
  };
}

/* ---------- 读取（API/UI） ---------- */

const toVersionDto = (row: typeof customMotionComponentVersions.$inferSelect, projectId: string): CustomMotionComponentVersion =>
  customMotionComponentVersionSchema.parse({
    id: row.id,
    componentId: row.componentId,
    workspaceId: row.workspaceId,
    projectId,
    sceneId: (row.input as { sceneId: string }).sceneId,
    versionNumber: row.versionNumber,
    name: row.name,
    description: row.description,
    code: row.code,
    codeSha256: row.codeSha256,
    dependencies: row.dependencies,
    input: row.input,
    validation: row.validation,
    sourceStorageKey: row.sourceStorageKey,
    framesStorageKey: row.framesStorageKey,
    createdAt: row.createdAt.toISOString(),
  });

/** 项目下的组件列表（含最新版本）。 */
export async function listCustomMotionComponents(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; sceneId?: string },
): Promise<CustomMotionComponent[]> {
  const conditions = [eq(customMotionComponents.workspaceId, input.workspaceId), eq(customMotionComponents.projectId, input.projectId)];
  if (input.sceneId !== undefined) conditions.push(eq(customMotionComponents.sceneId, input.sceneId));
  const rows = await deps.db
    .select()
    .from(customMotionComponents)
    .where(and(...conditions))
    .orderBy(desc(customMotionComponents.createdAt));
  if (rows.length === 0) return [];
  const versionRows = await deps.db
    .select()
    .from(customMotionComponentVersions)
    .where(inArray(customMotionComponentVersions.componentId, rows.map((row) => row.id)));
  const latestByComponent = new Map<string, typeof versionRows[number]>();
  for (const version of versionRows) {
    const current = latestByComponent.get(version.componentId);
    if (current === undefined || version.versionNumber > current.versionNumber) latestByComponent.set(version.componentId, version);
  }
  return rows.map((row) => {
    const latest = latestByComponent.get(row.id);
    return customMotionComponentSchema.parse({
      id: row.id,
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      sceneId: row.sceneId,
      name: row.name,
      latestVersionNumber: row.latestVersionNumber,
      latestVersion: latest === undefined ? null : toVersionDto(latest, row.projectId),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });
  });
}

/** 组件详情（全部版本，新→旧）。 */
export async function getCustomMotionComponent(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; componentId: string },
): Promise<{ component: CustomMotionComponent; versions: CustomMotionComponentVersion[] }> {
  const rows = await deps.db
    .select()
    .from(customMotionComponents)
    .where(and(eq(customMotionComponents.id, input.componentId), eq(customMotionComponents.workspaceId, input.workspaceId), eq(customMotionComponents.projectId, input.projectId)))
    .limit(1);
  const component = rows[0];
  if (component === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'Custom Motion 组件不存在（或跨工作区）', 404);
  const versionRows = await deps.db
    .select()
    .from(customMotionComponentVersions)
    .where(eq(customMotionComponentVersions.componentId, component.id))
    .orderBy(desc(customMotionComponentVersions.versionNumber));
  const versions = versionRows.map((row) => toVersionDto(row, component.projectId));
  return {
    component: customMotionComponentSchema.parse({
      id: component.id,
      workspaceId: component.workspaceId,
      projectId: component.projectId,
      sceneId: component.sceneId,
      name: component.name,
      latestVersionNumber: component.latestVersionNumber,
      latestVersion: versions[0] ?? null,
      createdAt: component.createdAt.toISOString(),
      updatedAt: component.updatedAt.toISOString(),
    }),
    versions,
  };
}

