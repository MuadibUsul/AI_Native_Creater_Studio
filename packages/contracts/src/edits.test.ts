import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EDIT_OPERATION_REGISTRY,
  EDIT_OPERATION_TYPES,
  EDIT_OPERATION_V2_INPUT_SCHEMAS,
  EDIT_OPERATION_V2_REGISTRY,
  SOURCE_EDIT_OPERATION_TYPES,
  editOperationDefinitionSchema,
  editOperationV2RegistrationSchema,
  editRequestSchema,
} from './index.js';

const samplePath = join(import.meta.dirname, '..', 'fixtures', 'edit-request.sample.json');
const raw: unknown = JSON.parse(readFileSync(samplePath, 'utf8'));

describe('编辑协议契约（计划 §4.6）', () => {
  it('操作类型覆盖 §4.6、对象锁与 N01-08 规范化对象编辑的全部 18 类', () => {
    expect(EDIT_OPERATION_TYPES).toHaveLength(18);
    expect(EDIT_OPERATION_TYPES).toContain('restore_project_version');
    expect(EDIT_OPERATION_TYPES).toContain('set_scene_lock');
    expect(EDIT_OPERATION_TYPES).toContain('set_object_lock');
    expect(EDIT_OPERATION_TYPES).toContain('update_clip');
    expect(EDIT_OPERATION_TYPES).toContain('update_animation');
    expect(EDIT_OPERATION_TYPES).toContain('update_audio_region');
  });

  it('N01-06 注册表对每种操作恰有一项完整定义', () => {
    expect(Object.keys(EDIT_OPERATION_REGISTRY).sort()).toEqual([...EDIT_OPERATION_TYPES].sort());
    for (const operation of EDIT_OPERATION_TYPES) {
      const definition = editOperationDefinitionSchema.parse(EDIT_OPERATION_REGISTRY[operation]);
      expect(definition.operation).toBe(operation);
      expect(definition.requiredPermission).toBe('project:write');
      expect(definition.readSet.length).toBeGreaterThan(0);
      expect(definition.writeSet.length).toBeGreaterThan(0);
      expect(definition.preconditions.length).toBeGreaterThan(0);
      expect(definition.postconditions.length).toBeGreaterThan(0);
      expect(definition.supportedBackends).toEqual(['LEGACY_SCENE']);
    }
  });

  it('样例往返无损（defaults 填充后为标准不动点）', () => {
    const once = editRequestSchema.parse(raw);
    const twice = editRequestSchema.parse(JSON.parse(JSON.stringify(once)) as unknown);
    expect(twice).toEqual(once);
  });

  it('非法值被拒：未知 op / 空 operations / 缺幂等键 / baseRevision 为 0 / insert 缺 sceneDraft', () => {
    const request = editRequestSchema.parse(raw);

    expect(
      editRequestSchema.safeParse({ ...request, operations: [{ op: 'set_theme', changes: {} }] }).success,
    ).toBe(false);
    expect(editRequestSchema.safeParse({ ...request, operations: [] }).success).toBe(false);

    const { idempotencyKey: _omitted, ...withoutKey } = request;
    expect(editRequestSchema.safeParse(withoutKey).success).toBe(false);

    expect(editRequestSchema.safeParse({ ...request, baseProjectRevision: 0 }).success).toBe(false);
    expect(
      editRequestSchema.safeParse({ ...request, operations: [{ op: 'insert_scene', afterSceneId: null }] }).success,
    ).toBe(false);
    expect(
      editRequestSchema.safeParse({ ...request, idempotencyKey: 'short' }).success,
    ).toBe(false);
  });

  it('expectedSceneRevisions 要求正整数 revision', () => {
    const request = editRequestSchema.parse(raw);
    expect(
      editRequestSchema.safeParse({ ...request, expectedSceneRevisions: { scn_002: 0 } }).success,
    ).toBe(false);
  });

  it('批内创建 ID 可被后续操作引用，且不能与补偿 ID 同时出现', () => {
    const request = editRequestSchema.parse(raw);
    const sceneDraft = {
      sceneType: 'HOST_FULL', semanticType: 'HOOK', narration: '', visualIntent: '', durationMs: 1_000,
      componentId: null, componentVersion: null, props: {}, providerRequirement: null,
      sourceBindings: [], dataBindings: [], assetBindings: [], narrationBlockIds: [], locked: false,
    };
    expect(editRequestSchema.safeParse({
      ...request,
      operations: [
        { op: 'insert_scene', afterSceneId: null, createdSceneId: 'scn_batch', sceneDraft },
        { op: 'update_scene', sceneId: 'scn_batch', changes: { narration: '批内引用' } },
      ],
    }).success).toBe(true);
    expect(editRequestSchema.safeParse({
      ...request,
      operations: [{ op: 'insert_scene', afterSceneId: null, createdSceneId: 'scn_a', restoreSceneId: 'scn_b', sceneDraft }],
    }).success).toBe(false);
  });

  it('对象锁要求明确目标和至少一个合法维度，支持显式解锁', () => {
    const request = editRequestSchema.parse(raw);
    expect(editRequestSchema.safeParse({
      ...request,
      operations: [{ op: 'set_object_lock', objectKind: 'SCENE', objectId: 'scn_1', dimensions: ['CONTENT'], locked: false }],
    }).success).toBe(true);
    expect(editRequestSchema.safeParse({
      ...request,
      operations: [{ op: 'set_object_lock', objectKind: 'SCENE', objectId: 'scn_1', dimensions: [], locked: true }],
    }).success).toBe(false);
    expect(editRequestSchema.safeParse({
      ...request,
      operations: [{ op: 'set_object_lock', objectKind: 'SCENE', objectId: 'scn_1', dimensions: ['UNKNOWN'], locked: true }],
    }).success).toBe(false);
  });

  it('N01-08 接受完整 Clip、关键帧和音频区域编辑，拒绝空变更与乱序关键帧', () => {
    const request = editRequestSchema.parse(raw);
    const mt = (ticks: string) => ({ ticks, timebase: { num: 1, den: 1_000 } });
    expect(editRequestSchema.safeParse({
      ...request,
      operations: [{ op: 'update_clip', clipId: 'clp_1', changes: {
        sourceRange: { start: mt('1000'), end: mt('4000') },
        sequenceRange: { start: mt('0'), end: mt('3000') },
        timeMapping: { kind: 'LINEAR', rate: { num: 1, den: 1 }, direction: 'FORWARD', preservePitch: true },
      } }],
    }).success).toBe(true);
    expect(editRequestSchema.safeParse({ ...request, operations: [{ op: 'update_clip', clipId: 'clp_1', changes: {} }] }).success).toBe(false);
    expect(editRequestSchema.safeParse({
      ...request,
      operations: [{ op: 'update_animation', animationId: 'ani_1', targetKind: 'VISUAL_OBJECT', targetId: 'obj_1', keyframes: [
        { id: 'key_1', time: mt('1000'), value: 1, interpolation: 'LINEAR' },
        { id: 'key_2', time: mt('500'), value: 2, interpolation: 'HOLD' },
      ] }],
    }).success).toBe(false);
    expect(editRequestSchema.safeParse({
      ...request,
      operations: [{ op: 'update_audio_region', audioRegionId: 'aud_1', changes: { gainDb: -6, pan: 0.25 } }],
    }).success).toBe(true);
  });

  it('N01-11 为 §13.5 的每个来源操作登记输入 schema 和原生／别名／待实现状态', () => {
    expect(SOURCE_EDIT_OPERATION_TYPES).toHaveLength(33);
    expect(Object.keys(EDIT_OPERATION_V2_REGISTRY).sort()).toEqual([...SOURCE_EDIT_OPERATION_TYPES].sort());
    expect(Object.keys(EDIT_OPERATION_V2_INPUT_SCHEMAS).sort()).toEqual([...SOURCE_EDIT_OPERATION_TYPES].sort());
    for (const operation of SOURCE_EDIT_OPERATION_TYPES) {
      const definition = editOperationV2RegistrationSchema.parse(EDIT_OPERATION_V2_REGISTRY[operation]);
      expect(definition.operation).toBe(operation);
      expect(EDIT_OPERATION_V2_INPUT_SCHEMAS[operation]).toBeDefined();
      expect(['NATIVE', 'COMPILED_ALIAS', 'PLANNED']).toContain(definition.resolution);
      if (definition.resolution === 'PLANNED') expect(definition.plannedTask).not.toBeNull();
      else expect(definition.canonicalOperation).not.toBeNull();
    }
    expect(EDIT_OPERATION_V2_REGISTRY.move_clip).toMatchObject({ resolution: 'COMPILED_ALIAS', canonicalOperation: 'update_clip' });
    expect(EDIT_OPERATION_V2_REGISTRY.set_audio_gain).toMatchObject({ resolution: 'COMPILED_ALIAS', canonicalOperation: 'update_audio_region' });
    expect(EDIT_OPERATION_V2_REGISTRY.regenerate_region).toMatchObject({ resolution: 'PLANNED', category: 'ASYNC_COMMAND', costCategory: 'PROVIDER_ESTIMATE_REQUIRED' });
    for (const operation of ['create_preview_branch', 'commit_preview_branch', 'discard_preview_branch'] as const) {
      expect(EDIT_OPERATION_V2_REGISTRY[operation]).toMatchObject({ resolution: 'PLANNED', category: 'PREVIEW_COMMAND', supportedBackends: ['PROPOSAL_SERVICE'] });
    }
  });
});
