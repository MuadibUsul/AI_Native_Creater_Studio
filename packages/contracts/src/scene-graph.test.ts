import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sceneGraphSchema, STANDARD_SCENE_TYPES } from './index.js';

const samplePath = join(import.meta.dirname, '..', 'fixtures', 'scene-graph.sample.json');
const raw: unknown = JSON.parse(readFileSync(samplePath, 'utf8'));

describe('SceneGraph 契约（fixtures/scene-graph.sample.json）', () => {
  it('样例通过结构校验且符合 V1 默认格式', () => {
    const graph = sceneGraphSchema.parse(raw);
    expect(graph.format).toEqual({ width: 1920, height: 1080, fps: 30, aspectRatio: '16:9' });
    expect(graph.scenes).toHaveLength(13);
    expect(graph.schemaVersion).toBe('0.1');
  });

  it('往返无损：parse → JSON → parse 为标准不动点', () => {
    const once = sceneGraphSchema.parse(raw);
    const twice = sceneGraphSchema.parse(JSON.parse(JSON.stringify(once)) as unknown);
    expect(twice).toEqual(once);
  });

  it('领域不变量：position 连续、时间线相接、末端不越过 timeline.durationMs', () => {
    const graph = sceneGraphSchema.parse(raw);
    graph.scenes.forEach((scene, index) => {
      expect(scene.position, `scn position ${String(index)}`).toBe(index);
    });
    for (let i = 1; i < graph.scenes.length; i += 1) {
      const prev = graph.scenes[i - 1];
      const current = graph.scenes[i];
      expect(prev).toBeDefined();
      expect(current).toBeDefined();
      expect(current?.startMs).toBe((prev?.startMs ?? 0) + (prev?.durationMs ?? 0));
    }
    const last = graph.scenes.at(-1);
    expect(last).toBeDefined();
    expect((last?.startMs ?? 0) + (last?.durationMs ?? 0)).toBeLessThanOrEqual(graph.timeline.durationMs);
  });

  it('场景类型落在 DEC-04 标准清单或两类外部场景内', () => {
    const graph = sceneGraphSchema.parse(raw);
    const allowed = new Set<string>([...STANDARD_SCENE_TYPES, 'AI_VIDEO', 'CUSTOM_MOTION']);
    for (const scene of graph.scenes) {
      expect(allowed.has(scene.sceneType), `sceneType ${scene.sceneType}`).toBe(true);
    }
  });

  it('非法值被拒：缺失 schemaVersion / 负 duration / 非法状态 / revision 为 0', () => {
    const graph = sceneGraphSchema.parse(raw);
    const first = graph.scenes[0];
    expect(first).toBeDefined();

    const { schemaVersion: _omitted, ...withoutVersion } = graph;
    expect(sceneGraphSchema.safeParse(withoutVersion).success).toBe(false);
    expect(
      sceneGraphSchema.safeParse({ ...graph, scenes: [{ ...first, durationMs: -1 }] }).success,
    ).toBe(false);
    expect(
      sceneGraphSchema.safeParse({ ...graph, scenes: [{ ...first, status: 'DONE' }] }).success,
    ).toBe(false);
    expect(sceneGraphSchema.safeParse({ ...graph, projectRevision: 0 }).success).toBe(false);
    expect(
      sceneGraphSchema.safeParse({ ...graph, scenes: [{ ...first, startMs: 1.5 }] }).success,
    ).toBe(false);
  });
});
