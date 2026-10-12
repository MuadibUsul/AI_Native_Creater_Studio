import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  REVIEW_ERROR_REASONS,
  applyReviewRequestSchema,
  createReviewNoteRequestSchema,
  reviewNoteSchema,
  reviewRoundSchema,
  reviewStateSchema,
  updateReviewNoteRequestSchema,
  type AgentTurn,
  type ApplyReviewRequest,
  type ApplyReviewResponse,
  type CreateReviewNoteRequest,
  type ReviewNote,
  type ReviewRound,
  type ReviewState,
  type UpdateReviewNoteRequest,
} from '@ancs/contracts';
import { agentSessions, agentTurns, projectSequences, projects, proposals, reviewNotes, reviewRounds } from '@ancs/db';
import type { DomainDeps } from './deps.js';
import { agentTurnIdFor, getAgentTurn, startAgentTurn } from './agent-runtime.js';

/**
 * V6 §5.4 批注式审片（V6-4）。
 *
 * 1. 看片时逐处标记问题（定位 + 一句话）——批注属于一轮审片，一轮绑定所看的工程版本；
 * 2. 逐条和 AI 讨论修改方案（DISCUSS_NOTE 轮次：同一个通用导演，只给方案不改时间线），用户确定方案；
 * 3. 全部确定后一次执行（APPLY_REVIEW 轮次）：所有已确定的批注在一个草稿里做完 → 一个试改提案 →
 *    预览只重渲改动到的分段 → 用户采用后成为新版本。
 *
 * 轮次状态不另存，由执行轮与它的提案（含被继续微调后取代的链）派生，避免与真实状态不一致。
 * 执行进行中或试改待采用时，批注锁定（先采用或撤回再改）。
 */

type RoundRow = typeof reviewRounds.$inferSelect;
type NoteRow = typeof reviewNotes.$inferSelect;

interface DerivedRound {
  round: ReviewRound;
  appliedNoteIds: Set<string>;
}

const locked = (status: ReviewRound['status']): boolean => status === 'APPLYING' || status === 'READY';

async function requireProject(deps: DomainDeps, workspaceId: string, projectId: string): Promise<{ revision: number }> {
  const rows = await deps.db.select({ revision: projects.revision }).from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId), isNull(projects.deletedAt))).limit(1);
  if (rows[0] === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'project not found', 404);
  return rows[0];
}

/** 执行轮的提案若被"在试改上继续微调"取代，沿取代链找到最新的那一份。 */
async function followProposal(deps: DomainDeps, proposalId: string) {
  let currentId = proposalId;
  for (let hop = 0; hop < 20; hop += 1) {
    const rows = await deps.db.select({ id: proposals.id, status: proposals.status, committedRevision: proposals.committedRevision, supersededBy: proposals.supersededByProposalId })
      .from(proposals).where(eq(proposals.id, currentId)).limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    if (row.status !== 'SUPERSEDED' || row.supersededBy === null) return row;
    currentId = row.supersededBy;
  }
  return null;
}

async function deriveRound(deps: DomainDeps, row: RoundRow): Promise<DerivedRound> {
  const base = {
    id: row.id, projectId: row.projectId, sequenceId: row.sequenceId, baseRevision: row.baseRevision,
    applyTurnId: row.applyTurnId, appliedNoteIds: row.appliedNoteIds as string[], createdAt: row.createdAt.toISOString(),
  };
  const open = (applyIssue: ReviewRound['applyIssue'] = null): DerivedRound => ({
    round: reviewRoundSchema.parse({ ...base, status: 'OPEN', proposalId: null, appliedRevision: null, applyIssue }),
    appliedNoteIds: new Set(),
  });
  if (row.applyTurnId === null) return open();
  const turns = await deps.db.select({ status: agentTurns.status, proposalId: agentTurns.proposalId, reply: agentTurns.reply, error: agentTurns.error })
    .from(agentTurns).where(eq(agentTurns.id, row.applyTurnId)).limit(1);
  const turn = turns[0];
  if (turn === undefined) return open();
  if (turn.status === 'RUNNING') {
    return { round: reviewRoundSchema.parse({ ...base, status: 'APPLYING', proposalId: null, appliedRevision: null, applyIssue: null }), appliedNoteIds: new Set() };
  }
  if (turn.status === 'FAILED' || turn.status === 'CANCELLED') {
    return open({ kind: turn.status, reply: turn.reply, error: (turn.error as Record<string, unknown> | null) ?? null });
  }
  if (turn.proposalId === null) return open({ kind: 'NO_CHANGES', reply: turn.reply, error: null });
  const proposal = await followProposal(deps, turn.proposalId);
  if (proposal !== null && proposal.status === 'OPEN') {
    return { round: reviewRoundSchema.parse({ ...base, status: 'READY', proposalId: proposal.id, appliedRevision: null, applyIssue: null }), appliedNoteIds: new Set() };
  }
  if (proposal !== null && proposal.status === 'COMMITTED') {
    return {
      round: reviewRoundSchema.parse({ ...base, status: 'APPLIED', proposalId: proposal.id, appliedRevision: proposal.committedRevision, applyIssue: null }),
      appliedNoteIds: new Set(row.appliedNoteIds as string[]),
    };
  }
  return open({ kind: 'DISCARDED', reply: turn.reply, error: null });
}

async function toNotes(deps: DomainDeps, rows: NoteRow[], appliedNoteIds: Set<string>): Promise<ReviewNote[]> {
  const ids = rows.map((row) => row.id);
  const discussion = ids.length === 0 ? [] : await deps.db.select({ noteId: agentTurns.reviewNoteId, status: agentTurns.status, reply: agentTurns.reply, createdAt: agentTurns.createdAt })
    .from(agentTurns).where(and(inArray(agentTurns.reviewNoteId, ids), eq(agentTurns.purpose, 'DISCUSS_NOTE'))).orderBy(desc(agentTurns.createdAt));
  return rows.map((row) => {
    const turns = discussion.filter((turn) => turn.noteId === row.id);
    const lastReply = turns.find((turn) => turn.status === 'COMPLETED' && turn.reply !== null)?.reply ?? null;
    return reviewNoteSchema.parse({
      id: row.id,
      roundId: row.roundId,
      pointer: row.pointer,
      region: row.region ?? null,
      text: row.text,
      status: row.status === 'AGREED' && appliedNoteIds.has(row.id) ? 'APPLIED' : row.status,
      plan: row.plan,
      discussion: { turns: turns.length, lastReply, running: turns.some((turn) => turn.status === 'RUNNING') },
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });
  });
}

async function latestRound(deps: DomainDeps, workspaceId: string, projectId: string): Promise<RoundRow | null> {
  const rows = await deps.db.select().from(reviewRounds)
    .where(and(eq(reviewRounds.projectId, projectId), eq(reviewRounds.workspaceId, workspaceId)))
    .orderBy(desc(reviewRounds.createdAt)).limit(1);
  return rows[0] ?? null;
}

/** 审片状态：最近一轮 + 它的批注（按时间位置排序由客户端决定，这里按标记先后）。 */
export async function getReviewState(deps: DomainDeps, input: { workspaceId: string; projectId: string }): Promise<ReviewState> {
  const project = await requireProject(deps, input.workspaceId, input.projectId);
  const row = await latestRound(deps, input.workspaceId, input.projectId);
  if (row === null) return reviewStateSchema.parse({ projectRevision: project.revision, round: null, notes: [] });
  const derived = await deriveRound(deps, row);
  const notes = await deps.db.select().from(reviewNotes).where(eq(reviewNotes.roundId, row.id)).orderBy(reviewNotes.createdAt);
  return reviewStateSchema.parse({ projectRevision: project.revision, round: derived.round, notes: await toNotes(deps, notes, derived.appliedNoteIds) });
}

/**
 * 标记一处问题。没有进行中的审片轮（从未审片，或上一轮已采用）→ 在当前工程版本上开新一轮；
 * 一次执行进行中或试改待采用 → 409（先采用或撤回）。
 */
export async function addReviewNote(deps: DomainDeps, input: {
  workspaceId: string;
  projectId: string;
  request: CreateReviewNoteRequest;
  createdBy?: string | null;
}): Promise<ReviewNote> {
  const request = createReviewNoteRequestSchema.parse(input.request);
  const project = await requireProject(deps, input.workspaceId, input.projectId);
  const sequence = await deps.db.select({ id: projectSequences.id }).from(projectSequences)
    .where(and(eq(projectSequences.id, request.sequenceId), eq(projectSequences.projectId, input.projectId))).limit(1);
  if (sequence[0] === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'sequence not found', 404);
  let round = await latestRound(deps, input.workspaceId, input.projectId);
  if (round !== null) {
    const derived = await deriveRound(deps, round);
    if (locked(derived.round.status)) throw lockedFailure(derived.round.status);
    if (derived.round.status === 'APPLIED') round = null;
    else if (round.sequenceId !== request.sequenceId) throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'this review round is for another sequence', 409, { reason: REVIEW_ERROR_REASONS.SEQUENCE_MISMATCH });
  }
  if (round === null) {
    const [created] = await deps.db.insert(reviewRounds).values({
      id: `rvr_${randomUUID()}`, workspaceId: input.workspaceId, projectId: input.projectId, sequenceId: request.sequenceId,
      baseRevision: project.revision, createdBy: input.createdBy ?? null,
    }).returning();
    if (created === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'review round insert failed', 500);
    round = created;
  }
  const [row] = await deps.db.insert(reviewNotes).values({
    id: `rvn_${randomUUID()}`, workspaceId: input.workspaceId, projectId: input.projectId, roundId: round.id,
    pointer: request.pointer, region: request.region, text: request.text, createdBy: input.createdBy ?? null,
  }).returning();
  if (row === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'review note insert failed', 500);
  const [note] = await toNotes(deps, [row], new Set());
  return note!;
}

function lockedFailure(status: ReviewRound['status']): ApiFailure {
  return new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, status === 'APPLYING'
    ? 'the review notes are being applied; wait for the result'
    : 'the applied review notes are waiting to be kept or discarded', 409, { reason: REVIEW_ERROR_REASONS.ROUND_LOCKED, status });
}

async function loadNote(deps: DomainDeps, workspaceId: string, noteId: string): Promise<{ note: NoteRow; round: RoundRow; derived: DerivedRound }> {
  const rows = await deps.db.select().from(reviewNotes).where(and(eq(reviewNotes.id, noteId), eq(reviewNotes.workspaceId, workspaceId))).limit(1);
  const note = rows[0];
  if (note === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'review note not found', 404, { reason: REVIEW_ERROR_REASONS.NOTE_NOT_FOUND });
  const rounds = await deps.db.select().from(reviewRounds).where(eq(reviewRounds.id, note.roundId)).limit(1);
  const round = rounds[0];
  if (round === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'review note not found', 404, { reason: REVIEW_ERROR_REASONS.NOTE_NOT_FOUND });
  return { note, round, derived: await deriveRound(deps, round) };
}

/** 改批注文字、确定/改方案、标为"不改了"或重新打开。已执行过的轮次与锁定期间不可改。 */
export async function updateReviewNote(deps: DomainDeps, input: { workspaceId: string; noteId: string; request: UpdateReviewNoteRequest }): Promise<ReviewNote> {
  const request = updateReviewNoteRequestSchema.parse(input.request);
  const { derived } = await loadNote(deps, input.workspaceId, input.noteId);
  if (locked(derived.round.status)) throw lockedFailure(derived.round.status);
  if (derived.round.status === 'APPLIED') throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'this review round has been applied', 409, { reason: REVIEW_ERROR_REASONS.ROUND_LOCKED, status: 'APPLIED' });
  const [row] = await deps.db.update(reviewNotes).set({
    ...(request.text === undefined ? {} : { text: request.text }),
    ...(request.plan === undefined ? {} : { plan: request.plan === null || request.plan === '' ? null : request.plan }),
    ...(request.status === undefined ? {} : { status: request.status }),
    updatedAt: new Date(),
  }).where(eq(reviewNotes.id, input.noteId)).returning();
  if (row === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'review note not found', 404, { reason: REVIEW_ERROR_REASONS.NOTE_NOT_FOUND });
  const [note] = await toNotes(deps, [row], new Set());
  return note!;
}

export async function deleteReviewNote(deps: DomainDeps, input: { workspaceId: string; noteId: string }): Promise<void> {
  const { derived } = await loadNote(deps, input.workspaceId, input.noteId);
  if (locked(derived.round.status)) throw lockedFailure(derived.round.status);
  if (derived.round.status === 'APPLIED') throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'this review round has been applied', 409, { reason: REVIEW_ERROR_REASONS.ROUND_LOCKED, status: 'APPLIED' });
  await deps.db.delete(reviewNotes).where(eq(reviewNotes.id, input.noteId));
}

/** 一条批注的讨论（新→旧）。 */
export async function listReviewNoteTurns(deps: DomainDeps, input: { workspaceId: string; noteId: string }): Promise<AgentTurn[]> {
  await loadNote(deps, input.workspaceId, input.noteId);
  const rows = await deps.db.select({ id: agentTurns.id }).from(agentTurns)
    .where(and(eq(agentTurns.reviewNoteId, input.noteId), eq(agentTurns.workspaceId, input.workspaceId), eq(agentTurns.purpose, 'DISCUSS_NOTE')))
    .orderBy(desc(agentTurns.createdAt)).limit(50);
  return Promise.all(rows.map((row) => getAgentTurn(deps, { workspaceId: input.workspaceId, turnId: row.id })));
}

const APPLY_MESSAGES = {
  'zh-CN': (count: number) => `按审片批注一次修改（${String(count)} 条）`,
  en: (count: number) => `Apply the review notes in one pass (${String(count)} ${count === 1 ? 'note' : 'notes'})`,
} as const;

/**
 * 全部执行：把这一轮里已确定的批注交给 AI 一次做完（一个 APPLY_REVIEW 轮次 → 一个试改提案）。
 * 没有已确定的批注 → 422；执行进行中/试改待采用 → 409；已采用的轮次 → 409（新标记会开新一轮）。
 */
export async function applyReview(deps: DomainDeps, input: {
  workspaceId: string;
  projectId: string;
  request: ApplyReviewRequest;
  createdBy?: string | null;
  idempotencyKey?: string | null;
}): Promise<ApplyReviewResponse> {
  const request = applyReviewRequestSchema.parse(input.request);
  await requireProject(deps, input.workspaceId, input.projectId);
  const row = await latestRound(deps, input.workspaceId, input.projectId);
  if (row === null) throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'there are no review notes to apply', 422, { reason: REVIEW_ERROR_REASONS.NOTHING_TO_APPLY });
  const derived = await deriveRound(deps, row);
  if (derived.round.status === 'APPLIED') {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'this review round has already been applied; new notes start a new round', 422, { reason: REVIEW_ERROR_REASONS.NOTHING_TO_APPLY });
  }
  if (derived.round.status !== 'OPEN') {
    // 幂等重放：同一个幂等键已经发起过这次执行 → 返回同一轮次
    if (row.applyTurnId !== null && input.idempotencyKey !== null && input.idempotencyKey !== undefined
      && row.applyTurnId === agentTurnIdFor(request.sessionId, `review-apply:${input.idempotencyKey}`)) {
      return { round: derived.round, turn: await getAgentTurn(deps, { workspaceId: input.workspaceId, turnId: row.applyTurnId }) };
    }
    throw lockedFailure(derived.round.status);
  }
  const sessions = await deps.db.select().from(agentSessions)
    .where(and(eq(agentSessions.id, request.sessionId), eq(agentSessions.workspaceId, input.workspaceId))).limit(1);
  const session = sessions[0];
  if (session === undefined || session.projectId !== input.projectId) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'agent session not found', 404);
  if (session.sequenceId !== row.sequenceId) throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'the session works on another sequence', 409, { reason: REVIEW_ERROR_REASONS.SEQUENCE_MISMATCH });
  const agreed = await deps.db.select({ id: reviewNotes.id }).from(reviewNotes)
    .where(and(eq(reviewNotes.roundId, row.id), eq(reviewNotes.status, 'AGREED'))).orderBy(reviewNotes.createdAt);
  if (agreed.length === 0) throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'no review note has an agreed fix yet', 422, { reason: REVIEW_ERROR_REASONS.NOTHING_TO_APPLY });

  const locale = session.locale === 'en' ? 'en' : 'zh-CN';
  const turn = await startAgentTurn(deps, {
    workspaceId: input.workspaceId,
    sessionId: session.id,
    request: { message: APPLY_MESSAGES[locale](agreed.length), pointer: { timeRange: null, clipIds: [] } },
    review: { purpose: 'APPLY_REVIEW', roundId: row.id, noteIds: agreed.map((note) => note.id), expectedApplyTurnId: row.applyTurnId },
    createdBy: input.createdBy ?? null,
    idempotencyKey: input.idempotencyKey === null || input.idempotencyKey === undefined ? null : `review-apply:${input.idempotencyKey}`,
  });
  const updated = await deps.db.select().from(reviewRounds).where(eq(reviewRounds.id, row.id)).limit(1);
  return { round: (await deriveRound(deps, updated[0] ?? row)).round, turn };
}
