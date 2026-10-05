import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { parseMedia } from '@remotion/media-parser';
import { nodeReader } from '@remotion/media-parser/node';
import {
  RENDER_FINAL_JOB_TYPE,
  renderManifestSchema,
  toSrtTime,
  toVttTime,
  type ArticleFetcher,
} from '@ancs/contracts';
import {
  createDb,
  assetVersions,
  assets,
  jobs,
  masterNarrations,
  redactDatabaseUrl,
  renderEvents,
  resolveTestDatabaseUrl,
  runMigrations,
  workspaces,
  type DbHandle,
} from '@ancs/db';
import {
  applyDirectorPlan,
  claimJob,
  createChannel,
  createContentFromUrl,
  createCreatorIdentity,
  createProject,
  createRender,
  generateNarrative,
  getRender,
  runExtraction,
  synthesizeMasterNarration,
  updateChannel,
  updateCreatorIdentity,
  type DomainDeps,
} from '@ancs/domain';
import { MockLlmAdapter } from '@ancs/providers-mock-llm';
import { MockTtsAdapter } from '@ancs/providers-mock-tts';
import { LocalObjectStorage } from '@ancs/providers-storage-local';
import { JobHandlerRegistry } from './handlers.js';
import { createProcessRenderExecutor } from './render-executor-process.js';
import { createRenderExecutionHandler } from './render-handler.js';
import { executeJob } from './runner.js';

/**
 * P07-04 验收（**真实 DB + 真实本地存储 + 真实 Remotion 渲染（spawn CLI）+ Mock LLM/TTS**）：
 * - 创建 Render 自动入队 RENDER_FINAL（同事务）→ Worker 认领 → 处理器经**进程隔离执行器**
 *   调用 render-worker 的 run-render.ts → MP4/SRT/VTT/Manifest 入自有存储 → transition(QA)；
 * - 成片元数据：1920×1080、30fps、时长与 Master Narration 一致、**含音轨**（计划 P07-04 验收）；
 * - Manifest（§28）：manifest_hash = manifest.json 字节 SHA-256；项目版本/组件版本/资产版本/Master 音频齐全；
 * - 失败定性：执行器失败 → Render=FAILED + 任务 FAILED_FINAL（不自动重试）。
 */

const ARTICLE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>利率周报</title></head><body>
<h1>美联储利率决议</h1>
<p>联邦基金利率维持在 5.25% 不变。市场预期通胀将继续回落，债券收益率曲线小幅走陡。</p>
<p>分析师认为，若就业数据走弱，降息预期可能提前。</p>
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

const deps = (): DomainDeps => ({ db: handle.db, storage, llm: llm, tts, articleFetcher: fetcher });

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
  storageRoot = await mkdtemp(join(tmpdir(), 'ancs-render-exec-'));
  storage = new LocalObjectStorage({
    rootDir: storageRoot,
    publicBaseUrl: 'http://127.0.0.1:3999',
    signingSecret: 'render-exec-storage-secret-0123456789', // secrets:check-ignore：测试专用假密钥
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

/** 完整可达渲染项目：栏目/身份 → 文章 → 叙事 → Director 应用 → Master Narration（Audio-First）。 */
async function makeRenderableProject(): Promise<{ workspaceId: string; projectId: string; planId: string }> {
  const workspaceId = `ws_${randomUUID()}`;
  await handle.db.insert(workspaces).values({ id: workspaceId, name: 'Final 合成租户' });
  const channel = await createChannel(deps(), { workspaceId, input: { name: '利率栏目' } });
  const identity = await createCreatorIdentity(deps(), { workspaceId, displayName: '主播甲' });
  await updateCreatorIdentity(deps(), {
    workspaceId,
    creatorIdentityId: identity.id,
    input: {
      voiceIdentity: {
        provider: 'mock-voice',
        providerVoiceId: 'vo_render_exec',
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
  const project = await createProject(deps(), { workspaceId, input: { title: 'Final 合成项目', channelId: channel.id } });
  const url = `https://news.example/rates/${randomUUID()}`;
  fetcher.responses.set(url, { contentType: 'text/html; charset=utf-8', bytes: new TextEncoder().encode(ARTICLE_HTML) });
  const record = await createContentFromUrl(deps(), { workspaceId, projectId: project.id, createdBy: null, input: { sourceType: 'URL_ARTICLE', url } });
  await runExtraction(deps(), { workspaceId, projectId: project.id, documentId: record.document.id });
  llm.scriptNext('valid');
  const generated = await generateNarrative(deps(), { workspaceId, projectId: project.id, documentId: record.document.id, targetDurationMs: 8000, createdBy: null });
  await applyDirectorPlan(deps(), { workspaceId, projectId: project.id, planId: generated.plan.id, actorId: 'user_test' });
  await synthesizeMasterNarration(deps(), { workspaceId, projectId: project.id, planId: generated.plan.id });
  return { workspaceId, projectId: project.id, planId: generated.plan.id };
}

function registryWith(executor: ReturnType<typeof createProcessRenderExecutor>): JobHandlerRegistry {
  return new JobHandlerRegistry([createRenderExecutionHandler({ executor })]);
}

async function claimRenderJob(workspaceId: string) {
  const claimed = await claimJob(deps(), { workerId: 'render-test-worker', leaseSeconds: 300, types: [RENDER_FINAL_JOB_TYPE] });
  expect(claimed, '应认领到 RENDER_FINAL 任务').not.toBeNull();
  expect(claimed?.workspaceId).toBe(workspaceId);
  return claimed as NonNullable<typeof claimed>;
}

describe('Final 合成（P07-04 端到端）', () => {
  it(
    '创建渲染 → 任务入队 → 真实渲染 → 产物入存储 → QA（1920×1080/30fps/音轨/时长）',
    { timeout: 900_000 },
    async () => {
      const { workspaceId, projectId } = await makeRenderableProject();

      // 1) 创建 Render：QUEUED + RENDER_FINAL 任务（同事务入队）
      const render = await createRender(deps(), { workspaceId, projectId, request: { profile: 'STUDIO_1080' }, createdBy: null });
      expect(render.status).toBe('QUEUED');
      expect(render.input.format).toEqual({ width: 1920, height: 1080, fps: 30 });
      const jobRows = await handle.db.select().from(jobs).where(eq(jobs.workspaceId, workspaceId));
      expect(jobRows).toHaveLength(1);
      expect(jobRows[0]?.type).toBe(RENDER_FINAL_JOB_TYPE);
      expect(jobRows[0]?.status).toBe('QUEUED');

      const master = await handle.db.select().from(masterNarrations).where(eq(masterNarrations.projectId, projectId)).limit(1);
      const masterDurationMs = master[0]?.totalDurationMs ?? 0;
      expect(masterDurationMs).toBeGreaterThan(1000);

      // 2) Worker 认领 + 执行（生产链路：进程隔离执行器 → render-worker CLI → Remotion）
      const claimed = await claimRenderJob(workspaceId);
      const outcome = await executeJob(deps(), registryWith(createProcessRenderExecutor({ timeoutMs: 15 * 60 * 1000 })), { workerId: 'render-test-worker', leaseSeconds: 300, heartbeatIntervalMs: 30_000 }, claimed);
      expect(outcome).toBe('succeeded');

      // 3) Render 进入 QA；产物资产齐备（MP4/SRT/VTT/Manifest）
      const after = await getRender(deps(), { workspaceId, renderId: render.id });
      expect(after.status).toBe('QA');
      expect(after.manifestHash).not.toBeNull();
      expect(after.outputAssetIds).toHaveLength(5); // VIDEO/SRT/VTT/MANIFEST + THUMBNAIL（P10-05）

      // 审计事件：QUEUED → RENDERING → QA（单向 + 审计）
      const events = await handle.db.select().from(renderEvents).where(eq(renderEvents.renderId, render.id)).orderBy(renderEvents.seq);
      expect(events.map((event) => event.status)).toEqual(['QUEUED', 'RENDERING', 'QA']);

      // 4) 产物全部在自有存储中（逐资产版本探测 + 读取字节）
      const versionRows = await handle.db.select().from(assetVersions).where(eq(assetVersions.workspaceId, workspaceId));
      const outputVersions = versionRows.filter((row) => after.outputAssetIds.includes(row.assetId));
      expect(outputVersions).toHaveLength(5); // + THUMBNAIL（P10-05）
      const assetRows = await handle.db.select().from(assets).where(eq(assets.workspaceId, workspaceId));
      const outputAssets = assetRows.filter((row) => after.outputAssetIds.includes(row.id));
      expect(outputAssets.every((row) => row.origin === 'SYSTEM_RENDER')).toBe(true);
      expect(outputAssets.every((row) => row.retentionClass === 'KEEP_FINAL')).toBe(true);
      expect(outputAssets.map((row) => row.assetType).sort()).toEqual(['FINAL_VIDEO', 'MANIFEST', 'SUBTITLE', 'SUBTITLE', 'THUMBNAIL']);
      for (const version of outputVersions) {
        const probe = await storage.probeObject(version.storageKey);
        expect(probe.exists, `${version.storageKey} 应在存储中`).toBe(true);
        expect(probe.sizeBytes).toBeGreaterThan(0);
        expect(version.checksumSha256).not.toBeNull();
      }

      // 5) Manifest：字节 SHA-256 = manifest_hash；REQ-28-01 基线字段；产物清单一致
      const manifestVersion = outputVersions.find((row) => row.mimeType === 'application/json');
      expect(manifestVersion).toBeDefined();
      const manifestBytes = await storage.getObject(manifestVersion?.storageKey ?? '');
      expect(manifestBytes).not.toBeNull();
      const digest = createHash('sha256').update(manifestBytes as Uint8Array).digest('hex');
      expect(digest).toBe(after.manifestHash);
      const manifest = renderManifestSchema.parse(JSON.parse(Buffer.from(manifestBytes as Uint8Array).toString('utf8')));
      expect(manifest.projectVersionId).toBe(render.input.projectVersionId);
      expect(manifest.projectId).toBe(projectId);
      expect(manifest.componentVersions.length).toBeGreaterThan(0);
      expect(manifest.masterAudio?.masterNarrationId).toBe(render.input.masterNarrationId);
      expect(manifest.masterAudio?.durationMs).toBe(masterDurationMs);
      expect(manifest.renderSettings.profile).toBe('STUDIO_1080');
      expect(manifest.renderSettings.width).toBe(1920);
      expect(manifest.renderSettings.height).toBe(1080);
      expect(manifest.outputs.map((output) => output.kind).sort()).toEqual(['SUBTITLE_SRT', 'SUBTITLE_VTT', 'THUMBNAIL', 'VIDEO']);

      // 6) MP4 元数据（真实解析产物字节）：1920×1080 / 30fps / 音轨存在 / 时长自洽
      const videoVersion = outputVersions.find((row) => row.mimeType === 'video/mp4');
      expect(videoVersion).toBeDefined();
      const videoBytes = await storage.getObject(videoVersion?.storageKey ?? '');
      expect(videoBytes).not.toBeNull();
      const localMp4 = join(storageRoot, 'verify-final.mp4');
      await writeFile(localMp4, videoBytes as Uint8Array);
      const media = await parseMedia({
        src: localMp4,
        reader: nodeReader,
        // 内部开发用途；商业上线前的 Remotion 授权核验见计划 P09-06（REQ-47-01）
        acknowledgeRemotionLicense: true,
        fields: { dimensions: true, durationInSeconds: true, fps: true, audioCodec: true, tracks: true },
      });
      expect(media.dimensions).toEqual({ width: 1920, height: 1080 });
      expect(media.fps).toBe(30);
      expect(media.audioCodec).not.toBeNull();
      expect(media.tracks.some((track) => track.type === 'audio')).toBe(true);
      // 容器时长 = 合成输入时长（spec.durationMs；含无旁白的章节卡——Director 插入的 CHAPTER_TITLE）
      const expectedSeconds = manifest.renderSettings.durationMs / 1000;
      expect(media.durationInSeconds).toBeGreaterThan(expectedSeconds - 0.35);
      expect(media.durationInSeconds).toBeLessThan(expectedSeconds + 0.35);
      // 旁白完整包含在成片中（音轨未被截断）
      expect(media.durationInSeconds).toBeGreaterThan(masterDurationMs / 1000 - 0.05);
      // 时长偏差是"已识别"的（After-Alignment 重定时未实现 → 明确告警，不静默）
      expect(manifest.renderSettings.durationMs).toBeGreaterThan(masterDurationMs + 1000);
      expect(manifest.warnings.some((warning) => warning.includes('After-Alignment'))).toBe(true);

      // 7) 字幕产物（时间权威 = Alignment）：cue 数与段数一致；末 cue 结束时刻 = Master 总时长
      const srtVersion = outputVersions.find((row) => row.mimeType === 'application/x-subrip');
      const vttVersion = outputVersions.find((row) => row.mimeType === 'text/vtt');
      const srtBytes = await storage.getObject(srtVersion?.storageKey ?? '');
      const vttBytes = await storage.getObject(vttVersion?.storageKey ?? '');
      const srt = Buffer.from(srtBytes as Uint8Array).toString('utf8');
      const vtt = Buffer.from(vttBytes as Uint8Array).toString('utf8');
      const cueCount = (master[0]?.cues as unknown[] | undefined)?.length ?? 0;
      expect(cueCount).toBeGreaterThan(0);
      expect(srt.match(/-->/g)).toHaveLength(cueCount);
      expect(vtt.startsWith('WEBVTT')).toBe(true);
      expect(srt).toContain(toSrtTime(masterDurationMs));
      expect(vtt).toContain(toVttTime(masterDurationMs));

      // 8) 任务完成回执（manifestHash/产物摘要）
      const jobAfter = (await handle.db.select().from(jobs).where(eq(jobs.id, claimed.id)).limit(1))[0];
      expect(jobAfter?.status).toBe('SUCCEEDED');
      expect((jobAfter?.result as Record<string, unknown>)['manifestHash']).toBe(after.manifestHash);
    },
  );

  it(
    '执行失败定性：Render=FAILED + 任务 FAILED_FINAL（不自动重试）',
    { timeout: 120_000 },
    async () => {
      const { workspaceId, projectId } = await makeRenderableProject();
      const render = await createRender(deps(), { workspaceId, projectId, request: { profile: 'DRAFT_720' }, createdBy: null });
      const claimed = await claimRenderJob(workspaceId);

      // 脚本化失败执行器（模拟渲染栈崩溃：非零退出）
      const failing = createProcessRenderExecutor({ command: [process.execPath, '-e', "console.error('renderer exploded'); process.exit(3);"] });
      const outcome = await executeJob(deps(), registryWith(failing), { workerId: 'render-test-worker', leaseSeconds: 60, heartbeatIntervalMs: 15_000 }, claimed);
      expect(outcome).toBe('succeeded');

      const after = await getRender(deps(), { workspaceId, renderId: render.id });
      expect(after.status).toBe('FAILED');
      expect(after.outputAssetIds).toHaveLength(0);
      expect((after.error as Record<string, unknown>)['reason']).toBe('EXECUTOR_FAILED');

      const jobAfter = (await handle.db.select().from(jobs).where(eq(jobs.id, claimed.id)).limit(1))[0];
      expect(jobAfter?.status).toBe('FAILED_FINAL');
      expect((jobAfter?.error as Record<string, unknown>)['reason']).toBe('RENDER_EXECUTION_FAILED');
    },
  );
});
