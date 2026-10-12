import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  AGENT_ERROR_REASONS,
  AgentModelFailure,
  ApiFailure,
  REVIEW_ERROR_REASONS,
  legacyMillisecondsToMediaTime,
  sourceMediaProbeResultSchema,
  type AgentContentBlock,
  type AgentFrameSampler,
  type AgentModelAdapter,
  type AgentModelRequest,
  type AgentModelResponse,
  type AgentModelUsage,
} from '@ancs/contracts';
import { agentTurnMessages, assetVersions, assets, compositionCaptionSpans, createDb, mediaDerivatives, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, workflowRuns, workspaces, type DbHandle } from '@ancs/db';
import {
  AGENT_SYSTEM_PROMPT,
  WorkflowRegistry,
  addReviewNote,
  adoptProposal,
  applyReview,
  discardProposal,
  getReviewState,
  listReviewNoteTurns,
  updateReviewNote,
  advanceWorkflow,
  agentTurnWorkflow,
  cancelWorkflow,
  createAgentSession,
  createChannel,
  createProject,
  createSequence,
  getAgentTurn,
  listProjectComposition,
  loadProposalForRead,
  previewProposal,
  processEdits,
  getProject,
  startAgentTurn,
  type DomainDeps,
} from './index.js';

/**
 * V6-1a 通用导演 Agent 运行时（真实 PostgreSQL + 编辑内核；模型为脚本模型，不是真实 Provider）：
 * - 一轮完整处理：上下文编译（素材/时间线/请求）→ 工具调用 → 草稿编辑（原子、错误回给模型）→ 提案；
 *   采用前工程不变，采用后时间线与草稿一致（预分配 id 稳定），成片长度贴合内容；
 * - 供应商专有块原样回放；未知工具/非法输入/被内核拒绝的编辑都作为工具错误回给模型；
 * - 崩溃/限流后续跑：已记录的模型调用不重复付费；
 * - 成本上限：保留已完成草稿并说明原因；计价按模型单价累加；
 * - 模型拒绝 → 轮次失败；取消 → 轮次取消；同会话并发轮次 409；幂等键返回同一轮次；
 * - 用户在轮次期间改过工程：草稿在最新版本上仍成立时提案建在最新版本上。
 */

let handle: DbHandle;
const deps = (): DomainDeps => ({ db: handle.db });
const mt = (milliseconds: number) => legacyMillisecondsToMediaTime(milliseconds);

beforeAll(async () => {
  const url = resolveTestDatabaseUrl();
  handle = createDb(url);
  try { await handle.pool.query('select 1'); }
  catch (error) {
    await handle.close();
    throw new Error(`Cannot connect to test database ${redactDatabaseUrl(url)}`, { cause: error });
  }
  await runMigrations(handle);
});
afterAll(async () => { await handle.close(); });

/** 脚本模型（测试内联：domain 不得依赖 providers/*）。 */
class ScriptedModel implements AgentModelAdapter {
  readonly providerId = 'scripted';
  readonly implementation = 'SCRIPTED' as const;
  readonly requests: AgentModelRequest[] = [];
  constructor(private readonly steps: ((request: AgentModelRequest) => AgentModelResponse)[], readonly model = 'scripted-director') {}
  respond(request: AgentModelRequest): Promise<AgentModelResponse> {
    const step = this.steps[this.requests.length];
    this.requests.push(structuredClone(request));
    if (step === undefined) return Promise.reject(new Error('no scripted step'));
    try { return Promise.resolve(step(request)); } catch (error) { return Promise.reject(error); }
  }
}

const usage = (inputTokens = 0, outputTokens = 0): AgentModelUsage => ({ inputTokens, outputTokens, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
const reply = (content: AgentContentBlock[], stopReason: AgentModelResponse['stopReason'], model = 'scripted-director', used = usage()): AgentModelResponse => ({ model, content, stopReason, usage: used });
const lastMessage = (request: AgentModelRequest) => request.messages[request.messages.length - 1]!;
const toolResults = (request: AgentModelRequest) => lastMessage(request).content.filter((block): block is Extract<AgentContentBlock, { type: 'tool_result' }> => block.type === 'tool_result');

function probe(durationMs: number, withAudio: boolean) {
  const video = {
    index: 0, type: 'VIDEO' as const, codecName: 'h264', codecLongName: 'H.264', profile: 'High',
    timeBase: { numerator: 1, denominator: 15_360 }, startPts: '0', durationTicks: '61440', durationMs,
    width: 1920, height: 1080, rotationDegrees: 0, pixelFormat: 'yuv420p', colorRange: 'tv', colorSpace: 'bt709',
    colorTransfer: 'bt709', colorPrimaries: 'bt709', nominalFrameRate: { numerator: 30, denominator: 1 },
    averageFrameRate: { numerator: 30, denominator: 1 }, frameCount: '300', sampleRate: null, channels: null,
    channelLayout: null, cadence: 'CONSTANT' as const, sampledPacketCount: 30, sampledPtsDeltaTicks: ['512'],
  };
  const audio = {
    ...video, index: 1, type: 'AUDIO' as const, codecName: 'aac', codecLongName: 'AAC', profile: 'LC', width: null, height: null, rotationDegrees: null,
    pixelFormat: null, colorRange: null, colorSpace: null, colorTransfer: null, colorPrimaries: null, nominalFrameRate: null, averageFrameRate: null,
    frameCount: null, sampleRate: 48_000, channels: 2, channelLayout: 'stereo',
  };
  return sourceMediaProbeResultSchema.parse({
    schemaVersion: '1.0', status: 'READY', formatNames: ['mp4'], formatLongName: 'QuickTime / MOV', startTimeMs: 0, durationMs, bitRate: 92_000,
    streams: withAudio ? [video, audio] : [video],
    decodeCheck: { status: 'PASSED', errorCode: null, message: null },
    capabilities: { upload: 'AVAILABLE', decode: 'AVAILABLE', preview: 'AVAILABLE', export: 'AVAILABLE', reasons: [] },
  });
}

async function fixture() {
  const workspaceId = `ws_${randomUUID()}`;
  await handle.db.insert(workspaces).values({ id: workspaceId, name: 'V6-1a 导演 Agent' });
  const channel = await createChannel(deps(), { workspaceId, input: { name: '旅行' } });
  const project = await createProject(deps(), { workspaceId, input: { title: '海边一日', channelId: channel.id, mode: 'FOOTAGE_EDIT' } });
  const sequence = await createSequence(deps(), { workspaceId, projectId: project.id, input: { name: '主序列', frameRate: { num: 30, den: 1 }, duration: mt(1_000) } });
  const footage = async (name: string, durationMs: number, withAudio: boolean): Promise<string> => {
    const assetId = `ast_${randomUUID()}`;
    const versionId = `av_${randomUUID()}`;
    await handle.db.insert(assets).values({
      id: assetId, workspaceId, projectId: project.id, assetType: 'UPLOADED_VIDEO', origin: 'USER_UPLOAD', status: 'READY',
      retentionClass: 'PROJECT', license: { kind: 'OWNED' }, currentVersionId: versionId, metadata: { filename: name },
    });
    await handle.db.insert(assetVersions).values({
      id: versionId, assetId, workspaceId, versionNumber: 1, storageKey: `v6-1a/${versionId}.mp4`, mimeType: 'video/mp4', sizeBytes: 2048,
      checksumSha256: 'b'.repeat(64), durationMs, width: 1920, height: 1080, status: 'READY', mediaProbe: probe(durationMs, withAudio),
    });
    return versionId;
  };
  const beach = await footage('beach.mp4', 8_000, true);
  const sunset = await footage('sunset.mp4', 6_000, false);
  const session = await createAgentSession(deps(), { workspaceId, projectId: project.id, request: { sequenceId: sequence.id, locale: 'zh-CN' } });
  return { workspaceId, projectId: project.id, sequenceId: sequence.id, beach, sunset, session };
}

async function drive(model: AgentModelAdapter, workspaceId: string, runId: string, limits?: Parameters<typeof agentTurnWorkflow>[0]['limits'], frames?: AgentFrameSampler) {
  const registry = new WorkflowRegistry().register(agentTurnWorkflow({ model, ...(limits === undefined ? {} : { limits }), ...(frames === undefined ? {} : { frames }) }));
  for (let index = 0; index < 10; index += 1) {
    const row = (await handle.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)))[0]!;
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(row.status)) return row.status;
    if (row.activeJobId === null) throw new Error(`run ${runId} has no active job (${row.status})`);
    await advanceWorkflow(deps(), registry, { workspaceId, runId, jobId: row.activeJobId });
  }
  throw new Error('workflow did not finish');
}

describe('V6-1a 通用导演 Agent 运行时（真实 PostgreSQL，脚本模型）', () => {
  it('一轮初剪：上下文 → 读素材 → 草稿编辑（错误回给模型）→ 提案；采用前工程不变，采用后与草稿一致', async () => {
    const f = await fixture();
    const opaque: AgentContentBlock = { type: 'opaque', provider: 'scripted', payload: { thinking: 'plan the opening' } };
    const model = new ScriptedModel([
      (request) => {
        expect(request.system).toBe(AGENT_SYSTEM_PROMPT);
        expect(request.tools.map((tool) => tool.name)).toEqual(['get_timeline', 'list_footage', 'inspect_footage', 'look_at_footage', 'search_footage', 'edit_timeline', 'review_draft', 'look_at_timeline']);
        const context = (request.messages[0]!.content[0] as { text: string }).text;
        expect(context).toContain('<request>\n帮我把这些素材剪成一个短片');
        expect(context).toContain(f.beach);
        expect(context).toContain('"language":"zh-CN"');
        expect(context).toContain('"mode":"FOOTAGE_EDIT"');
        return reply([opaque, { type: 'text', text: '先看看海边这段。' }, { type: 'tool_use', id: 't1', name: 'inspect_footage', input: { footageId: f.beach } }], 'tool_use');
      },
      (request) => {
        expect(request.messages[1]!.content).toContainEqual(opaque); // 原样回放
        const [result] = toolResults(request);
        expect(result).toMatchObject({ toolUseId: 't1', isError: false });
        expect(JSON.parse(result!.content)).toMatchObject({ footageId: f.beach, name: 'beach.mp4', contentTreatment: 'REFERENCE_DATA_ONLY' });
        return reply([{ type: 'tool_use', id: 't2', name: 'edit_timeline', input: { operations: [
          { op: 'place_clip', footageId: f.beach, sourceStart: '1', sourceEnd: '4.5' },
          { op: 'place_clip', footageId: f.sunset, sourceStart: 0, sourceEnd: '3', withAudio: false },
          { op: 'add_caption', text: '出发！', start: '0', end: '2' },
          { op: 'fit_length' },
        ] } }], 'tool_use');
      },
      (request) => {
        const [result] = toolResults(request);
        expect(result!.isError).toBe(false);
        const body = JSON.parse(result!.content) as { applied: number; length: string; createdClips: { id: string; at: [string, string] }[] };
        expect(body.applied).toBe(4);
        expect(body.length).toBe('6.500');
        expect(body.createdClips.map((clip) => clip.at)).toEqual(expect.arrayContaining([['0.000', '3.500'], ['3.500', '6.500']]));
        return reply([
          { type: 'tool_use', id: 't3', name: 'edit_timeline', input: { operations: [{ op: 'remove_clip', clipId: 'clp_missing' }] } },
          { type: 'tool_use', id: 't4', name: 'no_such_tool', input: {} },
          { type: 'tool_use', id: 't5', name: 'inspect_footage', input: { bogus: true } },
        ], 'tool_use');
      },
      (request) => {
        const results = toolResults(request);
        expect(results.map((result) => result.isError)).toEqual([true, true, true]);
        expect(JSON.parse(results[0]!.content)).toMatchObject({ failedIndex: 0, failedOp: 'remove_clip', applied: 0, reason: 'AGENT_EDIT_INVALID' });
        return reply([{ type: 'text', text: '第一版剪好了，6.5 秒，开头加了一句字幕。' }], 'end_turn');
      },
    ]);

    const turn = await startAgentTurn(deps(), { workspaceId: f.workspaceId, sessionId: f.session.id, request: { message: '帮我把这些素材剪成一个短片' }, idempotencyKey: 'first-cut' });
    expect(turn.status).toBe('RUNNING');
    expect((await startAgentTurn(deps(), { workspaceId: f.workspaceId, sessionId: f.session.id, request: { message: '帮我把这些素材剪成一个短片' }, idempotencyKey: 'first-cut' })).id).toBe(turn.id);
    const busy = await startAgentTurn(deps(), { workspaceId: f.workspaceId, sessionId: f.session.id, request: { message: '再来一个' } }).catch((error: unknown) => error);
    expect(busy).toBeInstanceOf(ApiFailure);
    expect((busy as ApiFailure).details['reason']).toBe(AGENT_ERROR_REASONS.TURN_IN_PROGRESS);

    expect(await drive(model, f.workspaceId, turn.workflowRunId!)).toBe('SUCCEEDED');
    const finished = await getAgentTurn(deps(), { workspaceId: f.workspaceId, turnId: turn.id });
    expect(finished).toMatchObject({ status: 'COMPLETED', reply: '第一版剪好了，6.5 秒，开头加了一句字幕。', error: null, costMicros: null });
    expect(finished.toolCalls.map((call) => `${call.name}:${String(call.ok)}`)).toEqual(['inspect_footage:true', 'edit_timeline:true', 'edit_timeline:false', 'no_such_tool:false', 'inspect_footage:false']);
    expect(finished.proposalId).not.toBeNull();

    // 采用前工程不变
    const untouched = await listProjectComposition(deps(), { workspaceId: f.workspaceId, projectId: f.projectId });
    expect(untouched.clips).toHaveLength(0);
    expect(untouched.sequences[0]?.duration).toEqual(mt(1_000));

    const trial = await previewProposal(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, proposalId: finished.proposalId! });
    const proposal = await loadProposalForRead(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, proposalId: finished.proposalId! });
    expect(trial.operationsHash).toBe(proposal.operationsHash);
    await adoptProposal(deps(), {
      workspaceId: f.workspaceId, projectId: f.projectId, proposalId: proposal.proposalId,
      expectedOperationsHash: proposal.operationsHash, expectedSelectionFingerprint: null, idempotencyKey: `adopt-${randomUUID()}`,
    });
    const adopted = await listProjectComposition(deps(), { workspaceId: f.workspaceId, projectId: f.projectId });
    expect(adopted.sequences[0]?.duration).toEqual(mt(6_500));
    expect(adopted.clips.filter((clip) => clip.assetVersionId === f.beach)).toHaveLength(2); // 视频 + 关联音频
    expect(adopted.clips.filter((clip) => clip.assetVersionId === f.sunset)).toHaveLength(1);
    const captions = await handle.db.select({ text: compositionCaptionSpans.text }).from(compositionCaptionSpans).where(eq(compositionCaptionSpans.projectId, f.projectId));
    expect(captions.map((caption) => caption.text)).toEqual(['出发！']);
  });

  it('续跑：限流失败后重试，从日志继续，已完成的模型调用不重复付费；按模型单价累计成本', async () => {
    const f = await fixture();
    let failedOnce = false;
    const priced = 'claude-opus-5-5';
    const model = new ScriptedModel([
      () => reply([{ type: 'tool_use', id: 'r1', name: 'list_footage', input: {} }], 'tool_use', priced, usage(100_000, 1_000)),
      () => {
        if (!failedOnce) { failedOnce = true; throw new AgentModelFailure('RATE_LIMITED', 'model rate limited', 429); }
        throw new Error('unreachable');
      },
      (request) => {
        // 重试后的调用：日志里已有第一次响应与工具结果
        expect(request.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
        return reply([{ type: 'text', text: '素材都看过了。' }], 'end_turn', priced, usage(50_000, 500));
      },
    ], priced);
    const turn = await startAgentTurn(deps(), { workspaceId: f.workspaceId, sessionId: f.session.id, request: { message: '看看有什么素材' } });
    expect(await drive(model, f.workspaceId, turn.workflowRunId!)).toBe('SUCCEEDED');
    expect(model.requests).toHaveLength(3);
    const finished = await getAgentTurn(deps(), { workspaceId: f.workspaceId, turnId: turn.id });
    expect(finished).toMatchObject({ status: 'COMPLETED', proposalId: null, reply: '素材都看过了。' });
    expect(finished.usage).toEqual({ inputTokens: 150_000, outputTokens: 1_500, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
    // Opus 5.5：$4/MTok 输入、$20/MTok 输出 → (150k×4 + 1.5k×20)/1M = $0.63
    expect(finished.costMicros).toBe(630_000);
    const logged = await handle.db.select().from(agentTurnMessages).where(eq(agentTurnMessages.turnId, turn.id));
    expect(logged.map((row) => row.role).sort()).toEqual(['assistant', 'assistant', 'user', 'user']);
  });

  it('成本上限：保留已完成草稿为提案并说明原因', async () => {
    const f = await fixture();
    const model = new ScriptedModel([
      () => reply([{ type: 'tool_use', id: 'b1', name: 'edit_timeline', input: { operations: [{ op: 'place_clip', footageId: f.sunset, sourceStart: '0', sourceEnd: '2', withAudio: false }] } }], 'tool_use', 'claude-opus-5-5', usage(400_000, 0)),
    ], 'claude-opus-5-5');
    const turn = await startAgentTurn(deps(), { workspaceId: f.workspaceId, sessionId: f.session.id, request: { message: '剪一版' } });
    expect(await drive(model, f.workspaceId, turn.workflowRunId!, { maxCostMicros: 1_000_000 })).toBe('SUCCEEDED');
    const finished = await getAgentTurn(deps(), { workspaceId: f.workspaceId, turnId: turn.id });
    expect(finished.status).toBe('COMPLETED');
    expect(finished.error).toEqual({ reason: AGENT_ERROR_REASONS.BUDGET_EXCEEDED });
    expect(finished.proposalId).not.toBeNull();
    expect(finished.reply).toContain('成本上限');
    expect(model.requests).toHaveLength(1);
  });

  it('模型拒绝 → 轮次失败；取消 → 轮次取消（不留进行中的轮次）', async () => {
    const f = await fixture();
    const refusing = new ScriptedModel([() => reply([{ type: 'text', text: '' }], 'refusal')]);
    const refused = await startAgentTurn(deps(), { workspaceId: f.workspaceId, sessionId: f.session.id, request: { message: '……' } });
    expect(await drive(refusing, f.workspaceId, refused.workflowRunId!)).toBe('FAILED');
    const failed = await getAgentTurn(deps(), { workspaceId: f.workspaceId, turnId: refused.id });
    expect(failed.status).toBe('FAILED');
    expect(JSON.stringify(failed.error)).toContain(AGENT_ERROR_REASONS.MODEL_REFUSED);

    const idle = new ScriptedModel([]);
    const cancelled = await startAgentTurn(deps(), { workspaceId: f.workspaceId, sessionId: f.session.id, request: { message: '算了' } });
    await cancelWorkflow(deps(), { workspaceId: f.workspaceId, runId: cancelled.workflowRunId! });
    expect(await drive(idle, f.workspaceId, cancelled.workflowRunId!)).toBe('CANCELLED');
    expect((await getAgentTurn(deps(), { workspaceId: f.workspaceId, turnId: cancelled.id })).status).toBe('CANCELLED');
    expect(idle.requests).toHaveLength(0);
  });

  it('看素材：抽帧优先用就绪的低清代理，图像随工具结果交给模型；未装配抽帧时明确报不可用', async () => {
    const f = await fixture();
    // 为 beach 建一个就绪的代理衍生物
    const proxyAssetId = `ast_${randomUUID()}`;
    const proxyVersionId = `av_${randomUUID()}`;
    await handle.db.insert(assets).values({ id: proxyAssetId, workspaceId: f.workspaceId, projectId: null, assetType: 'UPLOADED_VIDEO', origin: 'SYSTEM_RENDER', status: 'READY', retentionClass: 'PROJECT', license: { kind: 'OWNED' }, currentVersionId: proxyVersionId });
    await handle.db.insert(assetVersions).values({ id: proxyVersionId, assetId: proxyAssetId, workspaceId: f.workspaceId, versionNumber: 1, storageKey: `proxies/${proxyVersionId}.mp4`, mimeType: 'video/mp4', sizeBytes: 512, checksumSha256: 'd'.repeat(64), durationMs: 8_000, width: 960, height: 540, status: 'READY' });
    await handle.db.insert(mediaDerivatives).values({ id: `mdv_${randomUUID()}`, workspaceId: f.workspaceId, sourceAssetVersionId: f.beach, kind: 'PROXY', profileKey: 'proxy-540p', status: 'READY', derivativeAssetVersionId: proxyVersionId, sourceChecksumSha256: 'b'.repeat(64) });

    const sampled: { storageKey: string; times: readonly string[]; maxWidth: number }[] = [];
    const frames: AgentFrameSampler = {
      sample: (input) => { sampled.push(input); return Promise.resolve(input.times.map(() => ({ mediaType: 'image/jpeg' as const, data: '/9j/4AAQ' }))); },
    };
    const model = new ScriptedModel([
      () => reply([
        { type: 'tool_use', id: 'l1', name: 'look_at_footage', input: { footageId: f.beach, from: '2', to: '6', count: 4 } },
        { type: 'tool_use', id: 'l2', name: 'look_at_footage', input: { footageId: f.sunset, times: ['1.5', 99] } },
      ], 'tool_use'),
      (request) => {
        const [first, second] = toolResults(request);
        expect(JSON.parse(first!.content)).toMatchObject({ frames: [{ at: '2.500' }, { at: '3.500' }, { at: '4.500' }, { at: '5.500' }] });
        expect(first!.images).toHaveLength(4);
        expect(JSON.parse(second!.content).frames.map((frame: { at: string }) => frame.at)).toEqual(['1.500', '5.999']);
        return reply([{ type: 'text', text: '看过了。' }], 'end_turn');
      },
    ]);
    const turn = await startAgentTurn(deps(), { workspaceId: f.workspaceId, sessionId: f.session.id, request: { message: '看看海边那段的画面' } });
    expect(await drive(model, f.workspaceId, turn.workflowRunId!, undefined, frames)).toBe('SUCCEEDED');
    expect(sampled.map((call) => call.storageKey)).toEqual([`proxies/${proxyVersionId}.mp4`, `v6-1a/${f.sunset}.mp4`]);
    expect(sampled.every((call) => call.maxWidth === 512)).toBe(true);
    // 图像进入日志（重试时原样回放）
    const logged = await handle.db.select().from(agentTurnMessages).where(eq(agentTurnMessages.turnId, turn.id));
    expect(JSON.stringify(logged.map((row) => row.content))).toContain('/9j/4AAQ');

    const blind = new ScriptedModel([
      () => reply([{ type: 'tool_use', id: 'b1', name: 'look_at_footage', input: { footageId: f.beach } }], 'tool_use'),
      (request) => {
        expect(toolResults(request)[0]).toMatchObject({ isError: true });
        return reply([{ type: 'text', text: '看不了画面。' }], 'end_turn');
      },
    ]);
    const second = await startAgentTurn(deps(), { workspaceId: f.workspaceId, sessionId: f.session.id, request: { message: '再看看' } });
    expect(await drive(blind, f.workspaceId, second.workflowRunId!)).toBe('SUCCEEDED');
  });

  it('用户在轮次期间改过工程：草稿在最新版本上仍成立 → 提案建在最新版本上', async () => {
    const f = await fixture();
    const model = new ScriptedModel([
      () => reply([{ type: 'tool_use', id: 's1', name: 'edit_timeline', input: { operations: [{ op: 'place_clip', footageId: f.sunset, sourceStart: '0', sourceEnd: '2', withAudio: false }] } }], 'tool_use'),
      () => reply([{ type: 'text', text: '好了。' }], 'end_turn'),
    ]);
    const turn = await startAgentTurn(deps(), { workspaceId: f.workspaceId, sessionId: f.session.id, request: { message: '放一段日落' } });
    // 用户同时把成片延长到 20 秒（工程 revision 前进）
    const project = await getProject(deps(), { workspaceId: f.workspaceId, projectId: f.projectId });
    await processEdits(deps(), {
      workspaceId: f.workspaceId, projectId: f.projectId, actor: { type: 'USER', id: 'u_v6' },
      request: { schemaVersion: '1.0', baseProjectRevision: project.revision, expectedSceneRevisions: {}, operations: [{ op: 'set_sequence_duration', sequenceId: f.sequenceId, duration: mt(20_000) }], idempotencyKey: `idem_${randomUUID()}` },
    });
    expect(await drive(model, f.workspaceId, turn.workflowRunId!)).toBe('SUCCEEDED');
    const finished = await getAgentTurn(deps(), { workspaceId: f.workspaceId, turnId: turn.id });
    const proposal = await loadProposalForRead(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, proposalId: finished.proposalId! });
    expect(proposal.baseProjectRevision).toBe(project.revision + 1);
  });

  it('在试改上继续（V6-1c）：下一轮从未采用的试改出发，新提案取代它；没有再改则沿用；采用后的新一轮从头开始', async () => {
    const f = await fixture();
    const say = async (message: string, model: AgentModelAdapter) => {
      const turn = await startAgentTurn(deps(), { workspaceId: f.workspaceId, sessionId: f.session.id, request: { message } });
      expect(await drive(model, f.workspaceId, turn.workflowRunId!)).toBe('SUCCEEDED');
      return getAgentTurn(deps(), { workspaceId: f.workspaceId, turnId: turn.id });
    };
    const firstCut = await say('剪一版', new ScriptedModel([
      () => reply([{ type: 'tool_use', id: 'a1', name: 'edit_timeline', input: { operations: [{ op: 'place_clip', footageId: f.sunset, sourceStart: '0', sourceEnd: '4' }, { op: 'fit_length' }] } }], 'tool_use'),
      () => reply([{ type: 'text', text: '第一版。' }], 'end_turn'),
    ]));
    expect(firstCut.continuesProposalId).toBeNull();
    const trial = await loadProposalForRead(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, proposalId: firstCut.proposalId! });
    const projectBefore = await getProject(deps(), { workspaceId: f.workspaceId, projectId: f.projectId });

    // 继续：上下文标明在试改上继续，时间线已含试改的片段
    const refined = await say('再短一点', new ScriptedModel([
      (request) => {
        const context = (request.messages[0]!.content[0] as { text: string }).text;
        expect(context).toContain('"continuesTrial":true');
        const clipId = /"id":"(clp_[^"]+)"/.exec(context)?.[1];
        expect(clipId).toBeDefined();
        return reply([{ type: 'tool_use', id: 'b1', name: 'edit_timeline', input: { operations: [{ op: 'trim_clip', clipId, trimTail: '1' }, { op: 'fit_length' }] } }], 'tool_use');
      },
      () => reply([{ type: 'text', text: '短了一秒。' }], 'end_turn'),
    ]));
    expect(refined.continuesProposalId).toBe(trial.proposalId);
    const replacement = await loadProposalForRead(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, proposalId: refined.proposalId! });
    expect(replacement.operations.slice(0, trial.operations.length)).toEqual(trial.operations);
    expect(replacement.operations.length).toBeGreaterThan(trial.operations.length);
    expect(replacement.baseProjectRevision).toBe(projectBefore.revision);
    expect((await loadProposalForRead(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, proposalId: trial.proposalId })).status).toBe('SUPERSEDED');

    // 只回答、不再改：沿用当前试改
    const question = await say('这样可以吗', new ScriptedModel([() => reply([{ type: 'text', text: '可以。' }], 'end_turn')]));
    expect(question.continuesProposalId).toBe(replacement.proposalId);
    expect(question.proposalId).toBe(replacement.proposalId);
    expect((await loadProposalForRead(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, proposalId: replacement.proposalId })).status).toBe('OPEN');

    // 采用后，新一轮从工程当前版本出发
    await adoptProposal(deps(), {
      workspaceId: f.workspaceId, projectId: f.projectId, proposalId: replacement.proposalId,
      expectedOperationsHash: replacement.operationsHash, expectedSelectionFingerprint: null, idempotencyKey: `adopt-${randomUUID()}`,
    });
    const fresh = await say('看看', new ScriptedModel([() => reply([{ type: 'text', text: '好。' }], 'end_turn')]));
    expect(fresh.continuesProposalId).toBeNull();
    expect(fresh.proposalId).toBeNull();
    const clips = (await listProjectComposition(deps(), { workspaceId: f.workspaceId, projectId: f.projectId })).clips;
    expect(clips.filter((clip) => clip.sequenceId === f.sequenceId)).toHaveLength(1);
  });

  it('在试改上继续时用户先采用了原试改：只把本轮新增的改动建成新提案（基于采用后的版本）', async () => {
    const f = await fixture();
    const first = await startAgentTurn(deps(), { workspaceId: f.workspaceId, sessionId: f.session.id, request: { message: '剪一版' } });
    expect(await drive(new ScriptedModel([
      () => reply([{ type: 'tool_use', id: 'a1', name: 'edit_timeline', input: { operations: [{ op: 'place_clip', footageId: f.sunset, sourceStart: '0', sourceEnd: '4' }, { op: 'fit_length' }] } }], 'tool_use'),
      () => reply([{ type: 'text', text: '第一版。' }], 'end_turn'),
    ]), f.workspaceId, first.workflowRunId!)).toBe('SUCCEEDED');
    const trial = await loadProposalForRead(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, proposalId: (await getAgentTurn(deps(), { workspaceId: f.workspaceId, turnId: first.id })).proposalId! });

    const second = await startAgentTurn(deps(), { workspaceId: f.workspaceId, sessionId: f.session.id, request: { message: '后面再接一段' } });
    expect(second.continuesProposalId).toBe(trial.proposalId);
    const adopted = await adoptProposal(deps(), {
      workspaceId: f.workspaceId, projectId: f.projectId, proposalId: trial.proposalId,
      expectedOperationsHash: trial.operationsHash, expectedSelectionFingerprint: null, idempotencyKey: `adopt-${randomUUID()}`,
    });
    expect(await drive(new ScriptedModel([
      () => reply([{ type: 'tool_use', id: 'b1', name: 'edit_timeline', input: { operations: [{ op: 'place_clip', footageId: f.beach, sourceStart: '1', sourceEnd: '3', withAudio: false }, { op: 'fit_length' }] } }], 'tool_use'),
      () => reply([{ type: 'text', text: '接上了。' }], 'end_turn'),
    ]), f.workspaceId, second.workflowRunId!)).toBe('SUCCEEDED');
    const done = await getAgentTurn(deps(), { workspaceId: f.workspaceId, turnId: second.id });
    const added = await loadProposalForRead(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, proposalId: done.proposalId! });
    expect(added.baseProjectRevision).toBe(adopted.projectRevision);
    expect(JSON.stringify(added.operations)).not.toContain(f.sunset);
    await adoptProposal(deps(), {
      workspaceId: f.workspaceId, projectId: f.projectId, proposalId: added.proposalId,
      expectedOperationsHash: added.operationsHash, expectedSelectionFingerprint: null, idempotencyKey: `adopt-${randomUUID()}`,
    });
    const clips = (await listProjectComposition(deps(), { workspaceId: f.workspaceId, projectId: f.projectId })).clips.filter((clip) => clip.sequenceId === f.sequenceId);
    expect(clips.map((clip) => clip.assetVersionId).sort()).toEqual([f.beach, f.sunset].sort());
  });

  it('可选风格策略（V6 §6.6）：选用的策略与旋钮作为数据进入上下文；工具目录不变；未知策略/旋钮在建轮次前拒绝', async () => {
    const f = await fixture();
    const turn = await startAgentTurn(deps(), { workspaceId: f.workspaceId, sessionId: f.session.id, request: { message: '剪一版', strategyPackId: 'builtin:travel-beat', strategyKnobs: { pacing: 'intense' } } });
    expect(turn).toMatchObject({ strategyPackId: 'builtin:travel-beat', strategyKnobs: { pacing: 'intense', transitions: 'hard_cuts' } });
    const model = new ScriptedModel([
      (request) => {
        const context = (request.messages[0]!.content[0] as { text: string }).text;
        expect(context).toContain('<optional_style_strategy>');
        expect(context).toContain('id: builtin:travel-beat');
        expect(context).toContain('- pacing = intense');
        // 工具目录与不选策略时完全一致
        expect(request.tools.map((tool) => tool.name)).toEqual(['get_timeline', 'list_footage', 'inspect_footage', 'look_at_footage', 'search_footage', 'edit_timeline', 'review_draft', 'look_at_timeline']);
        expect(request.system).toBe(AGENT_SYSTEM_PROMPT);
        return reply([{ type: 'text', text: '好。' }], 'end_turn');
      },
    ]);
    expect(await drive(model, f.workspaceId, turn.workflowRunId!)).toBe('SUCCEEDED');

    const plain = await startAgentTurn(deps(), { workspaceId: f.workspaceId, sessionId: f.session.id, request: { message: '再看看' } });
    expect(plain).toMatchObject({ strategyPackId: null, strategyKnobs: {} });
    expect(await drive(new ScriptedModel([(request) => {
      expect((request.messages[0]!.content[0] as { text: string }).text).not.toContain('<optional_style_strategy>');
      return reply([{ type: 'text', text: '好。' }], 'end_turn');
    }]), f.workspaceId, plain.workflowRunId!)).toBe('SUCCEEDED');

    const before = (await handle.db.select().from(workflowRuns)).length;
    await expect(startAgentTurn(deps(), { workspaceId: f.workspaceId, sessionId: f.session.id, request: { message: 'x', strategyPackId: 'builtin:nope' } })).rejects.toMatchObject({ httpStatus: 404, details: { reason: 'STRATEGY_PACK_NOT_FOUND' } });
    await expect(startAgentTurn(deps(), { workspaceId: f.workspaceId, sessionId: f.session.id, request: { message: 'x', strategyPackId: 'builtin:travel-beat', strategyKnobs: { pacing: 'warp' } } })).rejects.toMatchObject({ httpStatus: 422, details: { reason: 'STRATEGY_KNOB_INVALID' } });
    expect((await handle.db.select().from(workflowRuns)).length).toBe(before);
  });

  it('自检（V6 §6.4）：review_draft 按通用规则检查草稿并说明缺失的分析层；look_at_timeline 看到草稿在时间线上的画面', async () => {
    const f = await fixture();
    const sampled: { storageKey: string; times: readonly string[] }[] = [];
    const frames: AgentFrameSampler = { sample: (input) => { sampled.push(input); return Promise.resolve(input.times.map(() => ({ mediaType: 'image/jpeg' as const, data: '/9j/4AAQ' }))); } };
    const model = new ScriptedModel([
      // 放两段，第二段只有 0.2 s（闪帧），并故意不收成片长度（空尾巴）
      () => reply([{ type: 'tool_use', id: 'e1', name: 'edit_timeline', input: { operations: [
        { op: 'place_clip', footageId: f.sunset, sourceStart: '0', sourceEnd: '3' },
        { op: 'place_clip', footageId: f.sunset, sourceStart: '1', sourceEnd: '1.2' },
        { op: 'set_length', seconds: '5' },
      ] } }], 'tool_use'),
      () => reply([
        { type: 'tool_use', id: 'r1', name: 'review_draft', input: {} },
        { type: 'tool_use', id: 'l1', name: 'look_at_timeline', input: { times: ['1.5', '3.1', '4.5'] } },
      ], 'tool_use'),
      (request) => {
        const [review, look] = toolResults(request);
        const findings = JSON.parse(review!.content) as { findings: { kind: string; at: string[] }[]; stats: { videoClips: number; shotSeconds: { min: string } }; notChecked: string[] };
        expect(findings.findings.map((finding) => finding.kind)).toEqual(['FLASH_CLIP', 'REPEATED_SHOT', 'LENGTH_MISMATCH']);
        expect(findings.stats).toMatchObject({ videoClips: 2, shotSeconds: { min: '0.200' } });
        expect(findings.notChecked).toContain('black frames (footage not analyzed)');
        const looked = JSON.parse(look!.content) as { frames: { at: string; footage: string | null; footageAt: string | null }[] };
        expect(looked.frames).toEqual([
          { at: '1.5', clipId: expect.any(String), footage: 'sunset.mp4', footageAt: '1.500' },
          { at: '3.1', clipId: expect.any(String), footage: 'sunset.mp4', footageAt: '1.100' },
          { at: '4.5', clipId: null, footage: null, footageAt: null },
        ]);
        expect(look!.images).toHaveLength(2);
        return reply([{ type: 'text', text: '查过了。' }], 'end_turn');
      },
    ]);
    const turn = await startAgentTurn(deps(), { workspaceId: f.workspaceId, sessionId: f.session.id, request: { message: '剪一下' } });
    expect(await drive(model, f.workspaceId, turn.workflowRunId!, undefined, frames)).toBe('SUCCEEDED');
    expect(sampled.map((call) => call.times)).toEqual([['1.500'], ['1.100']]);
    const done = await getAgentTurn(deps(), { workspaceId: f.workspaceId, turnId: turn.id });
    expect(done.toolCalls.map((call) => call.name)).toEqual(['edit_timeline', 'review_draft', 'look_at_timeline']);
    expect(done.toolCalls[1]!.summary).toBe('review: 2 warnings, 1 notes');
  });
});

describe('V6-4 批注式审片（真实 PostgreSQL，脚本模型）', () => {
  const contextOf = (request: AgentModelRequest) => (request.messages[0]!.content[0] as { text: string }).text;
  interface ReviewNoteView { id: string; note: string; clips: string[]; agreedPlan?: string }
  const reviewBlock = (request: AgentModelRequest) => JSON.parse(/<review>\n([\s\S]*?)\n<\/review>/.exec(contextOf(request))![1]!) as { mode: string; notes: ReviewNoteView[] } & Record<string, unknown>;
  const reasonOf = async (promise: Promise<unknown>) => {
    const error = await promise.then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiFailure);
    return { status: (error as ApiFailure).httpStatus, reason: (error as ApiFailure).details['reason'] };
  };
  const adopt = async (workspaceId: string, projectId: string, proposalId: string) => {
    const proposal = await loadProposalForRead(deps(), { workspaceId, projectId, proposalId });
    await adoptProposal(deps(), { workspaceId, projectId, proposalId, expectedOperationsHash: proposal.operationsHash, expectedSelectionFingerprint: null, idempotencyKey: `adopt-${randomUUID()}` });
  };
  const run = async (model: AgentModelAdapter, workspaceId: string, turn: { id: string; workflowRunId: string | null }) => {
    expect(await drive(model, workspaceId, turn.workflowRunId!)).toBe('SUCCEEDED');
    return getAgentTurn(deps(), { workspaceId, turnId: turn.id });
  };

  it('标记 → 讨论（只给方案、不改时间线）→ 确定 → 一次执行 → 在试改上微调 → 采用；之后的标记开新一轮', async () => {
    const f = await fixture();
    const ws = f.workspaceId;
    // 先有一版已采用的初剪
    const cut = await run(new ScriptedModel([
      () => reply([{ type: 'tool_use', id: 'c1', name: 'edit_timeline', input: { operations: [
        { op: 'place_clip', footageId: f.beach, sourceStart: '0', sourceEnd: '4' },
        { op: 'place_clip', footageId: f.sunset, sourceStart: '0', sourceEnd: '3', withAudio: false },
        { op: 'fit_length' },
      ] } }], 'tool_use'),
      () => reply([{ type: 'text', text: '第一版。' }], 'end_turn'),
    ]), ws, await startAgentTurn(deps(), { workspaceId: ws, sessionId: f.session.id, request: { message: '剪一版' } }));
    await adopt(ws, f.projectId, cut.proposalId!);
    const composition = await listProjectComposition(deps(), { workspaceId: ws, projectId: f.projectId });
    const videoTracks = new Set(composition.tracks.filter((track) => track.kind === 'VIDEO').map((track) => track.id));
    const beachClip = composition.clips.find((clip) => clip.assetVersionId === f.beach && videoTracks.has(clip.trackId))!;

    expect((await getReviewState(deps(), { workspaceId: ws, projectId: f.projectId })).round).toBeNull();
    const note = (text: string, start: string, end: string, extra: Record<string, unknown> = {}) => addReviewNote(deps(), {
      workspaceId: ws, projectId: f.projectId, request: { sequenceId: f.sequenceId, pointer: { timeRange: { start, end }, clipIds: [] }, text, ...extra },
    });
    const noteA = await note('开头太拖', '0', '2', { pointer: { timeRange: { start: '0', end: '2' }, clipIds: [beachClip.id] }, region: { x: 0.1, y: 0.1, width: 0.5, height: 0.4 } });
    const noteB = await note('日落那段太暗', '4.5', '6');
    const noteC = await note('结尾要不要加字幕', '6', '7');
    const marked = await getReviewState(deps(), { workspaceId: ws, projectId: f.projectId });
    expect(marked.round).toMatchObject({ status: 'OPEN', baseRevision: marked.projectRevision, applyTurnId: null, proposalId: null, applyIssue: null });
    expect(marked.notes.map((item) => [item.text, item.status])).toEqual([['开头太拖', 'OPEN'], ['日落那段太暗', 'OPEN'], ['结尾要不要加字幕', 'OPEN']]);
    expect(await reasonOf(applyReview(deps(), { workspaceId: ws, projectId: f.projectId, request: { sessionId: f.session.id } }))).toEqual({ status: 422, reason: REVIEW_ERROR_REASONS.NOTHING_TO_APPLY });

    // 讨论一条批注：同一个导演、同一个工具目录；指向取自批注；改动被拒，只给方案
    const plan = '把开头那段海边剪掉前 1 秒，直接从浪花开始。';
    const talk = await startAgentTurn(deps(), { workspaceId: ws, sessionId: f.session.id, request: { message: '这里怎么改好？', reviewNoteId: noteA.id } });
    expect(talk).toMatchObject({ purpose: 'DISCUSS_NOTE', reviewNoteId: noteA.id, reviewRoundId: marked.round!.id, continuesProposalId: null, pointer: { timeRange: { start: '0', end: '2' }, clipIds: [beachClip.id] } });
    const talked = await run(new ScriptedModel([
      (request) => {
        expect(request.tools.map((tool) => tool.name)).toContain('edit_timeline');
        expect(reviewBlock(request)).toEqual({
          mode: 'DISCUSS_NOTE', reviewedRevision: marked.round!.baseRevision, currentRevision: marked.projectRevision,
          note: { id: noteA.id, note: '开头太拖', at: { start: '0', end: '2' }, clips: [beachClip.id], frameRegion: { x: 0.1, y: 0.1, width: 0.5, height: 0.4 } },
        });
        expect(contextOf(request)).not.toContain('<recent_turns>');
        return reply([{ type: 'tool_use', id: 'd1', name: 'edit_timeline', input: { operations: [{ op: 'trim_clip', clipId: beachClip.id, trimHead: '1' }] } }], 'tool_use');
      },
      (request) => {
        const [result] = toolResults(request);
        expect(result).toMatchObject({ isError: true });
        expect(result!.content).toContain('discusses one review note');
        return reply([{ type: 'text', text: plan }], 'end_turn');
      },
    ]), ws, talk);
    expect(talked).toMatchObject({ status: 'COMPLETED', proposalId: null, reply: plan });
    expect(talked.toolCalls).toEqual([{ name: 'edit_timeline', ok: false, summary: 'discussion only: not applied' }]);
    expect((await listReviewNoteTurns(deps(), { workspaceId: ws, noteId: noteA.id })).map((turn) => turn.id)).toEqual([talk.id]);
    const discussed = (await getReviewState(deps(), { workspaceId: ws, projectId: f.projectId })).notes.find((item) => item.id === noteA.id)!;
    expect(discussed.discussion).toEqual({ turns: 1, lastReply: plan, running: false });

    // 确定：A 按讨论的方案，B 交给 AI 自己决定，C 不改了
    await updateReviewNote(deps(), { workspaceId: ws, noteId: noteA.id, request: { status: 'AGREED', plan } });
    await updateReviewNote(deps(), { workspaceId: ws, noteId: noteB.id, request: { status: 'AGREED' } });
    await updateReviewNote(deps(), { workspaceId: ws, noteId: noteC.id, request: { status: 'DISMISSED' } });

    // 全部执行：一个轮次、一个提案；执行期间批注锁定；同一幂等键重放得到同一轮次
    const applied = await applyReview(deps(), { workspaceId: ws, projectId: f.projectId, request: { sessionId: f.session.id }, idempotencyKey: 'apply-1' });
    expect(applied.round).toMatchObject({ status: 'APPLYING', applyTurnId: applied.turn.id, appliedNoteIds: [noteA.id, noteB.id] });
    expect(applied.turn).toMatchObject({ purpose: 'APPLY_REVIEW', reviewRoundId: marked.round!.id, reviewNoteId: null, continuesProposalId: null, message: '按审片批注一次修改（2 条）' });
    expect((await applyReview(deps(), { workspaceId: ws, projectId: f.projectId, request: { sessionId: f.session.id }, idempotencyKey: 'apply-1' })).turn.id).toBe(applied.turn.id);
    expect(await reasonOf(note('再加一处', '1', '2'))).toEqual({ status: 409, reason: REVIEW_ERROR_REASONS.ROUND_LOCKED });
    expect(await reasonOf(updateReviewNote(deps(), { workspaceId: ws, noteId: noteC.id, request: { status: 'OPEN' } }))).toEqual({ status: 409, reason: REVIEW_ERROR_REASONS.ROUND_LOCKED });
    const applyTurn = await run(new ScriptedModel([
      (request) => {
        const review = reviewBlock(request);
        expect(review.mode).toBe('APPLY_REVIEW');
        expect(review.notes.map((item) => item.id)).toEqual([noteA.id, noteB.id]);
        expect(review.notes[0]).toMatchObject({ agreedPlan: plan, clips: [beachClip.id] });
        expect(review.notes[1]).not.toHaveProperty('agreedPlan');
        expect(contextOf(request)).not.toContain('<recent_turns>');
        return reply([{ type: 'tool_use', id: 'a1', name: 'edit_timeline', input: { operations: [{ op: 'trim_clip', clipId: beachClip.id, trimHead: '1' }, { op: 'fit_length' }] } }], 'tool_use');
      },
      () => reply([{ type: 'text', text: '开头剪掉了 1 秒；日落那段暂时没有调色工具，先保持原样。' }], 'end_turn'),
    ]), ws, applied.turn);
    expect(applyTurn.proposalId).not.toBeNull();
    const ready = await getReviewState(deps(), { workspaceId: ws, projectId: f.projectId });
    expect(ready.round).toMatchObject({ status: 'READY', proposalId: applyTurn.proposalId });
    expect(ready.projectRevision).toBe(marked.projectRevision); // 采用前工程不变

    // 在执行的试改上继续微调（共看片室的普通一轮）：新提案取代它，审片轮跟随到最新的试改
    const refineTurn = await startAgentTurn(deps(), { workspaceId: ws, sessionId: f.session.id, request: { message: '再短一点' } });
    expect(refineTurn).toMatchObject({ purpose: 'EDIT', continuesProposalId: applyTurn.proposalId });
    const refined = await run(new ScriptedModel([
      (request) => {
        expect(contextOf(request)).toContain('"continuesTrial":true');
        expect(contextOf(request)).not.toContain('<review>');
        expect(contextOf(request)).not.toContain('这里怎么改好？'); // 批注讨论不混入普通对话
        return reply([{ type: 'tool_use', id: 'e1', name: 'edit_timeline', input: { operations: [{ op: 'trim_clip', clipId: beachClip.id, trimTail: '0.5' }, { op: 'fit_length' }] } }], 'tool_use');
      },
      () => reply([{ type: 'text', text: '又短了半秒。' }], 'end_turn'),
    ]), ws, refineTurn);
    expect((await getReviewState(deps(), { workspaceId: ws, projectId: f.projectId })).round).toMatchObject({ status: 'READY', proposalId: refined.proposalId });

    await adopt(ws, f.projectId, refined.proposalId!);
    const done = await getReviewState(deps(), { workspaceId: ws, projectId: f.projectId });
    expect(done.round).toMatchObject({ status: 'APPLIED', proposalId: refined.proposalId, appliedRevision: done.projectRevision });
    expect(done.notes.map((item) => item.status)).toEqual(['APPLIED', 'APPLIED', 'DISMISSED']);
    expect((await listProjectComposition(deps(), { workspaceId: ws, projectId: f.projectId })).sequences[0]?.duration).toEqual(mt(5_500));
    expect(await reasonOf(updateReviewNote(deps(), { workspaceId: ws, noteId: noteA.id, request: { text: '改一下' } }))).toEqual({ status: 409, reason: REVIEW_ERROR_REASONS.ROUND_LOCKED });
    expect(await reasonOf(applyReview(deps(), { workspaceId: ws, projectId: f.projectId, request: { sessionId: f.session.id } }))).toEqual({ status: 422, reason: REVIEW_ERROR_REASONS.NOTHING_TO_APPLY });

    // 采用后再标记：在新版本上开新一轮
    const noteD = await note('第二段再亮一点', '3', '4');
    const next = await getReviewState(deps(), { workspaceId: ws, projectId: f.projectId });
    expect(next.round).toMatchObject({ status: 'OPEN', baseRevision: done.projectRevision });
    expect(next.round!.id).not.toBe(marked.round!.id);
    expect(next.notes.map((item) => item.id)).toEqual([noteD.id]);
  });

  it('撤回执行的试改 → 回到可改状态并说明；AI 没做改动如实说明；跨工作区/跨工程 404', async () => {
    const f = await fixture();
    const ws = f.workspaceId;
    const noteA = await addReviewNote(deps(), { workspaceId: ws, projectId: f.projectId, request: { sequenceId: f.sequenceId, pointer: { timeRange: { start: '0', end: '1' }, clipIds: [] }, text: '这里放海边的镜头' } });
    await updateReviewNote(deps(), { workspaceId: ws, noteId: noteA.id, request: { status: 'AGREED' } });
    const first = await applyReview(deps(), { workspaceId: ws, projectId: f.projectId, request: { sessionId: f.session.id } });
    const firstTurn = await run(new ScriptedModel([
      () => reply([{ type: 'tool_use', id: 'p1', name: 'edit_timeline', input: { operations: [{ op: 'place_clip', footageId: f.beach, sourceStart: '0', sourceEnd: '2' }, { op: 'fit_length' }] } }], 'tool_use'),
      () => reply([{ type: 'text', text: '放好了。' }], 'end_turn'),
    ]), ws, first.turn);
    await discardProposal(deps(), { workspaceId: ws, projectId: f.projectId, proposalId: firstTurn.proposalId! });
    const discarded = await getReviewState(deps(), { workspaceId: ws, projectId: f.projectId });
    expect(discarded.round).toMatchObject({ status: 'OPEN', proposalId: null, applyIssue: { kind: 'DISCARDED', reply: '放好了。' } });
    expect(discarded.notes[0]!.status).toBe('AGREED');
    await updateReviewNote(deps(), { workspaceId: ws, noteId: noteA.id, request: { plan: '用海边最开始的 2 秒' } });

    const second = await applyReview(deps(), { workspaceId: ws, projectId: f.projectId, request: { sessionId: f.session.id } });
    expect(second.round.appliedNoteIds).toEqual([noteA.id]);
    await run(new ScriptedModel([() => reply([{ type: 'text', text: '这段素材里没有合适的镜头。' }], 'end_turn')]), ws, second.turn);
    expect((await getReviewState(deps(), { workspaceId: ws, projectId: f.projectId })).round).toMatchObject({ status: 'OPEN', applyIssue: { kind: 'NO_CHANGES', reply: '这段素材里没有合适的镜头。' } });

    const other = await fixture();
    expect(await reasonOf(getReviewState(deps(), { workspaceId: other.workspaceId, projectId: f.projectId }))).toMatchObject({ status: 404 });
    expect(await reasonOf(updateReviewNote(deps(), { workspaceId: other.workspaceId, noteId: noteA.id, request: { status: 'OPEN' } }))).toEqual({ status: 404, reason: REVIEW_ERROR_REASONS.NOTE_NOT_FOUND });
    expect(await reasonOf(startAgentTurn(deps(), { workspaceId: other.workspaceId, sessionId: other.session.id, request: { message: '讨论', reviewNoteId: noteA.id } }))).toEqual({ status: 404, reason: REVIEW_ERROR_REASONS.NOTE_NOT_FOUND });
    expect(await reasonOf(applyReview(deps(), { workspaceId: ws, projectId: f.projectId, request: { sessionId: other.session.id } }))).toMatchObject({ status: 404 });
  });
});
