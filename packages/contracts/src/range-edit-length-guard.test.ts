import { describe, expect, it } from 'vitest';
import { estimateRangeEditDurationDeltaMs } from './range-edit.js';
import type { EditOperation } from './edits.js';

/**
 * N06-07：范围编辑计划的总时长**确定性估算**（由操作负载推导）。
 * 关键取舍：估算不出时必须 `exact=false`（调用方按"需解释"处理），绝不能假装等长放行。
 */
const mt = (ms: number) => ({ ticks: String(ms), timebase: { num: 1, den: 1000 } });
const rangeMs = (start: number, end: number) => ({ start: mt(start), end: mt(end) });

describe('N06-07 estimateRangeEditDurationDeltaMs', () => {
  it('插入（INSERT/APPEND）变长，量为源区间时长', () => {
    const insert = { op: 'insert_clip', sourceRange: rangeMs(0, 2_000), mode: 'INSERT' } as unknown as EditOperation;
    expect(estimateRangeEditDurationDeltaMs([insert])).toEqual({ deltaMs: 2_000, exact: true });
  });

  it('覆盖（OVERWRITE）不改变总时长', () => {
    const overwrite = { op: 'insert_clip', sourceRange: rangeMs(0, 2_500), mode: 'OVERWRITE' } as unknown as EditOperation;
    expect(estimateRangeEditDurationDeltaMs([overwrite])).toEqual({ deltaMs: 0, exact: true });
  });

  it('涟漪去尾/掐头按收缝量变短（显式 amount）', () => {
    const trimTail = { op: 'ripple_clip', clipId: 'c1', action: 'TRIM_TAIL', amount: mt(1_000), closeAcrossTracks: false } as unknown as EditOperation;
    expect(estimateRangeEditDurationDeltaMs([trimTail])).toEqual({ deltaMs: -1_000, exact: true });
  });

  it('涟漪 DELETE 与普通删除：无法由负载确定 → exact=false（不得当作等长）', () => {
    const rippleDelete = { op: 'ripple_clip', clipId: 'c1', action: 'DELETE', amount: null, closeAcrossTracks: true } as unknown as EditOperation;
    const deleteClip = { op: 'delete_clip', clipId: 'c1' } as unknown as EditOperation;
    expect(estimateRangeEditDurationDeltaMs([rippleDelete]).exact).toBe(false);
    expect(estimateRangeEditDurationDeltaMs([deleteClip]).exact).toBe(false);
  });

  it('裁剪/移动/不透明度等不改总时长 → 0 且 exact', () => {
    const trim = { op: 'trim_clip', clipId: 'c1', sourceRange: rangeMs(1_000, 3_000), sequenceRange: rangeMs(0, 2_000) } as unknown as EditOperation;
    const opacity = { op: 'set_clip_opacity', clipId: 'c1', opacity: 0.5 } as unknown as EditOperation;
    expect(estimateRangeEditDurationDeltaMs([trim, opacity])).toEqual({ deltaMs: 0, exact: true });
  });
});
