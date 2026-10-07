import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';

export const FINANCE_VISUALIZATION_TYPES = ['CANDLE', 'YIELD_CURVE', 'POLICY_PATH', 'SUPPLY_CHAIN', 'TRADE_ROUTE', 'SCENARIO_TREE'] as const;
export const financeVisualizationTypeSchema = z.enum(FINANCE_VISUALIZATION_TYPES);
export type FinanceVisualizationType = z.infer<typeof financeVisualizationTypeSchema>;

export const dataLicenseSchema = z.object({
  licenseId: z.string().min(1).max(160),
  name: z.string().min(1).max(200),
  url: z.string().url().nullable().default(null),
  allowedUse: z.string().min(1).max(500),
  effectiveAt: isoDateTimeSchema,
});

export const financeDataSourceSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  name: z.string().min(1).max(200),
  sourceUrl: z.string().url().nullable().default(null),
  license: dataLicenseSchema,
  createdAt: isoDateTimeSchema,
});
export type FinanceDataSource = z.infer<typeof financeDataSourceSchema>;
export const createFinanceDataSourceSchema = financeDataSourceSchema.omit({ id: true, workspaceId: true, createdAt: true });
export type CreateFinanceDataSource = z.infer<typeof createFinanceDataSourceSchema>;
export const financeDataSourceListSchema = z.object({ items: z.array(financeDataSourceSchema) });

export const financeTemplateSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  key: z.string().min(1).max(120),
  version: z.number().int().positive(),
  name: z.string().min(1).max(200),
  visualizationType: financeVisualizationTypeSchema,
  config: z.record(z.string(), z.unknown()),
  createdAt: isoDateTimeSchema,
});
export type FinanceTemplate = z.infer<typeof financeTemplateSchema>;
export const createFinanceTemplateSchema = financeTemplateSchema.omit({ id: true, workspaceId: true, version: true, createdAt: true });
export type CreateFinanceTemplate = z.infer<typeof createFinanceTemplateSchema>;
export const financeTemplateListSchema = z.object({ items: z.array(financeTemplateSchema) });

export const financeDatumSchema = z.object({
  label: z.string().min(1).max(200),
  value: z.number().finite().nullable(),
  unit: z.string().min(1).max(40),
  currency: z.string().min(3).max(8).nullable().default(null),
  timezone: z.string().min(1).max(80),
  adjustment: z.string().min(1).max(120),
  sourceId: opaqueIdSchema,
  observedAt: isoDateTimeSchema,
  dimensions: z.record(z.string(), z.string()).default({}),
});
export const financeRelationSchema = z.object({ from: z.string().min(1), to: z.string().min(1), label: z.string().min(1), sourceId: opaqueIdSchema });

export const generateFinanceArtifactRequestSchema = z.object({
  visualizationType: financeVisualizationTypeSchema,
  title: z.string().min(1).max(300),
  dataSourceId: opaqueIdSchema,
  templateId: opaqueIdSchema,
  data: z.array(financeDatumSchema).min(1),
  relations: z.array(financeRelationSchema).default([]),
});
export type GenerateFinanceArtifactRequest = z.infer<typeof generateFinanceArtifactRequestSchema>;
export type GenerateFinanceArtifactRequestInput = z.input<typeof generateFinanceArtifactRequestSchema>;

export const financeArtifactSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  visualizationType: financeVisualizationTypeSchema,
  title: z.string(),
  dataSourceSnapshot: financeDataSourceSchema,
  templateSnapshot: financeTemplateSchema,
  data: z.array(financeDatumSchema),
  relations: z.array(financeRelationSchema),
  createdAt: isoDateTimeSchema,
});
export type FinanceArtifact = z.infer<typeof financeArtifactSchema>;
export const financeArtifactListSchema = z.object({ items: z.array(financeArtifactSchema) });

export const FINANCE_ERROR_REASONS = {
  MISSING_DATA: 'MISSING_DATA',
  SOURCE_MISMATCH: 'SOURCE_MISMATCH',
  TEMPLATE_TYPE_MISMATCH: 'TEMPLATE_TYPE_MISMATCH',
} as const;
