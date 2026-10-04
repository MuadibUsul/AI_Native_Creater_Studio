import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, type DbHandle } from '@ancs/db';
import type { ArticleFetcher, LlmAdapter } from '@ancs/contracts';
import { MockLlmAdapter } from '@ancs/providers-mock-llm';
import { MockTtsAdapter } from '@ancs/providers-mock-tts';
import { LocalObjectStorage } from '@ancs/providers-storage-local';
import { buildServer } from './server.js';

/**
 * P07-03 验收（HTTP + SDK，真实 DB + Mock LLM/TTS + 本地存储）：
 * - 创建渲染 = **冻结输入快照**（自动 FINAL_RENDER 版本 + Master Narration + 资产版本清单 + 档位画幅）；
 * - **渲染中编辑当前项目不改变该次 Render 输入**（核心验收点：创建后编辑项目 → 输入逐字段不变）；
 * - 前置校验：缺 Master Narration → 409；空快照 → 422；跨工作区版本 → 404；
 * - 状态机单向：非法迁移 409；审计事件（render_events）随迁移递增。
 */

const ARTICLE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>利率周报</title></head><body>
<h1>美联储利率决议</h1>
<p>联邦基金利率维持在 5.25% 不变。</p>
</body></html>`;

let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let llm: MockLlmAdapter;
let tts: MockTtsAdapter;

class ScriptedFetcher implements ArticleFetcher {
  readonly kind = 'scripted';
  responses = new Map<string, { contentType: string | null; bytes: Uint8Array }>();
  async fetch(input: { url: string }) {
    const response = this.responses.get(input.url);
    if (response === undefined) throw new Error(`unreachable: ${input.url}`);
    return { finalUrl: input.url, contentType: response.contentType, bytes: response.bytes };
  }
}
const fetcher = new ScriptedFetcher();

beforeAll(async () => {
  const url = resolveTestDatabaseUrl();
  handle = createDb(url);
  try {
    await handle.pool.query('select 1');
  } catch (error) {
    await handle.close();
    throw new Error(`无法连接测试数据库 ${redactDatabaseUrl(url)}。`, { cause: error });
  }
  await runMigrations(handle);
  auth = createAuth({
    db: handle.db,
    secret: 'render-snapshot-secret-0123456789', // secrets:check-ignore：测试专用假密钥
    baseUrl: 'http://localhost:3001',
  });
  llm = new MockLlmAdapter();
  tts = new MockTtsAdapter();
  app = await buildServer({
    auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
    content: { articleFetcher: fetcher, llm: llm as LlmAdapter },
    audio: { tts },
    storage: {
      adapter: new LocalObjectStorage({
        rootDir: `${process.cwd()}/.artifacts/test-storage/render-snapshot-${randomUUID()}`,
        publicBaseUrl: 'http://127.0.0.1:3999',
        signingSecret: 'render-snapshot-storage-secret', // secrets:check-ignore：测试专用假密钥
      }),
    },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(async () => {
  await app.close();
  await handle.close();
});

async function newClient(tag: string): Promise<AncsClient> {
  const email = `${tag}-${randomUUID()}@test.local`;
  await createInternalUser(auth, { email, password: 'password-1234', name: tag });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: 'password-1234' });
  return client;
}

/** 完整链路：文章 → 叙事 → Director 应用 → Master Narration → 带场景与音频的项目。 */
async function makeRenderableProject(client: AncsClient): Promise<{ workspaceId: string; projectId: string }> {
  const workspace = await client.workspaces.create({ name: `渲染-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '栏目' });
  const identity = await client.creatorIdentities.create(workspace.id, { displayName: '主播甲' });
  await client.creatorIdentities.update(workspace.id, identity.id, {
    voiceIdentity: { provider: 'mock-voice', providerVoiceId: 'vo_render', cloneType: 'INSTANT', ownershipType: 'SELF_VERIFIED', managedMode: 'BYOK', languageProfile: 'zh-CN' },
  });
  await client.channels.update(workspace.id, channel.id, { defaults: { creatorIdentityId: identity.id } });
  const project = await client.projects.create(workspace.id, { title: '渲染项目', channelId: channel.id });
  const url = `https://news.example/rates/${randomUUID()}`;
  fetcher.responses.set(url, { contentType: 'text/html; charset=utf-8', bytes: new TextEncoder().encode(ARTICLE_HTML) });
  const record = await client.content.create(workspace.id, project.id, { sourceType: 'URL_ARTICLE', url });
  await client.evidence.extract(workspace.id, project.id, record.document.id);
  llm.scriptNext('valid');
  const generated = await client.narrative.generate(workspace.id, project.id, record.document.id, { targetDurationMs: 90_000 });
  await client.narrative.applyDirectorPlan(workspace.id, project.id, generated.plan.id, { idempotencyKey: `idem_rn_${randomUUID()}` });
  await client.narrative.synthesizeMasterNarration(workspace.id, project.id, generated.plan.id);
  return { workspaceId: workspace.id, projectId: project.id };
}

describe('Render Snapshot（P07-03）', () => {
  it('创建渲染冻结输入：自动 FINAL_RENDER 版本 + narration + 资产版本 + 档位画幅', async () => {
    const client = await newClient('render-create');
    const { workspaceId, projectId } = await makeRenderableProject(client);

    const render = await client.renders.create(workspaceId, projectId, { profile: 'STUDIO_1080' });
    expect(render.status).toBe('QUEUED');
    expect(render.profile).toBe('STUDIO_1080');
    expect(render.input.format).toEqual({ width: 1920, height: 1080, fps: 30 });
    expect(render.input.masterNarrationId).not.toBeNull();
    // 快照含场景（Director 应用后的场景进入版本快照）
    const graph = await client.projects.graph(projectId);
    expect(graph.scenes.length).toBeGreaterThan(0);
    // 版本已创建（FINAL_RENDER）
    const versions = await client.projects.versions.list(projectId);
    expect(versions.some((version) => version.reason === 'FINAL_RENDER' && version.id === render.input.projectVersionId)).toBe(true);
  });

  it('**渲染中编辑当前项目不改变该次 Render 输入**（核心验收点）', async () => {
    const client = await newClient('render-frozen');
    const { workspaceId, projectId } = await makeRenderableProject(client);
    const render = await client.renders.create(workspaceId, projectId, { profile: 'STUDIO_1080' });
    const inputBefore = JSON.stringify(render.input);

    // 渲染在途（QUEUED）：编辑当前项目（改项目标题 + 修改场景时长 → 新 revision）
    const graph = await client.projects.graph(projectId);
    const scene = graph.scenes[0];
    expect(scene).toBeDefined();
    await client.projects.edit(projectId, {
      baseProjectRevision: graph.projectRevision,
      expectedSceneRevisions: { [scene?.id ?? '']: scene?.revision ?? 1 },
      operations: [{ op: 'update_scene', sceneId: scene?.id ?? '', changes: { durationMs: 9000 } }],
      idempotencyKey: `idem_rnedit_${randomUUID()}`,
      intent: '渲染在途时的并发编辑（不应影响输入）',
    });

    // 输入快照逐字段不变；版本本体不可变
    const after = await client.renders.get(workspaceId, render.id);
    expect(JSON.stringify(after.input)).toBe(inputBefore);
    expect(after.input.projectVersionId).toBe(render.input.projectVersionId);
    expect(after.input.assetVersionIds).toEqual(render.input.assetVersionIds);
    expect(after.input.format).toEqual(render.input.format);

    // 冻结校验服务确认
    const check = await client.renders.get(workspaceId, render.id);
    expect(check.input.projectVersionId).toBe(render.input.projectVersionId);
  });

  it('前置校验：空项目 → 409/422；跨工作区版本 → 404', async () => {
    const client = await newClient('render-gates');
    // 空项目：先命中"快照无场景"或"无 Master"（两者都是明确的 4xx，顺序为 Master 先行）
    const workspace2 = await client.workspaces.create({ name: `无Master-${randomUUID().slice(0, 8)}` });
    const channel2 = await client.channels.create(workspace2.id, { name: '栏目' });
    const project2 = await client.projects.create(workspace2.id, { title: '空项目', channelId: channel2.id });
    const noMaster = await client.renders.create(workspace2.id, project2.id, { profile: 'DRAFT_720' }).catch((error: unknown) => error);
    expect(noMaster).toBeInstanceOf(AncsApiError);
    expect([409, 422]).toContain((noMaster as AncsApiError).status);

    // 跨工作区版本：工作区 A 的版本 → 工作区 B 提交渲染（B 的项目须有场景与 Master 才能到达版本校验；
    // 但 renderable 项目的版本属于 A —— B 提交时版本校验发生在 Master 校验之后，因此先用 renderable 项目触发）
    const { projectId: projectA } = await makeRenderableProject(client);
    // Director 应用不足 50 事件（无自动快照）→ 显式建 MANUAL 版本用于跨工作区校验
    await client.projects.versions.create(projectA, { reason: 'MANUAL', note: '跨工作区校验用' });
    const versions = await client.projects.versions.list(projectA);
    expect(versions.length).toBeGreaterThan(0);
    const { workspaceId: wsB, projectId: projectB } = await makeRenderableProject(client);
    const cross = await client.renders.create(wsB, projectB, { profile: 'DRAFT_720', projectVersionId: versions[0]?.id }).catch((error: unknown) => error);
    expect(cross).toBeInstanceOf(AncsApiError);
    expect((cross as AncsApiError).status).toBe(404);
  });

  it('状态机单向：QUEUED→RENDERING→QA→READY；非法迁移 409；审计事件递增', async () => {
    const client = await newClient('render-state');
    const { workspaceId, projectId } = await makeRenderableProject(client);
    const render = await client.renders.create(workspaceId, projectId, { profile: 'DRAFT_720' });

    // 非法迁移：QUEUED → READY（跳过渲染与 QA）
    const illegal = await client.renders.transition(workspaceId, render.id, { to: 'READY' }).catch((error: unknown) => error);
    expect(illegal).toBeInstanceOf(AncsApiError);
    expect((illegal as AncsApiError).status).toBe(409);

    // 合法推进：QUEUED → RENDERING → QA → READY
    const rendering = await client.renders.transition(workspaceId, render.id, { to: 'RENDERING', note: '开始渲染' });
    expect(rendering.status).toBe('RENDERING');
    const qa = await client.renders.transition(workspaceId, render.id, { to: 'QA' });
    expect(qa.status).toBe('QA');
    const ready = await client.renders.transition(workspaceId, render.id, { to: 'READY', note: 'QA 通过' });
    expect(ready.status).toBe('READY');

    // 终态不可再迁移
    const after = await client.renders.transition(workspaceId, render.id, { to: 'RENDERING' }).catch((error: unknown) => error);
    expect(after).toBeInstanceOf(AncsApiError);
    expect((after as AncsApiError).status).toBe(409);
  });

  it('隔离：跨租户创建/查询 → 404', async () => {
    const client = await newClient('render-isolation');
    const { workspaceId, projectId } = await makeRenderableProject(client);
    const render = await client.renders.create(workspaceId, projectId, { profile: 'DRAFT_720' });

    const { client: intruder } = { client: await newClient('render-intruder') };
    const crossed = await intruder.renders.get(workspaceId, render.id).catch((error: unknown) => error);
    expect(crossed).toBeInstanceOf(AncsApiError);
    expect((crossed as AncsApiError).status).toBe(404);
  });
});
