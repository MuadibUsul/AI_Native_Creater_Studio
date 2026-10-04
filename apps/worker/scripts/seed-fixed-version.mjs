#!/usr/bin/env node
/**
 * 固定版本渲染种子（P08-03 恢复演练工具；在 apps/worker 上下文运行以解析 @ancs/* 与 Mock 适配器）。
 *
 * 用途：
 *  1) 在**源库**造一个真实可渲染项目（栏目/身份 → 文章 → 叙事 → Director → Master Narration）
 *     并创建一次 Render（冻结输入），输出 { workspaceId, projectId, versionId, narrationId, renderInput, versionSnapshotHash }；
 *  2) 在**恢复库**上：
 *     - `--verify <json>`：核对固定版本快照哈希与渲染输入逐字段一致；
 *     - `--rerender <json>`：以同一 projectVersionId 重新创建 Render → 真实执行（进程隔离执行器）→ 报告状态与输入一致性。
 *
 * 输出：一行 JSON（stdout），供演练脚本断言。
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { createDb, projectVersions, workspaces } = await import('@ancs/db');
const { eq } = await import('drizzle-orm');
const domain = await import('@ancs/domain');
const { MockLlmAdapter } = await import('@ancs/providers-mock-llm');
const { MockTtsAdapter } = await import('@ancs/providers-mock-tts');
const { LocalObjectStorage } = await import('@ancs/providers-storage-local');

const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined || databaseUrl === '') {
  console.error(JSON.stringify({ ok: false, error: 'MISSING_DATABASE_URL' }));
  process.exit(1);
}

const storageDir = process.env['ANCS_STORAGE_LOCAL_DIR'] ?? join(await mkdtemp(join(tmpdir(), 'ancs-recovery-')), 'storage');
const storage = new LocalObjectStorage({ rootDir: storageDir, publicBaseUrl: 'http://127.0.0.1:1', signingSecret: 'recovery-storage-secret-0123456789' /* secrets:check-ignore：演练专用假密钥 */ });
const handle = createDb(databaseUrl);

const ARTICLE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>恢复演练</title></head><body>
<h1>利率决议</h1><p>联邦基金利率维持在 5.25% 不变。市场预期通胀回落。</p></body></html>`;

const fetcher = {
  kind: 'scripted',
  responses: new Map(),
  async fetch(input) {
    const response = this.responses.get(input.url);
    if (response === undefined) throw new Error(`unreachable: ${input.url}`);
    return { finalUrl: input.url, contentType: response.contentType, bytes: response.bytes };
  },
};

const mode = process.argv[2] ?? '--seed';
const argJson = process.argv[3];

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

async function seed() {
  const workspaceId = `ws_recovery_${randomUUID().slice(0, 8)}`;
  await handle.db.insert(workspaces).values({ id: workspaceId, name: '恢复演练租户' });
  const depsForSetup = { db: handle.db, storage, llm: new MockLlmAdapter(), tts: new MockTtsAdapter(), articleFetcher: fetcher };
  const channel = await domain.createChannel(depsForSetup, { workspaceId, input: { name: '演练栏目' } });
  const identity = await domain.createCreatorIdentity(depsForSetup, { workspaceId, displayName: '演练主播' });
  await domain.updateCreatorIdentity(depsForSetup, {
    workspaceId,
    creatorIdentityId: identity.id,
    input: {
      voiceIdentity: {
        provider: 'mock-voice',
        providerVoiceId: 'vo_recovery',
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
  await domain.updateChannel(depsForSetup, { workspaceId, channelId: channel.id, input: { defaults: { creatorIdentityId: identity.id } } });
  const project = await domain.createProject(depsForSetup, { workspaceId, input: { title: '恢复演练项目', channelId: channel.id } });
  const url = `https://news.example/recovery/${randomUUID()}`;
  fetcher.responses.set(url, { contentType: 'text/html; charset=utf-8', bytes: new TextEncoder().encode(ARTICLE_HTML) });
  const record = await domain.createContentFromUrl(depsForSetup, { workspaceId, projectId: project.id, createdBy: null, input: { sourceType: 'URL_ARTICLE', url } });
  await domain.runExtraction(depsForSetup, { workspaceId, projectId: project.id, documentId: record.document.id });
  const llm = new MockLlmAdapter();
  llm.scriptNext('valid');
  const deps = { ...depsForSetup, llm };
  const generated = await domain.generateNarrative(deps, { workspaceId, projectId: project.id, documentId: record.document.id, targetDurationMs: 3000, createdBy: null });
  await domain.applyDirectorPlan(deps, { workspaceId, projectId: project.id, planId: generated.plan.id, actorId: 'recovery-seed' });
  await domain.synthesizeMasterNarration(deps, { workspaceId, projectId: project.id, planId: generated.plan.id });
  const render = await domain.createRender(deps, { workspaceId, projectId: project.id, request: { profile: 'DRAFT_720' }, createdBy: null });

  const versionRow = (await handle.db.select().from(projectVersions).where(eq(projectVersions.id, render.input.projectVersionId)).limit(1))[0];
  return {
    ok: true,
    workspaceId,
    projectId: project.id,
    versionId: render.input.projectVersionId,
    narrationId: render.input.masterNarrationId,
    renderId: render.id,
    renderInput: JSON.stringify(render.input),
    versionSnapshotHash: sha256(JSON.stringify(versionRow?.snapshot ?? {})),
    storageDir,
  };
}

async function verify(reference) {
  const versionRow = (await handle.db.select().from(projectVersions).where(eq(projectVersions.id, reference.versionId)).limit(1))[0];
  const restoration = {
    ok: versionRow !== undefined,
    versionPresent: versionRow !== undefined,
    snapshotHashMatches: versionRow !== undefined && sha256(JSON.stringify(versionRow.snapshot)) === reference.versionSnapshotHash,
  };
  return { ok: restoration.ok && restoration.snapshotHashMatches, ...restoration };
}

async function rerender(reference) {
  const deps = { db: handle.db, storage };
  const render = await domain.createRender(deps, { workspaceId: reference.workspaceId, projectId: reference.projectId, request: { profile: 'DRAFT_720', projectVersionId: reference.versionId }, createdBy: null });
  const claimed = await domain.claimJob(deps, { workerId: 'recovery-rerender', leaseSeconds: 600, types: ['RENDER_FINAL'] });
  if (claimed === null) return { ok: false, error: 'NO_RENDER_JOB' };
  const { JobHandlerRegistry } = await import('../dist/handlers.js');
  const { createRenderExecutionHandler } = await import('../dist/render-handler.js');
  const { createProcessRenderExecutor } = await import('../dist/render-executor-process.js');
  const { executeJob } = await import('../dist/runner.js');
  const registry = new JobHandlerRegistry([createRenderExecutionHandler({ executor: createProcessRenderExecutor({ timeoutMs: 10 * 60 * 1000 }) })]);
  const outcome = await executeJob(deps, registry, { workerId: 'recovery-rerender', leaseSeconds: 600, heartbeatIntervalMs: 60_000 }, claimed);
  const fresh = await domain.getRender(deps, { workspaceId: reference.workspaceId, renderId: typeof claimed.input['renderId'] === 'string' ? claimed.input['renderId'] : render.id });
  const inputMatches = JSON.stringify(fresh.input) === reference.renderInput;
  return {
    ok: outcome === 'succeeded' && fresh.status === 'QA' && inputMatches,
    outcome,
    status: fresh.status,
    renderId: fresh.id,
    projectVersionId: fresh.input.projectVersionId,
    inputMatchesOriginal: inputMatches,
    manifestHash: fresh.manifestHash,
  };
}

try {
  if (mode === '--seed') {
    console.log(JSON.stringify(await seed()));
  } else if (mode === '--verify') {
    console.log(JSON.stringify(await verify(JSON.parse(argJson ?? '{}'))));
  } else if (mode === '--rerender') {
    console.log(JSON.stringify(await rerender(JSON.parse(argJson ?? '{}'))));
  } else {
    console.error(JSON.stringify({ ok: false, error: 'UNKNOWN_MODE', mode }));
    process.exit(1);
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
} finally {
  await handle.close();
}
