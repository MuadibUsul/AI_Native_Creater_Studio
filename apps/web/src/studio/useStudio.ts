'use client';

import { useCallback, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentLocale, AgentPointer, AgentTurn, Clip, Generation, MediaRange, Proposal, SequencePreview, StudioState, WorkflowRun } from '@ancs/contracts';
import { useAncsClient } from '@/lib/client';

/**
 * 共看片室的数据层：一律经 SDK 读写服务端（不维护第二套工程状态）。
 * - 工作台状态：素材在上传/理解时轮询；
 * - 时间线：按工程版本号读取文档（版本变了才重读）；
 * - 对话：轮次进行中逐秒轮询；
 * - 预览：当前版本或试改提案各请求一次（服务端同计划去重），渲染中轮询。
 */

export const studioKeys = {
  state: (workspaceId: string, projectId: string) => ['studio', workspaceId, projectId] as const,
  document: (projectId: string, revision: number) => ['studio', 'document', projectId, revision] as const,
  turns: (workspaceId: string, sessionId: string) => ['studio', 'turns', workspaceId, sessionId] as const,
  proposal: (workspaceId: string, proposalId: string) => ['studio', 'proposal', workspaceId, proposalId] as const,
  previewRequest: (projectId: string, sequenceId: string, target: string) => ['studio', 'preview-request', projectId, sequenceId, target] as const,
  preview: (workspaceId: string, previewId: string) => ['studio', 'preview', workspaceId, previewId] as const,
  exportRun: (workspaceId: string, runId: string) => ['studio', 'export', workspaceId, runId] as const,
  /** 最新的制作计划（无限画布上的计划画框，AP-04） */
  plan: (workspaceId: string, projectId: string) => ['studio', 'plan', workspaceId, projectId] as const,
  /** 这条视频的导出运行列表（任务中心只读） */
  exports: (workspaceId: string, projectId: string) => ['studio', 'exports', workspaceId, projectId] as const,
};

const footageBusy = (state: StudioState | undefined): boolean =>
  state?.footage.some((item) => item.status === 'UPLOADING' || item.status === 'PROCESSING'
    || Object.values(item.understanding).some((value) => value === 'WORKING')) ?? false;
/** 交给 AI 剪完进行中（V6-9）：轮询进度到交付 */
const autonomyBusy = (state: StudioState | undefined): boolean =>
  state?.autonomousRun !== null && state?.autonomousRun !== undefined && ['WAITING_FOR_FOOTAGE', 'DIRECTING', 'CHECKING'].includes(state.autonomousRun.status);
/** 付费生成进行中（V6-7/V6-8）：轮询到结果出来 */
const generationBusy = (state: StudioState | undefined): boolean => state?.generations.some((item) => item.status === 'RUNNING') ?? false;

export function useStudioState(workspaceId: string, projectId: string) {
  const client = useAncsClient();
  return useQuery({
    queryKey: studioKeys.state(workspaceId, projectId),
    queryFn: () => client.studio.state(workspaceId, projectId),
    refetchInterval: (query) => (footageBusy(query.state.data) || generationBusy(query.state.data) || autonomyBusy(query.state.data) ? 2500 : false),
  });
}

export interface StudioTimeline {
  duration: MediaRange['end'];
  frameRate: { num: number; den: number };
  videoTrackId: string | null;
  audioTrackId: string | null;
  /** 序列里每条画面/声音轨的种类（特效轨等其他画面轨上的片段也要上时间带） */
  trackKinds: ReadonlyMap<string, 'VIDEO' | 'AUDIO'>;
  clips: Clip[];
}

export function useStudioTimeline(projectId: string, sequenceId: string | undefined, revision: number | undefined) {
  const client = useAncsClient();
  const query = useQuery({
    queryKey: studioKeys.document(projectId, revision ?? -1),
    queryFn: () => client.projects.state(projectId, { schemaVersion: '1.0' }),
    enabled: sequenceId !== undefined && revision !== undefined,
    staleTime: Infinity,
    placeholderData: (previous) => previous,
  });
  const timeline = useMemo<StudioTimeline | null>(() => {
    const composition = query.data?.document.composition;
    const sequence = composition?.sequences.find((item) => item.id === sequenceId);
    if (composition === undefined || sequence === undefined) return null;
    const tracks = composition.tracks.filter((track) => track.sequenceId === sequenceId).sort((left, right) => left.position - right.position);
    return {
      duration: sequence.duration,
      frameRate: sequence.frameRate,
      videoTrackId: tracks.find((track) => track.kind === 'VIDEO')?.id ?? null,
      audioTrackId: tracks.find((track) => track.kind === 'AUDIO')?.id ?? null,
      trackKinds: new Map(tracks.flatMap((track) => (track.kind === 'VIDEO' || track.kind === 'AUDIO' ? [[track.id, track.kind] as const] : []))),
      clips: composition.clips.filter((clip) => clip.sequenceId === sequenceId),
    };
  }, [query.data, sequenceId]);
  return { ...query, timeline };
}

export function useStudioTurns(workspaceId: string, sessionId: string | null) {
  const client = useAncsClient();
  return useQuery({
    queryKey: studioKeys.turns(workspaceId, sessionId ?? 'none'),
    queryFn: () => client.agent.listTurns(workspaceId, sessionId ?? ''),
    enabled: sessionId !== null,
    refetchInterval: (query) => (query.state.data?.some((turn) => turn.status === 'RUNNING') ? 1000 : false),
  });
}

/** 最近一轮产生的提案；只有仍 OPEN 时才是"试改"。 */
export function useTrialProposal(workspaceId: string, projectId: string, turn: AgentTurn | undefined) {
  const client = useAncsClient();
  const proposalId = turn?.status === 'COMPLETED' ? turn.proposalId : null;
  return useQuery({
    queryKey: studioKeys.proposal(workspaceId, proposalId ?? 'none'),
    queryFn: () => client.projects.proposal(workspaceId, projectId, proposalId ?? ''),
    enabled: proposalId !== null,
  });
}

const PREVIEW_DONE = new Set<SequencePreview['status']>(['READY', 'FAILED']);

/** 预览：target 为 null 表示不需要预览（时间线为空）。 */
export function useStudioPreview(workspaceId: string, projectId: string, sequenceId: string | undefined, target: { revision: number; proposalId: string | null } | null) {
  const client = useAncsClient();
  const targetKey = target === null ? 'none' : target.proposalId === null ? `rev-${String(target.revision)}` : `proposal-${target.proposalId}`;
  const requested = useQuery({
    queryKey: studioKeys.previewRequest(projectId, sequenceId ?? 'none', targetKey),
    queryFn: () => client.previews.request(workspaceId, projectId, sequenceId ?? '', { proposalId: target?.proposalId ?? null }),
    enabled: target !== null && sequenceId !== undefined,
    staleTime: Infinity,
    gcTime: 10 * 60_000,
  });
  const previewId = requested.data?.id ?? null;
  const preview = useQuery({
    queryKey: studioKeys.preview(workspaceId, previewId ?? 'none'),
    queryFn: () => client.previews.get(workspaceId, previewId ?? ''),
    enabled: previewId !== null,
    initialData: requested.data,
    refetchInterval: (query) => (query.state.data !== undefined && PREVIEW_DONE.has(query.state.data.status) ? false : 800),
  });
  return { request: requested, preview, refresh: () => void preview.refetch(), retry: () => void requested.refetch() };
}

export function useExportRun(workspaceId: string, runId: string | null) {
  const client = useAncsClient();
  return useQuery({
    queryKey: studioKeys.exportRun(workspaceId, runId ?? 'none'),
    queryFn: () => client.workflowRuns.get(workspaceId, runId ?? ''),
    enabled: runId !== null,
    refetchInterval: (query) => (query.state.data === undefined || query.state.data.status === 'RUNNING' || query.state.data.status === 'CANCEL_REQUESTED' ? 1500 : false),
  });
}

/** 导出产物：渲染步骤输出里的成片视频资产。 */
export function exportVideoAssetId(run: WorkflowRun | undefined): string | null {
  const rendered = run?.outputs['render'] as { outputs?: { kind?: string; assetId?: string }[] } | undefined;
  return rendered?.outputs?.find((output) => output.kind === 'VIDEO')?.assetId ?? null;
}

/** 导出时是否加了 AI 生成合成内容标识（成片含 AI 生成的画面、配音或特效时由服务端加上）。 */
export function exportContentLabelled(run: WorkflowRun | undefined): boolean {
  const rendered = run?.outputs['render'] as { contentLabel?: unknown } | undefined;
  return rendered?.contentLabel !== undefined && rendered.contentLabel !== null;
}

/** 用户选用的风格策略（可选）：包 + 旋钮取值。 */
export interface StudioStrategyChoice {
  packId: string;
  knobs: Record<string, string>;
}

export function useStrategyPacks(workspaceId: string) {
  const client = useAncsClient();
  return useQuery({ queryKey: ['studio', 'strategies', workspaceId], queryFn: () => client.agent.strategies(workspaceId), staleTime: 5 * 60_000 });
}

const randomKey = (prefix: string): string => `${prefix}-${globalThis.crypto.randomUUID()}`;

export function useStudioActions(workspaceId: string, projectId: string) {
  const client = useAncsClient();
  const queryClient = useQueryClient();
  const invalidateProject = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ['studio', workspaceId, projectId] });
  }, [queryClient, workspaceId, projectId]);

  /** 说一句话：会话语言与界面语言不一致时新开会话（AI 按会话语言回应）。 */
  const send = useMutation({
    mutationFn: async (input: { state: StudioState; message: string; pointer: AgentPointer; locale: AgentLocale; strategy: StudioStrategyChoice | null; idempotencyKey?: string }) => {
      const session = input.state.session !== null && input.state.session.locale === input.locale
        ? input.state.session
        : await client.agent.createSession(workspaceId, projectId, { sequenceId: input.state.sequenceId, locale: input.locale }, { idempotencyKey: randomKey('session') });
      const turn = await client.agent.startTurn(workspaceId, session.id, {
        message: input.message,
        pointer: input.pointer,
        ...(input.strategy === null ? {} : { strategyPackId: input.strategy.packId, strategyKnobs: input.strategy.knobs }),
      }, { idempotencyKey: input.idempotencyKey ?? randomKey('turn') });
      return { session, turn };
    },
    onSuccess: async ({ session, turn }) => {
      queryClient.setQueryData<AgentTurn[]>(studioKeys.turns(workspaceId, session.id), (current) => [turn, ...(current ?? []).filter((item) => item.id !== turn.id)]);
      await invalidateProject();
    },
  });

  const cancel = useMutation({
    mutationFn: (turn: AgentTurn) => client.agent.cancelTurn(workspaceId, turn.id, { idempotencyKey: randomKey('cancel') }),
    onSuccess: async (turn) => { await queryClient.invalidateQueries({ queryKey: studioKeys.turns(workspaceId, turn.sessionId) }); },
  });

  const adopt = useMutation({
    mutationFn: (proposal: Proposal) => client.projects.adoptProposal(workspaceId, projectId, proposal.proposalId, {
      expectedOperationsHash: proposal.operationsHash,
      expectedSelectionFingerprint: proposal.selectionFingerprint,
      idempotencyKey: randomKey('adopt'),
    }),
    onSuccess: async (result) => {
      queryClient.setQueryData(studioKeys.proposal(workspaceId, result.proposal.proposalId), result.proposal);
      await invalidateProject();
    },
  });

  const discard = useMutation({
    mutationFn: (proposal: Proposal) => client.projects.discardProposal(workspaceId, projectId, proposal.proposalId, {}, { idempotencyKey: randomKey('discard') }),
    onSuccess: (proposal) => { queryClient.setQueryData(studioKeys.proposal(workspaceId, proposal.proposalId), proposal); },
  });

  const undoChange = useMutation({
    mutationFn: () => client.studio.undoChange(workspaceId, projectId, { idempotencyKey: randomKey('undo') }),
    onSuccess: invalidateProject,
  });

  const startExport = useMutation({
    mutationFn: (input: { sequenceId: string; width: number; height: number; revision: number }) =>
      client.finalRenders.start(workspaceId, projectId, input.sequenceId, { profile: { width: input.width, height: input.height }, expectedRevision: input.revision }, { idempotencyKey: randomKey('export') }),
    // 任务中心的导出列表随之刷新（进行中时它自己每 5 秒轮询到结束）
    onSuccess: () => queryClient.invalidateQueries({ queryKey: studioKeys.exports(workspaceId, projectId) }),
  });

  /** 项目制作规则：开/关程序化特效（V6-3；用户显式操作，服务端记事件） */
  const setEffectsAllowed = useMutation({
    mutationFn: (allowed: boolean) => client.studio.updateProductionPolicy(workspaceId, projectId, { allowProceduralGraphics: allowed }, { idempotencyKey: randomKey('policy') }),
    onSuccess: invalidateProject,
  });

  /** 项目制作规则：开/关 AI 合成配音讲述（V6-5；用户显式操作，服务端记事件） */
  const setNarrationAllowed = useMutation({
    mutationFn: (allowed: boolean) => client.studio.updateProductionPolicy(workspaceId, projectId, { allowGeneratedSpeech: allowed }, { idempotencyKey: randomKey('policy') }),
    onSuccess: invalidateProject,
  });

  /** 项目制作规则：开/关付费生成画面（V6-7/V6-8；每次生成仍需确认报价） */
  const setGenerationAllowed = useMutation({
    mutationFn: (allowed: boolean) => client.studio.updateProductionPolicy(workspaceId, projectId, { allowGeneratedVideo: allowed }, { idempotencyKey: randomKey('policy') }),
    onSuccess: invalidateProject,
  });

  /** 确认报价：带上卡片上展示的报价上限；开始后出现一轮"确认生成"，结果作为试改回来 */
  const acceptGeneration = useMutation({
    mutationFn: (generation: Generation) => client.generations.accept(workspaceId, projectId, generation.id, { expectedMaxMicros: generation.estimate.maxMicros }, { idempotencyKey: randomKey('generation') }),
    onSuccess: async (generation) => {
      await invalidateProject();
      if (generation.sessionId !== null) await queryClient.invalidateQueries({ queryKey: studioKeys.turns(workspaceId, generation.sessionId) });
    },
  });

  const declineGeneration = useMutation({
    mutationFn: (generation: Generation) => client.generations.decline(workspaceId, projectId, generation.id, { idempotencyKey: randomKey('generation-decline') }),
    onSuccess: invalidateProject,
  });

  return { send, cancel, adopt, discard, undoChange, startExport, setEffectsAllowed, setNarrationAllowed, setGenerationAllowed, acceptGeneration, declineGeneration, invalidateProject };
}
