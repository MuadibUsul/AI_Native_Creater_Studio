/**
 * 时序映射（P05-04 / 规范 §5.2；计划 §3.3 的 remotion-core）：
 * **预览（Remotion Player）与成片（render-worker）必须共用本模块**，避免两套时序漂移。
 *
 * 纪律（§5.2 原文口径）：
 * - 按**绝对起止边界**统一换算 frame；
 * - Scene 帧数 = 结束帧 − 开始帧（**禁止逐段独立四舍五入后累加**）；
 * - 字幕、动画、音频裁剪使用同一个换算（本模块是唯一入口）。
 */

/** 时序所需的最小场景字段（与完整 Scene DTO 解耦：预览、成片与测试都可传入结构兼容对象）。 */
export interface TimelineSceneInput {
  id: string;
  position: number;
  startMs: number;
  durationMs: number;
}

/** 时序所需的最小图输入（format + timeline + scenes）。 */
export interface TimelineInput {
  format: { fps: number; width: number; height: number; aspectRatio: string };
  timeline: { durationMs: number };
  scenes: readonly TimelineSceneInput[];
}

export interface SceneTiming {
  sceneId: string;
  position: number;
  /** Scene 的绝对起止（毫秒；来自 Scene Graph，权威） */
  startMs: number;
  endMs: number;
  /** 绝对边界换算的帧（整数） */
  startFrame: number;
  endFrame: number;
  /** 帧数 = endFrame − startFrame（可为 0，表示不足一帧的相邻边界） */
  frames: number;
}

export interface VideoTiming {
  fps: number;
  durationMs: number;
  /** 总帧数（按时间轴末端绝对换算；至少 1 帧） */
  durationInFrames: number;
  scenes: SceneTiming[];
}

/** 毫秒 → 绝对帧（四舍五入到最近帧；仅在**绝对边界**使用，绝不做逐段累加）。 */
export const msToFrame = (ms: number, fps: number): number => Math.round((ms * fps) / 1000);

/**
 * 由 Scene Graph 生成时序表。
 * Scene 的 startMs 由 Graph 给出（P02-01 组装时按 position 绝对定位）；本函数**不改写**图数据，
 * 只做换算与一致性校验（gap/overlap 会体现在 frames 上，由调用方/QA 处理）。
 */
export function timelineOf(graph: TimelineInput): VideoTiming {
  const fps = graph.format.fps;
  const scenes: SceneTiming[] = graph.scenes.map((scene) => {
    const startMs = scene.startMs;
    const endMs = scene.startMs + scene.durationMs;
    const startFrame = msToFrame(startMs, fps);
    const endFrame = msToFrame(endMs, fps);
    return { sceneId: scene.id, position: scene.position, startMs, endMs, startFrame, endFrame, frames: endFrame - startFrame };
  });

  // 总时长取时间轴声明与场景末端的较大者（时间轴通常等于总和；以绝对边界换算，不累加分段结果）
  const scenesEndMs = scenes.reduce((max, scene) => Math.max(max, scene.endMs), 0);
  const durationMs = Math.max(graph.timeline.durationMs, scenesEndMs);
  const durationInFrames = Math.max(1, msToFrame(durationMs, fps));

  return { fps, durationMs, durationInFrames, scenes };
}

/** 帧 → 该帧命中的场景（用于 Player 标题/调试；未命中区间返回 null）。 */
export function sceneAtFrame(timing: VideoTiming, frame: number): SceneTiming | null {
  return timing.scenes.find((scene) => frame >= scene.startFrame && frame < scene.endFrame) ?? null;
}

/** 帧 → 组内相对帧（供场景组件动画使用；与 §7 Scene 内动画口径一致）。 */
export function frameWithinScene(scene: SceneTiming, frame: number): number {
  return Math.max(0, Math.min(frame - scene.startFrame, Math.max(0, scene.frames - 1)));
}
