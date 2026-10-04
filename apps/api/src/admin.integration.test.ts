import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, jobs, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, workspaces, type DbHandle } from '@ancs/db';
import { claimJob, createJob, failJob, type DomainDeps } from '@ancs/domain';
import { buildServer } from './server.js';

/**
 * P08-02 验收（真实 DB；**平台管理员与普通用户角色严格分离**——REQ-67-02）：
 * - 普通用户（含 workspace OWNER）访问 /api/v1/admin/* → 404（反枚举，不暴露运营面存在性）；
 *   未认证 → 401；管理员（部署配置名单）→ 可访问；
 * - 总览聚合来自真实数据（任务/渲染/QA/审批/Provider 生成/成本）；
 * - **人工重试复用任务服务**：FAILED_FINAL → QUEUED（预算/幂等/版本规则不变），审计含 job 事件。
 */

let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let adminEmail = '';
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
  // 管理员名单来自**部署配置**（此处注入测试名单）：先建用户拿 id，再以其 id 构建 admin 守卫
  adminEmail = `ops-admin-${randomUUID()}@test.local`;
  const adminUser = await createInternalUser(auth, { email: adminEmail, password: ADMIN_PASSWORD, name: 'ops-admin' });
  app = await buildServer({
    auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
    admin: { userIds: [adminUser.id] },
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
  await client.auth.signIn({ email: adminEmail, password: ADMIN_PASSWORD });
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
    const deniedJobs = await owner.admin.jobs().catch((error: unknown) => error);
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

    const failed = await admin.admin.jobs({ status: 'FAILED_FINAL', workspaceId });
    expect(failed.some((job) => job.id === created.id)).toBe(true);

    // 人工重试：复用任务服务（FAILED_FINAL → QUEUED；清退避；不绕过任何规则）
    const retried = await admin.admin.retryJob(created.id, { reason: '运营人工重试' });
    expect(retried.status).toBe('QUEUED');
    expect(retried.nextAttemptAt).toBeNull();
    const after = (await handle.db.select().from(jobs).where(eq(jobs.id, created.id)).limit(1))[0];
    expect(after?.status).toBe('QUEUED');

    // 审计：job 事件（重试）与失败事件可见
    const audit = await admin.admin.audit({ limit: 50 });
    expect(audit.some((entry) => entry.kind === 'JOB' && entry.workspaceId === workspaceId)).toBe(true);
  }, 120_000);
});
