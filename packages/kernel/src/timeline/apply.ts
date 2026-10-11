import { WorkingTimeline } from './support.js';
import { deleteClip, duplicateClip, insertClip, moveClip, replaceClipSource, splitClip, trimClip } from './clip-ops.js';
import { rippleClip, rollClip, slideClip, slipClip, splitAvCut } from './refine-ops.js';
import type { KernelContext, KernelResult, KernelTimelineOperation, TimelineState } from './types.js';

/**
 * 在单序列时间线状态上应用一条编辑操作（纯函数：不修改输入状态，不做 I/O）。
 * 失败抛 `ApiFailure`（与服务端统一错误信封同一错误码/原因），成功返回按顺序应用的写入与事件草稿。
 */
export function applyTimelineOperation(state: TimelineState, operation: KernelTimelineOperation, ctx: KernelContext): KernelResult {
  const work = new WorkingTimeline(state);
  switch (operation.op) {
    case 'insert_clip':
      insertClip(work, operation, ctx);
      break;
    case 'delete_clip':
      deleteClip(work, operation);
      break;
    case 'split_clip':
      splitClip(work, operation, ctx);
      break;
    case 'trim_clip':
      trimClip(work, operation);
      break;
    case 'move_clip':
      moveClip(work, operation);
      break;
    case 'duplicate_clip':
      duplicateClip(work, operation, ctx);
      break;
    case 'replace_clip_source':
      replaceClipSource(work, operation);
      break;
    case 'slip_clip':
      slipClip(work, operation);
      break;
    case 'slide_clip':
      slideClip(work, operation);
      break;
    case 'roll_clip':
      rollClip(work, operation);
      break;
    case 'ripple_clip':
      rippleClip(work, operation);
      break;
    case 'split_av_cut':
      splitAvCut(work, operation, ctx);
      break;
  }
  return { changes: work.changes };
}

/** 依次应用写入后的结果状态（供试改、属性测试与客户端乐观预览使用）。 */
export function applyKernelResult(state: TimelineState, result: KernelResult): TimelineState {
  const clips = new Map(state.clips.map((clip) => [clip.id, clip]));
  const tracks = new Map(state.tracks.map((track) => [track.id, track]));
  const audioRegions = new Map(state.audioRegions.map((region) => [region.id, region]));
  for (const { write } of result.changes) {
    if (write.entity === 'clip') {
      if (write.type === 'delete') clips.delete(write.before.id);
      else clips.set(write.after.id, write.after);
    } else if (write.entity === 'track') {
      tracks.set(write.after.id, write.after);
    } else {
      audioRegions.set(write.after.id, write.after);
    }
  }
  return { ...state, clips: [...clips.values()], tracks: [...tracks.values()], audioRegions: [...audioRegions.values()] };
}
