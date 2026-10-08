import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { adminPrincipals, adminRoleGrants, adminRoleScopes, auditLog, createDb, plans, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, supportAccessGrants, workspaces, type DbHandle } from '@ancs/db';
import { createJob, createSupportGrant, ensureDefaultPlans, recordAudit, revokeSupportGrant, type DomainDeps } from '@ancs/domain';
import { LocalObjectStorage } from '@ancs/providers-storage-local';
import { HeuristicMalwareScanner } from '@ancs/providers-malware-heuristic';
import { buildServer } from './server.js';
import { enrollTestOpsTotp, provisionTestOpsPrincipal, signInTestOpsClient, testOpsDeps } from './test-helpers/ops-auth.js';
import { createStorageDeps } from './plugins/storage.js';

/**
 * P09-05 验收（真实 DB + HTTP/SDK + 真实本地存储端点）：
 * - **恶意文件扫描**（§43.3）：EICAR → 422（**不落盘**）+ 审计 `upload.malware_rejected`；干净文件正常；
 * - **滥用处理**：标记（创建/解决）+ 工作区限制（RESTRICTED → 新任务 403 WORKSPACE_RESTRICTED；
 *   解除后恢复）——每次动作入 audit_log；
 * - **支持访问不可无痕**：无授权 → 403；授权创建即对**工作区成员可见**（事件流）；
 *   每次 support-view 留痕（audit_log + 成员可见 `support.viewed` 事件）；撤销后再访问 → 403；
 * - **完整 Admin**（§67）：users/workspaces/projects/provider-status/storage/credits 只读聚合 + 审计表查询。
 */

let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let rootDir: string;
let storage: LocalObjectStorage;
let adminEmail = '';
let adminTotpUri = '';
const ADMIN_PASSWORD = 'admin-password-1234'; // secrets:check-ignore：测试专用假密钥
const PASSWORD = 'password-1234';

// EICAR 测试签名（运行时拼接，避免仓库/工具误报）；检出即证明扫描链路可用
const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}', '$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!', '$H+H*'].join('');

const deps = (): DomainDeps => ({ db: handle.db });

function makePng(width = 2, height = 2): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  bytes[16] = (width >> 24) & 0xff;
  bytes[17] = (width >> 16) & 0xff;
  bytes[18] = (width >> 8) & 0xff;
  bytes[19] = width & 0xff;
  bytes[20] = (height >> 24) & 0xff;
  bytes[21] = (height >> 16) & 0xff;
  bytes[22] = (height >> 8) & 0xff;
  bytes[23] = height & 0xff;
  bytes[24] = 8;
  bytes[25] = 2;
  return bytes;
}

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
  rootDir = await mkdtemp(join(tmpdir(), 'ancs-security-ops-'));
  storage = new LocalObjectStorage({
    rootDir,
    publicBaseUrl: 'http://127.0.0.1:0',
    signingSecret: 'security-ops-integration-secret-0123456789', // secrets:check-ignore：测试专用假密钥
  });
  auth = createAuth({ db: handle.db, secret: 'security-ops-secret-0123456789', baseUrl: 'http://localhost:3001' }); // secrets:check-ignore：测试专用假密钥
  adminEmail = `secops-admin-${randomUUID()}@test.local`;
  const adminUser = await createInternalUser(auth, { email: adminEmail, password: ADMIN_PASSWORD, name: 'secops-admin' });
  await provisionTestOpsPrincipal(handle.db, adminUser.id);
  app = await buildServer({
    auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
    storage: createStorageDeps(storage, {
      scanner: new HeuristicMalwareScanner(),
      auditSink: async (entry) => {
        await recordAudit({ db: handle.db }, {
          actorKind: 'SYSTEM',
          action: entry.action,
          targetType: 'storage_object',
          targetId: entry.key,
          workspaceId: entry.workspaceId,
          details: { filename: entry.filename, contentType: entry.contentType, findings: entry.findings, scanner: entry.scanner },
        });
      },
    }),
    admin: testOpsDeps(handle.db),
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
  adminTotpUri = await enrollTestOpsTotp(createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' }), adminEmail, ADMIN_PASSWORD);
  storage.publicBaseUrl = baseUrl;
});

afterAll(async () => {
  await app.close();
  await handle.close();
  await rm(rootDir, { recursive: true, force: true });
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

async function expectApiError(promise: Promise<unknown>, status: number, reason?: string): Promise<AncsApiError> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AncsApiError);
  const apiError = error as AncsApiError;
  expect(apiError.status).toBe(status);
  if (reason !== undefined) expect((apiError.details as { reason?: string }).reason).toBe(reason);
  return apiError;
}

describe('SaaS 安全运营（P09-05）', () => {
  it('恶意文件扫描：EICAR 上传被拒（不落盘）+ 审计；干净文件正常落盘可取回', async () => {
    const client = await newClient('secops-scan');
    const workspace = await client.workspaces.create({ name: `扫描-${randomUUID().slice(0, 8)}` });

    // 恶意内容：EICAR → 422（reason MALWARE_DETECTED + findings）
    const badIntent = await client.assets.createUploadIntent(workspace.id, {
      assetType: 'USER_UPLOAD',
      filename: 'payload.png',
      contentType: 'image/png',
      sizeBytes: EICAR.length,
    });
    const badUrl = badIntent.upload?.url ?? '';
    const badResponse = await fetch(badUrl, { method: 'PUT', body: EICAR, headers: { 'content-type': 'image/png' } });
    expect(badResponse.status).toBe(422);
    const badBody = (await badResponse.json()) as { error?: { details?: { reason?: string; findings?: { code: string }[] } } };
    expect(badBody.error?.details?.reason).toBe('MALWARE_DETECTED');
    expect(badBody.error?.details?.findings?.some((finding) => finding.code === 'EICAR_TEST_SIGNATURE')).toBe(true);
    // **未落盘**：存储根目录下不存在任何包含 EICAR 签名的对象
    const writtenFiles = await readdir(rootDir, { recursive: true, withFileTypes: true });
    for (const entry of writtenFiles) {
      if (!entry.isFile()) continue;
      const content = await readFile(join(entry.parentPath, entry.name), 'latin1');
      expect(content.includes(EICAR)).toBe(false);
    }
    // 审计：upload.malware_rejected（SYSTEM）
    const auditRows = await handle.db.select().from(auditLog);
    expect(auditRows.some((row) => row.action === 'upload.malware_rejected' && row.workspaceId === workspace.id)).toBe(true);

    // 干净内容：正常上传 → READY（真实探测）→ 下载取回原始字节
    const good = await client.assets.upload(workspace.id, {
      assetType: 'USER_UPLOAD',
      filename: 'hero.png',
      contentType: 'image/png',
      data: makePng(),
    });
    expect(good.status).toBe('READY');
    const download = await client.assets.downloadUrl(workspace.id, good.id);
    const fetched = await fetch(download.url);
    expect(fetched.status).toBe(200);
    expect((await fetched.arrayBuffer()).byteLength).toBe(33);
  }, 120_000);

  it('旧运营直写在 AdminAction 接线前全部拒绝且不产生副作用', async () => {
    const owner = await newClient('secops-abuse');
    const admin = await newAdminClient();
    const workspace = await owner.workspaces.create({ name: `滥用-${randomUUID().slice(0, 8)}` });

    await expectApiError(admin.admin.createAbuseFlag(workspace.id, { category: 'SPAM', severity: 'HIGH', note: '批量垃圾项目（人工核查）' }), 403);
    await expectApiError(admin.admin.setAbuseState(workspace.id, { abuseState: 'RESTRICTED', note: '调查中' }), 403);
    await expectApiError(admin.admin.resolveAbuseFlag(`abf_${randomUUID()}`, { resolutionNote: '错误复核' }), 403);
    await expectApiError(admin.admin.assignPlan(workspace.id, { planKey: 'FREE' }), 403);
    expect((await handle.db.select({ abuseState: workspaces.abuseState }).from(workspaces))[0]?.abuseState).toBe('NORMAL');
    const job = await createJob(deps(), { workspaceId: workspace.id, type: 'NOOP_TEST' });
    expect(job.status).toBe('QUEUED');
    const auditLogRows = await handle.db.select().from(auditLog);
    expect(auditLogRows.some((row) => row.workspaceId === workspace.id && row.action.startsWith('abuse.'))).toBe(false);
  }, 120_000);

  it('旧支持授权直写关闭，未授权视图与跨工作区读取被拒绝且不留伪访问记录', async () => {
    const owner = await newClient('secops-support');
    const admin = await newAdminClient();
    const workspace = await owner.workspaces.create({ name: `支持-${randomUUID().slice(0, 8)}` });
    await expectApiError(admin.admin.supportView(workspace.id, 'ticket-42'), 403);
    await expectApiError(admin.admin.createSupportGrant(workspace.id, {
      purpose: '排查渲染失败工单 #42', ticketId: 'ticket-42',
      beneficiaryPrincipalId: `oppr_${randomUUID()}`, scope: 'SUMMARY_READ', ttlHours: 2,
    }), 403);
    const events = await owner.events.list(workspace.id, { cursor: 0 });
    expect(events.events.some((event) => event.eventType === 'support.access_granted' || event.eventType === 'support.viewed')).toBe(false);
    expect((await handle.db.select().from(auditLog)).some((row) => row.workspaceId === workspace.id && row.action === 'support.view')).toBe(false);
  }, 120_000);

  it('支持视图逐人、逐工单、逐工作区授权；其他运营者不能借同一 scope 横向访问', async () => {
    const owner = await newClient('support-owner');
    const workspace = await owner.workspaces.create({ name: `支持范围-${randomUUID().slice(0, 8)}` });
    const otherWorkspace = await owner.workspaces.create({ name: `其他范围-${randomUUID().slice(0, 8)}` });
    const ticketId = `ticket-${randomUUID()}`;
    async function supportOperator(label: string) {
      const email = `support-${label}-${randomUUID()}@test.local`;
      const created = await createInternalUser(auth, { email, password: ADMIN_PASSWORD, name: label });
      const principalId = `oppr_${randomUUID()}`;
      const roleGrantId = `oprg_${randomUUID()}`;
      await handle.db.insert(adminPrincipals).values({ id: principalId, userId: created.id, environment: 'TEST' });
      await handle.db.insert(adminRoleGrants).values({ id: roleGrantId, principalId, role: 'SUPPORT_L2' });
      await handle.db.insert(adminRoleScopes).values({
        id: `opsc_${randomUUID()}`, roleGrantId, scopeKind: 'WORKSPACE', workspaceId: workspace.id,
        ticketId, expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });
      const uri = await enrollTestOpsTotp(createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' }), email, ADMIN_PASSWORD);
      const operator = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
      await signInTestOpsClient(operator, email, ADMIN_PASSWORD, uri);
      return { operator, principalId, userId: created.id };
    }
    const alice = await supportOperator('alice');
    const bob = await supportOperator('bob');
    await expectApiError(alice.operator.admin.supportView(workspace.id, ticketId), 403, 'SUPPORT_GRANT_REQUIRED');

    // This fixture represents an independently approved grant; the old direct-write API stays closed.
    const grant = await createSupportGrant(deps(), {
      workspaceId: workspace.id, actorUserId: alice.userId,
      request: { purpose: '调查工单渲染异常', ticketId, beneficiaryPrincipalId: alice.principalId, scope: 'SUMMARY_READ', ttlHours: 2 },
    });
    await expectApiError(bob.operator.admin.supportView(workspace.id, ticketId), 403, 'SUPPORT_GRANT_REQUIRED');
    await expectApiError(alice.operator.admin.supportView(workspace.id, 'different-ticket'), 403);
    await createSupportGrant(deps(), {
      workspaceId: otherWorkspace.id, actorUserId: alice.userId,
      request: { purpose: '另一工作区的工单', ticketId, beneficiaryPrincipalId: alice.principalId, scope: 'SUMMARY_READ', ttlHours: 2 },
    });
    await expectApiError(alice.operator.admin.supportView(otherWorkspace.id, ticketId), 403);
    const view = await alice.operator.admin.supportView(workspace.id, ticketId);
    expect(view.grant.id).toBe(grant.id);
    expect(view.workspaceId).toBe(workspace.id);
    expect(JSON.stringify(view)).not.toMatch(/prompt|narration|sourceText/i);
    expect((await handle.db.select().from(auditLog)).filter((row) => row.action === 'support.view' && row.workspaceId === workspace.id)).toHaveLength(1);

    await handle.db.update(supportAccessGrants).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(supportAccessGrants.id, grant.id));
    await expectApiError(alice.operator.admin.supportView(workspace.id, ticketId), 403, 'SUPPORT_GRANT_REQUIRED');
    await revokeSupportGrant(deps(), { grantId: grant.id, actorUserId: alice.userId });
    await expectApiError(alice.operator.admin.supportView(workspace.id, ticketId), 403, 'SUPPORT_GRANT_REQUIRED');
  }, 120_000);

  it('未完成安全投影的旧 Admin 列表拒绝，已审查的 Provider 聚合仍可读取', async () => {
    const owner = await newClient('secops-admin-views');
    const admin = await newAdminClient();
    const workspace = await owner.workspaces.create({ name: `总览-${randomUUID().slice(0, 8)}` });
    await owner.assets.upload(workspace.id, { assetType: 'USER_UPLOAD', filename: 'a.png', contentType: 'image/png', data: makePng() });
    await expectApiError(admin.admin.users({ query: 'secops-admin-views' }), 403);
    await expectApiError(admin.admin.workspaces(), 403);
    await expectApiError(admin.admin.projects({ workspaceId: workspace.id }), 403);
    await expectApiError(admin.admin.storage({ workspaceId: workspace.id }), 403);
    await expectApiError(admin.admin.workspaceCredits(workspace.id), 403);
    await expectApiError(admin.admin.auditLog({ workspaceId: workspace.id }), 403);
    const providerStatus = await admin.admin.providerStatus();
    expect(Array.isArray(providerStatus.items)).toBe(true);
  }, 120_000);
});
