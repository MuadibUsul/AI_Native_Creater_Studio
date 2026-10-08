import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { auditLog, createDb, plans, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, workspaces, type DbHandle } from '@ancs/db';
import { createJob, ensureDefaultPlans, recordAudit, type DomainDeps } from '@ancs/domain';
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

  it('滥用处理：标记创建/解决 + 限制状态阻止新任务（403），解除即恢复；全程审计', async () => {
    const owner = await newClient('secops-abuse');
    const admin = await newAdminClient();
    const workspace = await owner.workspaces.create({ name: `滥用-${randomUUID().slice(0, 8)}` });

    // 标记：创建 → OPEN；解决 → RESOLVED（重复解决 409）
    const flag = await admin.admin.createAbuseFlag(workspace.id, { category: 'SPAM', severity: 'HIGH', note: '批量垃圾项目（人工核查）' });
    expect(flag.status).toBe('OPEN');
    expect((await admin.admin.abuseFlags({ workspaceId: workspace.id })).map((item) => item.id)).toContain(flag.id);
    const resolved = await admin.admin.resolveAbuseFlag(flag.id, { resolutionNote: '已警告并清理' });
    expect(resolved.status).toBe('RESOLVED');
    await expectApiError(admin.admin.resolveAbuseFlag(flag.id, { resolutionNote: '重复' }), 409);

    // 限制：RESTRICTED → **新任务被阻止**（域闸门，全 API 路径共用）
    await admin.admin.setAbuseState(workspace.id, { abuseState: 'RESTRICTED', note: '调查中' });
    const blocked = await createJob(deps(), { workspaceId: workspace.id, type: 'NOOP_TEST' }).catch((error: unknown) => error);
    expect((blocked as { httpStatus?: number }).httpStatus).toBe(403);
    expect(((blocked as { details?: { reason?: string } }).details ?? {}).reason).toBe('WORKSPACE_RESTRICTED');

    // 解除 → 恢复
    await admin.admin.setAbuseState(workspace.id, { abuseState: 'NORMAL', note: '解除' });
    const job = await createJob(deps(), { workspaceId: workspace.id, type: 'NOOP_TEST' });
    expect(job.status).toBe('QUEUED');

    // 审计：flag 创建/解决 + 状态设置
    const auditLogRows = await admin.admin.auditLog({ workspaceId: workspace.id });
    const actions = auditLogRows.map((row) => row.action);
    expect(actions).toContain('abuse.flag.create');
    expect(actions).toContain('abuse.flag.resolve');
    expect(actions).toContain('abuse.state.set');
  }, 120_000);

  it('支持访问不可无痕：无授权 403；授权对成员可见；每次访问留痕 + 成员可见事件；撤销后 403', async () => {
    const owner = await newClient('secops-support');
    const admin = await newAdminClient();
    const workspace = await owner.workspaces.create({ name: `支持-${randomUUID().slice(0, 8)}` });

    // 无授权 → 403（明确 reason）
    await expectApiError(admin.admin.supportView(workspace.id), 403, 'SUPPORT_GRANT_REQUIRED');

    // 授权创建 → **成员可见事件**（不可无痕）
    const grant = await admin.admin.createSupportGrant(workspace.id, { purpose: '排查渲染失败工单 #42', ttlHours: 2 });
    expect(grant.status).toBe('ACTIVE');
    const eventsAfterGrant = await owner.events.list(workspace.id, { cursor: 0 });
    const grantEvent = eventsAfterGrant.events.find((event) => event.eventType === 'support.access_granted');
    expect(grantEvent).toBeDefined();
    expect(grantEvent?.payload['purpose']).toBe('排查渲染失败工单 #42');

    // 支持视图：仅元数据摘要（无项目内容/素材字节/Prompt）
    const view = await admin.admin.supportView(workspace.id);
    expect(view.workspaceId).toBe(workspace.id);
    expect(view.counts.members).toBe(1);
    expect(view.grant.id).toBe(grant.id);
    expect(JSON.stringify(view)).not.toMatch(/prompt|narration|sourceText/i);

    // 每次访问留痕：成员可见 `support.viewed` 事件 + audit_log 行
    const eventsAfterView = await owner.events.list(workspace.id, { cursor: 0 });
    expect(eventsAfterView.events.some((event) => event.eventType === 'support.viewed')).toBe(true);
    const auditRows = await admin.admin.auditLog({ workspaceId: workspace.id });
    expect(auditRows.some((row) => row.action === 'support.view' && row.actorKind === 'PLATFORM_ADMIN')).toBe(true);
    expect(auditRows.some((row) => row.action === 'support.grant.create')).toBe(true);

    // 撤销 → 再访问 403；重复撤销 409
    await admin.admin.revokeSupportGrant(grant.id);
    await expectApiError(admin.admin.supportView(workspace.id), 403, 'SUPPORT_GRANT_REQUIRED');
    await expectApiError(admin.admin.revokeSupportGrant(grant.id), 409);
  }, 120_000);

  it('完整 Admin（§67）：users/workspaces/projects/provider-status/storage/credits 只读聚合 + 审计表', async () => {
    const owner = await newClient('secops-admin-views');
    const admin = await newAdminClient();
    const workspace = await owner.workspaces.create({ name: `总览-${randomUUID().slice(0, 8)}` });
    const ownerEmail = (await owner.auth.session()).user.email;

    // 上传一张图 → storage 聚合非零
    await owner.assets.upload(workspace.id, { assetType: 'USER_UPLOAD', filename: 'a.png', contentType: 'image/png', data: makePng() });

    // users：包含 owner（含参与 Workspace 数）
    const users = await admin.admin.users({ query: 'secops-admin-views' });
    const ownerRow = users.find((row) => row.email === ownerEmail);
    expect(ownerRow?.workspaceCount).toBeGreaterThanOrEqual(1);

    // workspaces：包含该 workspace（套餐/成员/存储/积分/限制状态字段齐全）
    const workspaceRows = await admin.admin.workspaces();
    const workspaceRow = workspaceRows.find((row) => row.id === workspace.id);
    expect(workspaceRow?.membersUsed).toBe(1);
    expect(workspaceRow?.abuseState).toBe('NORMAL');
    expect(workspaceRow?.storageBytesUsed).toBeGreaterThan(0);

    // 套餐指派 → 审计 `plan.assign`；credits 平台视图
    await admin.admin.assignPlan(workspace.id, { planKey: 'FREE' });
    const credits = await admin.admin.workspaceCredits(workspace.id);
    expect(credits.balanceCredits).toBe(0);
    const auditRows = await admin.admin.auditLog({ workspaceId: workspace.id });
    expect(auditRows.some((row) => row.action === 'plan.assign')).toBe(true);

    // storage / provider-status / projects 形状
    const storageSummary = await admin.admin.storage();
    expect(storageSummary.totalBytes).toBeGreaterThan(0);
    expect(storageSummary.items.some((item) => item.workspaceId === workspace.id)).toBe(true);
    const providerStatus = await admin.admin.providerStatus();
    expect(Array.isArray(providerStatus.items)).toBe(true);
    const projects = await admin.admin.projects({ workspaceId: workspace.id });
    expect(Array.isArray(projects)).toBe(true);
  }, 120_000);
});
