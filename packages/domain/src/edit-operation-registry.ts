import {
  ApiFailure,
  EDIT_OPERATION_REGISTRY,
  ERROR_CODES,
  OBJECT_LOCK_DIMENSIONS,
  type EditExecutionBackend,
  type EditOperation,
  type EditOperationDefinition,
  type ObjectLockDimension,
  type ObjectLockKind,
} from '@ancs/contracts';

export const EDIT_OPERATION_ERROR_REASONS = {
  UNKNOWN: 'UNKNOWN_EDIT_OPERATION',
  PLANNED: 'EDIT_OPERATION_NOT_IMPLEMENTED',
  ACTOR_FORBIDDEN: 'EDIT_OPERATION_ACTOR_FORBIDDEN',
  BACKEND_UNSUPPORTED: 'EDIT_OPERATION_BACKEND_UNSUPPORTED',
  CANDIDATE_REFERENCE_MISSING: 'EDIT_CANDIDATE_REFERENCE_MISSING',
  CANDIDATE_ID_OCCUPIED: 'EDIT_CANDIDATE_ID_OCCUPIED',
  CANDIDATE_LOCKED: 'EDIT_CANDIDATE_SCENE_LOCKED',
  CANDIDATE_IMPACT_LOCKED: 'EDIT_IMPACT_LOCKED',
  CANDIDATE_SPLIT_RANGE: 'EDIT_CANDIDATE_SPLIT_OUT_OF_RANGE',
  CANDIDATE_ORDER: 'EDIT_CANDIDATE_ORDER_INVALID',
  AI_UNLOCK_FORBIDDEN: 'AI_UNLOCK_FORBIDDEN',
  LOCK_TARGET_MISSING: 'EDIT_LOCK_TARGET_MISSING',
  RESTORE_EXCLUSIVE: 'RESTORE_PROJECT_VERSION_REQUIRES_EXCLUSIVE_BATCH',
} as const;

export interface EditCandidateScene {
  id: string;
  durationMs: number;
  locked: boolean;
}

export interface EditCandidateLock {
  objectKind: ObjectLockKind;
  objectId: string;
  dimensions: ObjectLockDimension[];
  reason?: string | null;
}

export interface EditImpact {
  objectKind: ObjectLockKind;
  objectId: string;
  dimensions: ObjectLockDimension[];
  direct: boolean;
  via: string | null;
}

export interface EditImpactDependency {
  fromKind: ObjectLockKind;
  fromId: string;
  toKind: ObjectLockKind;
  toId: string;
  dimensions: ObjectLockDimension[];
}

export interface EditCandidateResult {
  scenes: EditCandidateScene[];
  locks: EditCandidateLock[];
  impacts: EditImpact[];
  createdSceneIds: string[];
  definitions: EditOperationDefinition[];
}

const lockKey = (kind: ObjectLockKind, id: string): string => `${kind}:${id}`;
const uniqueDimensions = (dimensions: readonly ObjectLockDimension[]): ObjectLockDimension[] =>
  OBJECT_LOCK_DIMENSIONS.filter((dimension) => dimensions.includes(dimension));

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

const sceneImpact = (
  objectId: string,
  dimensions: ObjectLockDimension[],
  direct = true,
  via: string | null = null,
): EditImpact => ({ objectKind: 'SCENE', objectId, dimensions: uniqueDimensions(dimensions), direct, via });

function operationImpacts(operation: EditOperation, ordered: readonly EditCandidateScene[], projectId?: string): EditImpact[] {
  const indexOf = (sceneId: string): number => ordered.findIndex((scene) => scene.id === sceneId);
  const laterPositionImpacts = (index: number, via: string): EditImpact[] =>
    ordered.slice(Math.max(0, index + 1)).map((scene) => sceneImpact(scene.id, ['POSITION'], false, via));

  switch (operation.op) {
    case 'update_project': {
      if (projectId === undefined) return [];
      const dimensions: ObjectLockDimension[] = [];
      if (operation.changes.title !== undefined) dimensions.push('CONTENT');
      if (operation.changes.targetDurationMs !== undefined) dimensions.push('DURATION');
      return dimensions.length === 0 ? [] : [{ objectKind: 'PROJECT', objectId: projectId, dimensions, direct: true, via: null }];
    }
    case 'update_scene': {
      const dimensions: ObjectLockDimension[] = [];
      const changes = operation.changes;
      if (changes.durationMs !== undefined) dimensions.push('DURATION');
      if (changes.componentId !== undefined || changes.componentVersion !== undefined || changes.props !== undefined || changes.transition !== undefined) dimensions.push('STYLE');
      if (changes.narration !== undefined || changes.visualIntent !== undefined || changes.sceneType !== undefined || changes.semanticType !== undefined || changes.providerRequirement !== undefined || changes.sourceBindings !== undefined || changes.dataBindings !== undefined) dimensions.push('CONTENT');
      const impacts = dimensions.length === 0 ? [] : [sceneImpact(operation.sceneId, dimensions)];
      if (changes.durationMs !== undefined) impacts.push(...laterPositionImpacts(indexOf(operation.sceneId), operation.sceneId));
      return impacts;
    }
    case 'insert_scene': {
      const insertionIndex = operation.afterSceneId === null ? 0 : indexOf(operation.afterSceneId) + 1;
      return ordered.slice(Math.max(0, insertionIndex)).map((scene) => sceneImpact(scene.id, ['POSITION'], false, operation.createdSceneId ?? 'new-scene'));
    }
    case 'delete_scene': {
      const index = indexOf(operation.sceneId);
      return [sceneImpact(operation.sceneId, [...OBJECT_LOCK_DIMENSIONS]), ...laterPositionImpacts(index, operation.sceneId)];
    }
    case 'duplicate_scene': {
      const anchorId = operation.afterSceneId ?? operation.sceneId;
      const insertionIndex = indexOf(anchorId) + 1;
      return ordered.slice(Math.max(0, insertionIndex)).map((scene) => sceneImpact(scene.id, ['POSITION'], false, operation.createdSceneId ?? 'duplicate-scene'));
    }
    case 'split_scene': {
      const index = indexOf(operation.sceneId);
      return [sceneImpact(operation.sceneId, ['DURATION']), ...laterPositionImpacts(index, operation.sceneId)];
    }
    case 'reorder_scenes':
      return ordered.flatMap((scene, index) => operation.orderedSceneIds.indexOf(scene.id) === index ? [] : [sceneImpact(scene.id, ['POSITION'])]);
    case 'replace_asset':
      return [sceneImpact(operation.sceneId, ['ASSET'])];
    case 'restore_scene':
      return [sceneImpact(operation.sceneId, ['CONTENT', 'DURATION', 'ASSET', 'STYLE'])];
    case 'restore_project_version':
      return [
        ...(projectId === undefined ? [] : [{ objectKind: 'PROJECT' as const, objectId: projectId, dimensions: ['CONTENT', 'DURATION'] as ObjectLockDimension[], direct: true, via: null }]),
        ...ordered.map((scene) => sceneImpact(scene.id, [...OBJECT_LOCK_DIMENSIONS])),
      ];
    case 'set_scene_lock':
    case 'set_object_lock':
    case 'update_script':
    case 'update_caption':
    case 'update_audio_track':
      return [];
  }
}

function expandImpacts(initial: readonly EditImpact[], dependencies: readonly EditImpactDependency[]): EditImpact[] {
  const impacts = [...initial];
  const seen = new Set(impacts.map((impact) => `${lockKey(impact.objectKind, impact.objectId)}:${impact.dimensions.join(',')}`));
  for (let cursor = 0; cursor < impacts.length; cursor += 1) {
    const current = impacts[cursor]!;
    for (const dependency of dependencies) {
      if (dependency.fromKind !== current.objectKind || dependency.fromId !== current.objectId) continue;
      const dimensions = uniqueDimensions(dependency.dimensions.filter((dimension) => current.dimensions.includes(dimension)));
      if (dimensions.length === 0) continue;
      const impact: EditImpact = { objectKind: dependency.toKind, objectId: dependency.toId, dimensions, direct: false, via: lockKey(current.objectKind, current.objectId) };
      const key = `${lockKey(impact.objectKind, impact.objectId)}:${impact.dimensions.join(',')}`;
      if (!seen.has(key)) {
        seen.add(key);
        impacts.push(impact);
      }
    }
  }
  return impacts;
}

export function validateEditOperationCandidate(input: {
  scenes: readonly EditCandidateScene[];
  operations: readonly EditOperation[];
  actorType: 'USER' | 'AI' | 'SYSTEM';
  backend?: EditExecutionBackend;
  projectId?: string;
  locks?: readonly EditCandidateLock[];
  dependencies?: readonly EditImpactDependency[];
}): EditCandidateResult {
  const ordered = input.scenes.map((scene) => ({ ...scene }));
  const byId = new Map(ordered.map((scene) => [scene.id, scene]));
  const lockMap = new Map<string, EditCandidateLock>();
  for (const lock of input.locks ?? []) lockMap.set(lockKey(lock.objectKind, lock.objectId), { ...lock, dimensions: uniqueDimensions(lock.dimensions) });
  const createdSceneIds: string[] = [];
  const definitions: EditOperationDefinition[] = [];
  const allImpacts: EditImpact[] = [];
  const restoreCount = input.operations.filter((operation) => operation.op === 'restore_project_version').length;
  if (restoreCount > 0 && input.operations.length !== 1) {
    const operation = input.operations.find((item) => item.op === 'restore_project_version')!;
    candidateFailure('restore_project_version must be the only operation in its batch', EDIT_OPERATION_ERROR_REASONS.RESTORE_EXCLUSIVE, operation);
  }

  const requireScene = (id: string, operation: EditOperation): EditCandidateScene => {
    const scene = byId.get(id);
    if (scene === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'operation references a scene missing from the candidate state', 404, { reason: EDIT_OPERATION_ERROR_REASONS.CANDIDATE_REFERENCE_MISSING, operation: operation.op, sceneId: id });
    return scene;
  };
  const requireUnlocked = (scene: EditCandidateScene, operation: EditOperation): void => {
    if (scene.locked) throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'candidate scene is locked；请先显式解锁（set_scene_lock）', 409, { reason: EDIT_OPERATION_ERROR_REASONS.CANDIDATE_LOCKED, operation: operation.op, sceneId: scene.id });
  };
  const addScene = (scene: EditCandidateScene, afterId: string | null, operation: EditOperation): void => {
    if (byId.has(scene.id)) throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'created scene id is already occupied', 409, { reason: EDIT_OPERATION_ERROR_REASONS.CANDIDATE_ID_OCCUPIED, operation: operation.op, sceneId: scene.id });
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
    if (input.actorType === 'AI' && ((operation.op === 'set_object_lock' && !operation.locked) || (operation.op === 'set_scene_lock' && !operation.locked))) {
      throw new ApiFailure(ERROR_CODES.FORBIDDEN, 'AI cannot unlock protected content', 403, {
        reason: EDIT_OPERATION_ERROR_REASONS.AI_UNLOCK_FORBIDDEN,
        operation: operation.op,
      });
    }
    const impacts = expandImpacts(operationImpacts(operation, ordered, input.projectId), input.dependencies ?? []);
    for (const impact of impacts) {
      const lock = lockMap.get(lockKey(impact.objectKind, impact.objectId));
      const legacySceneLocked = impact.objectKind === 'SCENE' && byId.get(impact.objectId)?.locked === true;
      const blockedDimensions = legacySceneLocked
        ? [...impact.dimensions]
        : lock === undefined ? [] : impact.dimensions.filter((dimension) => lock.dimensions.includes(dimension));
      if (blockedDimensions.length > 0) throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'edit impact intersects an object lock', 409, { reason: EDIT_OPERATION_ERROR_REASONS.CANDIDATE_IMPACT_LOCKED, operation: operation.op, impact, blockedDimensions, lock: legacySceneLocked ? { objectKind: 'SCENE', objectId: impact.objectId, dimensions: [...OBJECT_LOCK_DIMENSIONS], reason: 'LEGACY_SCENE_LOCK' } : lock });
    }
    allImpacts.push(...impacts);

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
        lockMap.delete(lockKey('SCENE', scene.id));
        break;
      }
      case 'duplicate_scene': {
        const source = requireScene(operation.sceneId, operation);
        const id = operation.createdSceneId ?? operation.restoreSceneId ?? `__generated_duplicate_${String(index)}`;
        addScene({ ...source, id, locked: false }, operation.afterSceneId ?? source.id, operation);
        break;
      }
      case 'split_scene': {
        const source = requireScene(operation.sceneId, operation);
        requireUnlocked(source, operation);
        if (operation.atMs <= 0 || operation.atMs >= source.durationMs) candidateFailure('split point lies outside candidate scene duration', EDIT_OPERATION_ERROR_REASONS.CANDIDATE_SPLIT_RANGE, operation, { sceneId: source.id, durationMs: source.durationMs, atMs: operation.atMs });
        const tailDuration = source.durationMs - operation.atMs;
        source.durationMs = operation.atMs;
        const id = operation.createdTailSceneId ?? operation.restoreTailSceneId ?? `__generated_split_${String(index)}`;
        addScene({ ...source, id, durationMs: tailDuration, locked: false }, source.id, operation);
        break;
      }
      case 'reorder_scenes': {
        const current = [...byId.keys()].sort();
        const requested = [...operation.orderedSceneIds].sort();
        if (current.length !== requested.length || current.some((id, itemIndex) => id !== requested[itemIndex])) candidateFailure('reorder_scenes must contain every candidate scene exactly once', EDIT_OPERATION_ERROR_REASONS.CANDIDATE_ORDER, operation, { candidateSceneIds: current });
        ordered.sort((left, right) => operation.orderedSceneIds.indexOf(left.id) - operation.orderedSceneIds.indexOf(right.id));
        break;
      }
      case 'replace_asset': requireUnlocked(requireScene(operation.sceneId, operation), operation); break;
      case 'set_scene_lock': {
        const scene = requireScene(operation.sceneId, operation);
        scene.locked = operation.locked;
        break;
      }
      case 'set_object_lock': {
        if (operation.objectKind === 'PROJECT' && input.projectId !== undefined && operation.objectId !== input.projectId) candidateFailure('project lock target does not belong to this project', EDIT_OPERATION_ERROR_REASONS.LOCK_TARGET_MISSING, operation);
        if (operation.objectKind === 'SCENE') requireScene(operation.objectId, operation);
        const key = lockKey(operation.objectKind, operation.objectId);
        const current = lockMap.get(key);
        const dimensions = operation.locked ? uniqueDimensions([...(current?.dimensions ?? []), ...operation.dimensions]) : uniqueDimensions((current?.dimensions ?? []).filter((dimension) => !operation.dimensions.includes(dimension)));
        if (dimensions.length === 0) lockMap.delete(key);
        else lockMap.set(key, { objectKind: operation.objectKind, objectId: operation.objectId, dimensions, reason: operation.reason !== undefined ? operation.reason : current?.reason });
        break;
      }
      case 'restore_scene': requireUnlocked(requireScene(operation.sceneId, operation), operation); break;
      case 'restore_project_version': break;
      case 'update_script':
      case 'update_caption':
      case 'update_audio_track': break;
    }
  }
  return { scenes: ordered, locks: [...lockMap.values()], impacts: allImpacts, createdSceneIds, definitions };
}
