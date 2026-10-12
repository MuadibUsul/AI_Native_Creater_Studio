import { EDIT_OPERATION_TYPES, type EditOperation } from './edits.js';
import { OBJECT_LOCK_DIMENSIONS, OBJECT_LOCK_KINDS, type ObjectLockDimension, type ObjectLockKind } from './object-locks.js';

/**
 * N06-03：编辑操作 → 具体受影响对象与维度的**纯函数**映射（影响集/读写集的权威来源）。
 *
 * 与 `packages/domain/src/edit-operation-registry.ts` 的 `operationImpacts` 同源，但这里只依赖
 * 操作负载本身（不需要 Scene 顺序或数据库），因此可直接用于：
 * - 候选创建时**记录**其写目标（writeTargets）与读写集；
 * - 从 `edit_events` 的 `patch` 还原"干预改动到底碰了哪些对象与维度"。
 *
 * 维度语义沿用对象锁的六维（`OBJECT_LOCK_DIMENSIONS`）。无法从负载确定的维度**保守取全维度**，
 * 宁可多报冲突也不漏报（漏报会导致陈旧候选被静默 rebase）。
 */

export interface EditTargetRef {
  objectKind: ObjectLockKind;
  objectId: string;
  dimensions: ObjectLockDimension[];
}

const ALL: ObjectLockDimension[] = [...OBJECT_LOCK_DIMENSIONS];
const normalize = (dimensions: readonly ObjectLockDimension[]): ObjectLockDimension[] =>
  OBJECT_LOCK_DIMENSIONS.filter((dimension) => dimensions.includes(dimension));
const ref = (objectKind: ObjectLockKind, objectId: string, dimensions: readonly ObjectLockDimension[]): EditTargetRef =>
  ({ objectKind, objectId, dimensions: normalize(dimensions) });

/** `patch.op` 形态的可选负载（edit_events 的 patch 与候选 operations 元素同形）。 */
type OperationLike = { op?: unknown } & Record<string, unknown>;
const asRecord = (value: unknown): Record<string, unknown> | null =>
  (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null);
const str = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);
const hasKey = (record: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key) && record[key] !== undefined;

export function isObjectLockKind(value: unknown): value is ObjectLockKind {
  return typeof value === 'string' && (OBJECT_LOCK_KINDS as readonly string[]).includes(value);
}

export function isEditOperationName(value: unknown): boolean {
  return typeof value === 'string' && (EDIT_OPERATION_TYPES as readonly string[]).includes(value);
}

/**
 * 操作负载 → 直接受影响对象（含被创建/引用的对象）。
 * 读不到的字段被跳过（返回的对象可能为空数组），**不抛异常**。
 */
export function computeOperationTargetRefs(operation: OperationLike, options: { projectId?: string } = {}): EditTargetRef[] {
  const patch = asRecord(operation) ?? {};
  const projectId = options.projectId ?? str(patch['projectId']);
  const changes = asRecord(patch['changes']) ?? {};
  switch (patch['op']) {
    case 'update_project': {
      if (projectId === null) return [];
      const dimensions: ObjectLockDimension[] = [];
      if (hasKey(changes, 'title')) dimensions.push('CONTENT');
      if (hasKey(changes, 'targetDurationMs')) dimensions.push('DURATION');
      return dimensions.length === 0 ? [] : [ref('PROJECT', projectId, dimensions)];
    }
    case 'update_scene': {
      const sceneId = str(patch['sceneId']);
      if (sceneId === null) return [];
      const dimensions: ObjectLockDimension[] = [];
      if (hasKey(changes, 'durationMs')) dimensions.push('DURATION');
      if (hasKey(changes, 'componentId') || hasKey(changes, 'componentVersion') || hasKey(changes, 'props') || hasKey(changes, 'transition')) dimensions.push('STYLE');
      if (hasKey(changes, 'narration') || hasKey(changes, 'visualIntent') || hasKey(changes, 'sceneType') || hasKey(changes, 'semanticType') || hasKey(changes, 'providerRequirement') || hasKey(changes, 'sourceBindings') || hasKey(changes, 'dataBindings')) dimensions.push('CONTENT');
      return dimensions.length === 0 ? [] : [ref('SCENE', sceneId, dimensions)];
    }
    case 'insert_scene': {
      const sceneId = str(patch['createdSceneId']) ?? str(patch['restoreSceneId']);
      return sceneId === null ? [] : [ref('SCENE', sceneId, ALL)];
    }
    case 'duplicate_scene': {
      const sceneId = str(patch['createdSceneId']) ?? str(patch['restoreSceneId']);
      return sceneId === null ? [] : [ref('SCENE', sceneId, ALL)];
    }
    case 'delete_scene': {
      const sceneId = str(patch['sceneId']);
      return sceneId === null ? [] : [ref('SCENE', sceneId, ALL)];
    }
    case 'split_scene': {
      const sceneId = str(patch['sceneId']);
      return sceneId === null ? [] : [ref('SCENE', sceneId, ['DURATION'])];
    }
    case 'reorder_scenes': {
      const ordered = Array.isArray(patch['orderedSceneIds']) ? patch['orderedSceneIds'] : [];
      return ordered.filter((id): id is string => typeof id === 'string').map((id) => ref('SCENE', id, ['POSITION']));
    }
    case 'replace_asset': {
      const sceneId = str(patch['sceneId']);
      return sceneId === null ? [] : [ref('SCENE', sceneId, ['ASSET'])];
    }
    case 'restore_scene': {
      const sceneId = str(patch['sceneId']);
      return sceneId === null ? [] : [ref('SCENE', sceneId, ALL)];
    }
    case 'restore_project_version':
      return projectId === null ? [] : [ref('PROJECT', projectId, ALL)];
    case 'set_scene_lock': {
      const sceneId = str(patch['sceneId']);
      return sceneId === null ? [] : [ref('SCENE', sceneId, ALL)];
    }
    case 'set_object_lock': {
      const objectKind = patch['objectKind'];
      const objectId = str(patch['objectId']);
      const dimensions = Array.isArray(patch['dimensions']) ? patch['dimensions'].filter((dimension): dimension is ObjectLockDimension => (OBJECT_LOCK_DIMENSIONS as readonly string[]).includes(dimension as string)) : [];
      if (objectId === null || !isObjectLockKind(objectKind)) return [];
      return [ref(objectKind, objectId, dimensions.length === 0 ? ALL : dimensions)];
    }
    case 'update_clip': {
      const clipId = str(patch['clipId']);
      if (clipId === null) return [];
      const dimensions: ObjectLockDimension[] = [];
      if (hasKey(changes, 'sourceRange') || hasKey(changes, 'timeMapping') || hasKey(changes, 'sourceStreamId')) dimensions.push('CONTENT', 'DURATION');
      if (hasKey(changes, 'sequenceRange')) dimensions.push('POSITION', 'DURATION');
      if (hasKey(changes, 'trackId')) dimensions.push('TRACK', 'POSITION');
      return dimensions.length === 0 ? [] : [ref('CLIP', clipId, dimensions)];
    }
    case 'insert_clip': {
      const trackId = str(patch['trackId']);
      if (trackId === null) return [];
      const dimensions: ObjectLockDimension[] = ['POSITION', 'DURATION'];
      if (patch['mode'] === 'OVERWRITE') dimensions.push('CONTENT');
      return [ref('TRACK', trackId, dimensions)];
    }
    case 'delete_clip': {
      const clipId = str(patch['clipId']);
      return clipId === null ? [] : [ref('CLIP', clipId, ['CONTENT', 'POSITION', 'DURATION'])];
    }
    case 'split_clip': {
      const clipId = str(patch['clipId']);
      if (clipId === null) return [];
      const created = str(patch['createdClipId']) ?? str(patch['createdAudioClipId']);
      return created === null
        ? [ref('CLIP', clipId, ['CONTENT', 'DURATION', 'POSITION'])]
        : [ref('CLIP', clipId, ['CONTENT', 'DURATION', 'POSITION']), ref('CLIP', created, ['CONTENT', 'POSITION'])];
    }
    case 'trim_clip': {
      const clipId = str(patch['clipId']);
      return clipId === null ? [] : [ref('CLIP', clipId, ['CONTENT', 'POSITION', 'DURATION'])];
    }
    case 'move_clip': {
      const clipId = str(patch['clipId']);
      if (clipId === null) return [];
      const trackId = str(patch['trackId']);
      return trackId === null
        ? [ref('CLIP', clipId, ['POSITION', 'TRACK'])]
        : [ref('CLIP', clipId, ['POSITION', 'TRACK']), ref('TRACK', trackId, ['POSITION', 'DURATION'])];
    }
    case 'duplicate_clip': {
      const clipId = str(patch['createdClipId']) ?? str(patch['createdAudioClipId']) ?? str(patch['clipId']);
      return clipId === null ? [] : [ref('CLIP', clipId, ['POSITION'])];
    }
    case 'replace_clip_source': {
      const clipId = str(patch['clipId']);
      return clipId === null ? [] : [ref('CLIP', clipId, ['CONTENT', 'DURATION'])];
    }
    case 'slip_clip': {
      const clipId = str(patch['clipId']);
      return clipId === null ? [] : [ref('CLIP', clipId, ['CONTENT'])];
    }
    case 'slide_clip': {
      const clipId = str(patch['clipId']);
      return clipId === null ? [] : [ref('CLIP', clipId, ['POSITION'])];
    }
    case 'roll_clip': {
      const left = str(patch['leftClipId']);
      const right = str(patch['rightClipId']);
      return [left, right].filter((id): id is string => id !== null).map((id) => ref('CLIP', id, ['CONTENT', 'DURATION', 'POSITION']));
    }
    case 'ripple_clip': {
      const clipId = str(patch['clipId']);
      return clipId === null ? [] : [ref('CLIP', clipId, ['CONTENT', 'DURATION', 'POSITION'])];
    }
    case 'split_av_cut': {
      const video = str(patch['videoClipId']);
      const audio = str(patch['audioClipId']);
      return [video, audio].filter((id): id is string => id !== null).map((id) => ref('CLIP', id, ['CONTENT', 'DURATION', 'POSITION']));
    }
    case 'create_track': {
      const sequenceId = str(patch['sequenceId']);
      return sequenceId === null ? [] : [ref('TRACK', sequenceId, ['POSITION'])];
    }
    case 'move_track': {
      const trackId = str(patch['trackId']);
      return trackId === null ? [] : [ref('TRACK', trackId, ['POSITION'])];
    }
    case 'delete_track': {
      const trackId = str(patch['trackId']);
      return trackId === null ? [] : [ref('TRACK', trackId, ['POSITION', 'DURATION'])];
    }
    case 'update_track': {
      const trackId = str(patch['trackId']);
      if (trackId === null) return [];
      return [ref('TRACK', trackId, hasKey(changes, 'position') ? ['STYLE', 'POSITION'] : ['STYLE'])];
    }
    case 'set_sequence_duration': {
      const sequenceId = str(patch['sequenceId']);
      return sequenceId === null ? [] : [ref('SEQUENCE', sequenceId, ['DURATION'])];
    }
    case 'set_av_link': {
      const clipIds = Array.isArray(patch['clipIds']) ? patch['clipIds'] : [];
      return clipIds.filter((id): id is string => typeof id === 'string').map((id) => ref('CLIP', id, ['CONTENT']));
    }
    case 'create_caption': {
      const trackId = str(patch['trackId']);
      return trackId === null ? [] : [ref('TRACK', trackId, ['POSITION'])];
    }
    case 'update_caption':
    case 'split_caption':
    case 'delete_caption': {
      const captionId = str(patch['captionId']);
      return captionId === null ? [] : [ref('CAPTION', captionId, ['STYLE'])];
    }
    case 'cut_caption_range': {
      const captionId = str(patch['captionId']);
      if (captionId === null) return [];
      return [ref('CAPTION', captionId, patch['mode'] === 'CUT_CONTENT' ? ['POSITION', 'DURATION'] : ['STYLE'])];
    }
    case 'apply_audio_crossfade': {
      const left = str(patch['leftRegionId']);
      const right = str(patch['rightRegionId']);
      return [left, right].filter((id): id is string => id !== null).map((id) => ref('AUDIO_REGION', id, ['STYLE']));
    }
    case 'set_clip_transform':
    case 'set_clip_crop':
    case 'set_clip_opacity': {
      const clipId = str(patch['clipId']);
      return clipId === null ? [] : [ref('CLIP', clipId, ['STYLE'])];
    }
    case 'update_animation': {
      const targetId = str(patch['targetId']);
      const targetKind = patch['targetKind'];
      if (targetId === null) return [];
      if (targetKind === 'VISUAL_OBJECT') return [ref('VISUAL_OBJECT', targetId, ['STYLE'])];
      if (targetKind === 'AUDIO_REGION') return [ref('AUDIO_REGION', targetId, ['STYLE'])];
      return [];
    }
    case 'update_audio_region': {
      const audioRegionId = str(patch['audioRegionId']);
      if (audioRegionId === null) return [];
      const dimensions: ObjectLockDimension[] = [];
      if (hasKey(changes, 'trackId')) dimensions.push('TRACK', 'POSITION');
      if (hasKey(changes, 'sequenceRange') || hasKey(changes, 'localRange') || hasKey(changes, 'timeBinding')) dimensions.push('POSITION', 'DURATION');
      if (hasKey(changes, 'sourceStreamId') || hasKey(changes, 'channelMapping')) dimensions.push('ASSET');
      if (hasKey(changes, 'gainDb') || hasKey(changes, 'pan') || hasKey(changes, 'fadeIn') || hasKey(changes, 'fadeOut') || hasKey(changes, 'parameters')) dimensions.push('STYLE');
      return dimensions.length === 0 ? [] : [ref('AUDIO_REGION', audioRegionId, dimensions)];
    }
    // update_script / update_audio_track 属计划阶段，无具体目标；未知操作同样保守返回空（由调用方按需降级）
    default:
      return [];
  }
}

/** 供 `editOperationSchema` 已解析的强类型操作直接调用（与上面的防御式读取等价）。 */
export function operationTargetRefs(operation: EditOperation, options: { projectId?: string } = {}): EditTargetRef[] {
  return computeOperationTargetRefs(operation as unknown as OperationLike, options);
}

/** 两个目标集合是否在同一对象、同一维度上相交（用于"改同字段"判定）。 */
export function targetRefsIntersect(left: EditTargetRef, right: EditTargetRef): ObjectLockDimension[] {
  if (left.objectKind !== right.objectKind || left.objectId !== right.objectId) return [];
  return normalize(left.dimensions.filter((dimension) => right.dimensions.includes(dimension)));
}
