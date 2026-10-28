import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  AGENT_ERROR_REASONS,
  legacyMillisecondsToMediaTime,
  sourceMediaProbeResultSchema,
  type AgentModelAdapter,
  type AgentModelRequest,
  type AgentModelResponse,
} from '@ancs/contracts';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { assetVersions, assets, createDb, resolveTestDatabaseUrl, runMigrations, workflowRuns, type DbHandle } from '@ancs/db';
import { WorkflowRegistry, advanceWorkflow, agentTurnWorkflow, createProject, createSequence, unconfiguredAgentModel } from '@ancs/domain';
import { buildServer } from './server.js';

/**
 * V6-1a 验收（HTTP + SDK + 真实数据库；Worker 侧在进程内用脚本模型推进——不是真实 Provider）：
 * - 开会话 → 说一句话（202，RUNNING）→ Worker 推进 → 轮次 COMPLETED，回应 + 提案；采用后时间线落地；
 * - 统一工具目录对外可见；幂等键 → 同一轮次；同会话并发 409；
 * - 未配置导演模型 → 轮次 FAILED（AGENT_MODEL_NOT_CONFIGURED），不回退 Mock；
 * - 取消进行中的轮次；VIEWER 不能说话（403）；跨工作区 404。
 */

const PASSWORD = 'password-1234';
let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;

beforeAll(async () => {
  handle = createDb(resolveTestDatabaseUrl());
  await runMigrations(handle);
  auth = createAuth({ db: handle.db, secret: 'agent-http-secret-0123456789abcdef', baseUrl: 'http://localhost:3001' }); // secrets:check-ignore：测试专用假密钥（非真实凭据）
  app = await buildServer({ auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${String((app.server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await app.close();
  await handle.close();
});

async function signedIn(email = `agent-${randomUUID()}@test.local`): Promise<AncsClient> {
  await createInternalUser(auth, { email, password: PASSWORD, name: 'AI 导演测试' });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: PASSWORD });
  return client;
}

async function footageProject(client: AncsClient) {
  const workspace = await client.workspaces.create({ name: `导演-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '旅行' });
  const project = await createProject({ db: handle.db }, { workspaceId: workspace.id, input: { title: '山里', channelId: channel.id, mode: 'FOOTAGE_EDIT', brief: {} } });
  const sequence = await createSequence({ db: handle.db }, { workspaceId: workspace.id, projectId: project.id, input: { name: '主序列', frameRate: { num: 30, den: 1 }, duration: legacyMillisecondsToMediaTime(1_000) } });
  const assetId = `ast_${randomUUID()}`;
  const footageId = `av_${randomUUID()}`;
  await handle.db.insert(assets).values({
    id: assetId, workspaceId: workspace.id, projectId: project.id, assetType: 'UPLOADED_VIDEO', origin: 'USER_UPLOAD', status: 'READY',
    retentionClass: 'PROJECT', license: { kind: 'OWNED' }, currentVersionId: footageId, metadata: { filename: 'trail.mp4' },
  });
  await handle.db.insert(assetVersions).values({
    id: footageId, assetId, workspaceId: workspace.id, versionNumber: 1, storageKey: `v6-1a/${footageId}.mp4`, mimeType: 'video/mp4', sizeBytes: 2048,
    checksumSha256: 'c'.repeat(64), durationMs: 9_000, width: 1920, height: 1080, status: 'READY',
    mediaProbe: sourceMediaProbeResultSchema.parse({
      schemaVersion: '1.0', status: 'READY', formatNames: ['mp4'], formatLongName: 'QuickTime / MOV', startTimeMs: 0, durationMs: 9_000, bitRate: 92_000,
      streams: [{
        index: 0, type: 'VIDEO', codecName: 'h264', codecLongName: 'H.264', profile: 'High', timeBase: { numerator: 1, denominator: 15_360 }, startPts: '0',
        durationTicks: '138240', durationMs: 9_000, width: 1920, height: 1080, rotationDegrees: 0, pixelFormat: 'yuv420p', colorRange: 'tv', colorSpace: 'bt709',
        colorTransfer: 'bt709', colorPrimaries: 'bt709', nominalFrameRate: { numerator: 30, denominator: 1 }, averageFrameRate: { numerator: 30, denominator: 1 },
        frameCount: '270', sampleRate: null, channels: null, channelLayout: null, cadence: 'CONSTANT', sampledPacketCount: 30, sampledPtsDeltaTicks: ['512'],
      }],
      decodeCheck: { status: 'PASSED', errorCode: null, message: null },
      capabilities: { upload: 'AVAILABLE', decode: 'AVAILABLE', preview: 'AVAILABLE', export: 'AVAILABLE', reasons: [] },
    }),
  });
  return { workspaceId: workspace.id, projectId: project.id, sequenceId: sequence.id, footageId };
}

/** Worker 侧（进程内）：用给定模型推进轮次的工作流到终态。 */
async function runWorker(model: AgentModelAdapter, workspaceId: string, runId: string): Promise<string> {
  const registry = new WorkflowRegistry().register(agentTurnWorkflow({ model }));
  for (let index = 0; index < 10; index += 1) {
    const row = (await handle.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)))[0]!;
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(row.status)) return row.status;
    await advanceWorkflow({ db: handle.db }, registry, { workspaceId, runId, jobId: row.activeJobId! });
  }
  throw new Error('workflow did not finish');
}

function scripted(steps: ((request: AgentModelRequest) => AgentModelResponse)[]): AgentModelAdapter {
  let call = 0;
  return {
    providerId: 'scripted', implementation: 'SCRIPTED', model: 'scripted-director',
    respond: (request) => {
      const step = steps[call];
      call += 1;
      return step === undefined ? Promise.reject(new Error('no step')) : Promise.resolve(step(request));
    },
  };
}
const zero = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };

async function expectApiError(promise: Promise<unknown>, status: number, reason?: string): Promise<void> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AncsApiError);
  expect((error as AncsApiError).status).toBe(status);
  if (reason !== undefined) expect((error as AncsApiError).details['reason']).toBe(reason);
}

describe('AI 导演 HTTP 面（V6-1a）', () => {
  it('说一句话 → 202 → Worker 推进 → 回应 + 提案 → 采用后时间线落地；工具目录可见；幂等与并发', async () => {
    const owner = await signedIn();
    const f = await footageProject(owner);
    const tools = await owner.agent.tools(f.workspaceId);
    expect(tools.map((tool) => `${tool.name}:${tool.effect}`)).toEqual(['get_timeline:READ', 'plan_production:PLAN', 'get_production_plan:READ', 'list_footage:READ', 'inspect_footage:READ', 'look_at_footage:READ', 'search_footage:READ', 'find_edit_points:READ', 'edit_timeline:DRAFT_EDIT', 'caption_speech:DRAFT_EDIT', 'review_draft:READ', 'measure_pace:READ', 'look_at_timeline:READ', 'list_effects:READ', 'add_effect:DRAFT_EDIT', 'update_effect:DRAFT_EDIT', 'list_voices:READ', 'add_narration:DRAFT_EDIT', 'remove_narration:DRAFT_EDIT', 'read_article:READ', 'list_generation_options:READ', 'quote_generation:GENERATE']);
    expect(tools.find((tool) => tool.name === 'edit_timeline')?.inputSchema).toHaveProperty('properties.operations');

    const session = await owner.agent.createSession(f.workspaceId, f.projectId, { sequenceId: f.sequenceId, locale: 'en' });
    expect(session.locale).toBe('en');
    const key = `turn-${randomUUID()}`;
    const body = { message: 'Make a 5 second teaser', pointer: { timeRange: { start: '0', end: '1' }, clipIds: [] } };
    const turn = await owner.agent.startTurn(f.workspaceId, session.id, body, { idempotencyKey: key });
    expect(turn).toMatchObject({ status: 'RUNNING', reply: null, proposalId: null });
    // 同一幂等键 + 同一内容 → 同一轮次（不同内容复用键由 HTTP 幂等层拒绝）
    expect((await owner.agent.startTurn(f.workspaceId, session.id, body, { idempotencyKey: key })).id).toBe(turn.id);
    await expectApiError(owner.agent.startTurn(f.workspaceId, session.id, { message: 'another' }, { idempotencyKey: `turn-${randomUUID()}` }), 409, AGENT_ERROR_REASONS.TURN_IN_PROGRESS);

    const model = scripted([
      (request) => {
        expect((request.messages[0]!.content[0] as { text: string }).text).toContain('"timeRange":{"start":"0","end":"1"}');
        return { model: 'scripted-director', stopReason: 'tool_use', usage: zero, content: [{ type: 'tool_use', id: 'e1', name: 'edit_timeline', input: { operations: [
          { op: 'place_clip', footageId: f.footageId, sourceStart: '2', sourceEnd: '7' },
          { op: 'fit_length' },
        ] } }] };
      },
      () => ({ model: 'scripted-director', stopReason: 'end_turn', usage: zero, content: [{ type: 'text', text: 'Done: a 5 second teaser from the trail shot.' }] }),
    ]);
    expect(await runWorker(model, f.workspaceId, turn.workflowRunId!)).toBe('SUCCEEDED');
    const finished = await owner.agent.getTurn(f.workspaceId, turn.id);
    expect(finished).toMatchObject({ status: 'COMPLETED', reply: 'Done: a 5 second teaser from the trail shot.' });
    expect((await owner.agent.listTurns(f.workspaceId, session.id)).map((item) => item.id)).toEqual([turn.id]);
    // 这条视频的 AI 成本：脚本模型没有价格 → 总额为空（不填零），调用次数如实
    expect(await owner.agent.projectCost(f.workspaceId, f.projectId)).toMatchObject({ turns: 1, costMicros: null, unpricedCalls: 2 });

    // 低清预览：提案试改预览（202，工程不变）；同计划去重；最新版本预览在请求前 404
    await expectApiError(owner.previews.latest(f.workspaceId, f.projectId, f.sequenceId), 404);
    const trialPreview = await owner.previews.request(f.workspaceId, f.projectId, f.sequenceId, { proposalId: finished.proposalId }, { idempotencyKey: `pv-${randomUUID()}` });
    expect(trialPreview).toMatchObject({ status: 'QUEUED', source: 'PROPOSAL', proposalId: finished.proposalId, width: 960, height: 540, playbackUrl: null });
    expect((await owner.previews.request(f.workspaceId, f.projectId, f.sequenceId, { proposalId: finished.proposalId }, { idempotencyKey: `pv-${randomUUID()}` })).id).toBe(trialPreview.id);
    expect((await owner.previews.get(f.workspaceId, trialPreview.id)).id).toBe(trialPreview.id);

    const proposal = await owner.projects.proposal(f.workspaceId, f.projectId, finished.proposalId!);
    const preview = await owner.projects.previewProposal(f.workspaceId, f.projectId, proposal.proposalId, { idempotencyKey: `preview-${randomUUID()}` });
    expect(preview.operationsHash).toBe(proposal.operationsHash);
    await owner.projects.adoptProposal(f.workspaceId, f.projectId, proposal.proposalId, { expectedOperationsHash: proposal.operationsHash, expectedSelectionFingerprint: null, idempotencyKey: `adopt-${randomUUID()}` });
    // 采用后提案不再 OPEN：再请求它的试改预览 → 409
    await expectApiError(owner.previews.request(f.workspaceId, f.projectId, f.sequenceId, { proposalId: proposal.proposalId }, { idempotencyKey: `pv-${randomUUID()}` }), 409, 'PREVIEW_PROPOSAL_STALE');
    const current = await owner.previews.request(f.workspaceId, f.projectId, f.sequenceId, {}, { idempotencyKey: `pv-${randomUUID()}` });
    // 采用后的当前版本与刚预览过的提案是同一计划 → 命中同一预览（不重渲；记录保留它最初的来源）
    expect(current.id).toBe(trialPreview.id);
    expect(current.planHash).toBe(trialPreview.planHash);
    const state = await owner.projects.state(f.projectId, { schemaVersion: '1.0' });
    expect(state.document.composition.sequences.find((item) => item.id === f.sequenceId)?.duration).toEqual(legacyMillisecondsToMediaTime(5_000));
    expect(state.document.composition.clips.map((clip) => [clip.assetVersionId, clip.sequenceRange.start.ticks, clip.sequenceRange.end.ticks])).toEqual([[f.footageId, '0', '5000']]);
  }, 60_000);

  it('未配置导演模型 → 轮次明确失败；取消进行中的轮次；VIEWER 403；跨工作区 404', async () => {
    const owner = await signedIn();
    const f = await footageProject(owner);
    const session = await owner.agent.createSession(f.workspaceId, f.projectId, { sequenceId: f.sequenceId });
    const turn = await owner.agent.startTurn(f.workspaceId, session.id, { message: '剪一版' }, { idempotencyKey: `t-${randomUUID()}` });
    expect(await runWorker(unconfiguredAgentModel(), f.workspaceId, turn.workflowRunId!)).toBe('FAILED');
    const failed = await owner.agent.getTurn(f.workspaceId, turn.id);
    expect(failed.status).toBe('FAILED');
    expect(JSON.stringify(failed.error)).toContain(AGENT_ERROR_REASONS.MODEL_NOT_CONFIGURED);
    await expectApiError(owner.agent.cancelTurn(f.workspaceId, turn.id, { idempotencyKey: `c-${randomUUID()}` }), 409);

    const running = await owner.agent.startTurn(f.workspaceId, session.id, { message: '再来一个' }, { idempotencyKey: `t-${randomUUID()}` });
    await owner.agent.cancelTurn(f.workspaceId, running.id, { idempotencyKey: `c-${randomUUID()}` });
    expect(await runWorker(scripted([]), f.workspaceId, running.workflowRunId!)).toBe('CANCELLED');
    expect((await owner.agent.getTurn(f.workspaceId, running.id)).status).toBe('CANCELLED');

    const viewerEmail = `agent-viewer-${randomUUID()}@test.local`;
    const viewer = await signedIn(viewerEmail);
    await owner.workspaces.members.add(f.workspaceId, { email: viewerEmail, role: 'VIEWER' });
    expect((await viewer.agent.getTurn(f.workspaceId, turn.id)).id).toBe(turn.id);
    await expectApiError(viewer.agent.startTurn(f.workspaceId, session.id, { message: 'hi' }, { idempotencyKey: `v-${randomUUID()}` }), 403);

    const stranger = await signedIn();
    const strangerWorkspace = await stranger.workspaces.create({ name: `外部-${randomUUID().slice(0, 8)}` });
    await expectApiError(stranger.agent.getTurn(f.workspaceId, turn.id), 404);
    await expectApiError(stranger.agent.getSession(strangerWorkspace.id, session.id), 404);
    await expectApiError(stranger.agent.getTurn(strangerWorkspace.id, turn.id), 404);
  }, 60_000);
});
