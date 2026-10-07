import { createHash, createHmac, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, lt, max, sql } from 'drizzle-orm';
import {
  ApiFailure,
  CMS_ERROR_REASONS,
  CMS_WRITEBACK_DELIVERY_HEADER,
  CMS_WRITEBACK_EVENT_HEADER,
  CMS_WRITEBACK_EVENT_TYPE,
  CMS_WRITEBACK_JOB_TYPE,
  CMS_WRITEBACK_SIGNATURE_HEADER,
  CMS_WRITEBACK_TIMESTAMP_HEADER,
  ERROR_CODES,
  cmsIngestionRecordSchema,
  cmsWritebackAttemptSchema,
  cmsWritebackPayloadSchema,
  cmsWritebackTargetSchema,
  encryptedSecretSchema,
  type CmsEventContent,
  type CmsIngestionRecord,
  type CmsWritebackAttempt,
  type CmsWritebackPayload,
  type CmsWritebackTarget,
  type UpsertCmsWritebackTargetRequest,
} from '@ancs/contracts';
import { channels, cmsIngestions, cmsWritebackAttempts, cmsWritebackTargets, jobs, renders } from '@ancs/db';
import type { DomainDeps } from './channels.js';
import { createContent, createContentFromDocument } from './content.js';
import { assertSafeUrl } from './content-extract.js';
import { createJobInTx, retryJob } from './jobs.js';
import { createProject } from './projects.js';

/**
 * CMS 摄取服务（P13-06 / §4.2、§88；计划 §8 P13）。
 *
 * - **同一事件重放不重复建项目**：contentHash = 内容字节 sha256；唯一索引
 *   (workspace, source, externalId, contentHash) 命中 → 返回既有摄取（deduped=true）；
 * - **正文变化产生新来源版本**：同 externalId 新 contentHash → 摄取进同一项目为
 *   新 ContentDocument（旧来源版本不被覆盖）；
 * - 机器路径复用人工链路：项目创建（P02-01）/ URL 抓取（P04-01）/ HTML 文档导入（P10-01）。
 */

const toDto = (row: typeof cmsIngestions.$inferSelect): CmsIngestionRecord =>
  cmsIngestionRecordSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    source: row.source,
    externalId: row.externalId,
    contentHash: row.contentHash,
    projectId: row.projectId,
    documentId: row.documentId,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  });

const maskSecret = (secret: string): string => `••••${secret.slice(-4)}`;

const toTargetDto = (row: typeof cmsWritebackTargets.$inferSelect): CmsWritebackTarget =>
  cmsWritebackTargetSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    callbackUrl: row.callbackUrl,
    status: row.status,
    maskedSecret: row.maskedSecret,
    keyVersion: row.keyVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    rotatedAt: row.rotatedAt?.toISOString() ?? null,
  });

const toAttemptDto = (row: typeof cmsWritebackAttempts.$inferSelect): CmsWritebackAttempt =>
  cmsWritebackAttemptSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    targetId: row.targetId,
    ingestionId: row.ingestionId,
    projectId: row.projectId,
    renderId: row.renderId,
    jobId: row.jobId,
    deliveryId: row.deliveryId,
    attemptNumber: row.attemptNumber,
    jobAttempt: row.jobAttempt,
    status: row.status,
    requestUrl: row.requestUrl,
    requestPayload: row.requestPayload,
    requestBodySha256: row.requestBodySha256,
    signatureKeyVersion: row.signatureKeyVersion,
    responseStatus: row.responseStatus,
    responseHeaders: row.responseHeaders,
    responseBodyPreview: row.responseBodyPreview,
    responseTruncated: row.responseTruncated,
    errorReason: row.errorReason,
    errorMessage: row.errorMessage,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  });

function requireCipher(deps: DomainDeps) {
  if (deps.credentials === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'CMS 回写凭据保险库未配置', 500);
  return deps.credentials;
}

function requireWritebackSender(deps: DomainDeps) {
  if (deps.cmsWritebackSender === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'CMS 回写发送器未配置', 500);
  return deps.cmsWritebackSender;
}

function validateCallbackUrl(raw: string): string {
  const url = assertSafeUrl(raw);
  if (url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, '回调 URL 不得包含凭据或 fragment', 422, {
      reason: CMS_ERROR_REASONS.WRITEBACK_BLOCKED_TARGET,
    });
  }
  return url.toString();
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalValue(item)]));
  }
  return value;
}

/** 签名与重试共用的确定性 JSON 字节。 */
export function canonicalizeCmsWritebackPayload(payload: CmsWritebackPayload): string {
  return JSON.stringify(canonicalValue(cmsWritebackPayloadSchema.parse(payload)));
}

export async function getCmsWritebackTarget(deps: DomainDeps, input: { workspaceId: string }): Promise<CmsWritebackTarget> {
  const row = (await deps.db.select().from(cmsWritebackTargets).where(eq(cmsWritebackTargets.workspaceId, input.workspaceId)).limit(1))[0];
  if (row === undefined) {
    throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'CMS 回写目标未配置', 404, { reason: CMS_ERROR_REASONS.WRITEBACK_TARGET_NOT_CONFIGURED });
  }
  return toTargetDto(row);
}

export async function upsertCmsWritebackTarget(
  deps: DomainDeps,
  input: { workspaceId: string; createdBy?: string | null; request: UpsertCmsWritebackTargetRequest },
): Promise<CmsWritebackTarget> {
  const existing = (await deps.db.select().from(cmsWritebackTargets).where(eq(cmsWritebackTargets.workspaceId, input.workspaceId)).limit(1))[0];
  if (existing === undefined && (input.request.callbackUrl === undefined || input.request.signingSecret === undefined)) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, '首次配置必须同时提供 callbackUrl 与 signingSecret', 422);
  }
  const callbackUrl = input.request.callbackUrl === undefined ? existing?.callbackUrl : validateCallbackUrl(input.request.callbackUrl);
  if (callbackUrl === undefined) throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'callbackUrl 缺失', 422);
  const now = new Date();
  let encrypted = existing === undefined ? undefined : encryptedSecretSchema.parse(existing.encryptedSigningSecret);
  let maskedSecret = existing?.maskedSecret;
  let keyVersion = existing?.keyVersion;
  if (input.request.signingSecret !== undefined) {
    encrypted = await requireCipher(deps).encrypt(input.request.signingSecret);
    maskedSecret = maskSecret(input.request.signingSecret);
    keyVersion = encrypted.keyVersion;
  }
  if (encrypted === undefined || maskedSecret === undefined || keyVersion === undefined) {
    throw new ApiFailure(ERROR_CODES.INTERNAL, 'CMS 回写密钥配置不完整', 500);
  }
  const status = input.request.enabled === undefined ? (existing?.status ?? 'ACTIVE') : input.request.enabled ? 'ACTIVE' : 'DISABLED';
  const rows = existing === undefined
    ? await deps.db.insert(cmsWritebackTargets).values({
        id: `cmswt_${randomUUID()}`,
        workspaceId: input.workspaceId,
        callbackUrl,
        encryptedSigningSecret: encrypted,
        maskedSecret,
        keyVersion,
        status,
        createdBy: input.createdBy ?? null,
        ...(input.request.signingSecret !== undefined ? { rotatedAt: now } : {}),
      }).onConflictDoUpdate({
        target: cmsWritebackTargets.workspaceId,
        set: {
          callbackUrl,
          encryptedSigningSecret: encrypted,
          maskedSecret,
          keyVersion,
          status,
          updatedAt: now,
          ...(input.request.signingSecret !== undefined ? { rotatedAt: now } : {}),
        },
      }).returning()
    : await deps.db.update(cmsWritebackTargets).set({
        callbackUrl,
        encryptedSigningSecret: encrypted,
        maskedSecret,
        keyVersion,
        status,
        updatedAt: now,
        ...(input.request.signingSecret !== undefined ? { rotatedAt: now } : {}),
      }).where(and(eq(cmsWritebackTargets.id, existing.id), eq(cmsWritebackTargets.workspaceId, input.workspaceId))).returning();
  const row = rows[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'CMS 回写目标保存失败', 500);
  return toTargetDto(row);
}

export async function listCmsWritebackAttempts(
  deps: DomainDeps,
  input: { workspaceId: string; deliveryId?: string; renderId?: string; limit?: number },
): Promise<CmsWritebackAttempt[]> {
  const conditions = [eq(cmsWritebackAttempts.workspaceId, input.workspaceId)];
  if (input.deliveryId !== undefined) conditions.push(eq(cmsWritebackAttempts.deliveryId, input.deliveryId));
  if (input.renderId !== undefined) conditions.push(eq(cmsWritebackAttempts.renderId, input.renderId));
  const rows = await deps.db.select().from(cmsWritebackAttempts).where(and(...conditions)).orderBy(desc(cmsWritebackAttempts.createdAt)).limit(Math.min(Math.max(input.limit ?? 100, 1), 200));
  return rows.map(toAttemptDto);
}

type DomainTx = Parameters<Parameters<DomainDeps['db']['transaction']>[0]>[0];

/** Render READY 事务内调用：没有 CMS 来源/有效目标时明确 no-op。 */
export async function scheduleCmsWritebackInTx(
  tx: DomainTx,
  input: {
    workspaceId: string;
    projectId: string;
    projectVersionId: string;
    renderId: string;
    manifestHash: string | null;
    outputAssetIds: string[];
    occurredAt: Date;
  },
): Promise<{ deliveryId: string; jobId: string } | null> {
  if (input.manifestHash === null) return null;
  const ingestion = (await tx.select().from(cmsIngestions).where(and(eq(cmsIngestions.workspaceId, input.workspaceId), eq(cmsIngestions.projectId, input.projectId))).orderBy(asc(cmsIngestions.createdAt)).limit(1))[0];
  if (ingestion === undefined) return null;
  const target = (await tx.select().from(cmsWritebackTargets).where(and(eq(cmsWritebackTargets.workspaceId, input.workspaceId), eq(cmsWritebackTargets.status, 'ACTIVE'))).limit(1))[0];
  if (target === undefined) return null;
  const deliveryId = `cmsd_${randomUUID()}`;
  const payload = cmsWritebackPayloadSchema.parse({
    schemaVersion: '1.0',
    eventType: CMS_WRITEBACK_EVENT_TYPE,
    deliveryId,
    occurredAt: input.occurredAt.toISOString(),
    workspaceId: input.workspaceId,
    source: { type: ingestion.source, externalId: ingestion.externalId },
    artifact: {
      projectId: input.projectId,
      projectVersionId: input.projectVersionId,
      renderId: input.renderId,
      renderStatus: 'READY',
      approvalRequired: true,
      manifestHash: input.manifestHash,
      outputAssetIds: input.outputAssetIds,
    },
  });
  const body = canonicalizeCmsWritebackPayload(payload);
  const job = await createJobInTx(tx, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    type: CMS_WRITEBACK_JOB_TYPE,
    input: { deliveryId },
    maxAttempts: 4,
    classification: 'SYSTEM',
  });
  await tx.insert(cmsWritebackAttempts).values({
    id: `cmswa_${randomUUID()}`,
    workspaceId: input.workspaceId,
    targetId: target.id,
    ingestionId: ingestion.id,
    projectId: input.projectId,
    renderId: input.renderId,
    jobId: job.id,
    deliveryId,
    attemptNumber: 1,
    jobAttempt: 1,
    requestUrl: target.callbackUrl,
    requestPayload: payload,
    requestBodySha256: createHash('sha256').update(body).digest('hex'),
  });
  return { deliveryId, jobId: job.id };
}

async function finalizeAttempt(
  deps: DomainDeps,
  input: {
    id: string;
    status: 'SUCCEEDED' | 'FAILED_RETRYABLE' | 'FAILED_FINAL';
    responseStatus?: number | null;
    responseHeaders?: Record<string, string>;
    responseBodyPreview?: string | null;
    responseTruncated?: boolean;
    errorReason?: string | null;
    errorMessage?: string | null;
  },
): Promise<CmsWritebackAttempt> {
  const updated = await deps.db.update(cmsWritebackAttempts).set({
    status: input.status,
    responseStatus: input.responseStatus ?? null,
    responseHeaders: input.responseHeaders ?? {},
    responseBodyPreview: input.responseBodyPreview?.slice(0, 16_384) ?? null,
    responseTruncated: input.responseTruncated ?? false,
    errorReason: input.errorReason ?? null,
    errorMessage: input.errorMessage?.slice(0, 500) ?? null,
    completedAt: new Date(),
  }).where(and(eq(cmsWritebackAttempts.id, input.id), eq(cmsWritebackAttempts.status, 'PENDING'))).returning();
  const row = updated[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'CMS 回写尝试已被完成或回收', 409);
  return toAttemptDto(row);
}

/** 执行一次物理发送；业务失败作为结果返回，由 Worker 使用唯一 Job 状态机收敛。 */
export async function executeCmsWritebackAttempt(
  deps: DomainDeps,
  input: { workspaceId: string; jobId: string; deliveryId: string },
): Promise<{ ok: boolean; retryable: boolean; attempt: CmsWritebackAttempt; reason: string | null }> {
  const prepared = await deps.db.transaction(async (tx) => {
    await tx.execute(sql`select id from jobs where id = ${input.jobId} for update`);
    const job = (await tx.select().from(jobs).where(and(eq(jobs.id, input.jobId), eq(jobs.workspaceId, input.workspaceId))).limit(1))[0];
    if (job === undefined || job.type !== CMS_WRITEBACK_JOB_TYPE) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'CMS 回写任务不存在', 404);
    const first = (await tx.select().from(cmsWritebackAttempts).where(and(eq(cmsWritebackAttempts.workspaceId, input.workspaceId), eq(cmsWritebackAttempts.deliveryId, input.deliveryId))).orderBy(asc(cmsWritebackAttempts.attemptNumber)).limit(1))[0];
    if (first === undefined || first.jobId !== input.jobId) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'CMS 回写 delivery 不存在', 404);
    await tx.update(cmsWritebackAttempts).set({ status: 'UNKNOWN', completedAt: new Date(), errorReason: 'WORKER_RECOVERED', errorMessage: 'Worker 在完成记录前中断；本次发送结果未知' }).where(and(eq(cmsWritebackAttempts.jobId, input.jobId), eq(cmsWritebackAttempts.status, 'PENDING'), lt(cmsWritebackAttempts.jobAttempt, job.attempts)));
    let attempt = (await tx.select().from(cmsWritebackAttempts).where(and(eq(cmsWritebackAttempts.jobId, input.jobId), eq(cmsWritebackAttempts.jobAttempt, job.attempts))).limit(1))[0];
    const target = (await tx.select().from(cmsWritebackTargets).where(and(eq(cmsWritebackTargets.id, first.targetId), eq(cmsWritebackTargets.workspaceId, input.workspaceId))).limit(1))[0];
    if (target === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'CMS 回写目标不存在', 404);
    if (attempt === undefined) {
      const maxRows = await tx.select({ value: max(cmsWritebackAttempts.attemptNumber) }).from(cmsWritebackAttempts).where(eq(cmsWritebackAttempts.deliveryId, input.deliveryId));
      const inserted = await tx.insert(cmsWritebackAttempts).values({
        id: `cmswa_${randomUUID()}`,
        workspaceId: first.workspaceId,
        targetId: first.targetId,
        ingestionId: first.ingestionId,
        projectId: first.projectId,
        renderId: first.renderId,
        jobId: first.jobId,
        deliveryId: first.deliveryId,
        attemptNumber: Number(maxRows[0]?.value ?? 0) + 1,
        jobAttempt: job.attempts,
        requestUrl: target.callbackUrl,
        requestPayload: first.requestPayload,
        requestBodySha256: first.requestBodySha256,
      }).returning();
      attempt = inserted[0];
    }
    if (attempt === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'CMS 回写尝试创建失败', 500);
    const started = await tx.update(cmsWritebackAttempts).set({ requestUrl: target.callbackUrl, signatureKeyVersion: target.keyVersion, startedAt: new Date() }).where(and(eq(cmsWritebackAttempts.id, attempt.id), eq(cmsWritebackAttempts.status, 'PENDING'))).returning();
    return { attempt: started[0] ?? attempt, target, canAutoRetry: job.attempts < job.maxAttempts };
  });

  if (prepared.target.status !== 'ACTIVE') {
    const attempt = await finalizeAttempt(deps, { id: prepared.attempt.id, status: 'FAILED_FINAL', errorReason: CMS_ERROR_REASONS.WRITEBACK_TARGET_DISABLED, errorMessage: 'CMS 回写目标已禁用' });
    return { ok: false, retryable: false, attempt, reason: CMS_ERROR_REASONS.WRITEBACK_TARGET_DISABLED };
  }
  const body = canonicalizeCmsWritebackPayload(cmsWritebackPayloadSchema.parse(prepared.attempt.requestPayload));
  let secret: string;
  try {
    secret = await requireCipher(deps).decrypt(encryptedSecretSchema.parse(prepared.target.encryptedSigningSecret));
  } catch {
    const attempt = await finalizeAttempt(deps, { id: prepared.attempt.id, status: 'FAILED_FINAL', errorReason: 'SIGNING_KEY_UNAVAILABLE', errorMessage: 'CMS 回写签名密钥不可用' });
    return { ok: false, retryable: false, attempt, reason: 'SIGNING_KEY_UNAVAILABLE' };
  }
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  const headers = {
    'content-type': 'application/json',
    [CMS_WRITEBACK_EVENT_HEADER]: CMS_WRITEBACK_EVENT_TYPE,
    [CMS_WRITEBACK_DELIVERY_HEADER]: input.deliveryId,
    [CMS_WRITEBACK_TIMESTAMP_HEADER]: timestamp,
    [CMS_WRITEBACK_SIGNATURE_HEADER]: `sha256=${signature}`,
  };
  try {
    const response = await requireWritebackSender(deps).send({ url: prepared.target.callbackUrl, headers, body, timeoutMs: 10_000, maxResponseBytes: 16_384 });
    const allowedHeaders = Object.fromEntries(Object.entries(response.headers).filter(([key]) => ['content-type', 'retry-after', 'request-id', 'x-request-id'].includes(key.toLowerCase())));
    if (response.status >= 200 && response.status < 300) {
      const attempt = await finalizeAttempt(deps, { id: prepared.attempt.id, status: 'SUCCEEDED', responseStatus: response.status, responseHeaders: allowedHeaders, responseBodyPreview: response.body, responseTruncated: response.truncated || response.body.length > 16_384 });
      return { ok: true, retryable: false, attempt, reason: null };
    }
    const retryable = ([408, 425, 429].includes(response.status) || response.status >= 500) && prepared.canAutoRetry;
    const attempt = await finalizeAttempt(deps, {
      id: prepared.attempt.id,
      status: retryable ? 'FAILED_RETRYABLE' : 'FAILED_FINAL',
      responseStatus: response.status,
      responseHeaders: allowedHeaders,
      responseBodyPreview: response.body,
      responseTruncated: response.truncated || response.body.length > 16_384,
      errorReason: CMS_ERROR_REASONS.WRITEBACK_HTTP_ERROR,
      errorMessage: `CMS 回写返回 HTTP ${String(response.status)}`,
    });
    return { ok: false, retryable, attempt, reason: CMS_ERROR_REASONS.WRITEBACK_HTTP_ERROR };
  } catch (error) {
    const finalFailure = (error instanceof ApiFailure && error.httpStatus < 500) || !prepared.canAutoRetry;
    const reason = finalFailure ? CMS_ERROR_REASONS.WRITEBACK_BLOCKED_TARGET : CMS_ERROR_REASONS.WRITEBACK_NETWORK_ERROR;
    const attempt = await finalizeAttempt(deps, { id: prepared.attempt.id, status: finalFailure ? 'FAILED_FINAL' : 'FAILED_RETRYABLE', errorReason: reason, errorMessage: finalFailure ? 'CMS 回写目标被安全策略拒绝' : 'CMS 回写网络请求失败' });
    return { ok: false, retryable: !finalFailure, attempt, reason };
  }
}

export async function retryCmsWriteback(
  deps: DomainDeps,
  input: { workspaceId: string; deliveryId: string },
): Promise<{ deliveryId: string; jobId: string; status: 'QUEUED' }> {
  const latest = (await deps.db.select().from(cmsWritebackAttempts).where(and(eq(cmsWritebackAttempts.workspaceId, input.workspaceId), eq(cmsWritebackAttempts.deliveryId, input.deliveryId))).orderBy(desc(cmsWritebackAttempts.attemptNumber)).limit(1))[0];
  if (latest === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'CMS 回写 delivery 不存在', 404, { reason: CMS_ERROR_REASONS.WRITEBACK_DELIVERY_NOT_FOUND });
  const [job, render, target] = await Promise.all([
    deps.db.select().from(jobs).where(and(eq(jobs.id, latest.jobId), eq(jobs.workspaceId, input.workspaceId))).limit(1),
    deps.db.select().from(renders).where(and(eq(renders.id, latest.renderId), eq(renders.workspaceId, input.workspaceId))).limit(1),
    deps.db.select().from(cmsWritebackTargets).where(and(eq(cmsWritebackTargets.id, latest.targetId), eq(cmsWritebackTargets.workspaceId, input.workspaceId))).limit(1),
  ]);
  if (latest.status === 'SUCCEEDED' || !['FAILED_RETRYABLE', 'FAILED_FINAL'].includes(job[0]?.status ?? '') || render[0]?.status !== 'READY' || target[0]?.status !== 'ACTIVE') {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'CMS 回写当前不可重发', 409, { reason: CMS_ERROR_REASONS.WRITEBACK_NOT_RETRYABLE });
  }
  await retryJob(deps, { workspaceId: input.workspaceId, jobId: latest.jobId, reason: 'CMS_WRITEBACK_MANUAL_RETRY' });
  return { deliveryId: input.deliveryId, jobId: latest.jobId, status: 'QUEUED' };
}

/** CMS 摄取列表（新→旧；状态查询）。 */
export async function listCmsIngestions(
  deps: DomainDeps,
  input: { workspaceId: string },
): Promise<CmsIngestionRecord[]> {
  const rows = await deps.db
    .select()
    .from(cmsIngestions)
    .where(eq(cmsIngestions.workspaceId, input.workspaceId))
    .orderBy(desc(cmsIngestions.createdAt));
  return rows.map(toDto);
}

/** 摄取 CMS 事件（机器建项目 + 内容入库 + 幂等/版本语义）。 */
export async function ingestCmsEvent(
  deps: DomainDeps,
  input: { workspaceId: string; source: string; externalId: string; title: string; channelId: string; content: CmsEventContent; createdBy?: string | null },
): Promise<{ ingestion: CmsIngestionRecord; deduped: boolean; projectId: string; documentId: string; newSourceVersion: boolean }> {
  // 1) 内容字节与哈希（URL 先抓取——hash 基于内容而非链接）
  let bytes: Uint8Array;
  let sourceUrl: string | null = null;
  if (input.content.kind === 'URL') {
    if (deps.articleFetcher === undefined) {
      throw new ApiFailure(ERROR_CODES.INTERNAL, '文章抓取器未配置（DomainDeps.articleFetcher）', 500);
    }
    sourceUrl = input.content.url;
    const fetched = await deps.articleFetcher.fetch({ url: sourceUrl }).catch((error: unknown) => {
      throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, `文章抓取失败：${error instanceof Error ? error.message : String(error)}`.slice(0, 200), 502, {
        reason: CMS_ERROR_REASONS.FETCH_FAILED,
        url: sourceUrl,
      });
    });
    bytes = fetched.bytes;
  } else {
    bytes = new TextEncoder().encode(input.content.html);
  }
  if (bytes.byteLength === 0) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'CMS 事件内容为空（0 字节）', 422, { reason: CMS_ERROR_REASONS.EMPTY_CONTENT });
  }
  const contentHash = createHash('sha256').update(bytes).digest('hex');

  // 2) 重放：同 (workspace, source, externalId, contentHash) → 返回既有摄取（不重复建项目/文档）
  const replayRows = await deps.db
    .select()
    .from(cmsIngestions)
    .where(
      and(
        eq(cmsIngestions.workspaceId, input.workspaceId),
        eq(cmsIngestions.source, input.source),
        eq(cmsIngestions.externalId, input.externalId),
        eq(cmsIngestions.contentHash, contentHash),
      ),
    )
    .limit(1);
  const replay = replayRows[0];
  if (replay !== undefined) {
    return { ingestion: toDto(replay), deduped: true, projectId: replay.projectId, documentId: replay.documentId, newSourceVersion: false };
  }

  // 3) 项目复用：同 externalId 的既有摄取 → 同项目（新来源版本）；首次 → 机器建项目
  const previousRows = await deps.db
    .select()
    .from(cmsIngestions)
    .where(and(eq(cmsIngestions.workspaceId, input.workspaceId), eq(cmsIngestions.source, input.source), eq(cmsIngestions.externalId, input.externalId)))
    .orderBy(desc(cmsIngestions.createdAt))
    .limit(1);
  const previous = previousRows[0];
  let projectId: string;
  if (previous !== undefined) {
    projectId = previous.projectId;
  } else {
    const channelRows = await deps.db
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.id, input.channelId), eq(channels.workspaceId, input.workspaceId)))
      .limit(1);
    if (channelRows[0] === undefined) {
      throw new ApiFailure(ERROR_CODES.NOT_FOUND, '栏目不存在或不属于该工作区', 404, { reason: CMS_ERROR_REASONS.CHANNEL_NOT_FOUND });
    }
    const project = await createProject(deps, {
      workspaceId: input.workspaceId,
      createdBy: input.createdBy ?? undefined,
      input: { title: input.title, channelId: input.channelId },
    });
    projectId = project.id;
  }

  // 4) 内容摄取（复用人工链路：URL → P04-01 抓取；HTML → P10-01 文档导入）
  let documentId: string;
  if (input.content.kind === 'URL') {
    const document = await createContent(deps, {
      workspaceId: input.workspaceId,
      projectId,
      createdBy: input.createdBy ?? null,
      input: { sourceType: 'URL_ARTICLE', url: sourceUrl as string, title: input.title },
    });
    documentId = document.document.id;
  } else {
    const document = await createContentFromDocument(deps, {
      workspaceId: input.workspaceId,
      projectId,
      createdBy: input.createdBy ?? null,
      filename: `${input.externalId}.html`,
      contentType: 'text/html',
      bytes,
      parser: undefined,
      html: input.content.html,
    });
    documentId = document.document.id;
  }

  // 5) 摄取记录落库（唯一索引兜底并发；冲突 = 并发重放 → 重读返回既有）
  const inserted = await deps.db
    .insert(cmsIngestions)
    .values({
      id: `cmsi_${randomUUID()}`,
      workspaceId: input.workspaceId,
      source: input.source,
      externalId: input.externalId,
      contentHash,
      projectId,
      documentId,
      status: previous !== undefined ? 'NEW_SOURCE_VERSION' : 'INGESTED',
    })
    .onConflictDoNothing()
    .returning();
  const row = inserted[0];
  if (row === undefined) {
    const existingRows = await deps.db
      .select()
      .from(cmsIngestions)
      .where(
        and(
          eq(cmsIngestions.workspaceId, input.workspaceId),
          eq(cmsIngestions.source, input.source),
          eq(cmsIngestions.externalId, input.externalId),
          eq(cmsIngestions.contentHash, contentHash),
        ),
      )
      .limit(1);
    const existing = existingRows[0];
    if (existing === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'cms ingestion read failed', 500);
    return { ingestion: toDto(existing), deduped: true, projectId: existing.projectId, documentId: existing.documentId, newSourceVersion: false };
  }
  return {
    ingestion: toDto(row),
    deduped: false,
    projectId,
    documentId,
    newSourceVersion: previous !== undefined,
  };
}
