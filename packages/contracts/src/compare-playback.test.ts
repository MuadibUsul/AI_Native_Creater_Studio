import { describe, expect, it } from 'vitest';
import { buildComparePlaybackPlan } from './compare-playback.js';
import type { CompareReport } from './proposal-compare.js';
import { legacyMillisecondsToMediaTime } from './common/media-time.js';

/**
 * N06-08（收口）：把对照报告编译成播放器可消费的回放计划。
 * 关键：标记必须落到时间轴；删除用左侧区间、新增用右侧；不可定位的仍列出；空循环不算循环。
 */
const mt = (ms: number) => legacyMillisecondsToMediaTime(ms);
const range = (startMs: number, endMs: number) => ({ start: mt(startMs), end: mt(endMs) });

const report: CompareReport = {
  proposalId: 'prop_1',
  workspaceId: 'ws_1',
  projectId: 'p_1',
  comparedAgainst: { kind: 'CURRENT', ref: null },
  leftLabel: '确认版 r3',
  rightLabel: '候选 prop_1（代际 2）',
  alignment: 'CLIP_ID',
  diffs: [
    { objectKind: 'CLIP', objectId: 'clip_changed', label: null, change: 'CHANGED', axes: ['CONTENT'], beforeAssetVersionId: 'av_1', afterAssetVersionId: 'av_1', beforeTrackId: 't1', afterTrackId: 't1', beforeSequenceRange: range(4_000, 7_000), afterSequenceRange: range(4_000, 6_000), alignedBy: 'CLIP_ID' },
    { objectKind: 'CLIP', objectId: 'clip_removed', label: null, change: 'REMOVED', axes: ['CONTENT', 'POSITION', 'ASSET'], beforeAssetVersionId: 'av_1', afterAssetVersionId: null, beforeTrackId: 't1', afterTrackId: null, beforeSequenceRange: range(0, 3_000), afterSequenceRange: null, alignedBy: 'CLIP_ID' },
    { objectKind: 'CLIP', objectId: 'clip_added', label: null, change: 'ADDED', axes: ['CONTENT', 'POSITION', 'ASSET'], beforeAssetVersionId: null, afterAssetVersionId: 'av_2', beforeTrackId: null, afterTrackId: 't1', beforeSequenceRange: null, afterSequenceRange: range(8_000, 9_000), alignedBy: 'CLIP_ID' },
    { objectKind: 'CLIP', objectId: 'clip_nowhere', label: null, change: 'CHANGED', axes: ['STYLE'], beforeAssetVersionId: null, afterAssetVersionId: null, beforeTrackId: null, afterTrackId: null, beforeSequenceRange: null, afterSequenceRange: null, alignedBy: 'CLIP_ID' },
  ],
  unchangedCount: 5,
  addedCount: 1,
  removedCount: 1,
  changedCount: 2,
  anchorMatchedCount: 0,
  unmatchedAnchors: [],
  assetVersionIds: ['av_1', 'av_2'],
};

describe('N06-08 buildComparePlaybackPlan', () => {
  it('标记落到时间轴并按起点排序；删除用左侧区间、新增用右侧、修改用两侧', () => {
    const plan = buildComparePlaybackPlan({ report });
    expect(plan.marks.map((mark) => mark.clipId)).toEqual(['clip_removed', 'clip_changed', 'clip_added', 'clip_nowhere']);
    const removed = plan.marks.find((mark) => mark.clipId === 'clip_removed')!;
    expect(removed.side).toBe('LEFT');
    expect(removed.range).toEqual(range(0, 3_000));
    const added = plan.marks.find((mark) => mark.clipId === 'clip_added')!;
    expect(added.side).toBe('RIGHT');
    expect(added.range).toEqual(range(8_000, 9_000));
    const changed = plan.marks.find((mark) => mark.clipId === 'clip_changed')!;
    expect(changed.side).toBe('BOTH');
    expect(changed.range).toEqual(range(4_000, 6_000)); // 用**试改后**的区间
  });

  it('不可定位的差异仍然列出（range=null）并计入 unplaced，不静默丢弃', () => {
    const plan = buildComparePlaybackPlan({ report });
    const nowhere = plan.marks.find((mark) => mark.clipId === 'clip_nowhere')!;
    expect(nowhere.range).toBeNull();
    expect(plan.summary.unplaced).toBe(1);
    // 未变数量与各类计数如实透传
    expect(plan.summary).toMatchObject({ changed: 2, added: 1, removed: 1, unchanged: 5 });
  });

  it('局部循环：给定有效区间即生效；空区间视为无循环（不猜一个范围）', () => {
    expect(buildComparePlaybackPlan({ report, loopRange: range(1_000, 3_000) }).loopRange).toEqual(range(1_000, 3_000));
    expect(buildComparePlaybackPlan({ report, loopRange: range(2_000, 2_000) }).loopRange).toBeNull();
    expect(buildComparePlaybackPlan({ report }).loopRange).toBeNull();
  });

  it('两侧标签与对齐方式透传（播放器据此显示"你在看哪一侧"）', () => {
    const plan = buildComparePlaybackPlan({ report });
    expect(plan.leftLabel).toBe('确认版 r3');
    expect(plan.rightLabel).toBe('候选 prop_1（代际 2）');
    expect(plan.alignment).toBe('CLIP_ID');
  });
});
