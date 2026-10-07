import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, plans, redactDatabaseUrl, renderApprovals, renders, resolveTestDatabaseUrl, runMigrations, workspaces, type DbHandle } from '@ancs/db';
import { ensureDefaultPlans, type DomainDeps } from '@ancs/domain';
import { MockLlmAdapter } from '@ancs/providers-mock-llm';
import type { ArticleFetcher } from '@ancs/contracts';
import { buildServer } from './server.js';

/**
 * P13-04 验收（真实 DB）：P3/P4 体验。
 * - **Send to Draft（P3）**：deliveryMode=DRAFT → uploadDraft → 状态记 **DRAFT**（**不显示为 Published**）；
 *   不支持 Draft 的平台明确拒绝（DRAFT_NOT_SUPPORTED）；
 * - **P4 Export Package**：仅矩阵声明 EXPORT_PACKAGE 的平台（抖音/X）；包 = 视频+封面+文案+披露+手工清单，
 *   **末步恒为"由用户完成"**（finalStepByUser=true）；未批准版本不能打包（闸门与发布同源）；
 *   非 P4 平台（未声明 EXPORT_PACKAGE）明确拒绝。
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
  auth = createAuth({ db: handle.db, secret: 'p3p4-secret-0123456789', baseUrl: 'http://localhost:3001' }); // secrets:check-ignore：测试专用假密钥
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

async function makeApprovedRender(client: AncsClient, options: { approve: boolean }): Promise<{
  workspaceId: string;
  projectId: string;
  versionId: string;
  outputAssetId: string;
}> {
  const workspace = await client.workspaces.create({ name: `p3p4-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '栏目' });
  const project = await client.projects.create(workspace.id, { title: '利率周报', channelId: channel.id });
  const url = `https://news.example/p3p4/${randomUUID()}`;
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
  if (options.approve) {
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
  }
  return { workspaceId: workspace.id, projectId: project.id, versionId: version.id, outputAssetId };
}

async function expectApiError(promise: Promise<unknown>, status: number, reason?: string): Promise<AncsApiError> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AncsApiError);
  const apiError = error as AncsApiError;
  expect(apiError.status).toBe(status);
  if (reason !== undefined) expect((apiError.details as { reason?: string }).reason).toBe(reason);
  return apiError;
}

describe('P3/P4 体验（P13-04）', () => {
  it('Send to Draft：状态记 DRAFT（**不显示为 Published**）+ 导入说明；无 UPLOAD_DRAFT 能力平台明确拒绝', async () => {
    const client = await newClient('p3-draft');
    const { workspaceId, projectId, versionId, outputAssetId } = await makeApprovedRender(client, { approve: true });

    const draft = await client.publications.request(workspaceId, projectId, {
      publicationKey: { platformId: 'mock.platform', accountId: 'acc-draft', projectVersionId: versionId, outputAssetId },
      title: '利率周报',
      deliveryMode: 'DRAFT',
    });
    expect(draft.publication.state).toBe('DRAFT'); // **不是 PUBLISHED**
    expect(draft.publication.publishedAt).toBeNull(); // 未发布
    expect(draft.publication.remoteId).toContain('mock-draft');
    expect(draft.publication.transferInstructions).toContain('手动发布');

    // 列表中状态仍为 DRAFT（UI 与真实状态一致）
    const list = await client.publications.list(workspaceId, projectId);
    expect(list.items[0]?.state).toBe('DRAFT');

    // 无 UPLOAD_DRAFT 生效能力的平台（TIKTOK stub——核验未完成生效能力为空）→ 明确拒绝
    await expectApiError(
      client.publications.request(workspaceId, projectId, {
        publicationKey: { platformId: 'TIKTOK', accountId: 'acc-draft2', projectVersionId: versionId, outputAssetId },
        title: '利率周报',
        deliveryMode: 'DRAFT',
      }),
      422,
      'DRAFT_NOT_SUPPORTED',
    );
  }, 120_000);

  it('P4 Export Package（抖音）：视频+文案+披露+平台清单，**末步由用户完成**；未批准不能打包；非 P4 平台拒绝', async () => {
    const client = await newClient('p4-package');
    const unapproved = await makeApprovedRender(client, { approve: false });
    // 未批准版本不能打包（闸门与发布同源）
    await expectApiError(
      client.exportPackages.create(unapproved.workspaceId, unapproved.projectId, {
        platformId: 'DOUYIN',
        projectVersionId: unapproved.versionId,
        outputAssetId: unapproved.outputAssetId,
        title: '利率周报',
        disclosure: '本视频包含 AI 生成内容',
      }),
      409,
      'NOT_APPROVED',
    );

    const { workspaceId, projectId, versionId, outputAssetId } = await makeApprovedRender(client, { approve: true });
    const pkg = await client.exportPackages.create(workspaceId, projectId, {
      platformId: 'DOUYIN',
      projectVersionId: versionId,
      outputAssetId,
      coverAssetId: null,
      title: '利率维持 5.25%',
      description: '每周利率解读',
      disclosure: '本视频包含 AI 生成内容',
    });
    expect(pkg.payload.platformId).toBe('DOUYIN');
    expect(pkg.payload.videoAssetId).toBe(outputAssetId);
    expect(pkg.payload.coverAssetId).toBeNull();
    expect(pkg.payload.coverNote).toContain('封面未生成');
    expect(pkg.payload.disclosure).toBe('本视频包含 AI 生成内容');
    // 平台清单完整且末步由用户完成
    expect(pkg.payload.checklist.length).toBeGreaterThanOrEqual(4);
    expect(pkg.payload.checklist.some((step) => step.includes('AI 生成内容声明'))).toBe(true);
    expect(pkg.payload.finalStepByUser).toBe(true);
    expect(pkg.payload.checklist[pkg.payload.checklist.length - 1]).toContain('由用户在平台完成发布');

    // 非 P4 平台（矩阵未声明 EXPORT_PACKAGE）→ 明确拒绝
    await expectApiError(
      client.exportPackages.create(workspaceId, projectId, {
        platformId: 'TIKTOK',
        projectVersionId: versionId,
        outputAssetId,
        title: '利率周报',
      }),
      422,
      'EXPORT_PACKAGE_UNAVAILABLE',
    );

    // 列表可见
    const list = await client.exportPackages.list(workspaceId, projectId);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.id).toBe(pkg.id);
  }, 120_000);
});
