import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import {
  ApiFailure,
  DEFAULT_QUEUE,
  ERROR_CODES,
  JOB_TERMINAL_STATUSES,
  jobSchema,
  type Job,
  type JobQueueAdapter,
  type JobQueueMessage,
  type JobStatus,
} from '@ancs/contracts';
import { jobDependencies, jobs, outboxEvents, workspaces } from '@ancs/db';
import type { DomainDeps } from './deps.js';
import { workspaceRestrictedFailure } from './security-ops.js';

/**
 * 任务系统（P03-01 / 计划 §5.5；规范 §35 强制规则）。
 *
 * 核心不变量：
 * 1. 权威状态在 PostgreSQL；队列消息只携带任务 ID（Worker 从 DB 读输入）；
 * 2. **事务 + Outbox**：任务创建/状态迁移时同事务写 `job.queued` / `job.started` /
 *    `job.completed` / `job.failed` 事件；派发中断（进程崩溃/队列不可用）后事件未标记
 *    published → 重跑派发即恢复（不丢任务）；
 * 3. **租约恢复**：RUNNING/PROVIDER_QUEUED 的租约到期由 `requeueExpiredLeases` 回收；
 * 4. **依赖**：WAITING_DEPENDENCY 在依赖全部成功后自动升级为 QUEUED（并产生派发事件）；
 *    任一依赖失败/取消 → 依赖方以明确结果传播终止（绝不永久等待）；
 * 5. 状态迁移只经 `transitionJob`（回调、轮询、人工恢复共用同一服务）。
 */

export const NOOP_JOB_TYPE = 'NOOP';
export const MAINTENANCE_RETENTION_JOB_TYPE = 'MAINTENANCE_RETENTION_SWEEP';
export const MAINTENANCE_DISPATCH_JOB_TYPE = 'MAINTENANCE_NOTIFICATION_DISPATCH';

/** 状态机：允许的迁移（计划 §5.5） */
const ALLOWED_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  WAITING_DEPENDENCY: ['QUEUED', 'CANCELLED', 'FAILED_FINAL'],
  QUEUED: ['RUNNING', 'CANCELLED', 'FAILED_FINAL'],
  RUNNING: ['PROVIDER_QUEUED', 'SUCCEEDED', 'FAILED_RETRYABLE', 'FAILED_FINAL', 'CANCEL_REQUESTED', 'QUEUED'],
  PROVIDER_QUEUED: ['RUNNING', 'SUCCEEDED', 'FAILED_RETRYABLE', 'FAILED_FINAL', 'CANCEL_REQUESTED', 'QUEUED'],
  SUCCEEDED: [],
  FAILED_RETRYABLE: ['QUEUED', 'FAILED_FINAL', 'CANCELLED'],
  FAILED_FINAL: ['QUEUED'],
  CANCEL_REQUESTED: ['CANCELLED', 'SUCCEEDED', 'FAILED_FINAL'],
  CANCELLED: ['QUEUED'],
};

export const DEFAULT_LEASE_SECONDS = 60;

/**
 * 退避与抖动（P03-02）：FAILED_RETRYABLE 的下次可认领时间 = base * 2^(attempts-1)，上限 cap，
 * 再乘 ±jitterRatio 的随机抖动（避免惊群）。可通过 DomainDeps.retryPolicy 覆盖（测试用确定性参数）。
 */
export const DEFAULT_RETRY_BASE_SECONDS = 5;
export const DEFAULT_RETRY_CAP_SECONDS = 300;
export const DEFAULT_RETRY_JITTER_RATIO = 0.2;

export interface RetryPolicy {
  baseSeconds?: number;
  capSeconds?: number;
  jitterRatio?: number;
  /** 注入随机源（测试用；返回 [0,1)） */
  random?: () => number;
}

export function computeBackoffSeconds(attempts: number, policy: RetryPolicy = {}): number {
  const base = policy.baseSeconds ?? DEFAULT_RETRY_BASE_SECONDS;
  const cap = policy.capSeconds ?? DEFAULT_RETRY_CAP_SECONDS;
  const jitterRatio = policy.jitterRatio ?? DEFAULT_RETRY_JITTER_RATIO;
  const exponential = Math.min(base * 2 ** Math.max(attempts - 1, 0), cap);
  const random = policy.random ?? Math.random;
  const jitter = (random() * 2 - 1) * jitterRatio; // [-jitterRatio, +jitterRatio)
  return Math.max(0, Math.round(exponential * (1 + jitter)));
}

/** DB 轮询队列（V1 默认传输）：投递即"标记可认领"，正确性由 jobs 表 + 回收扫描保证。 */
export class DbPollQueue implements JobQueueAdapter {
  readonly kind = 'db-poll';
  async enqueue(): Promise<void> {
    // 无需外部动作：Worker 直接认领 jobs 表中的 QUEUED 任务（权威状态即队列）
  }
}

export function requireQueue(deps: DomainDeps): JobQueueAdapter {
  return deps.queue ?? new DbPollQueue();
}

export const toJobDto = (row: typeof jobs.$inferSelect): Job =>
  jobSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    type: row.type,
    status: row.status,
    stage: row.stage,
    submitState: row.submitState,
    input: row.input,
    result: row.result,
    error: row.error,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    priority: row.priority,
    needsReconciliation: row.needsReconciliation,
    nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
    enqueuedAt: row.enqueuedAt?.toISOString() ?? null,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });

export async function loadJobRow(
  deps: DomainDeps,
  input: { workspaceId: string; jobId: string },
): Promise<typeof jobs.$inferSelect> {
  const rows = await deps.db
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, input.jobId), eq(jobs.workspaceId, input.workspaceId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'job not found', 404);
  return row;
}

export async function getJob(deps: DomainDeps, input: { workspaceId: string; jobId: string }): Promise<Job> {
  return toJobDto(await loadJobRow(deps, input));
}

export async function listJobs(
  deps: DomainDeps,
  input: { workspaceId: string; projectId?: string; status?: JobStatus; limit?: number },
): Promise<Job[]> {
  const conditions = [eq(jobs.workspaceId, input.workspaceId)];
  if (input.projectId !== undefined) conditions.push(eq(jobs.projectId, input.projectId));
  if (input.status !== undefined) conditions.push(eq(jobs.status, input.status));
  const rows = await deps.db
    .select()
    .from(jobs)
    .where(and(...conditions))
    .orderBy(desc(jobs.createdAt))
    .limit(Math.min(Math.max(input.limit ?? 50, 1), 200));
  return rows.map(toJobDto);
}

/** 依赖判定：全部成功 → 可升级；任一失败/取消 → 明确终止。 */
async function evaluateDependencies(
  deps: DomainDeps,
  tx: Parameters<Parameters<DomainDeps['db']['transaction']>[0]>[0],
  jobId: string,
): Promise<{ ready: boolean; blocking?: { dependencyJobId: string; status: string } }> {
  const dependencyRows = await tx
    .select({ dependsOnJobId: jobDependencies.dependsOnJobId })
    .from(jobDependencies)
    .where(eq(jobDependencies.jobId, jobId));
  if (dependencyRows.length === 0) return { ready: true };
  const ids = dependencyRows.map((row) => row.dependsOnJobId);
  const dependencyJobs = await tx
    .select({ id: jobs.id, status: jobs.status })
    .from(jobs)
    .where(inArray(jobs.id, ids));
  for (const dependency of dependencyJobs) {
    if (dependency.status === 'FAILED_FINAL' || dependency.status === 'CANCELLED') {
      return { ready: false, blocking: { dependencyJobId: dependency.id, status: dependency.status } };
    }
    if (dependency.status !== 'SUCCEEDED') {
      return { ready: false };
    }
  }
  return { ready: true };
}

/** 写入事件（与状态变更同事务；派发/SSE 共用）。 */
async function emitJobEvent(
  tx: Parameters<Parameters<DomainDeps['db']['transaction']>[0]>[0],
  row: { id: string; workspaceId: string; projectId: string | null; type: string; status: string; attempts: number },
  eventType: 'job.queued' | 'job.started' | 'job.progress' | 'job.completed' | 'job.failed',
  extra: Record<string, unknown> = {},
): Promise<void> {
  await tx.insert(outboxEvents).values({
    id: `obx_${randomUUID()}`,
    workspaceId: row.workspaceId,
    type: eventType,
    payload: {
      jobId: row.id,
      projectId: row.projectId,
      jobType: row.type,
      status: row.status,
      attempts: row.attempts,
      actorType: 'SYSTEM',
      actorId: null,
      ...extra,
    },
  });
}

export interface CreateJobInput {
  workspaceId: string;
  projectId?: string | null;
  type: string;
  input?: Record<string, unknown>;
  /** 依赖的任务（全部成功后才可运行） */
  dependsOn?: string[];
  priority?: number;
  maxAttempts?: number;
  createdBy?: string | null;
  /** SYSTEM 为非成本性内部维护/通知任务；默认 COSTED，受工作区滥用限制闸门约束。 */
  classification?: 'COSTED' | 'SYSTEM';
}

/**
 * 创建任务（事务）：WAITING_DEPENDENCY（有依赖）或 QUEUED（无依赖）。
 * 同事务写 `job.queued`（或依赖等待不写派发事件）——事务提交后即使派发进程崩溃，事件仍在 Outbox。
 */
export async function createJob(deps: DomainDeps, input: CreateJobInput): Promise<Job> {
  const dependsOn = [...new Set(input.dependsOn ?? [])];
  if (dependsOn.includes('unknown')) throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'invalid dependency', 400);

  return deps.db.transaction(async (tx) => {
    if (dependsOn.length > 0) {
      const found = await tx
        .select({ id: jobs.id, workspaceId: jobs.workspaceId })
        .from(jobs)
        .where(inArray(jobs.id, dependsOn));
      if (found.length !== dependsOn.length) {
        throw new ApiFailure(ERROR_CODES.NOT_FOUND, '依赖任务不存在', 404, { dependsOn });
      }
      for (const row of found) {
        if (row.workspaceId !== input.workspaceId) {
          throw new ApiFailure(ERROR_CODES.NOT_FOUND, '依赖任务不存在', 404, { dependsOn });
        }
      }
    }

    // 滥用限制闸门（P09-05）：RESTRICTED 工作区的新任务被阻止（已入队/运行中任务不受影响）
    const abuseRows = await tx.select({ abuseState: workspaces.abuseState }).from(workspaces).where(eq(workspaces.id, input.workspaceId)).limit(1);
    if (input.classification !== 'SYSTEM' && abuseRows[0]?.abuseState === 'RESTRICTED') {
      throw workspaceRestrictedFailure();
    }

    const now = new Date();
    const status: JobStatus = dependsOn.length > 0 ? 'WAITING_DEPENDENCY' : 'QUEUED';
    const inserted = await tx
      .insert(jobs)
      .values({
        id: `job_${randomUUID()}`,
        workspaceId: input.workspaceId,
        projectId: input.projectId ?? null,
        type: input.type,
        status,
        input: input.input ?? {},
        priority: input.priority ?? 0,
        maxAttempts: input.maxAttempts ?? 3,
        createdBy: input.createdBy ?? null,
        updatedAt: now,
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new ApiFailure(ERROR_CODES.INTERNAL, 'job insert failed', 500);

    for (const dependencyId of dependsOn) {
      await tx.insert(jobDependencies).values({ id: `jd_${randomUUID()}`, jobId: row.id, dependsOnJobId: dependencyId });
    }
    if (status === 'QUEUED') {
      await emitJobEvent(tx, row, 'job.queued');
    }
    return toJobDto(row);
  });
}

export interface CreateJobTxInput {
  workspaceId: string;
  projectId?: string | null;
  type: string;
  input?: Record<string, unknown>;
  priority?: number;
  maxAttempts?: number;
  createdBy?: string | null;
  /** SYSTEM 为非成本性内部维护/通知任务；默认 COSTED。 */
  classification?: 'COSTED' | 'SYSTEM';
}

/**
 * 事务内创建**无依赖**任务（QUEUED + `job.queued` 事件）。
 *
 * P07-04：Render 记录与 Final 合成任务在**同一事务**入队——避免"渲染已创建但任务丢失"
 * 的半提交窗口（提交后 Outbox 事件保证派发；进程崩溃由重跑派发恢复）。
 */
export async function createJobInTx(
  tx: Parameters<Parameters<DomainDeps['db']['transaction']>[0]>[0],
  input: CreateJobTxInput,
): Promise<Job> {
  // 滥用限制闸门（P09-05）：RESTRICTED 工作区的新任务被阻止（已入队/运行中任务不受影响）
  const abuseRows = await tx.select({ abuseState: workspaces.abuseState }).from(workspaces).where(eq(workspaces.id, input.workspaceId)).limit(1);
  if (input.classification !== 'SYSTEM' && abuseRows[0]?.abuseState === 'RESTRICTED') {
    throw workspaceRestrictedFailure();
  }
  const now = new Date();
  const inserted = await tx
    .insert(jobs)
    .values({
      id: `job_${randomUUID()}`,
      workspaceId: input.workspaceId,
      projectId: input.projectId ?? null,
      type: input.type,
      status: 'QUEUED',
      input: input.input ?? {},
      priority: input.priority ?? 0,
      maxAttempts: input.maxAttempts ?? 3,
      createdBy: input.createdBy ?? null,
      updatedAt: now,
    })
    .returning();
  const row = inserted[0];
  if (!row) throw new ApiFailure(ERROR_CODES.INTERNAL, 'job insert failed', 500);
  await emitJobEvent(tx, row, 'job.queued');
  return toJobDto(row);
}

export interface TransitionInput {
  workspaceId: string;
  jobId: string;
  to: JobStatus;
  /** 执行阶段（可选） */
  stage?: string | null;
  submitState?: 'NOT_SUBMITTED' | 'SUBMITTED' | 'SUBMISSION_UNKNOWN';
  result?: Record<string, unknown> | null;
  error?: Record<string, unknown> | null;
  /** 迁移原因（进入 error/审计；如 LEASE_EXPIRED / WORKER_COMPLETE / DEPENDENCY_FAILED） */
  reason?: string;
  extra?: Record<string, unknown>;
}

/**
 * 唯一的状态迁移服务（Worker 完成/失败、回调、人工 retry/cancel 全部经此）。
 * 同事务：状态 + 时间戳 + 事件（Outbox）；终态时解析依赖方（升级或传播终止）。
 */
export async function transitionJob(deps: DomainDeps, input: TransitionInput): Promise<Job> {
  return deps.db.transaction(async (tx) => {
    await tx.execute(sql`select id from jobs where id = ${input.jobId} for update`);
    const rows = await tx.select().from(jobs).where(eq(jobs.id, input.jobId)).limit(1);
    const row = rows[0];
    if (!row || row.workspaceId !== input.workspaceId) {
      throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'job not found', 404);
    }
    const from = row.status as JobStatus;
    if (from === input.to) {
      // 终态重复上报（陈旧 Worker/重复消费）→ 409：明确拒绝，且绝不覆盖既有结果
      if (JOB_TERMINAL_STATUSES.includes(from)) {
        throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, `任务已处于终态：${from}`, 409, { from, to: input.to });
      }
      return toJobDto(row);
    }
    if (!ALLOWED_TRANSITIONS[from].includes(input.to)) {
      throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, `非法状态迁移：${from} → ${input.to}`, 409, {
        from,
        to: input.to,
      });
    }

    const now = new Date();
    const terminal = JOB_TERMINAL_STATUSES.includes(input.to);
    const updated = await tx
      .update(jobs)
      .set({
        status: input.to,
        ...(input.stage !== undefined ? { stage: input.stage } : {}),
        ...(input.submitState !== undefined ? { submitState: input.submitState } : {}),
        ...(input.result !== undefined ? { result: input.result } : {}),
        ...(input.error !== undefined ? { error: input.error } : {}),
        ...(input.to === 'RUNNING' && row.startedAt === null ? { startedAt: now } : {}),
        // 进入 QUEUED：清租约与退避（任何路径的重新可认领都不再等待退避窗口）
        ...(input.to === 'QUEUED' ? { leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: null } : {}),
        ...(terminal ? { completedAt: now, leaseOwner: null, leaseExpiresAt: null } : {}),
        updatedAt: now,
      })
      .where(eq(jobs.id, input.jobId))
      .returning();
    const next = updated[0];
    if (!next) throw new ApiFailure(ERROR_CODES.INTERNAL, 'job update failed', 500);

    const eventMap: Partial<Record<JobStatus, 'job.started' | 'job.progress' | 'job.completed' | 'job.failed' | 'job.queued'>> = {
      QUEUED: 'job.queued',
      RUNNING: 'job.started',
      PROVIDER_QUEUED: 'job.progress',
      SUCCEEDED: 'job.completed',
      FAILED_RETRYABLE: 'job.failed',
      FAILED_FINAL: 'job.failed',
      CANCELLED: 'job.failed',
    };
    const eventType = eventMap[input.to];
    if (eventType !== undefined) {
      await emitJobEvent(tx, next, eventType, {
        from,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(input.error !== null && input.error !== undefined ? { error: input.error } : {}),
        ...(input.extra ?? {}),
      });
    }

    // 终态：解析依赖方（同事务，避免"依赖成功但依赖方永久等待"）
    if (terminal) {
      await resolveDependentsInTransaction(deps, tx, input.jobId, now);
    }

    return toJobDto(next);
  });
}

/** 终态后的依赖解析（同事务；transitionJob 与 failJob 共用）。 */
async function resolveDependentsInTransaction(
  deps: DomainDeps,
  tx: Parameters<Parameters<DomainDeps['db']['transaction']>[0]>[0],
  jobId: string,
  now: Date,
): Promise<void> {
  {
    {
      const dependents = await tx
        .select({ jobId: jobDependencies.jobId })
        .from(jobDependencies)
        .where(eq(jobDependencies.dependsOnJobId, jobId));
      for (const dependent of dependents) {
        const dependentRows = await tx.select().from(jobs).where(eq(jobs.id, dependent.jobId)).limit(1);
        const dependentRow = dependentRows[0];
        if (!dependentRow || dependentRow.status !== 'WAITING_DEPENDENCY') continue;
        const evaluation = await evaluateDependencies(deps, tx, dependentRow.id);
        if (evaluation.blocking !== undefined) {
          const blocked = await tx
            .update(jobs)
            .set({
              status: 'FAILED_FINAL',
              error: { reason: 'DEPENDENCY_FAILED', ...evaluation.blocking },
              completedAt: now,
              updatedAt: now,
            })
            .where(eq(jobs.id, dependentRow.id))
            .returning();
          const blockedRow = blocked[0];
          if (blockedRow) {
            await emitJobEvent(tx, blockedRow, 'job.failed', {
              from: 'WAITING_DEPENDENCY',
              reason: 'DEPENDENCY_FAILED',
              ...evaluation.blocking,
            });
          }
        } else if (evaluation.ready) {
          const promoted = await tx
            .update(jobs)
            .set({ status: 'QUEUED', updatedAt: now })
            .where(eq(jobs.id, dependentRow.id))
            .returning();
          const promotedRow = promoted[0];
          if (promotedRow) {
            await emitJobEvent(tx, promotedRow, 'job.queued', {
              from: 'WAITING_DEPENDENCY',
              reason: 'DEPENDENCIES_RESOLVED',
            });
          }
        }
      }
    }
  }
}

/** 认领任务（原子：SKIP LOCKED；设置租约；attempts +1）。 */
export async function claimJob(
  deps: DomainDeps,
  input: { workerId: string; leaseSeconds?: number; types?: string[]; now?: Date },
): Promise<Job | null> {
  const leaseSeconds = input.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  const now = input.now ?? new Date();
  return deps.db.transaction(async (tx) => {
    const conditions = [
      eq(jobs.status, 'QUEUED'),
      // 退避未到期的任务不可认领（P03-02）
      or(isNull(jobs.nextAttemptAt), lte(jobs.nextAttemptAt, now)),
    ];
    if (input.types !== undefined && input.types.length > 0) conditions.push(inArray(jobs.type, input.types));
    const rows = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(...conditions))
      .orderBy(desc(jobs.priority), asc(jobs.createdAt))
      .limit(1)
      .for('update', { skipLocked: true });
    const candidate = rows[0];
    if (!candidate) return null;
    const updated = await tx
      .update(jobs)
      .set({
        status: 'RUNNING',
        leaseOwner: input.workerId,
        leaseExpiresAt: new Date(now.getTime() + leaseSeconds * 1000),
        heartbeatAt: now,
        attempts: sql`${jobs.attempts} + 1`,
        startedAt: sql`coalesce(${jobs.startedAt}, ${now.toISOString()})`,
        updatedAt: now,
      })
      .where(eq(jobs.id, candidate.id))
      .returning();
    const row = updated[0];
    if (!row) return null;
    await emitJobEvent(tx, row, 'job.started', { reason: 'CLAIMED', workerId: input.workerId });
    return toJobDto(row);
  });
}

/** 心跳（延长租约；可携带阶段/进度）。 */
export async function heartbeatJob(
  deps: DomainDeps,
  input: { workspaceId: string; jobId: string; workerId: string; leaseSeconds?: number; stage?: string; progress?: number; now?: Date },
): Promise<Job> {
  const now = input.now ?? new Date();
  const leaseSeconds = input.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  const updated = await deps.db
    .update(jobs)
    .set({
      heartbeatAt: now,
      leaseExpiresAt: new Date(now.getTime() + leaseSeconds * 1000),
      ...(input.stage !== undefined ? { stage: input.stage } : {}),
      updatedAt: now,
    })
    .where(and(eq(jobs.id, input.jobId), eq(jobs.workspaceId, input.workspaceId), eq(jobs.leaseOwner, input.workerId)))
    .returning();
  const row = updated[0];
  if (!row) throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '心跳失败：租约已失效或不属于该 Worker', 409, { jobId: input.jobId });
  return toJobDto(row);
}

/**
 * 租约回收（Worker 崩溃恢复；可重入）：RUNNING/PROVIDER_QUEUED 且租约过期的任务回到 QUEUED，
 * 并重新写 `job.queued` 事件（派发中断同样可恢复）。PROVIDER_QUEUED 的回收标记需要对账。
 */
export async function requeueExpiredLeases(
  deps: DomainDeps,
  options: { now?: Date; limit?: number } = {},
): Promise<{ requeued: number; needsReconciliation: number }> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? 50;
  const expired = await deps.db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        inArray(jobs.status, ['RUNNING', 'PROVIDER_QUEUED']),
        lt(jobs.leaseExpiresAt, now),
      ),
    )
    .limit(limit);
  let requeued = 0;
  let needsReconciliation = 0;
  for (const candidate of expired) {
    const result = await deps.db.transaction(async (tx) => {
      await tx.execute(sql`select id from jobs where id = ${candidate.id} for update`);
      const rows = await tx.select().from(jobs).where(eq(jobs.id, candidate.id)).limit(1);
      const row = rows[0];
      if (!row || (row.status !== 'RUNNING' && row.status !== 'PROVIDER_QUEUED')) return null;
      if (row.leaseExpiresAt === null || row.leaseExpiresAt.getTime() >= now.getTime()) return null;
      const wasProvider = row.status === 'PROVIDER_QUEUED';
      const updated = await tx
        .update(jobs)
        .set({
          status: 'QUEUED',
          leaseOwner: null,
          leaseExpiresAt: null,
          // Provider 已接收但结果未知：不得自动重复付费提交（§5.6），需对账
          ...(wasProvider ? { needsReconciliation: true, submitState: 'SUBMISSION_UNKNOWN' as const } : {}),
          updatedAt: now,
        })
        .where(eq(jobs.id, row.id))
        .returning();
      const next = updated[0];
      if (!next) return null;
      await emitJobEvent(tx, next, 'job.queued', { from: row.status, reason: 'LEASE_EXPIRED' });
      return { wasProvider };
    });
    if (result !== null) {
      requeued += 1;
      if (result.wasProvider) needsReconciliation += 1;
    }
  }
  return { requeued, needsReconciliation };
}

/** 完成（成功）：设置结果与终态（经唯一迁移服务）。 */
export async function completeJob(
  deps: DomainDeps,
  input: { workspaceId: string; jobId: string; result?: Record<string, unknown>; stage?: string },
): Promise<Job> {
  return transitionJob(deps, {
    workspaceId: input.workspaceId,
    jobId: input.jobId,
    to: 'SUCCEEDED',
    result: input.result ?? {},
    ...(input.stage !== undefined ? { stage: input.stage } : {}),
    reason: 'WORKER_COMPLETE',
  });
}

/** 失败：可重试（attempts < maxAttempts）→ FAILED_RETRYABLE 并等待重试；否则 FAILED_FINAL。 */
export async function failJob(
  deps: DomainDeps,
  input: { workspaceId: string; jobId: string; error: Record<string, unknown>; retryable?: boolean; now?: Date },
): Promise<Job> {
  const row = await loadJobRow(deps, input);
  const canRetry = input.retryable !== false && row.attempts < row.maxAttempts;
  const now = input.now ?? new Date();
  return deps.db.transaction(async (tx) => {
    await tx.execute(sql`select id from jobs where id = ${input.jobId} for update`);
    const fresh = (await tx.select().from(jobs).where(eq(jobs.id, input.jobId)).limit(1))[0];
    if (!fresh) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'job not found', 404);
    const from = fresh.status as JobStatus;
    const to: JobStatus = canRetry ? 'FAILED_RETRYABLE' : 'FAILED_FINAL';
    if (!ALLOWED_TRANSITIONS[from].includes(to)) {
      throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, `非法状态迁移：${from} → ${to}`, 409, { from, to });
    }
    // 退避：可重试时设置下次可认领时间（含抖动，见 computeBackoffSeconds）
    const backoffSeconds = canRetry ? computeBackoffSeconds(fresh.attempts, deps.retryPolicy ?? {}) : null;
    const nextAttemptAt = backoffSeconds === null ? null : new Date(now.getTime() + backoffSeconds * 1000);
    const updated = await tx
      .update(jobs)
      .set({
        status: to,
        error: input.error,
        nextAttemptAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        ...(canRetry ? {} : { completedAt: now }),
        updatedAt: now,
      })
      .where(eq(jobs.id, input.jobId))
      .returning();
    const next = updated[0];
    if (!next) throw new ApiFailure(ERROR_CODES.INTERNAL, 'job update failed', 500);
    await emitJobEvent(tx, next, 'job.failed', {
      from,
      reason: canRetry ? 'WORKER_FAILED_RETRYABLE' : 'WORKER_FAILED_FINAL',
      error: input.error,
      ...(backoffSeconds !== null ? { backoffSeconds, nextAttemptAt: nextAttemptAt?.toISOString() } : {}),
    });
    // 终态（FAILED_FINAL）时同事务解析依赖方（与 transitionJob 一致）
    if (to === 'FAILED_FINAL') {
      await resolveDependentsInTransaction(deps, tx, input.jobId, now);
    }
    return toJobDto(next);
  });
}

/**
 * 自动重试推进（P03-02）：FAILED_RETRYABLE 且退避到期 → QUEUED（重新派发）。
 * 由 Worker tick 调用（可重入）；次数上限由 failJob 的 attempts < maxAttempts 判定。
 */
export async function promoteRetryableJobs(
  deps: DomainDeps,
  options: { now?: Date; limit?: number } = {},
): Promise<{ promoted: number }> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? 50;
  const candidates = await deps.db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.status, 'FAILED_RETRYABLE'),
        or(isNull(jobs.nextAttemptAt), lte(jobs.nextAttemptAt, now)),
      ),
    )
    .limit(limit);
  let promoted = 0;
  for (const candidate of candidates) {
    const outcome = await deps.db.transaction(async (tx) => {
      await tx.execute(sql`select id from jobs where id = ${candidate.id} for update`);
      const row = (await tx.select().from(jobs).where(eq(jobs.id, candidate.id)).limit(1))[0];
      if (!row || row.status !== 'FAILED_RETRYABLE') return false;
      if (row.nextAttemptAt !== null && row.nextAttemptAt.getTime() > now.getTime()) return false;
      const updated = await tx
        .update(jobs)
        .set({ status: 'QUEUED', nextAttemptAt: null, updatedAt: now })
        .where(eq(jobs.id, row.id))
        .returning();
      const next = updated[0];
      if (!next) return false;
      await emitJobEvent(tx, next, 'job.queued', { from: 'FAILED_RETRYABLE', reason: 'BACKOFF_ELAPSED' });
      return true;
    });
    if (outcome) promoted += 1;
  }
  return { promoted };
}

/**
 * 失败检查（P03-02）：发现"依赖已终态但仍 WAITING_DEPENDENCY"的孤儿等待（并发边缘/依赖行缺失），
 * 补做一次依赖解析（升级或明确失败）——保证依赖失败不会永久等待。
 */
export async function resolveStuckDependents(
  deps: DomainDeps,
  options: { limit?: number } = {},
): Promise<{ resolved: number }> {
  const limit = options.limit ?? 50;
  const waiting = await deps.db
    .select({ id: jobs.id })
    .from(jobs)
    .where(eq(jobs.status, 'WAITING_DEPENDENCY'))
    .limit(limit);
  let resolved = 0;
  for (const candidate of waiting) {
    const outcome = await deps.db.transaction(async (tx) => {
      await tx.execute(sql`select id from jobs where id = ${candidate.id} for update`);
      const row = (await tx.select().from(jobs).where(eq(jobs.id, candidate.id)).limit(1))[0];
      if (!row || row.status !== 'WAITING_DEPENDENCY') return false;
      const evaluation = await evaluateDependencies(deps, tx, row.id);
      if (!evaluation.ready && evaluation.blocking === undefined) return false; // 依赖仍在进行
      const now = new Date();
      if (evaluation.blocking !== undefined) {
        const updated = await tx
          .update(jobs)
          .set({ status: 'FAILED_FINAL', error: { reason: 'DEPENDENCY_FAILED', ...evaluation.blocking }, completedAt: now, updatedAt: now })
          .where(eq(jobs.id, row.id))
          .returning();
        const next = updated[0];
        if (!next) return false;
        await emitJobEvent(tx, next, 'job.failed', { from: 'WAITING_DEPENDENCY', reason: 'DEPENDENCY_FAILED', ...evaluation.blocking });
        return true;
      }
      const updated = await tx
        .update(jobs)
        .set({ status: 'QUEUED', updatedAt: now })
        .where(eq(jobs.id, row.id))
        .returning();
      const next = updated[0];
      if (!next) return false;
      await emitJobEvent(tx, next, 'job.queued', { from: 'WAITING_DEPENDENCY', reason: 'DEPENDENCIES_RESOLVED' });
      return true;
    });
    if (outcome) resolved += 1;
  }
  return { resolved };
}

/** 失败检查报告（运维视图）：各状态计数 + 需对账任务 + 需人工介入的终态失败。 */
export async function inspectJobs(
  deps: DomainDeps,
  input: { workspaceId: string },
): Promise<{
  byStatus: Record<string, number>;
  needsReconciliation: number;
  failedFinal: { jobId: string; type: string; error: Record<string, unknown> | null }[];
}> {
  const rows = await deps.db.select().from(jobs).where(eq(jobs.workspaceId, input.workspaceId));
  const byStatus: Record<string, number> = {};
  for (const row of rows) byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
  return {
    byStatus,
    needsReconciliation: rows.filter((row) => row.needsReconciliation).length,
    failedFinal: rows
      .filter((row) => row.status === 'FAILED_FINAL')
      .map((row) => ({ jobId: row.id, type: row.type, error: (row.error ?? null) as Record<string, unknown> | null })),
  };
}

/** 取消：QUEUED/WAITING_DEPENDENCY → CANCELLED；RUNNING/PROVIDER_QUEUED → CANCEL_REQUESTED（Worker 协作式收敛）。 */
export async function cancelJob(
  deps: DomainDeps,
  input: { workspaceId: string; jobId: string; reason?: string },
): Promise<Job> {
  const row = await loadJobRow(deps, input);
  const current = row.status as JobStatus;
  const target: JobStatus =
    current === 'QUEUED' || current === 'WAITING_DEPENDENCY'
      ? 'CANCELLED'
      : current === 'RUNNING' || current === 'PROVIDER_QUEUED'
        ? 'CANCEL_REQUESTED'
        : current;
  if (target === current && JOB_TERMINAL_STATUSES.includes(current)) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '任务已处于终态，无法取消', 409, { status: current });
  }
  return transitionJob(deps, {
    workspaceId: input.workspaceId,
    jobId: input.jobId,
    to: target,
    reason: input.reason ?? 'CANCEL_REQUESTED_BY_USER',
  });
}

/** 人工重试：FAILED_FINAL / FAILED_RETRYABLE / CANCELLED → QUEUED（重新派发）。 */
export async function retryJob(
  deps: DomainDeps,
  input: { workspaceId: string; jobId: string; reason?: string },
): Promise<Job> {
  const job = await transitionJob(deps, {
    workspaceId: input.workspaceId,
    jobId: input.jobId,
    to: 'QUEUED',
    reason: input.reason ?? 'MANUAL_RETRY',
  });
  // 人工重试立即生效：清退避（不等待自动重试窗口）
  const updated = await deps.db.update(jobs).set({ nextAttemptAt: null }).where(eq(jobs.id, job.id)).returning();
  const row = updated[0];
  if (!row) throw new ApiFailure(ERROR_CODES.INTERNAL, 'job update failed', 500);
  return toJobDto(row);
}

export interface JobDispatchReport {
  dispatched: number;
  enqueued: number;
  skipped: number;
  /** 派发失败（队列不可用）：事件保持未发布，重跑即恢复 */
  failed: number;
}

/**
 * Outbox → 队列派发（可重入）：消费未发布的 `job.queued` 事件，把 **仅任务 ID + 路由** 的消息
 * 送入队列适配器，然后标记 published_at。队列不可用时**不标记**（不丢任务，重跑恢复）。
 */
export async function runJobDispatch(
  deps: DomainDeps,
  options: { limit?: number; queueFor?: (jobType: string) => string } = {},
): Promise<JobDispatchReport> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const queue = requireQueue(deps);
  const report: JobDispatchReport = { dispatched: 0, enqueued: 0, skipped: 0, failed: 0 };

  const pending = await deps.db
    .select()
    .from(outboxEvents)
    .where(and(isNull(outboxEvents.publishedAt), eq(outboxEvents.type, 'job.queued')))
    .orderBy(asc(outboxEvents.seq))
    .limit(limit);

  for (const event of pending) {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const jobId = typeof payload['jobId'] === 'string' ? payload['jobId'] : null;
    if (jobId === null) {
      await deps.db.update(outboxEvents).set({ publishedAt: new Date() }).where(eq(outboxEvents.id, event.id));
      report.skipped += 1;
      continue;
    }
    const rows = await deps.db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
    const row = rows[0];
    if (!row || row.status !== 'QUEUED') {
      // 已不在可派发状态（已被认领/取消）：事件归档即可
      await deps.db.update(outboxEvents).set({ publishedAt: new Date() }).where(eq(outboxEvents.id, event.id));
      report.skipped += 1;
      continue;
    }

    const queueName = options.queueFor?.(row.type) ?? DEFAULT_QUEUE;
    const message: JobQueueMessage = { jobId: row.id, queue: queueName, attempt: row.attempts };
    try {
      await queue.enqueue(message);
    } catch {
      // 投递中断：保持未发布 → 下次派发重试（事务性 Outbox 的意义）
      report.failed += 1;
      continue;
    }
    await deps.db.transaction(async (tx) => {
      await tx.update(jobs).set({ enqueuedAt: new Date() }).where(eq(jobs.id, row.id));
      await tx.update(outboxEvents).set({ publishedAt: new Date() }).where(eq(outboxEvents.id, event.id));
    });
    report.enqueued += 1;
    report.dispatched += 1;
  }

  return report;
}

/**
 * 组合维护循环（Worker 的"tick"）：租约回收 → 任务派发。
 * 可重入；任何一步失败都不影响已提交的权威状态。
 */
export async function runMaintenanceTick(
  deps: DomainDeps,
  options: { now?: Date; limit?: number } = {},
): Promise<{
  leases: { requeued: number; needsReconciliation: number };
  retries: { promoted: number };
  dependents: { resolved: number };
  dispatch: JobDispatchReport;
}> {
  const leases = await requeueExpiredLeases(deps, options);
  const retries = await promoteRetryableJobs(deps, options);
  const dependents = await resolveStuckDependents(deps, options);
  const dispatch = await runJobDispatch(deps, options);
  return { leases, retries, dependents, dispatch };
}
