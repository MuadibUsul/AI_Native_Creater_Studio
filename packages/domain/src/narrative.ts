import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  MAX_LLM_ATTEMPTS,
  NARRATIVE_ERROR_REASONS,
  narrativeGenerationRequestSchema,
  narrativeGenerationResultSchema,
  narrativePlanSchema,
  updateNarrationBlockRequestSchema,
  type LlmAdapter,
  type NarrationBlock,
  type NarrativeGenerationRequest,
  type NarrativeGenerationResult,
  type NarrativePlan,
  type UpdateNarrationBlockRequest,
} from '@ancs/contracts';
import { claims, contentBlocks, contentDocuments, narrationBlocks, narrativePlans } from '@ancs/db';
import { buildNarrativePrompts, NARRATIVE_PROMPT_VERSION, repairNarrativePlan } from './narrative-repair.js';
import type { DomainDeps } from './channels.js';

/**
 * Narrative 服务（P04-03 / 规范 §8、§52；计划 P04-03）。
 *
 * 流程：ContentDocument + Claims（含锁定/事实类型）→ 结构化生成请求（**不含原始 HTML**）
 *   → LLM 适配器（真实或 Mock）→ **Schema 校验 + 有限修复**（有界；超限即 422）
 *   → 锁定旁白逐字保留 → 口语化门控（§8.2）→ 版本化落库（narrative_plans + narration_blocks）。
 *
 * 有限重试（§52 retry-repair）：**至多 MAX_LLM_ATTEMPTS 次**；第二次仍失败 → 明确失败（不无限重试）。
 */

function requireLlm(deps: DomainDeps): LlmAdapter {
  if (deps.llm === undefined) {
    throw new ApiFailure(ERROR_CODES.INTERNAL, 'LLM 适配器未配置（DomainDeps.llm）', 500);
  }
  return deps.llm;
}

const toBlockDto = (row: typeof narrationBlocks.$inferSelect): NarrationBlock => ({
  /** 对外暴露**逻辑 ID**（跨版本稳定；行主键 row.id 不对外） */
  id: row.logicalId,
  position: row.position,
  text: row.text,
  chapterId: row.chapterId,
  claimIds: row.claimIds as string[],
  estimatedDurationMs: row.estimatedDurationMs,
  locked: row.locked,
  status: row.status as NarrationBlock['status'],
});

export async function getPlan(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; planId: string },
): Promise<NarrativePlan> {
  const rows = await deps.db
    .select()
    .from(narrativePlans)
    .where(
      and(
        eq(narrativePlans.id, input.planId),
        eq(narrativePlans.projectId, input.projectId),
        eq(narrativePlans.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'narrative plan not found', 404);
  const blockRows = await deps.db
    .select()
    .from(narrationBlocks)
    .where(eq(narrationBlocks.planId, row.id))
    .orderBy(narrationBlocks.position);
  const blockDtos = blockRows.map(toBlockDto);
  return narrativePlanSchema.parse({
    schemaVersion: '0.1',
    id: row.id,
    revision: row.revision,
    title: row.title,
    thesis: row.thesis,
    hook: row.hook,
    chapters: (row.chapters as NarrativePlan['chapters']).map((chapter) => ({
      ...chapter,
      narrationBlockIds: blockDtos.filter((block) => block.chapterId === chapter.id).map((block) => block.id),
    })),
    narrationBlocks: blockDtos,
    keyClaims: row.keyClaims as string[],
    requiredVisualFacts: row.requiredVisualFacts as NarrativePlan['requiredVisualFacts'],
    ending: row.ending,
    estimatedDurationMs: row.estimatedDurationMs,
    generation: row.generation as NarrativePlan['generation'],
  });
}

/** 生成叙事计划（LLM + 有限修复 + 有限重试 + 锁定保留 + 口语化门控）。 */
export async function generateNarrative(
  deps: DomainDeps,
  input: {
    workspaceId: string;
    projectId: string;
    documentId: string;
    targetDurationMs: number;
    tone?: string | null;
    audience?: string | null;
    platform?: string | null;
    createdBy?: string | null;
  },
): Promise<NarrativeGenerationResult> {
  if (!Number.isInteger(input.targetDurationMs) || input.targetDurationMs <= 0) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, '目标时长必须为正整数（毫秒）', 400, {
      reason: NARRATIVE_ERROR_REASONS.INVALID_TARGET_DURATION,
    });
  }
  const llm = requireLlm(deps);

  const documentRows = await deps.db
    .select()
    .from(contentDocuments)
    .where(
      and(
        eq(contentDocuments.id, input.documentId),
        eq(contentDocuments.projectId, input.projectId),
        eq(contentDocuments.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);
  const document = documentRows[0];
  if (!document) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'content document not found', 404);

  // 上一版计划：锁定旁白必须逐字保留（§8.2）
  const previousPlanRows = await deps.db
    .select()
    .from(narrativePlans)
    .where(and(eq(narrativePlans.projectId, input.projectId), eq(narrativePlans.documentId, document.id)))
    .orderBy(desc(narrativePlans.revision))
    .limit(1);
  const previousPlan = previousPlanRows[0];
  const lockedBlocks =
    previousPlan === undefined
      ? []
      : (
          await deps.db
            .select({ id: narrationBlocks.logicalId, text: narrationBlocks.text })
            .from(narrationBlocks)
            .where(and(eq(narrationBlocks.planId, previousPlan.id), eq(narrationBlocks.locked, true)))
            .orderBy(narrationBlocks.position)
        ).map((row) => ({ id: row.id, text: row.text }));

  const blockRows = await deps.db
    .select()
    .from(contentBlocks)
    .where(eq(contentBlocks.documentId, document.id))
    .orderBy(contentBlocks.position);
  const claimRows = await deps.db
    .select()
    .from(claims)
    .where(and(eq(claims.projectId, input.projectId), eq(claims.workspaceId, input.workspaceId)));

  const request: NarrativeGenerationRequest = narrativeGenerationRequestSchema.parse({
    documentTitle: document.title,
    documentLanguage: document.language,
    contentDigest: blockRows
      .filter((row) => row.blockType === 'paragraph' || row.blockType === 'heading' || row.blockType === 'quote' || row.blockType === 'list')
      .map((row) => ({
        blockId: row.id,
        kind: row.blockType,
        text: (row.text ?? (row.items as string[] | null)?.join(' · ') ?? '').slice(0, 1000),
      }))
      .filter((item) => item.text !== ''),
    claims: claimRows.map((row) => ({
      claimId: row.id,
      text: row.text.slice(0, 2000),
      factuality: row.factuality as 'fact' | 'analysis' | 'opinion' | 'uncertain',
      locked: row.locked,
    })),
    lockedNarrationBlocks: lockedBlocks,
    targetDurationMs: input.targetDurationMs,
    tone: input.tone ?? null,
    audience: input.audience ?? null,
    platform: input.platform ?? null,
  });

  const { systemPrompt, userPrompt } = buildNarrativePrompts(request);
  const revision = (previousPlan?.revision ?? 0) + 1;
  const planId = `npl_${randomUUID()}`;

  let lastError: unknown = null;
  const allRepairs: string[] = [];
  const allWarnings: string[] = [];
  for (let attempt = 1; attempt <= MAX_LLM_ATTEMPTS; attempt += 1) {
    try {
      const completion = await llm.complete({ request, systemPrompt, userPrompt });
      const outcome = repairNarrativePlan(completion.content, {
        request,
        planId,
        revision,
        providerId: llm.providerId,
        modelVersion: completion.modelVersion,
        promptVersion: completion.promptVersion,
      });
      allRepairs.push(...outcome.repairs);
      allWarnings.push(...outcome.warnings);

      await persistPlan(deps, {
        plan: { ...outcome.plan, narrationBlocks: outcome.plan.narrationBlocks, generation: { ...outcome.plan.generation, repairs: allRepairs, warnings: allWarnings } },
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        documentId: document.id,
        targetDurationMs: input.targetDurationMs,
        createdBy: input.createdBy ?? null,
      });
      return narrativeGenerationResultSchema.parse({
        plan: await getPlan(deps, { workspaceId: input.workspaceId, projectId: input.projectId, planId }),
        meta: {
          llmCalls: attempt,
          repairs: allRepairs,
          warnings: allWarnings,
          claimCount: request.claims.length,
          lockedBlockCount: lockedBlocks.length,
        },
      });
    } catch (error) {
      // 内部/基础设施错误（DB、存储等）直接上抛：不得伪装成"LLM 输出问题"（否则误导排查）
      if (error instanceof ApiFailure) throw error;
      const code = (error as { code?: string }).code;
      if (code === undefined) throw error;
      lastError = error;
      // 仅"输出不可修复/结构缺失"值得重试一次；引用错误/逐字抄袭重试无意义
      if (code === 'INVALID_LLM_OUTPUT' || code === 'REPAIR_LIMIT_EXCEEDED') continue;
      break;
    }
  }

  const reasonCode = (lastError as { code?: string }).code ?? 'INVALID_LLM_OUTPUT';
  const reason =
    reasonCode === 'REPAIR_LIMIT_EXCEEDED'
      ? NARRATIVE_ERROR_REASONS.REPAIR_LIMIT_EXCEEDED
      : reasonCode === 'VERBATIM_NARRATION_REJECTED'
        ? NARRATIVE_ERROR_REASONS.VERBATIM_NARRATION_REJECTED
        : reasonCode === 'UNKNOWN_CLAIM_REFERENCE'
          ? NARRATIVE_ERROR_REASONS.UNKNOWN_CLAIM_REFERENCE
          : NARRATIVE_ERROR_REASONS.INVALID_LLM_OUTPUT;
  throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'LLM 输出无法通过 Schema 校验（有限修复后仍失败）', 422, {
    reason,
    attempts: MAX_LLM_ATTEMPTS,
    providerId: llm.providerId,
    detail: lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown'),
    repairs: allRepairs,
    promptVersion: NARRATIVE_PROMPT_VERSION,
  });
}

async function persistPlan(
  deps: DomainDeps,
  input: {
    plan: NarrativePlan;
    workspaceId: string;
    projectId: string;
    documentId: string;
    targetDurationMs: number;
    createdBy: string | null;
  },
): Promise<void> {
  await deps.db.transaction(async (tx) => {
    await tx.insert(narrativePlans).values({
      id: input.plan.id,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      documentId: input.documentId,
      revision: input.plan.revision,
      title: input.plan.title,
      thesis: input.plan.thesis,
      hook: input.plan.hook,
      ending: input.plan.ending,
      chapters: input.plan.chapters,
      keyClaims: input.plan.keyClaims,
      requiredVisualFacts: input.plan.requiredVisualFacts,
      estimatedDurationMs: input.plan.estimatedDurationMs,
      targetDurationMs: input.targetDurationMs,
      generation: input.plan.generation,
      createdBy: input.createdBy,
    });
    const planPrefix = input.plan.id.replace(/^npl_/, '').replace(/[^a-f0-9]/gi, '').slice(0, 12);
    for (const block of input.plan.narrationBlocks) {
      await tx.insert(narrationBlocks).values({
        // 行主键按计划作用域（全局唯一）；logicalId 为跨版本稳定的逻辑 ID
        id: `nbr_${planPrefix}_${String(block.position + 1)}`,
        logicalId: block.id,
        planId: input.plan.id,
        workspaceId: input.workspaceId,
        position: block.position,
        text: block.text,
        chapterId: block.chapterId,
        claimIds: block.claimIds,
        estimatedDurationMs: block.estimatedDurationMs,
        locked: block.locked,
        status: block.status,
      });
    }
  });
}

export async function getCurrentPlan(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string },
): Promise<NarrativePlan | null> {
  const rows = await deps.db
    .select({ id: narrativePlans.id })
    .from(narrativePlans)
    .where(and(eq(narrativePlans.projectId, input.projectId), eq(narrativePlans.workspaceId, input.workspaceId)))
    .orderBy(desc(narrativePlans.revision))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  return getPlan(deps, { ...input, planId: row.id });
}

export async function listPlans(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string },
): Promise<NarrativePlan[]> {
  const rows = await deps.db
    .select({ id: narrativePlans.id })
    .from(narrativePlans)
    .where(and(eq(narrativePlans.projectId, input.projectId), eq(narrativePlans.workspaceId, input.workspaceId)))
    .orderBy(desc(narrativePlans.revision))
    .limit(20);
  const plans: NarrativePlan[] = [];
  for (const row of rows) {
    plans.push(await getPlan(deps, { ...input, planId: row.id }));
  }
  return plans;
}

/** 编辑旁白块（作者修订）：锁定后修改文本 → 409（§8.2 锁定文字不得静默修改）。 */
export async function updateNarrationBlock(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; planId: string; blockId: string; input: UpdateNarrationBlockRequest },
): Promise<NarrationBlock> {
  const body = updateNarrationBlockRequestSchema.parse(input.input);
  const rows = await deps.db
    .select()
    .from(narrationBlocks)
    .where(
      and(
        eq(narrationBlocks.logicalId, input.blockId),
        eq(narrationBlocks.planId, input.planId),
        eq(narrationBlocks.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'narration block not found', 404);
  if (row.locked && body.text !== undefined && body.text !== row.text) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '旁白块已锁定：解锁后才能修改文本（§8.2）', 409, {
      reason: 'NARRATION_BLOCK_LOCKED',
    });
  }
  const updated = await deps.db
    .update(narrationBlocks)
    .set({
      ...(body.text !== undefined ? { text: body.text } : {}),
      ...(body.locked !== undefined ? { locked: body.locked } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.text !== undefined ? { estimatedDurationMs: Math.max(1000, Math.round((body.text.replace(/\s/g, '').length / 220) * 60_000)) } : {}),
      updatedAt: new Date(),
    })
    .where(eq(narrationBlocks.id, row.id))
    .returning();
  const next = updated[0];
  if (!next) throw new ApiFailure(ERROR_CODES.INTERNAL, 'narration block update failed', 500);
  return toBlockDto(next);
}
