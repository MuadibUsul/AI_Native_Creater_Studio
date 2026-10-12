import type { EditOperation, MediaRange, MediaTime, ObjectLockDimension, ObjectLockKind } from '@ancs/contracts';

/**
 * 编辑内核的时间线状态（V5 §6）：**一个项目**全部序列的内存快照。
 *
 * 只含编辑规则需要的核心字段；租户归属、时间戳等持久化字段由领域层在落库时补全。
 * 内核不读写数据库、不读环境、不取墙钟、不生成随机数（ID 由调用方注入）。
 */
export interface KernelSequence {
  id: string;
  /** 序列时长；其时基即序列编辑时基 */
  duration: MediaTime;
}

export interface KernelTrack {
  id: string;
  sequenceId: string;
  kind: string;
  position: number;
  name: string;
  locked: boolean;
  muted: boolean;
  hidden: boolean;
  solo: boolean;
  syncLocked: boolean;
}

export interface KernelClip {
  id: string;
  sequenceId: string;
  trackId: string;
  assetVersionId: string | null;
  nestedSequenceId: string | null;
  sourceStreamId: string | null;
  sourceRange: MediaRange;
  sequenceRange: MediaRange;
  timeMapping: unknown;
  avGroupId: string | null;
  parentClipId: string | null;
  /** 可编辑变换/裁切/透明度参数（null = 旧语义缺省值） */
  parameters: unknown;
}

export interface KernelAudioRegion {
  id: string;
  sequenceId: string;
  trackId: string;
  timeBinding: unknown;
  localRange: MediaRange;
  sequenceRange: MediaRange;
  sourceStreamId: string;
  channelMapping: unknown;
  gainDb: number;
  pan: number;
  fadeIn: MediaTime;
  fadeOut: MediaTime;
  parameters: unknown;
}

export interface KernelCaption {
  id: string;
  sequenceId: string;
  trackId: string;
  timeBinding: unknown;
  localRange: MediaRange;
  sequenceRange: MediaRange;
  text: string;
  languageTag: string;
  style: unknown;
  words: unknown;
  speechAnchorId: string | null;
}

/** 素材版本的不可变事实（来自探测与入库，不由编辑改变）。 */
export interface KernelAssetVersionFacts {
  status: string;
  durationMs: number | null;
  checksumSha256: string | null;
  hasAudio: boolean;
}

export interface KernelSourceFacts {
  /** 按 assetVersionId；不在表中 = 不存在或不属于本工作区 */
  assetVersions: ReadonlyMap<string, KernelAssetVersionFacts>;
}

/** 对象锁表：键 = `${objectKind}:${objectId}` */
export type KernelLockTable = ReadonlyMap<string, readonly ObjectLockDimension[]>;

export const lockKey = (objectKind: ObjectLockKind, objectId: string): string => `${objectKind}:${objectId}`;

export interface KernelPolicy {
  /** 原声保护：音频区域禁止改动源流/局部时钟（N03-06） */
  preserveOriginalSpeech: boolean;
}

export interface TimelineState {
  sequences: ReadonlyMap<string, KernelSequence>;
  tracks: readonly KernelTrack[];
  clips: readonly KernelClip[];
  audioRegions: readonly KernelAudioRegion[];
  captions: readonly KernelCaption[];
  locks: KernelLockTable;
  sources: KernelSourceFacts;
  policy: KernelPolicy;
  /**
   * 内核不编辑、但占用轨道的对象数（按 trackId；当前为视觉对象）。
   * 删除轨道时必须计入：否则数据库外键级联会静默删除它们且无法撤销。
   */
  unmanagedTrackObjects?: ReadonlyMap<string, number>;
}

export interface KernelContext {
  /** 新对象 ID（调用方注入，保证内核确定性；测试可注入固定序列） */
  newId(prefix: 'clp' | 'avgp' | 'trk' | 'cap'): string;
  /** 补偿路径（undo/redo）：恢复到此前已接受的状态，不受"新内容改动"类守卫限制 */
  compensation?: boolean;
}

export type KernelEntity =
  | { entity: 'sequence'; value: KernelSequence }
  | { entity: 'clip'; value: KernelClip }
  | { entity: 'track'; value: KernelTrack }
  | { entity: 'audioRegion'; value: KernelAudioRegion }
  | { entity: 'caption'; value: KernelCaption };

/** 内核产生的单条写入（按顺序应用）。 */
export type KernelWrite =
  | { type: 'insert'; after: KernelEntity }
  | { type: 'update'; before: KernelEntity; after: KernelEntity }
  | { type: 'delete'; before: KernelEntity };

/**
 * 编辑事件草稿：领域层把 `patch` 与 `snapshots`（键 → 实体快照，如 before/after/createdCaption）合并后落 edit_events。
 * 事件与写入解耦：事件顺序是 undo/redo 的语义顺序，可与写入顺序不同（例如轨道两阶段落位）。
 */
export interface KernelEventDraft {
  action: string;
  objectKind: 'SEQUENCE' | 'CLIP' | 'TRACK' | 'AUDIO_REGION' | 'CAPTION';
  objectId: string;
  patch: Record<string, unknown>;
  snapshots: Record<string, KernelEntity>;
}

export interface KernelResult {
  writes: KernelWrite[];
  events: KernelEventDraft[];
}

/** 已迁入内核的时间线操作。 */
export const KERNEL_TIMELINE_OPERATIONS = [
  'insert_clip',
  'delete_clip',
  'split_clip',
  'trim_clip',
  'move_clip',
  'duplicate_clip',
  'replace_clip_source',
  'slip_clip',
  'slide_clip',
  'roll_clip',
  'ripple_clip',
  'split_av_cut',
  'create_track',
  'move_track',
  'delete_track',
  'update_track',
  'set_sequence_duration',
  'set_clip_transform',
  'set_clip_crop',
  'set_clip_opacity',
  'set_av_link',
  'update_clip',
  'create_caption',
  'update_caption',
  'split_caption',
  'cut_caption_range',
  'delete_caption',
  'apply_audio_crossfade',
  'update_audio_region',
] as const;
export type KernelTimelineOperationName = (typeof KERNEL_TIMELINE_OPERATIONS)[number];
export type KernelTimelineOperation = Extract<EditOperation, { op: KernelTimelineOperationName }>;

export const isKernelTimelineOperation = (operation: EditOperation): operation is KernelTimelineOperation =>
  (KERNEL_TIMELINE_OPERATIONS as readonly string[]).includes(operation.op);

/** 操作引用的素材版本（领域层据此加载源事实）。 */
export function referencedAssetVersionIds(operation: KernelTimelineOperation): string[] {
  if ((operation.op === 'insert_clip' || operation.op === 'replace_clip_source') && operation.assetVersionId !== null) {
    return [operation.assetVersionId];
  }
  return [];
}
