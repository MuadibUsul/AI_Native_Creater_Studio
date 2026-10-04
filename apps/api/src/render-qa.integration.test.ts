import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, workspaces, type DbHandle } from '@ancs/db';
import type { ArticleFetcher, LlmAdapter } from '@ancs/contracts';
import { MockLlmAdapter } from '@ancs/providers-mock-llm';
import { MockTtsAdapter } from '@ancs/providers-mock-tts';
import { LocalObjectStorage } from '@ancs/providers-storage-local';
import { buildServer } from './server.js';

/**
 * P07-05 HTTP/SDK 面（真实 DB + Mock LLM/TTS + 本地存储；**不执行渲染/QA 任务**——端到端在
 * apps/worker/src/render-qa.integration.test.ts 覆盖）：
 * - 渲染前预检：缺 Master Narration → 阻止项失败；有场景 → SCENES_PRESENT PASS；
 * - QA 触发守卫：非 QA 状态 → 409；QA 报告读取（未 QA → null）；跨租户 404。
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
  async fetch(input: { url: string }): Promise<{ finalUrl: string; contentType: string | null; bytes: Uint8Array }> {
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
    secret: 'render-qa-api-secret-0123456789', // secrets:check-ignore：测试专用假密钥
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
        rootDir: `${process.cwd()}/.artifacts/test-storage/render-qa-api-${randomUUID()}`,
        publicBaseUrl: 'http://127.0.0.1:3999',
        signingSecret: 'render-qa-api-storage-0123456789', // secrets:check-ignore：测试专用假密钥
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

beforeEach(async () => {
  await handle.db.delete(workspaces);
});

async function newClient(tag: string): Promise<AncsClient> {
  const email = `${tag}-${randomUUID()}@test.local`;
  await createInternalUser(auth, { email, password: 'password-1234', name: tag });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: 'password-1234' });
  return client;
}

/** 完整可达渲染项目（与 P07-04 一致的链路；SDK 面）。 */
async function makeRenderableProject(client: AncsClient): Promise<{ workspaceId: string; projectId: string }> {
  const workspace = await client.workspaces.create({ name: `QA-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '栏目' });
  const identity = await client.creatorIdentities.create(workspace.id, { displayName: '主播丁' });
  await client.creatorIdentities.update(workspace.id, identity.id, {
    voiceIdentity: { provider: 'mock-voice', providerVoiceId: 'vo_qa_api', cloneType: 'INSTANT', ownershipType: 'SELF_VERIFIED', managedMode: 'BYOK', languageProfile: 'zh-CN' },
  });
  await client.channels.update(workspace.id, channel.id, { defaults: { creatorIdentityId: identity.id } });
  const project = await client.projects.create(workspace.id, { title: 'QA 项目', channelId: channel.id });
  const url = `https://news.example/rates/${randomUUID()}`;
  fetcher.responses.set(url, { contentType: 'text/html; charset=utf-8', bytes: new TextEncoder().encode(ARTICLE_HTML) });
  const record = await client.content.create(workspace.id, project.id, { sourceType: 'URL_ARTICLE', url });
  await client.evidence.extract(workspace.id, project.id, record.document.id);
  llm.scriptNext('valid');
  const generated = await client.narrative.generate(workspace.id, project.id, record.document.id, { targetDurationMs: 6000 });
  await client.narrative.applyDirectorPlan(workspace.id, project.id, generated.plan.id, { idempotencyKey: `idem_qa_${randomUUID()}` });
  await client.narrative.synthesizeMasterNarration(workspace.id, project.id, generated.plan.id);
  return { workspaceId: workspace.id, projectId: project.id };
}

describe('Final QA HTTP/SDK（P07-05）', () => {
  it('渲染前预检：完整项目 → 无阻止项（内容检查来自当前项目状态）', async () => {
    const client = await newClient('qa-precheck');
    const { projectId } = await makeRenderableProject(client);
    const report = await client.projects.renderPrecheck(projectId);
    expect(report.scope).toBe('PRE_RENDER');
    expect(report.summary.blockersFailed).toBe(0);
    expect(report.checks.find((check) => check.id === 'MASTER_NARRATION_PRESENT')?.status).toBe('PASS');
    expect(report.checks.find((check) => check.id === 'SCENES_PRESENT')?.status).toBe('PASS');
    // EMPTY 场景（V1 默认状态）为警告级（可见、不假阻止）
    expect(report.checks.find((check) => check.id === 'SCENE_STATUS_NO_PLACEHOLDER')?.severity).toBe('WARNING');
  });

  it('缺 Master Narration → 预检阻止项失败（不在渲染后才发现）', async () => {
    const client = await newClient('qa-precheck-master');
    const workspace = await client.workspaces.create({ name: `无Master-${randomUUID().slice(0, 8)}` });
    const channel = await client.channels.create(workspace.id, { name: '栏目' });
    const project = await client.projects.create(workspace.id, { title: '空项目', channelId: channel.id });
    const report = await client.projects.renderPrecheck(project.id);
    expect(report.verdict).toBe('FAIL');
    expect(report.checks.find((check) => check.id === 'MASTER_NARRATION_PRESENT')?.status).toBe('FAIL');
  });

  it('QA 触发守卫（非 QA 状态 409）与报告读取（未 QA → null）；跨租户 404', async () => {
    const client = await newClient('qa-guard');
    const { workspaceId, projectId } = await makeRenderableProject(client);
    const render = await client.renders.create(workspaceId, projectId, { profile: 'DRAFT_720' });
    expect(render.status).toBe('QUEUED');

    // 未 QA：报告为 null
    expect(await client.renders.qaReport(workspaceId, render.id)).toBeNull();

    // 非 QA 状态触发 → 409（QA 只判定处于 QA 的渲染）
    const triggered = await client.renders.qa(workspaceId, render.id).catch((error: unknown) => error);
    expect(triggered).toBeInstanceOf(AncsApiError);
    expect((triggered as AncsApiError).status).toBe(409);

    // 跨租户读取报告 → 404
    const intruder = await newClient('qa-intruder');
    const crossed = await intruder.renders.qaReport(workspaceId, render.id).catch((error: unknown) => error);
    expect(crossed).toBeInstanceOf(AncsApiError);
    expect((crossed as AncsApiError).status).toBe(404);
  });
});
