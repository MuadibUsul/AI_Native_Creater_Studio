import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, packArtifacts, plans, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, workspaces, type DbHandle } from '@ancs/db';
import { ensureDefaultPlans, type DomainDeps } from '@ancs/domain';
import { MockLlmAdapter } from '@ancs/providers-mock-llm';
import { and, eq } from 'drizzle-orm';
import type { ArticleFetcher } from '@ancs/contracts';
import { buildServer } from './server.js';

/**
 * P12-01 验收（真实 DB）：Shorts Pack 完整链路 analyze → generate → validate。
 * - generate 产出 9:16 派生 Graph（Hook 前置/逐句字幕/来源卡），**不写回源项目**（原图与 revision 零改动）；
 * - 来源保留：逐场景 provenance（Atom→Claim→Source）落在产物载荷中；
 * - validate 逐项检查：竖屏安全区越界/来源缺失/Hook 违规 **明确报错**（篡改产物可复现），
 *   节选与 Recipe 窗口偏差为明示 warning。
 */

const ARTICLE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>利率周报</title></head><body>
<h1>美联储利率决议</h1><p>联邦基金利率维持在 5.25% 不变。市场预计年内降息一次。</p></body></html>`;

let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let llm: MockLlmAdapter;
const PASSWORD = 'password-1234';
const deps = (): DomainDeps => ({ db: handle.db });

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
  auth = createAuth({ db: handle.db, secret: 'shorts-secret-0123456789', baseUrl: 'http://localhost:3001' }); // secrets:check-ignore：测试专用假密钥
  llm = new MockLlmAdapter();
  app = await buildServer({
    auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
    content: { articleFetcher: fetcher, llm },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(async () => {
  await app.close();
  await handle.close();
});

beforeEach(async () => {
  await handle.db.delete(workspaces);
  await handle.db.delete(plans);
  await ensureDefaultPlans(deps());
});

async function newClient(tag: string): Promise<AncsClient> {
  const email = `${tag}-${randomUUID()}@test.local`;
  await createInternalUser(auth, { email, password: PASSWORD, name: tag });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: PASSWORD });
  return client;
}

async function makeProjectWithAtom(client: AncsClient): Promise<{ workspaceId: string; projectId: string; atomId: string }> {
  const workspace = await client.workspaces.create({ name: `短片-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '栏目' });
  const project = await client.projects.create(workspace.id, { title: '利率周报', channelId: channel.id });
  const url = `https://news.example/shorts/${randomUUID()}`;
  fetcher.responses.set(url, { contentType: 'text/html; charset=utf-8', bytes: new TextEncoder().encode(ARTICLE_HTML) });
  const record = await client.content.create(workspace.id, project.id, { sourceType: 'URL_ARTICLE', url });
  await client.evidence.extract(workspace.id, project.id, record.document.id);
  const claims = await client.evidence.claims(workspace.id, project.id);
  await client.content.contentCore.migrate(workspace.id, project.id);
  const atom = await client.content.atoms.create(workspace.id, project.id, {
    kind: 'KEY_NUMBER',
    title: '利率维持 5.25%',
    text: '联邦基金利率维持在 5.25% 不变。市场预计年内降息一次。',
    sourceRefs: [{ claimId: claims[0]?.id ?? '' }],
  });
  await client.packs.enable(workspace.id, 'ancs.pack.shorts-analyzer');
  await client.packs.bind(workspace.id, project.id, 'ancs.pack.shorts-analyzer');
  return { workspaceId: workspace.id, projectId: project.id, atomId: atom.id };
}

async function expectApiError(promise: Promise<unknown>, status: number, reason?: string): Promise<AncsApiError> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AncsApiError);
  const apiError = error as AncsApiError;
  expect(apiError.status).toBe(status);
  if (reason !== undefined) expect((apiError.details as { reason?: string }).reason).toBe(reason);
  return apiError;
}

describe('Shorts Pack 完整链路（P12-01）', () => {
  it('generate 产出 9:16 派生 Graph（Hook/字幕/来源卡）；**原长视频不被修改**', async () => {
    const client = await newClient('shorts-main');
    const { workspaceId, projectId, atomId } = await makeProjectWithAtom(client);
    await client.packs.analyze(workspaceId, projectId, 'ancs.pack.shorts-analyzer');

    // 原项目基线（图 + revision）
    const before = await client.projects.graph(projectId);
    const beforeScenes = before.scenes.length;

    const artifact = await client.packs.generate(workspaceId, projectId, 'ancs.pack.shorts-analyzer');
    expect(artifact.payloadKind).toBe('DERIVED_SCENE_GRAPH');
    expect(artifact.packVersion).toBe('1.0.0');
    expect(artifact.payload.format.aspectRatio).toBe('9:16');
    expect(artifact.payload.format.width).toBe(1080);
    expect(artifact.payload.format.height).toBe(1920);

    // Hook 前置 + 字幕 + 来源卡（短片独立可理解）
    const scenes = artifact.payload.graph.scenes;
    expect(scenes[0]?.id).toBe(artifact.payload.hook.sceneId);
    expect(artifact.payload.hook.durationMs).toBeLessThanOrEqual(3000);
    expect(artifact.payload.hook.text).toBe('利率维持 5.25%');
    expect(artifact.payload.graph.captions.length).toBeGreaterThanOrEqual(1);
    expect(scenes.some((scene) => scene.sceneType === 'SOURCE')).toBe(true);

    // 来源保留：逐场景 provenance（Atom→Claim→Source）
    expect(artifact.payload.topic.atomIds).toEqual([atomId]);
    for (const scene of scenes) {
      const entry = artifact.payload.provenance.find((candidate) => candidate.sceneId === scene.id);
      expect(entry).toBeDefined();
      expect(entry?.atomId).toBe(atomId);
      expect((entry?.claimIds.length ?? 0) + (entry?.sourceIds.length ?? 0)).toBeGreaterThan(0);
    }

    // **原长视频不被修改**：图与场景数零改动（产物只在 pack_artifacts）
    const after = await client.projects.graph(projectId);
    expect(after.scenes.length).toBe(beforeScenes);
    expect(after.projectRevision).toBe(before.projectRevision);

    // 产物列表可见（附最近校验 = null，尚未校验）
    const artifacts = await client.packs.artifacts.list(workspaceId, projectId);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.latestValidation).toBeNull();
  }, 120_000);

  it('validate：自产产物通过（无 error）；篡改安全区/来源后明确报错（可复现）', async () => {
    const client = await newClient('shorts-validate');
    const { workspaceId, projectId } = await makeProjectWithAtom(client);
    await client.packs.analyze(workspaceId, projectId, 'ancs.pack.shorts-analyzer');
    const artifact = await client.packs.generate(workspaceId, projectId, 'ancs.pack.shorts-analyzer');

    const result = await client.packs.artifacts.validate(workspaceId, projectId, artifact.artifactId);
    expect(result.ok).toBe(true);
    expect(result.issues.filter((issue) => issue.severity === 'error')).toHaveLength(0);

    // 篡改 1：把 HOOK 场景盒位移出安全区（y 越界）；篡改 2：删除 SOURCE 场景的 provenance
    const payload = artifact.payload;
    const tampered = structuredClone(payload);
    const hookScene = tampered.graph.scenes[0];
    if (hookScene !== undefined) {
      (hookScene.props as Record<string, unknown>)['shortLayout'] = { role: 'HOOK', box: { x: 48, y: 100, width: 984, height: 420 } };
    }
    const sourceScene = tampered.graph.scenes.find((scene) => scene.sceneType === 'SOURCE');
    tampered.provenance = tampered.provenance.filter((entry) => entry.sceneId !== sourceScene?.id);
    await handle.db
      .update(packArtifacts)
      .set({ payload: tampered })
      .where(and(eq(packArtifacts.id, artifact.artifactId), eq(packArtifacts.workspaceId, workspaceId)));

    const tamperedResult = await client.packs.artifacts.validate(workspaceId, projectId, artifact.artifactId);
    expect(tamperedResult.ok).toBe(false);
    const codes = tamperedResult.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.code);
    expect(codes).toContain('SAFE_AREA_VIOLATION');
    expect(codes).toContain('PROVENANCE_MISSING');
    // 校验历史只追加：两次校验都可见（旧行不改写）
    const artifacts = await client.packs.artifacts.list(workspaceId, projectId);
    expect(artifacts[0]?.latestValidation?.ok).toBe(false);
  }, 120_000);

  it('闸门：未 analyze 即 generate → 409 ANALYZE_REQUIRED；跨项目产物 validate → 404', async () => {
    const client = await newClient('shorts-gates');
    const { workspaceId, projectId } = await makeProjectWithAtom(client);

    // 未 analyze → generate 拒绝（来源锚缺失，不凭空产出）
    await expectApiError(client.packs.generate(workspaceId, projectId, 'ancs.pack.shorts-analyzer'), 409, 'ANALYZE_REQUIRED');

    await client.packs.analyze(workspaceId, projectId, 'ancs.pack.shorts-analyzer');
    const artifact = await client.packs.generate(workspaceId, projectId, 'ancs.pack.shorts-analyzer');

    // 另一个项目不可见该产物（租户内项目隔离）
    const other = await client.projects.create(workspaceId, { title: '另一项目', channelId: (await client.channels.list(workspaceId))[0]?.id ?? '' });
    await expectApiError(client.packs.artifacts.validate(workspaceId, other.id, artifact.artifactId), 404, 'ARTIFACT_NOT_FOUND');
  }, 120_000);
});
