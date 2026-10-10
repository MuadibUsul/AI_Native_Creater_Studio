import type { TimelineProjection } from '@ancs/contracts';
import type { TimelineBandLane } from './TimelineBand';

/**
 * N04-04（主体）：把 `projectSequenceToTimeline` 的权威投影适配成 `TimelineBand` 的渲染车道。
 *
 * 只做**形状映射**，不重算几何：像素位置由组件按同一个有理时基换算（同一 viewport），
 * 因此"投影算出来的被裁剪/可见性"与"组件渲染出来的像素"不会各算一套。
 * 轨道 label 缺省时用轨道名；片段 label 缺省时用片段 id。
 */
export function projectionToBandLanes(projection: TimelineProjection): TimelineBandLane[] {
  return projection.lanes.map((lane) => ({
    id: lane.trackId,
    label: lane.name === '' ? lane.trackId : lane.name,
    kind: lane.kind,
    clips: lane.segments.map((segment) => ({
      id: segment.clipId,
      label: segment.label === '' ? segment.clipId : segment.label,
      range: segment.sequenceRange,
    })),
  }));
}
