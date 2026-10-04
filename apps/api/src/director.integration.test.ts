import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, type DbHandle } from '@ancs/db';
import type { ArticleFetcher, LlmAdapter } from '@ancs/contracts';
import { reserveCredits } from '@ancs/domain';
import { MockLlmAdapter } from '@ancs/providers-mock-llm';
import { buildServer } from './server.js';

/**
 * P04-05 验收（HTTP + SDK，真实 DB + Mock LLM）：
 * - Director 输出：Scene 序列（含章节标题结构场景）/资产计划/Provider 任务计划/成本估算/告警/决策摘要；
 * - **Provider 未核验时诚实阻止**：任务计划标记 blocked（NO_CALLABLE_PROVIDER），成本 UNKNOWN——不冒充可生成；
 * - 应用前验证：Schema/来源/Lock/预算；应用 = 编辑协议原子请求（仅空项目），重复应用幂等；
 * - 预算耗尽 → 计划 BLOCKER + 应用 402；跨租户 404。
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
    secret: 'director-workflow-secret-0123456789', // secrets:check-ignore：测试专用假密钥
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

async function makePlannedProject(
  client: AncsClient,
  options: { withDataset?: boolean } = {},
): Promise<{ workspaceId: string; projectId: string; documentId: string; sourceId: string; planId: string; datasetId: string | null }> {
  const workspace = await client.workspaces.create({ name: `导演-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '栏目' });
  const project = await client.projects.create(workspace.id, { title: '导演项目', channelId: channel.id });
  const url = `https://news.example/rates/${randomUUID()}`;
  fetcher.responses.set(url, { contentType: 'text/html; charset=utf-8', bytes: new TextEncoder().encode(ARTICLE_HTML) });
  const record = await client.content.create(workspace.id, project.id, { sourceType: 'URL_ARTICLE', url });
  await client.evidence.extract(workspace.id, project.id, record.document.id);
  const sources = await client.content.sources(workspace.id, project.id);
  const sourceId = sources[0]?.id ?? '';

  let datasetId: string | null = null;
  if (options.withDataset !== false) {
    const dataset = await client.evidence.createDataset(workspace.id, project.id, {
      title: '联邦基金利率路径',
      unit: '%',
      sourceIds: [sourceId],
      synthetic: false,
      series: [
        {
          id: 'ser_fed',
          name: '联邦基金利率',
          points: [
            { t: '2023', v: 4.5, accuracy: 'anchor' },
            { t: '2024', v: 5.25, accuracy: 'anchor' },
            { t: '2025', v: 4.0, accuracy: 'anchor' },
          ],
        },
      ],
    });
    datasetId = dataset.id;
  }

  llm.scriptNext('valid');
  const generated = await client.narrative.generate(workspace.id, project.id, record.document.id, { targetDurationMs: 120_000 });
  return { workspaceId: workspace.id, projectId: project.id, documentId: record.document.id, sourceId, planId: generated.plan.id, datasetId };
}

describe('Director（P04-05）', () => {
  it('规划输出：章节标题结构场景 + 图表绑定 + 语音能力 + Provider 未核验诚实阻止', async () => {
    const { client } = await newClient('director-plan');
    const { workspaceId, projectId, planId, sourceId, datasetId } = await makePlannedProject(client);

    const plan = await client.narrative.directorPlan(workspaceId, projectId, planId);
    expect(plan.directorVersion).toBe('director-v1');
    expect(plan.narrativePlanId).toBe(planId);
    expect(plan.narrativePlanRevision).toBeGreaterThanOrEqual(1);
    expect(plan.policyOverridden).toBe(false);
    expect(plan.policy).toMatchObject({ avatarRatioMin: 0.15, avatarRatioMax: 0.3, titleSceneMs: 2_500 });
    expect(plan.decisionSummary.length).toBeGreaterThan(10);
    expect(plan.generation.method).toBe('DETERMINISTIC');

    // 章节边界结构场景（TRANSITION → CHAPTER_TITLE）
    const titles = plan.scenes.filter((scene) => scene.sceneType === 'CHAPTER_TITLE');
    expect(titles.length).toBeGreaterThanOrEqual(1);
    expect(titles[0]?.semanticType).toBe('TRANSITION');
    expect(plan.scenes[0]?.sceneType).toBe('CHAPTER_TITLE');
    expect(plan.scenes.map((scene) => scene.position)).toEqual(plan.scenes.map((_, index) => index));

    // 利率事实 → 图表场景：绑定数据集 + 仍保留来源标注能力（data_source_ids）
    const narrative = await client.narrative.current(workspaceId, projectId);
    expect(narrative).not.toBeNull();
    const knownBlockIds = new Set(narrative?.narrationBlocks.map((block) => block.id) ?? []);
    for (const scene of plan.scenes) {
      for (const blockId of scene.narrationBlockIds) expect(knownBlockIds.has(blockId)).toBe(true);
    }
    const claims = await client.evidence.claims(workspaceId, projectId);
    const rateClaimIds = new Set(claims.filter((claim) => claim.text.includes('利率')).map((claim) => claim.id));
    const rateScene = plan.scenes.find((scene) => scene.claimIds.some((claimId) => rateClaimIds.has(claimId)));
    expect(rateScene).toBeDefined();
    expect(rateScene).toMatchObject({ sceneType: 'LINE_CHART', datasetId, degraded: false });
    expect(rateScene?.dataSourceIds).toContain(sourceId);
    expect(rateScene?.capabilities).toContain('speech.synthesize');
    expect(rateScene?.assetRequirements.some((asset) => asset.assetType === 'CHART_RENDER')).toBe(true);

    // Provider 未核验：任务计划被明确阻止（不冒充可生成）；成本不可估
    const speech = plan.providerJobs.find((job) => job.capability === 'speech.synthesize');
    expect(speech).toBeDefined();
    expect(speech?.blocked).toBe(true);
    expect(speech?.blockedReason).toBe('NO_CALLABLE_PROVIDER');
    expect(speech?.units).toBeGreaterThan(0);
    const codes = plan.warnings.map((warning) => warning.code);
    expect(codes).toContain('NO_CALLABLE_PROVIDER');
    expect(plan.estimatedCost.certainty).toBe('UNKNOWN');
    expect(plan.blocked).toBe(false);

    // 策略覆盖可配置（§9.4 不是硬编码）
    const overridden = await client.narrative.directorPlan(workspaceId, projectId, planId, { avatarRatioMax: 0.4, titleSceneMs: 1_000 });
    expect(overridden.policyOverridden).toBe(true);
    expect(overridden.policy.avatarRatioMax).toBe(0.4);
    expect(overridden.scenes.filter((scene) => scene.sceneType === 'CHAPTER_TITLE')[0]?.durationMs).toBe(1_000);
  });

  it('应用：验证后原子生效（锁定旁白 → 锁定场景；绑定与旁白保留）；重复应用幂等；非空项目 409', async () => {
    const { client } = await newClient('director-apply');
    const { workspaceId, projectId, planId, sourceId, datasetId } = await makePlannedProject(client);

    // 锁定一个旁白块（作者锁定 → Director 必须逐字保留并锁定对应 Scene）
    const narrative = await client.narrative.current(workspaceId, projectId);
    const firstBlock = narrative?.narrationBlocks[0];
    expect(firstBlock).toBeDefined();
    await client.narrative.updateBlock(workspaceId, projectId, planId, firstBlock?.id ?? '', { locked: true });

    const plan = await client.narrative.directorPlan(workspaceId, projectId, planId);
    const lockedScene = plan.scenes.find((scene) => scene.narrationBlockIds.includes(firstBlock?.id ?? ''));
    expect(lockedScene?.locked).toBe(true);
    expect(plan.warnings.map((warning) => warning.code)).toContain('LOCKED_PRESERVED');

    const applyKey = `idem_dir_${randomUUID()}`;
    const applied = await client.narrative.applyDirectorPlan(workspaceId, projectId, planId, { idempotencyKey: applyKey });
    expect(applied.scenes.length).toBe(plan.scenes.length);
    expect(applied.project.revision).toBeGreaterThanOrEqual(1);

    const graph = await client.projects.graph(projectId);
    expect(graph.scenes.length).toBe(plan.scenes.length);
    const graphLocked = graph.scenes.find((scene) => scene.narrationBlockIds.includes(firstBlock?.id ?? ''));
    expect(graphLocked?.locked).toBe(true);
    expect(graphLocked?.narration).toBe(firstBlock?.text);
    const graphChart = graph.scenes.find((scene) => scene.sceneType === 'LINE_CHART');
    expect(graphChart?.dataBindings.some((binding) => binding.datasetId === datasetId)).toBe(true);
    expect(graphChart?.sourceBindings.some((binding) => binding.sourceId === sourceId)).toBe(true);

    // 同幂等键重放 → 返回原结果（不重复插入，项目 revision 不变）
    const replay = await client.narrative.applyDirectorPlan(workspaceId, projectId, planId, { idempotencyKey: applyKey });
    expect(replay.project.revision).toBe(applied.project.revision);
    expect(replay.scenes.length).toBe(applied.scenes.length);

    // 重复应用（新幂等键）→ 项目已有场景，明确 409
    const conflict = await client.narrative
      .applyDirectorPlan(workspaceId, projectId, planId, { idempotencyKey: `idem_dir_${randomUUID()}` })
      .catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(AncsApiError);
    expect((conflict as AncsApiError).status).toBe(409);
    expect((conflict as AncsApiError).details['reason']).toBe('SCENES_EXIST');
  });

  it('预算规则：预算耗尽 → 计划 BLOCKER，应用 402（不得先扣费/先应用）', async () => {
    const { client } = await newClient('director-budget');
    const { workspaceId, projectId, planId } = await makePlannedProject(client);

    await client.billing.setBudget(workspaceId, { period: 'MONTHLY', limitCredits: 100, perJobMaxCredits: 0 });
    await reserveCredits({ db: handle.db }, { workspaceId, jobId: `job_${randomUUID()}`, estimatedCredits: 100 });

    const plan = await client.narrative.directorPlan(workspaceId, projectId, planId);
    expect(plan.blocked).toBe(true);
    expect(plan.blockedReasons).toContain('BUDGET_EXHAUSTED');
    const blocker = plan.warnings.find((warning) => warning.code === 'BUDGET_EXHAUSTED');
    expect(blocker?.severity).toBe('BLOCKER');

    const applied = await client.narrative
      .applyDirectorPlan(workspaceId, projectId, planId, { idempotencyKey: `idem_dir_${randomUUID()}` })
      .catch((error: unknown) => error);
    expect(applied).toBeInstanceOf(AncsApiError);
    expect((applied as AncsApiError).status).toBe(402);
    expect((applied as AncsApiError).details['reason']).toBe('BUDGET_EXHAUSTED');

    // 应用被阻止 → 项目仍为空
    const graph = await client.projects.graph(projectId);
    expect(graph.scenes.length).toBe(0);
  });

  it('隔离与反枚举：跨租户/未知计划 → 404', async () => {
    const { client } = await newClient('director-isolation');
    const { workspaceId, projectId, planId } = await makePlannedProject(client);

    const { client: intruder } = await newClient('director-intruder');
    const crossed = await intruder.narrative.directorPlan(workspaceId, projectId, planId).catch((error: unknown) => error);
    expect(crossed).toBeInstanceOf(AncsApiError);
    expect((crossed as AncsApiError).status).toBe(404);

    const missing = await client.narrative.directorPlan(workspaceId, projectId, 'plan_missing_director').catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(AncsApiError);
    expect((missing as AncsApiError).status).toBe(404);
  });
});
