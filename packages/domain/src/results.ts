import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, asc, eq, lte, sql } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  WEBHOOK_REJECTION_REASONS,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
  mimeMatches,
  providerCallbackSchema,
  resultCollectionSchema,
  sniffMimeType,
  type ProviderCallback,
  type ResultCollection,
  type ResultFetcher,
  type WebhookVerifier,
} from '@ancs/contracts';
import { assetVersions, assets, outboxEvents, providerResultStates, webhookEvents } from '@ancs/db';
import { completeProviderGeneration, recordProviderGeneration, settleHold } from './billing.js';
import { loadJobRow, transitionJob } from './jobs.js';
import type { DomainDeps } from './deps.js';

/**
 * Provider 结果回收与 Webhook 处理（P03-06 / 规范 §30、§31、§33.4；计划 §5.5、§5.6）。
 *
 * 流程：
 *   Provider 回调（验签 + replay 防护）或轮询/人工恢复
 *     → `handleProviderCompletion`：登记结果状态（临时 URL 与过期时间）
 *     → 任务迁移到 RUNNING/stage=COLLECT（**回调/轮询/人工共用同一迁移服务**）
 *     → `collectProviderResult`：下载 → 校验（大小/MIME 嗅探/校验和）→ **写入自有存储**
 *        → 落 Asset（PROVIDER_GENERATED/SYSTEM_RENDER，READY）
 *     → 任务完成 + 生成记录完成 + 计费结算（settleHold）
 *
 * 硬性纪律：
 * - **下载失败不重生成**（AC-09）：回收失败只增加 collectAttempts 并保持任务可回收，绝不重新提交；
 * - **Provider URL 不当永久标识**（§75 第 5 条 / AC-10）：回收成功即落自有存储，之后 URL 失效不影响；
 * - **迟到/乱序结果只登记不应用**（AC-05）：attempt 小于任务当前 attempt 的回调不改任务状态；
 * - **伪造回调被拒**（§33.4 / AC-08）：验签失败不落 webhook_events（只记审计行之外的拒绝），
 *   重复事件（同 provider eventId）幂等 ack。
 */

const DEFAULT_MAX_RESULT_BYTES = 512 * 1024 * 1024; // 单结果下载上限（V1；可配置）
export const RESULT_EXPIRY_WARNING_MINUTES = 15;

function requireFetcher(deps: DomainDeps): ResultFetcher {
  if (deps.resultFetcher === undefined) {
    throw new ApiFailure(ERROR_CODES.INTERNAL, '结果拉取器未配置（DomainDeps.resultFetcher）', 500);
  }
  return deps.resultFetcher;
}

function requireStorage(deps: DomainDeps) {
  if (deps.storage === undefined) {
    throw new ApiFailure(ERROR_CODES.INTERNAL, '对象存储适配器未配置（DomainDeps.storage）', 500);
  }
  return deps.storage;
}

/** 默认 HMAC-SHA256 验签（ts + '.' + body；时间窗 5 分钟）。 */
export function createHmacWebhookVerifier(providerId: string, secret: string, toleranceSeconds = WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS): WebhookVerifier {
  return {
    providerId,
    verify(input) {
      const header = input.headers[WEBHOOK_SIGNATURE_HEADER];
      const timestampHeader = input.headers[WEBHOOK_TIMESTAMP_HEADER];
      const signature = Array.isArray(header) ? header[0] : header;
      const timestamp = Array.isArray(timestampHeader) ? timestampHeader[0] : timestampHeader;
      if (signature === undefined || signature === '') {
        return { ok: false, reason: WEBHOOK_REJECTION_REASONS.MISSING_SIGNATURE };
      }
      if (timestamp === undefined || !/^\d+$/.test(timestamp)) {
        return { ok: false, reason: WEBHOOK_REJECTION_REASONS.MISSING_SIGNATURE };
      }
      const now = input.now ?? new Date();
      const skewSeconds = Math.abs(now.getTime() / 1000 - Number(timestamp));
      if (skewSeconds > toleranceSeconds) {
        return { ok: false, reason: WEBHOOK_REJECTION_REASONS.TIMESTAMP_OUT_OF_WINDOW };
      }
      const expected = createHmac('sha256', secret).update(`${timestamp}.${input.rawBody}`).digest('hex');
      const provided = signature.replace(/^sha256=/, '');
      // 恒定时间比较（长度不同直接拒绝；长度由 hex 编码固定，不构成可利用的侧信道）
      const a = Buffer.from(expected, 'utf8');
      const b = Buffer.from(provided, 'utf8');
      const equal = a.length === b.length && timingSafeEqual(a, b);
      return equal ? { ok: true } : { ok: false, reason: WEBHOOK_REJECTION_REASONS.INVALID_SIGNATURE };
    },
  };
}

export interface WebhookIngestResult {
  status: 'PROCESSED' | 'DUPLICATE' | 'REJECTED';
  reason?: string;
  webhookEventId?: string;
  jobId?: string | null;
  collection?: ResultCollection | null;
}

/**
 * Webhook 入口：验签 → replay 防护（唯一键）→ 归一化载荷 → 处理（回收）。
 * 验签失败：**不写事件行**（避免污染审计与 replay 键），直接拒绝。
 */
export async function ingestProviderWebhook(
  deps: DomainDeps,
  input: {
    providerId: string;
    rawBody: string;
    headers: Record<string, string | undefined>;
    verifiers?: readonly WebhookVerifier[];
    now?: Date;
  },
): Promise<WebhookIngestResult> {
  const verifier = input.verifiers?.find((candidate) => candidate.providerId === input.providerId);
  if (verifier === undefined) {
    return { status: 'REJECTED', reason: WEBHOOK_REJECTION_REASONS.UNKNOWN_PROVIDER };
  }
  const verification = verifier.verify({ headers: input.headers, rawBody: input.rawBody, ...(input.now !== undefined ? { now: input.now } : {}) });
  if (!verification.ok) {
    return { status: 'REJECTED', reason: verification.reason ?? WEBHOOK_REJECTION_REASONS.INVALID_SIGNATURE };
  }

  let parsed: ProviderCallback;
  try {
    parsed = providerCallbackSchema.parse(JSON.parse(input.rawBody));
  } catch {
    return { status: 'REJECTED', reason: WEBHOOK_REJECTION_REASONS.INVALID_PAYLOAD };
  }

  const payloadHash = createHmac('sha256', 'ancs-webhook-hash').update(input.rawBody).digest('hex');
  // replay 防护：同 (provider, eventId) 只生效一次
  const inserted = await deps.db
    .insert(webhookEvents)
    .values({
      id: `whk_${randomUUID()}`,
      providerId: input.providerId,
      providerEventId: parsed.eventId,
      status: 'VERIFIED',
      payloadHash,
      note: `${parsed.eventType} providerJobId=${parsed.providerJobId}`,
    })
    .onConflictDoNothing()
    .returning();
  const eventRow = inserted[0];
  if (eventRow === undefined) {
    const existing = await deps.db
      .select()
      .from(webhookEvents)
      .where(and(eq(webhookEvents.providerId, input.providerId), eq(webhookEvents.providerEventId, parsed.eventId)))
      .limit(1);
    return { status: 'DUPLICATE', webhookEventId: existing[0]?.id, jobId: existing[0]?.jobId ?? null };
  }

  const outcome = await processProviderCallback(deps, {
    providerId: input.providerId,
    callback: parsed,
    webhookEventId: eventRow.id,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  return { status: 'PROCESSED', webhookEventId: eventRow.id, jobId: outcome.jobId, collection: outcome.collection };
}

/** 回调/轮询/人工恢复共用的处理：定位任务 → 迟到判定 → 结果状态 → 回收。 */
export async function processProviderCallback(
  deps: DomainDeps,
  input: { providerId: string; callback: ProviderCallback; webhookEventId?: string; now?: Date },
): Promise<{ jobId: string | null; collection: ResultCollection | null; stale: boolean }> {
  const now = input.now ?? new Date();
  const callback = input.callback;

  // 通过 provider_job_id 定位任务（由 Provider 结果恢复，不信任回调中的 workspace）
  const jobRows = await deps.db
    .select()
    .from(providerResultStates)
    .where(eq(providerResultStates.providerJobId, callback.providerJobId))
    .limit(1);
  const state = jobRows[0];
  if (state === undefined) {
    // 未知 providerJobId：登记（人工排查）但不应用——不得据回调创建任务
    if (input.webhookEventId !== undefined) {
      await deps.db
        .update(webhookEvents)
        .set({ status: 'REJECTED', note: `unknown providerJobId=${callback.providerJobId}`, processedAt: now })
        .where(eq(webhookEvents.id, input.webhookEventId));
    }
    return { jobId: null, collection: null, stale: false };
  }

  // 迟到/乱序：attempt 小于当前 → 只登记不应用（AC-05）
  if (callback.attempt < state.attempt) {
    if (input.webhookEventId !== undefined) {
      await deps.db
        .update(webhookEvents)
        .set({ status: 'PROCESSED', jobId: state.jobId, attempt: callback.attempt, note: 'STALE_ATTEMPT_IGNORED', processedAt: now })
        .where(eq(webhookEvents.id, input.webhookEventId));
    }
    return { jobId: state.jobId, collection: null, stale: true };
  }

  // 已回收（重复回调经不同路径到达）：幂等跳过，不重复收集/不重复记账
  if (state.status === 'COLLECTED') {
    if (input.webhookEventId !== undefined) {
      await deps.db
        .update(webhookEvents)
        .set({ status: 'PROCESSED', jobId: state.jobId, attempt: callback.attempt, note: 'ALREADY_COLLECTED', processedAt: now })
        .where(eq(webhookEvents.id, input.webhookEventId));
    }
    return { jobId: state.jobId, collection: null, stale: false };
  }

  if (input.webhookEventId !== undefined) {
    await deps.db
      .update(webhookEvents)
      .set({ status: 'PROCESSED', jobId: state.jobId, attempt: callback.attempt, processedAt: now })
      .where(eq(webhookEvents.id, input.webhookEventId));
  }

  if (callback.eventType === 'job.failed') {
    await transitionJob(deps, {
      workspaceId: state.workspaceId,
      jobId: state.jobId,
      to: 'FAILED_RETRYABLE',
      error: { reason: 'PROVIDER_FAILED', providerJobId: callback.providerJobId, detail: callback.error ?? {} },
      reason: 'PROVIDER_FAILED',
    }).catch(() => undefined);
    await releaseResults(deps, { workspaceId: state.workspaceId, jobId: state.jobId, status: 'FAILED', error: { reason: 'PROVIDER_FAILED' } });
    return { jobId: state.jobId, collection: null, stale: false };
  }

  // 成功：登记结果描述（含临时 URL 过期时间）→ 迁移到 COLLECT → 回收
  await registerProviderResultDescriptors(deps, {
    workspaceId: state.workspaceId,
    jobId: state.jobId,
    attempt: callback.attempt,
    results: callback.results,
  });

  const job = await loadJobRow(deps, { workspaceId: state.workspaceId, jobId: state.jobId });
  if (job.status === 'PROVIDER_QUEUED') {
    await transitionJob(deps, {
      workspaceId: state.workspaceId,
      jobId: state.jobId,
      to: 'RUNNING',
      stage: 'COLLECT',
      reason: 'PROVIDER_RESULT_RECEIVED',
    });
  }

  const collection = await collectProviderResult(deps, { workspaceId: state.workspaceId, jobId: state.jobId, now });
  return { jobId: state.jobId, collection, stale: false };
}

/**
 * 登记待回收的结果描述（**轮询补偿 / 人工恢复**路径：先登记描述符，再调用 collectProviderResult）。
 * 与回调路径共用同一 state 行（(workspace, job) 唯一）。
 */
export async function registerProviderResultDescriptors(
  deps: DomainDeps,
  input: { workspaceId: string; jobId: string; attempt: number; results: ProviderCallback['results'] },
): Promise<void> {
  const now = new Date();
  const expiresAt = input.results
    .map((result) => (result.expiresAt === null ? null : new Date(result.expiresAt)))
    .filter((value): value is Date => value !== null)
    .sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
  const updated = await deps.db
    .update(providerResultStates)
    .set({ results: input.results, expiresAt, attempt: input.attempt, status: 'PENDING', updatedAt: now })
    .where(and(eq(providerResultStates.workspaceId, input.workspaceId), eq(providerResultStates.jobId, input.jobId)))
    .returning({ id: providerResultStates.id });
  if (updated[0] === undefined) {
    throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'provider result state not found（任务尚未提交给 Provider）', 404);
  }
}

/** 登记"等待 Provider 结果"的状态（任务提交给 Provider 后由生成链路调用）。 */
export async function registerProviderResultPending(
  deps: DomainDeps,
  input: { workspaceId: string; jobId: string; providerId: string; providerJobId: string; attempt: number; estimatedCredits?: number },
): Promise<void> {
  await deps.db
    .insert(providerResultStates)
    .values({
      id: `prs_${randomUUID()}`,
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      providerId: input.providerId,
      providerJobId: input.providerJobId,
      attempt: input.attempt,
      status: 'PENDING',
    })
    .onConflictDoUpdate({
      target: [providerResultStates.workspaceId, providerResultStates.jobId],
      set: {
        providerId: input.providerId,
        providerJobId: input.providerJobId,
        attempt: input.attempt,
        status: 'PENDING',
        updatedAt: new Date(),
      },
    });
}

async function releaseResults(
  deps: DomainDeps,
  input: { workspaceId: string; jobId: string; status: 'FAILED' | 'EXPIRED'; error?: Record<string, unknown> },
): Promise<void> {
  await deps.db
    .update(providerResultStates)
    .set({ status: input.status, lastError: input.error ?? null, updatedAt: new Date() })
    .where(and(eq(providerResultStates.workspaceId, input.workspaceId), eq(providerResultStates.jobId, input.jobId)));
}

/**
 * 下载 → 校验 → **写入自有存储** → 落 Asset → 完成任务。
 * 失败（下载/校验）：只记录 collectAttempts 与错误；任务保持可回收（**不重生成**，AC-09）。
 */
export async function collectProviderResult(
  deps: DomainDeps,
  input: { workspaceId: string; jobId: string; now?: Date; maxBytes?: number },
): Promise<ResultCollection> {
  const now = input.now ?? new Date();
  const stateRows = await deps.db
    .select()
    .from(providerResultStates)
    .where(and(eq(providerResultStates.workspaceId, input.workspaceId), eq(providerResultStates.jobId, input.jobId)))
    .limit(1);
  const state = stateRows[0];
  if (state === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'provider result state not found', 404);

  const results = Array.isArray(state.results) ? (state.results as ProviderCallback['results']) : [];
  const collectedAssets: ResultCollection['assets'] = [];
  const fetcher = requireFetcher(deps);
  const storage = requireStorage(deps);
  let bytesCollected = 0;

  try {
    for (const descriptor of results) {
      // 1) 下载（一次性；URL 不落为永久标识）
      const fetched = await fetcher.fetch({ url: descriptor.url, maxBytes: input.maxBytes ?? DEFAULT_MAX_RESULT_BYTES });
      bytesCollected += fetched.bytes.byteLength;

      // 2) 校验：大小
      if (descriptor.sizeBytes !== null && fetched.bytes.byteLength !== descriptor.sizeBytes) {
        throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '结果校验失败：大小与声明不符', 409, {
          reason: 'SIZE_MISMATCH',
          declared: descriptor.sizeBytes,
          actual: fetched.bytes.byteLength,
        });
      }
      // 3) 校验：内容嗅探（伪造 MIME 拒收，与资产上传同规则）
      const sniffed = sniffMimeType(fetched.bytes.subarray(0, 64));
      if (!mimeMatches(descriptor.contentType, sniffed)) {
        throw new ApiFailure(ERROR_CODES.UNSUPPORTED_MEDIA_TYPE, '结果校验失败：内容与声明类型不符', 415, {
          reason: 'MIME_MISMATCH',
          declared: descriptor.contentType,
          sniffed,
        });
      }
      // 4) 校验：校验和（Provider 提供时必须一致）
      const checksum = await sha256Hex(fetched.bytes);
      if (descriptor.checksumSha256 !== null && checksum !== descriptor.checksumSha256) {
        throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '结果校验失败：校验和不符', 409, { reason: 'CHECKSUM_MISMATCH' });
      }

      // 5) 写入自有存储（§26 布局）；DB 只留 storage_key
      const assetId = `ast_${randomUUID()}`;
      const versionId = `av_${randomUUID()}`;
      const storageKey = `workspaces/${input.workspaceId}/library/providers/${state.providerId}/assets/${assetId}/v1/result.bin`;
      await storage.putObject(storageKey, fetched.bytes);

      // 6) 落 Asset（READY；Provider 生成为付费资产）
      const assetType = descriptor.assetType;
      const origin = assetType.startsWith('GENERATED') ? 'PROVIDER_GENERATED' : 'SYSTEM_RENDER';
      await deps.db.transaction(async (tx) => {
        await tx.insert(assets).values({
          id: assetId,
          workspaceId: input.workspaceId,
          projectId: null,
          assetType,
          origin,
          provider: state.providerId,
          providerAssetId: state.providerJobId,
          status: 'READY',
          retentionClass: origin === 'PROVIDER_GENERATED' ? 'KEEP_PAID_GENERATED' : 'KEEP_FINAL',
          license: {
            type: 'PROVIDER_TERMS',
            holder: null,
            attribution: null,
            sourceUrl: null,
            termsUrl: null,
            notes: `Provider 结果回收（${state.providerId}）`,
            confirmedBy: null,
            confirmedAt: null,
          },
          metadata: { collectedFromJob: input.jobId, providerJobId: state.providerJobId },
          currentVersionId: versionId,
        });
        await tx.insert(assetVersions).values({
          id: versionId,
          assetId,
          workspaceId: input.workspaceId,
          versionNumber: 1,
          storageKey,
          mimeType: descriptor.contentType,
          sizeBytes: fetched.bytes.byteLength,
          checksumSha256: checksum,
          status: 'READY',
          metadata: { probed: { mimeType: sniffed, sizeBytes: fetched.bytes.byteLength }, collectedAt: now.toISOString() },
        });
      });
      collectedAssets.push({
        assetId,
        assetVersionId: versionId,
        storageKey,
        mimeType: descriptor.contentType,
        sizeBytes: fetched.bytes.byteLength,
        checksumSha256: checksum,
      });
    }

    // 7) 回收成功：状态 COLLECTED、任务完成、生成记录完成、计费结算
    await deps.db
      .update(providerResultStates)
      .set({
        status: 'COLLECTED',
        collectedAt: now,
        collectAttempts: state.collectAttempts + 1,
        bytesCollected,
        lastError: null,
        updatedAt: now,
      })
      .where(eq(providerResultStates.id, state.id));

    const job = await loadJobRow(deps, { workspaceId: input.workspaceId, jobId: input.jobId });
    if (job.status === 'RUNNING' || job.status === 'PROVIDER_QUEUED') {
      await transitionJob(deps, {
        workspaceId: input.workspaceId,
        jobId: input.jobId,
        to: 'SUCCEEDED',
        stage: 'COLLECT',
        result: { assets: collectedAssets, providerJobId: state.providerJobId },
        reason: 'RESULT_COLLECTED',
      });
    }

    // 8) Provider 用量记录完成 + 计费结算（幂等；BYOK 策略在 billing 内）
    const generation = await recordProviderGeneration(deps, {
      workspaceId: input.workspaceId,
      input: {
        jobId: input.jobId,
        providerId: state.providerId,
        modelId: (job.input as { modelId?: string }).modelId ?? 'unknown-model',
        operation: (job.input as { operation?: string }).operation ?? 'generate',
        credentialMode: (job.input as { credentialMode?: 'BYOK' | 'PLATFORM_MANAGED' }).credentialMode ?? 'PLATFORM_MANAGED',
        inputHash: (job.input as { inputHash?: string }).inputHash ?? `job:${input.jobId}`,
        attempt: job.attempts,
        providerJobId: state.providerJobId,
        estimatedCost: (job.input as { estimatedCost?: { amount: string; currency: string } }).estimatedCost ?? null,
        estimatedCredits: (job.input as { estimatedCredits?: number }).estimatedCredits ?? null,
      },
    });
    await completeProviderGeneration(deps, {
      workspaceId: input.workspaceId,
      generationId: generation.id,
      status: 'SUCCEEDED',
      providerJobId: state.providerJobId,
    });
    await settleHold(deps, {
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      actualCredits: (job.input as { estimatedCredits?: number }).estimatedCredits ?? 0,
    }).catch(() => undefined); // 无预留（免费任务）时忽略

    await deps.db.insert(outboxEvents).values({
      id: `obx_${randomUUID()}`,
      workspaceId: input.workspaceId,
      type: 'asset.ready',
      payload: { jobId: input.jobId, providerId: state.providerId, assetIds: collectedAssets.map((asset) => asset.assetId), actorType: 'SYSTEM', actorId: null },
    });

    return resultCollectionSchema.parse({ jobId: input.jobId, collected: collectedAssets.length, assets: collectedAssets, failure: null });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const details = (error as { details?: Record<string, unknown> }).details ?? {};
    // 分类：内容校验类失败不可重试（伪造/损坏的占位结果）；下载与网络类失败可重试
    const validationReasons = new Set(['SIZE_MISMATCH', 'MIME_MISMATCH', 'CHECKSUM_MISMATCH']);
    const reasonRaw = typeof details['reason'] === 'string' ? (details['reason'] as string) : null;
    const retryable = reasonRaw === null ? !(error instanceof ApiFailure) || error.httpStatus >= 500 : !validationReasons.has(reasonRaw);
    await deps.db
      .update(providerResultStates)
      .set({
        status: 'PENDING', // 保持待回收：**只重试回收，不重新生成**（AC-09）
        collectAttempts: state.collectAttempts + 1,
        lastError: { message, ...details },
        updatedAt: now,
      })
      .where(eq(providerResultStates.id, state.id));
    await deps.db.insert(outboxEvents).values({
      id: `obx_${randomUUID()}`,
      workspaceId: input.workspaceId,
      type: 'provider.result.collect_failed',
      payload: { jobId: input.jobId, providerId: state.providerId, retryable, message: message.slice(0, 200), actorType: 'SYSTEM', actorId: null },
    });
    return resultCollectionSchema.parse({
      jobId: input.jobId,
      collected: collectedAssets.length,
      assets: collectedAssets,
      failure: { reason: retryable ? 'RESULT_FETCH_FAILED' : 'RESULT_INVALID', message: message.slice(0, 500), retryable },
    });
  }
}

/** 过期预警扫描：临时 URL 临近过期仍未回收 → 事件 + 标的需要对账；已过期 → EXPIRED。 */
export async function runResultExpirySweep(
  deps: DomainDeps,
  options: { now?: Date; warnWithinMinutes?: number; limit?: number } = {},
): Promise<{ warned: number; expired: number }> {
  const now = options.now ?? new Date();
  const warnWithin = (options.warnWithinMinutes ?? RESULT_EXPIRY_WARNING_MINUTES) * 60 * 1000;
  const limit = options.limit ?? 100;

  const expiring = await deps.db
    .select()
    .from(providerResultStates)
    .where(
      and(
        eq(providerResultStates.status, 'PENDING'),
        lte(providerResultStates.expiresAt, new Date(now.getTime() + warnWithin)),
      ),
    )
    .orderBy(asc(providerResultStates.expiresAt))
    .limit(limit);

  let warned = 0;
  let expired = 0;
  for (const state of expiring) {
    const alreadyExpired = state.expiresAt !== null && state.expiresAt.getTime() <= now.getTime();
    if (alreadyExpired) {
      await releaseResults(deps, {
        workspaceId: state.workspaceId,
        jobId: state.jobId,
        status: 'EXPIRED',
        error: { reason: 'RESULT_URL_EXPIRED', expiresAt: state.expiresAt?.toISOString() ?? null },
      });
      // 结果可能永久丢失：标记任务需要对账（不得自动重复付费提交，§5.6）
      await deps.db.execute(
        sql`update jobs set needs_reconciliation = true, updated_at = now() where id = ${state.jobId} and status in ('RUNNING','PROVIDER_QUEUED')`,
      );
      await deps.db.insert(outboxEvents).values({
        id: `obx_${randomUUID()}`,
        workspaceId: state.workspaceId,
        type: 'provider.result.expired',
        payload: { jobId: state.jobId, providerId: state.providerId, actorType: 'SYSTEM', actorId: null },
      });
      expired += 1;
      continue;
    }
    await deps.db.insert(outboxEvents).values({
      id: `obx_${randomUUID()}`,
      workspaceId: state.workspaceId,
      type: 'provider.result.expiring',
      payload: {
        jobId: state.jobId,
        providerId: state.providerId,
        expiresAt: state.expiresAt?.toISOString() ?? null,
        actorType: 'SYSTEM',
        actorId: null,
      },
    });
    warned += 1;
  }
  return { warned, expired };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
