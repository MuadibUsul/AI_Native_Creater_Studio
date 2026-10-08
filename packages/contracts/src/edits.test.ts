import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EDIT_OPERATION_REGISTRY, EDIT_OPERATION_TYPES, editOperationDefinitionSchema, editRequestSchema } from './index.js';

const samplePath = join(import.meta.dirname, '..', 'fixtures', 'edit-request.sample.json');
const raw: unknown = JSON.parse(readFileSync(samplePath, 'utf8'));

describe('编辑协议契约（计划 §4.6）', () => {
  it('操作类型覆盖 §4.6 列出的全部 14 类', () => {
    expect(EDIT_OPERATION_TYPES).toHaveLength(14);
    expect(EDIT_OPERATION_TYPES).toContain('restore_project_version');
    expect(EDIT_OPERATION_TYPES).toContain('set_scene_lock');
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
});
