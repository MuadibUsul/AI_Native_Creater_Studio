import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  MULTILINGUAL_ERROR_REASONS,
  masterNarrationSchema,
  narrationCueSchema,
  translationJobSchema,
  translationUnitSchema,
  terminologyEntrySchema,
  upsertTerminologyRequestSchema,
  type LlmAdapter,
  type MasterNarration,
  type TranslationJob,
  type TerminologyEntry,
  type UpsertTerminologyRequest,
} from '@ancs/contracts';
import { narrationTranslations, terminologyEntries } from '@ancs/db';
import type { DomainDeps } from './deps.js';
import { getCurrentMasterNarration } from './alignment.js';
import { getPlan } from './narrative.js';

/**
 * 多语言服务（P12-04 / 规范 §5.1、§94；计划 §8 P12）。
 *
 * - **术语词典**：项目级数据（翻译与 TTS 发音共用；(projectId, sourceTerm, targetLanguage) 唯一）；
 * - **翻译经 LLM seam**（Mock 同构；真实翻译 Provider BLOCKED 凭据——fail-closed 501，不冒充）；
 * - **fail-closed 一致性门**：数字（逐块数字序列多重集相等）与实体（词典命中源词必须以译名出现）
 *   任一不一致 → 422，**整个翻译不落库、不合成**；
 * - **不复用原语言时间戳**：派生 Master Narration 走完整合成链（synthesizeMasterNarration，
 *   language 隔离缓存）——时间戳来自新语言的全新 TTS/对齐。
 */

const requireLlm = (deps: DomainDeps): LlmAdapter => {
  if (deps.llm === undefined) {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, '未配置 LLM 适配器：翻译 seam 不可用（fail-closed；真实翻译 Provider BLOCKED 凭据）', 501, {
      reason: MULTILINGUAL_ERROR_REASONS.TRANSLATION_UNAVAILABLE,
    });
  }
  return deps.llm;
};

const toEntryDto = (row: typeof terminologyEntries.$inferSelect): TerminologyEntry =>
  terminologyEntrySchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    sourceTerm: row.sourceTerm,
    targetLanguage: row.targetLanguage,
    targetTerm: row.targetTerm,
    kind: row.kind,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });

/** 术语词典 upsert（(projectId, sourceTerm, targetLanguage) 唯一；重复 = 更新译名）。 */
export async function upsertTerminologyEntry(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; request: UpsertTerminologyRequest },
): Promise<TerminologyEntry> {
  const body = upsertTerminologyRequestSchema.parse(input.request);
  const now = new Date();
  const inserted = await deps.db
    .insert(terminologyEntries)
    .values({
      id: `term_${randomUUID()}`,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      sourceTerm: body.sourceTerm,
      targetLanguage: body.targetLanguage,
      targetTerm: body.targetTerm,
      kind: body.kind,
      note: body.note ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [terminologyEntries.projectId, terminologyEntries.sourceTerm, terminologyEntries.targetLanguage],
      set: { targetTerm: body.targetTerm, kind: body.kind, note: body.note ?? null, updatedAt: now },
    })
    .returning();
  const row = inserted[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'terminology upsert failed', 500);
  return toEntryDto(row);
}

/** 术语词典列表（可按语言过滤；字母序）。 */
export async function listTerminology(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; language?: string },
): Promise<TerminologyEntry[]> {
  const conditions = [eq(terminologyEntries.workspaceId, input.workspaceId), eq(terminologyEntries.projectId, input.projectId)];
  if (input.language !== undefined) conditions.push(eq(terminologyEntries.targetLanguage, input.language));
  const rows = await deps.db
    .select()
    .from(terminologyEntries)
    .where(and(...conditions))
    .orderBy(terminologyEntries.sourceTerm);
  return rows.map(toEntryDto);
}

const countOccurrences = (haystack: string, needle: string): number => (needle === '' ? 0 : haystack.split(needle).length - 1);

/** 数字序列多重集（"数字一致"的判定口径：逐字保留，含小数点）。 */
const digitGroupsOf = (text: string): string[] => [...text.matchAll(/\d+(?:\.\d+)?/g)].map((match) => match[0] ?? '');

const multisetEqual = (left: string[], right: string[]): boolean => {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
};

/** 剥围栏 + JSON 解析（有限修复：剥 ```json 围栏；仍失败 → 明确 422）。 */
const parseTranslationOutput = (content: string): { translations: { narrationBlockId: string; text: string }[] } => {
  const stripped = content.replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '').trim();
  try {
    const parsed: unknown = JSON.parse(stripped);
    if (typeof parsed === 'object' && parsed !== null && 'translations' in parsed) {
      const raw = (parsed as { translations: unknown }).translations;
      if (Array.isArray(raw)) {
        const translations = raw
          .filter((entry): entry is { narrationBlockId: string; text: string } => typeof entry === 'object' && entry !== null && 'narrationBlockId' in entry && 'text' in entry)
          .map((entry) => ({ narrationBlockId: String(entry.narrationBlockId), text: String(entry.text) }));
        return { translations };
      }
    }
  } catch {
    // fallthrough
  }
  throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'LLM 输出无法解析为翻译 JSON（有限修复后仍失败）', 422, {
    reason: MULTILINGUAL_ERROR_REASONS.INVALID_TRANSLATION_OUTPUT,
  });
};

const toJobDto = (row: typeof narrationTranslations.$inferSelect): TranslationJob =>
  translationJobSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    narrativePlanId: row.narrativePlanId,
    sourceNarrationId: row.sourceNarrationId,
    derivedNarrationId: row.derivedNarrationId,
    targetLanguage: row.targetLanguage,
    units: row.units,
    numbersCheck: row.numbersCheck,
    entitiesCheck: row.entitiesCheck,
    createdAt: row.createdAt.toISOString(),
  });

/** 翻译作业列表（新→旧）。 */
export async function listTranslationJobs(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string },
): Promise<TranslationJob[]> {
  const rows = await deps.db
    .select()
    .from(narrationTranslations)
    .where(and(eq(narrationTranslations.workspaceId, input.workspaceId), eq(narrationTranslations.projectId, input.projectId)))
    .orderBy(desc(narrationTranslations.createdAt));
  return rows.map(toJobDto);
}

/**
 * 翻译旁白并重新合成（P12-04 完整链路）：
 * 源 Master → LLM 翻译（词典注入）→ 数字/实体 fail-closed 门 → 新语言全量重合成（新时间戳）→ 作业落库。
 */
export async function translateNarration(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; planId: string; targetLanguage: string },
): Promise<{ job: TranslationJob; narration: MasterNarration }> {
  const llm = requireLlm(deps);

  // 1) 源旁白块 + 源 Master（时间戳对照物；不存在 → 明确 409）
  const plan = await getPlan(deps, { workspaceId: input.workspaceId, projectId: input.projectId, planId: input.planId });
  const blocks = plan.narrationBlocks;
  if (blocks.length === 0) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, '叙事计划没有旁白块：无可翻译内容', 422, {
      reason: MULTILINGUAL_ERROR_REASONS.TRANSLATION_INCOMPLETE,
    });
  }
  const sourceNarration = await getCurrentMasterNarration(deps, { workspaceId: input.workspaceId, projectId: input.projectId, planId: input.planId });
  if (sourceNarration === null) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '尚无源语言 Master Narration：请先合成（翻译的对照物）', 409, {
      reason: MULTILINGUAL_ERROR_REASONS.SOURCE_NARRATION_MISSING,
    });
  }

  // 2) 术语词典（目标语言）
  const dictionary = await listTerminology(deps, { workspaceId: input.workspaceId, projectId: input.projectId, language: input.targetLanguage });

  // 3) LLM 翻译（seam；词典注入 systemPrompt——翻译与 TTS 发音共用同一份数据）
  const systemPrompt = [
    `purpose: translation`,
    `targetLanguage: ${input.targetLanguage}`,
    `promptVersion: translation-v1`,
    '要求：数字逐字保留；词典实体必须使用给定译名；不得改写事实。',
    ...dictionary.map((entry) => `${entry.sourceTerm}=>${entry.targetTerm}`),
  ].join('\n');
  const userPrompt = JSON.stringify({ blocks: blocks.map((block) => ({ narrationBlockId: block.id, text: block.text })) });
  if (llm.completePrompt === undefined) {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'LLM 适配器未实现 completePrompt：翻译 seam 不可用（fail-closed）', 501, {
      reason: MULTILINGUAL_ERROR_REASONS.TRANSLATION_UNAVAILABLE,
    });
  }
  const completion = await llm.completePrompt({ purpose: 'translation', systemPrompt, userPrompt });
  const parsed = parseTranslationOutput(completion.content);

  // 4) 完整性：每个旁白块都必须有翻译
  const translatedByBlock = new Map(parsed.translations.map((entry) => [entry.narrationBlockId, entry.text]));
  const missing = blocks.filter((block) => !translatedByBlock.has(block.id));
  if (missing.length > 0) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, `译文缺少 ${String(missing.length)} 个旁白块的翻译`, 422, {
      reason: MULTILINGUAL_ERROR_REASONS.TRANSLATION_INCOMPLETE,
    });
  }

  // 5) 数字一致性（逐块多重集相等；不等 → 422 整体不落库）
  for (const block of blocks) {
    const translated = translatedByBlock.get(block.id) ?? '';
    if (!multisetEqual(digitGroupsOf(block.text), digitGroupsOf(translated))) {
      throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, `数字不一致（旁白块 ${block.id}）：源 [${digitGroupsOf(block.text).join(', ')}] ≠ 译 [${digitGroupsOf(translated).join(', ')}]——数字必须逐字保留`, 422, {
        reason: MULTILINGUAL_ERROR_REASONS.NUMBERS_CHANGED,
        narrationBlockId: block.id,
      });
    }
  }
  const sourceDigitGroups = blocks.reduce((sum, block) => sum + digitGroupsOf(block.text).length, 0);
  const translatedDigitGroups = blocks.reduce((sum, block) => sum + digitGroupsOf(translatedByBlock.get(block.id) ?? '').length, 0);

  // 6) 实体一致性（词典命中源词 → 译文中必须出现译名；缺失 → 422 整体不落库）
  const entityEntries = dictionary.map((entry) => {
    const sourceCount = blocks.reduce((sum, block) => sum + countOccurrences(block.text, entry.sourceTerm), 0);
    const translatedCount = blocks.reduce((sum, block) => sum + countOccurrences(translatedByBlock.get(block.id) ?? '', entry.targetTerm), 0);
    return { sourceTerm: entry.sourceTerm, targetTerm: entry.targetTerm, sourceCount, translatedCount, ok: sourceCount === 0 || translatedCount > 0 };
  });
  const entityFailed = entityEntries.find((entry) => !entry.ok);
  if (entityFailed !== undefined) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, `实体不一致：词典「${entityFailed.sourceTerm}=>${entityFailed.targetTerm}」的源词出现 ${String(entityFailed.sourceCount)} 次但译名出现 0 次`, 422, {
      reason: MULTILINGUAL_ERROR_REASONS.ENTITY_MISSING,
    });
  }

  // 7) 重新合成（新语言 → 语言隔离缓存 → 全新 TTS/对齐；**不复用原语言时间戳**）
  const narration = await synthesizeForLanguage(deps, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    planId: input.planId,
    language: input.targetLanguage,
    texts: blocks.map((block) => ({ narrationBlockId: block.id, text: translatedByBlock.get(block.id) ?? '' })),
  });

  // 8) 作业落库（只追加；核对证据随行）
  const units = blocks.map((block) => {
    const translated = translatedByBlock.get(block.id) ?? '';
    return translationUnitSchema.parse({
      narrationBlockId: block.id,
      sourceText: block.text,
      translatedText: translated,
      termMappings: dictionary.map((entry) => ({
        sourceTerm: entry.sourceTerm,
        targetTerm: entry.targetTerm,
        sourceCount: countOccurrences(block.text, entry.sourceTerm),
        translatedCount: countOccurrences(translated, entry.targetTerm),
      })).filter((mapping) => mapping.sourceCount > 0),
    });
  });
  const inserted = await deps.db
    .insert(narrationTranslations)
    .values({
      id: `trj_${randomUUID()}`,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      narrativePlanId: input.planId,
      sourceNarrationId: sourceNarration.id,
      derivedNarrationId: narration.id,
      targetLanguage: input.targetLanguage,
      units,
      numbersCheck: { sourceDigitGroups, translatedDigitGroups, ok: true },
      entitiesCheck: { entries: entityEntries, ok: true },
    })
    .returning();
  const jobRow = inserted[0];
  if (jobRow === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'translation job insert failed', 500);
  const job = toJobDto(jobRow);
  return { job, narration: masterNarrationSchema.parse({ ...narration }) };
}

/** synthesizeMasterNarration 的透传（语言隔离在 alignment.ts 内实现；此处仅收拢依赖）。 */
async function synthesizeForLanguage(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; planId: string; language: string; texts: { narrationBlockId: string; text: string }[] },
): Promise<MasterNarration> {
  const { synthesizeMasterNarration } = await import('./alignment.js');
  return synthesizeMasterNarration(deps, input);
}

void narrationCueSchema;
