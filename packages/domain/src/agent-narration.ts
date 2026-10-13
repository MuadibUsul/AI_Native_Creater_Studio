import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  ASSET_DEFAULT_RETENTION,
  ApiFailure,
  ERROR_CODES,
  MAX_NARRATION_CHARS,
  NARRATION_ERROR_REASONS,
  NARRATION_TRACK_PREFIX,
  compareMediaTime,
  mediaTimeSchema,
  mediaTimeToDisplaySecondsText,
  narrationMetadataSchema,
  type EditOperation,
  type MediaTime,
  type NarrationMetadata,
  type Rational,
} from '@ancs/contracts';
import type { KernelClip, TimelineState } from '@ancs/kernel';
import { assets, assetVersions } from '@ancs/db';
import type { DomainDeps } from './deps.js';
import { agentSecondsToTime } from './agent-operations.js';
import { simulateAgentDraft, type AgentToolContext, type AgentToolDefinition, type AgentToolOutcome } from './agent-tools.js';
import { assertProjectGenerationAllowed } from './project-document.js';

/**
 * V6-5 讲述（配音）的导演工具（V6 §4.2、§11）：`list_voices` / `add_narration` / `remove_narration`。
 *
 * - AI 写讲述稿 → 逐句交给 Worker 装配的语音合成引擎 → 拼成一条音频资产（来源 GENERATED）→
 *   作为普通片段放在讲述轨（VO*，音频轨）上；字幕按每句在音频里的真实位置生成，并用 speechAnchorId 绑定到讲述片段。
 *   预览、终渲染、撤销、试改/采用都沿用时间线的同一套机制。
 * - 合成语音受项目制作规则约束（`speech.generate`），每次合成前服务端校验；字幕另受 `captions.generate` 约束。
 * - 每个声音如实声明能说的语言；说不了的语言明确拒绝（不用英文声音硬读中文）。
 * - 同一段讲述（同引擎、声音、语速、句子）复用已有音频，不重复合成。
 * 这里没有按视频类型或策略分支的逻辑：讲述只是 AI 可以选用的组件（裁决 0018）。
 */

const MAX_SENTENCE_CHARS = 200;
const MIN_SPEED = 0.7;
const MAX_SPEED = 1.4;

const json = (value: unknown): string => JSON.stringify(value);
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const seconds = (time: MediaTime): string => mediaTimeToDisplaySecondsText(time, 3);

const fail = (message: string, reason: string, details: Record<string, unknown> = {}): AgentToolOutcome =>
  ({ content: json({ error: message, reason, ...details }), isError: true, summary: `narration: ${reason}` });

const CJK = /[㐀-鿿豈-﫿]/;

/** 讲述稿的主要语言（只用来检查声音能不能说）：含中日韩汉字 → zh，否则 en。 */
export function narrationLanguage(text: string): 'zh' | 'en' {
  return CJK.test(text) ? 'zh' : 'en';
}

/**
 * 把讲述稿拆成句子（中英文句末标点；过长的句子再按逗号拆），去掉空句。
 * 逐句合成后句界精确，字幕按句出现。
 */
const TERMINATORS = new Set(['。', '！', '？', '!', '?', '；', ';', '…']);
const CLOSERS = new Set(['"', '”', '’', "'", '）', ')', '」', '』', '】']);

export function splitNarrationSentences(text: string): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized === '') return [];
  // 句末：中英文终止符，或后面是空格/结尾的英文句点（"3.5"、"e.g.x" 里的点不算）；紧跟的终止符与右引号/括号并入本句
  const chars = [...normalized];
  const sentences: string[] = [];
  let current = '';
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]!;
    current += char;
    const next = chars[index + 1];
    const afterCloser = chars[index + 2];
    const periodEnds = char === '.' && (next === undefined || next === ' ' || (CLOSERS.has(next) && (afterCloser === undefined || afterCloser === ' ')));
    if (!(TERMINATORS.has(char) || periodEnds)) continue;
    while (index + 1 < chars.length && (TERMINATORS.has(chars[index + 1]!) || CLOSERS.has(chars[index + 1]!) || chars[index + 1] === '.')) {
      index += 1;
      current += chars[index]!;
    }
    sentences.push(current.trim());
    current = '';
  }
  if (current.trim() !== '') sentences.push(current.trim());
  const out: string[] = [];
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (sentence === '') continue;
    if (sentence.length <= MAX_SENTENCE_CHARS) { out.push(sentence); continue; }
    // 过长：按逗号拆，再不行按长度硬切
    let current = '';
    for (const piece of sentence.split(/(?<=[，,、])/)) {
      if ((current + piece).length > MAX_SENTENCE_CHARS && current !== '') { out.push(current.trim()); current = ''; }
      current += piece;
      while (current.length > MAX_SENTENCE_CHARS) { out.push(current.slice(0, MAX_SENTENCE_CHARS).trim()); current = current.slice(MAX_SENTENCE_CHARS); }
    }
    if (current.trim() !== '') out.push(current.trim());
  }
  // 只有标点的碎片并到前一句
  return out.reduce<string[]>((merged, sentence) => {
    if (!/[\p{L}\p{N}]/u.test(sentence) && merged.length > 0) merged[merged.length - 1] = `${merged[merged.length - 1]!}${sentence}`;
    else merged.push(sentence);
    return merged;
  }, []);
}

// ---------------------------------------------------------------------------
// 讲述音频资产
// ---------------------------------------------------------------------------

export interface NarrationRef {
  footageId: string;
  assetId: string;
  narration: NarrationMetadata;
}

/** 读这些资产版本里的讲述音频（不是讲述的版本不返回）。 */
export async function loadNarrations(deps: DomainDeps, workspaceId: string, versionIds: readonly string[]): Promise<Map<string, NarrationRef>> {
  if (versionIds.length === 0) return new Map();
  const rows = await deps.db.select({ versionId: assetVersions.id, assetId: assets.id, metadata: assets.metadata }).from(assetVersions)
    .innerJoin(assets, eq(assets.id, assetVersions.assetId))
    .where(and(eq(assetVersions.workspaceId, workspaceId), inArray(assetVersions.id, [...new Set(versionIds)]), eq(assets.assetType, 'VOICE_AUDIO'), eq(assets.origin, 'GENERATED')));
  const out = new Map<string, NarrationRef>();
  for (const row of rows) {
    const parsed = narrationMetadataSchema.safeParse((row.metadata as { narration?: unknown } | null)?.narration);
    if (parsed.success) out.set(row.versionId, { footageId: row.versionId, assetId: row.assetId, narration: parsed.data });
  }
  return out;
}

/** 时间线上引用的讲述音频（给时间线视图、自检排除用）。 */
export async function narrationsOnTimeline(context: Pick<AgentToolContext, 'deps' | 'workspaceId'>, timeline: TimelineState, sequenceId: string): Promise<Map<string, NarrationRef>> {
  const ids = timeline.clips.filter((clip) => clip.sequenceId === sequenceId && clip.assetVersionId !== null).map((clip) => clip.assetVersionId as string);
  return loadNarrations(context.deps, context.workspaceId, ids);
}

interface SynthesizedNarration {
  footageId: string;
  reused: boolean;
  durationMs: number;
  narration: NarrationMetadata;
}

async function synthesizeNarration(context: AgentToolContext, input: { text: string; sentences: string[]; voice: string; speed: number; language: string }): Promise<SynthesizedNarration> {
  const ports = context.narration;
  if (ports === undefined) throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'narration is not configured in this deployment', 501, { reason: NARRATION_ERROR_REASONS.UNAVAILABLE });
  const storage = context.deps.storage;
  if (storage === undefined) throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'object storage is not configured', 501, { reason: NARRATION_ERROR_REASONS.UNAVAILABLE });
  const synthesizer = ports.synthesizer;
  const narrationKey = sha256(json({ engine: synthesizer.engine, voice: input.voice, speed: input.speed, sentences: input.sentences }));
  const existing = await context.deps.db.select({ versionId: assets.currentVersionId, metadata: assets.metadata, durationMs: assetVersions.durationMs }).from(assets)
    .innerJoin(assetVersions, eq(assetVersions.id, assets.currentVersionId))
    .where(and(eq(assets.workspaceId, context.workspaceId), eq(assets.projectId, context.projectId), eq(assets.assetType, 'VOICE_AUDIO'), eq(assets.status, 'READY'), sql`(${assets.metadata} ->> 'narrationKey') = ${narrationKey}`))
    .limit(1);
  const reuse = existing[0];
  const reusedMetadata = reuse === undefined ? null : narrationMetadataSchema.safeParse((reuse.metadata as { narration?: unknown } | null)?.narration).data ?? null;
  if (reuse?.versionId !== undefined && reuse.versionId !== null && reusedMetadata !== null && reuse.durationMs !== null) {
    return { footageId: reuse.versionId, reused: true, durationMs: reuse.durationMs, narration: reusedMetadata };
  }

  const started = Date.now();
  const output = await synthesizer.synthesize({ sentences: input.sentences, voice: input.voice, speed: input.speed });
  if (output.probe.status !== 'READY' || output.sentences.length !== input.sentences.length || output.durationMs <= 0) {
    throw new ApiFailure(ERROR_CODES.INTERNAL, 'synthesized narration is not usable', 500, { reason: NARRATION_ERROR_REASONS.SYNTHESIS_FAILED });
  }
  const narration = narrationMetadataSchema.parse({
    kind: 'NARRATION', text: input.text, voice: input.voice, engine: synthesizer.engine, speed: input.speed, language: input.language,
    sentences: input.sentences.map((text, index) => ({ text, startMs: Math.round(output.sentences[index]!.startMs), endMs: Math.round(output.sentences[index]!.endMs) })),
    synthesisMs: Math.max(0, Date.now() - started),
  });
  const assetId = `ast_${randomUUID()}`;
  const versionId = `av_${randomUUID()}`;
  const extension = output.mimeType === 'audio/wav' || output.mimeType === 'audio/x-wav' ? 'wav' : output.mimeType === 'audio/mpeg' ? 'mp3' : 'audio';
  const storageKey = `workspaces/${context.workspaceId}/projects/${context.projectId}/narration/${versionId}/narration.${extension}`;
  await storage.putObject(storageKey, output.audio);
  await context.deps.db.transaction(async (tx) => {
    await tx.insert(assets).values({
      id: assetId, workspaceId: context.workspaceId, projectId: context.projectId, assetType: 'VOICE_AUDIO', origin: 'GENERATED',
      provider: synthesizer.engine, providerAssetId: null, status: 'READY', retentionClass: ASSET_DEFAULT_RETENTION.VOICE_AUDIO,
      license: { type: 'USER_OWNED', holder: null, attribution: null, sourceUrl: null, termsUrl: null, notes: `合成配音（引擎 ${synthesizer.engine}，声音 ${input.voice}）`, confirmedBy: null, confirmedAt: null },
      metadata: { filename: `narration.${extension}`, mimeType: output.mimeType, narration, narrationKey },
      currentVersionId: versionId,
      createdBy: context.actorId === 'agent' ? null : context.actorId,
    });
    await tx.insert(assetVersions).values({
      id: versionId, assetId, workspaceId: context.workspaceId, versionNumber: 1, storageKey,
      mimeType: output.mimeType, sizeBytes: output.audio.byteLength, checksumSha256: createHash('sha256').update(output.audio).digest('hex'),
      durationMs: Math.round(output.durationMs), width: null, height: null, status: 'READY', probeStatus: 'READY', mediaProbe: output.probe,
      metadata: { narrationKey },
    });
  });
  return { footageId: versionId, reused: false, durationMs: Math.round(output.durationMs), narration };
}

// ---------------------------------------------------------------------------
// 时间线放置
// ---------------------------------------------------------------------------

/** 毫秒 → 序列时基（向下取整到时基网格，片段不会超出音频长度）。 */
function msToTime(ms: number, timebase: Rational): MediaTime {
  const ticks = Math.floor((Math.max(0, ms) * timebase.den) / (1000 * timebase.num));
  return mediaTimeSchema.parse({ ticks: String(ticks), timebase });
}

const addTime = (left: MediaTime, right: MediaTime): MediaTime => mediaTimeSchema.parse({ ticks: (BigInt(left.ticks) + BigInt(right.ticks)).toString(), timebase: left.timebase });

function overlaps(clip: KernelClip, start: MediaTime, end: MediaTime): boolean {
  return compareMediaTime(clip.sequenceRange.start, end) < 0 && compareMediaTime(start, clip.sequenceRange.end) < 0;
}

function narrationTracks(state: TimelineState, sequenceId: string) {
  return state.tracks.filter((track) => track.sequenceId === sequenceId && track.kind === 'AUDIO' && track.name.startsWith(NARRATION_TRACK_PREFIX))
    .sort((left, right) => left.position - right.position);
}

/** 讲述片段默认接在已有讲述的后面（连续调用 add_narration 自然排成一条讲述线）。 */
function narrationEnd(state: TimelineState, sequenceId: string): MediaTime | null {
  const trackIds = new Set(narrationTracks(state, sequenceId).map((track) => track.id));
  let end: MediaTime | null = null;
  for (const clip of state.clips) {
    if (!trackIds.has(clip.trackId)) continue;
    if (end === null || compareMediaTime(clip.sequenceRange.end, end) > 0) end = clip.sequenceRange.end;
  }
  return end;
}

function placementTrack(state: TimelineState, sequenceId: string, start: MediaTime, end: MediaTime): { trackId: string; create: EditOperation | null } {
  const tracks = narrationTracks(state, sequenceId);
  for (const track of tracks) {
    if (track.locked) continue;
    if (!state.clips.some((clip) => clip.trackId === track.id && overlaps(clip, start, end))) return { trackId: track.id, create: null };
  }
  const trackId = `trk_${randomUUID()}`;
  const all = state.tracks.filter((track) => track.sequenceId === sequenceId);
  const position = all.length === 0 ? 0 : Math.max(...all.map((track) => track.position)) + 1;
  return { trackId, create: { op: 'create_track', sequenceId, track: { kind: 'AUDIO', position, name: `${NARRATION_TRACK_PREFIX}${String(tracks.length + 1)}` }, restoreTrackId: trackId } };
}

function captionTrack(state: TimelineState, sequenceId: string): { trackId: string; create: EditOperation | null } {
  const existing = state.tracks.filter((track) => track.sequenceId === sequenceId && track.kind === 'CAPTION' && !track.locked).sort((left, right) => left.position - right.position)[0];
  if (existing !== undefined) return { trackId: existing.id, create: null };
  const trackId = `trk_${randomUUID()}`;
  const all = state.tracks.filter((track) => track.sequenceId === sequenceId);
  const position = all.length === 0 ? 0 : Math.max(...all.map((track) => track.position)) + 1;
  return { trackId, create: { op: 'create_track', sequenceId, track: { kind: 'CAPTION', position, name: 'C1' }, restoreTrackId: trackId } };
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

const secondsSchema = z.union([z.string().max(20), z.number().nonnegative().max(1e6)]).describe('Seconds as a decimal string, e.g. "12.5".');

const addNarrationInput = z.object({
  text: z.string().min(1).max(MAX_NARRATION_CHARS).describe(`The words to speak, written for the ear (short sentences, no headings or lists). Up to ${String(MAX_NARRATION_CHARS)} characters; split longer scripts into several narration parts.`),
  voice: z.string().min(1).max(64).optional().describe('Voice id from list_voices; defaults to the first voice that speaks the language of the text.'),
  at: secondsSchema.optional().describe('Timeline start; defaults to right after the existing narration, else the pointer time, else 0.'),
  speed: z.number().min(MIN_SPEED).max(MAX_SPEED).optional().describe('Speaking rate, 1 = normal.'),
  captions: z.boolean().optional().describe('Add a caption for each sentence, timed to the speech (default true when the project rules allow captions).'),
}).strict();

const removeNarrationInput = z.object({
  clipId: z.string().min(1).max(200).describe('A narration clip id from get_timeline.'),
}).strict();

async function speechAllowed(context: AgentToolContext): Promise<boolean> {
  return assertProjectGenerationAllowed(context.deps, { workspaceId: context.workspaceId, projectId: context.projectId, capability: 'speech.generate' }).then(() => true, () => false);
}

async function captionsAllowed(context: AgentToolContext): Promise<boolean> {
  return assertProjectGenerationAllowed(context.deps, { workspaceId: context.workspaceId, projectId: context.projectId, capability: 'captions.generate' }).then(() => true, () => false);
}

const listVoicesTool: AgentToolDefinition<Record<string, never>> = {
  descriptor: {
    name: 'list_voices', capability: 'narration.voices', effect: 'READ', permission: 'project:read', metered: false,
    description: 'List the voices you can narrate with (each with the languages it speaks), the speech engine, and whether the project rules allow a synthesized voice-over. Call it before add_narration.',
  },
  input: z.object({}).strict(),
  async run(context) {
    const allowed = await speechAllowed(context);
    if (context.narration === undefined) {
      return { content: json({ available: false, allowedByProjectRules: allowed, note: 'No speech engine is configured in this deployment: you cannot add narration. Say so, and offer captions or diagram cards instead.' }), isError: false, summary: 'narration unavailable' };
    }
    const synthesizer = context.narration.synthesizer;
    return {
      content: json({
        available: true,
        allowedByProjectRules: allowed,
        ...(allowed ? {} : { note: 'The project rules do not allow a synthesized voice-over. Tell the person they can turn narration on for this project, then ask again.' }),
        engine: synthesizer.engine,
        voices: synthesizer.voices(),
      }),
      isError: false,
      summary: `${String(synthesizer.voices().length)} voices (${synthesizer.engine})`,
    };
  },
};

const addNarrationTool: AgentToolDefinition<z.infer<typeof addNarrationInput>> = {
  descriptor: {
    name: 'add_narration', capability: 'narration.add', effect: 'DRAFT_EDIT', permission: 'project:write', metered: false,
    description: [
      'Add a spoken voice-over: synthesizes your narration script with a voice from list_voices and places it on a narration audio track, with one caption per sentence timed to the speech.',
      'Write for listening: short sentences, plain words, numbers as the source states them. Successive calls continue after the existing narration, so narrate a script part by part and time the pictures to each part (the result gives each sentence\'s timeline time).',
      'The narration goes into your draft like any edit; use remove_narration to take a part out again.',
    ].join(' '),
  },
  input: addNarrationInput,
  async run(context, input) {
    if (context.narration === undefined) return fail('narration is not configured in this deployment', NARRATION_ERROR_REASONS.UNAVAILABLE);
    if (!(await speechAllowed(context))) return fail('the project rules do not allow a synthesized voice-over; the person can turn narration on for this project', 'PRODUCTION_POLICY_BLOCKED');
    const sentences = splitNarrationSentences(input.text);
    if (sentences.length === 0) return fail('the narration text is empty', 'AGENT_EDIT_INVALID');
    const language = narrationLanguage(input.text);
    const voices = context.narration.synthesizer.voices();
    const voice = input.voice === undefined ? voices.find((candidate) => candidate.languages.includes(language)) : voices.find((candidate) => candidate.id === input.voice);
    if (voice === undefined) {
      return input.voice === undefined
        ? fail(`no configured voice speaks ${language === 'zh' ? 'Chinese' : 'English'}; tell the person a ${language === 'zh' ? 'Chinese' : 'English'} voice has to be configured, or narrate in a language a voice speaks`, NARRATION_ERROR_REASONS.LANGUAGE_UNSUPPORTED, { voices })
        : fail(`unknown voice ${input.voice}`, NARRATION_ERROR_REASONS.VOICE_NOT_FOUND, { voices });
    }
    if (!voice.languages.includes(language)) {
      return fail(`voice ${voice.id} speaks ${voice.languages.join(', ')} only, but the text is ${language}`, NARRATION_ERROR_REASONS.LANGUAGE_UNSUPPORTED, { voices });
    }
    try {
      return await placeNarration(context, { text: input.text.trim(), sentences, voice: voice.id, speed: input.speed ?? 1, language, at: input.at, captions: input.captions });
    } catch (error) {
      if (error instanceof ApiFailure && error.httpStatus < 500) return fail(error.message, String(error.details['reason'] ?? error.code), { details: error.details });
      if (error instanceof ApiFailure) return fail(error.message, String(error.details['reason'] ?? error.code));
      // 合成引擎失败：如实交还 AI（不自动重试）
      return fail(`speech synthesis failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`, NARRATION_ERROR_REASONS.SYNTHESIS_FAILED);
    }
  },
};

async function placeNarration(context: AgentToolContext, input: { text: string; sentences: string[]; voice: string; speed: number; language: string; at: string | number | undefined; captions: boolean | undefined }): Promise<AgentToolOutcome> {
  const baseline = await simulateAgentDraft(context, context.draft);
  const state = baseline.timeline;
  const sequence = state.sequences.get(context.sequenceId);
  if (sequence === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'sequence not found', 404);
  const timebase = mediaTimeSchema.parse(sequence.duration).timebase;
  const at = input.at !== undefined ? agentSecondsToTime(input.at, timebase)
    : narrationEnd(state, context.sequenceId) ?? agentSecondsToTime(context.pointer?.timeRange?.start ?? '0', timebase);

  const synthesized = await synthesizeNarration(context, { text: input.text, sentences: input.sentences, voice: input.voice, speed: input.speed, language: input.language });
  const length = msToTime(synthesized.durationMs, timebase);
  if (BigInt(length.ticks) <= 0n) return fail('the synthesized narration is too short to place', NARRATION_ERROR_REASONS.SYNTHESIS_FAILED);
  const end = addTime(at, length);
  const { trackId, create } = placementTrack(state, context.sequenceId, at, end);
  const clipId = `clp_${randomUUID()}`;
  const zero = mediaTimeSchema.parse({ ticks: '0', timebase });
  const operations: EditOperation[] = [
    ...(create === null ? [] : [create]),
    ...(compareMediaTime(end, sequence.duration) > 0 ? [{ op: 'set_sequence_duration' as const, sequenceId: context.sequenceId, duration: end }] : []),
    {
      op: 'insert_clip', sequenceId: context.sequenceId, trackId, assetVersionId: synthesized.footageId, nestedSequenceId: null, sourceStreamId: null,
      sourceRange: { start: zero, end: length }, mode: 'OVERWRITE', sequenceStart: at, linkAudio: false, audioTrackId: null,
      createdClipId: clipId, createdAudioClipId: `clp_${randomUUID()}`,
    },
  ];
  const wantCaptions = input.captions !== false && await captionsAllowed(context);
  const timedSentences = synthesized.narration.sentences.map((sentence) => {
    const start = addTime(at, msToTime(sentence.startMs, timebase));
    const stop = addTime(at, msToTime(Math.min(sentence.endMs, synthesized.durationMs), timebase));
    return { text: sentence.text, start, end: compareMediaTime(stop, end) > 0 ? end : stop };
  });
  let captionCount = 0;
  if (wantCaptions) {
    const track = captionTrack(state, context.sequenceId);
    if (track.create !== null) operations.push(track.create);
    for (const sentence of timedSentences) {
      if (compareMediaTime(sentence.end, sentence.start) <= 0) continue;
      captionCount += 1;
      operations.push({
        op: 'create_caption', sequenceId: context.sequenceId, trackId: track.trackId,
        timeBinding: { basis: 'SEQUENCE', clipId: null, semanticCueId: null },
        localRange: { start: zero, end: mediaTimeSchema.parse({ ticks: (BigInt(sentence.end.ticks) - BigInt(sentence.start.ticks)).toString(), timebase }) },
        sequenceRange: { start: sentence.start, end: sentence.end },
        text: sentence.text, languageTag: input.language === 'zh' ? 'zh-CN' : 'en', style: { schemaVersion: '1.0', values: {} }, words: [],
        speechAnchorId: clipId, restoreCaptionId: `cap_${randomUUID()}`,
      });
    }
  }
  const all = [...context.draft.operations, ...operations];
  await simulateAgentDraft(context, { baseRevision: baseline.baseRevision, operations: all });
  return {
    content: json({
      clipId,
      at: [seconds(at), seconds(end)],
      voice: input.voice,
      sentences: timedSentences.map((sentence) => ({ text: sentence.text, at: [seconds(sentence.start), seconds(sentence.end)] })),
      captions: wantCaptions ? captionCount : 'not added (project rules or your choice)',
      synthesis: synthesized.reused ? 'reused identical narration audio' : `synthesized in ${String(synthesized.narration.synthesisMs)} ms (${synthesized.narration.engine})`,
    }),
    isError: false,
    summary: `added narration (${String(input.sentences.length)} sentences) at ${seconds(at)}s`,
    draftOperations: all,
    ...(baseline.baseRevision === context.draft.baseRevision ? {} : { baseRevision: baseline.baseRevision }),
  };
}

const removeNarrationTool: AgentToolDefinition<z.infer<typeof removeNarrationInput>> = {
  descriptor: {
    name: 'remove_narration', capability: 'narration.remove', effect: 'DRAFT_EDIT', permission: 'project:write', metered: false,
    description: 'Remove a narration part from the timeline together with its captions. Other clips do not move.',
  },
  input: removeNarrationInput,
  async run(context, input) {
    const simulated = await simulateAgentDraft(context, context.draft);
    const clip = simulated.timeline.clips.find((item) => item.id === input.clipId && item.sequenceId === context.sequenceId);
    if (clip === undefined) return fail(`clip ${input.clipId} is not on this timeline`, 'AGENT_EDIT_INVALID');
    const narration = clip.assetVersionId === null ? undefined : (await loadNarrations(context.deps, context.workspaceId, [clip.assetVersionId])).get(clip.assetVersionId);
    if (narration === undefined) return fail(`clip ${input.clipId} is not narration`, NARRATION_ERROR_REASONS.NOT_NARRATION);
    const captions = simulated.timeline.captions.filter((caption) => caption.sequenceId === context.sequenceId && caption.speechAnchorId === clip.id);
    const operations: EditOperation[] = [
      ...context.draft.operations,
      ...captions.map((caption) => ({ op: 'delete_caption' as const, captionId: caption.id })),
      { op: 'delete_clip', clipId: clip.id },
    ];
    try {
      await simulateAgentDraft(context, { baseRevision: simulated.baseRevision, operations });
    } catch (error) {
      if (error instanceof ApiFailure && error.httpStatus < 500) return fail(error.message, String(error.details['reason'] ?? error.code));
      throw error;
    }
    return {
      content: json({ removed: clip.id, captionsRemoved: captions.length }),
      isError: false,
      summary: `removed narration ${clip.id}`,
      draftOperations: operations,
      ...(simulated.baseRevision === context.draft.baseRevision ? {} : { baseRevision: simulated.baseRevision }),
    };
  },
};

export const NARRATION_AGENT_TOOLS = [listVoicesTool, addNarrationTool, removeNarrationTool] as const;
