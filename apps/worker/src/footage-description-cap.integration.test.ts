import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  AGENT_ERROR_REASONS,
  AGENT_MODEL_PRICES,
  ApiFailure,
  MEDIA_ANALYSIS_ERROR_CODES,
  MEDIA_PROBE_JOB_TYPE,
  MEDIA_VISUAL_ANALYSIS_JOB_TYPE,
  MEDIA_VISUAL_ANALYSIS_PROCESSOR_VERSION,
  mergeModelPrices,
  type AgentModelAdapter,
  type AgentModelRequest,
} from '@ancs/contracts';
import { aiUsageRecords, assetVersions, createDb, mediaIndexRuns, resolveTestDatabaseUrl, runMigrations, workspaces, type DbHandle } from '@ancs/db';
import { claimJob, configureDeploymentPolicy, confirmUpload, createUploadIntent, retryFootageDescription, workspaceAiSpend, type DomainDeps } from '@ancs/domain';
import { LocalObjectStorage } from '@ancs/providers-storage-local';
import { createDefaultRegistry } from './handlers.js';
import { createModelVisualAnalysisAdapter } from './model-visual-analysis.js';
import { executeJob } from './runner.js';
import { createFfmpegSourceMediaProbe } from './source-media-probe-process.js';

/**
 * 上传后的画面理解计入工作区 AI 月度上限（真实 PostgreSQL + 真实 FFmpeg 抽帧 + 真实视觉适配器；视觉模型为脚本模型，
 * 按价格表里输入 $4/MTok 的模型单价计费，不调用真实 Provider）：
 * - 每次调用 $0.40；上限 $0.70：第 2 次调用后（本次分析在途的 $0.80 一并算上）停下，已花的入账，画面理解标为"额度用完"；
 * - 额度仍用完时"再理解一次"直接 402；上限提高后重试，四次调用全部完成并入账；
 * - 开始前已达上限：不取回源文件、不调用模型。
 */

let handle: DbHandle;
let storageRoot: string;
let storage: LocalObjectStorage;
const deps = (): DomainDeps => ({ db: handle.db, storage });
const fixture = resolve('packages/testing/fixtures/media-v04/clip-a-24000-1001.mp4');
const PRICED = Object.keys(AGENT_MODEL_PRICES).find((model) => AGENT_MODEL_PRICES[model]!.inputMicrosPerMTok === 4_000_000)!;
const created: string[] = [];

beforeAll(async () => {
  handle = createDb(resolveTestDatabaseUrl());
  await runMigrations(handle);
  storageRoot = await mkdtemp(join(tmpdir(), 'ancs-footage-cap-'));
  storage = new LocalObjectStorage({ rootDir: storageRoot, publicBaseUrl: 'http://127.0.0.1:3999', signingSecret: `footage-cap-${randomUUID()}` }); // secrets:check-ignore：测试专用假值
});
afterEach(() => configureDeploymentPolicy({}));
afterAll(async () => {
  for (const id of created) await handle.db.delete(workspaces).where(eq(workspaces.id, id));
  await handle.close();
  await rm(storageRoot, { recursive: true, force: true });
});

/** 每次调用 10 万输入 token（缺省按 $4/MTok 计 $0.40），按请求里的帧数回逐帧说明 */
function pricedVision(model = PRICED): AgentModelAdapter & { requests: AgentModelRequest[] } {
  const requests: AgentModelRequest[] = [];
  return {
    providerId: 'scripted', implementation: 'SCRIPTED', model, requests,
    respond: (request) => {
      requests.push(request);
      const frames = request.messages[0]!.content.filter((block) => block.type === 'image').length;
      return Promise.resolve({
        model, stopReason: 'end_turn', usage: { inputTokens: 100_000, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        content: [{ type: 'text', text: JSON.stringify(Array.from({ length: frames }, (_, frame) => ({ frame, description: 'test pattern' }))) }],
      });
    },
  };
}

async function uploadAndProbe() {
  const bytes = await readFile(fixture);
  const workspaceId = `ws_${randomUUID()}`;
  await handle.db.insert(workspaces).values({ id: workspaceId, name: '画面理解额度' });
  created.push(workspaceId);
  const checksumSha256 = createHash('sha256').update(bytes).digest('hex');
  const intent = await createUploadIntent(deps(), { workspaceId, userId: null, input: { assetType: 'USER_UPLOAD', filename: 'clip.mp4', contentType: 'video/mp4', sizeBytes: bytes.byteLength, checksumSha256 } });
  const version = (await handle.db.select().from(assetVersions).where(eq(assetVersions.assetId, intent.asset.id)).limit(1))[0]!;
  await storage.putObject(version.storageKey, bytes);
  await confirmUpload(deps(), { workspaceId, assetId: intent.asset.id, input: { checksumSha256 } });
  const job = await claimJob(deps(), { workerId: 'probe', leaseSeconds: 120, types: [MEDIA_PROBE_JOB_TYPE] });
  await executeJob(deps(), createDefaultRegistry({ sourceMediaProbe: createFfmpegSourceMediaProbe({ timeoutMs: 30_000 }) }), { workerId: 'probe', leaseSeconds: 120, heartbeatIntervalMs: 30_000 }, job!);
  return { workspaceId, assetId: intent.asset.id, versionId: version.id };
}

async function describeFootage(workspaceId: string, model: AgentModelAdapter) {
  const job = await claimJob(deps(), { workerId: 'vision', leaseSeconds: 120, types: [MEDIA_VISUAL_ANALYSIS_JOB_TYPE] });
  expect(job).not.toBeNull();
  // 4 秒素材、每秒一帧、每批一帧 → 4 次调用
  const adapter = createModelVisualAnalysisAdapter({ model, minIntervalMs: 1000, batchSize: 1 });
  return executeJob(deps(), createDefaultRegistry({ mediaVisualAnalysisAdapter: adapter }), { workerId: 'vision', leaseSeconds: 120, heartbeatIntervalMs: 30_000 }, job!);
}

const runOf = async (versionId: string) => (await handle.db.select().from(mediaIndexRuns)
  .where(and(eq(mediaIndexRuns.sourceAssetVersionId, versionId), eq(mediaIndexRuns.processorVersion, MEDIA_VISUAL_ANALYSIS_PROCESSOR_VERSION))).limit(1))[0]!;
const ledger = async (workspaceId: string) => handle.db.select().from(aiUsageRecords).where(eq(aiUsageRecords.workspaceId, workspaceId));

describe('画面理解计入工作区 AI 月度上限', () => {
  it('上限 $0.70：第 2 次调用后停下并入账 $0.80，标为额度用完；额度仍用完时重试 402；提高上限后重试完成并入账', { timeout: 120_000 }, async () => {
    configureDeploymentPolicy({ aiMonthlyCapMicros: 700_000 });
    const footage = await uploadAndProbe();
    const model = pricedVision();
    expect(await describeFootage(footage.workspaceId, model)).toBe('failed');
    expect(model.requests).toHaveLength(2);
    expect(await runOf(footage.versionId)).toMatchObject({ status: 'FAILED', errorCode: MEDIA_ANALYSIS_ERROR_CODES.AI_MONTHLY_CAP_REACHED });
    expect(await ledger(footage.workspaceId)).toEqual([expect.objectContaining({ kind: 'FOOTAGE_DESCRIPTION', model: PRICED, calls: 2, costMicros: 800_000, unpricedCalls: 0 })]);
    expect(await workspaceAiSpend(deps(), { workspaceId: footage.workspaceId })).toMatchObject({ spentMicros: 800_000, reached: true });

    const denied = await retryFootageDescription(deps(), { workspaceId: footage.workspaceId, assetId: footage.assetId }).then(() => null, (error: unknown) => error);
    expect(denied).toBeInstanceOf(ApiFailure);
    expect((denied as ApiFailure).httpStatus).toBe(402);
    expect((denied as ApiFailure).details).toMatchObject({ reason: AGENT_ERROR_REASONS.MONTHLY_CAP_REACHED });

    configureDeploymentPolicy({ aiMonthlyCapMicros: 5_000_000 });
    expect(await retryFootageDescription(deps(), { workspaceId: footage.workspaceId, assetId: footage.assetId })).toEqual({ status: 'QUEUED' });
    const again = pricedVision();
    expect(await describeFootage(footage.workspaceId, again)).toBe('succeeded');
    expect(again.requests).toHaveLength(4);
    expect((await runOf(footage.versionId)).status).toBe('READY');
    expect((await ledger(footage.workspaceId)).map((row) => row.costMicros).sort()).toEqual([1_600_000, 800_000]);
    expect(await workspaceAiSpend(deps(), { workspaceId: footage.workspaceId })).toMatchObject({ spentMicros: 2_400_000, reached: false });
  });

  it('开始前已达上限：不调用模型、不入账，直接标为额度用完', { timeout: 120_000 }, async () => {
    configureDeploymentPolicy({ aiMonthlyCapMicros: 0 });
    const footage = await uploadAndProbe();
    const model = pricedVision();
    expect(await describeFootage(footage.workspaceId, model)).toBe('failed');
    expect(model.requests).toHaveLength(0);
    expect(await runOf(footage.versionId)).toMatchObject({ status: 'FAILED', errorCode: MEDIA_ANALYSIS_ERROR_CODES.AI_MONTHLY_CAP_REACHED });
    expect(await ledger(footage.workspaceId)).toEqual([]);
  });

  it('设了上限而视觉模型没有单价：不调用、标为未配置原因；补上单价后照常理解并按单价入账', { timeout: 120_000 }, async () => {
    configureDeploymentPolicy({ aiMonthlyCapMicros: 5_000_000 });
    const footage = await uploadAndProbe();
    const unpriced = pricedVision('vendor-vision');
    expect(await describeFootage(footage.workspaceId, unpriced)).toBe('failed');
    expect(unpriced.requests).toHaveLength(0);
    expect(await runOf(footage.versionId)).toMatchObject({ status: 'FAILED', errorCode: MEDIA_ANALYSIS_ERROR_CODES.AI_MODEL_UNPRICED, errorSummary: expect.stringContaining('vendor-vision') });

    configureDeploymentPolicy({ aiMonthlyCapMicros: 5_000_000, modelPrices: mergeModelPrices({ 'vendor-vision': { input: 1, output: 4 } }) });
    expect(await retryFootageDescription(deps(), { workspaceId: footage.workspaceId, assetId: footage.assetId })).toEqual({ status: 'QUEUED' });
    expect(await describeFootage(footage.workspaceId, pricedVision('vendor-vision'))).toBe('succeeded');
    // 4 次 × 10 万 token × $1/MTok = $0.40
    expect(await ledger(footage.workspaceId)).toEqual([expect.objectContaining({ model: 'vendor-vision', calls: 4, costMicros: 400_000, unpricedCalls: 0 })]);
  });

  it('不设上限：照常理解并入账（入账只记录，不拦）', { timeout: 120_000 }, async () => {
    const footage = await uploadAndProbe();
    expect(await describeFootage(footage.workspaceId, pricedVision())).toBe('succeeded');
    expect(await ledger(footage.workspaceId)).toEqual([expect.objectContaining({ calls: 4, costMicros: 1_600_000 })]);
    expect(await workspaceAiSpend(deps(), { workspaceId: footage.workspaceId })).toMatchObject({ capMicros: null, spentMicros: 1_600_000, reached: false });
  });
});
