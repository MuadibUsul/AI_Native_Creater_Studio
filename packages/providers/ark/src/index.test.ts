import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ArkHttpError, createSeedance, nearestSeedanceRatio } from './index.js';

/**
 * 火山方舟 Seedance 客户端 × 本地假服务（按方舟公开接口形状回应；不是真实服务验证）：请求形状、Bearer 鉴权、
 * 任务状态映射（排队 / 运行 / 成功 / 失败 / 内容审核拦下）、错误信息不含密钥、成片下载不带密钥。
 */

const KEY = 'ark-test-key-00000000000000'; // secrets:check-ignore：测试专用假密钥（非真实凭据）

interface Recorded { method: string; url: string; headers: IncomingMessage['headers']; body: Record<string, unknown> | null }
let servers: Server[] = [];

async function startFake(handler: (response: ServerResponse, recorded: Recorded) => void): Promise<{ origin: string; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8'); });
    request.on('end', () => {
      const recorded = { method: request.method ?? '', url: request.url ?? '', headers: request.headers, body: raw.length > 0 ? JSON.parse(raw) as Record<string, unknown> : null };
      requests.push(recorded);
      handler(response, recorded);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, requests };
}
const json = (response: ServerResponse, status: number, body: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  servers = [];
});

describe('Seedance 客户端', () => {
  it('画面比例取最接近的一档', () => {
    expect(nearestSeedanceRatio(1920, 1080)).toBe('16:9');
    expect(nearestSeedanceRatio(1080, 1920)).toBe('9:16');
    expect(nearestSeedanceRatio(1080, 1080)).toBe('1:1');
    expect(nearestSeedanceRatio(1080, 1350)).toBe('3:4');
    expect(nearestSeedanceRatio(2560, 1080)).toBe('21:9');
  });

  it('提交 → 轮询（排队 / 运行 / 成功）→ 下载；密钥只在 API 请求头，成片下载不带密钥', async () => {
    const storage = await startFake((response) => { response.writeHead(200, { 'content-type': 'video/mp4' }); response.end(Buffer.from('MP4')); });
    let polls = 0;
    const api = await startFake((response, recorded) => {
      if (recorded.headers.authorization !== `Bearer ${KEY}`) return json(response, 401, { error: { code: 'AuthenticationError', message: 'The API key is invalid' } });
      if (recorded.method === 'POST' && recorded.url === '/api/v3/contents/generations/tasks') return json(response, 200, { id: 'cgt-20261014-abc' });
      if (recorded.url === '/api/v3/contents/generations/tasks/cgt-20261014-abc') {
        polls += 1;
        if (polls === 1) return json(response, 200, { id: 'cgt-20261014-abc', status: 'queued' });
        if (polls === 2) return json(response, 200, { id: 'cgt-20261014-abc', status: 'running' });
        return json(response, 200, { id: 'cgt-20261014-abc', status: 'succeeded', content: { video_url: `${storage.origin}/signed/video.mp4?X-Tos-Signature=abc` }, usage: { completion_tokens: 108_900, total_tokens: 108_900 } });
      }
      return json(response, 404, { error: { code: 'NotFound', message: recorded.url } });
    });
    const seedance = createSeedance({ apiKey: KEY, model: 'doubao-seedance-2-5-260628', baseUrl: `${api.origin}/api/v3` });
    const task = await seedance.start({ prompt: '清晨的山间湖面，薄雾，缓慢推进', durationSeconds: 5, ratio: '16:9', generateAudio: true });
    expect(task).toBe('cgt-20261014-abc');
    expect(api.requests[0]!.body).toEqual({
      model: 'doubao-seedance-2-5-260628',
      content: [{ type: 'text', text: '清晨的山间湖面，薄雾，缓慢推进' }],
      ratio: '16:9', duration: 5, generate_audio: true, watermark: false,
    });
    expect(api.requests[0]!.url).not.toContain(KEY);
    expect(await seedance.poll(task)).toEqual({ done: false, status: 'queued' });
    expect(await seedance.poll(task)).toEqual({ done: false, status: 'running' });
    const done = await seedance.poll(task);
    expect(done).toMatchObject({ done: true, error: null, filtered: null, tokens: 108_900 });
    expect(Buffer.from(await seedance.download((done as { videoUri: string }).videoUri)).toString('ascii')).toBe('MP4');
    expect(storage.requests[0]!.headers.authorization).toBeUndefined();

    await seedance.start({ prompt: 'x', durationSeconds: 10, ratio: '9:16', generateAudio: false, resolution: '480p' });
    expect(api.requests.at(-1)!.body).toMatchObject({ ratio: '9:16', duration: 10, generate_audio: false, resolution: '480p' });
    await expect(seedance.start({ prompt: 'x', durationSeconds: 4.5, ratio: '16:9', generateAudio: true })).rejects.toThrow('whole number of seconds');
  });

  it('失败如实返回：任务失败 / 内容审核拦下 / 取消；提交被拒带状态码与供应商错误码，错误信息不含密钥；任务 id 校验', async () => {
    const api = await startFake((response, recorded) => {
      if (recorded.method === 'POST') return json(response, 429, { error: { code: 'QuotaExceeded', message: 'The request has exceeded the quota.' } });
      if (recorded.url.endsWith('/t-failed')) return json(response, 200, { status: 'failed', error: { code: 'InternalServiceError', message: 'generation failed' } });
      if (recorded.url.endsWith('/t-blocked')) return json(response, 200, { status: 'failed', error: { code: 'OutputVideoSensitiveContentDetected', message: 'The output video may contain sensitive content.' } });
      if (recorded.url.endsWith('/t-cancelled')) return json(response, 200, { status: 'cancelled' });
      return json(response, 404, {});
    });
    const seedance = createSeedance({ apiKey: KEY, model: 'm', baseUrl: `${api.origin}/api/v3` });
    const rejected = await seedance.start({ prompt: 'x', durationSeconds: 5, ratio: '16:9', generateAudio: true }).catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(ArkHttpError);
    expect(rejected).toMatchObject({ status: 429, code: 'QuotaExceeded', message: 'QuotaExceeded: The request has exceeded the quota.' });
    expect(String((rejected as Error).message)).not.toContain(KEY);
    expect(await seedance.poll('t-failed')).toEqual({ done: true, videoUri: null, error: 'InternalServiceError: generation failed', filtered: null, tokens: null });
    expect(await seedance.poll('t-blocked')).toMatchObject({ done: true, videoUri: null, error: null, filtered: 'OutputVideoSensitiveContentDetected: The output video may contain sensitive content.' });
    expect(await seedance.poll('t-cancelled')).toMatchObject({ done: true, videoUri: null, error: 'cancelled' });
    for (const bad of ['../x', 'a/b', 'id?x=1']) await expect(seedance.poll(bad)).rejects.toThrow('unexpected Seedance task id');
    await expect(seedance.download('file:///etc/passwd')).rejects.toThrow('unexpected video link');
  });
});
