import { WorkingTimeline } from './support.js';
import { deleteClip, duplicateClip, insertClip, moveClip, replaceClipSource, splitClip, trimClip } from './clip-ops.js';
import { rippleClip, rollClip, slideClip, slipClip, splitAvCut } from './refine-ops.js';
import { createTrack, deleteTrack, moveTrack, setAvLink, setClipParameters, setSequenceDuration, updateClip, updateTrack } from './structure-ops.js';
import {
  applyAudioCrossfade,
  createCaption,
  cutCaptionRange,
  deleteCaption,
  splitCaption,
  updateAudioRegion,
  updateCaption,
} from './caption-audio-ops.js';
import type { KernelContext, KernelResult, KernelTimelineOperation, TimelineState } from './types.js';

/**
 * 在项目时间线状态上应用一条编辑操作（纯函数：不修改输入状态，不做 I/O）。
 * 失败抛 `ApiFailure`（与服务端统一错误信封同一错误码/原因），成功返回有序写入与事件草稿。
 */
export function applyTimelineOperation(state: TimelineState, operation: KernelTimelineOperation, ctx: KernelContext): KernelResult {
  const work = new WorkingTimeline(state);
  switch (operation.op) {
    case 'insert_clip': insertClip(work, operation, ctx); break;
    case 'delete_clip': deleteClip(work, operation); break;
    case 'split_clip': splitClip(work, operation, ctx); break;
    case 'trim_clip': trimClip(work, operation); break;
    case 'move_clip': moveClip(work, operation); break;
    case 'duplicate_clip': duplicateClip(work, operation, ctx); break;
    case 'replace_clip_source': replaceClipSource(work, operation); break;
    case 'slip_clip': slipClip(work, operation); break;
    case 'slide_clip': slideClip(work, operation); break;
    case 'roll_clip': rollClip(work, operation); break;
    case 'ripple_clip': rippleClip(work, operation); break;
    case 'split_av_cut': splitAvCut(work, operation, ctx); break;
    case 'create_track': createTrack(work, operation, ctx); break;
    case 'move_track': moveTrack(work, operation); break;
    case 'delete_track': deleteTrack(work, operation); break;
    case 'update_track': updateTrack(work, operation); break;
    case 'set_sequence_duration': setSequenceDuration(work, operation); break;
    case 'set_clip_transform':
    case 'set_clip_crop':
    case 'set_clip_opacity': setClipParameters(work, operation); break;
    case 'set_av_link': setAvLink(work, operation, ctx); break;
    case 'update_clip': updateClip(work, operation); break;
    case 'create_caption': createCaption(work, operation, ctx); break;
    case 'update_caption': updateCaption(work, operation); break;
    case 'split_caption': splitCaption(work, operation, ctx); break;
    case 'cut_caption_range': cutCaptionRange(work, operation, ctx); break;
    case 'delete_caption': deleteCaption(work, operation); break;
    case 'apply_audio_crossfade': applyAudioCrossfade(work, operation); break;
    case 'update_audio_region': updateAudioRegion(work, operation, ctx); break;
  }
  return work.result();
}

/** 依次应用写入后的结果状态（供试改、属性测试与客户端乐观预览使用）。 */
export function applyKernelResult(state: TimelineState, result: KernelResult): TimelineState {
  const maps = {
    sequence: new Map(state.sequences),
    clip: new Map(state.clips.map((item) => [item.id, item])),
    track: new Map(state.tracks.map((item) => [item.id, item])),
    audioRegion: new Map(state.audioRegions.map((item) => [item.id, item])),
    caption: new Map(state.captions.map((item) => [item.id, item])),
  } as const;
  for (const write of result.writes) {
    if (write.type === 'delete') {
      maps[write.before.entity].delete(write.before.value.id);
    } else {
      (maps[write.after.entity] as Map<string, typeof write.after.value>).set(write.after.value.id, write.after.value);
    }
  }
  return {
    ...state,
    sequences: maps.sequence,
    clips: [...maps.clip.values()],
    tracks: [...maps.track.values()],
    audioRegions: [...maps.audioRegion.values()],
    captions: [...maps.caption.values()],
  };
}
