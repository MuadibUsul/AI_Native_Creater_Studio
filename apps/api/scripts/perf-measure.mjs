#!/usr/bin/env node
/**
 * 性能测量主体（P08-04；在 apps/api 上下文运行以解析 @ancs/sdk 与 @ancs/auth）。
 *
 * 输入（env）：PERF_BASE_URL、PERF_PROJECTS、PERF_SCENES、PERF_ITERATIONS、DATABASE_URL
 * 输出（stdout 最后一行 JSON）：{ environment, seed, results, targets }
 * 说明：会话经 createInternalUser + SDK sign-in（与集成测试同一路径）；全部为真实 HTTP 调用。
 */
import { cpus, platform } from 'node:os';
import { createClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG } from '@ancs/auth';
import { createDb } from '@ancs/db';
import { randomUUID } from 'node:crypto';

const baseUrl = process.env['PERF_BASE_URL'];
const databaseUrl = process.env['DATABASE_URL'];
const projects = Number(process.env['PERF_PROJECTS'] ?? '10');
const scenesPerProject = Number(process.env['PERF_SCENES'] ?? '4');
const iterations = Number(process.env['PERF_ITERATIONS'] ?? '30');
if (baseUrl === undefined || databaseUrl === undefined) {
  console.error('需要 PERF_BASE_URL 与 DATABASE_URL');
  process.exit(1);
}

const handle = createDb(databaseUrl);
const auth = createAuth({ db: handle.db, secret: process.env['BETTER_AUTH_SECRET'], baseUrl });
const email = `perf-${randomUUID()}@test.local`;
const password = 'perf-password-1234'; // secrets:check-ignore：基线专用假密钥（临时库）
await createInternalUser(auth, { email, password, name: 'perf' });
const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
await client.auth.signIn({ email, password });
void DEFAULT_NATIVE_TOKEN_CONFIG;

// 种子
const workspace = await client.workspaces.create({ name: `性能-${randomUUID().slice(0, 6)}` });
const channel = await client.channels.create(workspace.id, { name: '性能栏目' });
const projectIds = [];
for (let index = 0; index < projects; index += 1) {
  const project = await client.projects.create(workspace.id, { title: `性能项目 ${String(index)}`, channelId: channel.id });
  projectIds.push(project.id);
  for (let sceneIndex = 0; sceneIndex < scenesPerProject; sceneIndex += 1) {
    await client.projects.addScene(project.id, {
      sceneType: 'CHAPTER_TITLE',
      semanticType: 'CONCEPT',
      narration: `场景 ${String(sceneIndex)}`,
      durationMs: 3000,
      props: { title: `章节 ${String(sceneIndex)}` },
      idempotencyKey: `perf_s_${String(index)}_${String(sceneIndex)}`,
    });
  }
}

const measure = async (name, run) => {
  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = process.hrtime.bigint();
    await run(index);
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  samples.sort((left, right) => left - right);
  const p = (quantile) => samples[Math.min(samples.length - 1, Math.floor(quantile * samples.length))];
  return { endpoint: name, iterations: samples.length, p50Ms: Number(p(0.5).toFixed(2)), p95Ms: Number(p(0.95).toFixed(2)), maxMs: Number(samples.at(-1).toFixed(2)) };
};

const results = [];
results.push(await measure('GET /health', async () => { await client.auth.session().catch(() => undefined); }));
results.push(await measure('GET /workspaces/:id/projects（列表）', async () => { await client.projects.list(workspace.id); }));
const graphTarget = projectIds[0];
results.push(await measure('GET /projects/:id/graph（场景图加载）', async () => { await client.projects.graph(graphTarget); }));

const patch = await measure('POST /projects/:id/edits（update_scene；服务端口径）', async (index) => {
  const graph = await client.projects.graph(graphTarget);
  const scene = graph.scenes[0];
  await client.projects.edit(graphTarget, {
    baseProjectRevision: graph.projectRevision,
    expectedSceneRevisions: { [scene.id]: scene.revision },
    operations: [{ op: 'update_scene', sceneId: scene.id, changes: { durationMs: 3000 + ((index % 50) + 1) } }],
    idempotencyKey: `perf_p_${String(index)}`,
    intent: '性能基线：场景微调',
  });
});
results.push(patch);

results.push(
  await measure('预览修改回合（patch → graph 重载）', async (index) => {
    const graph = await client.projects.graph(graphTarget);
    const scene = graph.scenes[0];
    await client.projects.edit(graphTarget, {
      baseProjectRevision: graph.projectRevision,
      expectedSceneRevisions: { [scene.id]: scene.revision },
      operations: [{ op: 'update_scene', sceneId: scene.id, changes: { durationMs: 3000 + ((index % 40) + 1) } }],
      idempotencyKey: `perf_r_${String(index)}`,
      intent: '性能基线：预览修改回合',
    });
    await client.projects.graph(graphTarget);
  }),
);

results.push(
  await measure('上传（意图 + 直传 PUT + 确认）', async (index) => {
    // 合法 PNG（1×1）+ 末字节扰动（避免内容哈希去重；嗅探只看头部）
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const body = Buffer.concat([png, Buffer.from([index % 251])]);
    const intent = await client.assets.createUploadIntent(workspace.id, {
      assetType: 'USER_UPLOAD',
      filename: `perf-${String(index)}.png`,
      contentType: 'image/png',
      sizeBytes: body.byteLength,
      projectId: graphTarget,
    });
    if (intent.upload === null) throw new Error('未获得直传目标（意外去重）');
    const put = await fetch(intent.upload.url, { method: 'PUT', headers: intent.upload.headers, body });
    if (!put.ok) throw new Error(`直传 HTTP ${String(put.status)}`);
    await client.assets.confirm(workspace.id, intent.asset.id, {});
  }),
);

const report = {
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: `${platform()} ${process.arch}`,
    cpus: cpus().length,
    baseUrl,
    note: '本地开发机（非 CI 专用跑分环境）；数字用于量级核对与同环境趋势',
  },
  seed: { projects, scenesPerProject, iterations },
  results,
  targets: {
    '普通 API / 列表 / 场景图 p95 < 500ms': results[0].p95Ms < 500 && results[1].p95Ms < 500 && results[2].p95Ms < 500,
    'Scene patch p95 < 150ms（服务端口径）': patch.p95Ms < 150,
    '预览修改回合 p95 < 500ms（服务端口径）': results[4].p95Ms < 500,
    '浏览器侧（首屏 <3s / 交互帧率）：未测——需前端部署实测（验证文档列明）': null,
  },
};

console.log(JSON.stringify(report));
await handle.close();
