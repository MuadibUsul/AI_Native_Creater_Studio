import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, type DbHandle } from '@ancs/db';
import type { ArticleFetcher, LlmAdapter } from '@ancs/contracts';
import { MockLlmAdapter } from '@ancs/providers-mock-llm';
import { buildServer } from './server.js';

/**
 * P05-06 验收（HTTP + SDK，真实 DB + Mock LLM）：
 * - **计划未 Apply 不改数据库**：生成计划后项目 revision 与场景完全不变；
 * - 计划结构化：operation 引用真实场景、带 before/after、影响估算与 rationale；
 * - **锁定场景**：对锁定场景的操作被剔除并告警（绝不自动解锁）；全被剔除 → 422 NO_CHANGES；
 * - 非法计划：引用不存在场景 → 422 UNKNOWN_SCENE_REFERENCE；不可解析 → 重试一次后成功；
 * - **Apply**：经统一编辑协议提交（revision 条件 + 幂等键）→ 变更生效 → 可撤销；
 * - **一项非法操作导致整批不提交**。
 */

const ARTICLE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>利率周报</title></head><body>
<h1>美联储利率决议</h1>
<p>联邦基金利率维持在 5.25% 不变。</p>
<p>分析师预计 2025 年可能降息 2 个百分点。</p>
</body></html>`;

let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let llm: MockLlmAdapter;

class ScriptedFetcher implements ArticleFetcher {
  readonly kind = 'scripted';
  responses = new Map<string, { contentType: string | null; bytes: Uint8Array }>();
  async fetch(input: { url: string }) {
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
  auth = createAuth({
    db: handle.db,
    secret: 'ai-edit-workflow-secret-0123456789', // secrets:check-ignore：测试专用假密钥
    baseUrl: 'http://localhost:3001',
  });
  llm = new MockLlmAdapter();
  app = await buildServer({
    auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
    content: { articleFetcher: fetcher, llm: llm as LlmAdapter },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(async () => {
  await app.close();
  await handle.close();
});

async function newClient(tag: string): Promise<AncsClient> {
  const email = `${tag}-${randomUUID()}@test.local`;
  await createInternalUser(auth, { email, password: 'password-1234', name: tag });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: 'password-1234' });
  return client;
}

/** 建一个带场景的项目（经叙事 → Director 应用）。 */
async function makeProjectWithScenes(client: AncsClient): Promise<{ workspaceId: string; projectId: string }> {
  const workspace = await client.workspaces.create({ name: `AI编辑-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '栏目' });
  const project = await client.projects.create(workspace.id, { title: 'AI Edit 项目', channelId: channel.id });
  const url = `https://news.example/rates/${randomUUID()}`;
  fetcher.responses.set(url, { contentType: 'text/html; charset=utf-8', bytes: new TextEncoder().encode(ARTICLE_HTML) });
  const record = await client.content.create(workspace.id, project.id, { sourceType: 'URL_ARTICLE', url });
  await client.evidence.extract(workspace.id, project.id, record.document.id);
  llm.scriptNext('valid');
  const generated = await client.narrative.generate(workspace.id, project.id, record.document.id, { targetDurationMs: 90_000 });
  await client.narrative.applyDirectorPlan(workspace.id, project.id, generated.plan.id, { idempotencyKey: `idem_ai_${randomUUID()}` });
  return { workspaceId: workspace.id, projectId: project.id };
}

describe('AI Edit（P05-06）', () => {
  it('生成计划不落库：项目 revision 与场景不变；计划结构完整（before/after/impact/rationale）', async () => {
    const client = await newClient('ai-edit-plan');
    const { workspaceId, projectId } = await makeProjectWithScenes(client);
    const before = await client.projects.graph(projectId);

    llm.scriptNext('ai_edit_valid');
    const plan = await client.narrative.aiEditPlan(workspaceId, projectId, { prompt: '把第一个场景延长 800ms' });

    expect(plan.planVersion).toBe('edit-plan-v1');
    expect(plan.baseProjectRevision).toBe(before.projectRevision);
    expect(plan.operations.length).toBeGreaterThan(0);
    const knownIds = new Set(before.scenes.map((scene) => scene.id));
    for (const entry of plan.operations) {
      expect(knownIds.has(entry.sceneId ?? '')).toBe(true);
      expect(entry.summary.length).toBeGreaterThan(0);
    }
    expect(plan.operations[0]?.before['durationMs']).toBe(before.scenes[0]?.durationMs);
    expect(plan.rationale.length).toBeGreaterThan(0);
    expect(plan.impact.costImpact).toBe('NONE');
    expect(plan.generation).toMatchObject({ method: 'LLM', providerId: 'mock.llm', attempts: 1 });

    // 未 Apply：数据库完全不变
    const after = await client.projects.graph(projectId);
    expect(after.projectRevision).toBe(before.projectRevision);
    expect(after.scenes.map((scene) => [scene.id, scene.revision, scene.durationMs, scene.narration])).toEqual(
      before.scenes.map((scene) => [scene.id, scene.revision, scene.durationMs, scene.narration]),
    );
  });

  it('Apply：计划经统一编辑协议提交（revision 条件）→ 变更生效；随后可撤销', async () => {
    const client = await newClient('ai-edit-apply');
    const { workspaceId, projectId } = await makeProjectWithScenes(client);
    const before = await client.projects.graph(projectId);

    llm.scriptNext('ai_edit_valid');
    const plan = await client.narrative.aiEditPlan(workspaceId, projectId, { prompt: '延长 800ms' });
    const expected: Record<string, number> = {};
    for (const entry of plan.operations) {
      if (entry.sceneId !== null) {
        const scene = before.scenes.find((candidate) => candidate.id === entry.sceneId);
        if (scene !== undefined) expected[scene.id] = scene.revision;
      }
    }
    const applied = await client.projects.edit(projectId, {
      baseProjectRevision: plan.baseProjectRevision,
      expectedSceneRevisions: expected,
      operations: plan.operations.map((entry) => entry.operation),
      idempotencyKey: `idem_apply_${plan.planId}`,
      intent: `AI Edit：${plan.prompt}`,
    });
    expect(applied.project.revision).toBe(before.projectRevision + 1);

    const after = await client.projects.graph(projectId);
    const firstChange = plan.operations.find((entry) => entry.operation.op === 'update_scene');
    expect(firstChange).toBeDefined();
    if (firstChange !== undefined && firstChange.operation.op === 'update_scene') {
      const changed = after.scenes.find((scene) => scene.id === firstChange.sceneId);
      expect(changed?.durationMs).toBe(firstChange.operation.changes.durationMs);
    }

    // 撤销（补偿事件；历史不改写）：每个 operation 一条事件，逐条撤销直至回到应用前状态
    for (let index = 0; index < plan.operations.length; index += 1) {
      await client.projects.undo(projectId, { idempotencyKey: `idem_undo_${String(index)}_${randomUUID()}` });
    }
    const restored = await client.projects.graph(projectId);
    expect(restored.scenes.map((scene) => [scene.id, scene.durationMs, scene.narration])).toEqual(
      before.scenes.map((scene) => [scene.id, scene.durationMs, scene.narration]),
    );
  });

  it('锁定场景：操作被剔除并告警（绝不自动解锁）；全部被剔除 → 422 NO_CHANGES', async () => {
    const client = await newClient('ai-edit-locked');
    const { workspaceId, projectId } = await makeProjectWithScenes(client);
    const graph = await client.projects.graph(projectId);
    const first = graph.scenes[0];
    expect(first).toBeDefined();
    await client.projects.edit(projectId, {
      baseProjectRevision: graph.projectRevision,
      expectedSceneRevisions: { [first?.id ?? '']: first?.revision ?? 1 },
      operations: [{ op: 'set_scene_lock', sceneId: first?.id ?? '', locked: true }],
      idempotencyKey: `idem_lock_${randomUUID()}`,
    });

    llm.scriptNext('ai_edit_locked');
    const planError = await client.narrative
      .aiEditPlan(workspaceId, projectId, { prompt: '缩短第一个场景' })
      .catch((error: unknown) => error);
    // Mock 只生成对锁定场景的操作 → 全被剔除 → NO_CHANGES（并附跳过告警）
    expect(planError).toBeInstanceOf(AncsApiError);
    expect((planError as AncsApiError).status).toBe(422);
    expect((planError as AncsApiError).details['reason']).toBe('NO_CHANGES');
    expect(JSON.stringify((planError as AncsApiError).details['warnings'])).toContain('已跳过对锁定场景');
  });

  it('非法计划：引用不存在场景 → 422；不可解析输出 → 重试一次后成功（attempts=2）', async () => {
    const client = await newClient('ai-edit-invalid');
    const { workspaceId, projectId } = await makeProjectWithScenes(client);

    llm.scriptNext('ai_edit_bad_scene');
    const bad = await client.narrative.aiEditPlan(workspaceId, projectId, { prompt: '删除不存在的场景' }).catch((error: unknown) => error);
    expect(bad).toBeInstanceOf(AncsApiError);
    expect((bad as AncsApiError).status).toBe(422);
    expect((bad as AncsApiError).details['reason']).toBe('UNKNOWN_SCENE_REFERENCE');

    llm.scriptNext('ai_edit_invalid_then_valid');
    const before = llm.callCount;
    const recovered = await client.narrative.aiEditPlan(workspaceId, projectId, { prompt: '微调' });
    expect(llm.callCount).toBe(before + 2); // 首次损坏 → 重试成功
    expect(recovered.generation.attempts).toBe(2);
  });

  it('整批不提交：一项非法操作（引用被删除的场景）→ 应用报错且数据库无变化', async () => {
    const client = await newClient('ai-edit-atomic');
    const { projectId } = await makeProjectWithScenes(client);
    const before = await client.projects.graph(projectId);
    const first = before.scenes[0];
    expect(first).toBeDefined();

    const failure = await client.projects
      .edit(projectId, {
        baseProjectRevision: before.projectRevision,
        expectedSceneRevisions: { [first?.id ?? '']: first?.revision ?? 1 },
        operations: [
          { op: 'update_scene', sceneId: first?.id ?? '', changes: { durationMs: 5000 } },
          { op: 'delete_scene', sceneId: 'scn_missing_scene' },
        ],
        idempotencyKey: `idem_atomic_${randomUUID()}`,
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AncsApiError);

    const after = await client.projects.graph(projectId);
    expect(after.projectRevision).toBe(before.projectRevision);
    expect(after.scenes.map((scene) => [scene.id, scene.durationMs])).toEqual(before.scenes.map((scene) => [scene.id, scene.durationMs]));
  });
});
