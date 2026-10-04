import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { parseWavPcm16 } from './wav.js';
import {
  ALIGNMENT_ERROR_REASONS,
  ApiFailure,
  ERROR_CODES,
  alignmentSegmentSchema,
  masterNarrationSchema,
  narrationCueSchema,
  type AlignmentSegment,
  type AlignmentWord,
  type MasterNarration,
  type NarrationBlock,
  type NarrationCue,
  type SpeechPlan,
  type SynthesisVoiceRef,
} from '@ancs/contracts';
import { assetVersions, assets, masterNarrations } from '@ancs/db';
import { getChannel } from './channels.js';
import { getCreatorIdentity } from './creator-identities.js';
import { getPlan } from './narrative.js';
import { getProject } from './projects.js';
import { planSpeech } from './speech-plan.js';
import type { DomainDeps } from './channels.js';

/**
 * Master Narration 与 Alignment 服务（P06-03 / 规范 §5.1、§58）。
 *
 * 流程（Audio-First）：
 *   旁白块 → 逐段合成（**带词级时间戳**）→ 分段音频落自有存储 → **拼接 Master 音频（WAV）**
 *   → 全局 Alignment（绝对时间轴）+ narration cues（驱动画面/字幕/Avatar 的唯一时间基础）。
 *
 * 纪律：
 * - **不接受"仅按字数估计"的 Final 对齐**（§5.1）：Provider 无时间戳时必须配置 AlignmentProvider，
 *   否则明确失败（TIMESTAMPS_UNAVAILABLE）——绝不用估计值冒充对齐；
 * - 分段音频**缓存复用**：改一句话只重新合成该段（其余段按 cacheKey 命中复用，不重复付费调用）；
 * - 分段音频/主音频只落 storage_key（§75 第 5 条）；Provider 私有参数只出现在 Adapter 调用瞬间（§94）；
 * - 结果**追加式**落库（master_narrations；当前 = 最新 createdAt）。
 */

/** 分段音频缓存键（内容 + 声音 + 语速 + 风格指令派生；同输入必得同键）。 */
export function segmentCacheKey(input: { text: string; speed: number; styleInstruction: string | null; voiceKey: string }): string {
  return createHash('sha256')
    .update(`${input.voiceKey}|${String(input.speed)}|${input.styleInstruction ?? ''}|${input.text}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
}

/** 对齐组装（纯函数）：段级绝对时间轴 + 词级偏移 + cues。 */
export function buildAlignment(
  segments: { narrationBlockId: string; text: string; durationMs: number; words: AlignmentWord[]; cacheKey: string; reused: boolean }[],
): { alignment: AlignmentSegment[]; cues: NarrationCue[]; totalDurationMs: number } {
  let cursor = 0;
  const alignment: AlignmentSegment[] = [];
  const cues: NarrationCue[] = [];
  for (const segment of segments) {
    const startMs = cursor;
    const durationMs = Math.max(1, Math.round(segment.durationMs));
    alignment.push(
      alignmentSegmentSchema.parse({
        narrationBlockId: segment.narrationBlockId,
        text: segment.text,
        charCount: [...segment.text].length,
        startMs,
        durationMs,
        endMs: startMs + durationMs,
        words: segment.words,
        cacheKey: segment.cacheKey,
        reused: segment.reused,
      }),
    );
    cues.push(narrationCueSchema.parse({ narrationBlockId: segment.narrationBlockId, startMs, durationMs }));
    cursor += durationMs;
  }
  return { alignment, cues, totalDurationMs: cursor };
}

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** WAV（PCM16）拼接：仅接受同采样率/同声道数的段；非 WAV/不一致 → null（交由渲染管线）。 */
export function concatWavSegments(segments: readonly Uint8Array[], parse: (bytes: Uint8Array) => { sampleRate: number; channels: number; dataOffset: number; dataLength: number } | null): Uint8Array | null {
  if (segments.length === 0) return null;
  const parsed = segments.map((bytes) => parse(bytes));
  const first = parsed[0];
  if (first === null || first === undefined) return null;
  for (const item of parsed) {
    if (item === null || item === undefined) return null;
    if (item.sampleRate !== first.sampleRate || item.channels !== first.channels) return null;
  }
  const totalDataLength = parsed.reduce((sum, item) => sum + (item?.dataLength ?? 0), 0);
  const buffer = new ArrayBuffer(44 + totalDataLength);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + totalDataLength, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, first.channels, true);
  view.setUint32(24, first.sampleRate, true);
  view.setUint32(28, first.sampleRate * first.channels * 2, true);
  view.setUint16(32, first.channels * 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, totalDataLength, true);
  let offset = 44;
  for (const [index, item] of parsed.entries()) {
    const source = segments[index];
    if (source === undefined || item === null || item === undefined) return null;
    new Uint8Array(buffer, offset, item.dataLength).set(source.subarray(item.dataOffset, item.dataOffset + item.dataLength));
    offset += item.dataLength;
  }
  return new Uint8Array(buffer);
}

function requireTts(deps: DomainDeps) {
  if (deps.tts === undefined) {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, '未配置 TTS 适配器：无法合成旁白（fail-closed）', 501, {
      reason: ALIGNMENT_ERROR_REASONS.TTS_UNAVAILABLE,
    });
  }
  return deps.tts;
}

function requireStorage(deps: DomainDeps) {
  if (deps.storage === undefined) {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, '未配置对象存储：分段音频必须落自有存储', 501, {
      reason: ALIGNMENT_ERROR_REASONS.STORAGE_UNAVAILABLE,
    });
  }
  return deps.storage;
}

/** 声音上下文（身份 + Provider 私有引用；仅用于 Adapter 映射层，绝不进入对齐/Scene 数据）。 */
export async function resolveSynthesisVoice(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; channelId: string; identityId?: string },
): Promise<SynthesisVoiceRef> {
  const channel = await getChannel(deps, { workspaceId: input.workspaceId, channelId: input.channelId });
  const identityId = input.identityId ?? channel.styleVersion.defaults.creatorIdentityId;
  if (identityId === null || identityId === undefined) return { voiceIdentityId: null, provider: null, providerVoiceId: null, languageProfile: null };
  const identity = await getCreatorIdentity(deps, { workspaceId: input.workspaceId, creatorIdentityId: identityId });
  const voice = identity.voiceIdentity;
  if (voice === null) return { voiceIdentityId: null, provider: null, providerVoiceId: null, languageProfile: null };
  return {
    voiceIdentityId: voice.id,
    provider: voice.provider,
    providerVoiceId: voice.providerVoiceId,
    languageProfile: voice.languageProfile,
  };
}

interface SynthesizedSegmentRecord {
  narrationBlockId: string;
  text: string;
  durationMs: number;
  words: AlignmentWord[];
  cacheKey: string;
  storageKey: string;
  reused: boolean;
}

/** 分段音频对象键（稳定派生；同缓存键 → 同键）。 */
export const segmentStorageKey = (workspaceId: string, projectId: string, cacheKey: string): string =>
  `workspaces/${workspaceId}/projects/${projectId}/narration/segments/${cacheKey}.wav`;

/**
 * 合成/重合成 Master Narration（追加式落库；`onlyBlockId` 提供时只重合成该段，其余命中缓存）。
 */
export async function synthesizeMasterNarration(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; planId: string; onlyBlockId?: string },
): Promise<MasterNarration> {
  const tts = requireTts(deps);
  const storage = requireStorage(deps);

  const plan = await getPlan(deps, { workspaceId: input.workspaceId, projectId: input.projectId, planId: input.planId });
  const blocks = plan.narrationBlocks;
  if (blocks.length === 0) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, '叙事计划没有旁白块：无可合成内容', 422, {
      reason: ALIGNMENT_ERROR_REASONS.NO_NARRATION_BLOCKS,
    });
  }
  if (input.onlyBlockId !== undefined && !blocks.some((block) => block.id === input.onlyBlockId)) {
    throw new ApiFailure(ERROR_CODES.NOT_FOUND, '旁白块不存在于当前计划', 404, {
      reason: ALIGNMENT_ERROR_REASONS.SEGMENT_NOT_FOUND,
    });
  }

  const project = await getProject(deps, { workspaceId: input.workspaceId, projectId: input.projectId });
  const speech = await planSpeech(deps, { workspaceId: input.workspaceId, projectId: input.projectId, planId: input.planId });
  const voice = await resolveSynthesisVoice(deps, { workspaceId: input.workspaceId, projectId: input.projectId, channelId: project.channelId });
  if (voice.voiceIdentityId === null) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '未绑定声音身份：合成前必须绑定 VoiceIdentity（§95）', 409, {
      reason: ALIGNMENT_ERROR_REASONS.VOICE_IDENTITY_REQUIRED,
    });
  }

  // 上一次 Master（缓存来源：同 cacheKey 的段直接复用音频与时间戳）
  const previousRows = await deps.db
    .select()
    .from(masterNarrations)
    .where(and(eq(masterNarrations.workspaceId, input.workspaceId), eq(masterNarrations.projectId, input.projectId), eq(masterNarrations.narrativePlanId, input.planId)))
    .orderBy(desc(masterNarrations.createdAt))
    .limit(1);
  const previousSegments = new Map<string, AlignmentSegment>();
  for (const segment of (previousRows[0]?.segments as AlignmentSegment[] | undefined) ?? []) {
    previousSegments.set(segment.narrationBlockId, segment);
  }

  const speechByBlock = new Map<string, SpeechPlan['segments'][number]>();
  for (const segment of speech.segments) {
    if (segment.narrationBlockId !== null) speechByBlock.set(segment.narrationBlockId, segment);
  }

  const warnings: string[] = [];
  const records: SynthesizedSegmentRecord[] = [];
  let alignmentMethod: MasterNarration['alignmentMethod'] = 'PROVIDER_TIMESTAMPS';

  for (const block of blocks) {
    const speechSegment = speechByBlock.get(block.id);
    const speed = speechSegment?.speed ?? 1;
    const styleInstruction = speechSegment?.styleInstruction ?? null;
    const cacheKey = segmentCacheKey({ text: block.text, speed, styleInstruction, voiceKey: `${voice.voiceIdentityId}@${String(voice.languageProfile)}` });
    const storageKey = segmentStorageKey(input.workspaceId, input.projectId, cacheKey);
    const previous = previousSegments.get(block.id);
    // 局部重建：只重合成目标段；其余段在 cacheKey 相同时复用（不重复调用 TTS）
    const isRebuildTarget = input.onlyBlockId !== undefined && block.id === input.onlyBlockId;
    const canReuse = !isRebuildTarget && previous !== undefined && previous.cacheKey === cacheKey;
    if (canReuse && previous !== undefined) {
      records.push({
        narrationBlockId: block.id,
        text: block.text,
        durationMs: previous.durationMs,
        words: previous.words,
        cacheKey,
        storageKey,
        reused: true,
      });
      continue;
    }

    const synthesized = await tts.synthesize({ text: block.text, voiceRef: voice, speed, styleInstruction });
    let words = synthesized.wordTimestamps;
    let durationMs = synthesized.durationMs;
    if (words === null) {
      // §5.1：Provider 无时间戳 → 必须由 AlignmentProvider 强制对齐；首期不接受按字数估计
      if (deps.aligner === undefined) {
        throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'TTS 未返回时间戳且未配置 AlignmentProvider：不接受按字数估计的 Final 对齐（§5.1）', 501, {
          reason: ALIGNMENT_ERROR_REASONS.TIMESTAMPS_UNAVAILABLE,
          narrationBlockId: block.id,
        });
      }
      const aligned = await deps.aligner.align({ bytes: synthesized.bytes, mimeType: synthesized.mimeType, text: block.text });
      words = aligned.words;
      durationMs = aligned.durationMs;
      alignmentMethod = 'ALIGNMENT_PROVIDER';
    }
    await storage.putObject(storageKey, synthesized.bytes);
    records.push({ narrationBlockId: block.id, text: block.text, durationMs, words, cacheKey, storageKey, reused: false });
  }

  const { alignment, cues, totalDurationMs } = buildAlignment(records);

  // 拼接 Master 音频（仅 WAV 且同格式；否则明确告警，交由渲染管线）
  const segmentBytes: Uint8Array[] = [];
  for (const record of records) {
    const bytes = await storage.getObject(record.storageKey);
    if (bytes === null) {
      throw new ApiFailure(ERROR_CODES.INTERNAL, `分段音频缺失：${record.storageKey}`, 500, { narrationBlockId: record.narrationBlockId });
    }
    segmentBytes.push(bytes);
  }
  const masterBytes = concatWavSegments(segmentBytes, parseWavPcm16);
  let assetId: string | null = null;
  let assetVersionId: string | null = null;
  let checksum: string | null = null;
  let sizeBytes: number | null = null;
  if (masterBytes === null) {
    warnings.push(
      `分段音频不是同格式 WAV（或为空）：未在域内拼接 Master 音频（${ALIGNMENT_ERROR_REASONS.MASTER_AUDIO_UNSUPPORTED_FORMAT}）；由渲染管线（P07）按 Alignment 拼接。`,
    );
  } else {
    assetId = `ast_${randomUUID()}`;
    const versionId = `av_${randomUUID()}`;
    assetVersionId = versionId;
    const masterKey = `workspaces/${input.workspaceId}/projects/${input.projectId}/narration/master/${randomUUID()}.wav`;
    await storage.putObject(masterKey, masterBytes);
    checksum = sha256Hex(masterBytes);
    sizeBytes = masterBytes.byteLength;
    await deps.db.transaction(async (tx) => {
      await tx.insert(assets).values({
        id: assetId as string,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        assetType: 'VOICE_AUDIO',
        origin: 'SYSTEM_RENDER',
        provider: null,
        providerAssetId: null,
        status: 'READY',
        retentionClass: 'KEEP_PAID_GENERATED',
        license: {
          type: 'PROVIDER_TERMS',
          holder: null,
          attribution: null,
          sourceUrl: null,
          termsUrl: null,
          notes: 'Master Narration（TTS 合成，按 Alignment 拼接）',
          confirmedBy: null,
          confirmedAt: null,
        },
        metadata: { masterNarrationForPlan: input.planId, planRevision: plan.revision },
        currentVersionId: versionId,
      });
      await tx.insert(assetVersions).values({
        id: versionId,
        assetId: assetId as string,
        workspaceId: input.workspaceId,
        versionNumber: 1,
        storageKey: masterKey,
        mimeType: 'audio/wav',
        sizeBytes: masterBytes.byteLength,
        checksumSha256: checksum,
        status: 'READY',
        metadata: { alignmentMethod, totalDurationMs },
      });
    });
  }

  const reused = records.filter((record) => record.reused).length;
  const row = {
    id: `mna_${randomUUID()}`,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    narrativePlanId: plan.id,
    narrativePlanRevision: plan.revision,
    assetId,
    assetVersionId,
    mimeType: masterBytes === null ? null : 'audio/wav',
    sizeBytes,
    checksumSha256: checksum,
    totalDurationMs,
    alignmentMethod,
    segments: alignment,
    cues,
    voiceIdentityId: voice.voiceIdentityId,
    voiceIdentityVersion: speech.voice.voiceIdentityVersion,
    speechProfileId: speech.speechProfile.id,
    speechProfileVersion: speech.speechProfile.version,
    cacheStats: { segments: records.length, reused, synthesized: records.length - reused },
    warnings,
  };
  const inserted = await deps.db.insert(masterNarrations).values(row).returning();
  const insertedRow = inserted[0];
  if (insertedRow === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'master narration insert failed', 500);

  return toMasterDto(insertedRow as typeof masterNarrations.$inferSelect);
}

const toMasterDto = (row: typeof masterNarrations.$inferSelect): MasterNarration =>
  masterNarrationSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    narrativePlanId: row.narrativePlanId,
    narrativePlanRevision: row.narrativePlanRevision,
    assetId: row.assetId,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    checksumSha256: row.checksumSha256,
    totalDurationMs: row.totalDurationMs,
    alignmentMethod: row.alignmentMethod,
    segments: row.segments,
    cues: row.cues,
    voice: { voiceIdentityId: row.voiceIdentityId, voiceIdentityVersion: row.voiceIdentityVersion },
    cacheStats: row.cacheStats,
    warnings: row.warnings,
    createdAt: row.createdAt.toISOString(),
  });

/** 当前 Master Narration（最新一条；无则 null）。 */
export async function getCurrentMasterNarration(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; planId?: string },
): Promise<MasterNarration | null> {
  const conditions = [eq(masterNarrations.workspaceId, input.workspaceId), eq(masterNarrations.projectId, input.projectId)];
  if (input.planId !== undefined) conditions.push(eq(masterNarrations.narrativePlanId, input.planId));
  const rows = await deps.db
    .select()
    .from(masterNarrations)
    .where(and(...conditions))
    .orderBy(desc(masterNarrations.createdAt))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : toMasterDto(row);
}

/** 旁白块 → narration cue 查询（供画面/字幕对齐使用；未合成时返回 null）。 */
export async function cueForBlock(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; planId: string; narrationBlockId: string },
): Promise<NarrationCue | null> {
  const master = await getCurrentMasterNarration(deps, input);
  return master?.cues.find((cue) => cue.narrationBlockId === input.narrationBlockId) ?? null;
}

/** 计划 revision 的旁白块（供上层校验；导出以避免重复查询）。 */
export type { NarrationBlock };
