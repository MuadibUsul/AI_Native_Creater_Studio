import { randomUUID } from 'node:crypto';
import {
  AI_EDIT_ERROR_REASONS,
  ApiFailure,
  EDIT_PLAN_VERSION,
  ERROR_CODES,
  editOperationSchema,
  editPlanSchema,
  type EditOperation,
  type EditPlan,
  type EditPlanImpact,
  type EditPlanOperation,
  type Scene,
} from '@ancs/contracts';
import { assembleSceneGraph, getProject } from './projects.js';
import type { DomainDeps } from './channels.js';

/**
 * AI Edit 服务（P05-06 / 规范 §37、§52、§55）。
 *
 * 流程：自然语言 prompt + 当前场景图摘要 → LLM 结构化输出（operation 列表 + 理由）
 *   → **契约校验**（每条操作）→ 场景引用校验 → **锁定场景操作剔除（§4.7，绝不自动解锁）**
 *   → 确定性影响估算（before/after 来自现状与操作本身）→ 返回 EditPlan。
 *
 * 纪律：
 * - **计划不落库**：本模块不写任何表——"未 Apply 不改数据库"是结构性保证；
 * - Apply 由客户端调用统一编辑协议（operation 数组 + revision 条件 + 幂等键）——整批在同一事务；
 * - 影响估算与差异预览**不伪造**：只做操作结构推导（无法确定的值标注为 "apply 时由服务端计算"）；
 * - 成本：计划阶段零 Provider 调用（costImpact=NONE）；需要重生成素材的意图必须由用户显式发起（P06）。
 */

export const AI_EDIT_PROMPT_VERSION = 'ai-edit-v1';

const MAX_ATTEMPTS = 2;

/** 计划 LLM 的提示词（约束写入提示词，可审计）。 */
export function buildEditPlanPrompts(input: { prompt: string; scenesDigest: string }): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = [
    '你是视频编辑助手。把用户的自然语言意图翻译为**结构化编辑计划**（JSON），不得输出任何其他文本。',
    '要求：',
    '1) 只使用以下操作类型：update_scene{sceneId,changes}、reorder_scenes{orderedSceneIds}、split_scene{sceneId,atMs}、duplicate_scene{sceneId,afterSceneId}、delete_scene{sceneId}、set_scene_lock{sceneId,locked}。',
    '2) 每条操作必须引用**已存在**的场景 ID（见下方场景清单）；严禁虚构 ID。',
    '3) **不得修改已锁定场景**（清单中标 locked 的场景）：不要为它们生成操作（系统会剔除并告警）。',
    '4) 输出 JSON：{ "rationale": string[], "operations": object[] }；rationale 与 operations 一一对应。',
    '5) 不产生任何 Provider 调用/素材生成意图；需要新素材时请在 rationale 中说明，由用户显式发起。',
    'promptVersion: ' + AI_EDIT_PROMPT_VERSION,
  ].join('\n');
  const userPrompt = [`用户意图：${input.prompt}`, '', '当前场景清单：', input.scenesDigest].join('\n');
  return { systemPrompt, userPrompt };
}

/** 场景清单摘要（确定性；id/类型/时长/锁定/旁白截断）。 */
export function scenesDigestOf(scenes: readonly Scene[]): string {
  return [...scenes]
    .sort((left, right) => left.position - right.position)
    .map(
      (scene) =>
        `- id=${scene.id} position=${String(scene.position)} type=${scene.sceneType} duration=${String(scene.durationMs)}ms locked=${String(scene.locked)} narration="${scene.narration.slice(0, 40)}"`,
    )
    .join('\n');
}

/** 操作的人类摘要 + before/after（before 来自现状；不确定值留给 Apply 时服务端计算）。 */
export function summarizeOperation(scene: Scene | undefined, operation: EditOperation): { summary: string; before: Record<string, unknown>; after: Record<string, unknown> } {
  switch (operation.op) {
    case 'update_scene': {
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(operation.changes)) {
        before[key] = key === 'durationMs' ? scene?.durationMs : key === 'narration' ? scene?.narration : '(apply 时由服务端计算)';
        after[key] = value;
      }
      return { summary: `修改场景 ${operation.sceneId.slice(0, 12)}…：${Object.keys(operation.changes).join(', ')}`, before, after };
    }
    case 'reorder_scenes':
      return { summary: `重排 ${String(operation.orderedSceneIds.length)} 个场景`, before: { order: scene === undefined ? null : scene.position }, after: { order: operation.orderedSceneIds.map((id) => id.slice(0, 12)) } };
    case 'split_scene':
      return { summary: `在 ${String(operation.atMs)}ms 拆分场景 ${operation.sceneId.slice(0, 12)}…`, before: { durationMs: scene?.durationMs ?? null }, after: { atMs: operation.atMs } };
    case 'duplicate_scene':
      return { summary: `复制场景 ${operation.sceneId.slice(0, 12)}…`, before: {}, after: { afterSceneId: operation.afterSceneId } };
    case 'delete_scene':
      return { summary: `删除场景 ${operation.sceneId.slice(0, 12)}…`, before: { durationMs: scene?.durationMs ?? null }, after: {} };
    case 'set_scene_lock':
      return { summary: `${operation.locked ? '锁定' : '解锁'}场景 ${operation.sceneId.slice(0, 12)}…`, before: { locked: scene?.locked ?? null }, after: { locked: operation.locked } };
    default:
      return { summary: `操作：${operation.op}`, before: {}, after: {} };
  }
}

/** 确定性影响估算（只做结构推导；不做"剩余时长"这类需要 Apply 后重算的推算，标注到 notes）。 */
export function computeImpact(scenes: readonly Scene[], operations: readonly EditOperation[]): EditPlanImpact {
  let scenesAdded = 0;
  let scenesRemoved = 0;
  let scenesModified = 0;
  let durationDeltaMs = 0;
  const byId = new Map(scenes.map((scene) => [scene.id, scene]));

  for (const operation of operations) {
    switch (operation.op) {
      case 'update_scene': {
        scenesModified += 1;
        const change = operation.changes.durationMs;
        if (typeof change === 'number') {
          const current = byId.get(operation.sceneId)?.durationMs ?? 0;
          durationDeltaMs += change - current;
        }
        break;
      }
      case 'duplicate_scene':
        scenesAdded += 1;
        durationDeltaMs += byId.get(operation.sceneId)?.durationMs ?? 0;
        break;
      case 'split_scene':
        scenesAdded += 1; // 拆出尾部场景（总时长不变）
        break;
      case 'delete_scene':
        scenesRemoved += 1;
        durationDeltaMs -= byId.get(operation.sceneId)?.durationMs ?? 0;
        break;
      case 'reorder_scenes':
        scenesModified += operation.orderedSceneIds.length;
        break;
      case 'set_scene_lock':
        scenesModified += 1;
        break;
      default:
        scenesModified += 1;
        break;
    }
  }

  return {
    scenesAdded,
    scenesRemoved,
    scenesModified,
    durationDeltaMs,
    costImpact: 'NONE',
    notes: [
      'AI Edit 计划阶段不产生任何 Provider 调用（成本影响：无）。',
      '绝对时间轴（startMs）在 Apply 时由服务端按场景顺序重算；此处不推算。',
    ],
  };
}

/** 过滤锁定场景的操作（§4.7：AI 不得修改锁定场景；返回被剔除的说明，绝不自动解锁）。 */
export function filterLockedOperations(scenes: readonly Scene[], operations: readonly EditOperation[]): { kept: EditOperation[]; warnings: string[] } {
  const locked = new Set(scenes.filter((scene) => scene.locked).map((scene) => scene.id));
  const warnings: string[] = [];
  const kept = operations.filter((operation) => {
    const sceneId = 'sceneId' in operation ? operation.sceneId : null;
    if (sceneId !== null && locked.has(sceneId)) {
      warnings.push(`已跳过对锁定场景 ${sceneId.slice(0, 12)}… 的操作（${operation.op}）：AI 不得修改锁定场景（§4.7），如需修改请先显式解锁。`);
      return false;
    }
    return true;
  });
  return { kept, warnings };
}

/** 场景引用校验（不得虚构操作目标）。 */
export function assertSceneReferences(scenes: readonly Scene[], operations: readonly EditOperation[]): void {
  const known = new Set(scenes.map((scene) => scene.id));
  for (const operation of operations) {
    const ids: string[] = [];
    if ('sceneId' in operation && operation.sceneId !== null) ids.push(operation.sceneId);
    if (operation.op === 'duplicate_scene' && operation.afterSceneId !== null) ids.push(operation.afterSceneId);
    if (operation.op === 'reorder_scenes') ids.push(...operation.orderedSceneIds);
    for (const id of ids) {
      if (!known.has(id)) {
        throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, `计划引用了不存在的场景：${id}`, 422, {
          reason: AI_EDIT_ERROR_REASONS.UNKNOWN_SCENE_REFERENCE,
          sceneId: id,
          operation: operation.op,
        });
      }
    }
    if (operation.op === 'insert_scene') {
      const createdId = operation.createdSceneId ?? operation.restoreSceneId;
      if (createdId !== undefined) known.add(createdId);
    } else if (operation.op === 'duplicate_scene') {
      const createdId = operation.createdSceneId ?? operation.restoreSceneId;
      if (createdId !== undefined) known.add(createdId);
    } else if (operation.op === 'split_scene') {
      const createdId = operation.createdTailSceneId ?? operation.restoreTailSceneId;
      if (createdId !== undefined) known.add(createdId);
    } else if (operation.op === 'delete_scene') {
      known.delete(operation.sceneId);
    }
  }
}

interface RawPlan {
  rationale?: unknown;
  operations?: unknown;
}

const parseRawPlan = (content: string): RawPlan => {
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
    return parsed as RawPlan;
  } catch {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'AI Edit：模型输出不是合法 JSON', 422, {
      reason: AI_EDIT_ERROR_REASONS.INVALID_PLAN,
    });
  }
};

/** 生成编辑计划（**不落库**；未 Apply 前不改变任何数据）。 */
export async function planAiEdit(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; prompt: string; createdBy?: string | null },
): Promise<EditPlan> {
  const prompt = input.prompt.trim();
  if (prompt === '') {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'AI Edit：意图不能为空', 400, { reason: AI_EDIT_ERROR_REASONS.EMPTY_PROMPT });
  }
  const adapter = deps.llm;
  if (adapter === undefined || adapter.completePrompt === undefined) {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'AI Edit：当前 LLM 适配器不支持结构化补全（fail-closed）', 501, {
      reason: AI_EDIT_ERROR_REASONS.LLM_UNSUPPORTED,
    });
  }

  const project = await getProject(deps, { workspaceId: input.workspaceId, projectId: input.projectId });
  const graph = await assembleSceneGraph(deps, { workspaceId: input.workspaceId, projectId: input.projectId });
  const scenes = graph.scenes;

  const { systemPrompt, userPrompt } = buildEditPlanPrompts({ prompt, scenesDigest: scenesDigestOf(scenes) });

  let lastError: ApiFailure | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    // 上游错误原样上抛（不伪装为 422；与 P04-03 同一纪律）
    const completion = await adapter.completePrompt({ purpose: 'ai_edit', systemPrompt, userPrompt });
    const raw = parseRawPlanSafe(completion.content);
    if (!raw.ok) {
      lastError = raw.error;
      continue;
    }
    const operations: EditOperation[] = [];
    let invalid = false;
    const rawOperations = Array.isArray(raw.plan.operations) ? raw.plan.operations : [];
    for (const candidate of rawOperations) {
      const parsed = editOperationSchema.safeParse(candidate);
      if (!parsed.success) {
        lastError = new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'AI Edit：计划包含非法的操作结构', 422, {
          reason: AI_EDIT_ERROR_REASONS.INVALID_PLAN,
          issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        });
        invalid = true;
        break;
      }
      operations.push(parsed.data);
    }
    if (invalid) continue;

    assertSceneReferences(scenes, operations);
    const { kept, warnings } = filterLockedOperations(scenes, operations);
    if (kept.length === 0) {
      throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'AI Edit：计划没有可应用的变更（可能全部被锁定约束剔除）', 422, {
        reason: AI_EDIT_ERROR_REASONS.NO_CHANGES,
        warnings,
        lockedScenes: scenes.filter((scene) => scene.locked).map((scene) => scene.id),
      });
    }

    const byId = new Map(scenes.map((scene) => [scene.id, scene]));
    const planOperations: EditPlanOperation[] = kept.map((operation) => {
      const sceneId = 'sceneId' in operation ? operation.sceneId : null;
      const { summary, before, after } = summarizeOperation(sceneId === null ? undefined : byId.get(sceneId), operation);
      return { operation, summary, sceneId, before, after };
    });
    const rationale = Array.isArray(raw.plan.rationale) ? raw.plan.rationale.filter((entry): entry is string => typeof entry === 'string') : [];

    return editPlanSchema.parse({
      schemaVersion: '0.1',
      planVersion: EDIT_PLAN_VERSION,
      planId: `edp_${randomUUID()}`,
      projectId: input.projectId,
      baseProjectRevision: project.revision,
      prompt,
      rationale,
      operations: planOperations,
      impact: computeImpact(scenes, kept),
      warnings,
      generation: {
        method: 'LLM',
        providerId: adapter.providerId,
        modelVersion: completion.modelVersion ?? null,
        promptVersion: completion.promptVersion ?? AI_EDIT_PROMPT_VERSION,
        attempts: attempt,
      },
    });
  }

  throw (
    lastError ??
    new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'AI Edit：模型输出无法解析为编辑计划', 422, { reason: AI_EDIT_ERROR_REASONS.INVALID_PLAN })
  );
}

const parseRawPlanSafe = (content: string): { ok: true; plan: RawPlan } | { ok: false; error: ApiFailure } => {
  try {
    return { ok: true, plan: parseRawPlan(content) };
  } catch (error) {
    if (error instanceof ApiFailure) return { ok: false, error };
    throw error;
  }
};
