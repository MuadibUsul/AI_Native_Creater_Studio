import { describe, expect, it } from 'vitest';
import { frameWithinScene, msToFrame, sceneAtFrame, timelineOf } from './timeline.js';

/**
 * P05-04 单元验收（规范 §5.2）：毫秒 → frame 按**绝对边界**换算；Scene 帧数 = 结束帧 − 开始帧；
 * **10 分钟样例不得出现累计漂移**（禁止逐段四舍五入累加）。
 */

const graphOf = (sceneDurations: number[], fps = 30, widthMs?: number) => {
  let cursor = 0;
  const scenes = sceneDurations.map((durationMs, index) => {
    const scene = {
      id: `scn_${String(index)}`,
      revision: 1,
      position: index,
      startMs: cursor,
      durationMs,
      semanticType: 'HOST_STATEMENT',
      sceneType: 'HOST_FULL',
      narrationBlockIds: [],
      narration: '',
      visualIntent: '',
      componentId: null,
      componentVersion: null,
      props: {},
      providerRequirement: null,
      sourceBindings: [],
      dataBindings: [],
      assetBindings: [],
      transition: { in: null, out: null },
      locked: false,
      approved: false,
      needsReview: false,
      status: 'DRAFT' as const,
    };
    cursor += durationMs;
    return scene;
  });
  return {
    format: { width: 1920, height: 1080, fps, aspectRatio: '16:9' as const },
    timeline: { durationMs: widthMs ?? cursor },
    scenes,
  };
};

describe('timelineOf（绝对边界换算）', () => {
  it('scene 帧数 = 结束帧 − 开始帧；相邻场景边界无缝隙', () => {
    const timing = timelineOf(graphOf([4000, 3000, 5000], 30));
    expect(timing.scenes.map((scene) => [scene.startFrame, scene.endFrame, scene.frames])).toEqual([
      [0, 120, 120],
      [120, 210, 90],
      [210, 360, 150],
    ]);
    // 无缝隙：前一场景的结束帧 = 后一场景的开始帧
    for (let index = 1; index < timing.scenes.length; index += 1) {
      expect(timing.scenes[index]?.startFrame).toBe(timing.scenes[index - 1]?.endFrame);
    }
  });

  it('10 分钟样例无累计漂移（非整帧时长也不漂移）', () => {
    // 600 个 1000ms 场景 + 3 个 1ms 尾部片段；总帧数必须按绝对边界换算
    const durations = [...Array.from({ length: 600 }, () => 1000), 1, 1, 1];
    const timing = timelineOf(graphOf(durations, 30));
    const totalMs = 600_000 + 3;
    expect(timing.durationMs).toBe(totalMs);
    expect(timing.durationInFrames).toBe(msToFrame(totalMs, 30)); // 18000（1ms 不累加成额外帧）
    const lastScene = timing.scenes[timing.scenes.length - 1];
    expect(lastScene?.endFrame).toBe(msToFrame(totalMs, 30));
  });

  it('明确排除"逐段独立四舍五入后累加"的错误口径（每段 20ms @30fps）', () => {
    // 300 × 20ms = 6000ms → 绝对边界 = 180 帧；逐段 round(0.6)=1 累加会得到 300（漂移 +120）
    const durations = Array.from({ length: 300 }, () => 20);
    const timing = timelineOf(graphOf(durations, 30));
    expect(timing.durationInFrames).toBe(180);
    const naive = durations.reduce((sum, duration) => sum + Math.round((duration * 30) / 1000), 0);
    expect(naive).toBe(300);
    expect(naive).toBeGreaterThan(timing.durationInFrames);
    // 场景级同样按绝对边界：第 10 段（200ms 起）开始的绝对帧 = 6
    expect(timing.scenes[10]?.startFrame).toBe(6);
  });

  it('不足一帧的极短场景：frames 可为 0（不伪造帧）', () => {
    const timing = timelineOf(graphOf([10, 20], 30)); // 10ms = 0.3 帧 → 0 帧
    expect(timing.scenes[0]?.frames).toBe(0);
    expect(timing.scenes[1]?.frames).toBe(1);
  });

  it('sceneAtFrame / frameWithinScene：命中区间与组内相对帧正确', () => {
    const timing = timelineOf(graphOf([1000, 2000], 30));
    expect(sceneAtFrame(timing, 0)?.sceneId).toBe('scn_0');
    expect(sceneAtFrame(timing, 29)?.sceneId).toBe('scn_0');
    expect(sceneAtFrame(timing, 30)?.sceneId).toBe('scn_1');
    expect(sceneAtFrame(timing, 90)).toBeNull();
    const second = timing.scenes[1];
    expect(second).toBeDefined();
    if (second !== undefined) {
      expect(frameWithinScene(second, 45)).toBe(15);
      expect(frameWithinScene(second, 30)).toBe(0);
      expect(frameWithinScene(second, 10_000)).toBe(second.frames - 1);
    }
  });
});
