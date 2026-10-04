import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, type DbHandle } from '@ancs/db';
import type { ArticleFetcher, LlmAdapter } from '@ancs/contracts';
import { MockLlmAdapter } from '@ancs/providers-mock-llm';
import { buildServer } from './server.js';

/**
 * P04-06 验收（HTTP + SDK，真实 DB + Mock LLM）：
 * - SpeechPlan 供应商无关：只引用 voiceIdentityId/version 与 SpeechProfile 版本；
 *   **Provider 私有参数（provider/providerVoiceId）绝不出现**（序列化字符串级断言）；
 * - 角色/语速/能量/停顿/强调/发音覆盖按 §94 默认规则确定性生成；
 * - 不支持的风格参数可解释降级（钳制 + 记录 + 警示）；锁定旁白逐字使用；
 * - 身份与风格版本化：SpeechProfile 更新 → 计划引用新版本；跨租户 404。
 */

const ARTICLE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>利率周报</title></head><body>
<h1>美联储利率决议</h1>
<p>联邦基金利率维持在 5.25% 不变，为 2024 年以来的最高水平。</p>
<p>分析师预计 2025 年可能降息 2 个百分点，因为通胀压力缓解。</p>
</body></html>`;

const PROVIDER_NAME = 'mock-voice-provider';
const PROVIDER_VOICE_ID = 'vo_secret_leak_check_9f8e7d';

let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let llm: MockLlmAdapter;

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
    secret: 'speech-plan-workflow-secret-0123456789', // secrets:check-ignore：测试专用假密钥
    baseUrl: 'http://localhost:3001',
  });
  llm = new MockLlmAdapter();
  app = await buildServer({
    auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
    content: { articleFetcher: fetcher, llm: llm as LlmAdapter },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(async () => {
  await app.close();
  await handle.close();
});

async function newClient(tag: string): Promise<{ client: AncsClient; email: string }> {
  const email = `${tag}-${randomUUID()}@test.local`;
  await createInternalUser(auth, { email, password: 'password-1234', name: tag });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: 'password-1234' });
  return { client, email };
}

async function makeSpeechProject(client: AncsClient): Promise<{
  workspaceId: string;
  channelId: string;
  projectId: string;
  planId: string;
  voiceIdentityId: string;
  speechProfileId: string;
}> {
  const workspace = await client.workspaces.create({ name: `语音-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '栏目' });

  // 语音身份（含 Provider 私有参数——它们**绝不能**进入 SpeechPlan）
  const identity = await client.creatorIdentities.create(workspace.id, { displayName: '主播甲' });
  const withVoice = await client.creatorIdentities.update(workspace.id, identity.id, {
    voiceIdentity: {
      provider: PROVIDER_NAME,
      providerVoiceId: PROVIDER_VOICE_ID,
      cloneType: 'INSTANT',
      ownershipType: 'SELF_VERIFIED',
      verificationStatus: 'VERIFIED',
      managedMode: 'BYOK',
      languageProfile: 'zh-CN',
    },
  });
  const voiceIdentityId = withVoice.voiceIdentity?.id ?? '';

  const profile = await client.speechProfiles.create(workspace.id, {
    name: '默认播音风格',
    fields: {
      defaultSpeed: 1.05,
      // 术语取 Mock 改写后必然出现的词（旁白文本，而非原文）
      pronunciationDictionary: [{ term: '量级', reading: 'liàng jí' }],
    },
  });

  // Channel 样式绑定身份与风格（Speech Director 的默认来源）
  await client.channels.update(workspace.id, channel.id, {
    defaults: { creatorIdentityId: identity.id, speechProfileId: profile.id },
  });

  const project = await client.projects.create(workspace.id, { title: '语音项目', channelId: channel.id });
  const url = `https://news.example/rates/${randomUUID()}`;
  fetcher.responses.set(url, { contentType: 'text/html; charset=utf-8', bytes: new TextEncoder().encode(ARTICLE_HTML) });
  const record = await client.content.create(workspace.id, project.id, { sourceType: 'URL_ARTICLE', url });
  await client.evidence.extract(workspace.id, project.id, record.document.id);

  llm.scriptNext('valid');
  const generated = await client.narrative.generate(workspace.id, project.id, record.document.id, { targetDurationMs: 120_000 });
  return { workspaceId: workspace.id, channelId: channel.id, projectId: project.id, planId: generated.plan.id, voiceIdentityId, speechProfileId: profile.id };
}

describe('Speech Director（P04-06）', () => {
  it('供应商无关 SpeechPlan：角色/停顿/强调/发音覆盖 + **Provider 私有参数零泄漏**', async () => {
    const { client } = await newClient('speech-plan');
    const { workspaceId, projectId, planId, voiceIdentityId, speechProfileId } = await makeSpeechProject(client);

    const speech = await client.narrative.speechPlan(workspaceId, projectId, planId);
    expect(speech.speechPlanVersion).toBe('speech-plan-v1');
    expect(speech.narrativePlanId).toBe(planId);

    // 身份与风格：版本化引用（Provider 参数不出现）
    expect(speech.voice.voiceIdentityId).toBe(voiceIdentityId);
    expect(speech.voice.voiceIdentityVersion).toBeGreaterThanOrEqual(1);
    expect(speech.speechProfile).toMatchObject({ id: speechProfileId, version: 1, source: 'CHANNEL' });

    // **私有参数零泄漏**：Provider 名称与 Provider voice id 不得出现在计划任何位置
    const serialized = JSON.stringify(speech);
    expect(serialized).not.toContain(PROVIDER_NAME);
    expect(serialized).not.toContain(PROVIDER_VOICE_ID);

    // 段落：与旁白块一一对应；首段 Hook；语义驱动的角色存在
    const narrative = await client.narrative.current(workspaceId, projectId);
    const blockIds = narrative?.narrationBlocks.map((block) => block.id) ?? [];
    expect(speech.segments.length).toBe(blockIds.length);
    expect(speech.segments[0]?.sceneRole).toBe('HOOK');
    expect(speech.segments.map((segment) => segment.narrationBlockId)).toEqual(blockIds);
    expect(speech.segments.some((segment) => segment.sceneRole === 'NUMBER')).toBe(true);

    // 关键数字：停顿 + 强调（5.25% 出现在旁白引用的事实句中）
    const numberSegment = speech.segments.find((segment) => segment.emphasisSpans.length > 0);
    expect(numberSegment).toBeDefined();
    expect(numberSegment?.pauses.some((pause) => pause.reason === 'NUMBER_PREPAUSE')).toBe(true);
    expect(numberSegment?.pauses.some((pause) => pause.reason === 'SENTENCE_GAP')).toBe(true);

    // 发音词典命中 → 覆盖
    expect(speech.segments.some((segment) => segment.pronunciationOverrides.some((entry) => entry.term === '量级'))).toBe(true);

    // 无可用 TTS：风格参数支持情况未核验（不冒充可合成）
    expect(speech.warnings.map((warning) => warning.code)).toContain('STYLE_SUPPORT_UNVERIFIED');
    expect(speech.decisionSummary.length).toBeGreaterThan(10);
    expect(speech.generation.method).toBe('DETERMINISTIC');
  });

  it('风格版本化：SpeechProfile 更新 → 计划引用新版本与新语速；锁定旁白逐字使用', async () => {
    const { client } = await newClient('speech-version');
    const { workspaceId, projectId, planId, speechProfileId } = await makeSpeechProject(client);

    const before = await client.narrative.speechPlan(workspaceId, projectId, planId);
    expect(before.speechProfile.version).toBe(1);

    await client.speechProfiles.update(workspaceId, speechProfileId, { fields: { defaultSpeed: 1.5 } });
    const after = await client.narrative.speechPlan(workspaceId, projectId, planId);
    expect(after.speechProfile).toMatchObject({ id: speechProfileId, version: 2, source: 'CHANNEL' });
    const hookBefore = before.segments[0]?.speed ?? 0;
    const hookAfter = after.segments[0]?.speed ?? 0;
    expect(hookAfter).toBeGreaterThan(hookBefore);

    // 锁定旁白：逐字进入合成文本 + INFO 告警
    const narrative = await client.narrative.current(workspaceId, projectId);
    const firstBlock = narrative?.narrationBlocks[0];
    expect(firstBlock).toBeDefined();
    await client.narrative.updateBlock(workspaceId, projectId, planId, firstBlock?.id ?? '', { locked: true });
    const locked = await client.narrative.speechPlan(workspaceId, projectId, planId);
    const lockedSegment = locked.segments.find((segment) => segment.narrationBlockId === firstBlock?.id);
    expect(lockedSegment).toMatchObject({ text: firstBlock?.text, locked: true });
    expect(locked.warnings.map((warning) => warning.code)).toContain('LOCKED_PRESERVED');
  });

  it('请求覆盖：显式指定身份与风格档案（source=REQUEST）；跨租户 404', async () => {
    const { client } = await newClient('speech-override');
    const { workspaceId, projectId, planId } = await makeSpeechProject(client);

    const other = await client.speechProfiles.create(workspaceId, { name: '快节奏', fields: { defaultSpeed: 1.4 } });
    const overridden = await client.narrative.speechPlan(workspaceId, projectId, planId, { speechProfileId: other.id });
    expect(overridden.speechProfile).toMatchObject({ id: other.id, version: 1, source: 'REQUEST' });

    // 未绑定身份的独立工作区：计划可用但明确警示（合成前必须绑定）
    const lonely = await newClient('speech-novoice');
    const workspace2 = await lonely.client.workspaces.create({ name: `无身份-${randomUUID().slice(0, 8)}` });
    const channel2 = await lonely.client.channels.create(workspace2.id, { name: '栏目' });
    const project2 = await lonely.client.projects.create(workspace2.id, { title: '无身份项目', channelId: channel2.id });
    const url = `https://news.example/rates/${randomUUID()}`;
    fetcher.responses.set(url, { contentType: 'text/html; charset=utf-8', bytes: new TextEncoder().encode(ARTICLE_HTML) });
    const record = await lonely.client.content.create(workspace2.id, project2.id, { sourceType: 'URL_ARTICLE', url });
    await lonely.client.evidence.extract(workspace2.id, project2.id, record.document.id);
    llm.scriptNext('valid');
    const generated = await lonely.client.narrative.generate(workspace2.id, project2.id, record.document.id, { targetDurationMs: 90_000 });
    const speech = await lonely.client.narrative.speechPlan(workspace2.id, project2.id, generated.plan.id);
    expect(speech.voice).toMatchObject({ voiceIdentityId: null, voiceIdentityVersion: null });
    expect(speech.warnings.map((warning) => warning.code)).toContain('NO_VOICE_IDENTITY');

    const { client: intruder } = await newClient('speech-intruder');
    const crossed = await intruder.narrative.speechPlan(workspaceId, projectId, planId).catch((error: unknown) => error);
    expect(crossed).toBeInstanceOf(AncsApiError);
    expect((crossed as AncsApiError).status).toBe(404);
  });
});
