import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { assetVersions, assets, createDb, plans, projectSources, projectVersions, redactDatabaseUrl, renders, resolveTestDatabaseUrl, runMigrations, workspaces, type DbHandle } from '@ancs/db';
import { ensureDefaultPlans, type DomainDeps } from '@ancs/domain';
import { MockLlmAdapter } from '@ancs/providers-mock-llm';
import { MockTtsAdapter } from '@ancs/providers-mock-tts';
import { LocalObjectStorage } from '@ancs/providers-storage-local';
import type { ArticleFetcher } from '@ancs/contracts';
import { buildServer } from './server.js';
import { createStorageDeps } from './plugins/storage.js';

/**
 * P10-05 验收（真实 DB + 真实存储）：
 * - 输出增强包 = **已批准正式版本的派生物**（manifestHash/projectVersionId 绑定；未批准 409）；
 * - **章节时间与正式成片一致**（越界/非单调 → 422 CONSISTENCY_VIOLATION，不静默修正）；
 * - **编码参数取自 manifest**；**授权署名取自资产许可**（缺失署名 → warning，不编造）；
 * - 封面 = THUMBNAIL 产物引用（缺失 → 明确 warning，不假称有封面）；标题/描述逐项可溯源。
 */

const ARTICLE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>利率周报</title></head><body>
<h1>美联储利率决议</h1><p>联邦基金利率维持在 5.25% 不变。市场预计年内降息一次。</p></body></html>`;

let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let storage: LocalObjectStorage;
let storageRoot: string;
let llm: MockLlmAdapter;

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
const deps = (): DomainDeps => ({ db: handle.db, storage });

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
  storageRoot = `${process.cwd()}/.artifacts/test-storage/outputs-${randomUUID()}`;
  storage = new LocalObjectStorage({ rootDir: await mkdtemp(join(tmpdir(), 'ancs-outputs-')), publicBaseUrl: 'http://127.0.0.1:0', signingSecret: 'outputs-integration-secret-0123456789' }); // secrets:check-ignore：测试专用假密钥
  auth = createAuth({ db: handle.db, secret: 'outputs-secret-0123456789', baseUrl: 'http://localhost:3001' }); // secrets:check-ignore：测试专用假密钥
  llm = new MockLlmAdapter();
  app = await buildServer({
    auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
    storage: createStorageDeps(storage),
    content: { articleFetcher: fetcher, llm },
    audio: { tts: new MockTtsAdapter() },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
  storage.publicBaseUrl = baseUrl;
});

afterAll(async () => {
  await app.close();
  await handle.close();
  await rm(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await handle.db.delete(workspaces);
  await handle.db.delete(plans);
  await ensureDefaultPlans(deps());
});

async function newClient(tag: string): Promise<AncsClient> {
  const email = `${tag}-${randomUUID()}@test.local`;
  await createInternalUser(auth, { email, password: 'password-1234', name: tag });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: 'password-1234' });
  return client;
}

interface FixtureOptions {
  /** manifest 声明的时长（用于一致性负例：小于章节 startMs 即越界） */
  manifestDurationMs?: number;
  /** 是否在产物中带封面（THUMBNAIL） */
  withThumbnail?: boolean;
  /** 许可素材是否缺署名文本 */
  assetAttributionText?: string | null;
}

/** 构造：READY + 结构可控的冻结快照（章节/摘要/来源/许可素材）+ 已批准。 */
async function makeApprovedRender(client: AncsClient, options: FixtureOptions = {}): Promise<{ workspaceId: string; projectId: string; renderId: string; thumbnailBytes: Uint8Array | null; sourceTitle: string }> {
  const workspace = await client.workspaces.create({ name: `输出-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '栏目' });
  const identity = await client.creatorIdentities.create(workspace.id, { displayName: '主播庚' });
  await client.creatorIdentities.update(workspace.id, identity.id, {
    voiceIdentity: { provider: 'mock-voice', providerVoiceId: 'vo_outputs', cloneType: 'INSTANT', ownershipType: 'SELF_VERIFIED', managedMode: 'BYOK', languageProfile: 'zh-CN' },
  });
  await client.channels.update(workspace.id, channel.id, { defaults: { creatorIdentityId: identity.id } });
  const project = await client.projects.create(workspace.id, { title: '利率周报（成片）', channelId: channel.id });
  const url = `https://news.example/rates/${randomUUID()}`;
  fetcher.responses.set(url, { contentType: 'text/html; charset=utf-8', bytes: new TextEncoder().encode(ARTICLE_HTML) });
  const record = await client.content.create(workspace.id, project.id, { sourceType: 'URL_ARTICLE', url });
  await client.evidence.extract(workspace.id, project.id, record.document.id);
  llm.scriptNext('valid');
  const generated = await client.narrative.generate(workspace.id, project.id, record.document.id, { targetDurationMs: 6000 });
  await client.narrative.applyDirectorPlan(workspace.id, project.id, generated.plan.id, { idempotencyKey: `idem_out_${randomUUID()}` });
  await client.narrative.synthesizeMasterNarration(workspace.id, project.id, generated.plan.id);
  const render = await client.renders.create(workspace.id, project.id, { profile: 'DRAFT_720' });

  // 许可素材（P10-03 元数据形态：license.attribution + metadata.stockLicense）
  const licensedAssetId = `ast_${randomUUID()}`;
  await handle.db.insert(assets).values({
    id: licensedAssetId,
    workspaceId: workspace.id,
    projectId: project.id,
    assetType: 'SOURCE_IMAGE',
    origin: 'LICENSED_STOCK',
    provider: 'mock-stock',
    providerAssetId: 'mockimg_licensed_a',
    status: 'READY',
    retentionClass: 'KEEP_USER_SOURCE',
    license: {
      type: 'LICENSED_STOCK',
      holder: null,
      attribution: options.assetAttributionText === undefined ? '素材：MockStock / 摄影 A（许可：MOCK-LIC-0001）' : options.assetAttributionText,
      sourceUrl: 'https://stock.mock.local/asset/a',
      termsUrl: null,
      notes: '许可证引用：MOCK-LIC-0001',
      confirmedBy: null,
      confirmedAt: null,
    },
    metadata: { stockProviderId: 'mock-stock', stockProviderAssetId: 'mockimg_licensed_a', title: '素材 A', stockLicense: { licenseType: 'LICENSED_STOCK', attributionRequired: true, licenseText: 'x', sourceUrl: 'https://stock.mock.local/asset/a', licenseReference: 'MOCK-LIC-0001' } },
    currentVersionId: null,
  });

  // 冻结快照：结构可控（章节 ×2 / 普通场景（绑定来源+素材）/ 摘要）
  const versionRows = await handle.db.select().from(projectVersions).where(eq(projectVersions.id, render.input.projectVersionId)).limit(1);
  const versionRow = versionRows[0];
  if (versionRow === undefined) throw new Error('冻结版本缺失');
  const snapshot = versionRow.snapshot as { graph: { scenes: Record<string, unknown>[]; timeline: { durationMs: number } } };
  const baseScene = snapshot.graph.scenes[0];
  if (baseScene === undefined) throw new Error('快照无场景');
  const cloneScene = (patch: Record<string, unknown>): Record<string, unknown> => ({ ...baseScene, ...patch });
  const sourceRow = (await handle.db.select().from(projectSources).where(eq(projectSources.projectId, project.id)).limit(1))[0];
  if (sourceRow === undefined) throw new Error('来源行缺失');
  snapshot.graph.scenes = [
    cloneScene({ id: `scn_ch1_${randomUUID().slice(0, 6)}`, position: 0, startMs: 0, durationMs: 1200, sceneType: 'CHAPTER_TITLE', semanticType: 'TRANSITION', props: { text: '开篇' }, sourceBindings: [], assetBindings: [] }),
    cloneScene({ id: `scn_body_${randomUUID().slice(0, 6)}`, position: 1, startMs: 1200, durationMs: 2600, sceneType: 'IMAGE_FULL', semanticType: 'IMAGE_EVIDENCE', props: {}, sourceBindings: [{ sourceId: sourceRow.id }], assetBindings: [{ assetId: licensedAssetId, role: 'visual' }] }),
    cloneScene({ id: `scn_ch2_${randomUUID().slice(0, 6)}`, position: 2, startMs: 3800, durationMs: 800, sceneType: 'CHAPTER_TITLE', semanticType: 'TRANSITION', props: { text: '第二幕' }, sourceBindings: [], assetBindings: [] }),
    cloneScene({ id: `scn_sum_${randomUUID().slice(0, 6)}`, position: 3, startMs: 4600, durationMs: 1400, sceneType: 'SUMMARY', semanticType: 'SUMMARY', props: { text: '利率维持不变，年内或降息一次。' }, sourceBindings: [], assetBindings: [] }),
  ];
  snapshot.graph.timeline.durationMs = 6000;
  await handle.db.update(projectVersions).set({ snapshot }).where(eq(projectVersions.id, versionRow.id));

  // 产物（真实字节 + 存储 + 资产行）
  const artifactBytes = new Map<string, Uint8Array>([
    ['VIDEO', new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 102, 97, 107, 101])],
    ['SUBTITLE_SRT', new TextEncoder().encode('1\n00:00:00,000 --> 00:00:03,000\n利率周报\n')],
    ['SUBTITLE_VTT', new TextEncoder().encode('WEBVTT\n\n00:00:00.000 --> 00:00:03.000\n利率周报\n')],
  ]);
  const thumbnailBytes = options.withThumbnail === true ? new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 8, 8]) : null;
  if (thumbnailBytes !== null) artifactBytes.set('THUMBNAIL', thumbnailBytes);

  const manifestDurationMs = options.manifestDurationMs ?? 6000;
  const outputs = [...artifactBytes.entries()].map(([kind, bytes]) => ({
    kind,
    fileName: kind === 'VIDEO' ? 'final.mp4' : kind === 'MANIFEST' ? 'manifest.json' : kind === 'SUBTITLE_SRT' ? 'subtitles.srt' : kind === 'SUBTITLE_VTT' ? 'subtitles.vtt' : 'thumbnail.png',
    mimeType: kind === 'VIDEO' ? 'video/mp4' : kind === 'SUBTITLE_SRT' ? 'application/x-subrip' : kind === 'SUBTITLE_VTT' ? 'text/vtt' : 'image/png',
    sizeBytes: bytes.byteLength,
    sha256: sha(bytes),
  }));
  const manifestBytes = new TextEncoder().encode(
    JSON.stringify(
      {
        schemaVersion: 'manifest-v1',
        projectId: project.id,
        projectVersionId: render.input.projectVersionId,
        sceneGraphSchemaVersion: 'graph-v1',
        renderSettings: { profile: 'DRAFT_720', width: 1280, height: 720, fps: 30, durationMs: manifestDurationMs },
        outputs,
        createdAt: '2026-10-05T10:00:00.000Z',
      },
      null,
      2,
    ),
  );

  const mimeByKind: Record<string, string> = { VIDEO: 'video/mp4', SUBTITLE_SRT: 'application/x-subrip', SUBTITLE_VTT: 'text/vtt', MANIFEST: 'application/json', THUMBNAIL: 'image/png' };
  const assetIds: string[] = [];
  const allArtifacts = new Map(artifactBytes);
  allArtifacts.set('MANIFEST', manifestBytes);
  for (const [kind, bytes] of allArtifacts) {
    const assetId = `ast_${randomUUID()}`;
    const versionId = `av_${randomUUID()}`;
    const fileName = kind === 'VIDEO' ? 'final.mp4' : kind === 'MANIFEST' ? 'manifest.json' : kind === 'SUBTITLE_SRT' ? 'subtitles.srt' : kind === 'SUBTITLE_VTT' ? 'subtitles.vtt' : 'thumbnail.png';
    const storageKey = `workspaces/${workspace.id}/projects/${project.id}/renders/${render.id}/${fileName}`;
    await storage.putObject(storageKey, bytes);
    await handle.db.insert(assets).values({
      id: assetId,
      workspaceId: workspace.id,
      projectId: project.id,
      assetType: kind === 'VIDEO' ? 'DRAFT_RENDER' : kind === 'MANIFEST' ? 'MANIFEST' : kind === 'THUMBNAIL' ? 'THUMBNAIL' : 'SUBTITLE',
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
  await handle.db.update(renders).set({ status: 'READY', manifestHash, outputAssetIds: assetIds, updatedAt: new Date() }).where(eq(renders.id, render.id));
  await client.renders.decideApproval(workspace.id, render.id, { decision: 'APPROVED', note: 'P10-05 夹具批准' });

  return { workspaceId: workspace.id, projectId: project.id, renderId: render.id, thumbnailBytes, sourceTitle: sourceRow.title };
}

describe('输出增强包（P10-05）', () => {
  it('主路径：与已批准正式版本绑定；章节/编码参数/来源/署名/封面逐项一致；描述可溯源', async () => {
    const client = await newClient('outputs-main');
    const { workspaceId, renderId, thumbnailBytes, sourceTitle } = await makeApprovedRender(client, { withThumbnail: true });

    const enhancements = await client.renders.outputEnhancements(workspaceId, renderId);
    // 正式版本绑定
    const renderRows = await handle.db.select().from(renders).where(eq(renders.id, renderId)).limit(1);
    const renderRow = renderRows[0];
    expect(enhancements.manifestHash).toBe(renderRow?.manifestHash);
    expect(enhancements.projectVersionId).toBe(renderRow === undefined ? undefined : (renderRow.input as { projectVersionId: string }).projectVersionId);
    expect(enhancements.approvalId).toBeTruthy();

    // 编码参数取自 manifest（正式版本事实）
    expect(enhancements.format).toEqual({ width: 1280, height: 720, fps: 30 });
    expect(enhancements.durationMs).toBe(6000);

    // 章节：时间与正式成片一致（startMs 原样；单调）
    expect(enhancements.chapters.map((chapter) => [chapter.startMs, chapter.title])).toEqual([
      [0, '开篇'],
      [3800, '第二幕'],
    ]);
    expect(enhancements.consistency.checked).toContain('CHAPTER_WITHIN_DURATION');
    expect(enhancements.consistency.checked).toContain('CHAPTER_MONOTONIC');

    // 来源（可追溯 + 被引用场景）
    expect(enhancements.sources).toHaveLength(1);
    expect(enhancements.sources[0]?.title).toBe(sourceTitle);
    expect(enhancements.sources[0]?.referencedBySceneIds).toHaveLength(1);

    // 授权署名（许可元数据取自资产；不编造）
    const attributed = enhancements.assetAttributions.find((entry) => entry.assetId.startsWith('ast_'));
    expect(attributed?.licenseType).toBe('LICENSED_STOCK');
    expect(attributed?.attributionRequired).toBe(true);
    expect(attributed?.attributionText).toContain('MockStock');
    expect(enhancements.consistency.warnings).toEqual([]);

    // 封面：manifest 产物引用 + sha 与正式版本一致；帧位在时长内
    expect(enhancements.thumbnail.fileName).toBe('thumbnail.png');
    expect(enhancements.thumbnail.sha256).toBe(sha(thumbnailBytes as Uint8Array));
    expect(enhancements.thumbnail.atMs).toBeGreaterThan(0);
    expect(enhancements.thumbnail.atMs).toBeLessThan(6000);

    // 标题/描述可溯源
    expect(enhancements.titles[0]?.text).toBe('利率周报（成片）');
    expect(enhancements.description.text).toContain('利率维持不变');
    expect(enhancements.description.text).toContain('MockStock');
    expect(enhancements.description.derivedFrom).toEqual(expect.arrayContaining(['PROJECT_TITLE', 'SUMMARY_SCENE', 'CHAPTERS', 'SOURCES', 'ASSET_ATTRIBUTIONS']));
  }, 120_000);

  it('无封面产物 → 明确 warning（不假称有封面）；缺署名文本 → warning（不编造署名）', async () => {
    const client = await newClient('outputs-warn');
    const { workspaceId, renderId } = await makeApprovedRender(client, { withThumbnail: false, assetAttributionText: null });

    const enhancements = await client.renders.outputEnhancements(workspaceId, renderId);
    expect(enhancements.thumbnail.fileName).toBeNull();
    expect(enhancements.thumbnail.sha256).toBeNull();
    expect(enhancements.consistency.warnings.some((warning) => warning.includes('无封面产物'))).toBe(true);
    expect(enhancements.consistency.warnings.some((warning) => warning.includes('缺少署名文本'))).toBe(true);
    const attributed = enhancements.assetAttributions.find((entry) => entry.licenseType === 'LICENSED_STOCK');
    expect(attributed?.attributionText).toBeNull();
  }, 120_000);

  it('一致性失败：章节超出正式成片时长 → 422 CONSISTENCY_VIOLATION（不静默修正）', async () => {
    const client = await newClient('outputs-mismatch');
    const { workspaceId, renderId } = await makeApprovedRender(client, { manifestDurationMs: 1000 });

    const error = await client.renders.outputEnhancements(workspaceId, renderId).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AncsApiError);
    expect((error as AncsApiError).status).toBe(422);
    expect((error as AncsApiError).details['reason']).toBe('CONSISTENCY_VIOLATION');
    const violations = (error as AncsApiError).details['violations'] as { check: string }[];
    expect(violations.some((violation) => violation.check === 'CHAPTER_WITHIN_DURATION')).toBe(true);
  }, 120_000);

  it('未批准 → 409 NOT_APPROVED（发布物只能来自已批准正式版本）', async () => {
    const client = await newClient('outputs-unapproved');
    const { workspaceId, renderId } = await makeApprovedRender(client);
    // 撤销批准（重新插入 REJECTED 作为最新决策）
    await client.renders.decideApproval(workspaceId, renderId, { decision: 'REJECTED', note: '撤回' });

    const error = await client.renders.outputEnhancements(workspaceId, renderId).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AncsApiError);
    expect((error as AncsApiError).status).toBe(409);
    expect((error as AncsApiError).details['reason']).toBe('NOT_APPROVED');
  }, 120_000);
});
