import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';

/**
 * StructuredDataset 契约（计划 §4.2 / 规范 §10.3、§7）。
 * 事实图表只能绑定结构化数据或可追踪 Source；synthetic=true 的数据集禁止被事实图表引用。
 */

export const DATASET_POINT_ACCURACIES = ['anchor', 'reconstructed'] as const;

export const datasetPointSchema = z.object({
  /** 数据点标签：ISO 日期、季度或年度（"2024-06-14" / "2023Q1" / "2023"） */
  t: z.string().min(1),
  v: z.number(),
  /** anchor=公开报道/统计的锚点；reconstructed=为保持序列连续的重构 */
  accuracy: z.enum(DATASET_POINT_ACCURACIES).default('reconstructed'),
});

export const datasetSeriesSchema = z.object({
  id: opaqueIdSchema,
  name: z.string().min(1),
  points: z.array(datasetPointSchema).min(1),
});

export const structuredDatasetSchema = z.object({
  id: opaqueIdSchema,
  title: z.string().min(1),
  unit: z.string().min(1),
  sourceIds: z.array(opaqueIdSchema).min(1),
  synthetic: z.boolean().default(false),
  note: z.string().optional(),
  series: z.array(datasetSeriesSchema).min(1),
});

export type StructuredDataset = z.infer<typeof structuredDatasetSchema>;
export type DatasetSeries = z.infer<typeof datasetSeriesSchema>;
