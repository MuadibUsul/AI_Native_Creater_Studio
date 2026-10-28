import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { assetVersions, createDb, resolveTestDatabaseUrl, runMigrations, workspaces, type DbHandle } from '@ancs/db';
import { LocalObjectStorage } from '@ancs/providers-storage-local';
import { confirmUpload, createStudioProject, createUploadIntent, defaultAgentToolCatalog, getStudioState, type AgentToolContext, type DomainDeps } from '@ancs/domain';

/**
 * 图片素材不需要媒体探测（probeStatus = NOT_REQUIRED）：上传确认后在共看片室里就是"就绪"，
 * AI 的素材清单也不能把它永远算成"还在处理"（否则画面一直转圈、交给 AI 剪完一直等到超时）。真实 PostgreSQL。
 */

let handle: DbHandle;
let storageRoot: string;
let storage: LocalObjectStorage;
const deps = (): DomainDeps => ({ db: handle.db, storage });
const created: string[] = [];
// 1×1 PNG
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a2dd2b9e0000000049454e44ae426082', 'hex');

beforeAll(async () => {
  handle = createDb(resolveTestDatabaseUrl());
  await runMigrations(handle);
  storageRoot = await mkdtemp(join(tmpdir(), 'ancs-footage-ready-'));
  storage = new LocalObjectStorage({ rootDir: storageRoot, publicBaseUrl: 'http://127.0.0.1:3999', signingSecret: `footage-ready-${randomUUID()}` }); // secrets:check-ignore：测试专用假值
});
afterAll(async () => {
  for (const id of created) await handle.db.delete(workspaces).where(eq(workspaces.id, id));
  await handle.close();
  await rm(storageRoot, { recursive: true, force: true });
});

describe('图片素材的就绪状态', () => {
  it('上传确认后：共看片室显示就绪；AI 的素材清单不报"还在处理"', async () => {
    const workspaceId = `ws_${randomUUID()}`;
    await handle.db.insert(workspaces).values({ id: workspaceId, name: '图片素材' });
    created.push(workspaceId);
    const project = await createStudioProject(deps(), { workspaceId, request: { title: '封面', aspectRatio: '16:9', locale: 'en' } });
    const checksumSha256 = createHash('sha256').update(PNG).digest('hex');
    const intent = await createUploadIntent(deps(), { workspaceId, userId: null, input: { assetType: 'USER_UPLOAD', filename: 'cover.png', contentType: 'image/png', sizeBytes: PNG.byteLength, checksumSha256, projectId: project.projectId } });
    const version = (await handle.db.select().from(assetVersions).where(eq(assetVersions.assetId, intent.asset.id)).limit(1))[0]!;
    await storage.putObject(version.storageKey, PNG);
    await confirmUpload(deps(), { workspaceId, assetId: intent.asset.id, input: { checksumSha256 } });
    expect((await handle.db.select().from(assetVersions).where(eq(assetVersions.id, version.id)))[0]).toMatchObject({ probeStatus: 'NOT_REQUIRED', mediaProbe: null });

    const state = await getStudioState(deps(), { workspaceId, projectId: project.projectId });
    expect(state.footage).toEqual([expect.objectContaining({ name: 'cover.png', kind: 'image', status: 'READY', footageId: version.id })]);

    const context: AgentToolContext = { deps: deps(), workspaceId, projectId: project.projectId, sequenceId: state.sequenceId, actorId: 'agent', locale: 'en', draft: { baseRevision: state.project.revision, operations: [] } };
    const listed = JSON.parse((await defaultAgentToolCatalog().get('list_footage')!.run(context, {})).content) as { stillProcessing?: number };
    expect(listed.stillProcessing).toBeUndefined();
  });
});
