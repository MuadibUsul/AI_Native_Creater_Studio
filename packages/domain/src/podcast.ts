import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  PODCAST_ERROR_REASONS,
  PODCAST_VALIDATION_CODES,
  VISUAL_REFERENCE_LEXICON,
  podcastEpisodeSchema,
  podcastValidationResultSchema,
  planAudioMix,
  validationResultSchema,
  type MixPlan,
  type MasterNarration,
  type NarrationBlock,
  type PodcastEpisode,
  type ValidationResult,
} from '@ancs/contracts';
import { masterNarrations, podcastEpisodes, projectSources } from '@ancs/db';
import type { DomainDeps } from './channels.js';
import { getCurrentMasterNarration, synthesizeMasterNarration } from './alignment.js';
import { getPlan } from './narrative.js';

/**
 * Podcast 服务（P12-05 / 规范 §4.2、§59；计划 §8 P12）。
 *
 * - **去除"看屏幕"表达**：确定性词表（VISUAL_REFERENCE_LEXICON）逐句移除并**逐句披露**
 *   （removedSentences）；纯视觉块整块跳过（skippedBlockIds）；全空 → 422 NO_AUDIO_CONTENT；
 * - **纯音频 Master（variant='PODCAST'）**：全新合成（子集文本 → 新 cacheKey → 新 TTS/对齐），
 *   **不进视频主链**（getCurrentMasterNarration 只认 MASTER）；
 * - **章节 = 派生 Master 的真实 cue**（时间戳来自新音频的 Alignment——与 P10-05 同纪律）；
 * - **混音计划**：planAudioMix 纯计算（旁白基准 cue + ducking 结构；V1 未绑定 BGM → 显式披露）；
 * - **授权完整**：attribution（来源元数据署名；无来源明示）+ metadata（标题/语言/explicit=false）。
 */

const splitSentences = (text: string): string[] =>
  text
    // 小数安全断句（ASCII 点号不切——"5.25%" 必须保持完整；中文句读为主）
    .split(/(?<=[。！？!?；;\n])/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

const containsVisualReference = (sentence: string): boolean =>
  VISUAL_REFERENCE_LEXICON.some((phrase) => sentence.includes(phrase));

/** 纯音频改写：移除视觉指涉句（逐字保留其余；全句视觉 → 空串 = 整块跳过）。 */
export function adaptNarrationForAudio(
  blocks: readonly NarrationBlock[],
): { units: { narrationBlockId: string; sourceText: string; adaptedText: string; removedSentences: string[] }[]; skippedBlockIds: string[]; sentencesAdapted: number; sentencesRemoved: number; sentencesTotal: number } {
  const units: { narrationBlockId: string; sourceText: string; adaptedText: string; removedSentences: string[] }[] = [];
  const skippedBlockIds: string[] = [];
  let sentencesAdapted = 0;
  let sentencesRemoved = 0;
  const sentencesTotal = blocks.reduce((sum, block) => sum + splitSentences(block.text).length, 0);
  for (const block of blocks) {
    const sentences = splitSentences(block.text);
    const kept: string[] = [];
    const removed: string[] = [];
    for (const sentence of sentences) {
      if (containsVisualReference(sentence)) removed.push(sentence);
      else kept.push(sentence);
    }
    sentencesRemoved += removed.length;
    sentencesAdapted += kept.length;
    const adaptedText = kept.join('');
    units.push({ narrationBlockId: block.id, sourceText: block.text, adaptedText, removedSentences: removed });
    if (adaptedText === '') skippedBlockIds.push(block.id);
  }
  return { units, skippedBlockIds, sentencesAdapted, sentencesRemoved, sentencesTotal };
}

const toEpisodeDto = (row: typeof podcastEpisodes.$inferSelect): PodcastEpisode =>
  podcastEpisodeSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    planId: row.planId,
    sourceNarrationId: row.sourceNarrationId,
    masterNarrationId: row.masterNarrationId,
    language: row.language,
    title: row.title,
    units: row.units,
    skippedBlockIds: row.skippedBlockIds,
    coverage: row.coverage,
    chapters: row.chapters,
    mixPlan: row.mixPlan,
    mixNote: row.mixNote,
    metadata: row.metadata,
    attribution: row.attribution,
    createdAt: row.createdAt.toISOString(),
  });

/** 播客集列表（新→旧）。 */
export async function listPodcastEpisodes(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string },
): Promise<PodcastEpisode[]> {
  const rows = await deps.db
    .select()
    .from(podcastEpisodes)
    .where(and(eq(podcastEpisodes.workspaceId, input.workspaceId), eq(podcastEpisodes.projectId, input.projectId)))
    .orderBy(desc(podcastEpisodes.createdAt));
  return rows.map(toEpisodeDto);
}

async function getPodcastMaster(deps: DomainDeps, input: { workspaceId: string; projectId: string; planId: string }): Promise<MasterNarration | null> {
  const rows = await deps.db
    .select()
    .from(masterNarrations)
    .where(
      and(
        eq(masterNarrations.workspaceId, input.workspaceId),
        eq(masterNarrations.projectId, input.projectId),
        eq(masterNarrations.narrativePlanId, input.planId),
        eq(masterNarrations.variant, 'PODCAST'),
      ),
    )
    .orderBy(desc(masterNarrations.createdAt))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    narrativePlanId: row.narrativePlanId,
    narrativePlanRevision: row.narrativePlanRevision,
    assetId: row.assetId,
    assetVersionId: row.assetVersionId,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    checksumSha256: row.checksumSha256,
    totalDurationMs: row.totalDurationMs,
    alignmentMethod: row.alignmentMethod as MasterNarration['alignmentMethod'],
    segments: row.segments as MasterNarration['segments'],
    cues: row.cues as MasterNarration['cues'],
    voice: { voiceIdentityId: row.voiceIdentityId, voiceIdentityVersion: row.voiceIdentityVersion },
    language: row.language,
    variant: 'PODCAST',
    cacheStats: row.cacheStats as MasterNarration['cacheStats'],
    warnings: row.warnings as string[],
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * 生成播客集（P12-05 完整链路）：
 * 源 Master（409 闸门）→ 纯音频改写（视觉指涉移除+披露；全空 422）→ PODCAST 变体重合成
 * （子集文本 → 全新音频/时间戳）→ 章节（真实 cue）→ 混音计划 → 元数据/署名 → 落库。
 */
export async function generatePodcastEpisode(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; planId: string },
): Promise<PodcastEpisode> {
  // 1) 源 Master（对照物；不存在 → 明确 409）
  const sourceNarration = await getCurrentMasterNarration(deps, { workspaceId: input.workspaceId, projectId: input.projectId, planId: input.planId });
  if (sourceNarration === null) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '尚无源（视频）Master Narration：请先合成（播客为派生版本）', 409, {
      reason: PODCAST_ERROR_REASONS.PODCAST_SOURCE_MISSING,
    });
  }

  // 2) 纯音频改写（确定性词表；逐句披露）
  const plan = await getPlan(deps, { workspaceId: input.workspaceId, projectId: input.projectId, planId: input.planId });
  const adaptation = adaptNarrationForAudio(plan.narrationBlocks);
  const speakable = adaptation.units.filter((unit) => unit.adaptedText !== '');
  if (speakable.length === 0) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, '全部旁白块均为纯视觉指涉（移除后无音频内容）——纯音频版本不可生成', 422, {
      reason: PODCAST_ERROR_REASONS.NO_AUDIO_CONTENT,
    });
  }

  // 3) PODCAST 变体重合成（子集文本 → 未覆盖块整块跳过；全新音频/时间戳；不进视频主链）
  const master = await synthesizeMasterNarration(deps, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    planId: input.planId,
    variant: 'PODCAST',
    texts: speakable.map((unit) => ({ narrationBlockId: unit.narrationBlockId, text: unit.adaptedText })),
  });

  // 4) 章节 = 派生 Master 的真实 cue（时间戳来自新音频的 Alignment）
  const chapters = master.segments.map((segment, index) => ({
    index,
    title: `第 ${String(index + 1)} 节：${[...segment.text].slice(0, 16).join('')}${[...segment.text].length > 16 ? '…' : ''}`,
    startMs: segment.startMs,
    durationMs: segment.durationMs,
  }));

  // 5) 混音计划（纯计算：旁白基准 cue + ducking 结构；V1 未绑定 BGM → 显式披露）
  const mixPlan: MixPlan = planAudioMix({
    projectId: input.projectId,
    durationMs: master.totalDurationMs,
    cues: master.cues,
    tracks: [],
    ducking: { level: 0.355, attackMs: 120, releaseMs: 320 },
  });
  const mixNote = '未绑定 BGM/片头/片尾素材：混音计划仅含旁白基准轨与 ducking 结构（绑定素材后重算）；最终混音由渲染管线按计划执行。';

  // 6) 元数据与署名（不编造：来源来自 project_sources；无来源 → 明示）
  const sourceRows = await deps.db
    .select({ id: projectSources.id, title: projectSources.title, publisher: projectSources.publisher })
    .from(projectSources)
    .where(and(eq(projectSources.workspaceId, input.workspaceId), eq(projectSources.projectId, input.projectId)));
  const attribution =
    sourceRows.length === 0
      ? { text: '来源见原文（未收录来源元数据）', sourceIds: [] as string[] }
      : {
          text: `来源：${sourceRows
            .slice(0, 3)
            .map((source) => `《${source.title}》（${source.publisher}）`)
            .join('、')}`,
          sourceIds: sourceRows.map((source) => source.id),
        };

  const inserted = await deps.db
    .insert(podcastEpisodes)
    .values({
      id: `pod_${randomUUID()}`,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      planId: input.planId,
      sourceNarrationId: sourceNarration.id,
      masterNarrationId: master.id,
      language: sourceNarration.language ?? 'zh',
      title: `${plan.title}（播客版）`,
      units: adaptation.units,
      skippedBlockIds: adaptation.skippedBlockIds,
      coverage: {
        sentencesAdapted: adaptation.sentencesAdapted,
        sentencesRemoved: adaptation.sentencesRemoved,
        sentencesTotal: adaptation.sentencesTotal,
      },
      chapters,
      mixPlan,
      mixNote,
      metadata: { title: `${plan.title}（播客版）`, language: sourceNarration.language ?? 'zh', explicit: false, bgmBound: false },
      attribution,
    })
    .returning();
  const row = inserted[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'podcast episode insert failed', 500);
  return toEpisodeDto(row);
}

/** 确定性校验（对已存集重跑全部检查；error/warning 分明——与生成时的门同一套规则）。 */
export async function validatePodcastEpisode(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; episodeId: string },
): Promise<{ episodeId: string; result: ValidationResult; validatedAt: string }> {
  const rows = await deps.db
    .select()
    .from(podcastEpisodes)
    .where(and(eq(podcastEpisodes.id, input.episodeId), eq(podcastEpisodes.workspaceId, input.workspaceId), eq(podcastEpisodes.projectId, input.projectId)))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new ApiFailure(ERROR_CODES.NOT_FOUND, '播客集不存在', 404, { reason: PODCAST_ERROR_REASONS.EPISODE_NOT_FOUND });
  }
  const episode = toEpisodeDto(row);
  const issues: ValidationResult['issues'] = [];
  const push = (severity: 'error' | 'warning', code: string, message: string): void => {
    issues.push({ severity, code, message, artifactId: null });
  };

  // 1) 空集
  if (episode.units.length === 0) push('error', PODCAST_VALIDATION_CODES.NO_UNITS, '无任何可用旁白单元');

  // 2) 视觉指涉：改写脚本不得再含词表词
  for (const unit of episode.units) {
    if (containsVisualReference(unit.adaptedText)) {
      push('error', PODCAST_VALIDATION_CODES.VISUAL_REFERENCE_PRESENT, `单元 ${unit.narrationBlockId} 改写文本仍含视觉指涉表达（去除"看屏幕"未达成）`);
    }
  }

  // 3) 章节 = 派生 Master 的真实 cue（逐条核对时间戳与数量）
  const master = await getPodcastMaster(deps, { workspaceId: input.workspaceId, projectId: input.projectId, planId: episode.planId });
  if (master === null) {
    push('error', PODCAST_VALIDATION_CODES.CHAPTERS_MISMATCH, '派生 Master（PODCAST 变体）缺失：章节无法对账');
  } else {
    if (episode.chapters.length !== master.segments.length) {
      push('error', PODCAST_VALIDATION_CODES.CHAPTERS_MISMATCH, `章节数 ${String(episode.chapters.length)} ≠ 派生 Master 段数 ${String(master.segments.length)}`);
    }
    for (const [index, chapter] of episode.chapters.entries()) {
      const segment = master.segments[index];
      if (segment === undefined) break;
      if (chapter.startMs !== segment.startMs || chapter.durationMs !== segment.durationMs) {
        push('error', PODCAST_VALIDATION_CODES.CHAPTERS_MISMATCH, `章节 ${String(chapter.index)} 时间戳与派生 Master 不一致（章节时间必须来自实际音频）`);
        break;
      }
    }
  }

  // 4) 元数据完整
  if (episode.metadata.title === '' || episode.metadata.language === '') {
    push('error', PODCAST_VALIDATION_CODES.METADATA_INCOMPLETE, '元数据不完整（标题/语言缺失）');
  }

  // 5) 授权/署名（项目有来源但署名为空 → error；无来源 → warning 明示）
  const sourceCount = await deps.db
    .select({ id: projectSources.id })
    .from(projectSources)
    .where(and(eq(projectSources.workspaceId, input.workspaceId), eq(projectSources.projectId, input.projectId)));
  if (sourceCount.length > 0 && episode.attribution.sourceIds.length === 0) {
    push('error', PODCAST_VALIDATION_CODES.ATTRIBUTION_MISSING, '项目存在来源但署名缺失（授权不完整）');
  }
  if (sourceCount.length === 0) {
    push('warning', PODCAST_VALIDATION_CODES.ATTRIBUTION_MISSING, '项目无来源记录：署名为明示占位（未收录来源元数据）');
  }

  // 6) 混音计划存在
  if (episode.mixPlan.tracks === undefined || episode.mixNote === '') {
    push('error', PODCAST_VALIDATION_CODES.MIX_PLAN_MISSING, '混音计划缺失');
  }

  // 7) 移除比例披露（>50% 视觉指涉 → warning）
  if (episode.coverage.sentencesTotal > 0 && episode.coverage.sentencesRemoved / episode.coverage.sentencesTotal > 0.5) {
    push(
      'warning',
      PODCAST_VALIDATION_CODES.HEAVY_REMOVAL,
      `视觉指涉移除比例过高：${String(episode.coverage.sentencesRemoved)}/${String(episode.coverage.sentencesTotal)} 句被移除（请核对叙事完整性）`,
    );
  }

  const result = validationResultSchema.parse({ ok: issues.every((issue) => issue.severity !== 'error'), issues });
  return podcastValidationResultSchema.parse({ episodeId: episode.id, result, validatedAt: new Date().toISOString() });
}

void podcastValidationResultSchema;
