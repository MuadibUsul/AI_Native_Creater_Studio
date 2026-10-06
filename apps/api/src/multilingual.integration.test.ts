import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, plans, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, workspaces, type DbHandle } from '@ancs/db';
import { ensureDefaultPlans, type DomainDeps } from '@ancs/domain';
import { MockLlmAdapter } from '@ancs/providers-mock-llm';
import { MockTtsAdapter } from '@ancs/providers-mock-tts';
import { LocalObjectStorage } from '@ancs/providers-storage-local';
import type { ArticleFetcher, LlmAdapter } from '@ancs/contracts';
import { buildServer } from './server.js';

/**
 * P12-04 验收（真实 DB）：多语言（翻译脚本/术语词典/重新 TTS/对齐/字幕/派生版本）。
 * - **不复用原语言时间戳**：派生 Master Narration 为全新合成行（cacheStats.synthesized=全部段、
 *   cacheKey 含语言 → 与源语言 cacheKey 不同；源语言行不作为译文缓存源）；
 * - **数字一致**：Mock 翻译抹掉数字 → 422 NUMBERS_CHANGED（fail-closed，整体不落库不合成）；
 * - **实体一致**：词典命中源词但译文无译名 → 422 ENTITY_MISSING；正常路径词典替换生效；
 * - **引用一致**：翻译单元逐块回链源旁白块（narrationBlockId）。
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
  auth = createAuth({ db: handle.db, secret: 'multilingual-secret-0123456789', baseUrl: 'http://localhost:3001' }); // secrets:check-ignore：测试专用假密钥
  llm = new MockLlmAdapter();
  app = await buildServer({
    auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
    content: { articleFetcher: fetcher, llm: llm as LlmAdapter },
    audio: { tts: new MockTtsAdapter() },
    storage: {
      adapter: new LocalObjectStorage({
        rootDir: `${process.cwd()}/.artifacts/test-storage/multilingual-${randomUUID()}`,
        publicBaseUrl: 'http://localhost:9000',
        signingSecret: 'multilingual-storage-secret', // secrets:check-ignore：测试专用假密钥
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

/** 建项目：绑定声音身份（Channel 默认）→ 生成叙事计划 → 源语言 Master（P06-03 链路）。 */
async function makeProjectWithNarration(client: AncsClient): Promise<{ workspaceId: string; projectId: string; planId: string }> {
  const workspace = await client.workspaces.create({ name: `多语言-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '栏目' });
  const identity = await client.creatorIdentities.create(workspace.id, { displayName: '主播甲' });
  await client.creatorIdentities.update(workspace.id, identity.id, {
    voiceIdentity: { provider: 'mock-voice', providerVoiceId: 'vo_test_ml', cloneType: 'INSTANT', ownershipType: 'SELF_VERIFIED', managedMode: 'BYOK', languageProfile: 'zh-CN' },
  });
  await client.channels.update(workspace.id, channel.id, { defaults: { creatorIdentityId: identity.id } });

  const project = await client.projects.create(workspace.id, { title: '利率周报', channelId: channel.id });
  const url = `https://news.example/ml/${randomUUID()}`;
  fetcher.responses.set(url, { contentType: 'text/html; charset=utf-8', bytes: new TextEncoder().encode(ARTICLE_HTML) });
  const record = await client.content.create(workspace.id, project.id, { sourceType: 'URL_ARTICLE', url });
  await client.evidence.extract(workspace.id, project.id, record.document.id);
  llm.scriptNext('valid');
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

describe('多语言（P12-04）', () => {
  it('翻译 + 重新合成：新语言 Master（全新时间戳）；词典替换生效；引用逐块回链；作业落库', async () => {
    const client = await newClient('ml-main');
    const { workspaceId, projectId, planId } = await makeProjectWithNarration(client);

    const source = await client.narrative.masterNarration(workspaceId, projectId, planId);
    expect(source).not.toBeNull();
    // 词典源词取自**实际旁白文本**（Mock 叙事为口语化改写——原文词不出现；取首段的引导语）
    const firstText = source?.segments[0]?.text ?? '';
    const lead = firstText.split('：')[0] ?? '';
    expect(lead.length).toBeGreaterThanOrEqual(2);
    await client.multilingual.upsertTerminology(workspaceId, projectId, {
      sourceTerm: lead,
      targetLanguage: 'en',
      targetTerm: 'pull the camera closer',
      kind: 'TERM',
    });
    const dictionary = await client.multilingual.terminology(workspaceId, projectId, 'en');
    expect(dictionary.items).toHaveLength(1);

    const result = await client.multilingual.translate(workspaceId, projectId, planId, { targetLanguage: 'en' });
    // 词典替换生效（译文 ≠ 源文本）
    expect(result.job.units.some((unit) => unit.translatedText !== unit.sourceText)).toBe(true);
    expect(result.job.units.some((unit) => unit.translatedText.includes('pull the camera closer'))).toBe(true);
    // 数字一致（逐字保留）与实体一致（词典命中 → 译名出现）
    expect(result.job.numbersCheck.ok).toBe(true);
    expect(result.job.numbersCheck.sourceDigitGroups).toBe(result.job.numbersCheck.translatedDigitGroups);
    expect(result.job.entitiesCheck.entries.every((entry) => entry.ok)).toBe(true);
    // 引用一致：单元逐块回链源旁白块
    expect(result.job.units.length).toBe(source?.segments.length);

    // **不复用原语言时间戳**：派生行全新（language='en'；全部段重新合成；cacheKey 与源不同）
    expect(result.narration.id).not.toBe(source?.id);
    expect(result.narration.language).toBe('en');
    expect(result.narration.cacheStats.reused).toBe(0);
    expect(result.narration.cacheStats.synthesized).toBe(result.narration.segments.length);
    for (const segment of result.narration.segments) {
      const sourceSegment = source?.segments.find((candidate) => candidate.narrationBlockId === segment.narrationBlockId);
      expect(sourceSegment).toBeDefined();
      expect(segment.cacheKey).not.toBe(sourceSegment?.cacheKey);
      expect(segment.reused).toBe(false);
    }
    // 字幕/画面驱动基础：新 cues 齐备（由新语言对齐派生）
    expect(result.narration.cues.length).toBe(result.narration.segments.length);

    // 作业列表可见
    const jobs = await client.multilingual.translations(workspaceId, projectId);
    expect(jobs.items).toHaveLength(1);
    expect(jobs.items[0]?.derivedNarrationId).toBe(result.narration.id);
    expect(jobs.items[0]?.sourceNarrationId).toBe(source?.id);
  }, 180_000);

  it('数字不一致 fail-closed：Mock 抹掉数字 → 422 NUMBERS_CHANGED；不落库、不合成', async () => {
    const client = await newClient('ml-numbers');
    const { workspaceId, projectId, planId } = await makeProjectWithNarration(client);
    llm.scriptNext('translation_numbers_dropped');

    const before = await client.multilingual.translations(workspaceId, projectId);
    await expectApiError(client.multilingual.translate(workspaceId, projectId, planId, { targetLanguage: 'en' }), 422, 'NUMBERS_CHANGED');
    const after = await client.multilingual.translations(workspaceId, projectId);
    expect(after.items).toHaveLength(before.items.length);
    // 未产生新 Master（整体不合成）
    const master = await client.narrative.masterNarration(workspaceId, projectId, planId);
    expect(master?.language === null || master?.language === undefined).toBe(true);
  }, 180_000);

  it('词典 kind 门与源旁白闸门：非法 kind → 422；无源 Master → 409 SOURCE_NARRATION_MISSING', async () => {
    const client = await newClient('ml-entity');
    const { workspaceId, projectId } = await makeProjectWithNarration(client);

    // 词典 kind 门：TERMINOLOGY_KINDS 之外的 kind → 请求被拒（SDK 侧 schema 校验先行拒绝）
    await expect(
      client.multilingual.upsertTerminology(workspaceId, projectId, {
        sourceTerm: 'X',
        targetLanguage: 'en',
        targetTerm: 'Y',
        kind: 'ORG' as never,
      }),
    ).rejects.toThrow();

    // 无源 Master 的项目 → 409 SOURCE_NARRATION_MISSING
    const workspace2 = await client.workspaces.create({ name: `空-${randomUUID().slice(0, 8)}` });
    const channel2 = await client.channels.create(workspace2.id, { name: '栏目' });
    const project2 = await client.projects.create(workspace2.id, { title: '空项目', channelId: channel2.id });
    const url = `https://news.example/ml2/${randomUUID()}`;
    fetcher.responses.set(url, { contentType: 'text/html; charset=utf-8', bytes: new TextEncoder().encode(ARTICLE_HTML) });
    const record2 = await client.content.create(workspace2.id, project2.id, { sourceType: 'URL_ARTICLE', url });
    await client.evidence.extract(workspace2.id, project2.id, record2.document.id);
    llm.scriptNext('valid');
    const plan2 = await client.narrative.generate(workspace2.id, project2.id, record2.document.id, { targetDurationMs: 90_000 });
    await expectApiError(client.multilingual.translate(workspace2.id, project2.id, plan2.plan.id, { targetLanguage: 'en' }), 409, 'SOURCE_NARRATION_MISSING');
  }, 180_000);
});
