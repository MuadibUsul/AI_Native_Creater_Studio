import {
  MAX_REPAIRS,
  VERBATIM_NGRAM,
  VERBATIM_OVERLAP_THRESHOLD,
  narrativePlanSchema,
  type NarrativeGenerationRequest,
  type NarrativePlan,
} from '@ancs/contracts';

/**
 * Narrative 的确定性部分（P04-03 / §8.2、§52）——纯函数，可独立单测：
 * - **有限修复**（有界）：从 LLM 输出到 NarrativePlan 的解析/规整（剥代码围栏、剔未知字段、
 *   类型强转、缺省派生）；修复条目逐条记录；**修复超限或核心缺失即明确失败**（不无限重试/不瞎猜）；
 * - **口语化检查**：与原文的 8-gram 字符重叠率（≥ 阈值即"逐字朗读嫌疑"）；
 * - **锁定保留**：锁定旁白块逐字保留（LLM 若改写则回滚为原文并记录修复）；
 * - 字数→时长估算（与 P06-03 Alignment 的口径一致：220 字/分钟基准）。
 */

const CHARS_PER_MINUTE = 220;

export function estimateDurationMs(text: string): number {
  const chars = text.replace(/\s/g, '').length;
  return Math.max(1000, Math.round((chars / CHARS_PER_MINUTE) * 60_000));
}

export interface RepairOutcome {
  plan: NarrativePlan;
  repairs: string[];
  warnings: string[];
}

type LooseRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is LooseRecord => typeof value === 'object' && value !== null && !Array.isArray(value);

/** 剥离代码围栏/前后噪声，取出第一个完整 JSON 对象文本。 */
export function extractJsonPayload(raw: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidate = (fenced?.[1] ?? raw).trim();
  const start = candidate.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < candidate.length; index += 1) {
    const char = candidate[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') inString = !inString;
    if (inString) continue;
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return candidate.slice(start, index + 1);
    }
  }
  return null;
}

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null);
const asPositiveInt = (value: unknown): number | null => {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : null;
};

/**
 * 把 LLM 输出规整为 NarrativePlan（**有限修复**）。
 * 抛出 { reason } 式错误由调用方包装为 422：INVALID_LLM_OUTPUT / REPAIR_LIMIT_EXCEEDED / UNKNOWN_CLAIM_REFERENCE。
 */
export function repairNarrativePlan(
  rawContent: string,
  input: {
    request: NarrativeGenerationRequest;
    planId: string;
    revision: number;
    providerId: string;
    modelVersion: string;
    promptVersion: string;
  },
): RepairOutcome {
  const repairs: string[] = [];
  const warnings: string[] = [];

  const payload = extractJsonPayload(rawContent);
  if (payload === null) {
    throw Object.assign(new Error('LLM 输出缺少可解析的 JSON 对象'), { code: 'INVALID_LLM_OUTPUT' });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw Object.assign(new Error('LLM 输出 JSON 解析失败'), { code: 'INVALID_LLM_OUTPUT' });
  }
  if (!isRecord(parsed)) {
    throw Object.assign(new Error('LLM 输出不是 JSON 对象'), { code: 'INVALID_LLM_OUTPUT' });
  }

  // 历史版本/未知字段：剔除（真实模型的 schema 漂移）
  const knownTopLevel = new Set(['title', 'thesis', 'hook', 'chapters', 'narrationBlocks', 'ending', 'keyClaims', 'requiredVisualFacts', 'estimatedDuration', 'estimatedDurationMs']);
  for (const key of Object.keys(parsed)) {
    if (!knownTopLevel.has(key)) {
      delete parsed[key];
      repairs.push(`剔除未知字段 ${key}`);
    }
  }

  const claimById = new Map(input.request.claims.map((claim) => [claim.claimId, claim]));
  const lockedById = new Map(input.request.lockedNarrationBlocks.map((block) => [block.id, block.text]));
  const digestTexts = input.request.contentDigest.map((item) => item.text);

  const title = asString(parsed['title']) ?? `${input.request.documentTitle}｜视频叙事`;
  if (parsed['title'] === undefined) repairs.push('缺少 title：由文档标题派生');

  const chapterList = Array.isArray(parsed['chapters']) ? parsed['chapters'].filter(isRecord) : [];
  const chapterTitles = new Map<string, string>(); // title → id
  const chapters: NarrativePlan['chapters'] = [];
  let chapterIndex = 0;
  for (const chapter of chapterList) {
    const chapterTitle = asString(chapter['title']);
    if (chapterTitle === null || chapterTitle.trim() === '') {
      repairs.push('丢弃无标题章节');
      continue;
    }
    chapterIndex += 1;
    const id = `nch_${String(chapterIndex)}`;
    chapterTitles.set(chapterTitle, id);
    chapters.push({
      id,
      title: chapterTitle.slice(0, 200),
      intent: asString(chapter['intent'])?.slice(0, 500) ?? null,
      narrationBlockIds: [],
    });
  }

  const rawBlocks = Array.isArray(parsed['narrationBlocks']) ? parsed['narrationBlocks'] : [];
  if (rawBlocks.length === 0) {
    throw Object.assign(new Error('LLM 输出缺少 narrationBlocks（结构性缺失，不可修复）'), { code: 'REPAIR_LIMIT_EXCEEDED' });
  }

  const blocks: NarrativePlan['narrationBlocks'] = [];
  let blockIndex = 0;
  const seenLocked = new Set<string>();
  for (const rawBlock of rawBlocks) {
    if (!isRecord(rawBlock)) {
      repairs.push('丢弃非对象旁白块');
      continue;
    }
    const id = asString(rawBlock['id']) ?? `nrb_${String(blockIndex + 1)}`;
    let text = asString(rawBlock['text'])?.trim() ?? '';
    if (text === '') {
      repairs.push(`丢弃空文本旁白块 ${id}`);
      continue;
    }
    // 锁定保留：LLM 若改写锁定旁白 → 回滚为锁定原文（§8.2）
    const lockedText = lockedById.get(id);
    if (lockedText !== undefined) {
      if (text !== lockedText) {
        repairs.push(`锁定旁白 ${id} 被模型改写：已回滚为锁定原文`);
        text = lockedText;
      }
      seenLocked.add(id);
    }
    const claimIdsRaw = Array.isArray(rawBlock['claimIds']) ? rawBlock['claimIds'].map((value) => asString(value)).filter((value): value is string => value !== null) : [];
    const claimIds: string[] = [];
    for (const claimId of claimIdsRaw) {
      if (!claimById.has(claimId)) {
        repairs.push(`剔除不存在的事实引用 ${claimId}（不得引用未登记事实）`);
        continue;
      }
      claimIds.push(claimId);
    }
    const chapterTitle = asString(rawBlock['chapterTitle']) ?? asString(rawBlock['chapterId']) ?? null;
    const chapterId = chapterTitle !== null ? (chapterTitles.get(chapterTitle) ?? null) : null;
    // 防御性去重：真实模型可能输出重复 id（作为主键/逻辑引用都会冲突）
    let uniqueId = id;
    let suffix = 2;
    while (blocks.some((existing) => existing.id === uniqueId)) {
      uniqueId = `${id}_${String(suffix)}`;
      suffix += 1;
    }
    if (uniqueId !== id) repairs.push(`旁白块 id 重复（${id}）：已重命名为 ${uniqueId}`);
    blockIndex += 1;
    blocks.push({
      id: uniqueId,
      position: blockIndex - 1,
      text: text.slice(0, 4000),
      chapterId,
      claimIds,
      estimatedDurationMs: estimateDurationMs(text),
      locked: lockedText !== undefined,
      status: 'DRAFT',
    });
    if (chapterId !== null) {
      const chapter = chapters.find((candidate) => candidate.id === chapterId);
      chapter?.narrationBlockIds.push(id);
    }
  }

  // 锁定旁白若完全缺失（模型把锁定段落丢了）→ 追加保留（不静默丢失作者文字）
  for (const [lockedId, lockedText] of lockedById) {
    if (seenLocked.has(lockedId)) continue;
    blockIndex += 1;
    blocks.push({
      id: lockedId,
      position: blockIndex - 1,
      text: lockedText,
      chapterId: null,
      claimIds: [],
      estimatedDurationMs: estimateDurationMs(lockedText),
      locked: true,
      status: 'DRAFT',
    });
    repairs.push(`模型丢失锁定旁白 ${lockedId}：已补回锁定原文`);
  }

  if (blocks.length === 0) {
    throw Object.assign(new Error('修复后没有任何有效旁白块'), { code: 'REPAIR_LIMIT_EXCEEDED' });
  }
  if (repairs.length > MAX_REPAIRS) {
    throw Object.assign(new Error(`修复条目超过上限（${String(repairs.length)} > ${String(MAX_REPAIRS)}）`), { code: 'REPAIR_LIMIT_EXCEEDED' });
  }

  // 说明：旁白块 `id` 为**逻辑 ID**（跨版本稳定，锁定旁白在再生成后不变）；
  // 数据库行主键按计划作用域（persistPlan 生成），避免不同版本/计划的逻辑 ID 冲突。

  // 章节兜底：模型可能不返回章节（修复为单章）
  if (chapters.length === 0) {
    chapters.push({ id: 'nch_1', title: '主体', intent: null, narrationBlockIds: blocks.map((block) => block.id) });
    repairs.push('缺少 chapters：修复为单章「主体」');
  }

  // 口语化检查（§8.2 不得逐字朗读）：8-gram 字符重叠
  for (const block of blocks) {
    const overlap = maxNgramOverlap(block.text, digestTexts);
    if (overlap >= VERBATIM_OVERLAP_THRESHOLD) {
      warnings.push(`旁白块 ${block.id} 与原文重叠率 ${(overlap * 100).toFixed(0)}%（疑似逐字朗读）`);
    }
  }
  // 锁定旁白是作者文字（可能有意引用原文），豁免口语化门控；仅对模型生成的旁白判逐字朗读
  const generatedBlocks = blocks.filter((block) => !block.locked);
  const verbatimBlockCount = warnings.filter((warning) => warning.includes('逐字朗读')).length;
  if (generatedBlocks.length > 0 && verbatimBlockCount >= generatedBlocks.length) {
    throw Object.assign(new Error('全部生成旁白疑似逐字朗读原文（§8.2 必须口语化）'), { code: 'VERBATIM_NARRATION_REJECTED' });
  }

  const thesis = asString(parsed['thesis']) ?? `围绕「${input.request.documentTitle}」的核心解释。`;
  if (parsed['thesis'] === undefined) repairs.push('缺少 thesis：按文档标题派生');
  const hook = asString(parsed['hook']) ?? '以反常识事实开场。';
  if (parsed['hook'] === undefined) repairs.push('缺少 hook：使用安全默认开场');
  const ending = asString(parsed['ending']) ?? '总结核心结论，并提示下一步关注点。';
  if (parsed['ending'] === undefined) repairs.push('缺少 ending：使用安全默认结尾');

  const keyClaimsRaw = Array.isArray(parsed['keyClaims']) ? parsed['keyClaims'] : [];
  const keyClaims = [...new Set(keyClaimsRaw.map((value) => asString(value)).filter((value): value is string => value !== null && claimById.has(value)))];
  if (keyClaimsRaw.length > 0 && keyClaims.length === 0) {
    throw Object.assign(new Error('keyClaims 全部引用未登记事实（不得虚构来源/事实）'), { code: 'UNKNOWN_CLAIM_REFERENCE' });
  }

  // 时长：优先毫秒字段；其次秒字段折算；最后按旁白字数汇总（确定性估算）
  let finalDuration = asPositiveInt(parsed['estimatedDurationMs']);
  if (finalDuration === null) {
    const seconds = asPositiveInt(parsed['estimatedDuration']);
    if (seconds !== null) {
      finalDuration = seconds * 1000;
      repairs.push('estimatedDuration（秒）已折算为 estimatedDurationMs');
    }
  }
  if (finalDuration === null) {
    finalDuration = blocks.reduce((sum, block) => sum + block.estimatedDurationMs, 0);
    repairs.push('缺少时长字段：按旁白字数估算（220 字/分钟）');
  }

  const plan = narrativePlanSchema.parse({
    schemaVersion: '0.1',
    id: input.planId,
    revision: input.revision,
    title,
    thesis,
    hook,
    chapters,
    narrationBlocks: blocks.map((block, index) => ({ ...block, position: index })),
    keyClaims,
    requiredVisualFacts: keyClaims.map((claimId) => ({ claimId, semanticHint: null, datasetId: null })),
    ending,
    estimatedDurationMs: finalDuration,
    generation: {
      method: 'LLM',
      providerId: input.providerId,
      modelVersion: input.modelVersion,
      promptVersion: input.promptVersion,
      repairs,
      warnings,
    },
  });
  return { plan, repairs, warnings };
}

/** 与任一原文段落的最大 8-gram 字符重叠率。 */
export function maxNgramOverlap(text: string, sources: string[]): number {
  const normalized = text.replace(/\s/g, '');
  if (normalized.length < VERBATIM_NGRAM) return 0;
  const grams = new Set<string>();
  for (let index = 0; index + VERBATIM_NGRAM <= normalized.length; index += 1) {
    grams.add(normalized.slice(index, index + VERBATIM_NGRAM));
  }
  let best = 0;
  for (const source of sources) {
    const sourceNormalized = source.replace(/\s/g, '');
    if (sourceNormalized.length < VERBATIM_NGRAM) continue;
    let hits = 0;
    let total = 0;
    for (let index = 0; index + VERBATIM_NGRAM <= sourceNormalized.length; index += 1) {
      total += 1;
      if (grams.has(sourceNormalized.slice(index, index + VERBATIM_NGRAM))) hits += 1;
    }
    if (total > 0) best = Math.max(best, hits / total);
  }
  return best;
}

/** 系统提示词（promptVersion 供 §52 记录；含 §8.2 约束）。 */
export const NARRATIVE_PROMPT_VERSION = 'narrative-v1';

export function buildNarrativePrompts(request: NarrativeGenerationRequest): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = [
    '你是知识视频的叙事编导。把文章结构转成**视频叙事结构**（不是逐字朗读）。',
    'promptVersion: ' + NARRATIVE_PROMPT_VERSION,
    '硬性约束：',
    '1) 返回**严格 JSON**（无多余文字）；字段：title/thesis/hook/chapters/narrationBlocks/ending/keyClaims/estimatedDuration。',
    '2) 旁白必须口语化，禁止逐字复述原文；',
    '3) 只能引用给定的事实 id（claims[].claimId），不得编造事实或来源；',
    '4) 锁定旁白（lockedNarrationBlocks）必须逐字保留（同 id 同文本）；',
    '5) 生成旁白块 id 使用 nrg_1..n（锁定旁白沿用其既有 id，不得改名）；chapters[].narrationBlockIds 引用这些 id。',
  ].join('\n');
  const userPrompt = JSON.stringify(
    {
      documentTitle: request.documentTitle,
      language: request.documentLanguage,
      targetDurationMs: request.targetDurationMs,
      tone: request.tone,
      audience: request.audience,
      platform: request.platform,
      claims: request.claims,
      lockedNarrationBlocks: request.lockedNarrationBlocks,
      contentDigest: request.contentDigest,
    },
    null,
    0,
  );
  return { systemPrompt, userPrompt };
}
