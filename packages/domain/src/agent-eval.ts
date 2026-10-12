import type { StrategyPack } from '@ancs/contracts';
import type { DomainDeps } from './deps.js';
import { defaultAgentToolCatalog } from './agent-tools.js';
import type { EditOperation } from '@ancs/contracts';

/**
 * V6 §6.5 质量与评测：初剪的**自动指标**（人工评分仍是主要衡量）。
 *
 * - 与 AI 自检用同一套通用检查（review_draft），评测与自检口径一致；
 * - 每个指标给出原始值与 0–1 分，缺少分析层的指标为"无法评估"（null），不填分；
 * - 选用了策略时额外给出风格贴合度指标，不替代通用指标（以不选策略的评测为主）。
 */

export interface DraftReview {
  findings: { kind: string; severity: string; at: [string, string]; clipId: string | null; message: string }[];
  stats: { length: string; contentEnd: string; videoClips: number; shotSeconds: { min: string; median: string; max: string } | null; cutsPerMinute: number | null };
  notChecked: string[];
}

/** 用自检工具检查任意一份草稿（例如一个提案的操作）；不改工程。 */
export async function reviewDraftOperations(deps: DomainDeps, input: {
  workspaceId: string;
  projectId: string;
  sequenceId: string;
  baseRevision: number;
  operations: EditOperation[];
}): Promise<DraftReview> {
  const tool = defaultAgentToolCatalog().get('review_draft');
  if (tool === undefined) throw new Error('review_draft tool is not registered');
  const outcome = await tool.run({
    deps, workspaceId: input.workspaceId, projectId: input.projectId, sequenceId: input.sequenceId, actorId: 'eval', locale: 'en',
    draft: { baseRevision: input.baseRevision, operations: input.operations },
  }, {});
  if (outcome.isError) throw new Error(`review failed: ${outcome.content}`);
  return JSON.parse(outcome.content) as DraftReview;
}

export interface EvalIndicator {
  key: string;
  value: number | string | null;
  /** 0–1；null = 无法评估（缺分析层或不适用） */
  score: number | null;
  note: string;
}

export interface FirstCutScorecard {
  indicators: EvalIndicator[];
  /** 可评估指标的平均分（自动指标，不等于质量结论） */
  automaticScore: number | null;
  disclaimer: string;
}

const clamp = (value: number): number => Math.max(0, Math.min(1, Math.round(value * 100) / 100));

export function scoreFirstCut(input: {
  review: DraftReview;
  footageCount: number;
  usedFootageCount: number;
  targetSeconds?: number | null;
  strategy?: StrategyPack | null;
}): FirstCutScorecard {
  const count = (kind: string) => input.review.findings.filter((finding) => finding.kind === kind).length;
  const notChecked = (text: string) => input.review.notChecked.some((item) => item.includes(text));
  const length = Number(input.review.stats.length);
  const clips = input.review.stats.videoClips;
  const indicators: EvalIndicator[] = [
    {
      key: 'length_fit', value: length,
      score: input.targetSeconds === undefined || input.targetSeconds === null || input.targetSeconds <= 0 ? null : clamp(1 - Math.abs(length - input.targetSeconds) / input.targetSeconds),
      note: input.targetSeconds ? `target ${String(input.targetSeconds)} s` : 'no target length in the request',
    },
    { key: 'black_residue', value: count('BLACK_STRETCH'), score: notChecked('black frames') ? null : clamp(1 - 0.5 * count('BLACK_STRETCH')), note: 'black picture taken from the footage' },
    { key: 'sentence_integrity', value: count('CUT_MID_SENTENCE'), score: notChecked('spoken sentences') ? null : clamp(1 - 0.25 * count('CUT_MID_SENTENCE')), note: 'cuts inside spoken sentences' },
    { key: 'structure_cleanliness', value: count('FLASH_CLIP') + count('PICTURE_GAP') + count('LENGTH_MISMATCH') + count('EMPTY_TIMELINE'), score: clamp(1 - 0.34 * (count('FLASH_CLIP') + count('PICTURE_GAP') + count('LENGTH_MISMATCH') + 3 * count('EMPTY_TIMELINE'))), note: 'flash clips, gaps without picture, length not matching content' },
    { key: 'sound_continuity', value: count('MISSING_SOUND'), score: clips === 0 ? null : clamp(1 - count('MISSING_SOUND') / clips), note: 'picture from footage with sound but nothing audible' },
    { key: 'shot_variety', value: count('REPEATED_SHOT'), score: clamp(1 - 0.25 * count('REPEATED_SHOT')), note: 'the same part of a footage used twice' },
    {
      key: 'footage_coverage', value: input.footageCount === 0 ? null : `${String(input.usedFootageCount)}/${String(input.footageCount)}`,
      score: input.footageCount === 0 ? null : clamp(input.usedFootageCount / input.footageCount / 0.6),
      note: 'share of the footage that made it into the cut (60% or more counts as full)',
    },
  ];
  if (input.strategy) {
    const typical = input.strategy.editingDna.shotSeconds.typical;
    const median = input.review.stats.shotSeconds === null ? null : Number(input.review.stats.shotSeconds.median);
    const distance = median === null ? null : median < typical.min ? typical.min - median : median > typical.max ? median - typical.max : 0;
    indicators.push({
      key: 'style_pacing_fit', value: median,
      score: distance === null ? null : clamp(1 - distance / Math.max(typical.max - typical.min, 0.5)),
      note: `median shot length vs the strategy's ${String(typical.min)}-${String(typical.max)} s`,
    });
  }
  const scored = indicators.map((indicator) => indicator.score).filter((score): score is number => score !== null);
  return {
    indicators,
    automaticScore: scored.length === 0 ? null : clamp(scored.reduce((sum, score) => sum + score, 0) / scored.length),
    disclaimer: 'Automatic indicators only catch mechanical problems. Story, rhythm and taste are judged by people with the rating sheet.',
  };
}
