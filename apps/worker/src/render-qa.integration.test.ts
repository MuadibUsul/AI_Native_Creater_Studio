import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { RENDER_FINAL_JOB_TYPE, RENDER_QA_JOB_TYPE, type ArticleFetcher } from '@ancs/contracts';
import {
  applyDirectorPlan,
  claimJob,
  createChannel,
  createContentFromUrl,
  createCreatorIdentity,
  createProject,
  createRender,
  generateNarrative,
  getLatestRenderQaReport,
  getRender,
  runExtraction,
  synthesizeMasterNarration,
  transitionRender,
  updateChannel,
  updateCreatorIdentity,
  type DomainDeps,
} from '@ancs/domain';
import {
  createDb,
  jobs,
  masterNarrations,
  redactDatabaseUrl,
  renderQaReports,
  resolveTestDatabaseUrl,
  runMigrations,
  workspaces,
  type DbHandle,
} from '@ancs/db';
import { MockLlmAdapter } from '@ancs/providers-mock-llm';
import { MockTtsAdapter } from '@ancs/providers-mock-tts';
import { LocalObjectStorage } from '@ancs/providers-storage-local';
import { JobHandlerRegistry } from './handlers.js';
import { createProcessRenderExecutor } from './render-executor-process.js';
import { createRenderExecutionHandler } from './render-handler.js';
import { createProcessMediaProbe } from './media-probe-process.js';
import { createRenderQaHandler } from './qa-handler.js';
import { executeJob } from './runner.js';

/**
 * P07-05 验收（**真实 DB + 真实存储 + 真实渲染 + 真实 QA（含媒体探测）**）：
 * - 渲染完成 → **自动入队 RENDER_QA**（§86：Final Render 后 MUST 经过自动 QA）；
 * - QA：冻结快照内容检查 + 产物字节独立复核（校验和重算、MP4 元数据探测、字幕边界）→ PASS → READY + 报告落库；
 * - FAIL 路径：产物缺失（QA 状态无产物）→ 报告 FAIL + Render FAILED（阻断项可见）。
 */

const ARTICLE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>利率周报</title></head><body>
<h1>美联储利率决议</h1>
<p>联邦基金利率维持在 5.25% 不变。市场预期通胀将继续回落。</p>
</body></html>`;

class ScriptedFetcher implements ArticleFetcher {
  readonly kind = 'scripted';
  responses = new Map<string, { contentType: string | null; bytes: Uint8Array }>();
  async fetch(input: { url: string }): Promise<{ finalUrl: string; contentType: string | null; bytes: Uint8Array }> {
    const response = this.responses.get(input.url);
    if (response === undefined) throw new Error(`unreachable: ${input.url}`);
    return { finalUrl: input.url, contentType: response.contentType, bytes: response.bytes };
  }
}

let handle: DbHandle;
let storageRoot: string;
let storage: LocalObjectStorage;
let llm: MockLlmAdapter;
let tts: MockTtsAdapter;
const fetcher = new ScriptedFetcher();
const WORKER_ID = 'qa-test-worker';

const deps = (): DomainDeps => ({ db: handle.db, storage, llm, tts, articleFetcher: fetcher });

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
  storageRoot = await mkdtemp(join(tmpdir(), 'ancs-render-qa-'));
  storage = new LocalObjectStorage({
    rootDir: storageRoot,
    publicBaseUrl: 'http://127.0.0.1:3999',
    signingSecret: 'render-qa-storage-secret-0123456789', // secrets:check-ignore：测试专用假密钥
  });
});

afterAll(async () => {
  await handle.close();
  await rm(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await handle.db.delete(workspaces);
  llm = new MockLlmAdapter();
  tts = new MockTtsAdapter();
});

async function makeRenderableProject(): Promise<{ workspaceId: string; projectId: string }> {
  const workspaceId = `ws_${randomUUID()}`;
  await handle.db.insert(workspaces).values({ id: workspaceId, name: 'QA 租户' });
  const channel = await createChannel(deps(), { workspaceId, input: { name: 'QA 栏目' } });
  const identity = await createCreatorIdentity(deps(), { workspaceId, displayName: '主播丙' });
  await updateCreatorIdentity(deps(), {
    workspaceId,
    creatorIdentityId: identity.id,
    input: {
      voiceIdentity: {
        provider: 'mock-voice',
        providerVoiceId: 'vo_qa',
        cloneType: 'INSTANT',
        ownershipType: 'SELF_VERIFIED',
        verificationStatus: null,
        managedMode: 'BYOK',
        languageProfile: 'zh-CN',
        defaultSpeechProfileId: null,
        status: 'ACTIVE',
      },
    },
  });
  await updateChannel(deps(), { workspaceId, channelId: channel.id, input: { defaults: { creatorIdentityId: identity.id } } });
  const project = await createProject(deps(), { workspaceId, input: { title: 'QA 项目', channelId: channel.id } });
  const url = `https://news.example/rates/${randomUUID()}`;
  fetcher.responses.set(url, { contentType: 'text/html; charset=utf-8', bytes: new TextEncoder().encode(ARTICLE_HTML) });
  const record = await createContentFromUrl(deps(), { workspaceId, projectId: project.id, createdBy: null, input: { sourceType: 'URL_ARTICLE', url } });
  await runExtraction(deps(), { workspaceId, projectId: project.id, documentId: record.document.id });
  llm.scriptNext('valid');
  const generated = await generateNarrative(deps(), { workspaceId, projectId: project.id, documentId: record.document.id, targetDurationMs: 6000, createdBy: null });
  await applyDirectorPlan(deps(), { workspaceId, projectId: project.id, planId: generated.plan.id, actorId: 'user_test' });
  await synthesizeMasterNarration(deps(), { workspaceId, projectId: project.id, planId: generated.plan.id });
  return { workspaceId, projectId: project.id };
}

function fullRegistry() {
  return new JobHandlerRegistry([
    createRenderExecutionHandler({ executor: createProcessRenderExecutor({ timeoutMs: 15 * 60 * 1000 }) }),
    createRenderQaHandler({ probe: createProcessMediaProbe({ timeoutMs: 60_000 }) }),
  ]);
}

describe('Final QA（P07-05 端到端）', () => {
  it(
    '渲染完成自动入队 QA → 独立复核通过 → READY + 报告落库（0 阻止项失败）',
    { timeout: 900_000 },
    async () => {
      const { workspaceId, projectId } = await makeRenderableProject();
      const render = await createRender(deps(), { workspaceId, projectId, request: { profile: 'DRAFT_720' }, createdBy: null });

      // 1) RENDER_FINAL → 渲染完成（真实渲染）→ **自动入队 RENDER_QA**
      const finalJob = await claimJob(deps(), { workerId: WORKER_ID, leaseSeconds: 600, types: [RENDER_FINAL_JOB_TYPE] });
      expect(finalJob).not.toBeNull();
      expect(await executeJob(deps(), fullRegistry(), { workerId: WORKER_ID, leaseSeconds: 600, heartbeatIntervalMs: 60_000 }, finalJob as NonNullable<typeof finalJob>)).toBe('succeeded');
      const afterRender = await getRender(deps(), { workspaceId, renderId: render.id });
      expect(afterRender.status).toBe('QA');
      expect(afterRender.outputAssetIds).toHaveLength(4);
      const qaJobRows = await handle.db.select().from(jobs).where(eq(jobs.type, RENDER_QA_JOB_TYPE));
      expect(qaJobRows).toHaveLength(1);
      expect(qaJobRows[0]?.status).toBe('QUEUED');

      // 2) QA 执行（真实：冻结快照内容检查 + 产物字节独立复核（含媒体探测 CLI））
      const qaJob = await claimJob(deps(), { workerId: WORKER_ID, leaseSeconds: 300, types: [RENDER_QA_JOB_TYPE] });
      expect(qaJob).not.toBeNull();
      expect(await executeJob(deps(), fullRegistry(), { workerId: WORKER_ID, leaseSeconds: 300, heartbeatIntervalMs: 60_000 }, qaJob as NonNullable<typeof qaJob>)).toBe('succeeded');

      // 3) PASS → READY；报告落库（append-only）+ 逐项检查可见
      const afterQa = await getRender(deps(), { workspaceId, renderId: render.id });
      expect(afterQa.status).toBe('READY');
      const report = await getLatestRenderQaReport(deps(), { workspaceId, renderId: render.id });
      expect(report).not.toBeNull();
      expect(report?.verdict).toBe('PASS');
      expect(report?.summary.blockersFailed).toBe(0);
      expect(report?.scope).toBe('FINAL_RENDER');
      const checkIds = report?.checks.map((check) => check.id) ?? [];
      expect(checkIds).toContain('VIDEO_RESOLUTION_FPS');
      expect(checkIds).toContain('AUDIO_TRACK_PRESENT');
      expect(checkIds).toContain('SUBTITLE_TIMING_BOUNDS');
      expect(checkIds).toContain('ARTIFACT_CHECKSUM_MATCH');
      // SKIP 显式可见（响度/AI 视觉 QA 未交付）
      expect(report?.checks.filter((check) => check.status === 'SKIP').map((check) => check.id).sort()).toEqual(['AI_VISUAL_QA', 'AUDIO_LOUDNESS_RANGE']);
      // 分辨率与档位一致（DRAFT_720）
      const resolution = report?.checks.find((check) => check.id === 'VIDEO_RESOLUTION_FPS');
      expect(resolution?.status).toBe('PASS');
      expect(resolution?.details['width']).toBe(1280);
      // 报告行落库（audit）
      const reportRows = await handle.db.select().from(renderQaReports).where(eq(renderQaReports.renderId, render.id));
      expect(reportRows).toHaveLength(1);
      expect(reportRows[0]?.verdict).toBe('PASS');
      // Master Narration 引用与冻结一致（内容检查来自快照）
      const masterRows = await handle.db.select().from(masterNarrations).where(eq(masterNarrations.projectId, projectId)).limit(1);
      expect(render.input.masterNarrationId).toBe(masterRows[0]?.id ?? null);
    },
  );

  it(
    'FAIL 路径：产物缺失（QA 状态无产物）→ 报告 FAIL（ARTIFACTS_PRESENT 阻止）+ Render FAILED',
    { timeout: 120_000 },
    async () => {
      const { workspaceId, projectId } = await makeRenderableProject();
      const render = await createRender(deps(), { workspaceId, projectId, request: { profile: 'DRAFT_720' }, createdBy: null });
      // 手工推进到 QA 但不产生产物（模拟异常路径）
      await transitionRender(deps(), { workspaceId, renderId: render.id, to: 'RENDERING', note: '测试：直达 QA 无产物' });
      await transitionRender(deps(), { workspaceId, renderId: render.id, to: 'QA', note: '测试：无产物进入 QA' });

      const qaJob = await claimJob(deps(), { workerId: WORKER_ID, leaseSeconds: 120, types: [RENDER_QA_JOB_TYPE] });
      // 自动 QA 任务在本用例不存在（未跑渲染）——手动触发
      expect(qaJob).toBeNull();
      const { jobId } = await (await import('@ancs/domain')).triggerRenderQa(deps(), { workspaceId, renderId: render.id, requestedBy: null });
      const claimed = await claimJob(deps(), { workerId: WORKER_ID, leaseSeconds: 120, types: [RENDER_QA_JOB_TYPE] });
      expect(claimed?.id).toBe(jobId);
      expect(await executeJob(deps(), fullRegistry(), { workerId: WORKER_ID, leaseSeconds: 120, heartbeatIntervalMs: 60_000 }, claimed as NonNullable<typeof claimed>)).toBe('succeeded');

      const after = await getRender(deps(), { workspaceId, renderId: render.id });
      expect(after.status).toBe('FAILED');
      const report = await getLatestRenderQaReport(deps(), { workspaceId, renderId: render.id });
      expect(report?.verdict).toBe('FAIL');
      expect(report?.summary.blockersFailed).toBeGreaterThan(0);
      const artifacts = report?.checks.find((check) => check.id === 'ARTIFACTS_PRESENT');
      expect(artifacts?.status).toBe('FAIL');
      expect(artifacts?.severity).toBe('BLOCKER');
    },
  );
});
