import { randomUUID } from 'node:crypto';
import { and, desc, eq, max, sql } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  FINANCE_ERROR_REASONS,
  financeArtifactSchema,
  financeDataSourceSchema,
  financeTemplateSchema,
  type CreateFinanceDataSource,
  type CreateFinanceTemplate,
  type FinanceArtifact,
  type FinanceDataSource,
  type FinanceTemplate,
  type GenerateFinanceArtifactRequest,
} from '@ancs/contracts';
import { financeArtifacts, financeDataSources, financeTemplates } from '@ancs/db';
import type { DomainDeps } from './deps.js';

const sourceDto = (row: typeof financeDataSources.$inferSelect): FinanceDataSource => financeDataSourceSchema.parse({ ...row, createdAt: row.createdAt.toISOString() });
const templateDto = (row: typeof financeTemplates.$inferSelect): FinanceTemplate => financeTemplateSchema.parse({ ...row, createdAt: row.createdAt.toISOString() });
const artifactDto = (row: typeof financeArtifacts.$inferSelect): FinanceArtifact => financeArtifactSchema.parse({ ...row, createdAt: row.createdAt.toISOString() });

export async function createFinanceDataSource(deps: DomainDeps, input: { workspaceId: string; request: CreateFinanceDataSource }): Promise<FinanceDataSource> {
  const row = (await deps.db.insert(financeDataSources).values({ id: `fds_${randomUUID()}`, workspaceId: input.workspaceId, ...input.request }).returning())[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, '财经数据源保存失败', 500);
  return sourceDto(row);
}

export async function listFinanceDataSources(deps: DomainDeps, input: { workspaceId: string }): Promise<FinanceDataSource[]> {
  return (await deps.db.select().from(financeDataSources).where(eq(financeDataSources.workspaceId, input.workspaceId)).orderBy(desc(financeDataSources.createdAt))).map(sourceDto);
}

export async function createFinanceTemplate(deps: DomainDeps, input: { workspaceId: string; request: CreateFinanceTemplate }): Promise<FinanceTemplate> {
  return deps.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${input.workspaceId}:${input.request.key}`}))`);
    const versions = await tx.select({ value: max(financeTemplates.version) }).from(financeTemplates).where(and(eq(financeTemplates.workspaceId, input.workspaceId), eq(financeTemplates.key, input.request.key)));
    const row = (await tx.insert(financeTemplates).values({ id: `ftpl_${randomUUID()}`, workspaceId: input.workspaceId, version: Number(versions[0]?.value ?? 0) + 1, ...input.request }).returning())[0];
    if (row === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, '财经模板保存失败', 500);
    return templateDto(row);
  });
}

export async function listFinanceTemplates(deps: DomainDeps, input: { workspaceId: string }): Promise<FinanceTemplate[]> {
  return (await deps.db.select().from(financeTemplates).where(eq(financeTemplates.workspaceId, input.workspaceId)).orderBy(desc(financeTemplates.createdAt))).map(templateDto);
}

export async function generateFinanceArtifact(deps: DomainDeps, input: { workspaceId: string; request: GenerateFinanceArtifactRequest }): Promise<FinanceArtifact> {
  const [sourceRow, templateRow] = await Promise.all([
    deps.db.select().from(financeDataSources).where(and(eq(financeDataSources.id, input.request.dataSourceId), eq(financeDataSources.workspaceId, input.workspaceId))).limit(1),
    deps.db.select().from(financeTemplates).where(and(eq(financeTemplates.id, input.request.templateId), eq(financeTemplates.workspaceId, input.workspaceId))).limit(1),
  ]);
  const source = sourceRow[0];
  const template = templateRow[0];
  if (source === undefined || template === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, '财经数据源或模板不存在', 404);
  if (template.visualizationType !== input.request.visualizationType) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, '模板类型与财经可视化类型不匹配', 422, { reason: FINANCE_ERROR_REASONS.TEMPLATE_TYPE_MISMATCH });
  }
  if (input.request.data.some((item) => item.sourceId !== source.id) || input.request.relations.some((item) => item.sourceId !== source.id)) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, '数据或关系引用了未声明的数据源', 422, { reason: FINANCE_ERROR_REASONS.SOURCE_MISMATCH });
  }
  const missing = input.request.data.filter((item) => item.value === null).map((item) => item.label);
  if (missing.length > 0) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, '财经数据存在缺失值，不能编造图表', 422, { reason: FINANCE_ERROR_REASONS.MISSING_DATA, labels: missing });
  }
  const row = (await deps.db.insert(financeArtifacts).values({
    id: `fart_${randomUUID()}`, workspaceId: input.workspaceId, visualizationType: input.request.visualizationType, title: input.request.title,
    dataSourceSnapshot: sourceDto(source), templateSnapshot: templateDto(template), data: input.request.data, relations: input.request.relations,
  }).returning())[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, '财经产物保存失败', 500);
  return artifactDto(row);
}

export async function listFinanceArtifacts(deps: DomainDeps, input: { workspaceId: string }): Promise<FinanceArtifact[]> {
  return (await deps.db.select().from(financeArtifacts).where(eq(financeArtifacts.workspaceId, input.workspaceId)).orderBy(desc(financeArtifacts.createdAt))).map(artifactDto);
}
