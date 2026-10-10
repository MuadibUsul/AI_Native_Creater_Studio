import { describe, expect, it } from 'vitest';
import { computeOperationTargetRefs, targetRefsIntersect } from './edit-impact.js';

/**
 * N06-03：操作 → 写目标（对象 + 维度）的纯函数映射。
 * 这里是"影响集"的权威来源：既要精确（同对象同维度才算竞争），又要保守（读不出形状时取全维度）。
 */
describe('N06-03 computeOperationTargetRefs 影响集目标解析', () => {
  const CLIP = 'clip_A';

  it('裁剪片段：内容／位置／时长三个维度', () => {
    const refs = computeOperationTargetRefs({ op: 'trim_clip', clipId: CLIP });
    expect(refs).toEqual([{ objectKind: 'CLIP', objectId: CLIP, dimensions: ['CONTENT', 'POSITION', 'DURATION'] }]);
  });

  it('移动片段到指定轨：同时影响片段与目标轨（含轨道时序）', () => {
    const refs = computeOperationTargetRefs({ op: 'move_clip', clipId: CLIP, trackId: 'track_B' });
    expect(refs).toEqual([
      { objectKind: 'CLIP', objectId: CLIP, dimensions: ['POSITION', 'TRACK'] },
      { objectKind: 'TRACK', objectId: 'track_B', dimensions: ['POSITION', 'DURATION'] },
    ]);
  });

  it('不透明度只动 STYLE（与位置编辑可共存，不构成竞争）', () => {
    expect(computeOperationTargetRefs({ op: 'set_clip_opacity', clipId: CLIP, opacity: 0.5 }))
      .toEqual([{ objectKind: 'CLIP', objectId: CLIP, dimensions: ['STYLE'] }]);
  });

  it('update_clip：按 changes 实际字段推导维度（sequenceRange → POSITION+DURATION）', () => {
    expect(computeOperationTargetRefs({ op: 'update_clip', clipId: CLIP, changes: { sequenceRange: {} } }))
      .toEqual([{ objectKind: 'CLIP', objectId: CLIP, dimensions: ['POSITION', 'DURATION'] }]);
    expect(computeOperationTargetRefs({ op: 'update_clip', clipId: CLIP, changes: { sourceRange: {} } }))
      .toEqual([{ objectKind: 'CLIP', objectId: CLIP, dimensions: ['CONTENT', 'DURATION'] }]);
    // 无 changes（涟漪邻居事件常如此）→ 读不出形状 → 空（调用方按保守全维度处理）
    expect(computeOperationTargetRefs({ op: 'update_clip', clipId: CLIP })).toEqual([]);
  });

  it('重排场景：展开为每个 Scene × POSITION（间接影响必须可检测）', () => {
    const refs = computeOperationTargetRefs({ op: 'reorder_scenes', orderedSceneIds: ['s1', 's2', 's3'] });
    expect(refs).toEqual([
      { objectKind: 'SCENE', objectId: 's1', dimensions: ['POSITION'] },
      { objectKind: 'SCENE', objectId: 's2', dimensions: ['POSITION'] },
      { objectKind: 'SCENE', objectId: 's3', dimensions: ['POSITION'] },
    ]);
  });

  it('对象锁：锁定的对象与维度即为影响面（锁间接影响可检测）', () => {
    expect(computeOperationTargetRefs({ op: 'set_object_lock', objectKind: 'CLIP', objectId: CLIP, dimensions: ['STYLE'], locked: true }))
      .toEqual([{ objectKind: 'CLIP', objectId: CLIP, dimensions: ['STYLE'] }]);
  });

  it('拆分/复制/替换源把新建片段引用一并计入', () => {
    expect(computeOperationTargetRefs({ op: 'split_clip', clipId: CLIP, createdClipId: 'clip_new' })).toEqual([
      { objectKind: 'CLIP', objectId: CLIP, dimensions: ['CONTENT', 'POSITION', 'DURATION'] },
      { objectKind: 'CLIP', objectId: 'clip_new', dimensions: ['CONTENT', 'POSITION'] },
    ]);
    expect(computeOperationTargetRefs({ op: 'replace_clip_source', clipId: CLIP }))
      .toEqual([{ objectKind: 'CLIP', objectId: CLIP, dimensions: ['CONTENT', 'DURATION'] }]);
  });

  it('缺失必需字段或未知操作：返回空而不是抛异常（调用方降级处理）', () => {
    expect(computeOperationTargetRefs({ op: 'trim_clip' })).toEqual([]);
    expect(computeOperationTargetRefs({ op: 'not_a_real_op', clipId: CLIP })).toEqual([]);
    expect(computeOperationTargetRefs({})).toEqual([]);
    expect(computeOperationTargetRefs({ op: 'set_object_lock', objectKind: 'OBJECT_LOCK', objectId: CLIP, dimensions: ['STYLE'] })).toEqual([]);
  });

  it('维度相交判定：同对象同维度才算竞争；同对象不同维度可共存', () => {
    const opacity = { objectKind: 'CLIP' as const, objectId: CLIP, dimensions: ['STYLE' as const] };
    const trim = { objectKind: 'CLIP' as const, objectId: CLIP, dimensions: ['CONTENT' as const, 'DURATION' as const] };
    const trim2 = { objectKind: 'CLIP' as const, objectId: CLIP, dimensions: ['POSITION' as const, 'DURATION' as const] };
    const otherClip = { objectKind: 'CLIP' as const, objectId: 'clip_Z', dimensions: ['STYLE' as const] };
    expect(targetRefsIntersect(opacity, trim)).toEqual([]);
    expect(targetRefsIntersect(trim, trim2)).toEqual(['DURATION']);
    expect(targetRefsIntersect(opacity, otherClip)).toEqual([]);
    expect(targetRefsIntersect(opacity, opacity)).toEqual(['STYLE']);
  });
});
