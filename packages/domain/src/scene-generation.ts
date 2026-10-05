import { and, eq, sql } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  GENERATE_JOB_TYPE,
  type Job,
  type ProviderRouteDecision,
} from '@ancs/contracts';
import { jobs, projects, scenes } from '@ancs/db';
import { createJob, toJobDto } from './jobs.js';
import { resolveProviderRoute } from './credentials.js';
import type { DomainDeps } from './channels.js';

/**
 * 显式生成动作（P06-05 / §2.8、§14.4、§16、§45）。
 *
 * 纪律：
 * - **只有用户显式发起**才创建生成任务（编辑器"生成素材"按钮）——绝无隐式/自动提交；
 * - **双击只提交一次**：去重键由 (项目, 场景, 场景 revision, 能力) 派生并写入任务输入；
 *   已存在未终止失败的同键任务 → 直接返回该任务（deduped=true）；
 * - **输入最小化**（§2.8/REQ-2-07）：任务输入只含完成该 Scene 所需的最少数据（场景类型/提示/时长/画幅），
 *   **不携带文章正文、来源原文或其它场景数据**；
 * - **AI Video 使用边界**（§14.4）：数据图表/利率曲线/真实财经数字/来源引用类场景禁止走视频生成（422）；
 * - **能力缺失 → 明确阻止**：Router 无可用候选（未核验/无凭据）→ 501（fail-closed，不排队空任务）。
 */

/** 数据/证据类语义与场景类型：禁止使用 AI Video（§14.4）。 */
export const AI_VIDEO_FORBIDDEN_SEMANTIC = new Set(['NUMBER', 'KPI_SET', 'TREND', 'COMPARISON', 'RANKING', 'QUOTE', 'SOURCE', 'DOCUMENT', 'YIELD_SPREAD', 'YIELD_CURVE', 'PRICE_SERIES', 'CANDLE_SERIES', 'PERCENT_CHANGE', 'BALANCE_SHEET', 'SUPPLY_DEMAND', 'TRADE_FLOW', 'CAPITAL_FLOW', 'POLICY_PATH', 'SCENARIO_COMPARE']);
export const AI_VIDEO_FORBIDDEN_SCENE_TYPES = new Set(['BIG_NUMBER', 'KPI_GRID', 'LINE_CHART', 'DUAL_LINE_CHART', 'BAR_CHART', 'SPREAD_AREA_CHART', 'SOURCE_CARD', 'QUOTE_CARD', 'DOCUMENT_HIGHLIGHT', 'NEWS_HEADLINE', 'MAP_STATIC', 'TIMELINE',
  // P10-04 扩展数据类型同样禁止 AI Video（§14.4：数据/来源类不得由生成画面冒充）
  'AREA_CHART', 'STACKED_BAR_CHART', 'NUMBER_COMPARE', 'PERCENT_DELTA', 'MAP_ZOOM', 'MAP_FLOW', 'PROCESS_FLOW']);

export interface SceneGenerationResult {
  job: Job;
  /** true = 命中去重（返回既有任务；未重复提交/计费） */
  deduped: boolean;
  providerRoute: { providerId: string; modelId: string; credentialMode: string; reason: string };
}

/** 去重键（双击/重试同一次生成的唯一标识）。 */
export const sceneGenerationDedupeKey = (input: { projectId: string; sceneId: string; sceneRevision: number; capability: string }): string =>
  `gen:${input.projectId}:${input.sceneId}:r${String(input.sceneRevision)}:${input.capability}`;

/** 终态失败：允许再次显式提交（用户重试）；其余状态视为"已在途/已成功" → 去重返回。 */
const TERMINAL_RETRYABLE = new Set(['FAILED_FINAL', 'CANCELLED']);

export async function requestSceneGeneration(
  deps: DomainDeps,
  input: {
    workspaceId: string;
    projectId: string;
    sceneId: string;
    capability?: string;
    actorId?: string | null;
  },
): Promise<SceneGenerationResult> {
  const capability = input.capability ?? 'video.generate';

  const sceneRows = await deps.db
    .select()
    .from(scenes)
    .where(and(eq(scenes.id, input.sceneId), eq(scenes.workspaceId, input.workspaceId), eq(scenes.projectId, input.projectId)))
    .limit(1);
  const scene = sceneRows[0];
  if (!scene) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'scene not found', 404);

  const projectRows = await deps.db
    .select({ aspectRatio: projects.aspectRatio, resolution: projects.resolution })
    .from(projects)
    .where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, input.workspaceId)))
    .limit(1);
  const project = projectRows[0];
  if (!project) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'project not found', 404);

  // ① AI Video 使用边界（§14.4）：数据/证据类一律禁止
  if (capability === 'video.generate') {
    if (AI_VIDEO_FORBIDDEN_SEMANTIC.has(scene.semanticType) || AI_VIDEO_FORBIDDEN_SCENE_TYPES.has(scene.sceneType)) {
      throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'AI Video 不得用于数据图表/利率曲线/真实财经数字/来源引用（§14.4）：请使用标准数据组件', 422, {
        reason: 'AI_VIDEO_BOUNDARY_VIOLATION',
        sceneId: scene.id,
        sceneType: scene.sceneType,
        semanticType: scene.semanticType,
      });
    }
  }

  // ② 显式生成只允许"素材类"场景（视频/图片/头像），避免误对文字/结构场景提交昂贵调用
  const assetDriven = new Set(['AI_VIDEO', 'IMAGE_FULL', 'REAL_BROLL', 'HOST_FULL', 'HOST_SIDE']);
  if (!assetDriven.has(scene.sceneType)) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, `场景类型 ${scene.sceneType} 不是素材生成类场景：无需 Provider 生成（标准组件本地渲染）`, 422, {
      reason: 'SCENE_NOT_ASSET_DRIVEN',
      sceneId: scene.id,
      sceneType: scene.sceneType,
    });
  }

  // ③ 能力路由（fail-closed：无可用候选 → 501；未核验目录不排队空任务）
  let route: ProviderRouteDecision;
  try {
    route = await resolveProviderRoute(deps, { workspaceId: input.workspaceId, capability });
  } catch (error) {
    if (error instanceof ApiFailure && error.code === ERROR_CODES.CAPABILITY_UNAVAILABLE) {
      throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, `能力「${capability}」当前没有可用 Provider（未核验/无凭据）：生成被明确阻止`, 501, {
        reason: 'NO_CALLABLE_PROVIDER',
        capability,
        rejected: error.details['rejected'] ?? [],
      });
    }
    throw error;
  }
  if (route.decision === null) {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, `能力「${capability}」当前没有可用 Provider：生成被明确阻止`, 501, {
      reason: 'NO_CALLABLE_PROVIDER',
      capability,
    });
  }

  const dedupeKey = sceneGenerationDedupeKey({ projectId: input.projectId, sceneId: scene.id, sceneRevision: scene.revision, capability });

  // ④ 去重：同键且非"终态失败"的任务直接返回（双击只提交一次）
  const existingRows = await deps.db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.workspaceId, input.workspaceId),
        eq(jobs.projectId, input.projectId),
        eq(jobs.type, GENERATE_JOB_TYPE),
        sql`${jobs.input}->>'dedupeKey' = ${dedupeKey}`,
      ),
    )
    .limit(1);
  const existing = existingRows[0];
  if (existing !== undefined && !TERMINAL_RETRYABLE.has(existing.status)) {
    return {
      job: toJobDto(existing),
      deduped: true,
      providerRoute: { providerId: route.decision.providerId, modelId: route.decision.modelId, credentialMode: route.decision.credentialMode, reason: route.decision.reason },
    };
  }

  // ⑤ 输入最小化（§2.8）：只含完成该 Scene 所需的最少数据——无正文、无来源原文、无其它场景
  const jobInput = {
    providerId: route.decision.providerId,
    modelId: route.decision.modelId,
    operation: capability,
    credentialMode: route.decision.credentialMode,
    inputHash: `scene:${scene.id}:r${String(scene.revision)}`,
    estimatedCredits: null,
    dedupeKey,
    scene: {
      sceneId: scene.id,
      sceneRevision: scene.revision,
      sceneType: scene.sceneType,
      semanticType: scene.semanticType,
      durationMs: scene.durationMs,
      prompt: scene.visualIntent === '' ? String((scene.props as Record<string, unknown>)['prompt'] ?? '') : scene.visualIntent,
      format: { aspectRatio: project.aspectRatio, resolution: project.resolution },
    },
  };

  const job = await createJob(deps, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    type: GENERATE_JOB_TYPE,
    input: jobInput,
    createdBy: input.actorId ?? null,
  });
  return {
    job,
    deduped: false,
    providerRoute: { providerId: route.decision.providerId, modelId: route.decision.modelId, credentialMode: route.decision.credentialMode, reason: route.decision.reason },
  };
}
