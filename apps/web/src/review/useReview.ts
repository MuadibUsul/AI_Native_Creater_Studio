'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentLocale, AgentTurn, CreateReviewNoteRequest, ReviewState, StudioState, UpdateReviewNoteRequest } from '@ancs/contracts';
import { useAncsClient } from '@/lib/client';
import { studioKeys } from '@/studio/useStudio';

/**
 * 审片的数据层（一律经 SDK；规则在服务端）：
 * - 审片状态在"一次执行进行中"或"有批注正在讨论"时轮询；
 * - 讨论 = 带 reviewNoteId 的一轮对话（会话语言与界面语言不一致时新开会话，AI 按会话语言回应）；
 * - 采用/撤回执行的试改走提案接口（与共看片室同一套）。
 */

export const reviewKeys = {
  state: (workspaceId: string, projectId: string) => ['review', workspaceId, projectId] as const,
  noteTurns: (workspaceId: string, noteId: string) => ['review', 'note-turns', workspaceId, noteId] as const,
};

const busy = (state: ReviewState | undefined): boolean =>
  state?.round?.status === 'APPLYING' || (state?.notes.some((note) => note.discussion.running) ?? false);

export function useReviewState(workspaceId: string, projectId: string) {
  const client = useAncsClient();
  return useQuery({
    queryKey: reviewKeys.state(workspaceId, projectId),
    queryFn: () => client.review.state(workspaceId, projectId),
    refetchInterval: (query) => (busy(query.state.data) ? 1000 : false),
  });
}

export function useNoteTurns(workspaceId: string, noteId: string | null, running: boolean) {
  const client = useAncsClient();
  return useQuery({
    queryKey: reviewKeys.noteTurns(workspaceId, noteId ?? 'none'),
    queryFn: () => client.review.noteTurns(workspaceId, noteId ?? ''),
    enabled: noteId !== null,
    refetchInterval: (query) => (running || query.state.data?.some((turn) => turn.status === 'RUNNING') ? 1000 : false),
  });
}

export function useReviewProposal(workspaceId: string, projectId: string, proposalId: string | null) {
  const client = useAncsClient();
  return useQuery({
    queryKey: studioKeys.proposal(workspaceId, proposalId ?? 'none'),
    queryFn: () => client.projects.proposal(workspaceId, projectId, proposalId ?? ''),
    enabled: proposalId !== null,
  });
}

const randomKey = (prefix: string): string => `${prefix}-${globalThis.crypto.randomUUID()}`;

export function useReviewActions(workspaceId: string, projectId: string) {
  const client = useAncsClient();
  const queryClient = useQueryClient();
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: reviewKeys.state(workspaceId, projectId) });
  };

  /** 本页使用的 AI 会话：工作台的会话语言与界面一致就沿用，否则按界面语言新开 */
  const sessionFor = async (state: StudioState, locale: AgentLocale) => (state.session !== null && state.session.locale === locale
    ? state.session
    : client.agent.createSession(workspaceId, projectId, { sequenceId: state.sequenceId, locale }, { idempotencyKey: randomKey('session') }));

  const addNote = useMutation({
    mutationFn: (input: CreateReviewNoteRequest) => client.review.addNote(workspaceId, projectId, input, { idempotencyKey: randomKey('note') }),
    onSuccess: refresh,
  });
  const updateNote = useMutation({
    mutationFn: (input: { noteId: string; patch: UpdateReviewNoteRequest }) => client.review.updateNote(workspaceId, input.noteId, input.patch, { idempotencyKey: randomKey('note-update') }),
    onSuccess: refresh,
  });
  const deleteNote = useMutation({
    mutationFn: (noteId: string) => client.review.deleteNote(workspaceId, noteId, { idempotencyKey: randomKey('note-delete') }),
    onSuccess: refresh,
  });
  const discuss = useMutation({
    mutationFn: async (input: { state: StudioState; locale: AgentLocale; noteId: string; message: string }) => {
      const session = await sessionFor(input.state, input.locale);
      return client.agent.startTurn(workspaceId, session.id, { message: input.message, reviewNoteId: input.noteId }, { idempotencyKey: randomKey('discuss') });
    },
    onSuccess: async (turn: AgentTurn) => {
      if (turn.reviewNoteId !== null) {
        queryClient.setQueryData<AgentTurn[]>(reviewKeys.noteTurns(workspaceId, turn.reviewNoteId), (current) => [turn, ...(current ?? []).filter((item) => item.id !== turn.id)]);
      }
      await refresh();
    },
  });
  const apply = useMutation({
    mutationFn: async (input: { state: StudioState; locale: AgentLocale }) => {
      const session = await sessionFor(input.state, input.locale);
      return client.review.apply(workspaceId, projectId, { sessionId: session.id }, { idempotencyKey: randomKey('apply') });
    },
    onSuccess: async () => {
      await refresh();
      await queryClient.invalidateQueries({ queryKey: ['studio', workspaceId, projectId] });
    },
  });
  return { addNote, updateNote, deleteNote, discuss, apply, refresh };
}
