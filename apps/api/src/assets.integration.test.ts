import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { LocalObjectStorage } from '@ancs/providers-storage-local';
import {
  createDb,
  assetVersions,
  assets,
  redactDatabaseUrl,
  resolveTestDatabaseUrl,
  runMigrations,
  uploadIntents,
  workspaces,
  type DbHandle,
} from '@ancs/db';
import {
  addScene,
  assertAssetBindable,
  buildStorageKey,
  confirmUpload,
  createAssetDownloadUrl,
  createChannel,
  createProject,
  createUploadIntent,
  getAsset,
  listAssets,
  processEdits,
  redoProject,
  undoProject,
  type DomainDeps,
} from '@ancs/domain';

/**
 * P02-04 验收（服务层，真实本地存储）：
 * - 上传意图 → 直传 → 确认（真实探测：存在性/大小/SHA-256/内容嗅探）；
 * - 重复确认幂等；**伪造 MIME、越权对象、不完整上传不可 Ready**；
 * - workspace 内哈希去重（意图阶段与确认阶段）；意图过期；
 * - replace_asset 绑定 / 解绑 / 撤销（版本与账本不改写）。
 */

let handle: DbHandle;
let rootDir: string;
let storage: LocalObjectStorage;

const deps = (): DomainDeps => ({ db: handle.db, storage });

/** 可构造真实 PNG（签名 + IHDR 尺寸），用于内容嗅探与尺寸探测 */
function makePng(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  bytes[16] = (width >> 24) & 0xff;
  bytes[17] = (width >> 16) & 0xff;
  bytes[18] = (width >> 8) & 0xff;
  bytes[19] = width & 0xff;
  bytes[20] = (height >> 24) & 0xff;
  bytes[21] = (height >> 16) & 0xff;
  bytes[22] = (height >> 8) & 0xff;
  bytes[23] = height & 0xff;
  bytes[24] = 8;
  bytes[25] = 2;
  return bytes;
}

const sha256 = async (data: Uint8Array): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
};

beforeAll(async () => {
  const url = resolveTestDatabaseUrl();
  handle = createDb(url);
  try {
    await handle.pool.query('select 1');
  } catch (error) {
    await handle.close();
    throw new Error(`无法连接测试数据库 ${redactDatabaseUrl(url)}。请先运行 infra/docker-compose.dev.yml。`, { cause: error });
  }
  await runMigrations(handle);
  rootDir = await mkdtemp(join(tmpdir(), 'ancs-assets-'));
  storage = new LocalObjectStorage({
    rootDir,
    publicBaseUrl: 'http://127.0.0.1:3999',
    signingSecret: 'assets-integration-secret-0123456789', // secrets:check-ignore：测试专用假密钥
  });
});

afterAll(async () => {
  await handle.close();
  await rm(rootDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await handle.db.delete(workspaces);
});

async function makeWorkspace(name = '资产租户'): Promise<{ workspaceId: string; projectId: string; channelId: string }> {
  const workspaceId = `ws_${randomUUID()}`;
  await handle.db.insert(workspaces).values({ id: workspaceId, name });
  const channel = await createChannel(deps(), { workspaceId, input: { name: '栏目' } });
  const project = await createProject(deps(), { workspaceId, input: { title: '资产项目', channelId: channel.id } });
  return { workspaceId, projectId: project.id, channelId: channel.id };
}

/** 走完整链路：意图 → 直传（adapter 写入）→ 确认 */
async function uploadAsset(
  input: { workspaceId: string; projectId?: string | null; assetType?: 'USER_UPLOAD' | 'SOURCE_IMAGE'; bytes?: Uint8Array; contentType?: string; declareChecksum?: boolean },
) {
  const bytes = input.bytes ?? makePng(640, 360);
  const checksumSha256 = input.declareChecksum === true ? await sha256(bytes) : undefined;
  const intent = await createUploadIntent(deps(), {
    workspaceId: input.workspaceId,
    userId: null,
    input: {
      assetType: input.assetType ?? 'USER_UPLOAD',
      filename: 'cover.png',
      contentType: input.contentType ?? 'image/png',
      sizeBytes: bytes.byteLength,
      projectId: input.projectId ?? null,
      ...(checksumSha256 !== undefined ? { checksumSha256 } : {}),
    },
  });
  if (intent.upload === null) throw new Error('unexpected dedupe');
  const payload = storage.verifyToken(new URL(intent.upload.url).searchParams.get('token') ?? '', 'upload');
  if (payload === null) throw new Error('token 校验失败');
  await storage.writeObject(payload.key, bytes);
  return { intent, bytes, checksumSha256 };
}

describe('资产上传链路（§26.1：意图 → 直传 → 确认）', () => {
  it('确认后 Ready：真实探测大小/SHA-256/尺寸；版本不可变；下载 URL 带 TTL', async () => {
    const { workspaceId, projectId } = await makeWorkspace();
    const { intent } = await uploadAsset({ workspaceId, projectId, declareChecksum: true });

    const detail = await confirmUpload(deps(), { workspaceId, assetId: intent.asset.id, input: {} });
    expect(detail.status).toBe('READY');
    expect(detail.retentionClass).toBe('KEEP_USER_SOURCE');
    expect(detail.license.type).toBe('USER_OWNED');
    expect(detail.versions).toHaveLength(1);
    const version = detail.versions[0];
    expect(version?.status).toBe('READY');
    expect(version?.sizeBytes).toBe(33);
    expect(version?.checksumSha256).not.toBeNull();
    expect(version?.checksumSha256 ?? '').toMatch(/^[a-f0-9]{64}$/);
    expect(version?.width).toBe(640);
    expect(version?.height).toBe(360);
    expect(version?.storageKey).toBe(
      buildStorageKey({ workspaceId, projectId, assetType: 'USER_UPLOAD', assetId: intent.asset.id, versionNumber: 1, filename: 'cover.png' }),
    );
    // 探测结果记录在版本元数据（可审计）
    expect(version?.metadata['probed']).toMatchObject({ mimeType: 'image/png', width: 640, height: 360 });

    // 下载 Signed URL（短 TTL；scope=purpose download）
    const download = await createAssetDownloadUrl(deps(), { workspaceId, assetId: intent.asset.id });
    const token = new URL(download.url).searchParams.get('token') ?? '';
    expect(storage.verifyToken(token, 'download')).not.toBeNull();
    expect(storage.verifyToken(token, 'upload')).toBeNull();
    expect(new Date(download.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // 未就绪资产不可下载：新建一个未确认的资产
    const pending = await createUploadIntent(deps(), {
      workspaceId,
      userId: null,
      input: { assetType: 'USER_UPLOAD', filename: 'x.png', contentType: 'image/png', sizeBytes: 10, projectId: null },
    });
    await expect(createAssetDownloadUrl(deps(), { workspaceId, assetId: pending.asset.id })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('重复确认幂等：不产生新版本/新副作用，返回一致结果', async () => {
    const { workspaceId, projectId } = await makeWorkspace();
    const { intent } = await uploadAsset({ workspaceId, projectId, declareChecksum: true });

    const first = await confirmUpload(deps(), { workspaceId, assetId: intent.asset.id, input: {} });
    const second = await confirmUpload(deps(), { workspaceId, assetId: intent.asset.id, input: {} });
    expect(second.status).toBe('READY');
    expect(second.versions).toHaveLength(1);
    expect(JSON.stringify(second.versions)).toBe(JSON.stringify(first.versions));

    const intents = await handle.db.select().from(uploadIntents).where(eq(uploadIntents.assetId, intent.asset.id));
    expect(intents.filter((row) => row.status === 'COMPLETED')).toHaveLength(1);
    expect(await handle.db.select().from(assetVersions).where(eq(assetVersions.assetId, intent.asset.id))).toHaveLength(1);
  });

  it('伪造 MIME：声明 image/png 实际为文本 → 415、资产与版本 FAILED、对象删除', async () => {
    const { workspaceId, projectId } = await makeWorkspace();
    const textBytes = new TextEncoder().encode('这不是 PNG 内容');
    const { intent } = await uploadAsset({ workspaceId, projectId, bytes: textBytes, contentType: 'image/png' });

    const failure = await confirmUpload(deps(), { workspaceId, assetId: intent.asset.id, input: {} }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE', httpStatus: 415 });
    expect((failure as { details?: Record<string, unknown> }).details).toMatchObject({ declaredMimeType: 'image/png', sniffedMimeType: null });

    const detail = await getAsset(deps(), { workspaceId, assetId: intent.asset.id });
    expect(detail.status).toBe('FAILED');
    expect(detail.versions[0]?.status).toBe('FAILED');
    // 伪造对象已被清理（不留存不可信内容）
    const key = detail.versions[0]?.storageKey ?? '';
    expect((await storage.probeObject(key)).exists).toBe(false);
    // 再次确认仍拒绝（不因重试变 Ready）
    await expect(confirmUpload(deps(), { workspaceId, assetId: intent.asset.id, input: {} })).rejects.toMatchObject({ httpStatus: 409 });
  });

  it('不完整上传（实际字节数 < 声明）：409 SIZE_MISMATCH，保持待上传可重试', async () => {
    const { workspaceId, projectId } = await makeWorkspace();
    const bytes = makePng(100, 100);
    const intent = await createUploadIntent(deps(), {
      workspaceId,
      userId: null,
      input: {
        assetType: 'USER_UPLOAD',
        filename: 'partial.png',
        contentType: 'image/png',
        sizeBytes: bytes.byteLength + 500, // 声明更大
        projectId,
      },
    });
    const payload = storage.verifyToken(new URL(intent.upload?.url ?? '').searchParams.get('token') ?? '', 'upload');
    await storage.writeObject(payload?.key ?? '', bytes);

    const failure = await confirmUpload(deps(), { workspaceId, assetId: intent.asset.id, input: {} }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'PRECONDITION_FAILED', httpStatus: 409 });
    expect((failure as { details?: Record<string, unknown> }).details).toMatchObject({ reason: 'SIZE_MISMATCH', expectedSizeBytes: 533, actualSizeBytes: 33 });
    const detail = await getAsset(deps(), { workspaceId, assetId: intent.asset.id });
    expect(detail.status).toBe('PENDING_UPLOAD'); // 未 Ready，可重新上传后确认
  });

  it('对象缺失（未直传就确认）：409 OBJECT_MISSING', async () => {
    const { workspaceId } = await makeWorkspace();
    const intent = await createUploadIntent(deps(), {
      workspaceId,
      userId: null,
      input: { assetType: 'USER_UPLOAD', filename: 'never-uploaded.png', contentType: 'image/png', sizeBytes: 33, projectId: null },
    });
    const failure = await confirmUpload(deps(), { workspaceId, assetId: intent.asset.id, input: {} }).catch((error: unknown) => error);
    expect((failure as { details?: Record<string, unknown> }).details).toMatchObject({ reason: 'OBJECT_MISSING' });
  });

  it('校验和不符 → 409 CHECKSUM_MISMATCH 且标记 FAILED、删除对象', async () => {
    const { workspaceId } = await makeWorkspace();
    const bytes = makePng(50, 50);
    const intent = await createUploadIntent(deps(), {
      workspaceId,
      userId: null,
      input: {
        assetType: 'USER_UPLOAD',
        filename: 'bad-sum.png',
        contentType: 'image/png',
        sizeBytes: bytes.byteLength,
        projectId: null,
        checksumSha256: 'f'.repeat(64), // 预声明错误的校验和
      },
    });
    const payload = storage.verifyToken(new URL(intent.upload?.url ?? '').searchParams.get('token') ?? '', 'upload');
    await storage.writeObject(payload?.key ?? '', bytes);

    const failure = await confirmUpload(deps(), { workspaceId, assetId: intent.asset.id, input: {} }).catch((error: unknown) => error);
    expect((failure as { details?: Record<string, unknown> }).details).toMatchObject({ reason: 'CHECKSUM_MISMATCH' });
    const detail = await getAsset(deps(), { workspaceId, assetId: intent.asset.id });
    expect(detail.status).toBe('FAILED');
    expect((await storage.probeObject(detail.versions[0]?.storageKey ?? '')).exists).toBe(false);
  });

  it('意图过期：确认 409 INTENT_EXPIRED（记录 EXPIRED），对象不被标记 Ready', async () => {
    const { workspaceId } = await makeWorkspace();
    const expiredDeps: DomainDeps = { db: handle.db, storage, uploadIntentTtlSeconds: -5 };
    const bytes = makePng(10, 10);
    const intent = await createUploadIntent(expiredDeps, {
      workspaceId,
      userId: null,
      input: { assetType: 'USER_UPLOAD', filename: 'old.png', contentType: 'image/png', sizeBytes: bytes.byteLength, projectId: null },
    });
    const payload = storage.verifyToken(new URL(intent.upload?.url ?? '').searchParams.get('token') ?? '', 'upload');
    // 过期 token 已不可用（上传端吊销）；但对象模拟此前已上传完成
    expect(payload).toBeNull();
    await storage.writeObject(
      buildStorageKey({ workspaceId, projectId: null, assetType: 'USER_UPLOAD', assetId: intent.asset.id, versionNumber: 1, filename: 'old.png' }),
      bytes,
    );

    const failure = await confirmUpload(expiredDeps, { workspaceId, assetId: intent.asset.id, input: {} }).catch((error: unknown) => error);
    expect((failure as { details?: Record<string, unknown> }).details).toMatchObject({ reason: 'INTENT_EXPIRED' });
    const intentRows = await handle.db.select().from(uploadIntents).where(eq(uploadIntents.assetId, intent.asset.id));
    expect(intentRows[0]?.status).toBe('EXPIRED');
  });

  it('workspace 内哈希去重：意图阶段命中（不创建对象）；确认阶段命中（复用对象并清理冗余）', async () => {
    const { workspaceId, projectId } = await makeWorkspace();
    const bytes = makePng(320, 180);
    const { intent: first } = await uploadAsset({ workspaceId, projectId, bytes, declareChecksum: true });
    await confirmUpload(deps(), { workspaceId, assetId: first.asset.id, input: {} });

    // 意图阶段：相同 checksum → deduped，无直传目标
    const second = await createUploadIntent(deps(), {
      workspaceId,
      userId: null,
      input: {
        assetType: 'USER_UPLOAD',
        filename: 'same-content.png',
        contentType: 'image/png',
        sizeBytes: bytes.byteLength,
        projectId,
        checksumSha256: await sha256(bytes),
      },
    });
    expect(second.deduped).toBe(true);
    expect(second.upload).toBeNull();
    expect(second.asset.id).toBe(first.asset.id);

    // 确认阶段：客户端未提供 checksum 的重复内容 → 确认后复用既有对象并删除本次上传
    const third = await createUploadIntent(deps(), {
      workspaceId,
      userId: null,
      input: { assetType: 'USER_UPLOAD', filename: 'same-content-2.png', contentType: 'image/png', sizeBytes: bytes.byteLength, projectId },
    });
    const thirdUpload = third.upload;
    const payload = storage.verifyToken(new URL(thirdUpload?.url ?? '').searchParams.get('token') ?? '', 'upload');
    await storage.writeObject(payload?.key ?? '', bytes);
    const thirdDetail = await confirmUpload(deps(), { workspaceId, assetId: third.asset.id, input: {} });
    expect(thirdDetail.status).toBe('READY');
    expect(thirdDetail.metadata['deduplicatedFrom']).toBe(first.asset.id);
    expect(thirdDetail.versions[0]?.storageKey).toBe((await getAsset(deps(), { workspaceId, assetId: first.asset.id })).versions[0]?.storageKey);
    expect((await storage.probeObject(payload?.key ?? '')).exists).toBe(false); // 冗余对象已清理
  });

  it('越权对象与跨租户：他人资产不可见（404）；绑定校验拒绝未就绪/跨项目资产', async () => {
    const a = await makeWorkspace('A 租户');
    const b = await makeWorkspace('B 租户');
    const { intent } = await uploadAsset({ workspaceId: a.workspaceId, projectId: a.projectId, declareChecksum: true });

    // 跨 workspace：get / confirm / download 全部 404（抗枚举）
    await expect(getAsset(deps(), { workspaceId: b.workspaceId, assetId: intent.asset.id })).rejects.toMatchObject({ httpStatus: 404 });
    await expect(confirmUpload(deps(), { workspaceId: b.workspaceId, assetId: intent.asset.id, input: {} })).rejects.toMatchObject({ httpStatus: 404 });
    await expect(createAssetDownloadUrl(deps(), { workspaceId: b.workspaceId, assetId: intent.asset.id })).rejects.toMatchObject({ httpStatus: 404 });
    expect(await listAssets(deps(), { workspaceId: b.workspaceId })).toHaveLength(0);

    // 未就绪资产不可绑定
    await expect(
      assertAssetBindable(deps(), { workspaceId: a.workspaceId, assetId: intent.asset.id, projectId: a.projectId }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    const detail = await confirmUpload(deps(), { workspaceId: a.workspaceId, assetId: intent.asset.id, input: {} });
    expect(detail.status).toBe('READY');
    // 项目归属不匹配 → 拒绝
    await expect(
      assertAssetBindable(deps(), { workspaceId: a.workspaceId, assetId: intent.asset.id, projectId: b.projectId }),
    ).rejects.toMatchObject({ httpStatus: 409 });
  });

  it('不支持直传的资产类型 → 501；MIME 组合不在白名单 → 415；生成类资产不可直传', async () => {
    const { workspaceId } = await makeWorkspace();
    await expect(
      createUploadIntent(deps(), {
        workspaceId,
        userId: null,
        input: { assetType: 'GENERATED_VIDEO', filename: 'gen.mp4', contentType: 'video/mp4', sizeBytes: 100, projectId: null },
      }),
    ).rejects.toMatchObject({ httpStatus: 501 });
    await expect(
      createUploadIntent(deps(), {
        workspaceId,
        userId: null,
        input: { assetType: 'SOURCE_DOCUMENT', filename: 'x.mp4', contentType: 'video/mp4', sizeBytes: 100, projectId: null },
      }),
    ).rejects.toMatchObject({ httpStatus: 415 });
  });
});

describe('replace_asset：Scene 绑定与撤销（§4.6 / §23）', () => {
  it('绑定 → 解绑 → 撤销/重做；资产未就绪拒绝；事件与 revision 正确', async () => {
    const { workspaceId, projectId } = await makeWorkspace();
    const { intent, checksumSha256 } = await uploadAsset({ workspaceId, projectId, declareChecksum: true });
    await confirmUpload(deps(), { workspaceId, assetId: intent.asset.id, input: { checksumSha256 } });

    const scene = await addScene(deps(), {
      workspaceId,
      projectId,
      input: { sceneType: 'HOST_FULL', semanticType: 'HOST_STATEMENT', durationMs: 5000 },
    });
    const sceneId = scene.scene.id;
    const actor = { type: 'USER' as const, id: 'u_assets' };

    const bind = await processEdits(deps(), {
      workspaceId,
      projectId,
      actor,
      request: {
        baseProjectRevision: scene.project.revision,
        expectedSceneRevisions: { [sceneId]: 1 },
        operations: [{ op: 'replace_asset', sceneId, role: 'visual', newAssetId: intent.asset.id }],
        idempotencyKey: `idem_asset_bind_${randomUUID()}`,
      },
    });
    expect(bind.response.scenes[0]?.assetBindings).toEqual([{ assetId: intent.asset.id, role: 'visual' }]);
    expect(bind.response.scenes[0]?.revision).toBe(2);
    expect(bind.response.editEvents[0]?.action).toBe('REPLACE_ASSET');

    // 未就绪资产不可绑定
    const pending = await createUploadIntent(deps(), {
      workspaceId,
      userId: null,
      input: { assetType: 'USER_UPLOAD', filename: 'p.png', contentType: 'image/png', sizeBytes: 33, projectId: null },
    });
    const rejected = await processEdits(deps(), {
      workspaceId,
      projectId,
      actor,
      request: {
        baseProjectRevision: bind.response.project.revision,
        expectedSceneRevisions: { [sceneId]: 2 },
        operations: [{ op: 'replace_asset', sceneId, role: 'visual', newAssetId: pending.asset.id }],
        idempotencyKey: `idem_asset_bind_bad_${randomUUID()}`,
      },
    }).catch((error: unknown) => error);
    expect(rejected).toMatchObject({ code: 'PRECONDITION_FAILED', httpStatus: 409 });

    // 解绑（newAssetId = null）
    const unbind = await processEdits(deps(), {
      workspaceId,
      projectId,
      actor,
      request: {
        baseProjectRevision: bind.response.project.revision,
        expectedSceneRevisions: { [sceneId]: 2 },
        operations: [{ op: 'replace_asset', sceneId, role: 'visual', newAssetId: null }],
        idempotencyKey: `idem_asset_unbind_${randomUUID()}`,
      },
    });
    expect(unbind.response.scenes[0]?.assetBindings).toEqual([]);

    // 撤销解绑 → 恢复绑定（身份稳定）
    const undo = await undoProject(deps(), { workspaceId, projectId, actor });
    expect(undo.response.scenes[0]?.assetBindings).toEqual([{ assetId: intent.asset.id, role: 'visual' }]);
    expect(undo.response.editEvents[0]?.action).toBe('UNDO_REPLACE_ASSET');
    // 重做 → 再次解绑
    const redo = await redoProject(deps(), { workspaceId, projectId, actor });
    expect(redo.response.scenes[0]?.assetBindings).toEqual([]);
  });

  it('restore_project_version 一并还原资产绑定（快照含 assetBindings）', async () => {
    const { workspaceId, projectId } = await makeWorkspace();
    const { intent, checksumSha256 } = await uploadAsset({ workspaceId, projectId, declareChecksum: true });
    await confirmUpload(deps(), { workspaceId, assetId: intent.asset.id, input: { checksumSha256 } });
    const scene = await addScene(deps(), {
      workspaceId,
      projectId,
      input: { sceneType: 'HOST_FULL', semanticType: 'HOST_STATEMENT', durationMs: 5000 },
    });
    const sceneId = scene.scene.id;
    const actor = { type: 'USER' as const, id: 'u_assets' };

    const { createProjectVersion, getProjectVersion } = await import('@ancs/domain');
    const bind = await processEdits(deps(), {
      workspaceId,
      projectId,
      actor,
      request: {
        baseProjectRevision: scene.project.revision,
        expectedSceneRevisions: { [sceneId]: 1 },
        operations: [{ op: 'replace_asset', sceneId, role: 'visual', newAssetId: intent.asset.id }],
        idempotencyKey: `idem_snap_bind_${randomUUID()}`,
      },
    });
    const version = await createProjectVersion(deps(), { workspaceId, projectId, reason: 'MANUAL' });
    const detail = await getProjectVersion(deps(), { workspaceId, projectId, versionId: version.id });
    expect(detail.snapshot.graph.scenes[0]?.assetBindings).toEqual([{ assetId: intent.asset.id, role: 'visual' }]);

    // 解绑后恢复快照 → 绑定回来
    await processEdits(deps(), {
      workspaceId,
      projectId,
      actor,
      request: {
        baseProjectRevision: bind.response.project.revision,
        expectedSceneRevisions: { [sceneId]: 2 },
        operations: [{ op: 'replace_asset', sceneId, role: 'visual', newAssetId: null }],
        idempotencyKey: `idem_snap_unbind_${randomUUID()}`,
      },
    });
    const current = await handle.db.select().from(assets).where(eq(assets.id, intent.asset.id));
    expect(current).toHaveLength(1);
    const restored = await processEdits(deps(), {
      workspaceId,
      projectId,
      actor,
      request: {
        baseProjectRevision: bind.response.project.revision + 1,
        expectedSceneRevisions: {},
        operations: [{ op: 'restore_project_version', versionId: version.id }],
        idempotencyKey: `idem_snap_restore_${randomUUID()}`,
      },
    });
    expect(restored.response.scenes[0]?.assetBindings).toEqual([{ assetId: intent.asset.id, role: 'visual' }]);
  });
});
