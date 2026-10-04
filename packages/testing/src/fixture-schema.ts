import { z } from 'zod';
import {
  contentDocumentSchema,
  sourceSnapshotSchema,
  structuredDatasetSchema,
} from '@ancs/contracts';

/**
 * Fixture 专用结构（P00-04 建立；P01-01 起正式契约来自 @ancs/contracts）。
 *
 * 正式化说明：ContentDocument / SourceSnapshot / StructuredDataset 的 schema 已合并进
 * packages/contracts（P01-01），本文件仅保留金样/负面用例自有的预期结构与用例外壳，
 * 并 re-export 契约 schema 供 fixture 使用者导入。
 */

export { contentDocumentSchema, sourceSnapshotSchema, structuredDatasetSchema };

export type {
  ContentDocument,
  SourceSnapshot,
  StructuredDataset,
} from '@ancs/contracts';

// ---------- Expected structure（fixture 自有，非产品契约） ----------

export const fixtureExpectedSchema = z.object({
  scenario: z.string().min(1),
  language: z.string().min(1),
  targetDurationSeconds: z.object({ min: z.number().positive(), max: z.number().positive() }),
  format: z.object({
    aspectRatio: z.string().min(1),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().int().positive(),
  }),
  chapters: z.array(z.object({ id: z.string().min(1), title: z.string().min(1), intent: z.string().min(1) })),
  requiredScenes: z.array(
    z.object({
      sceneType: z.string().min(1),
      semanticType: z.string().min(1),
      role: z.string().min(1),
      narrationLine: z.string().optional(),
      datasetId: z.string().optional(),
      seriesIds: z.array(z.string()).optional(),
      sourceId: z.string().optional(),
      constraints: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
  qaExpectations: z.record(z.string(), z.unknown()),
});

export type FixtureExpected = z.infer<typeof fixtureExpectedSchema>;

// ---------- Bundle ----------

export interface FixtureBundle {
  content: z.infer<typeof contentDocumentSchema>;
  sources: z.infer<typeof sourceSnapshotSchema>[];
  datasets: z.infer<typeof structuredDatasetSchema>[];
  expected: FixtureExpected;
}

export const sourcesFileSchema = z.object({
  meta: z.record(z.string(), z.unknown()),
  sources: z.array(sourceSnapshotSchema),
});

export const datasetsFileSchema = z.object({
  meta: z.record(z.string(), z.unknown()),
  datasets: z.array(structuredDatasetSchema),
});

export const negativeCaseSchema = z.object({
  caseId: z.string().min(1),
  label: z.string().min(1),
  purpose: z.string().min(1),
  expectedIssueCodes: z.array(z.string()).min(1),
  bundle: z.object({
    content: contentDocumentSchema,
    sources: z.array(sourceSnapshotSchema),
    datasets: z.array(structuredDatasetSchema),
    expected: fixtureExpectedSchema,
  }),
});

export type NegativeCase = z.infer<typeof negativeCaseSchema>;
