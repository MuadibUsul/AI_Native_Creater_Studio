import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EDIT_OPERATION_TYPES, editRequestSchema } from './index.js';

const samplePath = join(import.meta.dirname, '..', 'fixtures', 'edit-request.sample.json');
const raw: unknown = JSON.parse(readFileSync(samplePath, 'utf8'));

describe('编辑协议契约（计划 §4.6）', () => {
  it('操作类型覆盖 §4.6 列出的全部 14 类', () => {
    expect(EDIT_OPERATION_TYPES).toHaveLength(14);
    expect(EDIT_OPERATION_TYPES).toContain('restore_project_version');
    expect(EDIT_OPERATION_TYPES).toContain('set_scene_lock');
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
});
