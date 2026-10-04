import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  ApiFailure,
  EVIDENCE_ERROR_REASONS,
  ERROR_CODES,
  chartBindingCheckSchema,
  citationRecordSchema,
  claimRecordSchema,
  datasetRecordSchema,
  extractionResultSchema,
  type ChartBindingCheck,
  type CitationRecord,
  type ClaimRecord,
  type ContentBlock,
  type CreateDatasetRequest,
  type DatasetRecord,
  type ExtractionResult,
  type FactVisualDecision,
  type NumericMention,
} from '@ancs/contracts';
import { claims, contentBlocks, contentDocuments, projectSources, sourceCitations, structuredDatasets } from '@ancs/db';
import { checkChartBinding, extractClaimCandidates, extractNumericMentions, extractTimelineMentions, extractionFingerprint, planFactVisual } from './evidence-extract.js';
import type { DomainDeps } from './channels.js';

/**
 * 证据与数据服务（P04-02 / 规范 §7、§10.3、§85）。
 *
 * 可追溯链：Claim → Citation(locator=块 ID + 字符区间) → Source(url/contentHash)；
 * Dataset → sourceIds → Source。**fact 类 Claim 必须 ≥1 来源**；图表只能绑定
 * 非 synthetic、非空、有来源的数据集；数据缺失 → `planFactVisual` 降级（绝不编造数列）。
 */

const toClaimDto = (row: typeof claims.$inferSelect): ClaimRecord =>
  claimRecordSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    documentId: row.documentId,
    blockId: row.blockId,
    text: row.text,
    factuality: row.factuality,
    sourceIds: row.sourceIds,
    structuredData: row.structuredData,
    locked: row.locked,
    extraction: row.extraction,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });

const toCitationDto = (row: typeof sourceCitations.$inferSelect): CitationRecord =>
  citationRecordSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    claimId: row.claimId,
    sourceId: row.sourceId,
    locator: row.locator,
    quotedText: row.quotedText,
    createdAt: row.createdAt.toISOString(),
  });

const toDatasetDto = (row: typeof structuredDatasets.$inferSelect): DatasetRecord =>
  datasetRecordSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    title: row.title,
    unit: row.unit,
    sourceIds: row.sourceIds,
    synthetic: row.synthetic,
    note: row.note ?? undefined,
    series: row.series,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });

async function loadDocumentBlocks(deps: DomainDeps, workspaceId: string, documentId: string): Promise<ContentBlock[]> {
  const rows = await deps.db
    .select()
    .from(contentBlocks)
    .where(and(eq(contentBlocks.documentId, documentId), eq(contentBlocks.workspaceId, workspaceId)))
    .orderBy(contentBlocks.position);
  return rows.map(
    (row) =>
      ({
        id: row.id,
        type: row.blockType,
        ...(row.level !== null ? { level: row.level } : {}),
        ...(row.text !== null ? { text: row.text } : {}),
        ...(row.items !== null ? { items: row.items as string[] } : {}),
        ...(row.table !== null ? { table: row.table as { columns: string[]; rows: string[][] } } : {}),
        ...(row.note !== null ? { note: row.note } : {}),
      }) as ContentBlock,
  );
}

/**
 * 运行确定性抽取（可重入：同一指纹重复运行不产生重复 Claim——已存在的同文本 Claim 跳过）。
 * 事实（fact）Claim 的来源 = 文档的来源链（URL 文章 → 该文档的 sourceId；粘贴/脚本无来源 → fact 降级为
 * uncertain 并标注原因，保证"事实必须可追溯"不被动摇）。
 */
export async function runExtraction(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; documentId: string },
): Promise<ExtractionResult> {
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

  const blocks = await loadDocumentBlocks(deps, input.workspaceId, input.documentId);
  const candidates = extractClaimCandidates(blocks);
  const numericMentions: NumericMention[] = blocks.flatMap((block) => extractNumericMentions(block));
  const timeline = blocks.flatMap((block) =>
    extractTimelineMentions(block).map((mention) => ({ blockId: block.id, date: mention.date, description: mention.description })),
  );

  const sourceId = document.sourceId;
  const notes: string[] = [];
  const createdClaims: ClaimRecord[] = [];
  const createdCitations: CitationRecord[] = [];

  await deps.db.transaction(async (tx) => {
    for (const candidate of candidates) {
      // fact 类必须有可追溯来源；无来源（粘贴/脚本）→ 降级为 uncertain 并记录原因（不静默造假）
      let factuality = candidate.factuality;
      if (factuality === 'fact' && sourceId === null) {
        factuality = 'uncertain';
        if (!notes.some((note) => note.includes('无可追溯来源'))) {
          notes.push('部分句子无可追溯来源（粘贴/手写输入）：事实性降级为 uncertain，供人工补充来源后再升级');
        }
      }
      // 幂等：同文档同文本的 Claim 不重复创建
      const existing = await tx
        .select({ id: claims.id })
        .from(claims)
        .where(and(eq(claims.documentId, document.id), eq(claims.text, candidate.text)))
        .limit(1);
      if (existing[0] !== undefined) continue;

      const claimId = `clm_${randomUUID()}`;
      const inserted = await tx
        .insert(claims)
        .values({
          id: claimId,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          documentId: document.id,
          blockId: candidate.blockId,
          text: candidate.text,
          factuality,
          sourceIds: sourceId === null ? [] : [sourceId],
          structuredData: [],
          locked: false,
          extraction: {
            method: 'DETERMINISTIC',
            confidence: candidate.confidence,
            sourceText: candidate.numericMentions.length > 0 ? candidate.numericMentions.map((mention) => mention.raw).join(' / ') : null,
          },
        })
        .returning();
      const claimRow = inserted[0];
      if (!claimRow) throw new ApiFailure(ERROR_CODES.INTERNAL, 'claim insert failed', 500);
      createdClaims.push(toClaimDto(claimRow));

      // Citation：定位到块 + 字符区间（可追溯）
      if (sourceId !== null) {
        const citationId = `cit_${randomUUID()}`;
        const citationRows = await tx
          .insert(sourceCitations)
          .values({
            id: citationId,
            workspaceId: input.workspaceId,
            claimId,
            sourceId,
            locator: `${candidate.blockId}:${String(candidate.start)}-${String(candidate.end)}`,
            quotedText: candidate.text.slice(0, 1000),
          })
          .returning();
        const citationRow = citationRows[0];
        if (citationRow) createdCitations.push(toCitationDto(citationRow));
      }
    }

    await tx
      .update(contentDocuments)
      .set({
        extractions: {
          fingerprint: extractionFingerprint(blocks),
          numericMentions,
          timeline,
          runAt: new Date().toISOString(),
        },
        updatedAt: new Date(),
      })
      .where(eq(contentDocuments.id, document.id));
  });

  return extractionResultSchema.parse({
    documentId: document.id,
    method: 'DETERMINISTIC',
    claims: createdClaims,
    citations: createdCitations,
    numericMentions,
    timeline,
    summary: {
      blockCount: blocks.length,
      claimCount: createdClaims.length,
      numericCount: numericMentions.length,
      timelineCount: timeline.length,
      notes,
    },
  });
}

/** 手动创建 Claim（作者补录；fact 类必须带来源）。 */
export async function createClaim(
  deps: DomainDeps,
  input: {
    workspaceId: string;
    projectId: string;
    documentId?: string | null;
    input: {
      text: string;
      factuality: 'fact' | 'analysis' | 'opinion' | 'uncertain';
      sourceIds?: string[];
      locator?: string;
      quotedText?: string | null;
    };
  },
): Promise<{ claim: ClaimRecord; citations: CitationRecord[] }> {
  const sourceIds = input.input.sourceIds ?? [];
  if (input.input.factuality === 'fact' && sourceIds.length === 0) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'fact 类 Claim 必须至少有一个来源（不可追溯的事实不允许存在）', 422, {
      reason: EVIDENCE_ERROR_REASONS.CLAIM_REQUIRES_SOURCE,
    });
  }
  await assertSourcesInProject(deps, input.workspaceId, input.projectId, sourceIds);

  return deps.db.transaction(async (tx) => {
    const claimId = `clm_${randomUUID()}`;
    const inserted = await tx
      .insert(claims)
      .values({
        id: claimId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        documentId: input.documentId ?? null,
        blockId: null,
        text: input.input.text,
        factuality: input.input.factuality,
        sourceIds,
        structuredData: [],
        locked: false,
        extraction: { method: 'MANUAL', confidence: 1, sourceText: null },
      })
      .returning();
    const claimRow = inserted[0];
    if (!claimRow) throw new ApiFailure(ERROR_CODES.INTERNAL, 'claim insert failed', 500);

    const citations: CitationRecord[] = [];
    for (const sourceId of sourceIds) {
      const citationRows = await tx
        .insert(sourceCitations)
        .values({
          id: `cit_${randomUUID()}`,
          workspaceId: input.workspaceId,
          claimId,
          sourceId,
          locator: input.input.locator ?? 'manual',
          quotedText: input.input.quotedText ?? null,
        })
        .returning();
      const citationRow = citationRows[0];
      if (citationRow) citations.push(toCitationDto(citationRow));
    }
    return { claim: toClaimDto(claimRow), citations };
  });
}

async function assertSourcesInProject(deps: DomainDeps, workspaceId: string, projectId: string, sourceIds: string[]): Promise<void> {
  if (sourceIds.length === 0) return;
  const rows = await deps.db
    .select({ id: projectSources.id })
    .from(projectSources)
    .where(and(eq(projectSources.workspaceId, workspaceId), eq(projectSources.projectId, projectId), inArray(projectSources.id, sourceIds)));
  if (rows.length !== sourceIds.length) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, '引用的来源不属于该项目', 422, {
      reason: EVIDENCE_ERROR_REASONS.SOURCE_NOT_IN_PROJECT,
      requested: sourceIds,
      found: rows.map((row) => row.id),
    });
  }
}

export async function listClaims(deps: DomainDeps, input: { workspaceId: string; projectId: string; documentId?: string }): Promise<ClaimRecord[]> {
  const conditions = [eq(claims.workspaceId, input.workspaceId), eq(claims.projectId, input.projectId)];
  if (input.documentId !== undefined) conditions.push(eq(claims.documentId, input.documentId));
  const rows = await deps.db
    .select()
    .from(claims)
    .where(and(...conditions))
    .orderBy(desc(claims.createdAt));
  return rows.map(toClaimDto);
}

export async function listClaimCitations(deps: DomainDeps, input: { workspaceId: string; claimId: string }): Promise<CitationRecord[]> {
  const rows = await deps.db
    .select()
    .from(sourceCitations)
    .where(and(eq(sourceCitations.workspaceId, input.workspaceId), eq(sourceCitations.claimId, input.claimId)));
  return rows.map(toCitationDto);
}

/** 编辑 Claim：锁定后拒绝修改（§8.2：锁定文字不得静默修改）。 */
export async function updateClaim(
  deps: DomainDeps,
  input: {
    workspaceId: string;
    claimId: string;
    input: { text?: string; factuality?: 'fact' | 'analysis' | 'opinion' | 'uncertain'; locked?: boolean };
  },
): Promise<ClaimRecord> {
  const rows = await deps.db
    .select()
    .from(claims)
    .where(and(eq(claims.id, input.claimId), eq(claims.workspaceId, input.workspaceId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'claim not found', 404);
  const changingContent = input.input.text !== undefined || input.input.factuality !== undefined;
  if (row.locked && changingContent) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'Claim 已锁定：解锁后才能修改内容（锁定文字不得静默修改，§8.2）', 409, {
      reason: EVIDENCE_ERROR_REASONS.CLAIM_LOCKED,
    });
  }
  const nextFactuality = input.input.factuality ?? row.factuality;
  if (nextFactuality === 'fact' && (row.sourceIds as string[]).length === 0) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'fact 类 Claim 必须至少有一个来源', 422, {
      reason: EVIDENCE_ERROR_REASONS.CLAIM_REQUIRES_SOURCE,
    });
  }
  const updated = await deps.db
    .update(claims)
    .set({
      ...(input.input.text !== undefined ? { text: input.input.text } : {}),
      ...(input.input.factuality !== undefined ? { factuality: input.input.factuality } : {}),
      ...(input.input.locked !== undefined ? { locked: input.input.locked } : {}),
      updatedAt: new Date(),
    })
    .where(eq(claims.id, row.id))
    .returning();
  const next = updated[0];
  if (!next) throw new ApiFailure(ERROR_CODES.INTERNAL, 'claim update failed', 500);
  return toClaimDto(next);
}

/** 建立数据集（必须携带来源；synthetic 允许存在但不可绑定事实图表）。 */
export async function createDataset(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; input: CreateDatasetRequest },
): Promise<DatasetRecord> {
  if (input.input.sourceIds.length === 0) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, '数据集必须至少有一个来源（图表只能绑定可追溯数据）', 422, {
      reason: EVIDENCE_ERROR_REASONS.DATASET_REQUIRES_SOURCE,
    });
  }
  await assertSourcesInProject(deps, input.workspaceId, input.projectId, input.input.sourceIds);
  const pointCount = input.input.series.reduce((sum, series) => sum + series.points.length, 0);
  if (pointCount === 0) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, '数据集没有任何数据点（不得渲染空图表）', 422, {
      reason: EVIDENCE_ERROR_REASONS.DATASET_EMPTY,
    });
  }

  const inserted = await deps.db
    .insert(structuredDatasets)
    .values({
      id: `ds_${randomUUID()}`,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      title: input.input.title,
      unit: input.input.unit,
      sourceIds: input.input.sourceIds,
      synthetic: input.input.synthetic,
      note: input.input.note ?? null,
      series: input.input.series,
    })
    .returning();
  const row = inserted[0];
  if (!row) throw new ApiFailure(ERROR_CODES.INTERNAL, 'dataset insert failed', 500);
  return toDatasetDto(row);
}

export async function listDatasets(deps: DomainDeps, input: { workspaceId: string; projectId: string }): Promise<DatasetRecord[]> {
  const rows = await deps.db
    .select()
    .from(structuredDatasets)
    .where(and(eq(structuredDatasets.workspaceId, input.workspaceId), eq(structuredDatasets.projectId, input.projectId)))
    .orderBy(desc(structuredDatasets.createdAt));
  return rows.map(toDatasetDto);
}

export async function getDataset(deps: DomainDeps, input: { workspaceId: string; datasetId: string }): Promise<DatasetRecord> {
  const rows = await deps.db
    .select()
    .from(structuredDatasets)
    .where(and(eq(structuredDatasets.id, input.datasetId), eq(structuredDatasets.workspaceId, input.workspaceId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'dataset not found', 404);
  return toDatasetDto(row);
}

/**
 * 图表绑定校验（**事实图表唯一入口**）：非 synthetic / 非空 / 有来源，返回必须写入 Scene 的 data_source_ids。
 * 失败时抛 422 并给出原因（绝不静默降级为"随便画个图"）。
 */
export async function assertDatasetBindableForChart(
  deps: DomainDeps,
  input: { workspaceId: string; datasetId: string },
): Promise<ChartBindingCheck> {
  const dataset = await getDataset(deps, input);
  const check = checkChartBinding(dataset);
  const parsed = chartBindingCheckSchema.parse(check);
  if (!parsed.bindable) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, '数据集不可用于事实图表', 422, {
      reason: parsed.reasons[0] ?? EVIDENCE_ERROR_REASONS.DATA_MISSING,
      datasetId: dataset.id,
      reasons: parsed.reasons,
    });
  }
  return parsed;
}

/** 事实可视化策略解析（Claim 维度；§10.3 降级阶梯）——供 Director（P04-05）调用。 */
export async function resolveFactVisualForClaim(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; claimId: string; datasetId?: string },
): Promise<FactVisualDecision> {
  const rows = await deps.db
    .select()
    .from(claims)
    .where(and(eq(claims.id, input.claimId), eq(claims.workspaceId, input.workspaceId), eq(claims.projectId, input.projectId)))
    .limit(1);
  const claim = rows[0];
  if (!claim) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'claim not found', 404);

  const citations = await listClaimCitations(deps, { workspaceId: input.workspaceId, claimId: claim.id });
  let bindable: { id: string; sourceIds: string[] } | null = null;
  if (input.datasetId !== undefined) {
    const dataset = await getDataset(deps, { workspaceId: input.workspaceId, datasetId: input.datasetId });
    const check = checkChartBinding(dataset);
    if (check.bindable) bindable = { id: dataset.id, sourceIds: check.dataSourceIds };
  }

  return planFactVisual({
    hasTraceableSource: (claim.sourceIds as string[]).length > 0 || citations.length > 0,
    claimText: claim.text,
    bindableDataset: bindable,
    quotedText: citations[0]?.quotedText ?? null,
    quoteSourceId: citations[0]?.sourceId ?? null,
  });
}
