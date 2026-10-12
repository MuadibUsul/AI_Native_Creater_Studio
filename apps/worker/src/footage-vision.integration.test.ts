import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentModelAdapter, AgentModelRequest, AgentModelResponse } from '@ancs/contracts';
import { LocalObjectStorage } from '@ancs/providers-storage-local';
import { createStorageFrameSampler, extractJpegFrame } from './frame-sampler-process.js';
import { VISUAL_DESCRIPTION_PROMPT, createModelVisualAnalysisAdapter } from './model-visual-analysis.js';

/**
 * V6-1b（真实 FFmpeg；视觉模型为脚本模型，不是真实 Provider）：
 * - 抽帧：存储对象流式物化后按时间取 JPEG，宽度不超过上限，最后一帧之后明确失败；同一源文件缓存复用；
 * - 视觉理解：按时长均匀取样、分批带图交给模型、解析逐帧说明写成 VISUAL_EVENT；坏批次重试一次，仍坏则失败。
 */

let workRoot: string;
let sourcePath: string;
let storage: LocalObjectStorage;
const storageKey = 'footage/vision-test.mp4';

beforeAll(async () => {
  workRoot = await mkdtemp(join(tmpdir(), 'ancs-vision-it-'));
  sourcePath = join(workRoot, 'source.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=5', '-pix_fmt', 'yuv420p', '-y', sourcePath]);
  storage = new LocalObjectStorage({ rootDir: join(workRoot, 'storage'), publicBaseUrl: 'http://127.0.0.1:1', signingSecret: `vision-it-${randomUUID()}` }); // secrets:check-ignore: test-only dummy
  await storage.putObject(storageKey, new Uint8Array(await readFile(sourcePath)));
});

afterAll(async () => { await rm(workRoot, { recursive: true, force: true }); });

const widthOf = async (image: { data: string }): Promise<number> => {
  const path = join(workRoot, `${randomUUID()}.jpg`);
  await writeFile(path, Buffer.from(image.data, 'base64'));
  return Number(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width', '-of', 'csv=p=0', path]).toString('utf8').trim());
};

describe('素材抽帧（真实 FFmpeg）', () => {
  it('按时间取 JPEG、宽度不超过上限、缓存复用源文件；越过素材末尾明确失败', async () => {
    let materialized = 0;
    const counting = new Proxy(storage, {
      get(target, property, receiver) {
        if (property === 'materializeObject') return async (input: { key: string; destinationPath: string }) => { materialized += 1; await target.materializeObject(input); };
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const sampler = createStorageFrameSampler({ storage: counting });
    try {
      const first = await sampler.sample({ storageKey, times: ['0.5', '2.25'], maxWidth: 512 });
      expect(first).toHaveLength(2);
      expect(first.every((image) => image.mediaType === 'image/jpeg' && Buffer.from(image.data, 'base64').subarray(0, 2).equals(Buffer.from([0xff, 0xd8])))).toBe(true);
      expect(await widthOf(first[0]!)).toBe(512);
      // 不同时间点的画面不同（testsrc2 随时间变化）
      expect(first[0]!.data).not.toBe(first[1]!.data);
      await sampler.sample({ storageKey, times: ['4.9'], maxWidth: 2000 });
      expect(materialized).toBe(1);
      await expect(sampler.sample({ storageKey, times: ['30'], maxWidth: 512 })).rejects.toThrow(/no frame decoded/);
      await expect(sampler.sample({ storageKey, times: ['-1'], maxWidth: 512 })).rejects.toThrow(/invalid frame time/);
    } finally {
      await sampler.close();
    }
    // 小图不放大
    expect(await widthOf(await extractJpegFrame({ sourcePath, at: '1', maxWidth: 4000 }))).toBe(1280);
  });
});

function scriptedVision(handler: (request: AgentModelRequest, call: number) => string): AgentModelAdapter & { requests: AgentModelRequest[] } {
  const requests: AgentModelRequest[] = [];
  return {
    providerId: 'scripted', implementation: 'SCRIPTED', model: 'scripted-vision', requests,
    respond: (request) => {
      requests.push(request);
      const response: AgentModelResponse = { model: 'scripted-vision', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, content: [{ type: 'text', text: handler(request, requests.length - 1) }] };
      return Promise.resolve(response);
    },
  };
}

const framesIn = (request: AgentModelRequest): number => request.messages[0]!.content.filter((block) => block.type === 'image').length;

describe('视觉理解分析器（真实 FFmpeg + 脚本视觉模型）', () => {
  it('按时长均匀取样、分批带图、逐帧说明写成 VISUAL_EVENT（覆盖取样间隔）', async () => {
    const model = scriptedVision((request) => JSON.stringify(Array.from({ length: framesIn(request) }, (_, frame) => ({ frame, description: `  wide shot   of test pattern ${String(frame)} ` }))));
    const adapter = createModelVisualAnalysisAdapter({ model, minIntervalMs: 1000, batchSize: 2 });
    const result = await adapter.analyze({ sourcePath });
    expect(result.durationMs).toBe(5000);
    expect(result.sampledFrameCount).toBe(5);
    expect(model.requests.map(framesIn)).toEqual([2, 2, 1]);
    expect(model.requests[0]!.system).toBe(VISUAL_DESCRIPTION_PROMPT);
    expect(model.requests[0]!.effort).toBe('low');
    expect(result.visualEvents.map((event) => [event.sourceStartPts, event.sourceEndPts, event.label])).toEqual([
      ['0', '1000', 'wide shot of test pattern 0'],
      ['1000', '2000', 'wide shot of test pattern 1'],
      ['2000', '3000', 'wide shot of test pattern 0'],
      ['3000', '4000', 'wide shot of test pattern 1'],
      ['4000', '5000', 'wide shot of test pattern 0'],
    ]);
    expect(result).toMatchObject({ adapter: 'model:scripted', modelVersion: 'scripted-vision', objectTracks: [], personTracks: [] });
  });

  it('坏批次重试一次后成功；连续两次不可用则整次失败（不悄悄缺数据）', async () => {
    const flaky = scriptedVision((request, call) => (call === 0 ? 'sorry, here you go: not json' : JSON.stringify(Array.from({ length: framesIn(request) }, (_, frame) => ({ frame, description: 'ok' })))));
    const recovered = await createModelVisualAnalysisAdapter({ model: flaky, minIntervalMs: 2500, batchSize: 4 }).analyze({ sourcePath });
    expect(recovered.visualEvents).toHaveLength(2);
    expect(flaky.requests).toHaveLength(2);

    const broken = scriptedVision((request) => JSON.stringify([{ frame: 0, description: 'only one' }].slice(0, framesIn(request) - 1)));
    await expect(createModelVisualAnalysisAdapter({ model: broken, minIntervalMs: 2500, batchSize: 4 }).analyze({ sourcePath })).rejects.toThrow(/unusable description batch/);
    expect(broken.requests).toHaveLength(2);
  });
});
