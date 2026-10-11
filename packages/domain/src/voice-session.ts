import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  VOICE_ERROR_REASONS,
  intentRevisionSchema,
  voiceCapabilitiesSchema,
  voiceEventEnvelopeSchema,
  voiceSessionSchema,
  voiceTranscriptRevisionSchema,
  type IntentRevision,
  type SealUtteranceRequest,
  type EphemeralCredential,
  type VoiceCapabilities,
  type VoiceEventEnvelope,
  type VoiceSession,
  type VoiceTranscriptRevision,
  type VoiceTransport,
} from '@ancs/contracts';
import { projectSequences, projects, voiceSessions } from '@ancs/db';
import type { DomainDeps } from './deps.js';
import { getSelectionAnchor } from './selection.js';

/**
 * N05-01 实时会话与短期凭证适配 + 增量设计 §6—§8 的流式协议状态机。
 *
 * - 会话只携带**短期凭证**（HMAC 签名的会话令牌，作用域 voice:stream/voice:tools，TTL 有限）；
 *   响应结构里没有任何 Provider Key/Secret 字段——长期 Key 永不下发；
 * - 权限不信任客户端：会话创建与每次事件都由调用方（API 层）先做 workspace/project 权限校验；
 * - 代际隔离：会话 `generation` 不匹配、或会话已关闭/过期/撤销的事件一律拒绝；
 * - **partial 只读**：转写中/修订中的文字写入会话的 `transcriptDraft`，不写 edit_events、不动工程 revision；
 * - `sealUtterance` 把某个 utterance 的**已修订转写 + 解释动作 + 目标绑定**封存成规范 `IntentRevision`
 *   （未解析指代无法封存），它是进入 `planRangeEdit` 的唯一入口。
 */

export const VOICE_SESSION_TTL_SECONDS = 15 * 60;

/** 适配器能力表：未列出的标志一律不支持（不得把未知能力展示为支持）。 */
export const VOICE_ADAPTER_CAPABILITIES: Record<VoiceTransport, VoiceCapabilities> = {
  SERVER_RELAY: {
    transport: 'SERVER_RELAY',
    supported: ['STREAMING_PARTIALS', 'SERVER_VAD', 'WORD_TIMESTAMPS', 'BARGE_IN', 'SERVER_SIDE_TOOLS'],
    unsupported: [],
  },
  PROVIDER_SIDEBAND: {
    transport: 'PROVIDER_SIDEBAND',
    supported: ['STREAMING_PARTIALS', 'SERVER_VAD', 'BARGE_IN'],
    unsupported: ['WORD_TIMESTAMPS', 'SERVER_SIDE_TOOLS'],
  },
  // 浏览器自带语音识别只作为回退：不做服务端 VAD/工具，也不承诺逐词时间戳
  BROWSER_SPEECH_FALLBACK: {
    transport: 'BROWSER_SPEECH_FALLBACK',
    supported: ['STREAMING_PARTIALS'],
    unsupported: ['SERVER_VAD', 'WORD_TIMESTAMPS', 'BARGE_IN', 'SERVER_SIDE_TOOLS'],
  },
};

export const resolveVoiceCapabilities = (preferred?: VoiceTransport): VoiceCapabilities => {
  if (preferred === undefined) return VOICE_ADAPTER_CAPABILITIES.SERVER_RELAY;
  const capabilities = VOICE_ADAPTER_CAPABILITIES[preferred];
  if (capabilities === undefined) {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'unknown voice transport', 501, {
      reason: VOICE_ERROR_REASONS.UNSUPPORTED_CAPABILITY, transport: preferred,
    });
  }
  return capabilities;
};

const signCredential = (deps: DomainDeps, sessionId: string, expiresAt: Date, generation: number): { token: string; fingerprint: string } => {
  const secret = deps.voiceSessionSecret;
  if (secret === undefined) {
    // 未配置签名密钥 → fail-closed（不发放未签名凭证，也不回退到长期 Key）
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'voice session signing secret is not configured', 501, {
      reason: VOICE_ERROR_REASONS.CREDENTIAL_UNAVAILABLE,
    });
  }
  const payload = `${sessionId}.${String(generation)}.${expiresAt.toISOString()}`;
  const token = createHmac('sha256', secret).update(payload).digest('base64url');
  return { token, fingerprint: createHmac('sha256', secret).update(`${payload}.fingerprint`).digest('hex').slice(0, 32) };
};

const toSession = (row: typeof voiceSessions.$inferSelect): VoiceSession => voiceSessionSchema.parse({
  sessionId: row.id,
  workspaceId: row.workspaceId,
  projectId: row.projectId,
  selectionAnchorId: row.selectionAnchorId ?? null,
  status: row.status,
  generation: row.generation,
  clockEpoch: row.clockEpoch,
  capabilities: voiceCapabilitiesSchema.parse(row.capabilities),
  issuedAt: row.issuedAt.toISOString(),
  expiresAt: row.expiresAt.toISOString(),
});

const loadSessionRow = async (deps: DomainDeps, input: { workspaceId: string; projectId: string; sessionId: string }) => {
  const rows = await deps.db.select().from(voiceSessions).where(and(
    eq(voiceSessions.id, input.sessionId),
    eq(voiceSessions.workspaceId, input.workspaceId),
    eq(voiceSessions.projectId, input.projectId),
  )).limit(1);
  const row = rows[0];
  if (!row) {
    throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'voice session not found', 404, { reason: VOICE_ERROR_REASONS.SESSION_NOT_FOUND });
  }
  return row;
};

/** 会话可用性（过期/撤销/关闭/代际）。每次事件与封存都必须先过这道门。 */
const assertSessionOpen = (row: typeof voiceSessions.$inferSelect, generation?: number): void => {
  if (row.status === 'REVOKED') {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'voice session has been revoked', 409, { reason: VOICE_ERROR_REASONS.SESSION_REVOKED });
  }
  if (row.status === 'CLOSED') {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'voice session is closed', 409, { reason: VOICE_ERROR_REASONS.SESSION_NOT_OPEN });
  }
  if (row.status === 'EXPIRED' || row.expiresAt.getTime() <= Date.now()) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'voice session has expired', 409, { reason: VOICE_ERROR_REASONS.SESSION_EXPIRED });
  }
  if (generation !== undefined && generation !== row.generation) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'stale voice session generation', 409, {
      reason: VOICE_ERROR_REASONS.STALE_GENERATION, expected: row.generation, received: generation,
    });
  }
};

export async function createVoiceSession(deps: DomainDeps, input: {
  workspaceId: string;
  projectId: string;
  actorId?: string;
  selectionAnchorId?: string | null;
  preferredTransport?: VoiceTransport;
}): Promise<{ session: VoiceSession; credential: EphemeralCredential }> {
  const sequenceRows = await deps.db.select({ id: projectSequences.id }).from(projectSequences).where(and(
    eq(projectSequences.workspaceId, input.workspaceId), eq(projectSequences.projectId, input.projectId),
  )).limit(1);
  if (sequenceRows.length === 0) {
    throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'project has no sequence', 404, { reason: VOICE_ERROR_REASONS.SESSION_NOT_FOUND });
  }
  if (input.selectionAnchorId != null) {
    // 锚点必须属于同一工程（越权引用一律拒绝）
    await getSelectionAnchor(deps, { workspaceId: input.workspaceId, projectId: input.projectId, anchorId: input.selectionAnchorId });
  }
  const capabilities = resolveVoiceCapabilities(input.preferredTransport);
  const sessionId = `vsess_${randomUUID()}`;
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + VOICE_SESSION_TTL_SECONDS * 1_000);
  const { token, fingerprint } = signCredential(deps, sessionId, expiresAt, 1);
  const clockEpoch = Math.floor(issuedAt.getTime() / 1_000);
  await deps.db.insert(voiceSessions).values({
    id: sessionId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    actorId: input.actorId ?? null,
    selectionAnchorId: input.selectionAnchorId ?? null,
    status: 'OPEN',
    generation: 1,
    clockEpoch,
    capabilities,
    transport: capabilities.transport,
    credentialFingerprint: fingerprint,
    transcriptDraft: [],
    utterances: [],
    lastEventSeq: 0,
    issuedAt,
    expiresAt,
    updatedAt: issuedAt,
  });
  const row = await loadSessionRow(deps, { workspaceId: input.workspaceId, projectId: input.projectId, sessionId });
  return {
    session: toSession(row),
    credential: { kind: 'EPHEMERAL_SESSION', token, scopes: ['voice:stream', 'voice:tools'], expiresAt: row.expiresAt.toISOString() },
  };
}

/** 凭证头名（API 与客户端共用；日志中脱敏）。 */
export const VOICE_SESSION_CREDENTIAL_HEADER = 'x-voice-session-token';

/**
 * 校验短期会话凭证（V5-M3；代码审查 P1-4：此前凭证签发后从未被校验）。
 *
 * - 由会话行重算签名（会话 id + 代际 + 过期时间），恒定时间比较——凭证只对**签发它的那个会话与代际**有效；
 * - 签名不符/缺失/会话不存在一律 401 `VOICE_CREDENTIAL_INVALID`（不区分原因，避免探测会话是否存在）；
 * - 签名有效后再过会话门：撤销/关闭/过期 → 409（与按用户身份访问时相同的领域错误）；
 * - 返回会话的租户与工程作用域，调用方据此执行流式写入（不信任客户端传入的作用域）。
 */
export async function verifyVoiceSessionCredential(deps: DomainDeps, input: {
  sessionId: string;
  token: string | undefined;
}): Promise<{ workspaceId: string; projectId: string; sessionId: string; generation: number }> {
  const invalid = (): ApiFailure => new ApiFailure(ERROR_CODES.UNAUTHENTICATED, 'voice session credential is invalid', 401, {
    reason: VOICE_ERROR_REASONS.CREDENTIAL_INVALID,
  });
  const secret = deps.voiceSessionSecret;
  if (secret === undefined) {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'voice session signing secret is not configured', 501, {
      reason: VOICE_ERROR_REASONS.CREDENTIAL_UNAVAILABLE,
    });
  }
  if (input.token === undefined || input.token.length === 0 || input.token.length > 256) throw invalid();
  const rows = await deps.db.select().from(voiceSessions).where(eq(voiceSessions.id, input.sessionId)).limit(1);
  const row = rows[0];
  if (row === undefined) throw invalid();
  const { token: expected } = signCredential(deps, row.id, row.expiresAt, row.generation);
  const presented = Buffer.from(input.token, 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  if (presented.length !== wanted.length || !timingSafeEqual(presented, wanted)) throw invalid();
  assertSessionOpen(row);
  return { workspaceId: row.workspaceId, projectId: row.projectId, sessionId: row.id, generation: row.generation };
}

export async function getVoiceSession(deps: DomainDeps, input: {
  workspaceId: string;
  projectId: string;
  sessionId: string;
}): Promise<VoiceSession> {
  const row = await loadSessionRow(deps, input);
  // 读到过期会话时顺手标 EXPIRED（只读接口不改工程）
  if (row.status === 'OPEN' && row.expiresAt.getTime() <= Date.now()) {
    await deps.db.update(voiceSessions).set({ status: 'EXPIRED', updatedAt: new Date() }).where(eq(voiceSessions.id, row.id));
    return toSession({ ...row, status: 'EXPIRED' });
  }
  return toSession(row);
}

/**
 * 接受一条流式事件：只更新会话内的**预备状态**（转写草稿/序号）。
 * 拒绝旧代际、已关闭/过期/撤销会话的事件（晚到结果不得抢回新画面）。
 */
export async function appendVoiceEvent(deps: DomainDeps, input: {
  workspaceId: string;
  projectId: string;
  sessionId: string;
  envelope: VoiceEventEnvelope;
}): Promise<{ accepted: true; transcript: VoiceTranscriptRevision | null; projectUntouched: true }> {
  const envelope = voiceEventEnvelopeSchema.parse(input.envelope);
  const row = await loadSessionRow(deps, input);
  assertSessionOpen(row, envelope.generation);
  if (envelope.clockEpoch !== row.clockEpoch) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'event clock epoch does not match the session', 422, {
      reason: VOICE_ERROR_REASONS.STALE_GENERATION, expected: row.clockEpoch, received: envelope.clockEpoch,
    });
  }
  if (envelope.sessionId !== row.id) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'event session mismatch', 422, { reason: VOICE_ERROR_REASONS.SESSION_NOT_FOUND });
  }
  if (envelope.seq <= row.lastEventSeq) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'event sequence must advance within the session stream', 422, {
      reason: VOICE_ERROR_REASONS.STALE_GENERATION, lastEventSeq: row.lastEventSeq, received: envelope.seq,
    });
  }

  const draft = voiceTranscriptRevisionSchema.array().parse(row.transcriptDraft);
  let transcript: VoiceTranscriptRevision | null = null;
  if (envelope.kind === 'TRANSCRIPT_PARTIAL' || envelope.kind === 'TRANSCRIPT_REVISED') {
    const text = typeof envelope.payload['text'] === 'string' ? envelope.payload['text'] : '';
    const utteranceId = envelope.utteranceId ?? `utt_${randomUUID()}`;
    const previous = draft.filter((item) => item.utteranceId === utteranceId).sort((left, right) => right.revision - left.revision)[0];
    transcript = voiceTranscriptRevisionSchema.parse({
      utteranceId,
      revision: (previous?.revision ?? 0) + 1,
      text,
      isFinal: envelope.payload['isFinal'] === true,
      supersedesRevision: previous?.revision ?? null,
      updatedAt: new Date().toISOString(),
    });
    draft.push(transcript);
  }
  await deps.db.update(voiceSessions).set({
    transcriptDraft: draft.slice(-200),
    lastEventSeq: envelope.seq,
    updatedAt: new Date(),
  }).where(eq(voiceSessions.id, row.id));
  // partial/revision 只写会话草稿：projectUntouched 是**结构性保证**（本函数不触碰任何工程表）
  return { accepted: true, transcript, projectUntouched: true };
}

/** 把某次话语封存为规范 IntentRevision（partial 未封存前不产生任何正式操作）。 */
export async function sealUtterance(deps: DomainDeps, input: {
  workspaceId: string;
  projectId: string;
  sessionId: string;
  request: SealUtteranceRequest;
}): Promise<{ intentRevision: IntentRevision; projectUntouched: true }> {
  const row = await loadSessionRow(deps, input);
  assertSessionOpen(row);
  const draft = voiceTranscriptRevisionSchema.array().parse(row.transcriptDraft);
  const revisions = draft.filter((item) => item.utteranceId === input.request.utteranceId);
  const revision = revisions.find((item) => item.revision === input.request.transcriptRevision);
  if (revision === undefined) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'transcript revision not found for this utterance', 422, {
      reason: VOICE_ERROR_REASONS.UTTERANCE_NOT_SEALABLE, utteranceId: input.request.utteranceId, transcriptRevision: input.request.transcriptRevision,
    });
  }
  const latest = revisions.reduce((max, item) => Math.max(max, item.revision), 0);
  if (latest !== revision.revision) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'a newer transcript revision superseded this one', 409, {
      reason: VOICE_ERROR_REASONS.UTTERANCE_NOT_SEALABLE, latestRevision: latest,
    });
  }
  if (row.selectionAnchorId === null) {
    // 封存必须绑定选择锚点（指代的权威来源）：没有锚点就没有可验证作用域，不能进入正式编辑
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'sealing requires a selection anchor bound to the session', 422, {
      reason: VOICE_ERROR_REASONS.ANCHOR_MISMATCH,
    });
  }
  // 未完整语义不得进入正式编辑：存在未解析指代 → 422（不落库、不产生意图修订）
  const unresolved = input.request.targetBindings.filter((binding) => binding.resolvedTargetRefs.length === 0);
  if (unresolved.length > 0) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'unresolved references cannot be sealed', 422, {
      reason: VOICE_ERROR_REASONS.UTTERANCE_NOT_SEALABLE,
      references: unresolved.map((binding) => binding.reference),
    });
  }
  const utterances = intentRevisionSchema.array().parse(row.utterances);
  const previous = utterances.filter((item) => item.utteranceId === input.request.utteranceId).sort((left, right) => right.revision - left.revision)[0];
  const sealed = intentRevisionSchema.parse({
    intentRevisionId: `ir_${randomUUID()}`,
    sessionId: row.id,
    utteranceId: input.request.utteranceId,
    intentId: previous?.intentId ?? `int_${randomUUID()}`,
    revision: (previous?.revision ?? 0) + 1,
    selectionAnchorId: row.selectionAnchorId,
    transcriptRevision: revision.revision,
    targetBindings: input.request.targetBindings,
    interpretedAction: input.request.interpretedAction,
    explicitConstraints: input.request.explicitConstraints,
    assumptions: input.request.assumptions,
    status: 'SEALED',
    supersedesIntentRevisionId: previous?.intentRevisionId ?? null,
    proposedOperationRefs: [],
  });
  utterances.push(sealed);
  await deps.db.update(voiceSessions).set({ utterances: utterances.slice(-200), updatedAt: new Date() }).where(eq(voiceSessions.id, row.id));
  return { intentRevision: sealed, projectUntouched: true };
}

export async function closeVoiceSession(deps: DomainDeps, input: {
  workspaceId: string;
  projectId: string;
  sessionId: string;
}): Promise<VoiceSession> {
  const row = await loadSessionRow(deps, input);
  // dispose/结束可重复调用（幂等）：已关闭/撤销/过期都不再改动状态
  if (row.status !== 'OPEN') return toSession(row);
  await deps.db.update(voiceSessions).set({ status: 'CLOSED', closedAt: new Date(), updatedAt: new Date() }).where(eq(voiceSessions.id, row.id));
  const updated = await loadSessionRow(deps, input);
  return toSession(updated);
}

export async function revokeVoiceSession(deps: DomainDeps, input: {
  workspaceId: string;
  projectId: string;
  sessionId: string;
}): Promise<VoiceSession> {
  const row = await loadSessionRow(deps, input);
  if (row.status === 'REVOKED') return toSession(row);
  await deps.db.update(voiceSessions).set({ status: 'REVOKED', revokedAt: new Date(), updatedAt: new Date() }).where(eq(voiceSessions.id, row.id));
  const updated = await loadSessionRow(deps, input);
  return toSession(updated);
}

/** 供 API 层做权限投影：会话归属与代际（不信任客户端声明）。 */
export async function describeVoiceSessionOwnership(deps: DomainDeps, input: {
  workspaceId: string;
  projectId: string;
}): Promise<{ projectRevision: number }> {
  const rows = await deps.db.select({ revision: projects.revision }).from(projects).where(and(
    eq(projects.id, input.projectId), eq(projects.workspaceId, input.workspaceId),
  )).orderBy(desc(projects.revision)).limit(1);
  return { projectRevision: rows[0]?.revision ?? 0 };
}

/** 会话内最新草稿（诊断与测试用）。 */
export async function listVoiceTranscriptDraft(deps: DomainDeps, input: {
  workspaceId: string;
  projectId: string;
  sessionId: string;
}): Promise<VoiceTranscriptRevision[]> {
  const row = await loadSessionRow(deps, input);
  return voiceTranscriptRevisionSchema.array().parse(row.transcriptDraft);
}

/** 会话内已封存的意图修订。 */
export async function listSealedUtterances(deps: DomainDeps, input: {
  workspaceId: string;
  projectId: string;
  sessionId: string;
}): Promise<IntentRevision[]> {
  const row = await loadSessionRow(deps, input);
  return intentRevisionSchema.array().parse(row.utterances);
}
