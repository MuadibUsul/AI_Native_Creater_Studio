import { and, eq, inArray } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  VISUAL_GRAMMAR_ERROR_REASONS,
  VISUAL_GRAMMAR_VERSION,
  visualPlanSchema,
  type ContentBlock,
  type DatasetRecord,
  type FactVisualStrategy,
  type SemanticType,
  type VisualPlan,
} from '@ancs/contracts';
import { claims as claimsTable, contentBlocks, sourceCitations } from '@ancs/db';
import { checkChartBinding, extractNumericMentions, extractTimelineMentions, planFactVisual } from './evidence-extract.js';
import { listDatasets } from './evidence.js';
import { datasetShape, recognizeSemanticType, ruleForSemanticType, type DatasetShape } from './visual-grammar.js';
import { getPlan } from './narrative.js';
import type { DomainDeps } from './channels.js';

/**
 * Visual Plan 服务（P04-04 / 规范 §10）。
 *
 * 对叙事计划的每个旁白块：**确定性语义识别**（规则/词典 + 数据形状）→ 语义映射的允许场景类型
 * → 数据/来源门控（复用 P04-02 的 `checkChartBinding` 与 `planFactVisual` 降级阶梯）。
 *
 * 纪律：
 * - 事实图表（requiresData 语义）在没有**可绑定**数据集时绝不规划图表，按
 *   CHART → QUOTE → SOURCE_CARD → TEXTUAL_EXPLANATION → REQUEST_DATA 受控降级（与 P04-02 同一事实来源）；
 * - 数值类（requiresSource 语义）的数字逐字取自 Claim 文本，但必须可追溯（有来源/引文），否则同样降级；
 * - VisualPlan 是**纯投影**（NarrativePlan + Claims + Datasets → 计划，不落库）：同一输入必得同一输出，
 *   与叙事版本天然一致；持久化留给 Director（P04-05）的正式生成产物。
 */

/** 降级策略 → 可渲染的场景类型（V1 标准类型；REQUEST_DATA 例外，见调用处）。 */
const DEGRADED_SCENE_TYPES: Readonly<Record<Exclude<FactVisualStrategy, 'CHART'>, string>> = {
  QUOTE: 'QUOTE_CARD',
  SOURCE_CARD: 'SOURCE_CARD',
  TEXTUAL_EXPLANATION: 'SUMMARY',
  REQUEST_DATA: 'SOURCE_CARD',
};

/** 语义 → 数据集适配判定（候选已过绑定门控；缺省要求至少 1 个数据点）。 */
const DATASET_FITS: Partial<Record<SemanticType, (shape: DatasetShape) => boolean>> = {
  TREND: (shape) => shape.timeOrdered && shape.pointCount >= 3,
  COMPARISON: (shape) => shape.hasPairedSeries,
  RANKING: (shape) => shape.seriesCount === 1 && shape.pointCount <= 10,
  YIELD_SPREAD: (shape) => shape.timeOrdered && shape.seriesCount >= 2,
  YIELD_CURVE: (shape) => shape.timeOrdered,
  PRICE_SERIES: (shape) => shape.timeOrdered,
  CANDLE_SERIES: (shape) => shape.timeOrdered,
  SUPPLY_DEMAND: (shape) => shape.timeOrdered,
  TRADE_FLOW: (shape) => shape.pointCount >= 2,
  CAPITAL_FLOW: (shape) => shape.pointCount >= 2,
  BALANCE_SHEET: (shape) => shape.seriesCount >= 1,
  SCENARIO_COMPARE: (shape) => shape.hasPairedSeries,
};

interface CandidateDataset {
  record: DatasetRecord;
  shape: DatasetShape & { bindable: boolean };
  dataSourceIds: string[];
}

export async function planVisual(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; planId: string },
): Promise<VisualPlan> {
  const plan = await getPlan(deps, input);

  const claimIds = [...new Set(plan.narrationBlocks.flatMap((block) => block.claimIds))];
  const claimRows =
    claimIds.length === 0
      ? []
      : await deps.db
          .select()
          .from(claimsTable)
          .where(
            and(
              eq(claimsTable.workspaceId, input.workspaceId),
              eq(claimsTable.projectId, input.projectId),
              inArray(claimsTable.id, claimIds),
            ),
          );
  const claimById = new Map(claimRows.map((row) => [row.id, row]));

  const citations =
    claimIds.length === 0
      ? []
      : await deps.db
          .select()
          .from(sourceCitations)
          .where(and(eq(sourceCitations.workspaceId, input.workspaceId), inArray(sourceCitations.claimId, claimIds)));
  const citationsByClaim = new Map<string, typeof citations>();
  for (const citation of citations) {
    const list = citationsByClaim.get(citation.claimId) ?? [];
    list.push(citation);
    citationsByClaim.set(citation.claimId, list);
  }

  const blockIds = [...new Set(claimRows.map((row) => row.blockId).filter((id): id is string => id !== null))];
  const blockRows =
    blockIds.length === 0
      ? []
      : await deps.db
          .select({ id: contentBlocks.id, blockType: contentBlocks.blockType })
          .from(contentBlocks)
          .where(and(eq(contentBlocks.workspaceId, input.workspaceId), inArray(contentBlocks.id, blockIds)));
  const blockTypeById = new Map(blockRows.map((row) => [row.id, row.blockType]));

  const datasets = await listDatasets(deps, { workspaceId: input.workspaceId, projectId: input.projectId });
  const candidates: CandidateDataset[] = datasets.map((record) => {
    const check = checkChartBinding(record);
    return {
      record,
      shape: datasetShape({ id: record.id, unit: record.unit, bindable: check.bindable, series: record.series }),
      dataSourceIds: check.dataSourceIds,
    };
  });

  const items = plan.narrationBlocks.map((block) => {
    const blockClaims = block.claimIds.map((id) => claimById.get(id)).filter((row) => row !== undefined);
    const blockCitations = blockClaims.flatMap((row) => citationsByClaim.get(row.id) ?? []);
    const quote = blockCitations.find((citation) => citation.quotedText !== null) ?? null;

    // 识别以**事实（Claim）文本**为准：旁白是口语表达（"先把镜头拉近"等引导语会污染关键词判定），
    // 只有当块不含事实引用时才退回旁白文本。
    const claimTexts = blockClaims.map((row) => row.text);
    const text = (claimTexts.length > 0 ? claimTexts : [block.text]).join('\n').trim();
    const syntheticBlock: ContentBlock = { id: `blk_visual_${block.id}`, type: 'paragraph', text };
    const numericMentions = extractNumericMentions(syntheticBlock).map((mention) => ({
      raw: mention.raw,
      canonical: mention.canonical,
      unit: mention.unit,
    }));
    const timelineMentions = extractTimelineMentions(syntheticBlock).length;
    const hasSource =
      blockCitations.length > 0 || blockClaims.some((row) => (row.sourceIds as string[]).length > 0);
    const hasQuote = quote !== null;
    const blockKinds = blockClaims
      .map((row) => (row.blockId === null ? null : blockTypeById.get(row.blockId)))
      .filter((kind): kind is string => kind !== undefined && kind !== null);

    const recognition = recognizeSemanticType({
      claimText: text,
      numericMentions,
      datasets: candidates.map((candidate) => candidate.shape),
      timelineMentions,
      hasQuote,
      hasSource,
      entityKinds: [],
      blockKinds,
    });
    const rule = ruleForSemanticType(recognition.semanticType);
    if (rule.allowedSceneTypes.length === 0) {
      throw new ApiFailure(ERROR_CODES.INTERNAL, `语义 ${recognition.semanticType} 无可渲染场景类型`, 500, {
        reason: VISUAL_GRAMMAR_ERROR_REASONS.NO_ALLOWED_SCENE_TYPE,
      });
    }

    let suggestedSceneType = rule.preferredSceneTypes[0] ?? rule.allowedSceneTypes[0] ?? '';
    let datasetId: string | null = null;
    let dataSourceIds: string[] = [];
    let fallbackStrategy: FactVisualStrategy | null = null;
    const warnings: string[] = [];

    if (rule.requiresData) {
      const fits = DATASET_FITS[recognition.semanticType] ?? ((shape: DatasetShape) => shape.pointCount >= 1);
      const explicitIds = new Set(
        blockClaims.flatMap((row) =>
          ((row.structuredData as { datasetId: string }[] | null) ?? []).map((entry) => entry.datasetId),
        ),
      );
      const bound =
        candidates.find((candidate) => candidate.shape.bindable && explicitIds.has(candidate.record.id) && fits(candidate.shape)) ??
        candidates.find((candidate) => candidate.shape.bindable && fits(candidate.shape)) ??
        null;
      const decision = planFactVisual({
        hasTraceableSource: hasSource,
        claimText: text,
        bindableDataset: bound === null ? null : { id: bound.record.id, sourceIds: bound.dataSourceIds },
        quotedText: quote?.quotedText ?? null,
        quoteSourceId: quote?.sourceId ?? null,
      });
      if (decision.strategy === 'CHART' && bound !== null) {
        datasetId = bound.record.id;
        dataSourceIds = decision.dataSourceIds;
        if (bound.shape.seriesCount < 2 && (recognition.semanticType === 'SUPPLY_DEMAND' || recognition.semanticType === 'COMPARISON')) {
          warnings.push('语义需要两条以上序列，当前数据集仅 1 条：请补充对照序列');
        }
      } else {
        fallbackStrategy = decision.strategy === 'CHART' ? 'REQUEST_DATA' : decision.strategy;
        suggestedSceneType =
          fallbackStrategy === 'REQUEST_DATA'
            ? (rule.preferredSceneTypes[0] ?? rule.allowedSceneTypes[0] ?? '')
            : DEGRADED_SCENE_TYPES[fallbackStrategy];
        warnings.push(decision.reason);
        if (fallbackStrategy === 'REQUEST_DATA') {
          warnings.push('缺少可绑定的结构化数据集：请补充数据集或来源（不得由 AI 编造数列）');
        }
      }
    } else if (rule.requiresSource && !hasSource && !hasQuote) {
      const decision = planFactVisual({
        hasTraceableSource: false,
        claimText: text,
        bindableDataset: null,
        quotedText: null,
        quoteSourceId: null,
      });
      fallbackStrategy = decision.strategy === 'CHART' ? 'REQUEST_DATA' : decision.strategy;
      suggestedSceneType =
        fallbackStrategy === 'REQUEST_DATA'
          ? (rule.preferredSceneTypes[0] ?? rule.allowedSceneTypes[0] ?? '')
          : DEGRADED_SCENE_TYPES[fallbackStrategy];
      warnings.push(decision.reason);
      if (fallbackStrategy === 'REQUEST_DATA') {
        warnings.push('数值缺少可追溯来源：请补充来源或多转换为文本解释');
      }
    }

    return {
      narrationBlockId: block.id,
      claimIds: block.claimIds,
      semanticType: recognition.semanticType,
      recognition: {
        method: 'DETERMINISTIC' as const,
        confidence: recognition.confidence,
        rule: recognition.rule,
        reasons: recognition.reasons,
      },
      allowedSceneTypes: rule.allowedSceneTypes,
      suggestedSceneType,
      datasetId,
      dataSourceIds,
      fallbackStrategy,
      warnings,
    };
  });

  const bySemanticType: Record<string, number> = {};
  for (const item of items) {
    bySemanticType[item.semanticType] = (bySemanticType[item.semanticType] ?? 0) + 1;
  }

  return visualPlanSchema.parse({
    schemaVersion: '0.1',
    grammarVersion: VISUAL_GRAMMAR_VERSION,
    planId: plan.id,
    items,
    summary: {
      total: items.length,
      chartItems: items.filter((item) => item.datasetId !== null).length,
      degradedItems: items.filter((item) => item.fallbackStrategy !== null).length,
      bySemanticType,
    },
  });
}
