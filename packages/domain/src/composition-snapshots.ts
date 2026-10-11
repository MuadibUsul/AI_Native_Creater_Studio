import { audioRegionSchema, captionSpanSchema, clipSchema, trackSchema, visualParametersSchema } from '@ancs/contracts';
import type { compositionAudioRegions, compositionCaptionSpans, sequenceClips, sequenceTracks } from '@ancs/db';

/**
 * 时间线对象的事件快照格式（edit_events.patch.before/after；undo/redo 依赖此格式）。
 * 编辑事务（edits.ts）与内核适配器（kernel-timeline.ts）共用，保证事件形状唯一。
 */

/** 片段行（或由行派生的候选对象）：parameters 可缺省，快照时按缺省语义补全。 */
export type ClipRowLike = Omit<typeof sequenceClips.$inferSelect, 'parameters'> & { parameters?: unknown };

export const clipSnapshot = (row: ClipRowLike) => clipSchema.parse({
  ...row,
  parameters: row.parameters === null || row.parameters === undefined ? undefined : visualParametersSchema.parse(row.parameters),
  createdAt: row.createdAt.toISOString(),
});

export const audioRegionSnapshot = (row: typeof compositionAudioRegions.$inferSelect) => audioRegionSchema.parse({
  ...row,
  gainDb: Number(row.gainDb),
  pan: Number(row.pan),
  createdAt: row.createdAt.toISOString(),
});

export const trackSnapshot = (row: typeof sequenceTracks.$inferSelect) => trackSchema.parse({
  ...row,
  createdAt: row.createdAt.toISOString(),
});

export type CaptionRowLike = typeof compositionCaptionSpans.$inferSelect;
export const captionSnapshot = (row: CaptionRowLike) => captionSpanSchema.parse({
  ...row,
  createdAt: row.createdAt.toISOString(),
});
