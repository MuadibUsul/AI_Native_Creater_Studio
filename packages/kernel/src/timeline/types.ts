import type { EditOperation, MediaRange, MediaTime, ObjectLockDimension, ObjectLockKind } from '@ancs/contracts';

/**
 * 编辑内核的时间线状态（V5 §6）：**单个序列**的内存快照。
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
  timeBinding: unknown;
  localRange: MediaRange;
  sequenceRange: MediaRange;
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
  /** 同项目的序列时长（嵌套序列源边界） */
  sequenceDurations: ReadonlyMap<string, MediaTime>;
}

/** 对象锁表：键 = `${objectKind}:${objectId}` */
export type KernelLockTable = ReadonlyMap<string, readonly ObjectLockDimension[]>;

export const lockKey = (objectKind: ObjectLockKind, objectId: string): string => `${objectKind}:${objectId}`;

export interface TimelineState {
  sequence: KernelSequence;
  tracks: readonly KernelTrack[];
  clips: readonly KernelClip[];
  audioRegions: readonly KernelAudioRegion[];
  locks: KernelLockTable;
  sources: KernelSourceFacts;
}

export interface KernelContext {
  /** 新对象 ID（调用方注入，保证内核确定性；测试可注入固定序列） */
  newId(prefix: 'clp' | 'avgp' | 'trk'): string;
}

/** 内核产生的单条写入（按顺序应用）。 */
export type KernelWrite =
  | { entity: 'clip'; type: 'insert'; after: KernelClip }
  | { entity: 'clip'; type: 'update'; before: KernelClip; after: KernelClip }
  | { entity: 'clip'; type: 'delete'; before: KernelClip }
  | { entity: 'track'; type: 'insert'; after: KernelTrack }
  | { entity: 'audioRegion'; type: 'update'; before: KernelAudioRegion; after: KernelAudioRegion };

/**
 * 编辑事件草稿：领域层把 `patch` 与写入的 before/after 快照合并后落 `edit_events`。
 * `patch` 不含 before/after（快照格式属于持久化层）。
 */
export interface KernelEventDraft {
  action: string;
  objectKind: 'CLIP' | 'AUDIO_REGION' | 'TRACK';
  objectId: string;
  patch: Record<string, unknown>;
}

export interface KernelChange {
  write: KernelWrite;
  /** null = 只写不记事件（如自动创建的音频轨） */
  event: KernelEventDraft | null;
}

export interface KernelResult {
  changes: KernelChange[];
}

/** 已迁入内核的时间线操作（M1：片段原语 + 精剪）。 */
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
] as const;

/** 操作的主片段（定位所在序列）；insert_clip 由 sequenceId 直接给出，返回 null。 */
export function primaryClipIdOf(operation: KernelTimelineOperation): string | null {
  switch (operation.op) {
    case 'insert_clip':
      return null;
    case 'roll_clip':
      return operation.leftClipId;
    case 'split_av_cut':
      return operation.videoClipId;
    default:
      return operation.clipId;
  }
}
export type KernelTimelineOperationName = (typeof KERNEL_TIMELINE_OPERATIONS)[number];
export type KernelTimelineOperation = Extract<EditOperation, { op: KernelTimelineOperationName }>;

export const isKernelTimelineOperation = (operation: EditOperation): operation is KernelTimelineOperation =>
  (KERNEL_TIMELINE_OPERATIONS as readonly string[]).includes(operation.op);
