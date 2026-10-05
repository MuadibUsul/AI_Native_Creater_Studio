import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  VOICE_CLONE_ERROR_REASONS,
  VOICE_QUALITY_THRESHOLDS,
  addVoiceSampleRequestSchema,
  confirmVoiceConsentRequestSchema,
  submitVoiceCloneRequestSchema,
  voiceCloneSampleSchema,
  voiceCloneSchema,
  voiceCloneStateSchema,
  voiceConsentSchema,
  voiceQualityReportSchema,
  type VoiceClone,
  type VoiceCloneProvider,
  type VoiceCloneSample,
  type VoiceCloneState,
  type VoiceConsent,
  type VoiceQualityFinding,
  type VoiceQualityReport,
} from '@ancs/contracts';
import { assetVersions, outboxEvents, providerConnections, voiceCloneSamples, voiceClones, voiceConsents, voiceIdentities } from '@ancs/db';
import type { DomainDeps } from './channels.js';
import { requireStorage } from './assets.js';
import { parseWavPcm16 } from './wav.js';

/**
 * Voice Clone 服务（P10-02 / 规范 §6.2、§14.3、§20.1—20.3、§95）。
 *
 * 硬约束（验收）：
 * - **未授权不提交**：Consent（声明版本 + 文本哈希 + 主体类型）不存在/已撤销 → 422（先于任何 Provider 调用）；
 * - **字段不得混同**（§14.3 MUST）：样本/授权/provider_voice_id/retention/ownership 各自独立列；
 * - **训练失败可恢复**：FAILED(retryable) → `retryVoiceClone` 重提交（样本与 Consent 保留）；
 * - **退休 / 平台解绑 / Provider 删除可区分**：retiredAt（本地保留 Provider 声音）/ unlinkedAt（断开关联，
 *   Provider 声音保留）/ providerDeletedAt（Provider 侧不可恢复删除）——三态三时间戳；
 * - **音质检测不做假**：仅 WAV PCM16 支持深度指标（时长/采样率/静音/削波/有效语音）；
 *   其余格式 422 QUALITY_UNSUPPORTED_FORMAT（不伪造检测结果）。
 */

export const VOICE_CONSENT_STATEMENT_VERSION = 'v1';

/** 授权声明（版本化文本；哈希落库可核对——"不得把上传任意名人 MP3 作为产品能力"） */
export const VOICE_CONSENT_STATEMENT = [
  '【声音克隆授权声明 v1】',
  '1. 我确认：克隆的声音为我本人所有，或我已取得声音权利人明确、可核验的书面授权；',
  '2. 我理解：禁止未经授权克隆他人（含公众人物）声音，平台保留拒绝/删除的权利；',
  '3. 我同意：样本仅用于本工作区内的声音克隆与语音合成；平台按保留策略处理样本与生成物；',
  '4. 我知悉：我可随时撤销本授权；撤销后平台不再发起新的克隆/训练，已生成的历史内容保留可审计引用。',
].join('\n');

export const voiceConsentStatementHash = (): string => createHash('sha256').update(VOICE_CONSENT_STATEMENT, 'utf8').digest('hex');

/* ---------- 音质检测（纯函数；确定性阈值） ---------- */

const WINDOW_MS = 50;
const SILENCE_RMS = 10 ** (-45 / 20); // -45 dBFS
const SPEECH_RMS = 10 ** (-30 / 20); // -30 dBFS

const toDb = (value: number): number => (value <= 0 ? -120 : Math.round(20 * Math.log10(value) * 10) / 10);

/**
 * WAV PCM16 音质检测：时长 / 采样率 / 静音比 / 削波比 / 有效语音比 / 峰值 / RMS。
 * 非 WAV（或解析失败）→ FAIL 报告（UNSUPPORTED_FORMAT）——**不伪造检测**（调用方 422）。
 */
export function analyzeVoiceSampleQuality(input: { bytes: Uint8Array; contentType: string; kind?: 'INSTANT' | 'PROFESSIONAL' }): VoiceQualityReport {
  const analyzedAt = new Date().toISOString();
  const parsed = parseWavPcm16(input.bytes);
  if (parsed === null) {
    return voiceQualityReportSchema.parse({
      verdict: 'FAIL',
      format: input.contentType,
      findings: [{ code: 'QUALITY_UNSUPPORTED_FORMAT', severity: 'FAIL', message: '仅支持 WAV PCM16 样本的深度质量检测（时长/静音/削波/有效语音）——其他格式不做假检测，请转码后上传' }],
      analyzedAt,
    });
  }

  const { sampleRate, channels, dataOffset, dataLength } = parsed;
  const view = new DataView(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength);
  const frameCount = Math.floor(dataLength / (2 * channels));
  const mono = new Float32Array(frameCount);
  let peak = 0;
  let sumSquares = 0;
  let clipped = 0;
  for (let frame = 0; frame < frameCount; frame += 1) {
    let mixed = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      const value = view.getInt16(dataOffset + (frame * channels + channel) * 2, true) / 32768;
      mixed += value;
    }
    const sample = mixed / channels;
    mono[frame] = sample;
    const absolute = Math.abs(sample);
    if (absolute > peak) peak = absolute;
    if (absolute >= 0.99) clipped += 1;
    sumSquares += sample * sample;
  }
  const durationMs = Math.round((frameCount / sampleRate) * 1000);
  const windowSize = Math.max(1, Math.round((sampleRate * WINDOW_MS) / 1000));
  let windows = 0;
  let silentWindows = 0;
  let speechWindows = 0;
  for (let start = 0; start < frameCount; start += windowSize) {
    const end = Math.min(frameCount, start + windowSize);
    let energy = 0;
    for (let index = start; index < end; index += 1) energy += (mono[index] ?? 0) ** 2;
    const rms = Math.sqrt(energy / Math.max(1, end - start));
    windows += 1;
    if (rms < SILENCE_RMS) silentWindows += 1;
    if (rms >= SPEECH_RMS) speechWindows += 1;
  }
  const silenceRatio = windows === 0 ? 1 : silentWindows / windows;
  const effectiveSpeechRatio = windows === 0 ? 0 : speechWindows / windows;
  const clippingRatio = frameCount === 0 ? 0 : clipped / frameCount;
  const rmsDb = toDb(Math.sqrt(sumSquares / Math.max(1, frameCount)));

  const findings: VoiceQualityFinding[] = [];
  if (durationMs < VOICE_QUALITY_THRESHOLDS.minDurationMs) {
    findings.push({ code: 'TOO_SHORT', severity: 'FAIL', message: `样本过短（${String(durationMs)}ms < ${String(VOICE_QUALITY_THRESHOLDS.minDurationMs)}ms）——请录制更长的连续语音` });
  }
  if (durationMs > VOICE_QUALITY_THRESHOLDS.maxDurationMs) {
    findings.push({ code: 'TOO_LONG', severity: 'FAIL', message: `样本过长（${String(durationMs)}ms）——请上传单一干净片段，不要整段录音` });
  }
  if (silenceRatio > VOICE_QUALITY_THRESHOLDS.maxSilenceRatio) {
    findings.push({ code: 'MOSTLY_SILENT', severity: 'FAIL', message: `静音比过高（${(silenceRatio * 100).toFixed(0)}%）——请检查录音设备/环境` });
  }
  if (clippingRatio > VOICE_QUALITY_THRESHOLDS.clippingFailRatio) {
    findings.push({ code: 'CLIPPING', severity: 'FAIL', message: `削波严重（${(clippingRatio * 100).toFixed(1)}% 样本达到满幅）——请降低输入增益重录` });
  } else if (clippingRatio > VOICE_QUALITY_THRESHOLDS.clippingWarnRatio) {
    findings.push({ code: 'CLIPPING_MILD', severity: 'WARN', message: `存在削波（${(clippingRatio * 100).toFixed(1)}%）——建议降低增益` });
  }
  if (effectiveSpeechRatio < VOICE_QUALITY_THRESHOLDS.minEffectiveSpeechRatio) {
    findings.push({ code: 'LOW_SPEECH_RATIO', severity: 'FAIL', message: `有效语音比不足（${(effectiveSpeechRatio * 100).toFixed(0)}%）——样本应以清晰人声为主` });
  }
  if (sampleRate < VOICE_QUALITY_THRESHOLDS.minSampleRateHz) {
    findings.push({ code: 'LOW_SAMPLE_RATE', severity: 'FAIL', message: `采样率过低（${String(sampleRate)}Hz < ${String(VOICE_QUALITY_THRESHOLDS.minSampleRateHz)}Hz）——请以 16kHz 以上录制` });
  }
  if (input.kind === 'PROFESSIONAL' && durationMs < VOICE_QUALITY_THRESHOLDS.professionalRecommendedMs && durationMs >= VOICE_QUALITY_THRESHOLDS.minDurationMs) {
    findings.push({
      code: 'PROFESSIONAL_SAMPLE_SHORT',
      severity: 'WARN',
      message: `Professional 建议 ≥${String(Math.round(VOICE_QUALITY_THRESHOLDS.professionalRecommendedMs / 1000))}s 连续语音（当前 ${String(Math.round(durationMs / 1000))}s）——请补录，或先用 Instant 档试用`,
    });
  }
  if (rmsDb < -30) {
    findings.push({ code: 'LOW_LEVEL', severity: 'WARN', message: `整体电平偏低（RMS ${String(rmsDb)} dBFS）——建议提高录音电平` });
  }

  const verdict = findings.some((finding) => finding.severity === 'FAIL') ? 'FAIL' : findings.some((finding) => finding.severity === 'WARN') ? 'WARN' : 'PASS';
  return voiceQualityReportSchema.parse({
    verdict,
    format: 'audio/wav (pcm16)',
    durationMs,
    sampleRateHz: sampleRate,
    channels,
    silenceRatio: Math.round(silenceRatio * 1000) / 1000,
    clippingRatio: Math.round(clippingRatio * 10000) / 10000,
    effectiveSpeechRatio: Math.round(effectiveSpeechRatio * 1000) / 1000,
    peakDb: toDb(peak),
    rmsDb,
    findings,
    analyzedAt,
  });
}

/* ---------- DTO 映射 ---------- */

const toConsentDto = (row: typeof voiceConsents.$inferSelect): VoiceConsent =>
  voiceConsentSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    creatorIdentityId: row.creatorIdentityId,
    subjectType: row.subjectType,
    statementVersion: row.statementVersion,
    statementHash: row.statementHash,
    acceptedByUserId: row.acceptedByUserId,
    acceptedAt: row.acceptedAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    notes: row.notes,
  });

const toSampleDto = (row: typeof voiceCloneSamples.$inferSelect): VoiceCloneSample =>
  voiceCloneSampleSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    creatorIdentityId: row.creatorIdentityId,
    assetId: row.assetId,
    assetVersionId: row.assetVersionId,
    byteSize: row.byteSize,
    contentType: row.contentType,
    quality: row.quality,
    cloneId: row.cloneId,
    createdAt: row.createdAt.toISOString(),
  });

const toCloneDto = (row: typeof voiceClones.$inferSelect): VoiceClone =>
  voiceCloneSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    creatorIdentityId: row.creatorIdentityId,
    kind: row.kind,
    provider: row.provider,
    mode: row.mode,
    status: row.status,
    qualityVerdict: row.qualityVerdict,
    consentId: row.consentId,
    providerVoiceId: row.providerVoiceId,
    providerJobId: row.providerJobId,
    retentionPolicy: row.retentionPolicy,
    ownershipMetadata: row.ownershipMetadata,
    failure: row.failure,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    trainedAt: row.trainedAt?.toISOString() ?? null,
    retiredAt: row.retiredAt?.toISOString() ?? null,
    unlinkedAt: row.unlinkedAt?.toISOString() ?? null,
    providerDeletedAt: row.providerDeletedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });

/* ---------- 样本 ---------- */

const SAMPLE_MAX_BYTES = 50 * 1024 * 1024;

export async function addVoiceSample(
  deps: DomainDeps,
  input: { workspaceId: string; creatorIdentityId: string; request: unknown },
): Promise<VoiceCloneSample> {
  const body = addVoiceSampleRequestSchema.parse(input.request);
  const versionRows = await deps.db
    .select()
    .from(assetVersions)
    .where(and(eq(assetVersions.id, body.assetVersionId), eq(assetVersions.workspaceId, input.workspaceId)))
    .limit(1);
  const version = versionRows[0];
  if (version === undefined || version.assetId !== body.assetId || version.deletedAt !== null) {
    throw new ApiFailure(ERROR_CODES.NOT_FOUND, '样本资产版本不存在（或跨工作区/已删除）', 404);
  }
  const bytes = await requireStorage(deps).getObject(version.storageKey);
  if (bytes === null) {
    throw new ApiFailure(ERROR_CODES.NOT_FOUND, '样本对象不存在（上传未完成？）', 404);
  }
  if (bytes.byteLength > SAMPLE_MAX_BYTES) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, '样本超过 50MB 上限', 413, { byteSize: bytes.byteLength, maxBytes: SAMPLE_MAX_BYTES });
  }

  const quality = analyzeVoiceSampleQuality({ bytes, contentType: version.mimeType, kind: body.kind });
  if (quality.verdict === 'FAIL' && quality.findings.some((finding) => finding.code === 'QUALITY_UNSUPPORTED_FORMAT')) {
    // 不伪造检测结果：格式不支持深度检测 → 明确拒绝（样本不落库）
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, '样本格式不支持质量检测（仅 WAV PCM16）——请转码后上传；本系统不做假检测', 422, {
      reason: VOICE_CLONE_ERROR_REASONS.QUALITY_UNSUPPORTED_FORMAT,
      contentType: version.mimeType,
    });
  }

  const inserted = await deps.db
    .insert(voiceCloneSamples)
    .values({
      id: `vsm_${randomUUID()}`,
      workspaceId: input.workspaceId,
      creatorIdentityId: input.creatorIdentityId,
      assetId: body.assetId,
      assetVersionId: body.assetVersionId,
      byteSize: bytes.byteLength,
      contentType: version.mimeType,
      quality,
    })
    .returning();
  const row = inserted[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'sample insert failed', 500);
  return toSampleDto(row);
}

export async function listVoiceSamples(deps: DomainDeps, input: { workspaceId: string; creatorIdentityId: string }): Promise<VoiceCloneSample[]> {
  const rows = await deps.db
    .select()
    .from(voiceCloneSamples)
    .where(and(eq(voiceCloneSamples.workspaceId, input.workspaceId), eq(voiceCloneSamples.creatorIdentityId, input.creatorIdentityId)))
    .orderBy(desc(voiceCloneSamples.createdAt));
  return rows.map(toSampleDto);
}

/* ---------- Consent ---------- */

export async function confirmVoiceConsent(
  deps: DomainDeps,
  input: { workspaceId: string; creatorIdentityId: string; request: unknown; actorUserId: string },
): Promise<VoiceConsent> {
  const body = confirmVoiceConsentRequestSchema.parse(input.request);
  const now = new Date();
  const existing = await deps.db.select().from(voiceConsents).where(eq(voiceConsents.creatorIdentityId, input.creatorIdentityId)).limit(1);
  const values = {
    workspaceId: input.workspaceId,
    creatorIdentityId: input.creatorIdentityId,
    subjectType: body.subjectType,
    statementVersion: VOICE_CONSENT_STATEMENT_VERSION,
    statementHash: voiceConsentStatementHash(),
    acceptedByUserId: input.actorUserId,
    acceptedAt: now,
    revokedAt: null,
    notes: body.notes ?? null,
  };
  if (existing[0] !== undefined) {
    const updated = await deps.db.update(voiceConsents).set(values).where(eq(voiceConsents.id, existing[0].id)).returning();
    const row = updated[0];
    if (row === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'consent update failed', 500);
    return toConsentDto(row);
  }
  const inserted = await deps.db
    .insert(voiceConsents)
    .values({ id: `vco_${randomUUID()}`, ...values })
    .returning();
  const row = inserted[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'consent insert failed', 500);
  return toConsentDto(row);
}

export async function revokeVoiceConsent(deps: DomainDeps, input: { workspaceId: string; creatorIdentityId: string }): Promise<VoiceConsent> {
  const rows = await deps.db.select().from(voiceConsents).where(eq(voiceConsents.creatorIdentityId, input.creatorIdentityId)).limit(1);
  const row = rows[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'Consent 不存在', 404);
  if (row.revokedAt !== null) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'Consent 已撤销', 409);
  }
  const updated = await deps.db.update(voiceConsents).set({ revokedAt: new Date() }).where(eq(voiceConsents.id, row.id)).returning();
  const result = updated[0];
  if (result === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'consent revoke failed', 500);
  return toConsentDto(result);
}

export async function getVoiceConsent(deps: DomainDeps, input: { creatorIdentityId: string }): Promise<VoiceConsent | null> {
  const rows = await deps.db.select().from(voiceConsents).where(eq(voiceConsents.creatorIdentityId, input.creatorIdentityId)).limit(1);
  const row = rows[0];
  return row === undefined ? null : toConsentDto(row);
}

/* ---------- 状态读取 ---------- */

export async function getVoiceCloneState(deps: DomainDeps, input: { workspaceId: string; creatorIdentityId: string }): Promise<VoiceCloneState> {
  const [cloneRows, samples, consent] = await Promise.all([
    deps.db
      .select()
      .from(voiceClones)
      .where(and(eq(voiceClones.workspaceId, input.workspaceId), eq(voiceClones.creatorIdentityId, input.creatorIdentityId)))
      .orderBy(desc(voiceClones.createdAt))
      .limit(1),
    listVoiceSamples(deps, input),
    getVoiceConsent(deps, { creatorIdentityId: input.creatorIdentityId }),
  ]);
  const clone = cloneRows[0];
  const identityRows = await deps.db
    .select({ providerVoiceId: voiceIdentities.providerVoiceId, status: voiceIdentities.status })
    .from(voiceIdentities)
    .where(eq(voiceIdentities.creatorIdentityId, input.creatorIdentityId))
    .limit(1);
  const identity = identityRows[0];
  const boundToIdentity =
    clone !== undefined && clone.providerVoiceId !== null && identity !== undefined && identity.providerVoiceId === clone.providerVoiceId && identity.status === 'ACTIVE';
  return voiceCloneStateSchema.parse({
    clone: clone === undefined ? null : toCloneDto(clone),
    samples,
    consent,
    boundToIdentity,
  });
}

/* ---------- 提交 / 训练 / 重试 ---------- */

async function readSampleBytes(deps: DomainDeps, sampleRows: (typeof voiceCloneSamples.$inferSelect)[]): Promise<{ bytes: Uint8Array; contentType: string }[]> {
  const storage = requireStorage(deps);
  const result: { bytes: Uint8Array; contentType: string }[] = [];
  for (const sample of sampleRows) {
    const versionRows = await deps.db.select({ storageKey: assetVersions.storageKey }).from(assetVersions).where(eq(assetVersions.id, sample.assetVersionId)).limit(1);
    const key = versionRows[0]?.storageKey;
    if (key === undefined) continue;
    const bytes = await storage.getObject(key);
    if (bytes !== null) result.push({ bytes, contentType: sample.contentType });
  }
  return result;
}

async function emitVoiceEvent(deps: DomainDeps, workspaceId: string, type: string, payload: Record<string, unknown>): Promise<void> {
  await deps.db.insert(outboxEvents).values({
    id: `obx_${randomUUID()}`,
    workspaceId,
    type,
    payload: { actorType: 'USER', ...payload },
  });
}

/** READY 时绑定 VoiceIdentity（平台解绑 = 反向操作，保留下载可审计引用）。 */
async function bindIdentity(deps: DomainDeps, input: { workspaceId: string; creatorIdentityId: string; provider: string; providerVoiceId: string; kind: string; mode: string }): Promise<void> {
  const now = new Date();
  const existing = await deps.db.select({ id: voiceIdentities.id, version: voiceIdentities.version }).from(voiceIdentities).where(eq(voiceIdentities.creatorIdentityId, input.creatorIdentityId)).limit(1);
  const values = {
    provider: input.provider,
    providerVoiceId: input.providerVoiceId,
    cloneType: input.kind,
    managedMode: input.mode,
    status: 'ACTIVE',
    updatedAt: now,
    retiredAt: null,
  };
  if (existing[0] !== undefined) {
    await deps.db
      .update(voiceIdentities)
      .set({ ...values, version: existing[0].version + 1 })
      .where(eq(voiceIdentities.id, existing[0].id));
  } else {
    await deps.db.insert(voiceIdentities).values({
      id: `voi_${randomUUID()}`,
      workspaceId: input.workspaceId,
      creatorIdentityId: input.creatorIdentityId,
      version: 1,
      createdAt: now,
      ...values,
    });
  }
}

export async function submitVoiceClone(
  deps: DomainDeps,
  input: { workspaceId: string; creatorIdentityId: string; request: unknown; actorUserId: string; provider: VoiceCloneProvider | undefined },
): Promise<VoiceClone> {
  const body = submitVoiceCloneRequestSchema.parse(input.request);
  const provider = input.provider;
  if (provider === undefined) {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, '声音克隆 Provider 未装配（501 fail-closed）', 501, { reason: VOICE_CLONE_ERROR_REASONS.CLONE_PROVIDER_UNAVAILABLE });
  }

  // **未授权不提交**（先于任何 Provider 调用）
  const consent = await getVoiceConsent(deps, { creatorIdentityId: input.creatorIdentityId });
  if (consent === null || consent.revokedAt !== null) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, '缺少有效的授权声明（Consent）——请先完成授权确认', 422, { reason: VOICE_CLONE_ERROR_REASONS.CONSENT_REQUIRED, consentId: consent?.id ?? null });
  }

  // 样本门槛：≥1 PASS（WARN/FAIL 不提交；样本与检测报告保留）
  const sampleRows = await deps.db
    .select()
    .from(voiceCloneSamples)
    .where(and(eq(voiceCloneSamples.workspaceId, input.workspaceId), eq(voiceCloneSamples.creatorIdentityId, input.creatorIdentityId)))
    .orderBy(desc(voiceCloneSamples.createdAt));
  const usable = sampleRows.filter((row) => (row.quality as VoiceQualityReport).verdict === 'PASS');
  if (usable.length === 0) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, `无合格样本（PASS）——当前样本 ${String(sampleRows.length)} 条均未通过质量门槛`, 422, {
      reason: VOICE_CLONE_ERROR_REASONS.SAMPLES_REQUIRED,
      sampleCount: sampleRows.length,
    });
  }

  // BYOK：需工作区对应该 Provider 的连接（凭据不经本服务明文）
  let connection: { connectionId: string; provider: string } | undefined;
  if (body.mode === 'BYOK') {
    const connectionRows = await deps.db
      .select({ id: providerConnections.id })
      .from(providerConnections)
      .where(and(eq(providerConnections.workspaceId, input.workspaceId), eq(providerConnections.providerId, body.provider), eq(providerConnections.status, 'ACTIVE')))
      .limit(1);
    if (connectionRows[0] === undefined) {
      throw new ApiFailure(ERROR_CODES.FORBIDDEN, `BYOK 模式需要工作区已连接 Provider「${body.provider}」`, 422, { reason: VOICE_CLONE_ERROR_REASONS.BYOK_CONNECTION_REQUIRED, provider: body.provider });
    }
    connection = { connectionId: connectionRows[0].id, provider: body.provider };
  }

  const samples = await readSampleBytes(deps, usable);
  if (samples.length === 0) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, '样本对象不可读（存储缺失）', 422, { reason: VOICE_CLONE_ERROR_REASONS.SAMPLES_REQUIRED });
  }

  const cloneId = `vcl_${randomUUID()}`;
  const now = new Date();
  const providerInput = {
    workspaceId: input.workspaceId,
    creatorIdentityId: input.creatorIdentityId,
    kind: body.kind,
    name: `voice-${input.creatorIdentityId.slice(-6)}-${body.kind.toLowerCase()}`,
    samples,
    ...(connection !== undefined ? { connection } : {}),
  };

  let providerVoiceId: string | null = null;
  let providerJobId: string | null = null;
  let status: VoiceClone['status'];
  if (body.kind === 'INSTANT') {
    const result = await provider.createInstantClone(providerInput);
    providerVoiceId = result.providerVoiceId;
    status = 'READY';
  } else {
    const result = await provider.createProfessionalClone(providerInput);
    providerJobId = result.providerJobId;
    status = 'SUBMITTED';
  }

  const bestVerdict = 'PASS' as const; // 提交门槛要求 ≥1 PASS（聚合判定即 PASS；WARN/FAIL 样本不参与提交）
  const inserted = await deps.db
    .insert(voiceClones)
    .values({
      id: cloneId,
      workspaceId: input.workspaceId,
      creatorIdentityId: input.creatorIdentityId,
      kind: body.kind,
      provider: body.provider,
      mode: body.mode,
      status,
      qualityVerdict: bestVerdict,
      consentId: consent.id,
      providerVoiceId,
      providerJobId,
      retentionPolicy: body.retentionPolicy ?? null,
      ownershipMetadata: body.ownershipMetadata ?? {},
      submittedAt: now,
      trainedAt: status === 'READY' ? now : null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  const row = inserted[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'clone insert failed', 500);

  // 样本回填 cloneId（样本与克隆不混同：仅引用关系）
  for (const sample of usable) {
    await deps.db.update(voiceCloneSamples).set({ cloneId }).where(eq(voiceCloneSamples.id, sample.id));
  }
  if (status === 'READY' && providerVoiceId !== null) {
    await bindIdentity(deps, { workspaceId: input.workspaceId, creatorIdentityId: input.creatorIdentityId, provider: body.provider, providerVoiceId, kind: body.kind, mode: body.mode });
  }
  await emitVoiceEvent(deps, input.workspaceId, 'voice_clone.submitted', { cloneId, kind: body.kind, provider: body.provider, mode: body.mode, actorId: input.actorUserId });
  return toCloneDto(row);
}

export async function refreshVoiceClone(
  deps: DomainDeps,
  input: { workspaceId: string; creatorIdentityId: string; provider: VoiceCloneProvider | undefined },
): Promise<VoiceClone> {
  const provider = input.provider;
  if (provider === undefined) {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, '声音克隆 Provider 未装配（501 fail-closed）', 501, { reason: VOICE_CLONE_ERROR_REASONS.CLONE_PROVIDER_UNAVAILABLE });
  }
  const rows = await deps.db
    .select()
    .from(voiceClones)
    .where(and(eq(voiceClones.workspaceId, input.workspaceId), eq(voiceClones.creatorIdentityId, input.creatorIdentityId)))
    .orderBy(desc(voiceClones.createdAt))
    .limit(1);
  const row = rows[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, '无克隆记录', 404);
  if (row.providerJobId === null || (row.status !== 'SUBMITTED' && row.status !== 'TRAINING')) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, `当前状态不允许刷新（${row.status}）`, 409, { reason: VOICE_CLONE_ERROR_REASONS.INVALID_STATE, status: row.status });
  }
  const providerStatus = await provider.getCloneStatus({ providerJobId: row.providerJobId });
  const now = new Date();
  if (providerStatus.state === 'TRAINING') {
    const updated = await deps.db.update(voiceClones).set({ status: 'TRAINING', updatedAt: now }).where(eq(voiceClones.id, row.id)).returning();
    const next = updated[0];
    if (next === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'clone update failed', 500);
    return toCloneDto(next);
  }
  if (providerStatus.state === 'READY' && providerStatus.providerVoiceId !== undefined) {
    const updated = await deps.db
      .update(voiceClones)
      .set({ status: 'READY', providerVoiceId: providerStatus.providerVoiceId, trainedAt: now, failure: null, updatedAt: now })
      .where(eq(voiceClones.id, row.id))
      .returning();
    const next = updated[0];
    if (next === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'clone update failed', 500);
    await bindIdentity(deps, { workspaceId: row.workspaceId, creatorIdentityId: row.creatorIdentityId, provider: row.provider, providerVoiceId: providerStatus.providerVoiceId, kind: row.kind, mode: row.mode });
    await emitVoiceEvent(deps, row.workspaceId, 'voice_clone.ready', { cloneId: row.id, providerVoiceId: providerStatus.providerVoiceId });
    return toCloneDto(next);
  }
  const failure = { code: providerStatus.error?.code ?? 'TRAINING_FAILED', message: providerStatus.error?.message ?? '训练失败', at: now.toISOString(), retryable: true };
  const updated = await deps.db.update(voiceClones).set({ status: 'FAILED', failure, updatedAt: now }).where(eq(voiceClones.id, row.id)).returning();
  const next = updated[0];
  if (next === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'clone update failed', 500);
  await emitVoiceEvent(deps, row.workspaceId, 'voice_clone.failed', { cloneId: row.id, retryable: true, code: failure.code });
  return toCloneDto(next);
}

export async function retryVoiceClone(
  deps: DomainDeps,
  input: { workspaceId: string; creatorIdentityId: string; provider: VoiceCloneProvider | undefined },
): Promise<VoiceClone> {
  const provider = input.provider;
  if (provider === undefined) {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, '声音克隆 Provider 未装配（501 fail-closed）', 501, { reason: VOICE_CLONE_ERROR_REASONS.CLONE_PROVIDER_UNAVAILABLE });
  }
  const rows = await deps.db
    .select()
    .from(voiceClones)
    .where(and(eq(voiceClones.workspaceId, input.workspaceId), eq(voiceClones.creatorIdentityId, input.creatorIdentityId)))
    .orderBy(desc(voiceClones.createdAt))
    .limit(1);
  const row = rows[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, '无克隆记录', 404);
  const failure = row.failure as VoiceClone['failure'];
  if (row.status !== 'FAILED' || failure === null || !failure.retryable) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, `仅可重试失败且可恢复的克隆（当前 ${row.status}）`, 409, { reason: VOICE_CLONE_ERROR_REASONS.INVALID_STATE, status: row.status });
  }
  const usable = await deps.db
    .select()
    .from(voiceCloneSamples)
    .where(and(eq(voiceCloneSamples.workspaceId, input.workspaceId), eq(voiceCloneSamples.creatorIdentityId, input.creatorIdentityId)));
  const samples = await readSampleBytes(
    deps,
    usable.filter((sample) => (sample.quality as VoiceQualityReport).verdict === 'PASS'),
  );
  const now = new Date();
  const result =
    row.kind === 'INSTANT'
      ? { kind: 'instant' as const, value: await provider.createInstantClone({ workspaceId: row.workspaceId, creatorIdentityId: row.creatorIdentityId, kind: 'INSTANT', name: `voice-${row.creatorIdentityId.slice(-6)}-retry`, samples }) }
      : { kind: 'professional' as const, value: await provider.createProfessionalClone({ workspaceId: row.workspaceId, creatorIdentityId: row.creatorIdentityId, kind: 'PROFESSIONAL', name: `voice-${row.creatorIdentityId.slice(-6)}-retry`, samples }) };
  const updated = await deps.db
    .update(voiceClones)
    .set({
      status: result.kind === 'instant' ? 'READY' : 'SUBMITTED',
      providerVoiceId: result.kind === 'instant' ? result.value.providerVoiceId : null,
      providerJobId: result.kind === 'professional' ? result.value.providerJobId : null,
      failure: null,
      submittedAt: now,
      trainedAt: result.kind === 'instant' ? now : null,
      updatedAt: now,
    })
    .where(eq(voiceClones.id, row.id))
    .returning();
  const next = updated[0];
  if (next === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'clone retry failed', 500);
  if (result.kind === 'instant') {
    await bindIdentity(deps, { workspaceId: row.workspaceId, creatorIdentityId: row.creatorIdentityId, provider: row.provider, providerVoiceId: result.value.providerVoiceId, kind: row.kind, mode: row.mode });
  }
  await emitVoiceEvent(deps, row.workspaceId, 'voice_clone.retried', { cloneId: row.id });
  return toCloneDto(next);
}

/* ---------- 生命周期三态：退休 / 平台解绑 / Provider 删除 ---------- */

async function loadLatestClone(deps: DomainDeps, input: { workspaceId: string; creatorIdentityId: string }): Promise<typeof voiceClones.$inferSelect> {
  const rows = await deps.db
    .select()
    .from(voiceClones)
    .where(and(eq(voiceClones.workspaceId, input.workspaceId), eq(voiceClones.creatorIdentityId, input.creatorIdentityId)))
    .orderBy(desc(voiceClones.createdAt))
    .limit(1);
  const row = rows[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, '无克隆记录', 404);
  return row;
}

/** 本地退休：不再作为默认/新项目使用；Provider 侧声音保留（与解绑/删除可区分）。 */
export async function retireVoiceClone(deps: DomainDeps, input: { workspaceId: string; creatorIdentityId: string }): Promise<VoiceClone> {
  const row = await loadLatestClone(deps, input);
  if (row.status === 'PROVIDER_DELETED') {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'Provider 侧已删除——本地退休无意义', 409, { reason: VOICE_CLONE_ERROR_REASONS.INVALID_STATE });
  }
  const now = new Date();
  const updated = await deps.db.update(voiceClones).set({ status: 'RETIRED', retiredAt: now, updatedAt: now }).where(eq(voiceClones.id, row.id)).returning();
  const next = updated[0];
  if (next === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'clone retire failed', 500);
  // 身份侧：标记退休（历史 Project 仍保留可审计引用——providerVoiceId 不清空）
  await deps.db
    .update(voiceIdentities)
    .set({ status: 'RETIRED', retiredAt: now, updatedAt: now })
    .where(eq(voiceIdentities.creatorIdentityId, input.creatorIdentityId));
  await emitVoiceEvent(deps, row.workspaceId, 'voice_clone.retired', { cloneId: row.id });
  return toCloneDto(next);
}

/** 平台解绑：断开与 Creator Identity 的关联（Provider 侧保留；providerVoiceId 仅存于克隆记录供审计）。 */
export async function unlinkVoiceClone(deps: DomainDeps, input: { workspaceId: string; creatorIdentityId: string }): Promise<VoiceClone> {
  const row = await loadLatestClone(deps, input);
  if (row.status === 'PROVIDER_DELETED') {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'Provider 侧已删除——解绑无意义', 409, { reason: VOICE_CLONE_ERROR_REASONS.INVALID_STATE });
  }
  const now = new Date();
  const updated = await deps.db.update(voiceClones).set({ status: 'UNLINKED', unlinkedAt: now, updatedAt: now }).where(eq(voiceClones.id, row.id)).returning();
  const next = updated[0];
  if (next === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'clone unlink failed', 500);
  await deps.db
    .update(voiceIdentities)
    .set({ provider: null, providerVoiceId: null, status: 'UNLINKED', updatedAt: now })
    .where(eq(voiceIdentities.creatorIdentityId, input.creatorIdentityId));
  await emitVoiceEvent(deps, row.workspaceId, 'voice_clone.unlinked', { cloneId: row.id });
  return toCloneDto(next);
}

/** Provider 侧删除（不可恢复；与本地退休/解绑可区分）。 */
export async function deleteVoiceCloneAtProvider(
  deps: DomainDeps,
  input: { workspaceId: string; creatorIdentityId: string; provider: VoiceCloneProvider | undefined },
): Promise<VoiceClone> {
  const provider = input.provider;
  if (provider === undefined) {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, '声音克隆 Provider 未装配（501 fail-closed）', 501, { reason: VOICE_CLONE_ERROR_REASONS.CLONE_PROVIDER_UNAVAILABLE });
  }
  const row = await loadLatestClone(deps, input);
  if (row.providerVoiceId === null) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '克隆尚无 Provider 声音（未就绪）', 409, { reason: VOICE_CLONE_ERROR_REASONS.INVALID_STATE, status: row.status });
  }
  if (row.providerDeletedAt !== null) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'Provider 侧已删除（重复操作）', 409, { reason: VOICE_CLONE_ERROR_REASONS.INVALID_STATE });
  }
  await provider.deleteVoice({ providerVoiceId: row.providerVoiceId });
  const now = new Date();
  const updated = await deps.db.update(voiceClones).set({ status: 'PROVIDER_DELETED', providerDeletedAt: now, updatedAt: now }).where(eq(voiceClones.id, row.id)).returning();
  const next = updated[0];
  if (next === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'provider delete failed', 500);
  // 身份侧：声音已不存在 → 清除 provider 引用（历史记录仍在克隆行）
  await deps.db
    .update(voiceIdentities)
    .set({ provider: null, providerVoiceId: null, status: 'PROVIDER_DELETED', updatedAt: now })
    .where(eq(voiceIdentities.creatorIdentityId, input.creatorIdentityId));
  await emitVoiceEvent(deps, row.workspaceId, 'voice_clone.provider_deleted', { cloneId: row.id });
  return toCloneDto(next);
}

