import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, packArtifacts, plans, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, workspaces, type DbHandle } from '@ancs/db';
import { ensureDefaultPlans, type DomainDeps } from '@ancs/domain';
import { MockLlmAdapter } from '@ancs/providers-mock-llm';
import { and, eq } from 'drizzle-orm';
import type { ArticleFetcher } from '@ancs/contracts';
import { buildServer } from './server.js';

/**
 * P12-02 验收（真实 DB）：Social Visual Pack（1:1 / 4:5 / Carousel / 信息图）。
 * - generate：页序（封面 → 观点/图表页 → 信息图 → 来源页）；平台尺寸 1:1=1080×1080、4:5=1080×1350；
 *   图表数值逐字来自 Atom 载荷（可追溯，不虚构）；署名来自来源元数据；长文本按预算拆页（续页显式衔接）；
 * - validate：页序/尺寸/署名/图表可追溯/文字预算逐项检查；篡改可复现报错；
 * - 原长视频不被修改（产物只附加）。
 */

const ARTICLE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>利率周报</title></head><body>
<h1>美联储利率决议</h1><p>联邦基金利率维持在 5.25% 不变。市场预计年内降息一次。核心通胀升至 3.2%。</p></body></html>`;

let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let llm: MockLlmAdapter;
const PASSWORD = 'password-1234';
const SOCIAL_PACK = 'ancs.pack.social-visual';
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
  auth = createAuth({ db: handle.db, secret: 'social-secret-0123456789', baseUrl: 'http://localhost:3001' }); // secrets:check-ignore：测试专用假密钥
  llm = new MockLlmAdapter();
  app = await buildServer({
    auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
    content: { articleFetcher: fetcher, llm },
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

async function makeProjectWithAtoms(client: AncsClient): Promise<{ workspaceId: string; projectId: string }> {
  const workspace = await client.workspaces.create({ name: `图文-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '栏目' });
  const project = await client.projects.create(workspace.id, { title: '利率周报', channelId: channel.id });
  const url = `https://news.example/social/${randomUUID()}`;
  fetcher.responses.set(url, { contentType: 'text/html; charset=utf-8', bytes: new TextEncoder().encode(ARTICLE_HTML) });
  const record = await client.content.create(workspace.id, project.id, { sourceType: 'URL_ARTICLE', url });
  await client.evidence.extract(workspace.id, project.id, record.document.id);
  const claims = await client.evidence.claims(workspace.id, project.id);
  await client.content.contentCore.migrate(workspace.id, project.id);
  const claimId = claims[0]?.id ?? '';
  await client.content.atoms.create(workspace.id, project.id, {
    kind: 'KEY_NUMBER',
    title: '利率维持 5.25%',
    // 长文本（> 单页 180 字预算）——验证按预算拆页与续页衔接
    text: [
      '联邦基金利率维持在 5.25% 不变。',
      '这是美联储连续第三次会议按兵不动，符合市场预期。',
      '点阵图显示多数官员认为年内仍有一次降息空间。',
      '市场预计年内降息一次，最早可能在十二月。',
      '核心通胀升至 3.2%，距离百分之二的目标仍有明显距离。',
      '就业数据保持韧性，失业率维持在低位，为维持利率提供了支撑。',
      '鲍威尔在记者会上表示，需要更多数据确认通胀回落的可持续性。',
      '两年期美债收益率回落，美元指数走弱。',
      '机构普遍认为，降息路径仍将取决于后续的通胀与就业数据。',
    ].join(''),
    payload: { value: 5.25, unit: '%' },
    sourceRefs: [{ claimId }],
  });
  await client.content.atoms.create(workspace.id, project.id, {
    kind: 'KEY_NUMBER',
    title: '核心通胀 3.2%',
    text: '核心通胀升至 3.2%。',
    payload: { value: 3.2, unit: '%' },
    sourceRefs: [{ claimId }],
  });
  await client.content.atoms.create(workspace.id, project.id, {
    kind: 'SUB_TOPIC',
    title: '降息预期',
    text: '市场预计年内降息一次。交易员押注 12 月降息概率超过七成。',
    sourceRefs: [{ claimId }],
  });
  await client.packs.enable(workspace.id, SOCIAL_PACK);
  await client.packs.bind(workspace.id, project.id, SOCIAL_PACK);
  return { workspaceId: workspace.id, projectId: project.id };
}

async function expectApiError(promise: Promise<unknown>, status: number, reason?: string): Promise<AncsApiError> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AncsApiError);
  const apiError = error as AncsApiError;
  expect(apiError.status).toBe(status);
  if (reason !== undefined) expect((apiError.details as { reason?: string }).reason).toBe(reason);
  return apiError;
}

describe('Social Visual Pack（P12-02）', () => {
  it('generate：页序（封面→图表→信息图→来源页）、平台尺寸、图表可追溯、署名、长文本拆页', async () => {
    const client = await newClient('social-main');
    const { workspaceId, projectId } = await makeProjectWithAtoms(client);
    await client.packs.analyze(workspaceId, projectId, SOCIAL_PACK);
    const artifact = await client.packs.generate(workspaceId, projectId, SOCIAL_PACK);
    expect(artifact.payloadKind).toBe('SOCIAL_VISUAL_SET');
    const payload = artifact.payload;
    if (payload.kind !== 'SOCIAL_VISUAL_SET') throw new Error('unexpected payload kind');
    const pages = payload.pages;

    // 页序：index 连续；封面在前（1:1 + 4:5 两张）；来源页最后
    expect(pages.map((page) => page.index)).toEqual(pages.map((_, position) => position));
    expect(pages[0]?.role).toBe('COVER');
    expect(pages[0]?.platformKey).toBe('SQUARE_1X1');
    expect(pages[1]?.role).toBe('COVER');
    expect(pages[1]?.platformKey).toBe('PORTRAIT_4X5');
    expect(pages[pages.length - 1]?.role).toBe('SOURCE');

    // 平台尺寸：1:1 = 1080×1080；4:5 = 1080×1350
    const square = pages.filter((page) => page.platformKey === 'SQUARE_1X1');
    const portrait = pages.filter((page) => page.platformKey === 'PORTRAIT_4X5');
    expect(square.every((page) => page.format.width === 1080 && page.format.height === 1080)).toBe(true);
    expect(portrait.every((page) => page.format.width === 1080 && page.format.height === 1350)).toBe(true);

    // 图表：数字 Atom（2 个）→ CHART 页，数值逐字来自 Atom 载荷且可追溯
    const charts = pages.filter((page) => page.role === 'CHART');
    expect(charts).toHaveLength(2);
    expect(charts.every((page) => page.componentId === 'BIG_NUMBER' && page.dataSource?.kind === 'ATOM_PAYLOAD')).toBe(true);
    expect(charts.map((page) => page.text).join('|')).toContain('5.25%');

    // 信息图（1:1 KPI_GRID）
    const infographic = pages.find((page) => page.role === 'INFOGRAPHIC');
    expect(infographic?.platformKey).toBe('SQUARE_1X1');
    expect(infographic?.componentId).toBe('KPI_GRID');

    // 署名：来源页携带署名文本与来源引用
    const sourcePage = pages[pages.length - 1];
    expect(sourcePage?.attribution?.text).toBeTruthy();
    expect((sourcePage?.attribution?.sourceIds.length ?? 0)).toBeGreaterThan(0);

    // 长文本拆页：主 Atom 3 句 → 多个 POINT 页（续页显式衔接）；每页不超 180 字预算
    const points = pages.filter((page) => page.role === 'POINT');
    expect(points.length).toBeGreaterThanOrEqual(2);
    expect(points[0]?.continuationOf).toBeNull();
    expect(points[1]?.continuationOf).toBe(points[0]?.pageId);
    expect(points.every((page) => page.textChars <= 180)).toBe(true);

    // 原项目不被修改
    const graph = await client.projects.graph(projectId);
    expect(graph.scenes).toHaveLength(0);

    // validate：自产产物零 error（页数/窗口类偏差以 warning 披露）
    const validation = await client.packs.artifacts.validate(workspaceId, projectId, artifact.artifactId);
    expect(validation.ok).toBe(true);
    expect(validation.issues.filter((issue) => issue.severity === 'error')).toHaveLength(0);
  }, 120_000);

  it('validate 篡改可复现：页序/尺寸/署名/图表可追溯/文字预算逐项报错', async () => {
    const client = await newClient('social-tamper');
    const { workspaceId, projectId } = await makeProjectWithAtoms(client);
    await client.packs.analyze(workspaceId, projectId, SOCIAL_PACK);
    const artifact = await client.packs.generate(workspaceId, projectId, SOCIAL_PACK);
    const payload = artifact.payload;
    if (payload.kind !== 'SOCIAL_VISUAL_SET') throw new Error('unexpected payload kind');
    const tampered = structuredClone(payload);
    // 篡改 1：来源页换到最前（页序无效）
    const sourcePageIndex = tampered.pages.findIndex((page) => page.role === 'SOURCE');
    const [sourcePage] = tampered.pages.splice(sourcePageIndex, 1);
    if (sourcePage !== undefined) tampered.pages.unshift(sourcePage);
    tampered.pages.forEach((page, position) => {
      page.index = position;
    });
    // 篡改 2：封面尺寸改成 1080×1080 冒充 4:5 平台
    const portraitCover = tampered.pages.find((page) => page.platformKey === 'PORTRAIT_4X5');
    if (portraitCover !== undefined) portraitCover.format = { width: 1080, height: 1080, fps: 30, aspectRatio: '1:1' };
    // 篡改 3：清除署名
    const sourcePageNow = tampered.pages.find((page) => page.role === 'SOURCE');
    if (sourcePageNow !== undefined) sourcePageNow.attribution = null;
    // 篡改 4：图表页 dataSource 指向不存在的 Atom
    const chart = tampered.pages.find((page) => page.role === 'CHART');
    if (chart !== undefined) chart.dataSource = { kind: 'ATOM_PAYLOAD', atomId: 'atom_missing' };
    // 篡改 5：观点页文字超预算
    const point = tampered.pages.find((page) => page.role === 'POINT');
    if (point !== undefined) {
      point.text = '超'.repeat(200);
      point.textChars = 200;
    }
    await handle.db
      .update(packArtifacts)
      .set({ payload: tampered })
      .where(and(eq(packArtifacts.id, artifact.artifactId), eq(packArtifacts.workspaceId, workspaceId)));

    const validation = await client.packs.artifacts.validate(workspaceId, projectId, artifact.artifactId);
    expect(validation.ok).toBe(false);
    const codes = validation.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.code);
    expect(codes).toContain('PAGE_ORDER_INVALID');
    expect(codes).toContain('PLATFORM_SIZE_INVALID');
    expect(codes).toContain('ATTRIBUTION_MISSING');
    expect(codes).toContain('CHART_DATA_UNTRACEABLE');
    expect(codes).toContain('TEXT_OVERFLOW');
  }, 120_000);

  it('闸门与窗口：未 analyze → 409；素材偏薄时页数/图表缺口以 warning 披露（不冒充达标）', async () => {
    const client = await newClient('social-gates');
    const { workspaceId, projectId } = await makeProjectWithAtoms(client);
    await expectApiError(client.packs.generate(workspaceId, projectId, SOCIAL_PACK), 409, 'ANALYZE_REQUIRED');

    // 素材偏薄场景：单条非数字 Atom（短文本）→ 竖版页 3（封面/观点/来源）< Recipe 下限 6 且无图表
    const thin = await client.workspaces.create({ name: `薄-${randomUUID().slice(0, 8)}` });
    const thinChannel = await client.channels.create(thin.id, { name: '栏目' });
    const thinProject = await client.projects.create(thin.id, { title: '薄内容', channelId: thinChannel.id });
    const thinUrl = `https://news.example/thin/${randomUUID()}`;
    fetcher.responses.set(thinUrl, { contentType: 'text/html; charset=utf-8', bytes: new TextEncoder().encode(ARTICLE_HTML) });
    const thinRecord = await client.content.create(thin.id, thinProject.id, { sourceType: 'URL_ARTICLE', url: thinUrl });
    await client.evidence.extract(thin.id, thinProject.id, thinRecord.document.id);
    const thinClaims = await client.evidence.claims(thin.id, thinProject.id);
    await client.content.atoms.create(thin.id, thinProject.id, {
      kind: 'SUB_TOPIC',
      title: '降息预期',
      text: '市场预计年内降息一次。',
      sourceRefs: [{ claimId: thinClaims[0]?.id ?? '' }],
    });
    await client.packs.enable(thin.id, SOCIAL_PACK);
    await client.packs.bind(thin.id, thinProject.id, SOCIAL_PACK);
    await client.packs.analyze(thin.id, thinProject.id, SOCIAL_PACK);
    const thinArtifact = await client.packs.generate(thin.id, thinProject.id, SOCIAL_PACK);
    const validation = await client.packs.artifacts.validate(thin.id, thinProject.id, thinArtifact.artifactId);
    expect(validation.ok).toBe(true); // 无 error；差额以 warning 明示
    const windowIssue = validation.issues.find((issue) => issue.code === 'PAGE_COUNT_OUT_OF_RECIPE');
    expect(windowIssue?.severity).toBe('warning');
    expect(windowIssue?.message).toContain('6');
    expect(validation.issues.find((issue) => issue.code === 'NO_CHART_PAGE')?.severity).toBe('warning');
  }, 120_000);
});
