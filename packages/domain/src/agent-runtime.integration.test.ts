import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  AGENT_ERROR_REASONS,
  AgentModelFailure,
  ApiFailure,
  legacyMillisecondsToMediaTime,
  sourceMediaProbeResultSchema,
  type AgentContentBlock,
  type AgentModelAdapter,
  type AgentModelRequest,
  type AgentModelResponse,
  type AgentModelUsage,
} from '@ancs/contracts';
import { agentTurnMessages, assetVersions, assets, compositionCaptionSpans, createDb, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, workflowRuns, workspaces, type DbHandle } from '@ancs/db';
import {
  AGENT_SYSTEM_PROMPT,
  WorkflowRegistry,
  adoptProposal,
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

async function drive(model: AgentModelAdapter, workspaceId: string, runId: string, limits?: Parameters<typeof agentTurnWorkflow>[0]['limits']) {
  const registry = new WorkflowRegistry().register(agentTurnWorkflow({ model, ...(limits === undefined ? {} : { limits }) }));
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
        expect(request.tools.map((tool) => tool.name)).toEqual(['get_timeline', 'list_footage', 'inspect_footage', 'search_footage', 'edit_timeline']);
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
});
