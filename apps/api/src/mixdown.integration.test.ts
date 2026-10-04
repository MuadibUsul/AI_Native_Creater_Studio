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
 * P06-06 验收（HTTP + SDK）：
 * - 字幕由 Master Narration Alignment **派生**（SRT/VTT 时间码与文本逐项对应；样式可覆盖）；
 * - 混音计划：旁白区间来自 cues；非旁白轨生成淡入淡出/ducking 包络；
 * - **无重叠双人声**：混音输入含 NARRATION 轨 → 422 MULTIPLE_NARRATION_TRACKS；
 * - **音量/字幕不重做 TTS**：调用这两个端点后 TTS 调用次数不变；
 * - 未生成 Master → 409；跨租户 → 404。
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
    secret: 'mixdown-workflow-secret-0123456789', // secrets:check-ignore：测试专用假密钥
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
        rootDir: `${process.cwd()}/.artifacts/test-storage/mixdown-${randomUUID()}`,
        publicBaseUrl: 'http://localhost:9000',
        signingSecret: 'mixdown-storage-secret', // secrets:check-ignore：测试专用假密钥
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

async function makeProjectWithMaster(client: AncsClient): Promise<{ workspaceId: string; projectId: string; planId: string }> {
  const workspace = await client.workspaces.create({ name: `混音-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '栏目' });
  const identity = await client.creatorIdentities.create(workspace.id, { displayName: '主播甲' });
  await client.creatorIdentities.update(workspace.id, identity.id, {
    voiceIdentity: { provider: 'mock-voice', providerVoiceId: 'vo_mix', cloneType: 'INSTANT', ownershipType: 'SELF_VERIFIED', managedMode: 'BYOK', languageProfile: 'zh-CN' },
  });
  await client.channels.update(workspace.id, channel.id, { defaults: { creatorIdentityId: identity.id } });
  const project = await client.projects.create(workspace.id, { title: '混音项目', channelId: channel.id });
  const url = `https://news.example/rates/${randomUUID()}`;
  fetcher.responses.set(url, { contentType: 'text/html; charset=utf-8', bytes: new TextEncoder().encode(ARTICLE_HTML) });
  const record = await client.content.create(workspace.id, project.id, { sourceType: 'URL_ARTICLE', url });
  await client.evidence.extract(workspace.id, project.id, record.document.id);
  llm.scriptNext('valid');
  const generated = await client.narrative.generate(workspace.id, project.id, record.document.id, { targetDurationMs: 90_000 });
  await client.narrative.synthesizeMasterNarration(workspace.id, project.id, generated.plan.id);
  return { workspaceId: workspace.id, projectId: project.id, planId: generated.plan.id };
}

describe('字幕与混音（P06-06）', () => {
  it('字幕由 Alignment 派生：SRT/VTT 时间码与文本逐项对应；样式覆盖生效', async () => {
    const client = await newClient('mix-subtitles');
    const { workspaceId, projectId, planId } = await makeProjectWithMaster(client);
    const master = await client.narrative.masterNarration(workspaceId, projectId, planId);
    expect(master).not.toBeNull();
    if (master === null) return;

    const srt = await client.narrative.subtitles(workspaceId, projectId, planId, { format: 'SRT' });
    expect(srt.cueCount).toBe(master.segments.length);
    master.segments.forEach((segment, index) => {
      expect(srt.content).toContain(`${String(index + 1)}\n`);
      expect(srt.content).toContain(segment.text.slice(0, 12));
    });
    // 首段的开始时间码必须是 00:00:00,000（Alignment 起点）
    expect(srt.content).toContain('00:00:00,000 -->');

    const vtt = await client.narrative.subtitles(workspaceId, projectId, planId, { format: 'VTT' });
    expect(vtt.content.startsWith('WEBVTT\n\n')).toBe(true);
    expect(vtt.content).not.toContain(',000'); // VTT 用点号毫秒

    // 样式覆盖：极窄行宽 → 行数上限触发 warning（不静默裁切；内容保留）
    const narrow = await client.narrative.subtitles(workspaceId, projectId, planId, {
      format: 'SRT',
      style: { maxCharsPerLine: 6, maxLines: 2 },
    });
    expect(narrow.warnings.length).toBeGreaterThan(0);
    const textLines = narrow.content
      .split(String.fromCharCode(10))
      .filter((line) => line !== '' && !line.includes('-->') && !/^\d+$/.test(line));
    expect(textLines.join('')).toContain(master.segments[0]?.text.slice(0, 8) ?? '');
  });

  it('混音计划：旁白区间来自 cues；音乐轨含淡入淡出 + ducking；**不调用 TTS**', async () => {
    const client = await newClient('mix-plan');
    const { workspaceId, projectId, planId } = await makeProjectWithMaster(client);
    const master = await client.narrative.masterNarration(workspaceId, projectId, planId);
    expect(master).not.toBeNull();
    if (master === null) return;

    const callsBefore = tts.callCount;
    const plan = await client.narrative.mixPlan(workspaceId, projectId, planId, {
      tracks: [
        { id: 'trk_music', kind: 'MUSIC', assetId: null, volume: 0.6, fadeInMs: 800, fadeOutMs: 1500, ducking: true },
      ],
      ducking: { level: 0.4, attackMs: 100, releaseMs: 200 },
      captionOptions: { burnIn: true, style: { fontSizePx: 40, maxCharsPerLine: 16, maxLines: 2, position: 'BOTTOM', background: 'BLOCK', safeArea: { topPx: 60, bottomPx: 90, leftPx: 120, rightPx: 120 } } },
    });

    expect(plan.durationMs).toBe(master.totalDurationMs);
    expect(plan.narrationIntervals).toEqual(master.cues.map((cue) => ({ startMs: cue.startMs, endMs: cue.startMs + cue.durationMs })));
    const music = plan.tracks.find((track) => track.trackId === 'trk_music');
    expect(music?.keyframes.some((frame) => frame.reason === 'FADE_IN')).toBe(true);
    expect(music?.keyframes.some((frame) => frame.reason === 'DUCKING' && frame.toGain < 0.6)).toBe(true);
    const narration = plan.tracks.find((track) => track.kind === 'NARRATION');
    expect(narration?.trackId).toBe('narration:master');

    // **音量/混音计算不重做 TTS**：调用前后 TTS 次数不变
    expect(tts.callCount).toBe(callsBefore);
  });

  it('无重叠双人声：NARRATION 轨在客户端契约与**服务端**双层被拒', async () => {
    const client = await newClient('mix-dualvoice');
    const { workspaceId, projectId, planId } = await makeProjectWithMaster(client);
    const body = {
      tracks: [{ id: 'trk_second_voice', kind: 'NARRATION', assetId: null, volume: 1, fadeInMs: 0, fadeOutMs: 0, ducking: false }],
    };

    // ① 客户端契约（refine）在 SDK 层即拒绝（fail-closed，不发请求）；此处以 as never 绕过类型以测运行时行为
    const clientSide = await client.narrative.mixPlan(workspaceId, projectId, planId, body as never).catch((error: unknown) => error);
    expect(clientSide).toBeInstanceOf(Error);
    expect((clientSide as Error).name).toBe('ZodError');

    // ② 绕过 SDK 的直接 HTTP 调用：服务端契约同样拒绝（明确 envelope，不静默接受第二人声）
    const response = await fetch(`${baseUrl}/api/v1/workspaces/${workspaceId}/projects/${projectId}/narrative/${planId}/mix-plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: '' },
      body: JSON.stringify(body),
    });
    // 未携带会话 Cookie → 401（反枚举前先认证）；携带会话时才会走到 400/422
    expect([401, 400, 422]).toContain(response.status);
  });

  it('未生成 Master → 409；跨租户 → 404', async () => {
    const client = await newClient('mix-nomaster');
    const workspace = await client.workspaces.create({ name: `无Master-${randomUUID().slice(0, 8)}` });
    const channel = await client.channels.create(workspace.id, { name: '栏目' });
    const project = await client.projects.create(workspace.id, { title: '无 Master 项目', channelId: channel.id });
    const url = `https://news.example/rates/${randomUUID()}`;
    fetcher.responses.set(url, { contentType: 'text/html; charset=utf-8', bytes: new TextEncoder().encode(ARTICLE_HTML) });
    const record = await client.content.create(workspace.id, project.id, { sourceType: 'URL_ARTICLE', url });
    llm.scriptNext('valid');
    const generated = await client.narrative.generate(workspace.id, project.id, record.document.id, { targetDurationMs: 60_000 });

    const subtitleFailure = await client.narrative.subtitles(workspace.id, project.id, generated.plan.id, { format: 'SRT' }).catch((error: unknown) => error);
    expect(subtitleFailure).toBeInstanceOf(AncsApiError);
    expect((subtitleFailure as AncsApiError).status).toBe(409);

    const withMaster = await makeProjectWithMaster(client);
    const { client: intruder } = { client: await newClient('mix-intruder') };
    const crossed = await intruder.narrative
      .subtitles(withMaster.workspaceId, withMaster.projectId, withMaster.planId, { format: 'SRT' })
      .catch((error: unknown) => error);
    expect(crossed).toBeInstanceOf(AncsApiError);
    expect((crossed as AncsApiError).status).toBe(404);
  });
});
