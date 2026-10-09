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
  it('操作类型覆盖 §4.6、对象锁与 N01-08 规范化对象编辑的全部 25 类（N03-01 增补 insert_clip／delete_clip，N03-02 增补 split／trim／move／duplicate／replace_clip_source，N03-03 增补 slip／slide／roll／ripple／split_av_cut）', () => {
    expect(EDIT_OPERATION_TYPES).toHaveLength(30);
    expect(EDIT_OPERATION_TYPES).toContain('restore_project_version');
    expect(EDIT_OPERATION_TYPES).toContain('set_scene_lock');
    expect(EDIT_OPERATION_TYPES).toContain('set_object_lock');
    expect(EDIT_OPERATION_TYPES).toContain('update_clip');
    expect(EDIT_OPERATION_TYPES).toContain('insert_clip');
    expect(EDIT_OPERATION_TYPES).toContain('delete_clip');
    expect(EDIT_OPERATION_TYPES).toContain('split_clip');
    expect(EDIT_OPERATION_TYPES).toContain('trim_clip');
    expect(EDIT_OPERATION_TYPES).toContain('move_clip');
    expect(EDIT_OPERATION_TYPES).toContain('duplicate_clip');
    expect(EDIT_OPERATION_TYPES).toContain('replace_clip_source');
    expect(EDIT_OPERATION_TYPES).toContain('slip_clip');
    expect(EDIT_OPERATION_TYPES).toContain('slide_clip');
    expect(EDIT_OPERATION_TYPES).toContain('roll_clip');
    expect(EDIT_OPERATION_TYPES).toContain('ripple_clip');
    expect(EDIT_OPERATION_TYPES).toContain('split_av_cut');
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

  it('N03-01 insert_clip／delete_clip 契约：源互斥、APPEND 无起点、精确复原与 AV 关联约束', () => {
    const mt = (ticks: string) => ({ ticks, timebase: { num: 1, den: 1_000 } });
    const request = {
      schemaVersion: '1.0' as const,
      baseProjectRevision: 1,
      expectedSceneRevisions: {},
      idempotencyKey: 'idem_insert_clip_contract',
    };
    const base = {
      op: 'insert_clip' as const,
      sequenceId: 'seq_1',
      trackId: 'trk_1',
      assetVersionId: 'av_1',
      sourceRange: { start: mt('0'), end: mt('1000') },
    };
    const accepts = (operation: unknown) => editRequestSchema.safeParse({ ...request, operations: [operation] }).success;
    expect(accepts({ ...base, mode: 'INSERT', sequenceStart: mt('0') })).toBe(true);
    expect(accepts({ ...base, mode: 'OVERWRITE', sequenceStart: mt('0') })).toBe(true);
    // APPEND 落在目标轨末端：不得给定序列起点，INSERT/OVERWRITE 则必须给定
    expect(accepts({ ...base, mode: 'APPEND' })).toBe(true);
    expect(accepts({ ...base, mode: 'APPEND', sequenceStart: mt('0') })).toBe(false);
    expect(accepts({ ...base, mode: 'OVERWRITE' })).toBe(false);
    // 源互斥：assetVersionId 与 nestedSequenceId 恰有一个
    expect(accepts({ ...base, nestedSequenceId: 'seq_nested', mode: 'APPEND' })).toBe(false);
    expect(accepts({ ...base, assetVersionId: null, nestedSequenceId: 'seq_nested', mode: 'APPEND' })).toBe(true);
    // 精确复原（undo/redo 重建单条片段）不得同时建立 AV 关联
    expect(accepts({ ...base, mode: 'APPEND', restoreClipId: 'clp_1' })).toBe(false);
    expect(accepts({ ...base, mode: 'APPEND', restoreClipId: 'clp_1', linkAudio: false })).toBe(true);
    // 关联音轨只在 linkAudio 成立时有意义
    expect(accepts({ ...base, mode: 'APPEND', linkAudio: false, audioTrackId: 'trk_a' })).toBe(false);
    // 删除原语只接受片段 id，不接受其它字段
    expect(accepts({ op: 'delete_clip', clipId: 'clp_1' })).toBe(true);
    expect(accepts({ op: 'delete_clip', clipId: 'clp_1', mode: 'INSERT' })).toBe(false);
  });

  it('N03-02 split／trim／move／duplicate／replace_clip_source 契约：必填项、源互斥与"至少一项变更"', () => {
    const mt = (ticks: string) => ({ ticks, timebase: { num: 1, den: 1_000 } });
    const range = (start: string, end: string) => ({ start: mt(start), end: mt(end) });
    const request = {
      schemaVersion: '1.0' as const,
      baseProjectRevision: 1,
      expectedSceneRevisions: {},
      idempotencyKey: 'idem_n03_02_contract',
    };
    const accepts = (operation: unknown) => editRequestSchema.safeParse({ ...request, operations: [operation] }).success;

    expect(accepts({ op: 'split_clip', clipId: 'clp_1', at: mt('2000') })).toBe(true);
    expect(accepts({ op: 'split_clip', clipId: 'clp_1' })).toBe(false);

    expect(accepts({ op: 'trim_clip', clipId: 'clp_1', sourceRange: range('1000', '4000'), sequenceRange: range('0', '3000') })).toBe(true);
    expect(accepts({ op: 'trim_clip', clipId: 'clp_1', sourceRange: range('4000', '1000'), sequenceRange: range('0', '3000') })).toBe(false); // 空/反向区间

    expect(accepts({ op: 'move_clip', clipId: 'clp_1', sequenceRange: range('0', '1000') })).toBe(true);
    expect(accepts({ op: 'move_clip', clipId: 'clp_1', trackId: 'trk_2' })).toBe(true);
    expect(accepts({ op: 'move_clip', clipId: 'clp_1' })).toBe(false); // 至少要给目标轨或目标区间

    expect(accepts({ op: 'duplicate_clip', clipId: 'clp_1' })).toBe(true);
    expect(accepts({ op: 'duplicate_clip', clipId: 'clp_1', afterClipId: null })).toBe(true);

    expect(accepts({ op: 'replace_clip_source', clipId: 'clp_1', assetVersionId: 'av_2', sourceRange: range('0', '4000') })).toBe(true);
    expect(accepts({ op: 'replace_clip_source', clipId: 'clp_1', nestedSequenceId: 'seq_2', sourceRange: range('0', '4000') })).toBe(true);
    // 源互斥：恰好一个 assetVersionId／nestedSequenceId
    expect(accepts({ op: 'replace_clip_source', clipId: 'clp_1', assetVersionId: 'av_2', nestedSequenceId: 'seq_2', sourceRange: range('0', '4000') })).toBe(false);
    expect(accepts({ op: 'replace_clip_source', clipId: 'clp_1', sourceRange: range('0', '4000') })).toBe(false);
  });

  it('N03-03 精剪契约：显式涟漪、滑动/卷动必填项、J/L cut 方向与正偏移', () => {
    const mt = (ticks: string) => ({ ticks, timebase: { num: 1, den: 1_000 } });
    const range = (start: string, end: string) => ({ start: mt(start), end: mt(end) });
    const request = {
      schemaVersion: '1.0' as const,
      baseProjectRevision: 1,
      expectedSceneRevisions: {},
      idempotencyKey: 'idem_n03_03_contract',
    };
    const accepts = (operation: unknown) => editRequestSchema.safeParse({ ...request, operations: [operation] }).success;

    expect(accepts({ op: 'slip_clip', clipId: 'clp_1', sourceRange: range('1000', '4000') })).toBe(true);
    expect(accepts({ op: 'slide_clip', clipId: 'clp_1', offset: mt('500') })).toBe(true);
    expect(accepts({ op: 'slide_clip', clipId: 'clp_1', offset: mt('0') })).toBe(false); // 位移不得为 0
    expect(accepts({ op: 'roll_clip', leftClipId: 'clp_1', rightClipId: 'clp_2', at: mt('2000') })).toBe(true);
    expect(accepts({ op: 'roll_clip', leftClipId: 'clp_1', rightClipId: 'clp_1', at: mt('2000') })).toBe(false); // 必须两段不同片段

    // 涟漪：只有显式操作会收缝；金额与动作严格配对
    expect(accepts({ op: 'ripple_clip', clipId: 'clp_1', action: 'DELETE', amount: null })).toBe(true);
    expect(accepts({ op: 'ripple_clip', clipId: 'clp_1', action: 'TRIM_HEAD', amount: mt('500') })).toBe(true);
    expect(accepts({ op: 'ripple_clip', clipId: 'clp_1', action: 'TRIM_TAIL', amount: mt('500') })).toBe(true);
    expect(accepts({ op: 'ripple_clip', clipId: 'clp_1', action: 'DELETE', amount: mt('500') })).toBe(false);
    expect(accepts({ op: 'ripple_clip', clipId: 'clp_1', action: 'TRIM_HEAD', amount: null })).toBe(false);

    // J/L cut：方向枚举 + 正偏移
    expect(accepts({ op: 'split_av_cut', videoClipId: 'clp_v', audioClipId: 'clp_a', at: mt('4000'), offset: mt('500'), kind: 'J' })).toBe(true);
    expect(accepts({ op: 'split_av_cut', videoClipId: 'clp_v', audioClipId: 'clp_a', at: mt('4000'), offset: mt('500'), kind: 'L' })).toBe(true);
    expect(accepts({ op: 'split_av_cut', videoClipId: 'clp_v', audioClipId: 'clp_a', at: mt('4000'), offset: mt('500'), kind: 'X' })).toBe(false);
    expect(accepts({ op: 'split_av_cut', videoClipId: 'clp_v', audioClipId: 'clp_a', at: mt('4000'), offset: mt('0'), kind: 'J' })).toBe(false);
  });

  it('N01-11 为 §13.5 的每个来源操作登记输入 schema 和原生／别名／待实现状态', () => {
    expect(SOURCE_EDIT_OPERATION_TYPES).toHaveLength(38);
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
    // N03-02 起时间线原语是规范操作本身（不再是 update_clip 的别名）。
    expect(EDIT_OPERATION_V2_REGISTRY.move_clip).toMatchObject({ resolution: 'NATIVE', canonicalOperation: 'move_clip' });
    expect(EDIT_OPERATION_V2_REGISTRY.trim_clip).toMatchObject({ resolution: 'NATIVE', canonicalOperation: 'trim_clip' });
    expect(EDIT_OPERATION_V2_REGISTRY.split_clip).toMatchObject({ resolution: 'NATIVE', canonicalOperation: 'split_clip' });
    expect(EDIT_OPERATION_V2_REGISTRY.duplicate_clip).toMatchObject({ resolution: 'NATIVE', canonicalOperation: 'duplicate_clip' });
    expect(EDIT_OPERATION_V2_REGISTRY.replace_clip_source).toMatchObject({ resolution: 'NATIVE', canonicalOperation: 'replace_clip_source' });
    expect(EDIT_OPERATION_V2_REGISTRY.delete_clip).toMatchObject({ resolution: 'NATIVE', canonicalOperation: 'delete_clip' });
    // N03-03 起 slip/slide/roll/ripple/split_av_cut 同样是规范操作本身。
    expect(EDIT_OPERATION_V2_REGISTRY.slip_clip).toMatchObject({ resolution: 'NATIVE', canonicalOperation: 'slip_clip' });
    expect(EDIT_OPERATION_V2_REGISTRY.slide_clip).toMatchObject({ resolution: 'NATIVE', canonicalOperation: 'slide_clip' });
    expect(EDIT_OPERATION_V2_REGISTRY.roll_clip).toMatchObject({ resolution: 'NATIVE', canonicalOperation: 'roll_clip' });
    expect(EDIT_OPERATION_V2_REGISTRY.ripple_clip).toMatchObject({ resolution: 'NATIVE', canonicalOperation: 'ripple_clip' });
    expect(EDIT_OPERATION_V2_REGISTRY.split_av_cut).toMatchObject({ resolution: 'NATIVE', canonicalOperation: 'split_av_cut' });
    expect(EDIT_OPERATION_V2_REGISTRY.set_audio_gain).toMatchObject({ resolution: 'COMPILED_ALIAS', canonicalOperation: 'update_audio_region' });
    expect(EDIT_OPERATION_V2_REGISTRY.regenerate_region).toMatchObject({ resolution: 'PLANNED', category: 'ASYNC_COMMAND', costCategory: 'PROVIDER_ESTIMATE_REQUIRED' });
    for (const operation of ['create_preview_branch', 'commit_preview_branch', 'discard_preview_branch'] as const) {
      expect(EDIT_OPERATION_V2_REGISTRY[operation]).toMatchObject({ resolution: 'PLANNED', category: 'PREVIEW_COMMAND', supportedBackends: ['PROPOSAL_SERVICE'] });
    }
  });
});
