import { describe, expect, it } from 'vitest';
import type { EditOperation, Scene } from '@ancs/contracts';
import { assertSceneReferences, buildEditPlanPrompts, computeImpact, filterLockedOperations, scenesDigestOf, summarizeOperation } from './ai-edit.js';
import { ApiFailure } from '@ancs/contracts';

/**
 * P05-06 单元验收（AI Edit 的确定性部分）：
 * - 场景清单摘要与提示词契约（锁定规则写入提示词）；
 * - 场景引用校验（不得虚构）；
 * - 锁定场景操作剔除 + 告警（绝不自动解锁）；
 * - 影响估算只做结构推导（不伪造精确值）。
 */

const scene = (id: string, overrides: Partial<Scene> = {}): Scene =>
  ({
    id,
    revision: 1,
    position: 0,
    startMs: 0,
    durationMs: 4000,
    semanticType: 'HOST_STATEMENT',
    sceneType: 'HOST_FULL',
    narrationBlockIds: [],
    narration: '旁白文本',
    visualIntent: '',
    componentId: null,
    componentVersion: null,
    props: {},
    providerRequirement: null,
    sourceBindings: [],
    dataBindings: [],
    assetBindings: [],
    transition: { in: null, out: null },
    locked: false,
    approved: false,
    needsReview: false,
    status: 'DRAFT',
    ...overrides,
  }) as Scene;

describe('AI Edit 提示词与摘要', () => {
  it('提示词包含锁定约束与「不得虚构 ID」要求（可审计）', () => {
    const { systemPrompt, userPrompt } = buildEditPlanPrompts({ prompt: '缩短所有场景', scenesDigest: 'digest' });
    expect(systemPrompt).toContain('不得修改已锁定场景');
    expect(systemPrompt).toContain('严禁虚构 ID');
    expect(systemPrompt).toContain('promptVersion: ai-edit-v1');
    expect(systemPrompt).toContain('不产生任何 Provider 调用');
    expect(userPrompt).toContain('缩短所有场景');
  });

  it('清单摘要含 id/类型/时长/锁定，且按 position 排序', () => {
    const digest = scenesDigestOf([scene('scn_b', { position: 1, locked: true }), scene('scn_a', { position: 0 })]);
    const lines = digest.split('\n');
    expect(lines[0]).toContain('id=scn_a');
    expect(lines[1]).toContain('locked=true');
  });
});

describe('引用校验与锁定剔除（§4.7 / §52）', () => {
  const scenes = [scene('scn_1'), scene('scn_locked', { locked: true })];

  it('引用不存在的场景 → 422 UNKNOWN_SCENE_REFERENCE（含 reorder 列表校验）', () => {
    const bad: EditOperation[] = [{ op: 'delete_scene', sceneId: 'scn_missing' }];
    expect(() => assertSceneReferences(scenes, bad)).toThrowError(/不存在的场景/);
    try {
      assertSceneReferences(scenes, bad);
    } catch (error) {
      expect(error).toBeInstanceOf(ApiFailure);
      expect((error as ApiFailure).httpStatus).toBe(422);
      expect((error as ApiFailure).details['reason']).toBe('UNKNOWN_SCENE_REFERENCE');
    }
    expect(() => assertSceneReferences(scenes, [{ op: 'reorder_scenes', orderedSceneIds: ['scn_1', 'scn_missing'] }])).toThrow();
    expect(() => assertSceneReferences(scenes, [{ op: 'duplicate_scene', sceneId: 'scn_1', afterSceneId: 'scn_missing' }])).toThrow();
  });

  it('锁定场景的操作被剔除并给出告警（不自动解锁）', () => {
    const operations: EditOperation[] = [
      { op: 'update_scene', sceneId: 'scn_locked', changes: { durationMs: 9999 } },
      { op: 'update_scene', sceneId: 'scn_1', changes: { durationMs: 5000 } },
    ];
    const { kept, warnings } = filterLockedOperations(scenes, operations);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ sceneId: 'scn_1' });
    expect(warnings[0]).toContain('已跳过对锁定场景');
    expect(warnings[0]).toContain('请先显式解锁');
  });
});

describe('影响估算（结构推导，不伪造）', () => {
  it('时长增量按现状精确计算；新增/删除/修改计数正确；成本恒为 NONE', () => {
    const scenes = [scene('scn_1', { durationMs: 4000 }), scene('scn_2', { durationMs: 2000, position: 1 })];
    const impact = computeImpact(scenes, [
      { op: 'update_scene', sceneId: 'scn_1', changes: { durationMs: 4500 } },
      { op: 'duplicate_scene', sceneId: 'scn_2', afterSceneId: null },
      { op: 'split_scene', sceneId: 'scn_1', atMs: 1000 },
      { op: 'delete_scene', sceneId: 'scn_1' },
    ]);
    expect(impact).toMatchObject({ scenesAdded: 2, scenesRemoved: 1, durationDeltaMs: 4500 - 4000 + 2000 - 4000, costImpact: 'NONE' });
    expect(impact.notes.join(' ')).toContain('不产生任何 Provider 调用');
    expect(impact.notes.join(' ')).toContain('startMs');
  });

  it('操作摘要：before 来自现状；不确定值明确标注（不假装精确）', () => {
    const target = scene('scn_1', { durationMs: 4000 });
    const update = summarizeOperation(target, { op: 'update_scene', sceneId: 'scn_1', changes: { durationMs: 4500, props: { scale: 2 } } });
    expect(update.summary).toContain('修改场景');
    expect(update.before['durationMs']).toBe(4000);
    expect(update.before['props']).toBe('(apply 时由服务端计算)');
    expect(update.after['durationMs']).toBe(4500);
    const locked = summarizeOperation(target, { op: 'set_scene_lock', sceneId: 'scn_1', locked: true });
    expect(locked.summary).toContain('锁定场景');
  });
});
