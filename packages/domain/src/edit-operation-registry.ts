import {
  ApiFailure,
  EDIT_OPERATION_REGISTRY,
  ERROR_CODES,
  type EditExecutionBackend,
  type EditOperation,
  type EditOperationDefinition,
} from '@ancs/contracts';

export const EDIT_OPERATION_ERROR_REASONS = {
  UNKNOWN: 'UNKNOWN_EDIT_OPERATION',
  PLANNED: 'EDIT_OPERATION_NOT_IMPLEMENTED',
  ACTOR_FORBIDDEN: 'EDIT_OPERATION_ACTOR_FORBIDDEN',
  BACKEND_UNSUPPORTED: 'EDIT_OPERATION_BACKEND_UNSUPPORTED',
  CANDIDATE_REFERENCE_MISSING: 'EDIT_CANDIDATE_REFERENCE_MISSING',
  CANDIDATE_ID_OCCUPIED: 'EDIT_CANDIDATE_ID_OCCUPIED',
  CANDIDATE_LOCKED: 'EDIT_CANDIDATE_SCENE_LOCKED',
  CANDIDATE_SPLIT_RANGE: 'EDIT_CANDIDATE_SPLIT_OUT_OF_RANGE',
  CANDIDATE_ORDER: 'EDIT_CANDIDATE_ORDER_INVALID',
  RESTORE_EXCLUSIVE: 'RESTORE_PROJECT_VERSION_REQUIRES_EXCLUSIVE_BATCH',
} as const;

export interface EditCandidateScene {
  id: string;
  durationMs: number;
  locked: boolean;
}

export interface EditCandidateResult {
  scenes: EditCandidateScene[];
  createdSceneIds: string[];
  definitions: EditOperationDefinition[];
}

export function requireEditOperationDefinition(
  operation: EditOperation,
  actorType: 'USER' | 'AI' | 'SYSTEM',
  backend: EditExecutionBackend = 'LEGACY_SCENE',
): EditOperationDefinition {
  const definition = EDIT_OPERATION_REGISTRY[operation.op] as EditOperationDefinition | undefined;
  if (definition === undefined) {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'unknown edit operation', 501, {
      reason: EDIT_OPERATION_ERROR_REASONS.UNKNOWN,
      operation: (operation as { op?: unknown }).op,
    });
  }
  if (definition.availability !== 'ACTIVE') {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, `操作 ${operation.op} 当前不可用（计划阶段：${definition.plannedPhase ?? '未排期'}）`, 501, {
      reason: EDIT_OPERATION_ERROR_REASONS.PLANNED,
      operation: operation.op,
      plannedPhase: definition.plannedPhase,
    });
  }
  if (!definition.actorTypes.includes(actorType)) {
    throw new ApiFailure(ERROR_CODES.FORBIDDEN, 'actor is not allowed to execute this operation', 403, {
      reason: EDIT_OPERATION_ERROR_REASONS.ACTOR_FORBIDDEN,
      operation: operation.op,
      actorType,
    });
  }
  if (!definition.supportedBackends.includes(backend)) {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'operation is unavailable on the selected edit backend', 409, {
      reason: EDIT_OPERATION_ERROR_REASONS.BACKEND_UNSUPPORTED,
      operation: operation.op,
      backend,
    });
  }
  return definition;
}

const candidateFailure = (message: string, reason: string, operation: EditOperation, details: Record<string, unknown> = {}): never => {
  throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, message, 422, { reason, operation: operation.op, ...details });
};

/**
 * Simulate a complete operation batch in order before any authoritative row is
 * mutated. This validates references created or removed by earlier operations.
 */
export function validateEditOperationCandidate(input: {
  scenes: readonly EditCandidateScene[];
  operations: readonly EditOperation[];
  actorType: 'USER' | 'AI' | 'SYSTEM';
  backend?: EditExecutionBackend;
}): EditCandidateResult {
  const ordered = input.scenes.map((scene) => ({ ...scene }));
  const byId = new Map(ordered.map((scene) => [scene.id, scene]));
  const createdSceneIds: string[] = [];
  const definitions: EditOperationDefinition[] = [];
  const restoreCount = input.operations.filter((operation) => operation.op === 'restore_project_version').length;
  if (restoreCount > 0 && input.operations.length !== 1) {
    const operation = input.operations.find((item) => item.op === 'restore_project_version')!;
    candidateFailure('restore_project_version must be the only operation in its batch', EDIT_OPERATION_ERROR_REASONS.RESTORE_EXCLUSIVE, operation);
  }

  const requireScene = (id: string, operation: EditOperation): EditCandidateScene => {
    const scene = byId.get(id);
    if (scene === undefined) {
      throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'operation references a scene missing from the candidate state', 404, {
        reason: EDIT_OPERATION_ERROR_REASONS.CANDIDATE_REFERENCE_MISSING,
        operation: operation.op,
        sceneId: id,
      });
    }
    return scene as EditCandidateScene;
  };
  const requireUnlocked = (scene: EditCandidateScene, operation: EditOperation): void => {
    if (scene.locked) {
      throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'candidate scene is locked；请先显式解锁（set_scene_lock）', 409, {
        reason: EDIT_OPERATION_ERROR_REASONS.CANDIDATE_LOCKED,
        operation: operation.op,
        sceneId: scene.id,
      });
    }
  };
  const addScene = (scene: EditCandidateScene, afterId: string | null, operation: EditOperation): void => {
    if (byId.has(scene.id)) {
      throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'created scene id is already occupied', 409, {
        reason: EDIT_OPERATION_ERROR_REASONS.CANDIDATE_ID_OCCUPIED,
        operation: operation.op,
        sceneId: scene.id,
      });
    }
    let index = 0;
    if (afterId !== null) {
      requireScene(afterId, operation);
      index = ordered.findIndex((item) => item.id === afterId) + 1;
    }
    ordered.splice(index, 0, scene);
    byId.set(scene.id, scene);
    createdSceneIds.push(scene.id);
  };

  for (const [index, operation] of input.operations.entries()) {
    definitions.push(requireEditOperationDefinition(operation, input.actorType, input.backend));
    switch (operation.op) {
      case 'update_project': break;
      case 'insert_scene': {
        const id = operation.createdSceneId ?? operation.restoreSceneId ?? `__generated_insert_${String(index)}`;
        addScene({ id, durationMs: operation.sceneDraft.durationMs, locked: operation.sceneDraft.locked }, operation.afterSceneId, operation);
        break;
      }
      case 'update_scene': {
        const scene = requireScene(operation.sceneId, operation);
        requireUnlocked(scene, operation);
        if (operation.changes.durationMs !== undefined) scene.durationMs = operation.changes.durationMs;
        break;
      }
      case 'delete_scene': {
        const scene = requireScene(operation.sceneId, operation);
        requireUnlocked(scene, operation);
        byId.delete(scene.id);
        ordered.splice(ordered.findIndex((item) => item.id === scene.id), 1);
        break;
      }
      case 'duplicate_scene': {
        const source = requireScene(operation.sceneId, operation);
        const id = operation.createdSceneId ?? operation.restoreSceneId ?? `__generated_duplicate_${String(index)}`;
        addScene({ ...source, id }, operation.afterSceneId ?? source.id, operation);
        break;
      }
      case 'split_scene': {
        const source = requireScene(operation.sceneId, operation);
        requireUnlocked(source, operation);
        if (operation.atMs <= 0 || operation.atMs >= source.durationMs) {
          candidateFailure('split point lies outside candidate scene duration', EDIT_OPERATION_ERROR_REASONS.CANDIDATE_SPLIT_RANGE, operation, { sceneId: source.id, durationMs: source.durationMs, atMs: operation.atMs });
        }
        const tailDuration = source.durationMs - operation.atMs;
        source.durationMs = operation.atMs;
        const id = operation.createdTailSceneId ?? operation.restoreTailSceneId ?? `__generated_split_${String(index)}`;
        addScene({ ...source, id, durationMs: tailDuration }, source.id, operation);
        break;
      }
      case 'reorder_scenes': {
        const current = [...byId.keys()].sort();
        const requested = [...operation.orderedSceneIds].sort();
        if (current.length !== requested.length || current.some((id, itemIndex) => id !== requested[itemIndex])) {
          candidateFailure('reorder_scenes must contain every candidate scene exactly once', EDIT_OPERATION_ERROR_REASONS.CANDIDATE_ORDER, operation, { candidateSceneIds: current });
        }
        ordered.sort((left, right) => operation.orderedSceneIds.indexOf(left.id) - operation.orderedSceneIds.indexOf(right.id));
        break;
      }
      case 'replace_asset': {
        requireUnlocked(requireScene(operation.sceneId, operation), operation);
        break;
      }
      case 'set_scene_lock': {
        requireScene(operation.sceneId, operation).locked = operation.locked;
        break;
      }
      case 'restore_scene': {
        requireUnlocked(requireScene(operation.sceneId, operation), operation);
        break;
      }
      case 'restore_project_version': break;
      case 'update_script':
      case 'update_caption':
      case 'update_audio_track':
        // Availability check above always rejects planned operations.
        break;
    }
  }
  return { scenes: ordered, createdSceneIds, definitions };
}
