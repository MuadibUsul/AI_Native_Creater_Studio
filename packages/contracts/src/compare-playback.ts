import { z } from 'zod';
import { compareAlignmentSchema, compareChangeSchema, compareReportSchema, type CompareReport } from './proposal-compare.js';
import { compareMediaTime, mediaRangeSchema, type MediaRange } from './common/media-time.js';
import { objectLockDimensionSchema } from './object-locks.js';

/**
 * N06-08（收口）：把 A/B 对照报告编译成**播放器可直接消费的回放计划**。
 *
 * 纪律：
 * - 差异标记必须**落到时间轴上**：用前后各自的序列区间定位（删除项用**左侧**区间，新增用**右侧**，
 *   修改用两侧——播放器按当前在看哪一侧决定高亮）；
 * - 无法定位的差异（前后都没有区间）**仍要列出**（`range=null`），不静默丢弃；
 * - 标记按区间起点排序，保证渲染顺序确定、可重复；
 * - 局部循环区间由上层的时间选区给定；**空区间视为无循环**，不猜一个范围出来。
 */

export const compareMarkSideSchema = z.enum(['LEFT', 'RIGHT', 'BOTH']);
export type CompareMarkSide = z.infer<typeof compareMarkSideSchema>;

export const comparePlaybackMarkSchema = z.object({
  clipId: z.string().min(1),
  change: compareChangeSchema,
  axes: z.array(objectLockDimensionSchema),
  alignedBy: compareAlignmentSchema,
  /** 在时间轴上的定位区间（不可定位时为 null，但仍然列出） */
  range: mediaRangeSchema.nullable(),
  /** 该标记属于哪一侧（播放器据此决定高亮） */
  side: compareMarkSideSchema,
}).strict();
export type ComparePlaybackMark = z.infer<typeof comparePlaybackMarkSchema>;

export const comparePlaybackPlanSchema = z.object({
  leftLabel: z.string().max(200),
  rightLabel: z.string().max(200),
  alignment: compareAlignmentSchema,
  marks: z.array(comparePlaybackMarkSchema),
  /** 局部循环区间（来自时间选区；null = 不循环） */
  loopRange: mediaRangeSchema.nullable(),
  summary: z.object({
    changed: z.number().int().min(0),
    added: z.number().int().min(0),
    removed: z.number().int().min(0),
    unchanged: z.number().int().min(0),
    unplaced: z.number().int().min(0),
  }).strict(),
}).strict();
export type ComparePlaybackPlan = z.infer<typeof comparePlaybackPlanSchema>;

/** 对照报告 → 回放计划（纯函数）。 */
export function buildComparePlaybackPlan(input: {
  report: CompareReport;
  loopRange?: MediaRange | null;
}): ComparePlaybackPlan {
  const report = compareReportSchema.parse(input.report);
  const marks: ComparePlaybackMark[] = report.diffs.map((diff) => {
    const side: CompareMarkSide = diff.change === 'REMOVED' ? 'LEFT' : diff.change === 'ADDED' ? 'RIGHT' : 'BOTH';
    // 优先用"看得到的那一侧"的区间；删除项只有左侧、新增项只有右侧。
    const range = diff.change === 'REMOVED'
      ? diff.beforeSequenceRange
      : diff.afterSequenceRange ?? diff.beforeSequenceRange;
    return { clipId: diff.objectId, change: diff.change, axes: diff.axes, alignedBy: diff.alignedBy, range, side };
  });
  // 可定位的排在前面并按起点升序；不可定位的保留在尾部（不静默丢弃）。
  const placed = marks.filter((mark) => mark.range !== null)
    .sort((left, right) => compareMediaTime(left.range!.start, right.range!.start));
  const unplaced = marks.filter((mark) => mark.range === null);
  const loop = input.loopRange ?? null;
  const loopRange = loop !== null && compareMediaTime(loop.start, loop.end) < 0 ? loop : null;

  return comparePlaybackPlanSchema.parse({
    leftLabel: report.leftLabel,
    rightLabel: report.rightLabel,
    alignment: report.alignment,
    marks: [...placed, ...unplaced],
    loopRange,
    summary: {
      changed: report.changedCount,
      added: report.addedCount,
      removed: report.removedCount,
      unchanged: report.unchangedCount,
      unplaced: unplaced.length,
    },
  });
}
