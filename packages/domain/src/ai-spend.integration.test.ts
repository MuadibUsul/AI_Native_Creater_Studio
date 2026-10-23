import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  AGENT_ERROR_REASONS,
  AGENT_MODEL_PRICES,
  ApiFailure,
  REFERENCE_DISTILL_WORKFLOW,
  legacyMillisecondsToMediaTime,
  mergeModelPrices,
  planEntitlementsSchema,
  type AgentContentBlock,
  type AgentModelAdapter,
  type AgentModelRequest,
  type AgentModelResponse,
} from '@ancs/contracts';
import { createDb, plans, resolveTestDatabaseUrl, runMigrations, workflowRuns, workflowSteps, workspaceSubscriptions, workspaces, type DbHandle } from '@ancs/db';
import {
  WorkflowRegistry,
  advanceWorkflow,
  agentTurnWorkflow,
  configureDeploymentPolicy,
  createAgentSession,
  createChannel,
  createProject,
  createSequence,
  getAgentTurn,
  getStudioState,
  startAgentTurn,
  workspaceAiSpend,
  type DomainDeps,
} from './index.js';

/**
 * 工作区 AI 月度费用上限（真实 PostgreSQL；模型为脚本模型，按真实单价计费，不调用真实 Provider）：
 * - 部署缺省上限：一轮在下一次模型调用前停下、保留已完成的修改并说明原因；新的一轮 402 AI_MONTHLY_CAP_REACHED；
 * - 共看片室读面带本月花费与上限；下个月重新计算；
 * - 风格撰写（参考视频蒸馏）的模型费用计入同一口径；
 * - 套餐设了 aiSpendMicrosPerMonth 时以套餐为准（可高于部署缺省）；套餐为 0 = 不能用 AI。
 */

let handle: DbHandle;
const deps = (): DomainDeps => ({ db: handle.db });
/** 价格表里输入单价 $4/MTok 的模型（按真实单价计费的脚本模型；不调用 Provider） */
const PRICED = Object.keys(AGENT_MODEL_PRICES).find((model) => AGENT_MODEL_PRICES[model]!.inputMicrosPerMTok === 4_000_000)!;
const created: { workspaces: string[]; plans: string[] } = { workspaces: [], plans: [] };

beforeAll(async () => {
  handle = createDb(resolveTestDatabaseUrl());
  await runMigrations(handle);
});
afterEach(() => configureDeploymentPolicy({}));
afterAll(async () => {
  for (const id of created.workspaces) await handle.db.delete(workspaces).where(eq(workspaces.id, id));
  for (const id of created.plans) await handle.db.delete(plans).where(eq(plans.id, id));
  await handle.close();
});

class ScriptedModel implements AgentModelAdapter {
  readonly providerId = 'scripted';
  readonly implementation = 'SCRIPTED' as const;
  readonly model = PRICED;
  readonly requests: AgentModelRequest[] = [];
  constructor(private readonly steps: (() => AgentModelResponse)[]) {}
  respond(request: AgentModelRequest): Promise<AgentModelResponse> {
    const step = this.steps[this.requests.length];
    this.requests.push(request);
    return step === undefined ? Promise.reject(new Error('no scripted step')) : Promise.resolve(step());
  }
}

/** 输入 $4/MTok：200k 输入 token = $0.80 */
const call = (content: AgentContentBlock[], stopReason: AgentModelResponse['stopReason']): AgentModelResponse => ({
  model: PRICED, content, stopReason, usage: { inputTokens: 200_000, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
});
const listFootage = (id: string) => call([{ type: 'tool_use', id, name: 'list_footage', input: {} }], 'tool_use');

async function fixture(locale: 'zh-CN' | 'en' = 'zh-CN') {
  const workspaceId = `ws_${randomUUID()}`;
  await handle.db.insert(workspaces).values({ id: workspaceId, name: 'AI 月度上限' });
  created.workspaces.push(workspaceId);
  const channel = await createChannel(deps(), { workspaceId, input: { name: '上限' } });
  const project = await createProject(deps(), { workspaceId, input: { title: '上限测试', channelId: channel.id, mode: 'FOOTAGE_EDIT' } });
  const sequence = await createSequence(deps(), { workspaceId, projectId: project.id, input: { name: '主序列', frameRate: { num: 30, den: 1 }, duration: legacyMillisecondsToMediaTime(1_000) } });
  const session = await createAgentSession(deps(), { workspaceId, projectId: project.id, request: { sequenceId: sequence.id, locale } });
  return { workspaceId, projectId: project.id, session };
}

async function drive(model: AgentModelAdapter, workspaceId: string, runId: string, maxCostMicros = 50_000_000): Promise<string> {
  // 缺省放宽单轮上限，只看工作区月度上限
  const registry = new WorkflowRegistry().register(agentTurnWorkflow({ model, limits: { maxCostMicros } }));
  for (let index = 0; index < 10; index += 1) {
    const row = (await handle.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)))[0]!;
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(row.status)) return row.status;
    await advanceWorkflow(deps(), registry, { workspaceId, runId, jobId: row.activeJobId! });
  }
  throw new Error('workflow did not finish');
}

async function rejection(promise: Promise<unknown>): Promise<ApiFailure> {
  const error = await promise.then(() => null, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(ApiFailure);
  return error as ApiFailure;
}

describe('工作区 AI 月度费用上限', () => {
  it('部署缺省 $1：第二次调用后达到上限 → 在下一次模型调用前停下并说明；新的一轮 402；读面显示已达上限；下个月重新计算', async () => {
    configureDeploymentPolicy({ aiMonthlyCapMicros: 1_000_000 });
    const f = await fixture();
    expect(await workspaceAiSpend(deps(), { workspaceId: f.workspaceId })).toMatchObject({ capMicros: 1_000_000, capSource: 'DEPLOYMENT', spentMicros: 0, reached: false });

    const model = new ScriptedModel([() => listFootage('a'), () => listFootage('b'), () => call([{ type: 'text', text: '不该走到这里' }], 'end_turn')]);
    const turn = await startAgentTurn(deps(), { workspaceId: f.workspaceId, sessionId: f.session.id, request: { message: '看看素材' }, idempotencyKey: 'cap-1' });
    expect(await drive(model, f.workspaceId, turn.workflowRunId!)).toBe('SUCCEEDED');
    // $0.80 → 未达上限，继续；$1.60 → 达到上限，第三次调用没有发生
    expect(model.requests).toHaveLength(2);
    const finished = await getAgentTurn(deps(), { workspaceId: f.workspaceId, turnId: turn.id });
    expect(finished).toMatchObject({ status: 'COMPLETED', costMicros: 1_600_000, error: { reason: AGENT_ERROR_REASONS.MONTHLY_CAP_REACHED } });
    expect(finished.reply).toContain('本月的 AI 额度（$1.00）已用完');

    const spend = await workspaceAiSpend(deps(), { workspaceId: f.workspaceId });
    expect(spend).toMatchObject({ capMicros: 1_000_000, spentMicros: 1_600_000, unpricedCalls: 0, reached: true });
    expect(spend.period).toBe(new Date().toISOString().slice(0, 7));

    const denied = await rejection(startAgentTurn(deps(), { workspaceId: f.workspaceId, sessionId: f.session.id, request: { message: '再剪一版' } }));
    expect(denied.httpStatus).toBe(402);
    expect(denied.details).toMatchObject({ reason: AGENT_ERROR_REASONS.MONTHLY_CAP_REACHED, capMicros: 1_000_000, spentMicros: 1_600_000, resetsAt: spend.resetsAt });
    // 幂等重放：同一个键的已有轮次照常返回，不被上限挡住
    expect((await startAgentTurn(deps(), { workspaceId: f.workspaceId, sessionId: f.session.id, request: { message: '看看素材' }, idempotencyKey: 'cap-1' })).id).toBe(turn.id);
    expect((await getStudioState(deps(), { workspaceId: f.workspaceId, projectId: f.projectId })).aiSpend).toEqual(spend);

    const nextMonth = new Date(new Date(spend.resetsAt).getTime() + 86_400_000);
    expect(await workspaceAiSpend(deps(), { workspaceId: f.workspaceId, now: nextMonth })).toMatchObject({ spentMicros: 0, reached: false });
  });

  it('英文会话：停下时的说明是英文；风格撰写的模型费用计入同一口径', async () => {
    configureDeploymentPolicy({ aiMonthlyCapMicros: 1_000_000 });
    const f = await fixture('en');
    // 一次已完成的参考视频蒸馏：compose 步骤记录了 $0.30 的模型费用
    const runId = `wfr_${randomUUID()}`;
    await handle.db.insert(workflowRuns).values({ id: runId, workspaceId: f.workspaceId, type: REFERENCE_DISTILL_WORKFLOW, version: 1, subjectRef: 'distill:test', status: 'SUCCEEDED', input: {} });
    await handle.db.insert(workflowSteps).values({ id: `wfs_${randomUUID()}`, runId, workspaceId: f.workspaceId, stepKey: 'compose', attempt: 1, status: 'SUCCEEDED', result: { composer: 'MODEL', costMicros: 300_000 } });
    expect((await workspaceAiSpend(deps(), { workspaceId: f.workspaceId })).spentMicros).toBe(300_000);

    const model = new ScriptedModel([() => listFootage('a'), () => call([{ type: 'text', text: 'unreachable' }], 'end_turn')]);
    const turn = await startAgentTurn(deps(), { workspaceId: f.workspaceId, sessionId: f.session.id, request: { message: 'look at the footage' } });
    expect(await drive(model, f.workspaceId, turn.workflowRunId!)).toBe('SUCCEEDED');
    // $0.30 + $0.80 = $1.10 ≥ $1.00
    expect(model.requests).toHaveLength(1);
    const finished = await getAgentTurn(deps(), { workspaceId: f.workspaceId, turnId: turn.id });
    expect(finished.reply).toMatch(/^This workspace has used its AI allowance for this month \(\$1\.00\)/);
    expect((await workspaceAiSpend(deps(), { workspaceId: f.workspaceId })).spentMicros).toBe(1_100_000);
  });

  it('单轮上限与月度上限同时到达：说明月度额度（用户需要知道本月不能再用）', async () => {
    configureDeploymentPolicy({ aiMonthlyCapMicros: 1_000_000 });
    const f = await fixture();
    const model = new ScriptedModel([() => listFootage('a'), () => listFootage('b'), () => call([{ type: 'text', text: 'unreachable' }], 'end_turn')]);
    const turn = await startAgentTurn(deps(), { workspaceId: f.workspaceId, sessionId: f.session.id, request: { message: '看看素材' } });
    // 缺省单轮上限 $1.50：两次调用 $1.60 同时超过单轮与月度上限
    expect(await drive(model, f.workspaceId, turn.workflowRunId!, 1_500_000)).toBe('SUCCEEDED');
    expect(model.requests).toHaveLength(2);
    expect((await getAgentTurn(deps(), { workspaceId: f.workspaceId, turnId: turn.id })).error).toEqual({ reason: AGENT_ERROR_REASONS.MONTHLY_CAP_REACHED });
  });

  it('设了上限而导演模型没有单价：不调用，说明缺哪个模型的单价；运维补上单价（ANCS_MODEL_PRICES_JSON）后照常计费并受上限约束；不设上限时照旧放行', async () => {
    configureDeploymentPolicy({ aiMonthlyCapMicros: 1_000_000 });
    const f = await fixture();
    const unpriced = (steps: (() => AgentModelResponse)[]) => Object.assign(new ScriptedModel(steps), { model: 'vendor-pro' });
    const reply = (text: string): AgentModelResponse => ({ model: 'vendor-pro', content: [{ type: 'text', text }], stopReason: 'end_turn', usage: { inputTokens: 200_000, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } });
    const blocked = unpriced([() => reply('不该走到这里')]);
    const first = await startAgentTurn(deps(), { workspaceId: f.workspaceId, sessionId: f.session.id, request: { message: '看看素材' } });
    expect(await drive(blocked, f.workspaceId, first.workflowRunId!)).toBe('SUCCEEDED');
    expect(blocked.requests).toHaveLength(0);
    const stopped = await getAgentTurn(deps(), { workspaceId: f.workspaceId, turnId: first.id });
    expect(stopped.error).toEqual({ reason: AGENT_ERROR_REASONS.MODEL_UNPRICED, model: 'vendor-pro' });
    expect(stopped.reply).toContain('（vendor-pro）还没有单价');

    // 运维补上单价（$5/MTok 输入）：20 万 token = $1.00，计入并触发上限
    configureDeploymentPolicy({ aiMonthlyCapMicros: 1_000_000, modelPrices: mergeModelPrices({ 'vendor-pro': { input: 5, output: 20 } }) });
    const priced = unpriced([() => reply('看完了。')]);
    const second = await startAgentTurn(deps(), { workspaceId: f.workspaceId, sessionId: f.session.id, request: { message: '再看看' } });
    expect(await drive(priced, f.workspaceId, second.workflowRunId!)).toBe('SUCCEEDED');
    expect(await getAgentTurn(deps(), { workspaceId: f.workspaceId, turnId: second.id })).toMatchObject({ reply: '看完了。', costMicros: 1_000_000, error: null });
    expect(await workspaceAiSpend(deps(), { workspaceId: f.workspaceId })).toMatchObject({ spentMicros: 1_000_000, reached: true });

    // 不设上限：没有单价也照旧调用（只计次数）
    configureDeploymentPolicy({});
    const free = unpriced([() => reply('好的。')]);
    const third = await startAgentTurn(deps(), { workspaceId: f.workspaceId, sessionId: f.session.id, request: { message: '还有吗' } });
    expect(await drive(free, f.workspaceId, third.workflowRunId!)).toBe('SUCCEEDED');
    expect(await getAgentTurn(deps(), { workspaceId: f.workspaceId, turnId: third.id })).toMatchObject({ reply: '好的。', costMicros: null });
  });

  it('适配器声明的模型有单价、实际计费的模型没有（如带图改用另一个模型）：这次调用之后停下，说明是哪个模型', async () => {
    configureDeploymentPolicy({ aiMonthlyCapMicros: 5_000_000 });
    const f = await fixture();
    const model = new ScriptedModel([
      () => ({ model: 'vendor-image-model', content: [{ type: 'tool_use', id: 'a', name: 'list_footage', input: {} }], stopReason: 'tool_use', usage: { inputTokens: 1_000, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } }),
      () => call([{ type: 'text', text: 'unreachable' }], 'end_turn'),
    ]);
    const turn = await startAgentTurn(deps(), { workspaceId: f.workspaceId, sessionId: f.session.id, request: { message: '看看画面' } });
    expect(await drive(model, f.workspaceId, turn.workflowRunId!)).toBe('SUCCEEDED');
    expect(model.requests).toHaveLength(1);
    expect((await getAgentTurn(deps(), { workspaceId: f.workspaceId, turnId: turn.id })).error).toEqual({ reason: AGENT_ERROR_REASONS.MODEL_UNPRICED, model: 'vendor-image-model' });
  });

  it('套餐设了额度时以套餐为准：高于部署缺省可以继续；套餐额度为 0 = 不能开始；未设任何上限 = 不限', async () => {
    configureDeploymentPolicy({ aiMonthlyCapMicros: 1_000_000 });
    const f = await fixture();
    const subscribe = async (aiSpendMicrosPerMonth: number) => {
      const planId = `pln_${randomUUID()}`;
      // 退役状态的套餐版本：只供这个工作区的订阅引用，不进入"最新可用版本"
      await handle.db.insert(plans).values({
        id: planId, planKey: 'STUDIO', version: 100_000 + Math.floor(Math.random() * 1_000_000), name: 'AI 额度测试', status: 'RETIRED',
        entitlements: planEntitlementsSchema.parse({ aiSpendMicrosPerMonth }), price: null,
      });
      created.plans.push(planId);
      const [row] = await handle.db.select().from(plans).where(eq(plans.id, planId));
      await handle.db.update(workspaceSubscriptions).set({ supersededAt: new Date() }).where(eq(workspaceSubscriptions.workspaceId, f.workspaceId));
      await handle.db.insert(workspaceSubscriptions).values({ id: `sub_${randomUUID()}`, workspaceId: f.workspaceId, planId, planKey: 'STUDIO', planVersion: row!.version, status: 'ACTIVE' });
    };

    await subscribe(5_000_000);
    const model = new ScriptedModel([() => listFootage('a'), () => listFootage('b'), () => call([{ type: 'text', text: '看完了。' }], 'end_turn')]);
    const turn = await startAgentTurn(deps(), { workspaceId: f.workspaceId, sessionId: f.session.id, request: { message: '看看素材' } });
    expect(await drive(model, f.workspaceId, turn.workflowRunId!)).toBe('SUCCEEDED');
    // $2.40 超过部署缺省 $1，但套餐额度 $5：正常完成
    expect(await getAgentTurn(deps(), { workspaceId: f.workspaceId, turnId: turn.id })).toMatchObject({ status: 'COMPLETED', reply: '看完了。', error: null, costMicros: 2_400_000 });
    expect(await workspaceAiSpend(deps(), { workspaceId: f.workspaceId })).toMatchObject({ capMicros: 5_000_000, capSource: 'PLAN', spentMicros: 2_400_000, reached: false });

    await subscribe(0);
    const denied = await rejection(startAgentTurn(deps(), { workspaceId: f.workspaceId, sessionId: f.session.id, request: { message: '再来' } }));
    expect(denied.details).toMatchObject({ reason: AGENT_ERROR_REASONS.MONTHLY_CAP_REACHED, capMicros: 0 });

    // 退订（无订阅）+ 部署未设缺省 → 默认套餐也不设 → 不限
    await handle.db.delete(workspaceSubscriptions).where(eq(workspaceSubscriptions.workspaceId, f.workspaceId));
    configureDeploymentPolicy({});
    expect(await workspaceAiSpend(deps(), { workspaceId: f.workspaceId })).toMatchObject({ capMicros: null, capSource: null, reached: false });
  });
});
