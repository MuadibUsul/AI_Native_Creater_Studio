import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, narrationBlocks, plans, podcastEpisodes, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, workspaces, type DbHandle } from '@ancs/db';
import { ensureDefaultPlans, type DomainDeps } from '@ancs/domain';
import { MockLlmAdapter } from '@ancs/providers-mock-llm';
import { MockTtsAdapter } from '@ancs/providers-mock-tts';
import { LocalObjectStorage } from '@ancs/providers-storage-local';
import type { ArticleFetcher, LlmAdapter } from '@ancs/contracts';
import { buildServer } from './server.js';

/**
 * P12-05 验收（真实 DB）：Podcast（纯音频叙事/混音/元数据/章节/授权）。
 * - **去除"看屏幕"表达**：含视觉指涉的句子被移除并逐句披露（removedSentences）；纯视觉块整块跳过；
 * - **派生 Master 全新**：variant='PODCAST'（**不进视频主链**——getCurrentMasterNarration 仍返回源母带）；
 * - **章节 = 派生 Master 的真实 cue**（时间戳来自新音频；篡改可复现报错）；
 * - **元数据/授权完整**：metadata + attribution（来源署名）+ 混音计划。
 */

const ARTICLE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>利率周报</title></head><body>
<h1>美联储利率决议</h1><p>联邦基金利率维持在 5.25% 不变。市场预计年内降息一次。</p></body></html>`;

let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let llm: MockLlmAdapter;
const PASSWORD = 'password-1234';
const deps = (): DomainDeps => ({ db: handle.db });

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
  auth = createAuth({ db: handle.db, secret: 'podcast-secret-0123456789', baseUrl: 'http://localhost:3001' }); // secrets:check-ignore：测试专用假密钥
  llm = new MockLlmAdapter();
  app = await buildServer({
    auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
    content: { articleFetcher: fetcher, llm: llm as LlmAdapter },
    audio: { tts: new MockTtsAdapter() },
    storage: {
      adapter: new LocalObjectStorage({
        rootDir: `${process.cwd()}/.artifacts/test-storage/podcast-${randomUUID()}`,
        publicBaseUrl: 'http://localhost:9000',
        signingSecret: 'podcast-storage-secret', // secrets:check-ignore：测试专用假密钥
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
  await handle.db.delete(plans);
  await ensureDefaultPlans(deps());
});

async function newClient(tag: string): Promise<AncsClient> {
  const email = `${tag}-${randomUUID()}@test.local`;
  await createInternalUser(auth, { email, password: PASSWORD, name: tag });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: PASSWORD });
  return client;
}

async function makeNarratedProject(client: AncsClient, mode: 'valid' | 'visual_refs'): Promise<{ workspaceId: string; projectId: string; planId: string }> {
  const workspace = await client.workspaces.create({ name: `播客-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '栏目' });
  const identity = await client.creatorIdentities.create(workspace.id, { displayName: '主播甲' });
  await client.creatorIdentities.update(workspace.id, identity.id, {
    voiceIdentity: { provider: 'mock-voice', providerVoiceId: 'vo_test_podcast', cloneType: 'INSTANT', ownershipType: 'SELF_VERIFIED', managedMode: 'BYOK', languageProfile: 'zh-CN' },
  });
  await client.channels.update(workspace.id, channel.id, { defaults: { creatorIdentityId: identity.id } });

  const project = await client.projects.create(workspace.id, { title: '利率周报', channelId: channel.id });
  const url = `https://news.example/podcast/${randomUUID()}`;
  fetcher.responses.set(url, { contentType: 'text/html; charset=utf-8', bytes: new TextEncoder().encode(ARTICLE_HTML) });
  const record = await client.content.create(workspace.id, project.id, { sourceType: 'URL_ARTICLE', url });
  await client.evidence.extract(workspace.id, project.id, record.document.id);
  llm.scriptNext(mode);
  const generated = await client.narrative.generate(workspace.id, project.id, record.document.id, { targetDurationMs: 90_000 });
  await client.narrative.synthesizeMasterNarration(workspace.id, project.id, generated.plan.id);
  return { workspaceId: workspace.id, projectId: project.id, planId: generated.plan.id };
}

async function expectApiError(promise: Promise<unknown>, status: number, reason?: string): Promise<AncsApiError> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AncsApiError);
  const apiError = error as AncsApiError;
  expect(apiError.status).toBe(status);
  if (reason !== undefined) expect((apiError.details as { reason?: string }).reason).toBe(reason);
  return apiError;
}

describe('Podcast（P12-05）', () => {
  it('生成：视觉指涉句移除+逐句披露；PODCAST 变体全新 Master（**不进视频主链**）；章节=真实 cue；元数据/署名完整', async () => {
    const client = await newClient('pod-main');
    const { workspaceId, projectId, planId } = await makeNarratedProject(client, 'visual_refs');
    const source = await client.narrative.masterNarration(workspaceId, projectId, planId);
    expect(source).not.toBeNull();

    const episode = await client.podcast.generate(workspaceId, projectId, { planId });

    // 去除"看屏幕"表达：含视觉指涉的句子被移除并逐句披露
    const removed = episode.units.flatMap((unit) => unit.removedSentences);
    expect(removed.length).toBeGreaterThan(0);
    expect(removed.every((sentence) => sentence.includes('如图所示') || sentence.includes('这一列'))).toBe(true);
    // 改写文本不再含视觉指涉词
    expect(episode.units.every((unit) => !unit.adaptedText.includes('如图所示') && !unit.adaptedText.includes('这一列'))).toBe(true);
    // 覆盖披露
    expect(episode.coverage.sentencesRemoved).toBe(removed.length);
    expect(episode.coverage.sentencesTotal).toBeGreaterThan(0);

    // 纯视觉块整块跳过（偶数块 = 全句视觉 → skippedBlockIds 非空；剩余块子集成集）
    expect(episode.skippedBlockIds.length).toBeGreaterThan(0);
    expect(episode.units.length).toBeGreaterThan(episode.skippedBlockIds.length);

    // **PODCAST 变体不进视频主链**：video 主链 Master 仍是源母带（id 与 variant 不变）
    const videoMaster = await client.narrative.masterNarration(workspaceId, projectId, planId);
    expect(videoMaster?.id).toBe(source?.id);
    expect(videoMaster?.variant).toBe('MASTER');

    // 章节 = 派生 Master 的真实 cue（子集聚合：章节数 < 源段数）
    expect(episode.chapters.length).toBeGreaterThan(0);
    expect(episode.chapters.length).toBeLessThan(source?.segments.length ?? 0);
    for (const chapter of episode.chapters) {
      expect(chapter.startMs).toBeGreaterThanOrEqual(0);
      expect(chapter.durationMs).toBeGreaterThan(0);
    }

    // 元数据与授权完整（标题 = 计划标题 + 播客版后缀；计划标题派生自文档标题）
    expect(episode.metadata.title).toContain('美联储利率决议');
    expect(episode.metadata.title).toContain('播客版');
    expect(episode.metadata.language).toBe('zh');
    expect(episode.metadata.explicit).toBe(false);
    expect(episode.metadata.bgmBound).toBe(false);
    expect(episode.mixNote).toContain('未绑定 BGM');
    expect(episode.attribution.text).toContain('来源：');
    expect(episode.attribution.sourceIds.length).toBeGreaterThan(0);
    expect(episode.mixPlan.durationMs).toBeGreaterThan(0);

    // 校验通过（零 error）
    const validation = await client.podcast.validate(workspaceId, projectId, episode.id);
    expect(validation.result.ok).toBe(true);
    expect(validation.result.issues.filter((issue) => issue.severity === 'error')).toHaveLength(0);

    // 列表可见
    const list = await client.podcast.list(workspaceId, projectId);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.id).toBe(episode.id);
  }, 180_000);

  it('validate 篡改可复现：章节时间戳改写 → CHAPTERS_MISMATCH；脚本再注入视觉指涉 → VISUAL_REFERENCE_PRESENT', async () => {
    const client = await newClient('pod-tamper');
    const { workspaceId, projectId, planId } = await makeNarratedProject(client, 'visual_refs');
    const episode = await client.podcast.generate(workspaceId, projectId, { planId });

    // 篡改 1：章节时间戳改写（与派生 Master cue 不一致）
    await handle.db
      .update(podcastEpisodes)
      .set({ chapters: [{ index: 0, title: '伪造章节', startMs: 999_999, durationMs: 1 }] })
      .where(and(eq(podcastEpisodes.id, episode.id), eq(podcastEpisodes.workspaceId, workspaceId)));
    const tampered = await client.podcast.validate(workspaceId, projectId, episode.id);
    expect(tampered.result.ok).toBe(false);
    expect(tampered.result.issues.some((issue) => issue.code === 'CHAPTERS_MISMATCH')).toBe(true);

    // 篡改 2：脚本再注入视觉指涉
    await handle.db
      .update(podcastEpisodes)
      .set({ units: episode.units.map((unit) => ({ ...unit, adaptedText: `${unit.adaptedText}如图所示。` })) })
      .where(and(eq(podcastEpisodes.id, episode.id), eq(podcastEpisodes.workspaceId, workspaceId)));
    const tampered2 = await client.podcast.validate(workspaceId, projectId, episode.id);
    expect(tampered2.result.issues.some((issue) => issue.code === 'VISUAL_REFERENCE_PRESENT')).toBe(true);

    // 恢复原始数据 → 校验回到通过（校验是确定性的）
    await handle.db
      .update(podcastEpisodes)
      .set({ chapters: episode.chapters, units: episode.units })
      .where(and(eq(podcastEpisodes.id, episode.id), eq(podcastEpisodes.workspaceId, workspaceId)));
    const restored = await client.podcast.validate(workspaceId, projectId, episode.id);
    expect(restored.result.ok).toBe(true);
  }, 180_000);

  it('闸门：无源 Master → 409 PODCAST_SOURCE_MISSING；全视觉块 → 422 NO_AUDIO_CONTENT', async () => {
    const client = await newClient('pod-gates');
    const workspace = await client.workspaces.create({ name: `闸门-${randomUUID().slice(0, 8)}` });
    const channel = await client.channels.create(workspace.id, { name: '栏目' });
    const identity = await client.creatorIdentities.create(workspace.id, { displayName: '主播甲' });
    await client.creatorIdentities.update(workspace.id, identity.id, {
      voiceIdentity: { provider: 'mock-voice', providerVoiceId: 'vo_gate', cloneType: 'INSTANT', ownershipType: 'SELF_VERIFIED', managedMode: 'BYOK', languageProfile: 'zh-CN' },
    });
    await client.channels.update(workspace.id, channel.id, { defaults: { creatorIdentityId: identity.id } });
    const project = await client.projects.create(workspace.id, { title: '闸门项目', channelId: channel.id });
    const url = `https://news.example/gate/${randomUUID()}`;
    fetcher.responses.set(url, { contentType: 'text/html; charset=utf-8', bytes: new TextEncoder().encode(ARTICLE_HTML) });
    const record = await client.content.create(workspace.id, project.id, { sourceType: 'URL_ARTICLE', url });
    await client.evidence.extract(workspace.id, project.id, record.document.id);

    // 场景 1：有计划但未合成 Master → 409
    llm.scriptNext('valid');
    const plan = await client.narrative.generate(workspace.id, project.id, record.document.id, { targetDurationMs: 90_000 });
    await expectApiError(client.podcast.generate(workspace.id, project.id, { planId: plan.plan.id }), 409, 'PODCAST_SOURCE_MISSING');

    // 场景 2：合成后把全部块置为视觉指涉句（词表全命中 → 移除后全空）→ 422 NO_AUDIO_CONTENT
    llm.scriptNext('valid');
    const generated = await client.narrative.generate(workspace.id, project.id, record.document.id, { targetDurationMs: 90_000 });
    await client.narrative.synthesizeMasterNarration(workspace.id, project.id, generated.plan.id);
    await handle.db
      .update(narrationBlocks)
      .set({ text: '如图所示，看这一列。' })
      .where(eq(narrationBlocks.planId, generated.plan.id));
    await expectApiError(client.podcast.generate(workspace.id, project.id, { planId: generated.plan.id }), 422, 'NO_AUDIO_CONTENT');
  }, 180_000);
});
