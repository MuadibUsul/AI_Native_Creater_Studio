import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  budgetCounters,
  createDb,
  creditHolds,
  providerGenerations,
  redactDatabaseUrl,
  resolveTestDatabaseUrl,
  runMigrations,
  workspaces,
  type DbHandle,
} from '@ancs/db';
import {
  completeProviderGeneration,
  getBalanceCredits,
  getBillingStatus,
  listLedger,
  listProviderGenerations,
  periodKey,
  recordProviderGeneration,
  releaseHold,
  reserveCredits,
  settleHold,
  topUpCredits,
  upsertBudget,
  type DomainDeps,
} from '@ancs/domain';

/**
 * P03-05 验收（真实 DB）：
 * - **并发抢预算不超额（AC-11）**：20 个并发预留抢 100 Credits 限额 → 恰 10 个成功；
 * - **回调重放只结算一次**：重复结算返回原结果且账本条目数不变；
 * - 账本只追加：余额 = 条目效果之和；HOLD/HOLD_RELEASE 不改余额；
 * - per-job 上限、跨周期归还（periodKeys 快照）、释放幂等、重试复用同一预留；
 * - Provider 用量记录：唯一键幂等（重放返回原记录）；BYOK 计费经策略（默认 0，可注入）。
 */

let handle: DbHandle;
const deps = (override: Partial<DomainDeps> = {}): DomainDeps => ({ db: handle.db, ...override });

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
});

afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  await handle.db.delete(workspaces);
});

async function makeWorkspace(): Promise<string> {
  const workspaceId = `ws_${randomUUID()}`;
  await handle.db.insert(workspaces).values({ id: workspaceId, name: '计费测试租户' });
  return workspaceId;
}

describe('预算预留与原子性（AC-11）', () => {
  it('并发抢预算不超额：20 × 10 Credits 抢 100 限额 → 恰 10 个成功且不变量成立', async () => {
    const workspaceId = await makeWorkspace();
    await upsertBudget(deps(), { workspaceId, input: { period: 'MONTHLY', limitCredits: 100, perJobMaxCredits: 0 } });

    const attempts = await Promise.allSettled(
      Array.from({ length: 20 }, (_unused, index) =>
        reserveCredits(deps(), { workspaceId, jobId: `job_${String(index)}`, estimatedCredits: 10 }),
      ),
    );
    const fulfilled = attempts.filter((result) => result.status === 'fulfilled');
    const rejected = attempts.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(10);
    expect(rejected).toHaveLength(10);
    for (const failure of rejected) {
      const reason = (failure as PromiseRejectedResult).reason as { code?: string; httpStatus?: number; details?: { reason?: string } };
      expect(reason.code).toBe('BUDGET_EXCEEDED');
      expect(reason.httpStatus).toBe(402);
      expect(reason.details?.reason).toBe('BUDGET_EXCEEDED');
    }

    const key = periodKey('MONTHLY', new Date());
    const counterRows = await handle.db
      .select()
      .from(budgetCounters)
      .where(eq(budgetCounters.workspaceId, workspaceId));
    const counter = counterRows.find((row) => row.periodKey === key);
    expect(counter?.reservedCredits).toBe(100);
    expect(counter?.spentCredits).toBe(0);
    expect((counter?.spentCredits ?? 0) + (counter?.reservedCredits ?? 0)).toBeLessThanOrEqual(100);
    // 账本：10 条 HOLD，均不改变余额
    const entries = await listLedger(deps(), { workspaceId });
    expect(entries.filter((entry) => entry.entryType === 'HOLD')).toHaveLength(10);
    expect(await getBalanceCredits(deps(), { workspaceId })).toBe(0);
  });

  it('per-job 上限（REQ-68-01）：超限直接拒绝并给出上限', async () => {
    const workspaceId = await makeWorkspace();
    await upsertBudget(deps(), { workspaceId, input: { period: 'MONTHLY', limitCredits: 1000, perJobMaxCredits: 50 } });
    const failure = await reserveCredits(deps(), { workspaceId, jobId: 'job_big', estimatedCredits: 51 }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'BUDGET_EXCEEDED', httpStatus: 402 });
    expect((failure as { details: { reason?: string; perJobMaxCredits?: number } }).details).toMatchObject({
      reason: 'PER_JOB_LIMIT',
      perJobMaxCredits: 50,
    });
  });

  it('预留幂等与重试复用：同 job 同金额不重复占额；结算后重试重新占用', async () => {
    const workspaceId = await makeWorkspace();
    await upsertBudget(deps(), { workspaceId, input: { period: 'MONTHLY', limitCredits: 100, perJobMaxCredits: 0 } });

    const first = await reserveCredits(deps(), { workspaceId, jobId: 'job_retry', estimatedCredits: 30 });
    const again = await reserveCredits(deps(), { workspaceId, jobId: 'job_retry', estimatedCredits: 30 });
    expect(again.id).toBe(first.id);
    const key = periodKey('MONTHLY', new Date());
    let counter = (await handle.db.select().from(budgetCounters).where(eq(budgetCounters.workspaceId, workspaceId))).find((row) => row.periodKey === key);
    expect(counter?.reservedCredits).toBe(30);
    expect((await listLedger(deps(), { workspaceId })).filter((entry) => entry.entryType === 'HOLD')).toHaveLength(1);

    // 结算 → 重试（同 job）：同行重新占用（不新增 hold 行）
    await settleHold(deps(), { workspaceId, jobId: 'job_retry', actualCredits: 12 });
    const retry = await reserveCredits(deps(), { workspaceId, jobId: 'job_retry', estimatedCredits: 30 });
    expect(retry.id).toBe(first.id);
    expect(retry.status).toBe('HELD');
    counter = (await handle.db.select().from(budgetCounters).where(eq(budgetCounters.workspaceId, workspaceId))).find((row) => row.periodKey === key);
    expect(counter).toMatchObject({ reservedCredits: 30, spentCredits: 12 });
    const holdRows = await handle.db.select().from(creditHolds).where(eq(creditHolds.workspaceId, workspaceId));
    expect(holdRows).toHaveLength(1);
  });
});

describe('结算幂等（回调重放只结算一次）', () => {
  it('重复结算：返回原结果、账本条目不增、计数器只减一次', async () => {
    const workspaceId = await makeWorkspace();
    await upsertBudget(deps(), { workspaceId, input: { period: 'MONTHLY', limitCredits: 100, perJobMaxCredits: 0 } });
    await reserveCredits(deps(), { workspaceId, jobId: 'job_settle', estimatedCredits: 50 });

    const first = await settleHold(deps(), { workspaceId, jobId: 'job_settle', actualCredits: 42 });
    expect(first.hold.status).toBe('SETTLED');
    expect(first.hold.settledCredits).toBe(42);
    expect(first.ledgerEntriesWritten).toBe(2); // HOLD_RELEASE + DEBIT

    const entriesAfterFirst = await listLedger(deps(), { workspaceId });
    const second = await settleHold(deps(), { workspaceId, jobId: 'job_settle', actualCredits: 42 });
    const third = await settleHold(deps(), { workspaceId, jobId: 'job_settle', actualCredits: 999 }); // 数值不同也幂等（以首次为准）
    expect(second.hold.settledCredits).toBe(42);
    expect(third.hold.settledCredits).toBe(42);
    expect(second.ledgerEntriesWritten).toBe(0);
    expect(third.ledgerEntriesWritten).toBe(0);
    expect((await listLedger(deps(), { workspaceId })).length).toBe(entriesAfterFirst.length);

    const key = periodKey('MONTHLY', new Date());
    const counter = (await handle.db.select().from(budgetCounters).where(eq(budgetCounters.workspaceId, workspaceId))).find((row) => row.periodKey === key);
    expect(counter).toMatchObject({ reservedCredits: 0, spentCredits: 42 });

    // 余额 = 条目效果之和（HOLD/HOLD_RELEASE 不影响余额；DEBIT 扣除）
    await topUpCredits(deps(), { workspaceId, amountCredits: 100, note: '测试充值' });
    expect(await getBalanceCredits(deps(), { workspaceId })).toBe(58);

    const status = await getBillingStatus(deps(), { workspaceId });
    expect(status.balanceCredits).toBe(58);
    expect(status.usage).toMatchObject({ periodKey: key, spentCredits: 42, reservedCredits: 0 });
  });

  it('释放幂等与结算冲突：释放后不结算（409）；重复释放不重复写账本', async () => {
    const workspaceId = await makeWorkspace();
    await upsertBudget(deps(), { workspaceId, input: { period: 'MONTHLY', limitCredits: 100, perJobMaxCredits: 0 } });
    await reserveCredits(deps(), { workspaceId, jobId: 'job_release', estimatedCredits: 25 });

    const first = await releaseHold(deps(), { workspaceId, jobId: 'job_release', reason: 'JOB_FAILED' });
    expect(first.hold.status).toBe('RELEASED');
    expect(first.ledgerEntriesWritten).toBe(1);
    const second = await releaseHold(deps(), { workspaceId, jobId: 'job_release', reason: 'JOB_FAILED' });
    expect(second.ledgerEntriesWritten).toBe(0);
    expect(second.hold.releaseReason).toBe('JOB_FAILED');

    const settleAfterRelease = await settleHold(deps(), { workspaceId, jobId: 'job_release', actualCredits: 1 }).catch((error: unknown) => error);
    expect(settleAfterRelease).toMatchObject({ httpStatus: 409 });

    const key = periodKey('MONTHLY', new Date());
    const counter = (await handle.db.select().from(budgetCounters).where(eq(budgetCounters.workspaceId, workspaceId))).find((row) => row.periodKey === key);
    expect(counter).toMatchObject({ reservedCredits: 0, spentCredits: 0 });
  });

  it('跨周期归还：按预留时快照的 periodKey 归还，不串账', async () => {
    const workspaceId = await makeWorkspace();
    await upsertBudget(deps(), { workspaceId, input: { period: 'MONTHLY', limitCredits: 100, perJobMaxCredits: 0 } });
    const reserveDay = new Date('2026-10-31T23:00:00.000Z');
    const settleDay = new Date('2026-11-01T01:00:00.000Z');
    await reserveCredits(deps(), { workspaceId, jobId: 'job_cross', estimatedCredits: 20, now: reserveDay });

    const settle = await settleHold(deps(), { workspaceId, jobId: 'job_cross', actualCredits: 5, now: settleDay });
    expect(settle.hold.status).toBe('SETTLED');
    const counters = await handle.db.select().from(budgetCounters).where(eq(budgetCounters.workspaceId, workspaceId));
    const october = counters.find((row) => row.periodKey === '2026-10');
    const november = counters.find((row) => row.periodKey === '2026-11');
    expect(october).toMatchObject({ reservedCredits: 0, spentCredits: 5 }); // 归还与计入都落在预留周期
    expect(november).toBeUndefined();
  });
});

describe('Provider 用量记录（REQ-25-01；重放不重复记账）', () => {
  it('唯一键幂等：重复记录返回原行；BYOK 计费经策略（默认 0，可注入）', async () => {
    const workspaceId = await makeWorkspace();
    const input = {
      jobId: 'job_gen',
      providerId: 'tts.byok',
      modelId: 'tts-fast-v1',
      operation: 'speech.synthesize',
      credentialMode: 'BYOK' as const,
      inputHash: 'sha256:abc',
      attempt: 0,
      providerJobId: 'pjob_1',
      estimatedCost: { amount: '0.30', currency: 'USD' },
      estimatedCredits: 10,
    };
    const first = await recordProviderGeneration(deps(), { workspaceId, input });
    const replay = await recordProviderGeneration(deps(), { workspaceId, input });
    expect(replay.id).toBe(first.id);
    expect(await handle.db.select().from(providerGenerations).where(eq(providerGenerations.workspaceId, workspaceId))).toHaveLength(1);

    // 默认策略：BYOK 不扣平台 Credits
    const done = await completeProviderGeneration(deps(), {
      workspaceId,
      generationId: first.id,
      status: 'SUCCEEDED',
      actualCost: { amount: '0.28', currency: 'USD' },
      meteredCredits: 10,
      latencyMs: 1234,
    });
    expect(done.actualCredits).toBe(0);
    expect(done.latencyMs).toBe(1234);

    // 完成重放：原结果（不覆盖、不改成本）
    const doneReplay = await completeProviderGeneration(deps(), {
      workspaceId,
      generationId: first.id,
      status: 'FAILED',
      actualCost: { amount: '9.99', currency: 'USD' },
      meteredCredits: 999,
    });
    expect(doneReplay.status).toBe('SUCCEEDED');
    expect(doneReplay.actualCredits).toBe(0);

    // 注入策略：BYOK 按平台策略计 workflow credits（§35.2 策略位）
    const policyDeps = deps({ billingPolicy: { creditsForByok: (metered) => Math.ceil(metered / 2) } });
    const managed = await recordProviderGeneration(policyDeps, {
      workspaceId,
      input: { ...input, jobId: 'job_gen2', credentialMode: 'PLATFORM_MANAGED' as const, operation: 'speech.synthesize', attempt: 0 },
    });
    const managedDone = await completeProviderGeneration(policyDeps, {
      workspaceId,
      generationId: managed.id,
      status: 'SUCCEEDED',
      meteredCredits: 7,
    });
    expect(managedDone.actualCredits).toBe(7); // Managed 全量计费

    const byokSecond = await recordProviderGeneration(policyDeps, {
      workspaceId,
      input: { ...input, jobId: 'job_gen3', credentialMode: 'BYOK' as const },
    });
    const byokSecondDone = await completeProviderGeneration(policyDeps, {
      workspaceId,
      generationId: byokSecond.id,
      status: 'SUCCEEDED',
      meteredCredits: 10,
    });
    expect(byokSecondDone.actualCredits).toBe(5); // BYOK 经策略折算

    const listed = await listProviderGenerations(deps(), { workspaceId });
    expect(listed).toHaveLength(3);
  });
});
