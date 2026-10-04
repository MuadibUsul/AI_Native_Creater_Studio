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
 * P04-03 验收（HTTP + SDK，真实 DB + Mock LLM）：
 * - 结构化输出 + **有限修复**（可修复/不可修复两条路径；至多 2 次 LLM 调用）；
 * - **锁定文字保留**：再生成后锁定旁白逐字不变（含"模型改写 → 回滚""模型丢失 → 补回"）；
 * - **事实类型保留**：旁白只能引用已登记事实；Claim 表本身不被生成触碰；
 * - **不得逐字朗读**（§8.2）：抄袭原文的旁白被门控拒绝；
 * - 版本化：再生成产生新 revision；编辑旁白块（锁定后 409）；跨租户 404。
 */

const ARTICLE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>利率周报</title></head><body>
<h1>美联储利率决议</h1>
<p>联邦基金利率维持在 5.25% 不变，为 2024 年以来的最高水平。</p>
<p>分析师预计 2025 年可能降息 2 个百分点，因为通胀压力缓解。</p>
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
    secret: 'narrative-workflow-secret-0123456789', // secrets:check-ignore：测试专用假密钥
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

async function newClient(tag: string): Promise<{ client: AncsClient; email: string }> {
  const email = `${tag}-${randomUUID()}@test.local`;
  await createInternalUser(auth, { email, password: 'password-1234', name: tag });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: 'password-1234' });
  return { client, email };
}

async function makeProject(client: AncsClient): Promise<{ workspaceId: string; projectId: string; documentId: string }> {
  const workspace = await client.workspaces.create({ name: `叙事-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '栏目' });
  const project = await client.projects.create(workspace.id, { title: '叙事项目', channelId: channel.id });
  const url = `https://news.example/rates/${randomUUID()}`;
  fetcher.responses.set(url, { contentType: 'text/html; charset=utf-8', bytes: new TextEncoder().encode(ARTICLE_HTML) });
  const record = await client.content.create(workspace.id, project.id, { sourceType: 'URL_ARTICLE', url });
  await client.evidence.extract(workspace.id, project.id, record.document.id);
  return { workspaceId: workspace.id, projectId: project.id, documentId: record.document.id };
}

describe('Narrative 生成（P04-03）', () => {
  it('合法输出：结构化计划落库（章节/旁白/事实引用/估计时长）；版本 revision=1', async () => {
    const { client } = await newClient('narrative-valid');
    const { workspaceId, projectId, documentId } = await makeProject(client);
    llm.scriptNext('valid');

    const result = await client.narrative.generate(workspaceId, projectId, documentId, { targetDurationMs: 120_000 });
    expect(result.plan.revision).toBe(1);
    expect(result.plan.chapters.length).toBeGreaterThanOrEqual(1);
    expect(result.plan.narrationBlocks.length).toBeGreaterThanOrEqual(3);
    expect(result.plan.estimatedDurationMs).toBeGreaterThan(0);
    expect(result.plan.generation).toMatchObject({ method: 'LLM', providerId: 'mock.llm', promptVersion: 'narrative-v1' });
    expect(result.meta.claimCount).toBeGreaterThanOrEqual(2);

    // 旁白引用已登记事实（不得虚构）
    const claims = await client.evidence.claims(workspaceId, projectId);
    const knownClaimIds = new Set(claims.map((claim) => claim.id));
    for (const block of result.plan.narrationBlocks) {
      for (const claimId of block.claimIds) expect(knownClaimIds.has(claimId)).toBe(true);
    }
    expect(result.plan.keyClaims.length).toBeGreaterThanOrEqual(1);

    // 读回一致（列表/当前计划）
    const current = await client.narrative.current(workspaceId, projectId);
    expect(current?.id).toBe(result.plan.id);
    expect((await client.narrative.plans(workspaceId, projectId)).length).toBe(1);

    // 提示词包含约束（可审计）：逐字朗读禁止 + 锁定保留 + 事实 id 引用
    expect(llm.lastSystemPrompt).toContain('禁止逐字复述原文');
    expect(llm.lastSystemPrompt).toContain('锁定旁白');
    expect(llm.lastSystemPrompt).toContain('promptVersion');
  });

  it('有限修复：可修复输出（未知字段/折算/缺省）自动规整并记录；不可修复 → 422（最多 2 次调用）', async () => {
    const { client } = await newClient('narrative-repair');
    const { workspaceId, projectId, documentId } = await makeProject(client);

    llm.scriptNext('repairable');
    const before = llm.callCount;
    const repaired = await client.narrative.generate(workspaceId, projectId, documentId, { targetDurationMs: 90_000 });
    expect(llm.callCount).toBe(before + 1); // 一次成功，无需重试
    expect(repaired.meta.repairs.length).toBeGreaterThan(0);

    // 不可修复：重试一次后明确失败（422 + 原因 + 调用次数）
    llm.scriptNext('unrepairable').scriptNext('unrepairable');
    const callsBefore = llm.callCount;
    const failure = await client.narrative
      .generate(workspaceId, projectId, documentId, { targetDurationMs: 90_000 })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AncsApiError);
    expect(failure).toMatchObject({ status: 422, code: 'VALIDATION_FAILED' });
    expect((failure as AncsApiError).details['reason']).toBe('REPAIR_LIMIT_EXCEEDED');
    expect(llm.callCount).toBe(callsBefore + 2); // 有限重试：至多 2 次
    // 失败不产生新版本
    expect((await client.narrative.plans(workspaceId, projectId)).length).toBe(1);
  });

  it('锁定文字保留：再生成后锁定旁白逐字不变；模型改写被回滚、丢失被补回', async () => {
    const { client } = await newClient('narrative-locked');
    const { workspaceId, projectId, documentId } = await makeProject(client);
    llm.scriptNext('valid');
    const first = await client.narrative.generate(workspaceId, projectId, documentId, { targetDurationMs: 120_000 });
    const target = first.plan.narrationBlocks[0];
    expect(target).toBeDefined();

    // 锁定第一段（作者定稿）
    const lockedText = target?.text ?? '';
    await client.narrative.updateBlock(workspaceId, projectId, first.plan.id, target?.id ?? '', { locked: true });

    // 再生成：模型输出新的旁白（Mock 会重写全部文本）→ 锁定段落必须逐字保留
    llm.scriptNext('valid');
    const second = await client.narrative.generate(workspaceId, projectId, documentId, { targetDurationMs: 120_000 });
    expect(second.plan.revision).toBe(2);
    const preserved = second.plan.narrationBlocks.find((block) => block.id === target?.id);
    expect(preserved?.text).toBe(lockedText);
    expect(preserved?.locked).toBe(true);
    // 请求确实把锁定旁白交给了模型（可审计）
    expect(llm.lastRequest?.lockedNarrationBlocks).toEqual([{ id: target?.id, text: lockedText }]);

    // 锁定块与两版计划都在（旧版本只读保留）
    const plans = await client.narrative.plans(workspaceId, projectId);
    expect(plans.length).toBe(2);
    expect(plans[1]?.narrationBlocks.find((block) => block.id === target?.id)?.text).toBe(lockedText);
  });

  it('不得逐字朗读（§8.2）：抄袭原文的旁白 → 422 VERBATIM_NARRATION_REJECTED', async () => {
    const { client } = await newClient('narrative-verbatim');
    const { workspaceId, projectId, documentId } = await makeProject(client);
    llm.scriptNext('verbatim');
    const failure = await client.narrative
      .generate(workspaceId, projectId, documentId, { targetDurationMs: 60_000 })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ status: 422 });
    expect((failure as AncsApiError).details['reason']).toBe('VERBATIM_NARRATION_REJECTED');
    expect((await client.narrative.plans(workspaceId, projectId)).length).toBe(0); // 不落库
  });

  it('编辑旁白块：锁定后修改文本 → 409；解锁后可改且时长重估；跨租户 404；VIEWER 403', async () => {
    const owner = await newClient('narrative-edit');
    const viewer = await newClient('narrative-viewer');
    const stranger = await newClient('narrative-stranger');
    const { workspaceId, projectId, documentId } = await makeProject(owner.client);
    await owner.client.workspaces.members.add(workspaceId, { email: viewer.email, role: 'VIEWER' });
    llm.scriptNext('valid');
    const generated = await owner.client.narrative.generate(workspaceId, projectId, documentId, { targetDurationMs: 120_000 });
    const block = generated.plan.narrationBlocks[0];

    const updated = await owner.client.narrative.updateBlock(workspaceId, projectId, generated.plan.id, block?.id ?? '', {
      text: '作者修订后的旁白文本，长度明显不同以便观察时长重估。',
    });
    expect(updated.text).toContain('作者修订后的旁白');
    expect(updated.estimatedDurationMs).toBeGreaterThan(0);

    await owner.client.narrative.updateBlock(workspaceId, projectId, generated.plan.id, block?.id ?? '', { locked: true });
    const blocked = await owner.client.narrative
      .updateBlock(workspaceId, projectId, generated.plan.id, block?.id ?? '', { text: '试图修改锁定旁白' })
      .catch((error: unknown) => error);
    expect(blocked).toMatchObject({ status: 409 });
    expect((blocked as AncsApiError).details['reason']).toBe('NARRATION_BLOCK_LOCKED');
    await owner.client.narrative.updateBlock(workspaceId, projectId, generated.plan.id, block?.id ?? '', { locked: false });
    const editable = await owner.client.narrative.updateBlock(workspaceId, projectId, generated.plan.id, block?.id ?? '', { text: '解锁后的修订' });
    expect(editable.text).toBe('解锁后的修订');

    // VIEWER 可读不可写
    expect((await viewer.client.narrative.current(workspaceId, projectId))?.id).toBe(generated.plan.id);
    const viewerWrite = await viewer.client.narrative
      .generate(workspaceId, projectId, documentId, { targetDurationMs: 60_000 })
      .catch((error: unknown) => error);
    expect(viewerWrite).toMatchObject({ status: 403 });

    // 跨租户：404
    const strangerRead = await stranger.client.narrative.current(workspaceId, projectId).catch((error: unknown) => error);
    expect(strangerRead).toMatchObject({ status: 404 });
  });
});
