import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, packArtifacts, plans, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, workspaces, type DbHandle } from '@ancs/db';
import { ensureDefaultPlans, type DomainDeps } from '@ancs/domain';
import { MockLlmAdapter } from '@ancs/providers-mock-llm';
import { and, eq } from 'drizzle-orm';
import type { ArticleFetcher } from '@ancs/contracts';
import { buildServer } from './server.js';

/**
 * P12-03 验收（真实 DB）：Text Pack（Thread / 短文 / 平台文案 / Newsletter）。
 * - **引用和事实不丢失**：正文（去前缀）必须由逐字引文重建；引文必须可追溯（无来源引文 = error）；
 * - **平台长度限制由 Recipe 校验**（TEXT_THREAD/TEXT_POST/NEWSLETTER 各自上限；未定义 → 明示未核验）；
 * - 生成器不产出超限单元：装不下时列入 unavailableFormats 并说明原因（不改文字、不截断）。
 */

const ARTICLE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>利率周报</title></head><body>
<h1>美联储利率决议</h1><p>联邦基金利率维持在 5.25% 不变。核心通胀升至 3.2%。</p></body></html>`;

let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let llm: MockLlmAdapter;
const PASSWORD = 'password-1234';
const TEXT_PACK = 'ancs.pack.text';
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
  auth = createAuth({ db: handle.db, secret: 'text-secret-0123456789', baseUrl: 'http://localhost:3001' }); // secrets:check-ignore：测试专用假密钥
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

async function makeProjectWithAtom(client: AncsClient): Promise<{ workspaceId: string; projectId: string }> {
  const workspace = await client.workspaces.create({ name: `文字-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '栏目' });
  const project = await client.projects.create(workspace.id, { title: '利率周报', channelId: channel.id });
  const url = `https://news.example/text/${randomUUID()}`;
  fetcher.responses.set(url, { contentType: 'text/html; charset=utf-8', bytes: new TextEncoder().encode(ARTICLE_HTML) });
  const record = await client.content.create(workspace.id, project.id, { sourceType: 'URL_ARTICLE', url });
  await client.evidence.extract(workspace.id, project.id, record.document.id);
  const claims = await client.evidence.claims(workspace.id, project.id);
  await client.content.contentCore.migrate(workspace.id, project.id);
  await client.content.atoms.create(workspace.id, project.id, {
    kind: 'SUB_TOPIC',
    title: '降息预期升温',
    // 长文本（> 单条 280 字符上限的 1.5 倍）——验证 Thread 装条与逐字引用
    text: [
      '联邦基金利率维持在 5.25% 不变，这是连续第三次会议按兵不动。',
      '市场预计年内降息一次，最早可能在十二月落地。',
      '交易员押注十二月降息概率超过七成，高于一个月前的五成。',
      '点阵图显示多数官员认为年内仍有一次降息空间。',
      '核心通胀升至 3.2%，距离百分之二的目标仍有明显距离。',
      '就业数据保持韧性，失业率维持在低位，为维持利率提供了支撑。',
      '鲍威尔在记者会上表示，需要更多数据确认通胀回落的可持续性。',
      '两年期美债收益率回落，美元指数走弱，金价小幅走高。',
      '机构普遍认为，降息路径仍将取决于后续的通胀与就业数据。',
      '多位经济学家提示，若通胀读数反复，降息时点可能进一步推迟。',
      '掉期市场定价显示，年底前累计降息幅度预期约为三十个基点。',
      '新兴市场资金流向出现分化，部分高收益货币承压。',
      '企业债发行窗口重新打开，投资级利差小幅收窄。',
      '银行体系准备金充裕，货币市场利率保持平稳。',
      '总体来看，市场正在为一段更长时间的高利率环境重新定价。',
    ].join(''),
    sourceRefs: [{ claimId: claims[0]?.id ?? '' }],
  });
  await client.packs.enable(workspace.id, TEXT_PACK);
  await client.packs.bind(workspace.id, project.id, TEXT_PACK);
  return { workspaceId: workspace.id, projectId: project.id };
}

describe('Text Pack（P12-03）', () => {
  it('generate：Thread 装条（逐字引用）+ 短文/文案 + Newsletter 分节；引用可重建', async () => {
    const client = await newClient('text-main');
    const { workspaceId, projectId } = await makeProjectWithAtom(client);
    await client.packs.analyze(workspaceId, projectId, TEXT_PACK);
    const artifact = await client.packs.generate(workspaceId, projectId, TEXT_PACK);
    expect(artifact.payloadKind).toBe('TEXT_SET');
    const payload = artifact.payload;
    if (payload.kind !== 'TEXT_SET') throw new Error('unexpected payload kind');

    // Thread：长文本 → 多条（单条 ≤280 字符），前缀 [i/N]；正文逐句取自 Atom
    const thread = payload.units.filter((unit) => unit.kind === 'THREAD_POST');
    expect(thread.length).toBeGreaterThanOrEqual(2);
    expect(thread[0]?.prefix).toBe(`[1/${String(thread.length)}] `);
    expect(thread.every((unit) => unit.textChars <= 280)).toBe(true);
    expect(thread[0]?.text).toContain('联邦基金利率维持在 5.25% 不变');

    // 短文与平台文案（≤220 字符；标题逐字）
    expect(payload.units.some((unit) => unit.kind === 'SHORT_POST')).toBe(true);
    const copy = payload.units.find((unit) => unit.kind === 'PLATFORM_COPY');
    expect(copy?.text).toContain('降息预期升温');

    // Newsletter：分节（≤6000 字符）
    const sections = payload.units.filter((unit) => unit.kind === 'NEWSLETTER_SECTION');
    expect(sections).toHaveLength(1);

    // 引用与事实不丢失：每个单元正文（去前缀）= 引文逐字拼接；引文均可追溯
    for (const unit of payload.units) {
      const body = unit.text.startsWith(unit.prefix) ? unit.text.slice(unit.prefix.length) : unit.text;
      expect(unit.quotes.map((quote) => quote.text).join('')).toBe(body);
      expect(unit.quotes.every((quote) => quote.claimId !== null || quote.sourceId !== null)).toBe(true);
    }

    // validate：自产产物零 error
    const validation = await client.packs.artifacts.validate(workspaceId, projectId, artifact.artifactId);
    expect(validation.ok).toBe(true);
    expect(validation.issues.filter((issue) => issue.severity === 'error')).toHaveLength(0);
  }, 120_000);

  it('validate 篡改可复现：引用改写 / 无来源引文 / 超限 / 顺序错乱逐项报错', async () => {
    const client = await newClient('text-tamper');
    const { workspaceId, projectId } = await makeProjectWithAtom(client);
    await client.packs.analyze(workspaceId, projectId, TEXT_PACK);
    const artifact = await client.packs.generate(workspaceId, projectId, TEXT_PACK);
    const payload = artifact.payload;
    if (payload.kind !== 'TEXT_SET') throw new Error('unexpected payload kind');
    const tampered = structuredClone(payload);
    // 篡改 1：改写正文（引文不再能重建 → QUOTE_MISMATCH）
    const shortPost = tampered.units.find((unit) => unit.kind === 'SHORT_POST');
    if (shortPost !== undefined) shortPost.text = `${shortPost.prefix}被改写的事实表述。`;
    // 篡改 2：引文去掉来源引用（不可追溯）
    const secondPost = tampered.units.filter((unit) => unit.kind === 'THREAD_POST')[1];
    if (secondPost !== undefined) secondPost.quotes = secondPost.quotes.map((quote) => ({ ...quote, claimId: null, sourceId: null }));
    // 篡改 3：超长单元（首条 Thread 帖改成 300 字，超过单条上限 280）
    const firstPost = tampered.units.find((unit) => unit.kind === 'THREAD_POST');
    if (firstPost !== undefined) {
      firstPost.text = `${firstPost.prefix}${'长'.repeat(300)}`;
      firstPost.textChars = 300;
      firstPost.quotes = [{ claimId: firstPost.quotes[0]?.claimId ?? null, sourceId: firstPost.quotes[0]?.sourceId ?? null, text: '长'.repeat(300) }];
    }
    // 篡改 4：单元顺序错乱
    if (tampered.units.length >= 2) {
      const first = tampered.units[0];
      const last = tampered.units[tampered.units.length - 1];
      if (first !== undefined && last !== undefined) {
        first.index = tampered.units.length - 1;
        last.index = 0;
      }
    }
    await handle.db
      .update(packArtifacts)
      .set({ payload: tampered })
      .where(and(eq(packArtifacts.id, artifact.artifactId), eq(packArtifacts.workspaceId, workspaceId)));

    const validation = await client.packs.artifacts.validate(workspaceId, projectId, artifact.artifactId);
    expect(validation.ok).toBe(false);
    const errors = validation.issues.filter((issue) => issue.severity === 'error');
    const codes = errors.map((issue) => issue.code);
    const detail = errors.map((issue) => `${issue.code}:${issue.message}`).join(' | ');
    expect(codes, detail).toContain('QUOTE_MISMATCH');
    expect(codes, detail).toContain('FACT_QUOTE_UNTRACEABLE');
    expect(codes, detail).toContain('LENGTH_LIMIT_EXCEEDED');
    expect(codes, detail).toContain('UNIT_ORDER_INVALID');
  }, 120_000);

  it('长度冲突不改文字：单句超过单条上限 → 该形态列入 unavailableFormats 并说明原因', async () => {
    const client = await newClient('text-conflict');
    const { workspaceId, projectId } = await makeProjectWithAtom(client);
    // 追加一条"长句 Atom"（单句 > 280 字符）——Thread 无法在不改文字前提下装条
    const url = `https://news.example/text-long/${randomUUID()}`;
    fetcher.responses.set(url, { contentType: 'text/html; charset=utf-8', bytes: new TextEncoder().encode(ARTICLE_HTML) });
    const record = await client.content.create(workspaceId, projectId, { sourceType: 'URL_ARTICLE', url });
    await client.evidence.extract(workspaceId, projectId, record.document.id);
    const claims = await client.evidence.claims(workspaceId, projectId);
    await client.content.atoms.create(workspaceId, projectId, {
      kind: 'KEY_NUMBER',
      title: '长句 Atom',
      text: `${'这是一段相当长的单一语句'.repeat(30)}。`,
      sourceRefs: [{ claimId: claims[0]?.id ?? '' }],
    });
    await client.packs.analyze(workspaceId, projectId, TEXT_PACK);
    const artifact = await client.packs.generate(workspaceId, projectId, TEXT_PACK);
    const payload = artifact.payload;
    if (payload.kind !== 'TEXT_SET') throw new Error('unexpected payload kind');
    const threadUnavailable = payload.unavailableFormats.find((entry) => entry.channelKey === 'TEXT_THREAD');
    expect(threadUnavailable?.reason).toContain('不改文字');
    expect(payload.units.some((unit) => unit.kind === 'THREAD_POST')).toBe(false);
    const validation = await client.packs.artifacts.validate(workspaceId, projectId, artifact.artifactId);
    expect(validation.ok).toBe(true);
  }, 120_000);
});
