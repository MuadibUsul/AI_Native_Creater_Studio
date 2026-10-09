import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, plans, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, workspaces, type DbHandle } from '@ancs/db';
import { assignWorkspacePlan, ensureDefaultPlans, type DomainDeps } from '@ancs/domain';
import { packManifestSchema, type PackPlugin, type RestrictedPluginContext } from '@ancs/contracts';
import { MockLlmAdapter } from '@ancs/providers-mock-llm';
import type { ArticleFetcher } from '@ancs/contracts';
import { buildServer } from './server.js';
import { enrollTestOpsTotp, provisionTestOpsPrincipal, signInTestOpsClient, testOpsDeps } from './test-helpers/ops-auth.js';

/**
 * P11-03 验收（真实 DB）：
 * - 官方 Pack 随启动幂等安装；启用（**权益白名单强制**）；绑定（**版本锁定**）；
 * - analyze 四道闸门（绑定→安装→启用→权益）+ **受限上下文能力门控**（未声明 read_content_core → core/atoms 为空）；
 * - 官方 Shorts Analyzer 消费 Fit/Atom 出 OutputPlan（NOT_RECOMMENDED → 阻塞说明；有数字 Atom → 规划条目）。
 */

const ARTICLE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>利率周报</title></head><body>
<h1>美联储利率决议</h1><p>联邦基金利率维持在 5.25% 不变。市场预计年内降息一次。</p><p>核心通胀升至 3.2%。</p></body></html>`;

let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let adminEmail = '';
let adminTotpUri = '';
let llm: MockLlmAdapter;
const ADMIN_PASSWORD = 'admin-password-1234'; // secrets:check-ignore：测试专用假密钥
const PASSWORD = 'password-1234';
const SHORTS_PACK = 'ancs.pack.shorts-analyzer';

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
  auth = createAuth({ db: handle.db, secret: 'packs-secret-0123456789', baseUrl: 'http://localhost:3001' }); // secrets:check-ignore：测试专用假密钥
  adminEmail = `packs-admin-${randomUUID()}@test.local`;
  const adminUser = await createInternalUser(auth, { email: adminEmail, password: ADMIN_PASSWORD, name: 'packs-admin' });
  await provisionTestOpsPrincipal(handle.db, adminUser.id);
  llm = new MockLlmAdapter();
  app = await buildServer({
    auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
    content: { articleFetcher: fetcher, llm },
    admin: testOpsDeps(handle.db),
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
  adminTotpUri = await enrollTestOpsTotp(createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' }), adminEmail, ADMIN_PASSWORD);
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

async function newAdminClient(): Promise<AncsClient> {
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await signInTestOpsClient(client, adminEmail, ADMIN_PASSWORD, adminTotpUri);
  return client;
}

async function makeProjectWithContent(client: AncsClient): Promise<{ workspaceId: string; projectId: string; claimIds: string[] }> {
  const workspace = await client.workspaces.create({ name: `Pack-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '栏目' });
  const project = await client.projects.create(workspace.id, { title: '利率周报', channelId: channel.id });
  const url = `https://news.example/rates/${randomUUID()}`;
  fetcher.responses.set(url, { contentType: 'text/html; charset=utf-8', bytes: new TextEncoder().encode(ARTICLE_HTML) });
  const record = await client.content.create(workspace.id, project.id, { sourceType: 'URL_ARTICLE', url });
  await client.evidence.extract(workspace.id, project.id, record.document.id);
  const projectClaims = await client.evidence.claims(workspace.id, project.id);
  return { workspaceId: workspace.id, projectId: project.id, claimIds: projectClaims.map((claim) => claim.id) };
}

async function expectApiError(promise: Promise<unknown>, status: number, reason?: string): Promise<AncsApiError> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AncsApiError);
  const apiError = error as AncsApiError;
  expect(apiError.status).toBe(status);
  if (reason !== undefined) expect((apiError.details as { reason?: string }).reason).toBe(reason);
  return apiError;
}

describe('Pack 运行时（P11-03）', () => {
  it('官方 Pack 幂等安装 + 启用（权益白名单）+ 绑定（版本锁定）+ analyze 闸门链', async () => {
    const client = await newClient('pack-main');
    const { workspaceId, projectId, claimIds } = await makeProjectWithContent(client);

    // 安装清单：官方 Shorts Analyzer（两次访问一致 = 幂等）
    const packs = await client.packs.list(workspaceId);
    const shorts = packs.find((view) => view.installation.packId === SHORTS_PACK);
    expect(shorts?.installation.version).toBe('1.0.0');
    expect(shorts?.installation.official).toBe(true);
    expect(shorts?.enabled).toBe(false);
    const packsAgain = await client.packs.list(workspaceId);
    expect(packsAgain.find((view) => view.installation.packId === SHORTS_PACK)?.installation.id).toBe(shorts?.installation.id);

    // analyze 未启用 → 409 PACK_NOT_ENABLED（闸门顺序：绑定在前，但未绑定时也需明确）——
    // 先绑定会 409 PACK_NOT_ENABLED（未启用不可绑定）；先 analyze → 409 PACK_NOT_BOUND
    await expectApiError(client.packs.analyze(workspaceId, projectId, SHORTS_PACK), 409, 'PACK_NOT_BOUND');
    await expectApiError(client.packs.bind(workspaceId, projectId, SHORTS_PACK), 409, 'PACK_ENABLEMENT_REQUIRED');

    // 启用（ENTERPRISE 默认 packs:null = 不限）→ 绑定（版本锁定）
    const enablement = await client.packs.enable(workspaceId, SHORTS_PACK);
    expect(enablement.version).toBe('1.0.0');
    const binding = await client.packs.bind(workspaceId, projectId, SHORTS_PACK);
    expect(binding.version).toBe('1.0.0');

    // analyze（无 Atom → Fit NOT_RECOMMENDED → 计划带阻塞说明 + requiresApproval）
    const result = await client.packs.analyze(workspaceId, projectId, SHORTS_PACK);
    expect(result.plan.schemaVersion).toBe('output-plan-v1');
    expect(result.plan.items).toHaveLength(0);
    expect(result.plan.summary).toContain('NOT_RECOMMENDED');
    expect(result.plan.requiresApproval).toBe(true);
    // 受限上下文：read_content_core 已声明 → 核心数据面可见；无 Secret 字段
    expect(result.context.data.core).not.toBeNull();
    expect(result.context.packId).toBe(SHORTS_PACK);
    expect(JSON.stringify(result)).not.toMatch(/secret|apiKey|api_key|password|signature: "/i);

    // 创建 KEY_NUMBER Atom → Fit RECOMMENDED → 计划含 Atom 条目
    await client.content.atoms.create(workspaceId, projectId, {
      kind: 'KEY_NUMBER',
      title: '利率维持 5.25%',
      text: '联邦基金利率维持在 5.25% 不变。',
      sourceRefs: [{ claimId: claimIds[0] as string }],
      payload: { value: 5.25, unit: '%' },
    });
    const recommended = await client.packs.analyze(workspaceId, projectId, SHORTS_PACK);
    expect(recommended.plan.summary).toContain('RECOMMENDED');
    expect(recommended.plan.items).toHaveLength(1);
    expect(recommended.plan.items[0]?.description).toContain('利率维持 5.25%');
  }, 120_000);

  it('权益白名单：FREE 套餐（packs:[]）下启用 → 403（PACK_NOT_ENABLED）；analyze 同样 403', async () => {
    const client = await newClient('pack-entitled');
    const admin = await newAdminClient();
    const { workspaceId, projectId } = await makeProjectWithContent(client);

    // ENTERPRISE（默认）下启用成功
    await client.packs.enable(workspaceId, SHORTS_PACK);
    await client.packs.bind(workspaceId, projectId, SHORTS_PACK);

    // 降级 FREE（packs: [] = 无 Pack 权益）→ analyze 403（权益在 analyze 链内复检）
    await expectApiError(admin.admin.assignPlan(workspaceId, { planKey: 'FREE' }), 403);
    await assignWorkspacePlan(deps(), { workspaceId, planKey: 'FREE', assignedBy: 'test-domain' });
    await expectApiError(client.packs.analyze(workspaceId, projectId, SHORTS_PACK), 403, 'PACK_NOT_ENABLED'); // P09-01 权益常量

    // 停用后再启用 → 403（权益已不含）
    await client.packs.disable(workspaceId, SHORTS_PACK);
    await expectApiError(client.packs.enable(workspaceId, SHORTS_PACK), 403, 'PACK_NOT_ENABLED'); // P09-01 权益常量
  }, 120_000);

  it('受限上下文能力门控：未声明 read_content_core 的 Pack → ctx.data.core=null 且 atoms 空', async () => {
    const holder: { ctx: RestrictedPluginContext | null } = { ctx: null };
    const noCorePlugin: PackPlugin = {
      manifest: packManifestSchema.parse({
        manifestVersion: 'pack-manifest-v1',
        packId: 'test.pack.nocore',
        name: '无核心读取 Pack',
        version: '1.0.0',
        capabilities: [],
        compatibility: { coreRange: '>=1.0.0', sceneGraphSchemaVersion: null },
        defaultChannelKey: null,
        outputFormats: [],
        quota: null,
        signature: null,
      }),
      analyze: async (ctx) => {
        holder.ctx = ctx;
        return { schemaVersion: 'output-plan-v1', summary: 'ok', items: [], requiresApproval: false };
      },
    };
    const gated = await buildServer({
      auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
      content: { articleFetcher: fetcher, llm },
      packs: { plugins: [noCorePlugin] },
    });
    await gated.listen({ port: 0, host: '127.0.0.1' });
    const gatedUrl = `http://127.0.0.1:${String((gated.server.address() as AddressInfo).port)}`;

    const client = await newClient('pack-gate');
    // 在主实例建内容（同库）；gated 实例只注册了 noCore 插件
    await makeProjectWithContent(client);
    const gatedEmail = `gate-${randomUUID()}@test.local`;
    await createInternalUser(auth, { email: gatedEmail, password: PASSWORD, name: 'gate-user' });
    const gatedClient = createClient({ baseUrl: gatedUrl, clientType: 'web', clientVersion: '0.1.0' });
    await gatedClient.auth.signIn({ email: gatedEmail, password: PASSWORD });
    // gated 实例用同一 auth —— 直接重新登录同一用户不可行（randomUUID 邮箱）；改用主 client 的 cookie 不跨实例。
    // 简化：在 gated 实例上创建独立用户与项目（同一 DB）。
    const gWorkspace = await gatedClient.workspaces.create({ name: `门控-${randomUUID().slice(0, 8)}` });
    const gChannel = await gatedClient.channels.create(gWorkspace.id, { name: '栏目' });
    const gProject = await gatedClient.projects.create(gWorkspace.id, { title: '门控项目', channelId: gChannel.id });

    await gatedClient.packs.enable(gWorkspace.id, 'test.pack.nocore');
    await gatedClient.packs.bind(gWorkspace.id, gProject.id, 'test.pack.nocore');
    await gatedClient.packs.analyze(gWorkspace.id, gProject.id, 'test.pack.nocore');

    expect(holder.ctx).not.toBeNull();
    expect(holder.ctx?.data.core).toBeNull();
    expect(holder.ctx?.data.atoms).toHaveLength(0);
    expect(holder.ctx?.grantedCapabilities).toEqual([]);
    await gated.close();
  }, 120_000);
});
