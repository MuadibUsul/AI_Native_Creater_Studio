// 进程内共看片室环境（验收与评测脚本共用）：隔离测试库 + Fastify API + 进程内 Worker（与生产装配同一组处理器：
// 真实 FFmpeg 探测/代理/索引/预览/终渲染）+ 一个把 /api/v1 转给 API、其余转给 Web 的本地代理。
// 外部能力（导演模型、语音识别、视觉理解）由调用方传入；不传即"未配置"，相应任务如实失败。
import { randomBytes } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, resolveTestDatabaseUrl, runMigrations } from '../../packages/db/dist/index.js';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG } from '../../packages/auth/dist/index.js';
import { WorkflowRegistry, agentTurnWorkflow, claimJob, compositionFinalRenderWorkflow, runMaintenanceTick } from '../../packages/domain/dist/index.js';
import { buildServer } from '../../apps/api/dist/server.js';
import { createStorageDeps } from '../../apps/api/dist/plugins/storage.js';
import { createDefaultRegistry } from '../../apps/worker/dist/handlers.js';
import { executeJob } from '../../apps/worker/dist/runner.js';
import { createFfmpegSourceMediaProbe } from '../../apps/worker/dist/source-media-probe-process.js';
import { createFfmpegMediaProxyTranscoder } from '../../apps/worker/dist/source-media-transcoder-process.js';
import { createFfmpegMediaIndexer } from '../../apps/worker/dist/source-media-indexer-process.js';
import { createFfmpegRenderPlanExecutor } from '../../apps/worker/dist/render-plan/ffmpeg-executor.js';
import { createStorageFrameSampler } from '../../apps/worker/dist/frame-sampler-process.js';
import { LocalObjectStorage } from '../../packages/providers/storage-local/dist/index.js';
import { createClient } from '../../packages/sdk/dist/index.js';
import { createDeepgramLiveRecognizer, createRealtimeGateway, startFakeDeepgramLive } from '../../apps/realtime/dist/index.js';

/**
 * @param {{ director: object, speechRecognitionAdapter?: object, mediaVisualAnalysisAdapter?: object, webPort?: number, workDirPrefix?: string,
 *   voice?: { script: (query: URLSearchParams) => { atSeconds: number, message: object }[] } }} options
 *   voice：启动 Realtime Gateway；流式识别用**本地同协议假服务**（真实 Deepgram 适配器连假服务，标为 SCRIPTED）。
 */
export async function startStudioEnv(options) {
  const db = createDb(resolveTestDatabaseUrl());
  await runMigrations(db);
  const workDir = await mkdtemp(join(tmpdir(), options.workDirPrefix ?? 'ancs-studio-env-'));
  let apiPort = 0;
  const webPort = options.webPort ?? null;
  const proxy = createServer((incoming, outgoing) => {
    const toApi = incoming.url?.startsWith('/api/v1/') ?? false;
    if (!toApi && webPort === null) { outgoing.writeHead(404); outgoing.end(); return; }
    const upstream = httpRequest({ hostname: '127.0.0.1', port: toApi ? apiPort : webPort, method: incoming.method, path: incoming.url, headers: incoming.headers }, (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    });
    upstream.on('error', (error) => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(`upstream failed: ${error.message}`); });
    incoming.pipe(upstream);
  });
  const proxyPort = await new Promise((done, fail) => { proxy.once('error', fail); proxy.listen(0, '127.0.0.1', () => done(proxy.address().port)); });
  const baseUrl = `http://127.0.0.1:${String(proxyPort)}`;
  const auth = createAuth({ db: db.db, secret: randomBytes(32).toString('hex'), baseUrl });
  const storage = new LocalObjectStorage({ rootDir: join(workDir, 'storage'), publicBaseUrl: baseUrl, signingSecret: randomBytes(32).toString('hex') });
  const voiceSecret = randomBytes(32).toString('hex');
  const app = await buildServer({ auth: { auth, db: db.db, tokens: { db: db.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } }, storage: createStorageDeps(storage), voice: { sessionSecret: voiceSecret } });

  // V6-2：Realtime Gateway（独立 HTTP 服务器）+ 代理转发 /realtime/ 的 WebSocket 升级
  let realtime = null;
  if (options.voice !== undefined) {
    const apiKey = randomBytes(16).toString('hex');
    const fakeAsr = await startFakeDeepgramLive({ apiKey, script: options.voice.script });
    const recognizer = { ...createDeepgramLiveRecognizer({ apiKey, baseUrl: fakeAsr.url }), providerId: 'deepgram-local-fake', implementation: 'SCRIPTED' };
    const gateway = createRealtimeGateway({ deps: { db: db.db, voiceSessionSecret: voiceSecret }, recognizer, allowedOrigins: [baseUrl] });
    const server = createServer((_request, response) => { response.writeHead(404); response.end(); });
    gateway.attach(server, { exclusive: true });
    const port = await new Promise((done) => server.listen(0, '127.0.0.1', () => done(server.address().port)));
    realtime = { gateway, server, port, fakeAsr };
  }
  proxy.on('upgrade', (incoming, socket, head) => {
    if (realtime === null || !incoming.url?.startsWith('/realtime/')) { socket.destroy(); return; }
    const upstream = netConnect(realtime.port, '127.0.0.1', () => {
      const lines = [`${incoming.method} ${incoming.url} HTTP/${incoming.httpVersion}`];
      for (let index = 0; index < incoming.rawHeaders.length; index += 2) lines.push(`${incoming.rawHeaders[index]}: ${incoming.rawHeaders[index + 1]}`);
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  apiPort = app.server.address().port;

  const probe = createFfmpegSourceMediaProbe();
  const workflowRegistry = new WorkflowRegistry()
    .register(compositionFinalRenderWorkflow({ executor: createFfmpegRenderPlanExecutor(), outputProbe: probe }))
    .register(agentTurnWorkflow({ model: options.director, frames: createStorageFrameSampler({ storage }) }));
  const registry = createDefaultRegistry({
    sourceMediaProbe: probe,
    sourceMediaTranscoder: createFfmpegMediaProxyTranscoder(),
    sourceMediaIndexer: createFfmpegMediaIndexer(),
    ...(options.speechRecognitionAdapter === undefined ? {} : { speechRecognitionAdapter: options.speechRecognitionAdapter }),
    ...(options.mediaVisualAnalysisAdapter === undefined ? {} : { mediaVisualAnalysisAdapter: options.mediaVisualAnalysisAdapter }),
    workflowRegistry,
    previewExecutor: { executor: createFfmpegRenderPlanExecutor() },
  });
  const deps = { db: db.db, storage, retention: {} };
  let stopping = false;
  const workerLoop = (async () => {
    while (!stopping) {
      await runMaintenanceTick(deps, { limit: 50 }).catch(() => undefined);
      const job = await claimJob(deps, { workerId: 'studio-env', leaseSeconds: 300, types: registry.types() });
      if (job === null) { await new Promise((done) => setTimeout(done, 250)); continue; }
      await executeJob(deps, registry, { workerId: 'studio-env', leaseSeconds: 300, heartbeatIntervalMs: 20_000 }, job);
    }
  })();

  return {
    baseUrl,
    db,
    deps,
    workDir,
    /** 语音：本地假识别服务的连接记录（查询参数、音频字节数等） */
    voiceAsrConnections: realtime?.fakeAsr.connections ?? [],
    /** 新建内部用户并返回已登录的 SDK 客户端 */
    async signedInClient(email) {
      const password = randomBytes(24).toString('base64url');
      await createInternalUser(auth, { email, password, name: 'Studio Env' });
      const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
      await client.auth.signIn({ email, password });
      return { client, password };
    },
    async createUser(email) {
      const password = randomBytes(24).toString('base64url');
      await createInternalUser(auth, { email, password, name: 'Studio Check' });
      return password;
    },
    async close() {
      stopping = true;
      await workerLoop.catch(() => undefined);
      await app.close().catch(() => undefined);
      if (realtime !== null) {
        await realtime.gateway.close().catch(() => undefined);
        await new Promise((done) => realtime.server.close(done));
        await realtime.fakeAsr.close().catch(() => undefined);
      }
      await new Promise((done) => proxy.close(done));
      await db.close();
      await rm(workDir, { recursive: true, force: true });
    },
  };
}

/** 轮询直到条件成立（超时抛错，附带最后一次读到的值）。 */
export async function waitFor(read, done, { timeoutMs = 120_000, intervalMs = 500, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await read();
    if (done(last)) return last;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last).slice(0, 400)}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
