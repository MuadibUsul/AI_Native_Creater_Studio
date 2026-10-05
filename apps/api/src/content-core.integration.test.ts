import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { claims, contentBlocks, contentCores, contentDocuments, createDb, plans, projectSources, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, workspaces, type DbHandle } from '@ancs/db';
import { ensureDefaultPlans, type DomainDeps } from '@ancs/domain';
import { MockLlmAdapter } from '@ancs/providers-mock-llm';
import type { ArticleFetcher } from '@ancs/contracts';
import { buildServer } from './server.js';

/**
 * P11-01 验收（真实 DB）：
 * - **迁移前后来源与关键事实一致**：claims/sources 1:1 映射（文本/事实性/来源引用逐条对照）；
 * - **保留原文档**：文档/块/来源/声明行零改动（迁移前后行集合不变）；
 * - **幂等**：输入未变重跑 → reused=true 且不产生新行；原始侧漂移可被 state 对照发现 → 重跑重建；
 * - **不推断**：relations 恒空 + note；thesis 不编造（null）。
 */

const ARTICLE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>利率周报</title></head><body>
<h1>美联储利率决议</h1><p>联邦基金利率维持在 5.25% 不变。市场预计年内降息一次。</p><p>核心通胀升至 3.2%。</p></body></html>`;

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
  auth = createAuth({ db: handle.db, secret: 'content-core-secret-0123456789', baseUrl: 'http://localhost:3001' }); // secrets:check-ignore：测试专用假密钥
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

async function makeProjectWithContent(client: AncsClient): Promise<{ workspaceId: string; projectId: string; documentId: string; claimCountBefore: number; sourceCountBefore: number }> {
  const workspace = await client.workspaces.create({ name: `核心-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '栏目' });
  const project = await client.projects.create(workspace.id, { title: '利率周报', channelId: channel.id });
  const url = `https://news.example/rates/${randomUUID()}`;
  fetcher.responses.set(url, { contentType: 'text/html; charset=utf-8', bytes: new TextEncoder().encode(ARTICLE_HTML) });
  const record = await client.content.create(workspace.id, project.id, { sourceType: 'URL_ARTICLE', url });
  const extraction = await client.evidence.extract(workspace.id, project.id, record.document.id);
  const sourceCountBefore = (await handle.db.select().from(projectSources).where(eq(projectSources.projectId, project.id))).length;
  return { workspaceId: workspace.id, projectId: project.id, documentId: record.document.id, claimCountBefore: extraction.summary.claimCount, sourceCountBefore };
}

describe('Content Core 迁移（P11-01）', () => {
  it('迁移一致：claims/sources 1:1（逐条对照）；facts = fact 事实性子集；relations 不推断；原文档保留', async () => {
    const client = await newClient('cc-main');
    const { workspaceId, projectId, documentId, claimCountBefore } = await makeProjectWithContent(client);
    expect(claimCountBefore).toBeGreaterThan(0);

    // 迁移前快照（原文档侧逐行记录——迁移后必须零改动）
    const claimsBefore = await handle.db.select().from(claims).where(eq(claims.projectId, projectId));
    const blocksBefore = await handle.db.select().from(contentBlocks).where(eq(contentBlocks.workspaceId, workspaceId));
    const documentsBefore = await handle.db.select().from(contentDocuments).where(eq(contentDocuments.id, documentId));
    const sourcesBefore = await handle.db.select().from(projectSources).where(eq(projectSources.projectId, projectId));

    const migration = await client.content.contentCore.migrate(workspaceId, projectId);
    expect(migration.reused).toBe(false);
    expect(migration.consistency.claimCount).toBe(claimCountBefore);
    expect(migration.consistency.checked).toContain('CLAIMS_PRESERVED_1TO1');
    expect(migration.consistency.checked).toContain('RELATIONS_NOT_INFERRED');

    // 1:1 对照：文本/事实性/来源引用逐条一致（顺序无关）
    const coreClaims = [...migration.core.claims].sort((left, right) => left.claimId.localeCompare(right.claimId));
    const dbClaims = [...claimsBefore].sort((left, right) => left.id.localeCompare(right.id));
    expect(coreClaims.map((claim) => claim.text)).toEqual(dbClaims.map((claim) => claim.text));
    expect(coreClaims.map((claim) => claim.factuality)).toEqual(dbClaims.map((claim) => claim.factuality));
    expect(coreClaims.map((claim) => [...claim.sourceIds].sort())).toEqual(dbClaims.map((claim) => [...(claim.sourceIds as string[])].sort()));
    // facts = fact 子集（不新增）
    expect(migration.core.facts.map((fact) => fact.claimId).sort()).toEqual(coreClaims.filter((claim) => claim.factuality === 'fact').map((claim) => claim.claimId).sort());
    // relations 不推断；thesis 不编造
    expect(migration.core.relations).toEqual([]);
    expect(migration.core.thesis).toBeNull();
    expect(migration.core.notes.some((note) => note.includes('不推断'))).toBe(true);
    // 文档引用（原文档保留：核心只记引用）
    expect(migration.core.documents.map((document) => document.documentId)).toEqual([documentId]);
    expect(migration.core.documents[0]?.blockCount).toBeGreaterThan(0);

    // **原文档零改动**（行集合逐字段一致）
    expect(await handle.db.select().from(claims).where(eq(claims.projectId, projectId))).toEqual(claimsBefore);
    expect(await handle.db.select().from(contentBlocks).where(eq(contentBlocks.workspaceId, workspaceId))).toEqual(blocksBefore);
    expect(await handle.db.select().from(contentDocuments).where(eq(contentDocuments.id, documentId))).toEqual(documentsBefore);
    expect(await handle.db.select().from(projectSources).where(eq(projectSources.projectId, projectId))).toEqual(sourcesBefore);
    expect((await handle.db.select().from(contentCores)).filter((row) => row.projectId === projectId)).toHaveLength(1);
  }, 120_000);

  it('幂等：输入未变重跑 → reused=true（同一行同一 migratedAt）；state 实时计数对照', async () => {
    const client = await newClient('cc-idem');
    const { workspaceId, projectId } = await makeProjectWithContent(client);

    const first = await client.content.contentCore.migrate(workspaceId, projectId);
    const stateAfterFirst = await client.content.contentCore.state(workspaceId, projectId);
    expect(stateAfterFirst.consistency?.inputsDigest).toBe(first.consistency.inputsDigest);
    expect(stateAfterFirst.liveCounts.claimCount).toBe(first.consistency.claimCount); // 迁移后未漂移

    const second = await client.content.contentCore.migrate(workspaceId, projectId);
    expect(second.reused).toBe(true);
    expect(second.migratedAt).toBe(first.migratedAt);
    expect((await handle.db.select().from(contentCores)).filter((row) => row.projectId === projectId)).toHaveLength(1);
  }, 120_000);

  it('原始侧漂移可发现：迁移后新增声明 → state 对照不一致；重跑重建（reused=false、计数更新）', async () => {
    const client = await newClient('cc-drift');
    const { workspaceId, projectId } = await makeProjectWithContent(client);
    const first = await client.content.contentCore.migrate(workspaceId, projectId);

    // 漂移：迁移后原始侧新增声明（人工创建路径）
    await client.evidence.createClaim(workspaceId, projectId, { text: '人工补充的关键判断', factuality: 'analysis', sourceIds: [] });
    const drifted = await client.content.contentCore.state(workspaceId, projectId);
    expect(drifted.liveCounts.claimCount).toBe(first.consistency.claimCount + 1);
    expect(drifted.consistency?.claimCount).toBe(first.consistency.claimCount);

    const rebuilt = await client.content.contentCore.migrate(workspaceId, projectId);
    expect(rebuilt.reused).toBe(false);
    expect(rebuilt.consistency.claimCount).toBe(first.consistency.claimCount + 1);
    const state = await client.content.contentCore.state(workspaceId, projectId);
    expect(state.liveCounts.claimCount).toBe(state.consistency?.claimCount);
  }, 120_000);

  it('空项目 → 422 NOTHING_TO_MIGRATE（无可迁移对象）', async () => {
    const client = await newClient('cc-empty');
    const workspace = await client.workspaces.create({ name: `空-${randomUUID().slice(0, 8)}` });
    const channel = await client.channels.create(workspace.id, { name: '栏目' });
    const project = await client.projects.create(workspace.id, { title: '空项目', channelId: channel.id });
    const error = await client.content.contentCore.migrate(workspace.id, project.id).catch((caught: unknown) => caught);
    expect((error as { status?: number }).status).toBe(422);
    expect(((error as { details?: { reason?: string } }).details ?? {}).reason).toBe('NOTHING_TO_MIGRATE');
  }, 120_000);
});
