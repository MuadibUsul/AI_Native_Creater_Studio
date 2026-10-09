import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, jobs, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, workspaces, type DbHandle } from '@ancs/db';
import { claimJob, createJob, failJob, retryJob, type DomainDeps } from '@ancs/domain';
import { buildServer } from './server.js';
import { enrollTestOpsTotp, provisionTestOpsPrincipal, signInTestOpsClient, testOpsDeps } from './test-helpers/ops-auth.js';

/**
 * P08-02 验收（真实 DB；**平台管理员与普通用户角色严格分离**——REQ-67-02）：
 * - 普通用户（含 workspace OWNER）访问 /api/v1/admin/* → 404（反枚举，不暴露运营面存在性）；
 *   未认证 → 401；有明确 scope 的运营主体只能读取已收窄的安全投影；
 * - 总览聚合来自真实数据（任务/渲染/QA/审批/Provider 生成/成本）；
 * - 旧管理路由的原始 Job 与 Audit 查询及写操作在 N15-03 fail closed；任务服务重试仍独立验证。
 */

let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let adminEmail = '';
let adminTotpUri = '';
const PASSWORD = 'password-1234';
const ADMIN_PASSWORD = 'admin-password-1234'; // secrets:check-ignore：测试专用假密钥

const deps = (): DomainDeps => ({ db: handle.db });

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
    secret: 'admin-ops-secret-0123456789', // secrets:check-ignore：测试专用假密钥
    baseUrl: 'http://localhost:3001',
  });
  // 独立运营 principal + TOTP，会话由真实 API 二次挑战签发。
  adminEmail = `ops-admin-${randomUUID()}@test.local`;
  const adminUser = await createInternalUser(auth, { email: adminEmail, password: ADMIN_PASSWORD, name: 'ops-admin' });
  await provisionTestOpsPrincipal(handle.db, adminUser.id);
  app = await buildServer({
    auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
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

describe('最小运营（P08-02）', () => {
  it('角色分离：普通用户（含 OWNER）→ 404 反枚举；未认证 → 401；管理员可访问', async () => {
    const owner = await newClient('ops-owner');
    await owner.workspaces.create({ name: `运营-${randomUUID().slice(0, 8)}` });

    // workspace OWNER 也不是平台管理员（不复用普通用户角色）
    const deniedOverview = await owner.admin.overview().catch((error: unknown) => error);
    expect(deniedOverview).toBeInstanceOf(AncsApiError);
    expect((deniedOverview as AncsApiError).status).toBe(404);
    const deniedJobs = await owner.admin.jobs({ workspaceId: 'ws_does_not_matter' }).catch((error: unknown) => error);
    expect((deniedJobs as AncsApiError).status).toBe(404);
    const deniedRetry = await owner.admin.retryJob('job_does_not_matter').catch((error: unknown) => error);
    expect((deniedRetry as AncsApiError).status).toBe(404);

    // 未认证 → 401
    const anonymous = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
    const unauthenticated = await anonymous.admin.overview().catch((error: unknown) => error);
    expect(unauthenticated).toBeInstanceOf(AncsApiError);
    expect((unauthenticated as AncsApiError).status).toBe(401);

    // 管理员：可访问（真实聚合）
    const admin = await newAdminClient();
    const overview = await admin.admin.overview();
    expect(overview.generatedAt).toBeTruthy();
    expect(typeof overview.jobs.failedFinal).toBe('number');
  }, 120_000);

  it('指标导出（P08-03）：管理员可读 Prometheus 文本（API 请求/队列/渲染/QA/告警）', async () => {
    // 制造一次请求（让进程内指标非空）后读取导出
    const admin = await newAdminClient();
    await admin.admin.overview();
    const body = await admin.admin.metricsText();
    expect(body).toContain('ancs_api_requests_total');
    expect(body).toContain('# TYPE ancs_jobs gauge');
    expect(body).toContain('ancs_ops_alerts');
    expect(body).toContain('ancs_api_request_duration_seconds_bucket');
    expect(body).toContain('ancs_qa_reports_total');
  }, 120_000);

  it('总览聚合 + 人工重试（FAILED_FINAL → QUEUED；审计含 job 事件）', async () => {
    const workspaceId = `ws_${randomUUID()}`;
    await handle.db.insert(workspaces).values({ id: workspaceId, name: '运营租户' });
    const created = await createJob(deps(), { workspaceId, type: 'NOOP', input: { echo: 'ops' } });
    await claimJob(deps(), { workerId: 'ops-test', leaseSeconds: 60, types: ['NOOP'] });
    await failJob(deps(), { workspaceId, jobId: created.id, error: { reason: 'OPS_TEST' }, retryable: false });

    const admin = await newAdminClient();
    const overview = await admin.admin.overview();
    expect(overview.jobs.byStatus['FAILED_FINAL']).toBeGreaterThanOrEqual(1);
    expect(overview.jobs.failedFinal).toBeGreaterThanOrEqual(1);

    // 原始任务与审计投影尚未完成字段收窄，旧路由即使有运营会话也拒绝。
    const deniedJobs = await admin.admin.jobs({ status: 'FAILED_FINAL', workspaceId }).catch((error: unknown) => error);
    expect((deniedJobs as AncsApiError).status).toBe(403);
    const deniedRetry = await admin.admin.retryJob(created.id, { reason: '运营人工重试' }).catch((error: unknown) => error);
    expect((deniedRetry as AncsApiError).status).toBe(403);
    const deniedAudit = await admin.admin.audit({ limit: 50 }).catch((error: unknown) => error);
    expect((deniedAudit as AncsApiError).status).toBe(403);
    expect((await handle.db.select().from(jobs).where(eq(jobs.id, created.id)).limit(1))[0]?.status).toBe('FAILED_FINAL');

    // 核心任务服务仍可恢复 FAILED_FINAL，HTTP 管理写入口等待独立审批链。
    const retried = await retryJob(deps(), { workspaceId, jobId: created.id, reason: '运营人工重试' });
    expect(retried.status).toBe('QUEUED');
    expect(retried.nextAttemptAt).toBeNull();
    const after = (await handle.db.select().from(jobs).where(eq(jobs.id, created.id)).limit(1))[0];
    expect(after?.status).toBe('QUEUED');

  }, 120_000);
});
