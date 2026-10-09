import { describe, expect, it } from 'vitest';
import { validateEditOperationCandidate } from './edit-operation-registry.js';

const scenes = [
  { id: 'scn_a', durationMs: 5_000, locked: false },
  { id: 'scn_b', durationMs: 6_000, locked: false },
  { id: 'scn_c', durationMs: 7_000, locked: false },
];

describe('N01-07 edit impact and object locks', () => {
  it('content lock permits position-only reorder while position lock blocks it without sceneId on the operation', () => {
    expect(() => validateEditOperationCandidate({
      scenes,
      actorType: 'USER',
      projectId: 'prj_test',
      locks: [{ objectKind: 'SCENE', objectId: 'scn_a', dimensions: ['CONTENT'] }],
      operations: [{ op: 'reorder_scenes', orderedSceneIds: ['scn_c', 'scn_b', 'scn_a'] }],
    })).not.toThrow();

    expect(() => validateEditOperationCandidate({
      scenes,
      actorType: 'USER',
      projectId: 'prj_test',
      locks: [{ objectKind: 'SCENE', objectId: 'scn_a', dimensions: ['POSITION'] }],
      operations: [{ op: 'reorder_scenes', orderedSceneIds: ['scn_c', 'scn_b', 'scn_a'] }],
    })).toThrowError(expect.objectContaining({
      code: 'PRECONDITION_FAILED',
      details: expect.objectContaining({ reason: 'EDIT_IMPACT_LOCKED', blockedDimensions: ['POSITION'] }),
    }));
  });

  it('duration ripple includes later scene positions and dependency impacts', () => {
    expect(() => validateEditOperationCandidate({
      scenes,
      actorType: 'USER',
      projectId: 'prj_test',
      locks: [{ objectKind: 'TRACK', objectId: 'trk_parent', dimensions: ['POSITION'] }],
      dependencies: [{
        fromKind: 'SCENE', fromId: 'scn_b', toKind: 'TRACK', toId: 'trk_parent', dimensions: ['POSITION'],
      }],
      operations: [{ op: 'update_scene', sceneId: 'scn_a', changes: { durationMs: 8_000 } }],
    })).toThrowError(expect.objectContaining({
      details: expect.objectContaining({ reason: 'EDIT_IMPACT_LOCKED' }),
    }));
  });

  it('explicit unlock is an independent ordered operation and enables the following edit', () => {
    const result = validateEditOperationCandidate({
      scenes,
      actorType: 'USER',
      projectId: 'prj_test',
      locks: [{ objectKind: 'SCENE', objectId: 'scn_a', dimensions: ['POSITION', 'CONTENT'] }],
      operations: [
        { op: 'set_object_lock', objectKind: 'SCENE', objectId: 'scn_a', dimensions: ['POSITION'], locked: false },
        { op: 'reorder_scenes', orderedSceneIds: ['scn_c', 'scn_b', 'scn_a'] },
      ],
    });
    expect(result.locks).toEqual([{ objectKind: 'SCENE', objectId: 'scn_a', dimensions: ['CONTENT'], reason: undefined }]);
    expect(result.impacts.some((impact) => impact.objectId === 'scn_a' && impact.dimensions.includes('POSITION'))).toBe(true);
  });

  it('AI cannot silently unlock to make its plan pass', () => {
    expect(() => validateEditOperationCandidate({
      scenes,
      actorType: 'AI',
      projectId: 'prj_test',
      locks: [{ objectKind: 'SCENE', objectId: 'scn_a', dimensions: ['CONTENT'] }],
      operations: [{ op: 'set_object_lock', objectKind: 'SCENE', objectId: 'scn_a', dimensions: ['CONTENT'], locked: false }],
    })).toThrowError(expect.objectContaining({ code: 'FORBIDDEN', details: { reason: 'AI_UNLOCK_FORBIDDEN', operation: 'set_object_lock' } }));
  });
});
