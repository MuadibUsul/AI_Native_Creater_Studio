import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { assetVersions, assets, createDb, redactDatabaseUrl, renders, resolveTestDatabaseUrl, runMigrations, workspaces, type DbHandle } from '@ancs/db';
import type { ArticleFetcher, LlmAdapter } from '@ancs/contracts';
import { MockLlmAdapter } from '@ancs/providers-mock-llm';
import { MockTtsAdapter } from '@ancs/providers-mock-tts';
import { LocalObjectStorage } from '@ancs/providers-storage-local';
import { buildServer } from './server.js';
import { createStorageDeps } from './plugins/storage.js';

/**
 * P07-06 验收（真实 DB + 真实本地存储 + 签名下载端点；**READY 渲染为夹具构造**——
 * 渲染/QA 链路的真实验证在 apps/worker 套件，本文件聚焦审批与受控导出的守卫与一致性）：
 * - **未批准不能正式导出**（409 NOT_APPROVED；驳回同理）；
 * - 批准绑定 manifestHash 快照 → 导出包四件（MP4/SRT/VTT/Manifest）签名 URL，**下载字节与 Manifest 一致**；
 * - 批准后 Render 的 manifestHash 变化 → 409 APPROVAL_STALE（需重新审批）；
 * - 非 READY 不可审批（409）；跨租户 404。
 */

const ARTICLE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>利率周报</title></head><body>
<h1>美联储利率决议</h1>
<p>联邦基金利率维持在 5.25% 不变。</p>
</body></html>`;

let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let storage: LocalObjectStorage;
let storageRoot: string;
let llm: MockLlmAdapter;
let tts: MockTtsAdapter;

class ScriptedFetcher implements ArticleFetcher {
  readonly kind = 'scripted';
  responses = new Map<string, { contentType: string | null; bytes: Uint8Array }>();
  async fetch(input: { url: string }): Promise<{ finalUrl: string; contentType: string | null; bytes: Uint8Array }> {
    const response = this.responses.get(input.url);
    if (response === undefined) throw new Error(`unreachable: ${input.url}`);
    return { finalUrl: input.url, contentType: response.contentType, bytes: response.bytes };
  }
}
const fetcher = new ScriptedFetcher();
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

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
  storageRoot = `${process.cwd()}/.artifacts/test-storage/approval-${randomUUID()}`;
  storage = new LocalObjectStorage({
    rootDir: storageRoot,
    publicBaseUrl: 'http://127.0.0.1:3999',
    signingSecret: 'approval-storage-secret-0123456789', // secrets:check-ignore：测试专用假密钥
  });
  auth = createAuth({
    db: handle.db,
    secret: 'approval-auth-secret-0123456789', // secrets:check-ignore：测试专用假密钥
    baseUrl: 'http://localhost:3001',
  });
  llm = new MockLlmAdapter();
  tts = new MockTtsAdapter();
  app = await buildServer({
    auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
    content: { articleFetcher: fetcher, llm: llm as LlmAdapter },
    audio: { tts },
    storage: createStorageDeps(storage),
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
  // 本地下载端点：签名 URL 指向 API 端口（构建后回填）
  storage.publicBaseUrl = baseUrl;
});

afterAll(async () => {
  await app.close();
  await handle.close();
});

beforeEach(async () => {
  await handle.db.delete(workspaces);
});

async function newClient(tag: string): Promise<AncsClient> {
  const email = `${tag}-${randomUUID()}@test.local`;
  await createInternalUser(auth, { email, password: 'password-1234', name: tag });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: 'password-1234' });
  return client;
}

/** 构造 READY 渲染夹具：真实 createRender（冻结输入）+ 直接写入产物资产与存储（渲染链路真实验证在 worker 套件）。 */
async function makeReadyRender(client: AncsClient): Promise<{ workspaceId: string; projectId: string; renderId: string; artifactBytes: Map<string, Uint8Array> }> {
  const workspace = await client.workspaces.create({ name: `审批-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '栏目' });
  const identity = await client.creatorIdentities.create(workspace.id, { displayName: '主播戊' });
  await client.creatorIdentities.update(workspace.id, identity.id, {
    voiceIdentity: { provider: 'mock-voice', providerVoiceId: 'vo_approval', cloneType: 'INSTANT', ownershipType: 'SELF_VERIFIED', managedMode: 'BYOK', languageProfile: 'zh-CN' },
  });
  await client.channels.update(workspace.id, channel.id, { defaults: { creatorIdentityId: identity.id } });
  const project = await client.projects.create(workspace.id, { title: '审批项目', channelId: channel.id });
  const url = `https://news.example/rates/${randomUUID()}`;
  fetcher.responses.set(url, { contentType: 'text/html; charset=utf-8', bytes: new TextEncoder().encode(ARTICLE_HTML) });
  const record = await client.content.create(workspace.id, project.id, { sourceType: 'URL_ARTICLE', url });
  await client.evidence.extract(workspace.id, project.id, record.document.id);
  llm.scriptNext('valid');
  const generated = await client.narrative.generate(workspace.id, project.id, record.document.id, { targetDurationMs: 6000 });
  await client.narrative.applyDirectorPlan(workspace.id, project.id, generated.plan.id, { idempotencyKey: `idem_ap_${randomUUID()}` });
  await client.narrative.synthesizeMasterNarration(workspace.id, project.id, generated.plan.id);
  const render = await client.renders.create(workspace.id, project.id, { profile: 'DRAFT_720' });

  // 产物字节（fixture）+ 存储 + 资产行 + Render=READY
  const artifactBytes = new Map<string, Uint8Array>([
    ['VIDEO', new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 102, 97, 107, 101])],
    ['SUBTITLE_SRT', new TextEncoder().encode('1\n00:00:00,000 --> 00:00:03,000\n利率周报\n')],
    ['SUBTITLE_VTT', new TextEncoder().encode('WEBVTT\n\n00:00:00.000 --> 00:00:03.000\n利率周报\n')],
  ]);
  // Manifest（与产物清单一致——导出与 Manifest 一致性的证据）
  const outputs = [
    { kind: 'VIDEO' as const, fileName: 'final.mp4', sha256: sha(artifactBytes.get('VIDEO') as Uint8Array) },
    { kind: 'SUBTITLE_SRT' as const, fileName: 'subtitles.srt', sha256: sha(artifactBytes.get('SUBTITLE_SRT') as Uint8Array) },
    { kind: 'SUBTITLE_VTT' as const, fileName: 'subtitles.vtt', sha256: sha(artifactBytes.get('SUBTITLE_VTT') as Uint8Array) },
  ];
  const manifestBytes = new TextEncoder().encode(
    JSON.stringify(
      { schemaVersion: 'manifest-v1', projectId: project.id, projectVersionId: render.input.projectVersionId, outputs, createdAt: '2026-10-05T10:00:00.000Z' },
      null,
      2,
    ),
  );
  artifactBytes.set('MANIFEST', manifestBytes);

  const mimeByKind: Record<string, string> = { VIDEO: 'video/mp4', SUBTITLE_SRT: 'application/x-subrip', SUBTITLE_VTT: 'text/vtt', MANIFEST: 'application/json' };
  const assetIds: string[] = [];
  for (const [kind, bytes] of artifactBytes) {
    const assetId = `ast_${randomUUID()}`;
    const versionId = `av_${randomUUID()}`;
    const storageKey = `workspaces/${workspace.id}/projects/${project.id}/renders/${render.id}/${kind === 'VIDEO' ? 'final.mp4' : kind === 'MANIFEST' ? 'manifest.json' : kind === 'SUBTITLE_SRT' ? 'subtitles.srt' : 'subtitles.vtt'}`;
    await storage.putObject(storageKey, bytes);
    await handle.db.insert(assets).values({
      id: assetId,
      workspaceId: workspace.id,
      projectId: project.id,
      assetType: kind === 'VIDEO' ? 'DRAFT_RENDER' : kind === 'MANIFEST' ? 'MANIFEST' : 'SUBTITLE',
      origin: 'SYSTEM_RENDER',
      status: 'READY',
      retentionClass: 'KEEP_FINAL',
      license: { type: 'SYSTEM_GENERATED', holder: null, attribution: null, sourceUrl: null, termsUrl: null, notes: 'fixture', confirmedBy: null, confirmedAt: null },
      metadata: { renderId: render.id, kind },
      currentVersionId: versionId,
    });
    await handle.db.insert(assetVersions).values({
      id: versionId,
      assetId,
      workspaceId: workspace.id,
      versionNumber: 1,
      storageKey,
      mimeType: mimeByKind[kind] ?? 'application/octet-stream',
      sizeBytes: bytes.byteLength,
      checksumSha256: sha(bytes),
      status: 'READY',
      metadata: { renderId: render.id, kind },
    });
    assetIds.push(assetId);
  }
  const manifestHash = sha(manifestBytes);
  await handle.db
    .update(renders)
    .set({ status: 'READY', manifestHash, outputAssetIds: assetIds, updatedAt: new Date() })
    .where(eq(renders.id, render.id));

  return { workspaceId: workspace.id, projectId: project.id, renderId: render.id, artifactBytes };
}

describe('审批与受控导出（P07-06）', () => {
  it('未批准不能导出（409）；批准绑定 manifestHash → 导出四件签名 URL，**下载字节与 Manifest 一致**', async () => {
    const client = await newClient('approval-flow');
    const { workspaceId, renderId, artifactBytes } = await makeReadyRender(client);

    // 1) 未批准（无记录）→ 409 NOT_APPROVED
    const before = await client.renders.exportPackage(workspaceId, renderId).catch((error: unknown) => error);
    expect(before).toBeInstanceOf(AncsApiError);
    expect((before as AncsApiError).status).toBe(409);
    expect((before as AncsApiError).details['reason']).toBe('NOT_APPROVED');
    expect(await client.renders.approval(workspaceId, renderId)).toBeNull();

    // 2) 批准（绑定 manifestHash 快照）
    const approval = await client.renders.decideApproval(workspaceId, renderId, { decision: 'APPROVED', note: '金样批准' });
    expect(approval.decision).toBe('APPROVED');
    expect(approval.manifestHashAtApproval).toMatch(/^[0-9a-f]{64}$/);
    expect(approval.note).toBe('金样批准');

    // 3) 导出：四件 + 签名 URL（TTL）
    const bundle = await client.renders.exportPackage(workspaceId, renderId);
    expect(bundle.manifestHash).toBe(approval.manifestHashAtApproval);
    expect(bundle.approvalId).toBe(approval.id);
    expect(bundle.entries.map((entry) => entry.kind).sort()).toEqual(['MANIFEST', 'SUBTITLE_SRT', 'SUBTITLE_VTT', 'VIDEO']);

    // 4) 受控下载可用且与 Manifest 一致（真实下载 → 字节哈希对照 manifest.outputs）
    const fetched = new Map<string, Uint8Array>();
    for (const entry of bundle.entries) {
      const response = await fetch(entry.download.url);
      expect(response.status, `${entry.kind} 下载应成功`).toBe(200);
      fetched.set(entry.kind, new Uint8Array(await response.arrayBuffer()));
    }
    const manifest = JSON.parse(new TextDecoder().decode(fetched.get('MANIFEST') as Uint8Array)) as { outputs: { kind: string; sha256: string }[]; projectVersionId: string };
    expect(manifest.projectVersionId).toBe(bundle.projectVersionId);
    for (const output of manifest.outputs) {
      const bytes = fetched.get(output.kind);
      expect(bytes, `${output.kind} 下载字节存在`).toBeDefined();
      expect(sha(bytes as Uint8Array), `${output.kind} 与 Manifest sha256 一致`).toBe(output.sha256);
    }
    for (const [kind, bytes] of artifactBytes) {
      expect(sha(fetched.get(kind) as Uint8Array), `${kind} 与夹具一致`).toBe(sha(bytes));
    }
  });

  it('批准后 manifest 变化 → 409 APPROVAL_STALE（需重新审批）；重新批准恢复导出', async () => {
    const client = await newClient('approval-stale');
    const { workspaceId, renderId } = await makeReadyRender(client);
    await client.renders.decideApproval(workspaceId, renderId, { decision: 'APPROVED' });

    // 篡改 manifestHash（模拟批准后重渲/不一致）
    await handle.db.update(renders).set({ manifestHash: 'a'.repeat(64) }).where(eq(renders.id, renderId));
    const stale = await client.renders.exportPackage(workspaceId, renderId).catch((error: unknown) => error);
    expect(stale).toBeInstanceOf(AncsApiError);
    expect((stale as AncsApiError).status).toBe(409);
    expect((stale as AncsApiError).details['reason']).toBe('APPROVAL_STALE');

    // 重新批准（快照新 hash）→ 导出恢复
    const reapproval = await client.renders.decideApproval(workspaceId, renderId, { decision: 'APPROVED', note: '重渲后重新批准' });
    expect(reapproval.manifestHashAtApproval).toBe('a'.repeat(64));
    const bundle = await client.renders.exportPackage(workspaceId, renderId);
    expect(bundle.manifestHash).toBe('a'.repeat(64));
  });

  it('驳回后不能导出；非 READY 不可审批；跨租户 404', async () => {
    const client = await newClient('approval-guards');
    const { workspaceId, projectId, renderId } = await makeReadyRender(client);

    // 驳回 → 导出被阻止（决策为 REJECTED）
    const rejected = await client.renders.decideApproval(workspaceId, renderId, { decision: 'REJECTED', note: '需修改' });
    expect(rejected.decision).toBe('REJECTED');
    const blocked = await client.renders.exportPackage(workspaceId, renderId).catch((error: unknown) => error);
    expect((blocked as AncsApiError).status).toBe(409);
    expect((blocked as AncsApiError).details['reason']).toBe('NOT_APPROVED');

    // 非 READY（QUEUED）不可审批
    const queued = await client.renders.create(workspaceId, projectId, { profile: 'DRAFT_720' });
    const notReady = await client.renders.decideApproval(workspaceId, queued.id, { decision: 'APPROVED' }).catch((error: unknown) => error);
    expect(notReady).toBeInstanceOf(AncsApiError);
    expect((notReady as AncsApiError).status).toBe(409);
    expect((notReady as AncsApiError).details['reason']).toBe('RENDER_NOT_READY');

    // 跨租户：审批/导出/读取 → 404
    const intruder = await newClient('approval-intruder');
    const crossed = await intruder.renders.decideApproval(workspaceId, renderId, { decision: 'APPROVED' }).catch((error: unknown) => error);
    expect(crossed).toBeInstanceOf(AncsApiError);
    expect((crossed as AncsApiError).status).toBe(404);
    const crossExport = await intruder.renders.exportPackage(workspaceId, renderId).catch((error: unknown) => error);
    expect(crossExport).toBeInstanceOf(AncsApiError);
    expect((crossExport as AncsApiError).status).toBe(404);
  });
});
