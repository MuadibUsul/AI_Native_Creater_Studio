import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { ApiFailure, errorEnvelopeSchema, type ArticleFetcher } from '@ancs/contracts';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import {
  contentBlocks,
  contentDocuments,
  createDb,
  projectSources,
  redactDatabaseUrl,
  resolveTestDatabaseUrl,
  runMigrations,
  type DbHandle,
} from '@ancs/db';
import { assertSafeUrl } from '@ancs/domain';
import { buildServer } from './server.js';

/**
 * P04-01 验收（HTTP + SDK，真实 DB；抓取器脚本化）：
 * - URL 文章 / 粘贴正文 / 手写脚本 → 统一 ContentDocument（块落库、来源与快照事实）；
 * - **明确结果**：URL 异常、安全限制（SSRF）、空正文、错误编码、超大、不支持类型；
 * - Sources 编辑（仅元数据）；跨租户 404、VIEWER 403。
 */

let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;

/** 脚本化文章抓取器（逐跳 SSRF 校验与限制在真实实现中；此处模拟其对外行为） */
class ScriptedFetcher implements ArticleFetcher {
  readonly kind = 'scripted';
  responses = new Map<string, { finalUrl?: string; contentType: string | null; bytes: Uint8Array }>();
  failures = new Map<string, ApiFailure>();
  async fetch(input: { url: string }): Promise<{ finalUrl: string; contentType: string | null; bytes: Uint8Array }> {
    const failure = this.failures.get(input.url);
    if (failure !== undefined) throw failure;
    const response = this.responses.get(input.url);
    if (response === undefined) throw new ApiFailure('INTERNAL', `目标不可达：${input.url}`, 502, { reason: 'UNREACHABLE' });
    return { finalUrl: response.finalUrl ?? input.url, contentType: response.contentType, bytes: response.bytes };
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
    secret: 'content-workflow-secret-0123456789', // secrets:check-ignore：测试专用假密钥
    baseUrl: 'http://localhost:3001',
  });
  app = await buildServer({
    auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
    content: { articleFetcher: fetcher },
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

async function makeProject(client: AncsClient): Promise<{ workspaceId: string; projectId: string }> {
  const workspace = await client.workspaces.create({ name: `内容-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '栏目' });
  const project = await client.projects.create(workspace.id, { title: '内容项目', channelId: channel.id });
  return { workspaceId: workspace.id, projectId: project.id };
}

const ARTICLE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>市场周报</title></head><body>
<h1>本周市场回顾</h1>
<p>美股三大指数集体上涨，<strong>科技股</strong>领涨。</p>
<ul><li>纳斯达克 +2.1%</li><li>标普 500 +1.4%</li></ul>
<table><thead><tr><th>指数</th><th>周涨幅</th></tr></thead><tbody><tr><td>纳斯达克</td><td>2.1%</td></tr></tbody></table>
<img src="https://cdn.example/chart.png" alt="指数走势">
</body></html>`;

describe('输入归一化（P04-01）', () => {
  it('URL 文章 → ContentDocument + Source（快照哈希）；块落库可读回', async () => {
    const { client } = await newClient('content-url');
    const { workspaceId, projectId } = await makeProject(client);
    const url = `https://news.example/articles/${randomUUID()}`;
    fetcher.responses.set(url, { contentType: 'text/html; charset=utf-8', bytes: new TextEncoder().encode(ARTICLE_HTML) });

    const record = await client.content.create(workspaceId, projectId, { sourceType: 'URL_ARTICLE', url });
    expect(record.document.title).toBe('本周市场回顾');
    expect(record.document.language).toBe('zh');
    expect(record.document.blocks.length).toBeGreaterThanOrEqual(5);
    expect(record.normalization).toMatchObject({ sourceType: 'URL_ARTICLE', charset: 'utf-8', fetchedUrl: url, finalUrl: url });
    expect(record.normalization.tables).toBe(1);
    expect(record.normalization.figures).toBe(1);
    expect(record.document.tables).toHaveLength(1);
    expect(record.document.figures).toHaveLength(1);
    // 任何输入先归一化：claims 留空（抽取属 P04-02）
    expect(record.document.claims).toEqual([]);

    // 来源与快照事实（contentHash = 存储摘录的 sha256）
    const sources = await client.content.sources(workspaceId, projectId);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ url, publisher: 'news.example', snapshotKind: 'live_fetch' });
    expect(sources[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/);

    // 数据库侧：规范化块（不是整篇一个大 JSON）
    const rows = await handle.db.select().from(contentBlocks).where(eq(contentBlocks.documentId, record.document.id));
    expect(rows.length).toBe(record.document.blocks.length);
    expect(rows.map((row) => row.position)).toEqual(rows.map((_row, index) => index));

    // 读回（列表/详情）
    const list = await client.content.list(workspaceId, projectId);
    expect(list).toHaveLength(1);
    const detail = await client.content.get(workspaceId, projectId, record.document.id);
    expect(detail.document.blocks.map((block) => block.type)).toEqual(record.document.blocks.map((block) => block.type));
  });

  it('粘贴正文与手写脚本：Markdown/分行解析；空输入 → 明确结果', async () => {
    const { client } = await newClient('content-text');
    const { workspaceId, projectId } = await makeProject(client);

    const pasted = await client.content.create(workspaceId, projectId, {
      sourceType: 'PASTED_TEXT',
      text: '# 标题\n\n第一段。\n\n- A\n- B',
    });
    expect(pasted.document.blocks.map((block) => block.type)).toEqual(['heading', 'paragraph', 'list']);
    expect(pasted.document.sourceUrl).toBeUndefined(); // 粘贴文本没有来源 URL

    const script = await client.content.create(workspaceId, projectId, {
      sourceType: 'MANUAL_SCRIPT',
      text: '开场白\n第一幕：冲突\n第二幕：解决',
      title: '我的脚本',
    });
    expect(script.document.title).toBe('我的脚本');
    expect(script.document.blocks).toHaveLength(3);

    const empty = await client.content
      .create(workspaceId, projectId, { sourceType: 'PASTED_TEXT', text: '   \n  ' })
      .catch((error: unknown) => error);
    expect(empty).toBeInstanceOf(AncsApiError);
    expect(empty).toMatchObject({ status: 422, code: 'VALIDATION_FAILED' });
    expect((empty as AncsApiError).details['reason']).toBe('EMPTY_INPUT');
  });

  it('URL 异常与安全限制有明确结果：非法 URL、SSRF 目标、不可达、超大、类型不支持、空正文、错误编码', async () => {
    const { client } = await newClient('content-errors');
    const { workspaceId, projectId } = await makeProject(client);

    // 非法 URL（抓取前即拒）
    const invalid = await client.content.create(workspaceId, projectId, { sourceType: 'URL_ARTICLE', url: 'not-a-url' }).catch((error: unknown) => error);
    expect(invalid).toMatchObject({ status: 400 });
    expect((invalid as AncsApiError).details['reason']).toBe('INVALID_URL');

    // 安全限制：内网/回环（真实实现逐跳校验；此处直接断言守卫本身）
    expect(() => assertSafeUrl('http://127.0.0.1:8080/admin')).toThrow(/安全限制/);
    expect(() => assertSafeUrl('http://169.254.169.254/latest/meta-data')).toThrow(/安全限制/);
    // 抓取器对 SSRF 目标的拒绝（脚本化模拟真实实现的响应）
    const blockedUrl = 'http://192.168.1.10/secret';
    fetcher.failures.set(blockedUrl, new ApiFailure('FORBIDDEN', '安全限制：拒绝访问内网', 403, { reason: 'BLOCKED_TARGET' }));
    const blocked = await client.content.create(workspaceId, projectId, { sourceType: 'URL_ARTICLE', url: blockedUrl }).catch((error: unknown) => error);
    expect(blocked).toMatchObject({ status: 403 });
    expect((blocked as AncsApiError).details['reason']).toBe('BLOCKED_TARGET');

    // 不可达
    const unreachable = await client.content
      .create(workspaceId, projectId, { sourceType: 'URL_ARTICLE', url: 'https://unreachable.example/x' })
      .catch((error: unknown) => error);
    expect(unreachable).toMatchObject({ status: 502 });
    expect((unreachable as AncsApiError).details['reason']).toBe('UNREACHABLE');

    // 超大
    const bigUrl = `https://news.example/big/${randomUUID()}`;
    fetcher.failures.set(bigUrl, new ApiFailure('VALIDATION_FAILED', '文章超过大小上限', 413, { reason: 'TOO_LARGE' }));
    const tooLarge = await client.content.create(workspaceId, projectId, { sourceType: 'URL_ARTICLE', url: bigUrl }).catch((error: unknown) => error);
    expect(tooLarge).toMatchObject({ status: 413 });
    expect((tooLarge as AncsApiError).details['reason']).toBe('TOO_LARGE');

    // 类型不支持（PDF）
    const pdfUrl = `https://news.example/paper/${randomUUID()}.pdf`;
    fetcher.responses.set(pdfUrl, { contentType: 'application/pdf', bytes: new TextEncoder().encode('%PDF-1.7') });
    const unsupported = await client.content.create(workspaceId, projectId, { sourceType: 'URL_ARTICLE', url: pdfUrl }).catch((error: unknown) => error);
    expect(unsupported).toMatchObject({ status: 415 });
    expect((unsupported as AncsApiError).details['reason']).toBe('UNSUPPORTED_CONTENT_TYPE');

    // 空正文（页面只有脚本/导航）
    const emptyPageUrl = `https://news.example/empty/${randomUUID()}`;
    fetcher.responses.set(emptyPageUrl, { contentType: 'text/html', bytes: new TextEncoder().encode('<html><body><nav>菜单</nav><script>x</script></body></html>') });
    const emptyPage = await client.content.create(workspaceId, projectId, { sourceType: 'URL_ARTICLE', url: emptyPageUrl }).catch((error: unknown) => error);
    expect(emptyPage).toMatchObject({ status: 422 });
    expect((emptyPage as AncsApiError).details['reason']).toBe('EMPTY_CONTENT');

    // 错误编码（声明 GBK 但内容乱码 → 替换字符占比过高）
    const badEncodingUrl = `https://news.example/garbled/${randomUUID()}`;
    const garbage = new Uint8Array(512).fill(0x81);
    fetcher.responses.set(badEncodingUrl, { contentType: 'text/html; charset=utf-8', bytes: garbage });
    const badEncoding = await client.content.create(workspaceId, projectId, { sourceType: 'URL_ARTICLE', url: badEncodingUrl }).catch((error: unknown) => error);
    expect(badEncoding).toMatchObject({ status: 400 });
    expect((badEncoding as AncsApiError).details['reason']).toBe('ENCODING_UNSUPPORTED');

    // 失败不产生任何文档/来源（明确结果且无副作用）
    expect(
      await handle.db.select().from(contentDocuments).where(and(eq(contentDocuments.workspaceId, workspaceId), eq(contentDocuments.projectId, projectId))),
    ).toHaveLength(0);
    expect(
      await handle.db.select().from(projectSources).where(and(eq(projectSources.workspaceId, workspaceId), eq(projectSources.projectId, projectId))),
    ).toHaveLength(0);
  });

  it('Sources 编辑（仅元数据）：可改标题/备注；内容与哈希不可改；跨租户 404；VIEWER 403', async () => {
    const owner = await newClient('content-owner');
    const viewer = await newClient('content-viewer');
    const stranger = await newClient('content-stranger');
    const { workspaceId, projectId } = await makeProject(owner.client);
    await owner.client.workspaces.members.add(workspaceId, { email: viewer.email, role: 'VIEWER' });

    const url = `https://news.example/edit/${randomUUID()}`;
    fetcher.responses.set(url, { contentType: 'text/html; charset=utf-8', bytes: new TextEncoder().encode(ARTICLE_HTML) });
    await owner.client.content.create(workspaceId, projectId, { sourceType: 'URL_ARTICLE', url });
    const sources = await owner.client.content.sources(workspaceId, projectId);
    const source = sources[0];
    expect(source).toBeDefined();
    const originalHash = source?.contentHash;

    const updated = await owner.client.content.updateSource(workspaceId, projectId, source?.id ?? '', {
      title: '修订后的来源标题',
      note: '编辑说明：标题以官方发布为准',
    });
    expect(updated.title).toBe('修订后的来源标题');
    expect(updated.note).toBe('编辑说明：标题以官方发布为准');
    expect(updated.contentHash).toBe(originalHash); // 快照事实不可改

    // VIEWER 可读不可写
    expect((await viewer.client.content.sources(workspaceId, projectId)).length).toBe(1);
    const viewerEdit = await viewer.client.content
      .updateSource(workspaceId, projectId, source?.id ?? '', { title: '越权' })
      .catch((error: unknown) => error);
    expect(viewerEdit).toBeInstanceOf(AncsApiError);
    expect(viewerEdit).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect((viewerEdit as AncsApiError).details['requiredCapability']).toBe('project:write');

    // 跨租户：404（抗枚举）
    const strangerFailure = await stranger.client.content
      .updateSource(workspaceId, projectId, source?.id ?? '', { title: 'x' })
      .catch((error: unknown) => error);
    expect(strangerFailure).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    const strangerList = await stranger.client.content.sources(workspaceId, projectId).catch((error: unknown) => error);
    expect(strangerList).toMatchObject({ status: 404 });
  });

  it('错误信封形状符合契约（HTTP 层 {error:{code,message,requestId,details}}）', async () => {
    const { client: ownerClient, email: ownerEmail } = await newClient('content-envelope');
    const { workspaceId, projectId } = await makeProject(ownerClient);

    // 用 inject 取会话 Cookie（SDK 的 Cookie jar 不对外暴露）
    const email = `content-envelope-extra-${randomUUID()}@test.local`;
    await createInternalUser(auth, { email, password: 'password-1234', name: '信封测试' });
    const signIn = await app.inject({ method: 'POST', url: '/api/v1/auth/sign-in', payload: { email, password: 'password-1234' } });
    const setCookie = signIn.headers['set-cookie'];
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(typeof cookieHeader).toBe('string');

    // 该新用户还不是 workspace 成员 → 期望 404（抗枚举）；再断言信封形状
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/content`,
      payload: { sourceType: 'URL_ARTICLE', url: 'not-a-url' },
      headers: { cookie: (cookieHeader as string).split(';')[0] ?? '' },
    });
    expect(response.statusCode).toBe(404);
    const envelope404 = errorEnvelopeSchema.parse(response.json());
    expect(envelope404.error.code).toBe('NOT_FOUND');

    // 成员（owner）的非法 URL → 400 信封并带 reason
    const ownerSignIn = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-in',
      payload: { email: ownerEmail, password: 'password-1234' },
    });
    const ownerSetCookie = ownerSignIn.headers['set-cookie'];
    const ownerCookieHeader = Array.isArray(ownerSetCookie) ? ownerSetCookie[0] : ownerSetCookie;
    const ownerCookie = typeof ownerCookieHeader === 'string' ? ownerCookieHeader.split(';')[0] : '';
    const invalid = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/content`,
      payload: { sourceType: 'URL_ARTICLE', url: 'not-a-url' },
      headers: { cookie: ownerCookie ?? '' },
    });
    expect(invalid.statusCode).toBe(400);
    const envelope = errorEnvelopeSchema.parse(invalid.json());
    expect(envelope.error.code).toBe('VALIDATION_FAILED');
    expect(envelope.error.details['reason']).toBe('INVALID_URL');
    expect(envelope.error.requestId.length).toBeGreaterThan(0);
  });
});
