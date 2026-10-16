import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { RUNWAY_API_VERSION, RunwayHttpError, createRunwayAleph, createRunwayHttp, nearestRunwayRatio, runwayOrganization } from './index.js';

/**
 * Runway 客户端 × 本地假服务（按 Runway 公开接口形状回应；不是真实服务验证）：请求形状与版本头、任务状态映射
 * （排队 / 限流排队 / 运行 / 成功 / 失败 / 内容审核拦下 / 取消）、错误信息不含密钥、成片下载不带密钥、连不上 = 请求没发出去。
 */

const KEY = 'key_test_00000000000000000000000000'; // secrets:check-ignore：测试专用假密钥（非真实凭据）

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

describe('Runway 客户端', () => {
  it('比例取最接近的一档（同样接近时取像素多的）', () => {
    expect(nearestRunwayRatio(1920, 1080)).toBe('1280:720');
    expect(nearestRunwayRatio(1080, 1920)).toBe('720:1280');
    expect(nearestRunwayRatio(1080, 1080)).toBe('960:960');
    expect(nearestRunwayRatio(1080, 1350)).toBe('832:1104');
    expect(nearestRunwayRatio(640, 480)).toBe('1104:832');
  });

  it('额度检查与视频转视频：版本头与密钥只在 API 请求头；轮询各状态；成片下载不带密钥', async () => {
    const storage = await startFake((response) => { response.writeHead(200, { 'content-type': 'video/mp4' }); response.end(Buffer.from('MP4')); });
    let polls = 0;
    const api = await startFake((response, recorded) => {
      if (recorded.headers.authorization !== `Bearer ${KEY}` || recorded.headers['x-runway-version'] !== RUNWAY_API_VERSION) return json(response, 401, { error: 'Invalid API key' });
      if (recorded.url === '/v1/organization') return json(response, 200, { creditBalance: 1234, tier: { maxMonthlyCreditSpend: 10_000 } });
      if (recorded.method === 'POST' && recorded.url === '/v1/video_to_video') return json(response, 200, { id: '17f20503-6c24-4c16-946b-35dbbce2af2f' });
      if (recorded.url === '/v1/tasks/17f20503-6c24-4c16-946b-35dbbce2af2f') {
        polls += 1;
        const states = ['PENDING', 'THROTTLED', 'RUNNING'];
        if (polls <= states.length) return json(response, 200, { id: 'x', status: states[polls - 1], progress: polls / 4 });
        return json(response, 200, { id: 'x', status: 'SUCCEEDED', output: [`${storage.origin}/out/video.mp4?sig=abc`] });
      }
      return json(response, 404, { error: `not found ${recorded.url}` });
    });
    const base = `${api.origin}/v1`;
    expect(await runwayOrganization(createRunwayHttp({ apiKey: KEY, baseUrl: base }))).toEqual({ creditBalance: 1234 });
    const aleph = createRunwayAleph({ apiKey: KEY, baseUrl: base });
    expect(aleph.model).toBe('gen4_aleph');
    const task = await aleph.start({ promptText: 'turn the sky into a warm sunset', videoUri: 'data:video/mp4;base64,AAAA', ratio: '1280:720' });
    expect(api.requests.find((item) => item.url === '/v1/video_to_video')!.body).toEqual({ model: 'gen4_aleph', videoUri: 'data:video/mp4;base64,AAAA', promptText: 'turn the sky into a warm sunset', ratio: '1280:720' });
    for (const status of ['PENDING', 'THROTTLED', 'RUNNING']) expect(await aleph.poll(task)).toEqual({ done: false, status });
    const done = await aleph.poll(task);
    expect(done).toMatchObject({ done: true, error: null, filtered: null });
    expect(Buffer.from(await aleph.download((done as { videoUri: string }).videoUri)).toString('ascii')).toBe('MP4');
    expect(storage.requests[0]!.headers.authorization).toBeUndefined();
    expect(api.requests.every((item) => !item.url.includes(KEY))).toBe(true);
  });

  it('失败如实返回：提交被拒（状态码 + 供应商原因，不含密钥）、任务失败、内容审核拦下、取消；任务 id 校验；连不上 = 请求没发出去', async () => {
    const api = await startFake((response, recorded) => {
      if (recorded.method === 'POST') return json(response, 400, { error: 'Validation of body failed', issues: [{ path: ['ratio'] }] });
      if (recorded.url.endsWith('/t-failed')) return json(response, 200, { status: 'FAILED', failure: 'An unexpected error occurred.', failureCode: 'INTERNAL.BAD_OUTPUT.CODE01' });
      if (recorded.url.endsWith('/t-safety')) return json(response, 200, { status: 'FAILED', failure: 'Your input was flagged by our content moderation.', failureCode: 'SAFETY.INPUT.TEXT' });
      if (recorded.url.endsWith('/t-cancelled')) return json(response, 200, { status: 'CANCELLED' });
      return json(response, 404, {});
    });
    const aleph = createRunwayAleph({ apiKey: KEY, baseUrl: `${api.origin}/v1` });
    const rejected = await aleph.start({ promptText: 'x', videoUri: 'data:video/mp4;base64,AAAA', ratio: '1280:720' }).catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(RunwayHttpError);
    expect(rejected).toMatchObject({ status: 400, message: 'Validation of body failed', neverSent: false });
    expect(String((rejected as Error).message)).not.toContain(KEY);
    expect(await aleph.poll('t-failed')).toEqual({ done: true, videoUri: null, error: 'INTERNAL.BAD_OUTPUT.CODE01: An unexpected error occurred.', filtered: null });
    expect(await aleph.poll('t-safety')).toEqual({ done: true, videoUri: null, error: null, filtered: 'SAFETY.INPUT.TEXT: Your input was flagged by our content moderation.' });
    expect(await aleph.poll('t-cancelled')).toMatchObject({ done: true, videoUri: null, error: 'CANCELLED' });
    for (const bad of ['../x', 'a/b', 'id?x=1']) await expect(aleph.poll(bad)).rejects.toThrow('unexpected Runway task id');

    const closed = createServer();
    const port = await new Promise<number>((resolve) => closed.listen(0, '127.0.0.1', () => resolve((closed.address() as AddressInfo).port)));
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const unreachable = await createRunwayAleph({ apiKey: KEY, baseUrl: `http://127.0.0.1:${String(port)}/v1` }).start({ promptText: 'x', videoUri: 'data:,', ratio: '1280:720' }).catch((error: unknown) => error);
    expect(unreachable).toMatchObject({ status: null, neverSent: true });
    expect(String((unreachable as Error).message)).toContain('the request was never sent');
  });
});
