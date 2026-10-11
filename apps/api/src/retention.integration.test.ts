import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { LocalObjectStorage } from '@ancs/providers-storage-local';
import {
  assetVersions,
  assets,
  auditLog,
  createDb,
  idempotencyKeys,
  projectVersions,
  projects,
  redactDatabaseUrl,
  resolveTestDatabaseUrl,
  runMigrations,
  scenes,
  sequenceClips,
  uploadIntents,
  user,
  workspaces,
  type DbHandle,
} from '@ancs/db';
import {
  addScene,
  assertProjectVersionAssetRights,
  confirmUpload,
  createChannel,
  createProject,
  createProjectVersion,
  createSequence,
  createTrack,
  createUploadIntent,
  getAsset,
  getAssetLifecycle,
  listAssets,
  listProjects,
  listTrashedAssets,
  listTrashedProjects,
  processEdits,
  requestAssetPrivacyDeletion,
  restoreAsset,
  restoreProject,
  runRetentionSweep,
  softDeleteAsset,
  softDeleteProject,
  updateAssetRights,
  type DomainDeps,
} from '@ancs/domain';

/**
 * P02-05 验收（服务层，真实 DB + 真实本地存储）：
 * - Trash：软删除 → 默认列表不可见 → 保留期内可恢复；Trash 中项目不可读/写（404）；
 * - TTL 到期由**可重入**清理流程硬删（对象一并清理）；**重跑不误删**（第二次全零、其他数据完好）；
 * - 引用保护：Scene 绑定与项目版本快照引用 → 跳过；去重共享 storage_key → 对象保留到最后一个引用消失；
 * - 过期上传意图收敛（EXPIRED + 未完成版本 FAILED + 孤儿对象清理）；幂等键 TTL 清理。
 */

let handle: DbHandle;
let rootDir: string;
let storage: LocalObjectStorage;

const deps = (): DomainDeps => ({ db: handle.db, storage });

function makePng(seed: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  bytes.set([0x00, 0x00, 0x02, 0x80], 16);
  bytes.set([0x00, 0x00, 0x01, 0x68], 20);
  bytes[24] = 8;
  bytes[25] = 2;
  bytes[26] = seed & 0xff; // 使不同 seed 的校验和不同
  return bytes;
}

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
  rootDir = await mkdtemp(join(tmpdir(), 'ancs-retention-'));
  storage = new LocalObjectStorage({
    rootDir,
    publicBaseUrl: 'http://127.0.0.1:3999',
    signingSecret: 'retention-integration-secret-0123456789', // secrets:check-ignore：测试专用假密钥
  });
});

afterAll(async () => {
  await handle.close();
  await rm(rootDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await handle.db.delete(workspaces);
});

async function makeWorkspace(): Promise<{ workspaceId: string; projectId: string; sceneId: string; revision: number }> {
  const workspaceId = `ws_${randomUUID()}`;
  await handle.db.insert(workspaces).values({ id: workspaceId, name: '保留测试租户' });
  const channel = await createChannel(deps(), { workspaceId, input: { name: '栏目' } });
  const project = await createProject(deps(), { workspaceId, input: { title: '保留项目', channelId: channel.id } });
  const scene = await addScene(deps(), {
    workspaceId,
    projectId: project.id,
    input: { sceneType: 'HOST_FULL', semanticType: 'HOST_STATEMENT', durationMs: 5000 },
  });
  return { workspaceId, projectId: project.id, sceneId: scene.scene.id, revision: scene.project.revision };
}

/** 上传一个 READY 资产（真实直传 + 确认） */
async function uploadReadyAsset(workspaceId: string, projectId: string | null, seed = 1): Promise<{ assetId: string; versionId: string; storageKey: string }> {
  const bytes = makePng(seed);
  const intent = await createUploadIntent(deps(), {
    workspaceId,
    userId: null,
    input: { assetType: 'USER_UPLOAD', filename: `retention-${String(seed)}.png`, contentType: 'image/png', sizeBytes: bytes.byteLength, projectId },
  });
  if (intent.upload === null) throw new Error('unexpected dedupe');
  const payload = storage.verifyToken(new URL(intent.upload.url).searchParams.get('token') ?? '', 'upload');
  if (payload === null) throw new Error('token 校验失败');
  await storage.writeObject(payload.key, bytes);
  const detail = await confirmUpload(deps(), { workspaceId, assetId: intent.asset.id, input: {} });
  return { assetId: detail.id, versionId: detail.versions[0]?.id ?? '', storageKey: detail.versions[0]?.storageKey ?? '' };
}

const DAY = 24 * 60 * 60 * 1000;

describe('Trash（软删 / 恢复 / 隔离）', () => {
  it('软删除后默认列表不可见（可经 trashed 视图查询），恢复期内可恢复且读写恢复', async () => {
    const { workspaceId, projectId } = await makeWorkspace();
    const { assetId } = await uploadReadyAsset(workspaceId, projectId);

    const deletedProject = await softDeleteProject(deps(), { workspaceId, projectId });
    expect(deletedProject.id).toBe(projectId);
    expect(await listProjects(deps(), { workspaceId })).toHaveLength(0);
    expect((await listTrashedProjects(deps(), workspaceId)).map((row) => row.id)).toEqual([projectId]);
    // Trash 中项目不可编辑（404）
    const edits = await processEdits(deps(), {
      workspaceId,
      projectId,
      actor: { type: 'USER', id: 'u' },
      request: {
        baseProjectRevision: 1,
        expectedSceneRevisions: {},
        operations: [{ op: 'update_project', changes: { title: '不应生效' } }],
        idempotencyKey: `idem_trash_${randomUUID()}`,
      },
    }).catch((error: unknown) => error);
    expect(edits).toMatchObject({ httpStatus: 404 });

    // 保留期内清理不触碰 Trash：恢复成功
    const sweepEarly = await runRetentionSweep(deps(), { now: new Date(Date.now() + 10 * DAY) });
    expect(sweepEarly.projectsPurged).toBe(0);
    const restored = await restoreProject(deps(), { workspaceId, projectId });
    expect(restored.id).toBe(projectId);
    expect(await listProjects(deps(), { workspaceId })).toHaveLength(1);

    // 资产同理
    await softDeleteAsset(deps(), { workspaceId, assetId });
    expect(await listAssets(deps(), { workspaceId })).toHaveLength(0);
    expect((await listTrashedAssets(deps(), workspaceId)).map((row) => row.id)).toEqual([assetId]);
    const restoredAsset = await restoreAsset(deps(), { workspaceId, assetId });
    expect(restoredAsset.id).toBe(assetId);
    expect((await getAsset(deps(), { workspaceId, assetId })).status).toBe('READY');
  });

  it('Trash 到期：项目整体硬删（含场景/版本/事件），其资产与对象一并清理', async () => {
    const { workspaceId, projectId } = await makeWorkspace();
    const { assetId, storageKey } = await uploadReadyAsset(workspaceId, projectId);
    await softDeleteProject(deps(), { workspaceId, projectId });

    const now = new Date(Date.now() + 31 * DAY);
    const report = await runRetentionSweep(deps(), { now });
    expect(report.projectsPurged).toBe(1);
    expect(report.projectAssetsPurged).toBe(1);
    expect(report.objectsDeleted).toBe(1);

    expect(await listProjects(deps(), { workspaceId })).toHaveLength(0);
    expect((await listTrashedProjects(deps(), workspaceId))).toHaveLength(0);
    expect(await handle.db.select().from(assets).where(eq(assets.workspaceId, workspaceId))).toHaveLength(0);
    expect(await handle.db.select().from(scenes).where(eq(scenes.workspaceId, workspaceId))).toHaveLength(0);
    expect((await storage.probeObject(storageKey)).exists).toBe(false);
    void assetId;
  });

  it('可重入：清理中断后重跑收敛、**重跑不误删**（第二次全零，其他租户数据完好）', async () => {
    const a = await makeWorkspace();
    const b = await makeWorkspace();
    const assetA = await uploadReadyAsset(a.workspaceId, a.projectId, 7);
    const assetB = await uploadReadyAsset(b.workspaceId, b.projectId, 8);
    await softDeleteAsset(deps(), { workspaceId: a.workspaceId, assetId: assetA.assetId });

    const now = new Date(Date.now() + 31 * DAY);
    const first = await runRetentionSweep(deps(), { now });
    expect(first.trashAssetsPurged).toBe(1);
    expect((await storage.probeObject(assetA.storageKey)).exists).toBe(false);

    // 第二次运行（模拟崩溃重启后的重复执行）：不产生任何删除
    const second = await runRetentionSweep(deps(), { now });
    expect(second).toMatchObject({
      projectsPurged: 0,
      projectAssetsPurged: 0,
      trashAssetsPurged: 0,
      retentionAssetsPurged: 0,
      objectsDeleted: 0,
      orphanObjectsDeleted: 0,
    });

    // 其他租户的数据与对象完好
    expect((await getAsset(deps(), { workspaceId: b.workspaceId, assetId: assetB.assetId })).status).toBe('READY');
    expect((await storage.probeObject(assetB.storageKey)).exists).toBe(true);
  });

  it('引用保护：Scene 绑定与项目版本快照阻止硬删；解绑/快照清理后收敛', async () => {
    const { workspaceId, projectId, sceneId, revision } = await makeWorkspace();
    const { assetId, storageKey } = await uploadReadyAsset(workspaceId, projectId, 11);

    // 绑定到 Scene（replace_asset）
    await processEdits(deps(), {
      workspaceId,
      projectId,
      actor: { type: 'USER', id: 'u' },
      request: {
        baseProjectRevision: revision,
        expectedSceneRevisions: { [sceneId]: 1 },
        operations: [{ op: 'replace_asset', sceneId, role: 'visual', newAssetId: assetId }],
        idempotencyKey: `idem_bind_${randomUUID()}`,
      },
    });

    // 建版本快照（快照含 assetId）
    const version = await createProjectVersion(deps(), { workspaceId, projectId, reason: 'MANUAL' });

    // 进 Trash 并到期 → 绑定保护：跳过（资产与对象都保留）
    await softDeleteAsset(deps(), { workspaceId, assetId });
    const now = new Date(Date.now() + 31 * DAY);
    const bound = await runRetentionSweep(deps(), { now });
    expect(bound.assetsSkippedByReference).toBeGreaterThanOrEqual(1);
    expect(bound.trashAssetsPurged).toBe(0);
    expect(await handle.db.select().from(assets).where(eq(assets.id, assetId))).toHaveLength(1);
    expect((await storage.probeObject(storageKey)).exists).toBe(true);

    // 解除绑定 + 删除项目版本快照引用后 → 清理收敛
    await processEdits(deps(), {
      workspaceId,
      projectId,
      actor: { type: 'USER', id: 'u' },
      request: {
        baseProjectRevision: revision + 1,
        expectedSceneRevisions: { [sceneId]: 2 },
        operations: [{ op: 'replace_asset', sceneId, role: 'visual', newAssetId: null }],
        idempotencyKey: `idem_unbind_${randomUUID()}`,
      },
    });
    await handle.db.delete(projectVersions).where(eq(projectVersions.id, version.id));

    const after = await runRetentionSweep(deps(), { now });
    expect(after.trashAssetsPurged).toBe(1);
    expect((await storage.probeObject(storageKey)).exists).toBe(false);
  });

  it('共享资产保护：去重共享 storage_key 时对象保留至最后一个引用消失', async () => {
    const { workspaceId, projectId } = await makeWorkspace();
    const bytes = makePng(21);
    // 第一次上传（含 checksum 便于后续去重）
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
    const checksum = Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const first = await createUploadIntent(deps(), {
      workspaceId,
      userId: null,
      input: { assetType: 'USER_UPLOAD', filename: 'shared-1.png', contentType: 'image/png', sizeBytes: bytes.byteLength, projectId, checksumSha256: checksum },
    });
    const payload = storage.verifyToken(new URL(first.upload?.url ?? '').searchParams.get('token') ?? '', 'upload');
    await storage.writeObject(payload?.key ?? '', bytes);
    const firstDetail = await confirmUpload(deps(), { workspaceId, assetId: first.asset.id, input: {} });
    const sharedKey = firstDetail.versions[0]?.storageKey ?? '';

    // 第二次上传相同内容（不预声明 checksum）→ 确认阶段去重：复用对象
    const second = await createUploadIntent(deps(), {
      workspaceId,
      userId: null,
      input: { assetType: 'USER_UPLOAD', filename: 'shared-2.png', contentType: 'image/png', sizeBytes: bytes.byteLength, projectId },
    });
    const payload2 = storage.verifyToken(new URL(second.upload?.url ?? '').searchParams.get('token') ?? '', 'upload');
    await storage.writeObject(payload2?.key ?? '', bytes);
    const secondDetail = await confirmUpload(deps(), { workspaceId, assetId: second.asset.id, input: {} });
    expect(secondDetail.versions[0]?.storageKey).toBe(sharedKey);

    // 删除第一个 → 到期清理：对象仍被第二个引用 → 保留
    await softDeleteAsset(deps(), { workspaceId, assetId: firstDetail.id });
    const now = new Date(Date.now() + 31 * DAY);
    const sweep1 = await runRetentionSweep(deps(), { now });
    expect(sweep1.trashAssetsPurged).toBe(1);
    expect(sweep1.objectsKeptShared).toBe(1);
    expect((await storage.probeObject(sharedKey)).exists).toBe(true);

    // 删除第二个 → 清理后对象消失
    await softDeleteAsset(deps(), { workspaceId, assetId: secondDetail.id });
    const sweep2 = await runRetentionSweep(deps(), { now });
    expect(sweep2.trashAssetsPurged).toBe(1);
    expect(sweep2.objectsDeleted).toBe(1);
    expect((await storage.probeObject(sharedKey)).exists).toBe(false);
  });
});

describe('TTL 与过期收敛', () => {
  it('保留类 TTL：Draft Render 30 天到期自动清理（不进 Trash 也会清理）', async () => {
    const { workspaceId } = await makeWorkspace();
    // 直接构造 DRAFT_RENDER 资产（渲染类资产由系统创建；此处模拟已有产物）
    const bytes = makePng(31);
    const assetId = `ast_${randomUUID()}`;
    const versionId = `av_${randomUUID()}`;
    const storageKey = `workspaces/${workspaceId}/library/renders/assets/${assetId}/v1/draft.mp4`;
    await storage.writeObject(storageKey, bytes);
    await handle.db.insert(assets).values({
      id: assetId,
      workspaceId,
      assetType: 'DRAFT_RENDER',
      origin: 'SYSTEM_RENDER',
      status: 'READY',
      retentionClass: 'DRAFT_RENDER_30D',
      license: { type: 'PROVIDER_TERMS', holder: null, attribution: null, sourceUrl: null, termsUrl: null, notes: null, confirmedBy: null, confirmedAt: null },
      currentVersionId: versionId,
      createdAt: new Date(Date.now() - 40 * DAY),
      updatedAt: new Date(),
    });
    await handle.db.insert(assetVersions).values({
      id: versionId,
      assetId,
      workspaceId,
      versionNumber: 1,
      storageKey,
      mimeType: 'video/mp4',
      sizeBytes: bytes.byteLength,
      checksumSha256: 'a'.repeat(64),
      status: 'READY',
      metadata: {},
    });

    const report = await runRetentionSweep(deps(), { now: new Date() });
    expect(report.retentionAssetsPurged).toBe(1);
    expect(await handle.db.select().from(assets).where(eq(assets.id, assetId))).toHaveLength(0);
    expect((await storage.probeObject(storageKey)).exists).toBe(false);
  });

  it('过期上传意图：PENDING → EXPIRED、未完成版本 FAILED、孤儿对象清理；重跑不重复计数', async () => {
    const { workspaceId } = await makeWorkspace();
    const expiredDeps: DomainDeps = { db: handle.db, storage, uploadIntentTtlSeconds: -60 };
    const bytes = makePng(41);
    const intent = await createUploadIntent(expiredDeps, {
      workspaceId,
      userId: null,
      input: { assetType: 'USER_UPLOAD', filename: 'abandoned.png', contentType: 'image/png', sizeBytes: bytes.byteLength },
    });
    const key = (() => {
      const url = intent.upload?.url ?? '';
      return url;
    })();
    void key;
    // 直传完成但从未确认（用户中途放弃）
    const storageKey = `workspaces/${workspaceId}/library/uploads/assets/${intent.asset.id}/v1/abandoned.png`;
    await storage.writeObject(storageKey, bytes);

    const sweep = await runRetentionSweep(deps(), { now: new Date() });
    expect(sweep.uploadIntentsExpired).toBe(1);
    expect(sweep.orphanObjectsDeleted).toBe(1);
    expect((await storage.probeObject(storageKey)).exists).toBe(false);
    const intentRows = await handle.db.select().from(uploadIntents).where(eq(uploadIntents.assetId, intent.asset.id));
    expect(intentRows[0]?.status).toBe('EXPIRED');
    const versionRows = await handle.db.select().from(assetVersions).where(eq(assetVersions.assetId, intent.asset.id));
    expect(versionRows[0]?.status).toBe('FAILED');

    const again = await runRetentionSweep(deps(), { now: new Date() });
    expect(again.uploadIntentsExpired).toBe(0);
    expect(again.orphanObjectsDeleted).toBe(0);
  });

  it('幂等键 TTL：过期行被清理，未过期保留', async () => {
    await handle.db.insert(idempotencyKeys).values({
      id: `idem_old_${randomUUID()}`,
      scope: 'user:u:POST:/api/v1/projects',
      key: `k_old_${randomUUID()}`,
      requestHash: 'h1',
      statusCode: 200,
      responseJson: { ok: true },
      createdAt: new Date(Date.now() - 30 * 60 * 60 * 1000), // 30 小时前
    });
    await handle.db.insert(idempotencyKeys).values({
      id: `idem_new_${randomUUID()}`,
      scope: 'user:u:POST:/api/v1/projects',
      key: `k_new_${randomUUID()}`,
      requestHash: 'h2',
      statusCode: 200,
      responseJson: { ok: true },
    });

    const report = await runRetentionSweep(deps(), { now: new Date() });
    expect(report.idempotencyKeysPurged).toBe(1);
    const remaining = await handle.db.select().from(idempotencyKeys);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.requestHash).toBe('h2');
    void projects;
  });
});

describe('N02-07 来源、许可与隐私删除', () => {
  it('保存权利与引用证据；到期许可阻止发布；隐私删除先报告依赖再清理原件并留审计', async () => {
    const { workspaceId, projectId, sceneId, revision } = await makeWorkspace();
    const uploaded = await uploadReadyAsset(workspaceId, projectId, 77);
    const userId = `usr_${randomUUID()}`;
    await handle.db.insert(user).values({ id: userId, name: '权利测试用户', email: `${userId}@example.test` });
    const future = new Date(Date.now() + DAY).toISOString();
    const rights = await updateAssetRights(deps(), {
      workspaceId, assetId: uploaded.assetId, userId,
      request: { type: 'USER_OWNED', holder: '测试权利人', attribution: '© 测试权利人', sourceUrl: null, termsUrl: null, notes: null, userOwnedDeclared: true, permittedUses: ['EDIT', 'PUBLISH'], expiresAt: future, sensitivityClass: 'SENSITIVE' },
    });
    expect(rights.asset.sensitivityClass).toBe('SENSITIVE');
    expect(rights.licenseState).toBe('ACTIVE');

    await processEdits(deps(), {
      workspaceId, projectId, actor: { type: 'USER', id: userId },
      request: { baseProjectRevision: revision, expectedSceneRevisions: { [sceneId]: 1 }, operations: [{ op: 'replace_asset', sceneId, role: 'visual', newAssetId: uploaded.assetId }], idempotencyKey: `idem_rights_bind_${randomUUID()}` },
    });
    const version = await createProjectVersion(deps(), { workspaceId, projectId, reason: 'PUBLISH' });
    const lifecycle = await getAssetLifecycle(deps(), { workspaceId, assetId: uploaded.assetId });
    expect(lifecycle.references.some((reference) => reference.kind === 'SCENE')).toBe(true);
    expect(lifecycle.references.some((reference) => reference.projectVersionId === version.id)).toBe(true);
    expect(lifecycle.gcProtected).toBe(true);

    const deferred = await requestAssetPrivacyDeletion(deps(), {
      workspaceId, assetId: uploaded.assetId, userId,
      request: { confirmationAssetId: uploaded.assetId, reason: '用户请求删除原始素材' },
    });
    expect(deferred.status).toBe('DEFERRED_BY_REFERENCES');
    expect(deferred.missingDependencies.length).toBeGreaterThanOrEqual(2);
    expect((await getAsset(deps(), { workspaceId, assetId: uploaded.assetId })).id).toBe(uploaded.assetId);
    expect(await handle.db.select().from(auditLog).where(eq(auditLog.targetId, uploaded.assetId))).toHaveLength(2);

    await updateAssetRights(deps(), {
      workspaceId, assetId: uploaded.assetId, userId,
      request: { type: 'LICENSED', holder: '测试权利人', attribution: null, sourceUrl: null, termsUrl: null, notes: null, userOwnedDeclared: false, permittedUses: ['EDIT', 'PUBLISH'], expiresAt: new Date(Date.now() - DAY).toISOString(), sensitivityClass: 'SENSITIVE' },
    });
    await expect(assertProjectVersionAssetRights(deps(), { workspaceId, projectId, projectVersionId: version.id })).rejects.toMatchObject({ details: { reason: 'ASSET_RIGHTS_BLOCK_PUBLICATION' } });

    await processEdits(deps(), {
      workspaceId, projectId, actor: { type: 'USER', id: userId },
      request: { baseProjectRevision: revision + 1, expectedSceneRevisions: { [sceneId]: 2 }, operations: [{ op: 'replace_asset', sceneId, role: 'visual', newAssetId: null }], idempotencyKey: `idem_rights_unbind_${randomUUID()}` },
    });
    await handle.db.delete(projectVersions).where(eq(projectVersions.id, version.id));
    const scheduled = await requestAssetPrivacyDeletion(deps(), {
      workspaceId, assetId: uploaded.assetId, userId,
      request: { confirmationAssetId: uploaded.assetId, reason: '依赖已解除，执行隐私删除' },
    });
    expect(scheduled.status).toBe('SCHEDULED');
    const sweep = await runRetentionSweep(deps(), { now: new Date() });
    expect(sweep.trashAssetsPurged).toBe(1);
    expect((await storage.probeObject(uploaded.storageKey)).exists).toBe(false);
  });
});

describe('V5-M0 清理稳健性（代码审查 P0-2 / P1-1 回归）', () => {
  async function insertDraftRender(workspaceId: string, createdAt: Date, retentionClass = 'DRAFT_RENDER_30D'): Promise<string> {
    const assetId = `ast_${randomUUID()}`;
    const versionId = `av_${randomUUID()}`;
    await handle.db.insert(assets).values({
      id: assetId, workspaceId, assetType: 'DRAFT_RENDER', origin: 'SYSTEM_RENDER', status: 'READY', retentionClass,
      license: { type: 'PROVIDER_TERMS', holder: null, attribution: null, sourceUrl: null, termsUrl: null, notes: null, confirmedBy: null, confirmedAt: null },
      currentVersionId: versionId, createdAt, updatedAt: createdAt,
    });
    await handle.db.insert(assetVersions).values({
      id: versionId, assetId, workspaceId, versionNumber: 1, storageKey: `workspaces/${workspaceId}/m0/${assetId}.bin`,
      mimeType: 'video/mp4', sizeBytes: 1, checksumSha256: 'b'.repeat(64), status: 'READY', metadata: {},
    });
    return assetId;
  }

  it('时间线片段引用的资产：跳过而不是让整轮清理因外键失败；排在它后面的到期资产照常清理', async () => {
    const { workspaceId, projectId } = await makeWorkspace();
    const referenced = await uploadReadyAsset(workspaceId, projectId, 41);
    const free = await uploadReadyAsset(workspaceId, projectId, 42);
    const sequence = await createSequence(deps(), {
      workspaceId, projectId, input: { name: '主序列', frameRate: { num: 30, den: 1 }, duration: { ticks: '10000', timebase: { num: 1, den: 1000 } } },
    });
    const track = await createTrack(deps(), { workspaceId, projectId, sequenceId: sequence.id, input: { kind: 'VIDEO', position: 0, name: 'V1' } });
    const range = { start: { ticks: '0', timebase: { num: 1, den: 1000 } }, end: { ticks: '1000', timebase: { num: 1, den: 1000 } } };
    await handle.db.insert(sequenceClips).values({
      id: `clip_${randomUUID()}`, workspaceId, projectId, sequenceId: sequence.id, trackId: track.id,
      assetVersionId: referenced.versionId, sourceRange: range, sequenceRange: range,
      timeMapping: { kind: 'LINEAR', rate: { num: 1, den: 1 }, direction: 'FORWARD', preservePitch: true },
    });

    // 被引用的资产先进 Trash（排在队头），未引用的后进
    await softDeleteAsset(deps(), { workspaceId, assetId: referenced.assetId });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await softDeleteAsset(deps(), { workspaceId, assetId: free.assetId });

    const report = await runRetentionSweep(deps(), { now: new Date(Date.now() + 31 * DAY), limit: 1 });
    expect(report.assetsFailed).toBe(0);
    expect(report.assetsSkippedByReference).toBeGreaterThanOrEqual(1);
    expect(report.trashAssetsPurged).toBe(1);
    expect(await handle.db.select().from(assets).where(eq(assets.id, referenced.assetId))).toHaveLength(1);
    expect(await handle.db.select().from(assets).where(eq(assets.id, free.assetId))).toHaveLength(0);
    expect((await storage.probeObject(referenced.storageKey)).exists).toBe(true);
  });

  it('TTL 到期条件下推到 SQL：大量更早的永久类资产不会把到期缓存挤出扫描窗口', async () => {
    const { workspaceId } = await makeWorkspace();
    for (let index = 0; index < 6; index += 1) {
      await insertDraftRender(workspaceId, new Date(Date.now() - (200 - index) * DAY), 'KEEP_FINAL');
    }
    const expired = await insertDraftRender(workspaceId, new Date(Date.now() - 40 * DAY));
    const report = await runRetentionSweep(deps(), { now: new Date(), limit: 1 });
    expect(report.retentionAssetsPurged).toBe(1);
    expect(await handle.db.select().from(assets).where(eq(assets.id, expired))).toHaveLength(0);
    expect(await handle.db.select().from(assets).where(eq(assets.workspaceId, workspaceId))).toHaveLength(6);
  });

  it('版本快照引用按子串精确匹配：资产 id 中的 _ 不被当作 LIKE 通配符', async () => {
    const { workspaceId, projectId } = await makeWorkspace();
    const asset = await uploadReadyAsset(workspaceId, projectId, 43);
    // 一个只在"_ 位置不同"的快照：LIKE 会误判为引用，strpos 不会
    const lookalike = asset.assetId.replace('_', 'X');
    await createProjectVersion(deps(), { workspaceId, projectId, reason: 'MANUAL' });
    await handle.db.update(projectVersions).set({ snapshot: { note: lookalike } }).where(eq(projectVersions.projectId, projectId));
    await softDeleteAsset(deps(), { workspaceId, assetId: asset.assetId });
    const report = await runRetentionSweep(deps(), { now: new Date(Date.now() + 31 * DAY) });
    expect(report.trashAssetsPurged).toBe(1);
  });
});

