import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, type DbHandle } from '@ancs/db';
import type { AlignmentProvider, ArticleFetcher, LlmAdapter } from '@ancs/contracts';
import { MockLlmAdapter } from '@ancs/providers-mock-llm';
import { MockTtsAdapter } from '@ancs/providers-mock-tts';
import { LocalObjectStorage } from '@ancs/providers-storage-local';
import { buildServer } from './server.js';

/**
 * P06-03 验收（HTTP + SDK，真实 DB + Mock LLM/TTS + 本地存储）：
 * - 逐段合成（带词级时间戳）→ 拼接 Master 音频（落自有存储 + Asset 行）→ 全局 Alignment + cues；
 * - **局部重建**：改一句话 → 只重合成该段（TTS 调用 +1），其余段命中缓存（reused）；
 * - Provider 无时间戳且未配置对齐器 → 501 TIMESTAMPS_UNAVAILABLE（不接受按字数估计）；
 *   配置 AlignmentProvider 后 → alignmentMethod=ALIGNMENT_PROVIDER；
 * - 未绑定声音身份 → 409 VOICE_IDENTITY_REQUIRED；跨租户 404。
 */

const ARTICLE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>利率周报</title></head><body>
<h1>美联储利率决议</h1>
<p>联邦基金利率维持在 5.25% 不变。</p>
<p>分析师预计 2025 年可能降息 2 个百分点。</p>
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

/** 最小可用对齐器（把文本按字符均分到音频时长——本测试只验证"走 AlignmentProvider 路径"）。 */
class ScriptedAligner implements AlignmentProvider {
  readonly kind = 'scripted';
  async align(input: { bytes: Uint8Array; mimeType: string; text: string }) {
    const chars = [...input.text];
    const total = Math.max(300, chars.length * 120);
    return {
      words: chars.map((char, index) => ({ word: char, startMs: Math.round((index / chars.length) * total), endMs: Math.round(((index + 1) / chars.length) * total) })),
      durationMs: total,
    };
  }
}

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
    secret: 'master-narration-secret-0123456789', // secrets:check-ignore：测试专用假密钥
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
        rootDir: `${process.cwd()}/.artifacts/test-storage/master-narration-${randomUUID()}`,
        publicBaseUrl: 'http://localhost:9000',
        signingSecret: 'master-narration-storage-secret', // secrets:check-ignore：测试专用假密钥
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

/** 建项目：绑定声音身份与 SpeechProfile（Channel 默认）→ 生成叙事计划。 */
async function makeNarratedProject(client: AncsClient): Promise<{ workspaceId: string; projectId: string; planId: string }> {
  const workspace = await client.workspaces.create({ name: `主时钟-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '栏目' });
  const identity = await client.creatorIdentities.create(workspace.id, { displayName: '主播甲' });
  await client.creatorIdentities.update(workspace.id, identity.id, {
    voiceIdentity: { provider: 'mock-voice', providerVoiceId: 'vo_test_master', cloneType: 'INSTANT', ownershipType: 'SELF_VERIFIED', managedMode: 'BYOK', languageProfile: 'zh-CN' },
  });
  await client.channels.update(workspace.id, channel.id, { defaults: { creatorIdentityId: identity.id } });

  const project = await client.projects.create(workspace.id, { title: '主时钟项目', channelId: channel.id });
  const url = `https://news.example/rates/${randomUUID()}`;
  fetcher.responses.set(url, { contentType: 'text/html; charset=utf-8', bytes: new TextEncoder().encode(ARTICLE_HTML) });
  const record = await client.content.create(workspace.id, project.id, { sourceType: 'URL_ARTICLE', url });
  await client.evidence.extract(workspace.id, project.id, record.document.id);
  llm.scriptNext('valid');
  const generated = await client.narrative.generate(workspace.id, project.id, record.document.id, { targetDurationMs: 90_000 });
  return { workspaceId: workspace.id, projectId: project.id, planId: generated.plan.id };
}

describe('Master Narration 与 Alignment（P06-03）', () => {
  it('逐段合成 → 拼接（WAV + Asset）→ 全局 Alignment（绝对时间轴）与 cues', async () => {
    const client = await newClient('master-basic');
    const { workspaceId, projectId, planId } = await makeNarratedProject(client);
    const narrative = await client.narrative.current(workspaceId, projectId);
    expect(narrative).not.toBeNull();

    const master = await client.narrative.synthesizeMasterNarration(workspaceId, projectId, planId);
    expect(master.alignmentMethod).toBe('PROVIDER_TIMESTAMPS');
    expect(master.segments.length).toBe(narrative?.narrationBlocks.length);
    expect(master.cacheStats).toMatchObject({ reused: 0 });
    expect(master.cacheStats.synthesized).toBe(master.segments.length);

    // 绝对时间轴：段连续无缝隙；cues 与段一致
    let cursor = 0;
    for (const [index, segment] of master.segments.entries()) {
      expect(segment.startMs).toBe(cursor);
      expect(segment.endMs).toBe(segment.startMs + segment.durationMs);
      expect(segment.words.length).toBeGreaterThan(0); // 词级时间戳可用（§5.1）
      cursor += segment.durationMs;
      expect(master.cues[index]).toMatchObject({ narrationBlockId: segment.narrationBlockId, startMs: segment.startMs, durationMs: segment.durationMs });
    }
    expect(master.totalDurationMs).toBe(cursor);

    // Master 音频已落自有存储并登记资产（VOICE_AUDIO / READY / 校验和）
    expect(master.assetId).not.toBeNull();
    expect(master.mimeType).toBe('audio/wav');
    expect(master.checksumSha256).not.toBeNull();
    const assets = await client.assets.list(workspaceId, { projectId });
    expect(assets.some((asset) => asset.id === master.assetId && asset.assetType === 'VOICE_AUDIO' && asset.status === 'READY')).toBe(true);

    // 读回：当前 Master 与写入一致
    const current = await client.narrative.masterNarration(workspaceId, projectId, planId);
    expect(current?.id).toBe(master.id);
  });

  it('局部重建：改一句话 → 仅该段重新合成（TTS +1），其余段命中缓存且对齐更新', async () => {
    const client = await newClient('master-rebuild');
    const { workspaceId, projectId, planId } = await makeNarratedProject(client);
    const first = await client.narrative.synthesizeMasterNarration(workspaceId, projectId, planId);
    const target = first.segments[1];
    expect(target).toBeDefined();
    if (target === undefined) return;

    // 作者修改该旁白文本（未锁定；若锁定 → 409）
    await client.narrative.updateBlock(workspaceId, projectId, planId, target.narrationBlockId, { text: '改写后的一句话：利率维持不变。' });

    const callsBefore = tts.callCount;
    const rebuilt = await client.narrative.synthesizeMasterNarration(workspaceId, projectId, planId, { onlyBlockId: target.narrationBlockId });
    expect(tts.callCount).toBe(callsBefore + 1); // 只重合成这一段
    expect(rebuilt.cacheStats).toMatchObject({ synthesized: 1, reused: rebuilt.segments.length - 1 });

    // 该段文本/时长更新；其余段文字不变且 reused=true；对齐连续
    const updated = rebuilt.segments.find((segment) => segment.narrationBlockId === target.narrationBlockId);
    expect(updated?.text).toBe('改写后的一句话：利率维持不变。');
    expect(updated?.reused).toBe(false);
    for (const segment of rebuilt.segments) {
      if (segment.narrationBlockId !== target.narrationBlockId) expect(segment.reused).toBe(true);
    }
    let cursor = 0;
    for (const segment of rebuilt.segments) {
      expect(segment.startMs).toBe(cursor);
      cursor += segment.durationMs;
    }
    expect(rebuilt.totalDurationMs).toBe(cursor);
    // 新 Master 追加式落库（当前 = 新行）
    const current = await client.narrative.masterNarration(workspaceId, projectId, planId);
    expect(current?.id).toBe(rebuilt.id);
  });

  it('无时间戳且未配置对齐器 → 501 TIMESTAMPS_UNAVAILABLE（不接受按字数估计）', async () => {
    const client = await newClient('master-nots');
    const { workspaceId, projectId, planId } = await makeNarratedProject(client);
    tts.scriptNext('no_timestamps');
    const failure = await client.narrative.synthesizeMasterNarration(workspaceId, projectId, planId).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AncsApiError);
    expect((failure as AncsApiError).status).toBe(501);
    expect((failure as AncsApiError).details['reason']).toBe('TIMESTAMPS_UNAVAILABLE');
    // 明确失败不产生 Master
    expect(await client.narrative.masterNarration(workspaceId, projectId, planId)).toBeNull();
  });

  it('Provider 无时间戳 + 配置 AlignmentProvider → alignmentMethod=ALIGNMENT_PROVIDER', async () => {
    const email = `align-${randomUUID()}@test.local`;
    await createInternalUser(auth, { email, password: 'password-1234', name: 'align' });
    const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
    await client.auth.signIn({ email, password: 'password-1234' });
    const { workspaceId, projectId, planId } = await makeNarratedProject(client);

    // 第二个装配：TTS 默认返回"无时间戳" + 配置 ScriptedAligner（同一用户会话，保证工作区成员关系）
    const appWithNoTs = await buildServer({
      auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
      content: { articleFetcher: fetcher, llm: llm as LlmAdapter },
      audio: { tts: new MockTtsAdapter({ defaultMode: 'no_timestamps' }), aligner: new ScriptedAligner() },
      storage: {
        adapter: new LocalObjectStorage({
          rootDir: `${process.cwd()}/.artifacts/test-storage/master-align-${randomUUID()}`,
          publicBaseUrl: 'http://localhost:9000',
          signingSecret: 'master-align-storage-secret', // secrets:check-ignore：测试专用假密钥
        }),
      },
    });
    await appWithNoTs.listen({ port: 0, host: '127.0.0.1' });
    const address = appWithNoTs.server.address() as AddressInfo;
    const alignedClient = createClient({ baseUrl: `http://127.0.0.1:${String(address.port)}`, clientType: 'web', clientVersion: '0.1.0' });
    await alignedClient.auth.signIn({ email, password: 'password-1234' });

    const master = await alignedClient.narrative.synthesizeMasterNarration(workspaceId, projectId, planId);
    expect(master.alignmentMethod).toBe('ALIGNMENT_PROVIDER');
    expect(master.segments.every((segment) => segment.words.length > 0)).toBe(true);
    await appWithNoTs.close();
  });

  it('未绑定声音身份 → 409 VOICE_IDENTITY_REQUIRED；跨租户 → 404', async () => {
    const client = await newClient('master-novoice');
    const workspace = await client.workspaces.create({ name: `无身份-${randomUUID().slice(0, 8)}` });
    const channel = await client.channels.create(workspace.id, { name: '栏目' });
    const project = await client.projects.create(workspace.id, { title: '无身份项目', channelId: channel.id });
    const url = `https://news.example/rates/${randomUUID()}`;
    fetcher.responses.set(url, { contentType: 'text/html; charset=utf-8', bytes: new TextEncoder().encode(ARTICLE_HTML) });
    const record = await client.content.create(workspace.id, project.id, { sourceType: 'URL_ARTICLE', url });
    await client.evidence.extract(workspace.id, project.id, record.document.id);
    llm.scriptNext('valid');
    const generated = await client.narrative.generate(workspace.id, project.id, record.document.id, { targetDurationMs: 60_000 });

    const failure = await client.narrative.synthesizeMasterNarration(workspace.id, project.id, generated.plan.id).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AncsApiError);
    expect((failure as AncsApiError).status).toBe(409);
    expect((failure as AncsApiError).details['reason']).toBe('VOICE_IDENTITY_REQUIRED');

    const { client: intruder } = { client: await newClient('master-intruder') };
    const crossed = await intruder.narrative.masterNarration(workspace.id, project.id, generated.plan.id).catch((error: unknown) => error);
    expect(crossed).toBeInstanceOf(AncsApiError);
    expect((crossed as AncsApiError).status).toBe(404);
  });
});
