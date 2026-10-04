import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { MOTION_GENERATE_JOB_TYPE } from '@ancs/contracts';
import {
  addScene,
  claimJob,
  createChannel,
  createCreatorIdentity,
  createProject,
  getCustomMotionComponent,
  listCustomMotionComponents,
  startCustomMotionGeneration,
  type DomainDeps,
} from '@ancs/domain';
import {
  createDb,
  customMotionComponents,
  customMotionComponentVersions,
  jobs,
  redactDatabaseUrl,
  resolveTestDatabaseUrl,
  runMigrations,
  workspaces,
  type DbHandle,
} from '@ancs/db';
import { MockLlmAdapter } from '@ancs/providers-mock-llm';
import { LocalObjectStorage } from '@ancs/providers-storage-local';
import { createDefaultRegistry } from './handlers.js';
import { createProcessMotionValidator } from './motion-validator-process.js';
import { executeJob } from './runner.js';

/**
 * P07-02 验收（**真实 DB + 真实本地存储 + 真实沙箱/类型检查（spawn 验证器 CLI）+ Mock LLM**）：
 * - 生成链路：MOTION_GENERATE 入队（去重）→ LLM 草稿 → 四道门禁 → **仅 APPROVED 版本化落库**；
 * - 落库内容：代码（sha256 复核）/依赖/输入快照/产物（source.js + frames.json 入自有存储）；
 * - **失败不能进入项目**：门禁拒绝 → 任务 FAILED_FINAL + 零组件行/零对象（拒绝细节在任务错误中）。
 */

let handle: DbHandle;
let storageRoot: string;
let storage: LocalObjectStorage;
let llm: MockLlmAdapter;

const deps = (): DomainDeps => ({ db: handle.db, storage, llm });

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
  storageRoot = await mkdtemp(join(tmpdir(), 'ancs-motion-'));
  storage = new LocalObjectStorage({
    rootDir: storageRoot,
    publicBaseUrl: 'http://127.0.0.1:3999',
    signingSecret: 'motion-integration-secret-0123456789', // secrets:check-ignore：测试专用假密钥
  });
});

afterAll(async () => {
  await handle.close();
  await rm(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await handle.db.delete(workspaces);
  llm = new MockLlmAdapter();
});

async function makeMotionScene(): Promise<{ workspaceId: string; projectId: string; sceneId: string }> {
  const workspaceId = `ws_${randomUUID()}`;
  await handle.db.insert(workspaces).values({ id: workspaceId, name: 'Motion 租户' });
  const channel = await createChannel(deps(), { workspaceId, input: { name: '高光栏目' } });
  const identity = await createCreatorIdentity(deps(), { workspaceId, displayName: '主播乙' });
  void identity;
  const project = await createProject(deps(), { workspaceId, input: { title: 'Motion 项目', channelId: channel.id } });
  const created = await addScene(deps(), {
    workspaceId,
    projectId: project.id,
    input: {
      sceneType: 'CUSTOM_MOTION',
      semanticType: 'CONCEPT',
      narration: '利率维持在 5.25% 不变。',
      visualIntent: '高光数字动效（生成式 Motion）',
      durationMs: 6000,
      props: { headline: '5.25%' },
    },
  });
  return { workspaceId, projectId: project.id, sceneId: created.scene.id };
}

async function executeMotionJob(workspaceId: string): Promise<ReturnType<typeof claimJob>> {
  const claimed = await claimJob(deps(), { workerId: 'motion-test-worker', leaseSeconds: 120, types: [MOTION_GENERATE_JOB_TYPE] });
  expect(claimed, '应认领到 MOTION_GENERATE 任务').not.toBeNull();
  const outcome = await executeJob(
    deps(),
    createDefaultRegistry({ motionValidator: createProcessMotionValidator({ timeoutMs: 120_000 }) }),
    { workerId: 'motion-test-worker', leaseSeconds: 120, heartbeatIntervalMs: 30_000 },
    claimed as NonNullable<typeof claimed>,
  );
  void workspaceId;
  expect(outcome).toBe('succeeded');
  return claimed;
}

describe('Custom Motion 生成（P07-02 端到端）', () => {
  it(
    '合法 Motion → 四道门禁通过 → 代码/依赖/输入/产物版本落库（sha256 复核）',
    { timeout: 180_000 },
    async () => {
      const { workspaceId, projectId, sceneId } = await makeMotionScene();
      llm.scriptNext('motion_valid');

      // 1) 发起生成（入队；去重键防重复点击）
      const started = await startCustomMotionGeneration(deps(), { workspaceId, projectId, sceneId, brief: '进度条 + 标题' });
      expect(started.reused).toBe(false);
      const startedAgain = await startCustomMotionGeneration(deps(), { workspaceId, projectId, sceneId, brief: '进度条 + 标题' });
      expect(startedAgain.reused).toBe(true);
      expect(startedAgain.job.id).toBe(started.job.id);
      expect(await handle.db.select().from(jobs).where(eq(jobs.type, MOTION_GENERATE_JOB_TYPE))).toHaveLength(1);

      // 2) Worker 执行（真实：spawn 验证器 CLI → 沙箱子进程 + tsc 类型检查）
      const claimed = await executeMotionJob(workspaceId);
      const jobAfter = (await handle.db.select().from(jobs).where(eq(jobs.id, claimed?.id ?? '')).limit(1))[0];
      expect(jobAfter?.status).toBe('SUCCEEDED');
      const result = jobAfter?.result as Record<string, unknown>;
      expect(result['validationGate']).toBe('APPROVED');
      expect(result['frames']).toBe(3);

      // 3) 落库内容：代码/依赖/输入/验证报告（仅 APPROVED）
      const componentRows = await handle.db.select().from(customMotionComponents).where(eq(customMotionComponents.projectId, projectId));
      expect(componentRows).toHaveLength(1);
      expect(componentRows[0]?.name).toBe('MockMotion');
      expect(componentRows[0]?.latestVersionNumber).toBe(1);
      const versionRows = await handle.db.select().from(customMotionComponentVersions).where(eq(customMotionComponentVersions.componentId, componentRows[0]?.id ?? ''));
      expect(versionRows).toHaveLength(1);
      const version = versionRows[0] as NonNullable<(typeof versionRows)[number]>;
      const validation = version.validation as { verdict: string; stages: { stage: string; ok: boolean }[]; frames: { frame: number; sha256: string }[] };
      expect(validation.verdict).toBe('APPROVED');
      expect(validation.stages.map((stage) => stage.stage)).toEqual(['STATIC_ANALYSIS', 'TYPE_CHECK', 'SANDBOX_EVALUATION', 'FRAME_SAMPLES']);
      expect(validation.stages.every((stage) => stage.ok)).toBe(true);
      expect(validation.frames).toHaveLength(3);
      expect(new Set(validation.frames.map((frame) => frame.sha256)).size).toBe(3);
      expect(version.dependencies).toEqual([]);
      const input = version.input as Record<string, unknown>;
      expect(input['sceneId']).toBe(sceneId);
      expect(input['promptVersion']).toBe('motion-design-v1');
      expect(input['llmModel']).toBe('mock-llm-2026-10');
      expect(input['brief']).toBe('进度条 + 标题');

      // 4) 产物入自有存储：source.js（字节 = 代码，sha256 复核）+ frames.json（抽帧证据）
      const sourceBytes = await storage.getObject(version.sourceStorageKey);
      expect(sourceBytes).not.toBeNull();
      const sourceText = Buffer.from(sourceBytes as Uint8Array).toString('utf8');
      expect(sourceText).toBe(version.code);
      expect(createHash('sha256').update(sourceText, 'utf8').digest('hex')).toBe(version.codeSha256);
      expect(sourceText).toContain('registerMotion');
      const framesBytes = await storage.getObject(version.framesStorageKey);
      expect(framesBytes).not.toBeNull();
      const framesArtifact = JSON.parse(Buffer.from(framesBytes as Uint8Array).toString('utf8')) as { frames: { frame: number }[]; codeSha256: string };
      expect(framesArtifact.codeSha256).toBe(version.codeSha256);
      expect(framesArtifact.frames.map((frame) => frame.frame)).toEqual([0, 89, 179]);

      // 5) 读取面（list/get）与版本化身份
      const listed = await listCustomMotionComponents(deps(), { workspaceId, projectId });
      expect(listed).toHaveLength(1);
      expect(listed[0]?.latestVersion?.codeSha256).toBe(version.codeSha256);
      const detail = await getCustomMotionComponent(deps(), { workspaceId, projectId, componentId: componentRows[0]?.id ?? '' });
      expect(detail.versions).toHaveLength(1);
      expect(detail.component.sceneId).toBe(sceneId);
    },
  );

  it(
    '门禁拒绝 → 任务 FAILED_FINAL + **零组件行/零对象**（失败不能进入项目）',
    { timeout: 120_000 },
    async () => {
      const { workspaceId, projectId, sceneId } = await makeMotionScene();
      llm.scriptNext('motion_unsafe'); // 危险词法（fetch）→ 静态分析拒绝

      await startCustomMotionGeneration(deps(), { workspaceId, projectId, sceneId, brief: null });
      const claimed = await executeMotionJob(workspaceId);
      const jobAfter = (await handle.db.select().from(jobs).where(eq(jobs.id, claimed?.id ?? '')).limit(1))[0];
      expect(jobAfter?.status).toBe('FAILED_FINAL');
      const error = jobAfter?.error as Record<string, unknown>;
      expect(error['reason']).toBe('VALIDATION_REJECTED');
      const report = error['report'] as { verdict: string; stages: { stage: string; ok: boolean }[] };
      expect(report.verdict).toBe('REJECTED');
      expect(report.stages[0]?.stage).toBe('STATIC_ANALYSIS');
      expect(report.stages[0]?.ok).toBe(false);

      // 失败不能进入项目：零组件行、零版本行、零存储对象（rootDir 内无该项目的对象）
      expect(await handle.db.select().from(customMotionComponents).where(eq(customMotionComponents.projectId, projectId))).toHaveLength(0);
      expect(await handle.db.select().from(customMotionComponentVersions)).toHaveLength(0);
      expect(await listCustomMotionComponents(deps(), { workspaceId, projectId })).toHaveLength(0);
    },
  );

  it(
    '组件版本不可变：同场景再次生成 → 新版本行（latestVersionNumber 递增）',
    { timeout: 240_000 },
    async () => {
      const { workspaceId, projectId, sceneId } = await makeMotionScene();
      llm.scriptNext('motion_valid');
      await startCustomMotionGeneration(deps(), { workspaceId, projectId, sceneId, brief: null });
      await executeMotionJob(workspaceId);

      llm.scriptNext('motion_valid');
      const second = await startCustomMotionGeneration(deps(), { workspaceId, projectId, sceneId, brief: '再来一版' });
      expect(second.job.id).not.toBe(undefined);
      await executeMotionJob(workspaceId);

      const componentRows = await handle.db.select().from(customMotionComponents).where(eq(customMotionComponents.projectId, projectId));
      expect(componentRows).toHaveLength(1);
      expect(componentRows[0]?.latestVersionNumber).toBe(2);
      const versionRows = await handle.db.select().from(customMotionComponentVersions).where(eq(customMotionComponentVersions.componentId, componentRows[0]?.id ?? ''));
      expect(versionRows.map((row) => row.versionNumber).sort()).toEqual([1, 2]);
    },
  );
});
