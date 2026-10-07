import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, plans, redactDatabaseUrl, renderApprovals, renders, resolveTestDatabaseUrl, runMigrations, workspaces, type DbHandle } from '@ancs/db';
import { ensureDefaultPlans, type DomainDeps } from '@ancs/domain';
import { MockLlmAdapter } from '@ancs/providers-mock-llm';
import { PLATFORM_CAPABILITY_MATRIX } from '@ancs/contracts';
import type { ArticleFetcher } from '@ancs/contracts';
import { buildServer } from './server.js';

/**
 * P13-03 验收（真实 DB）：其他平台（TikTok/抖音/Bilibili/LinkedIn/X）。
 * - **不假设每个平台支持相同能力**：逐平台矩阵（tier/declaredCapabilities/notes）互不相同且为数据驱动；
 * - **UI 与真实 capability 一致**：核验未完成 → 生效能力为空 → 核心闸门 fail-closed
 *   （不显示"可发布"、不产生远端调用、无浏览器自动化）；
 * - 实测核验 BLOCKED 平台账号（诚实标注 UNVERIFIED_CREDENTIALS_REQUIRED）。
 */

const ARTICLE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>利率周报</title></head><body>
<h1>美联储利率决议</h1><p>联邦基金利率维持在 5.25% 不变。</p></body></html>`;

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
  auth = createAuth({ db: handle.db, secret: 'platforms-secret-0123456789', baseUrl: 'http://localhost:3001' }); // secrets:check-ignore：测试专用假密钥
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

async function makeApprovedRender(client: AncsClient): Promise<{ workspaceId: string; projectId: string; versionId: string; outputAssetId: string }> {
  const workspace = await client.workspaces.create({ name: `plat-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '栏目' });
  const project = await client.projects.create(workspace.id, { title: '利率周报', channelId: channel.id });
  const url = `https://news.example/plat/${randomUUID()}`;
  fetcher.responses.set(url, { contentType: 'text/html; charset=utf-8', bytes: new TextEncoder().encode(ARTICLE_HTML) });
  const record = await client.content.create(workspace.id, project.id, { sourceType: 'URL_ARTICLE', url });
  await client.evidence.extract(workspace.id, project.id, record.document.id);
  llm.scriptNext('valid');
  await client.narrative.generate(workspace.id, project.id, record.document.id, { targetDurationMs: 60_000 });
  const version = await client.projects.versions.create(project.id, { reason: 'FINAL_RENDER' });
  const outputAssetId = `ast_out_${randomUUID().slice(0, 8)}`;
  const manifestHash = `sha256-${randomUUID()}`;
  const render = await handle.db
    .insert(renders)
    .values({
      id: `rnd_${randomUUID()}`,
      workspaceId: workspace.id,
      projectId: project.id,
      profile: '1080p',
      status: 'READY',
      input: { projectVersionId: version.id },
      manifestHash,
      outputAssetIds: [outputAssetId],
    })
    .returning();
  await handle.db.insert(renderApprovals).values({
    id: `rapp_${randomUUID()}`,
    workspaceId: workspace.id,
    projectId: project.id,
    renderId: render[0]!.id,
    decision: 'APPROVED',
    manifestHashAtApproval: manifestHash,
    projectVersionIdAtApproval: version.id,
    projectRevisionAtApproval: 1,
  });
  return { workspaceId: workspace.id, projectId: project.id, versionId: version.id, outputAssetId };
}

describe('其他平台能力矩阵（P13-03）', () => {
  it('矩阵数据驱动且逐平台不同（不假设相同能力）；全部标注待实测核验', () => {
    const matrix = PLATFORM_CAPABILITY_MATRIX;
    expect(matrix.map((entry) => entry.platformId)).toEqual(['TIKTOK', 'DOUYIN', 'BILIBILI', 'LINKEDIN', 'X']);
    // 逐平台能力集互不相同（不假设相同能力）
    const capabilitySets = new Set(matrix.map((entry) => `${entry.tier}:${entry.declaredCapabilities.join(',')}`));
    expect(capabilitySets.size).toBe(matrix.length);
    // P4 归类明确（抖音/X——公开文档准入限制）
    expect(matrix.find((entry) => entry.platformId === 'DOUYIN')?.tier).toBe('P4_EXPORT_PACKAGE');
    expect(matrix.find((entry) => entry.platformId === 'X')?.tier).toBe('P4_EXPORT_PACKAGE');
    // 全部诚实标注：待实测核验（不冒充已核验）
    expect(matrix.every((entry) => entry.verification === 'UNVERIFIED_CREDENTIALS_REQUIRED')).toBe(true);
  });

  it('生效能力为空 → 核心闸门 fail-closed（各平台一致拒绝；无远端调用）', async () => {
    const client = await newClient('plat-gates');
    const { workspaceId, projectId, versionId, outputAssetId } = await makeApprovedRender(client);
    for (const entry of PLATFORM_CAPABILITY_MATRIX) {
      // 生效能力 = 声明 ∩ 已核验 = 空 → CAPABILITY_MISSING 422（ tier 与核验状态随错误透出）
      const error = await client.publications
        .request(workspaceId, projectId, {
          publicationKey: { platformId: entry.platformId, accountId: 'acc-1', projectVersionId: versionId, outputAssetId },
          title: '利率周报',
        })
        .catch((caught: unknown) => caught);
      expect((error as { status?: number }).status).toBe(422);
      expect((error as { details?: { reason?: string; tier?: string } }).details?.reason).toBe('CAPABILITY_MISSING');
      expect((error as { details?: { tier?: string } }).details?.tier).toBe(entry.tier);
    }
    // 恰 0 行（fail-closed 未落任何发布；无远端调用）
    const list = await client.publications.list(workspaceId, projectId);
    expect(list.items).toHaveLength(0);
  }, 120_000);

  it('能力分级经错误透出：P1（TIKTOK）与 P4（X/抖音）的 tier 语义在响应中可区分', async () => {
    const client = await newClient('plat-tiers');
    const { workspaceId, projectId, versionId, outputAssetId } = await makeApprovedRender(client);
    const tiktok = (await client.publications
      .request(workspaceId, projectId, {
        publicationKey: { platformId: 'TIKTOK', accountId: 'acc-1', projectVersionId: versionId, outputAssetId },
        title: '利率周报',
      })
      .catch((caught: unknown) => caught)) as { details?: { tier?: string } };
    expect(tiktok.details?.tier).toBe('P1_DIRECT_PUBLISH');
    const x = (await client.publications
      .request(workspaceId, projectId, {
        publicationKey: { platformId: 'X', accountId: 'acc-1', projectVersionId: versionId, outputAssetId },
        title: '利率周报',
      })
      .catch((caught: unknown) => caught)) as { details?: { tier?: string } };
    expect(x.details?.tier).toBe('P4_EXPORT_PACKAGE');
  }, 120_000);
});
