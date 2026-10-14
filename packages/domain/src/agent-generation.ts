import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  AVATAR_FRAMINGS,
  ApiFailure,
  GENERATION_ERROR_REASONS,
  GENERATION_KINDS,
  GENERATION_QUOTE_TTL_MINUTES,
  MAX_GENERATION_PROMPT_CHARS,
  MAX_NARRATION_CHARS,
  compareMediaTime,
  frameRegionSchema,
  generationRequestSchema,
  mediaTimeSchema,
  mediaTimeToDisplaySeconds,
  mediaTimeToDisplaySecondsText,
  type GenerationKind,
  type GenerationOffer,
  type GenerationRequest,
  type MediaTime,
  type Rational,
} from '@ancs/contracts';
import type { KernelClip, TimelineState } from '@ancs/kernel';
import { generationRequests } from '@ancs/db';
import { agentSecondsToTime } from './agent-operations.js';
import { simulateAgentDraft, type AgentToolContext, type AgentToolDefinition, type AgentToolOutcome } from './agent-tools.js';
import { identityForGeneration, listIdentityProfiles } from './identity-profiles.js';
import { estimateSpeechSeconds, formatMicros, generationBudget, quoteGeneration, toGeneration } from './paid-generation-quote.js';
import { assertProjectGenerationAllowed, getProjectProductionPolicy } from './project-document.js';

/**
 * V6-7 / V6-8 付费生成的导演工具（V6 §7.3 第三档、§4.3）：`list_generation_options` / `quote_generation`。
 *
 * AI 只能**报价**：建一份报价（供应商、时长、费用区间、有效期）交给用户在界面上确认；
 * 确认、预算预留、生成、结算都不在工具里，AI 也无法代为确认。工具目录对所有视频类型相同（裁决 0018）。
 */

const json = (value: unknown): string => JSON.stringify(value);
const secondsSchema = z.union([z.string().max(20), z.number().nonnegative().max(1e6)]).describe('Seconds as a decimal string, e.g. "12.5".');

const fail = (message: string, reason: string, details: Record<string, unknown> = {}): AgentToolOutcome =>
  ({ content: json({ error: message, reason, ...details }), isError: true, summary: `generation: ${reason}` });

const KIND_NOTES: Record<GenerationKind, string> = {
  AVATAR_CLIP: 'digital-human clip: the person\'s own likeness and voice saying a script (needs a ready identity with consent)',
  VIDEO_SHOT: 'a new generated shot (B-roll) from a prompt',
  VIDEO_REGION: 'regenerate a drawn region of an existing picture clip over a time range (outside the region stays untouched)',
};

/** 每类最便宜（按上限）的报价依据。 */
function bestOffer(offers: readonly GenerationOffer[], kind: GenerationKind): GenerationOffer | null {
  return [...offers].filter((offer) => offer.kind === kind).sort((left, right) => left.perSecondMicros.max - right.perSecondMicros.max)[0] ?? null;
}

const priceText = (offer: GenerationOffer): string => `${formatMicros(offer.perSecondMicros.min)}–${formatMicros(offer.perSecondMicros.max)} per second`;

async function pendingQuotes(context: AgentToolContext) {
  const rows = await context.deps.db.select().from(generationRequests)
    .where(and(eq(generationRequests.workspaceId, context.workspaceId), eq(generationRequests.projectId, context.projectId)))
    .orderBy(desc(generationRequests.createdAt)).limit(10);
  return rows.map((row) => toGeneration(row)).map((item) => ({
    quoteId: item.id, kind: item.kind, summary: item.summary, status: item.status,
    estimate: `${formatMicros(item.estimate.minMicros)}–${formatMicros(item.estimate.maxMicros)}`,
    ...(item.chargedMicros === null ? {} : { charged: formatMicros(item.chargedMicros) }),
  }));
}

const listGenerationOptionsTool: AgentToolDefinition<Record<string, never>> = {
  descriptor: {
    name: 'list_generation_options', capability: 'generation.options', effect: 'READ', permission: 'project:read', metered: false,
    description: [
      'What paid generation this project can use: which kinds this deployment offers (with price per second, longest single generation and languages),',
      'whether the project rules allow generated video and speech, the person\'s identities (likeness and voice readiness), the workspace generation budget,',
      'and recent quotes with their status. Paid generation is the most expensive and least controllable option: prefer editing the footage and code-generated effects;',
      'use it only when the person asks for it or nothing else can do the job.',
    ].join(' '),
  },
  input: z.object({}).strict(),
  run: async (context) => {
    const offers = context.generation?.offers() ?? [];
    const policy = await getProjectProductionPolicy(context.deps, { workspaceId: context.workspaceId, projectId: context.projectId });
    const identities = await listIdentityProfiles(context.deps, { workspaceId: context.workspaceId });
    const budget = await generationBudget(context.deps, { workspaceId: context.workspaceId });
    return {
      content: json({
        policy: { generatedVideo: policy.allowGeneratedVideo, generatedSpeech: policy.allowGeneratedSpeech },
        offers: GENERATION_KINDS.map((kind) => {
          const offer = bestOffer(offers, kind);
          return offer === null
            ? { kind, available: false, what: KIND_NOTES[kind] }
            : { kind, available: true, what: KIND_NOTES[kind], price: priceText(offer), maxSeconds: offer.maxSeconds, ...(offer.languages.length === 0 ? {} : { languages: offer.languages }), ...(offer.implementation === 'SCRIPTED' ? { note: 'test double in this deployment' } : {}) };
        }),
        identities: identities.map((identity) => ({
          id: identity.id,
          name: identity.name,
          likeness: identity.likeness.ready ? 'READY' : identity.likeness.reference === null ? 'NO_PHOTO' : 'NO_CONSENT',
          voice: identity.voice.ready ? 'READY' : identity.voice.reference === null ? 'NO_SAMPLE' : 'NO_CONSENT',
        })),
        budget: budget.configured
          ? { configured: true, remaining: formatMicros(Math.max(0, (budget.limitMicros ?? 0) - budget.spentMicros - budget.reservedMicros)) }
          : { configured: false, note: 'No generation budget is set for this workspace: confirming a quote will be refused until the owner sets one.' },
        recentQuotes: await pendingQuotes(context),
      }),
      isError: false,
      summary: `generation options: ${String(offers.length)} offer(s), ${String(identities.length)} identit${identities.length === 1 ? 'y' : 'ies'}`,
    };
  },
};

const quoteInput = z.object({
  kind: z.enum(GENERATION_KINDS),
  summary: z.string().trim().min(1).max(300).describe('One sentence in the session language saying what will be generated and where; shown to the person next to the price.'),
  identityId: z.string().max(80).optional().describe('AVATAR_CLIP: whose likeness and voice (an identity from list_generation_options).'),
  script: z.string().max(MAX_NARRATION_CHARS).optional().describe('AVATAR_CLIP: exactly what the digital human says.'),
  language: z.string().regex(/^[a-z]{2,3}$/).optional().describe('AVATAR_CLIP: language of the script, BCP 47 primary tag (en, zh, ...).'),
  framing: z.enum(AVATAR_FRAMINGS).optional().describe('AVATAR_CLIP: FULL = full frame on camera (default); CORNER = small picture-in-picture at the bottom right.'),
  prompt: z.string().max(MAX_GENERATION_PROMPT_CHARS).optional().describe('VIDEO_SHOT / VIDEO_REGION: what to generate, concretely (subject, motion, camera, light, style matching the footage).'),
  at: secondsSchema.optional().describe('AVATAR_CLIP / VIDEO_SHOT: timeline start; defaults to the start of the pointer time range, else 0.'),
  seconds: secondsSchema.optional().describe('VIDEO_SHOT: length in seconds.'),
  clipId: z.string().max(80).optional().describe('VIDEO_REGION: the picture clip to regenerate part of; defaults to the clip the person pointed at.'),
  start: secondsSchema.optional().describe('VIDEO_REGION: timeline start of the range; defaults to the pointer time range.'),
  end: secondsSchema.optional().describe('VIDEO_REGION: timeline end of the range.'),
  region: frameRegionSchema.optional().describe('VIDEO_REGION: the area to regenerate (0-1, origin top-left); defaults to the region the person drew.'),
}).strict();
type QuoteInput = z.infer<typeof quoteInput>;

const subtractSeconds = (end: MediaTime, start: MediaTime): number => mediaTimeToDisplaySeconds(end) - mediaTimeToDisplaySeconds(start);

/** 片段是否 1 倍速（源时长 = 时间线时长）：选区重绘按源时间取画面，变速片段暂不支持。 */
function isNormalSpeed(clip: KernelClip): boolean {
  return Math.abs(subtractSeconds(clip.sourceRange.end, clip.sourceRange.start) - subtractSeconds(clip.sequenceRange.end, clip.sequenceRange.start)) < 1e-6;
}

type RegionRequest = Extract<GenerationRequest, { kind: 'VIDEO_REGION' }>;

function regionRequest(state: TimelineState, timebase: Rational, context: AgentToolContext, input: QuoteInput, offer: GenerationOffer): RegionRequest | AgentToolOutcome {
  const prompt = input.prompt?.trim() ?? '';
  if (prompt.length === 0) return fail('VIDEO_REGION needs a prompt describing what the region should become', GENERATION_ERROR_REASONS.INVALID_REQUEST);
  const clipId = input.clipId ?? context.pointer?.clipIds[0];
  const clip = clipId === undefined ? undefined : state.clips.find((item) => item.id === clipId);
  const track = clip === undefined ? undefined : state.tracks.find((item) => item.id === clip.trackId);
  if (clip === undefined || track?.kind !== 'VIDEO' || clip.assetVersionId === null) {
    return fail('VIDEO_REGION needs a picture clip on the timeline (clipId, or the clip the person pointed at)', GENERATION_ERROR_REASONS.CLIP_NOT_FOUND, { clipId: clipId ?? null });
  }
  if (!isNormalSpeed(clip)) return fail('this clip plays at a changed speed; regenerating part of it is not supported', GENERATION_ERROR_REASONS.INVALID_REQUEST);
  const region = input.region ?? context.pointer?.frameRegion ?? null;
  if (region === null) return fail('VIDEO_REGION needs a region (or the person draws one on the picture)', GENERATION_ERROR_REASONS.INVALID_REQUEST);
  const start = agentSecondsToTime(input.start ?? context.pointer?.timeRange?.start ?? mediaTimeToDisplaySecondsText(clip.sequenceRange.start, 6), timebase);
  const end = agentSecondsToTime(input.end ?? context.pointer?.timeRange?.end ?? mediaTimeToDisplaySecondsText(clip.sequenceRange.end, 6), timebase);
  if (compareMediaTime(start, clip.sequenceRange.start) < 0 || compareMediaTime(end, clip.sequenceRange.end) > 0 || compareMediaTime(start, end) >= 0) {
    return fail(`the range must lie inside the clip (${mediaTimeToDisplaySecondsText(clip.sequenceRange.start, 3)}-${mediaTimeToDisplaySecondsText(clip.sequenceRange.end, 3)} s)`, GENERATION_ERROR_REASONS.INVALID_REQUEST);
  }
  const seconds = subtractSeconds(end, start);
  if (seconds > offer.maxSeconds) return fail(`at most ${String(offer.maxSeconds)} s per generation; quote a shorter range`, GENERATION_ERROR_REASONS.TOO_LONG, { maxSeconds: offer.maxSeconds });
  return { kind: 'VIDEO_REGION', prompt, clipId: clip.id, start, end, region };
}

async function quote(context: AgentToolContext, input: QuoteInput): Promise<AgentToolOutcome> {
  const offer = bestOffer(context.generation?.offers() ?? [], input.kind);
  if (offer === null) return fail(`this deployment has no provider for ${input.kind}`, GENERATION_ERROR_REASONS.UNAVAILABLE);
  try {
    await assertProjectGenerationAllowed(context.deps, { workspaceId: context.workspaceId, projectId: context.projectId, capability: 'video.generate' });
    if (input.kind === 'AVATAR_CLIP') await assertProjectGenerationAllowed(context.deps, { workspaceId: context.workspaceId, projectId: context.projectId, capability: 'speech.generate' });
  } catch (error) {
    if (error instanceof ApiFailure && error.httpStatus < 500) return fail(`${error.message}; the person can allow it in the project rules`, String(error.details['reason'] ?? error.code), { details: error.details });
    throw error;
  }
  const { timeline: state } = await simulateAgentDraft(context, context.draft);
  const sequence = state.sequences.get(context.sequenceId);
  if (sequence === undefined) return fail('sequence not found', GENERATION_ERROR_REASONS.INVALID_REQUEST);
  const timebase = mediaTimeSchema.parse(sequence.duration).timebase;
  const at = (): MediaTime => agentSecondsToTime(input.at ?? context.pointer?.timeRange?.start ?? '0', timebase);

  let request: GenerationRequest;
  let seconds: number;
  let identitySnapshot: Record<string, unknown> | null = null;
  if (input.kind === 'AVATAR_CLIP') {
    const script = input.script?.trim() ?? '';
    if (script.length === 0 || input.identityId === undefined) return fail('AVATAR_CLIP needs identityId and script', GENERATION_ERROR_REASONS.INVALID_REQUEST);
    const language = input.language ?? (context.locale === 'en' ? 'en' : 'zh');
    if (offer.languages.length > 0 && !offer.languages.includes(language)) {
      return fail(`the digital-human provider cannot speak "${language}" (it speaks ${offer.languages.join(', ')})`, GENERATION_ERROR_REASONS.LANGUAGE_UNSUPPORTED, { languages: offer.languages });
    }
    const identity = await identityForGeneration(context.deps, { workspaceId: context.workspaceId, identityId: input.identityId }).catch((error: unknown) => {
      if (error instanceof ApiFailure && error.httpStatus === 404) return null;
      throw error;
    });
    if (identity === null) return fail('identity not found', GENERATION_ERROR_REASONS.IDENTITY_NOT_FOUND, { identityId: input.identityId });
    const missing = (['LIKENESS', 'VOICE'] as const).filter((kind) => identity.parts[kind] === null);
    if (missing.length > 0) {
      const noReference = missing.some((kind) => (kind === 'LIKENESS' ? identity.profile.likeness.reference : identity.profile.voice.reference) === null);
      return fail(
        `${identity.profile.name} is not ready: ${missing.map((kind) => (kind === 'LIKENESS' ? 'likeness (photo + consent)' : 'voice (sample + consent)')).join(' and ')} missing; the person sets this up on the identity page`,
        noReference ? GENERATION_ERROR_REASONS.REFERENCE_REQUIRED : GENERATION_ERROR_REASONS.CONSENT_REQUIRED,
        { missing },
      );
    }
    seconds = estimateSpeechSeconds(script, language);
    if (seconds > offer.maxSeconds) return fail(`this script would run about ${seconds.toFixed(1)} s; at most ${String(offer.maxSeconds)} s per clip, so split it into several quotes`, GENERATION_ERROR_REASONS.TOO_LONG, { maxSeconds: offer.maxSeconds });
    request = { kind: 'AVATAR_CLIP', identityId: input.identityId, script, language, at: at(), framing: input.framing ?? 'FULL' };
    identitySnapshot = {
      identityId: input.identityId,
      likeness: { footageId: identity.parts.LIKENESS!.footageId, consentRecordId: identity.parts.LIKENESS!.consentRecordId },
      voice: { footageId: identity.parts.VOICE!.footageId, consentRecordId: identity.parts.VOICE!.consentRecordId },
    };
  } else if (input.kind === 'VIDEO_SHOT') {
    const prompt = input.prompt?.trim() ?? '';
    if (prompt.length === 0 || input.seconds === undefined) return fail('VIDEO_SHOT needs a prompt and seconds', GENERATION_ERROR_REASONS.INVALID_REQUEST);
    const duration = agentSecondsToTime(input.seconds, timebase);
    seconds = mediaTimeToDisplaySeconds(duration);
    if (seconds < 0.5) return fail('a generated shot must be at least 0.5 s', GENERATION_ERROR_REASONS.INVALID_REQUEST);
    if (seconds > offer.maxSeconds) return fail(`at most ${String(offer.maxSeconds)} s per generated shot`, GENERATION_ERROR_REASONS.TOO_LONG, { maxSeconds: offer.maxSeconds });
    request = { kind: 'VIDEO_SHOT', prompt, at: at(), duration };
  } else {
    const built = regionRequest(state, timebase, context, input, offer);
    if ('isError' in built) return built;
    request = built;
    seconds = subtractSeconds(built.end, built.start);
  }

  const priced = quoteGeneration(offer, input.kind, seconds);
  const id = `gen_${randomUUID()}`;
  const expiresAt = new Date(Date.now() + GENERATION_QUOTE_TTL_MINUTES * 60_000);
  const estimatedSeconds = input.kind === 'AVATAR_CLIP' ? seconds.toFixed(1) : trimSeconds(seconds);
  await context.deps.db.insert(generationRequests).values({
    id,
    workspaceId: context.workspaceId,
    projectId: context.projectId,
    sessionId: context.sessionId ?? null,
    quoteTurnId: context.turnId ?? null,
    kind: input.kind,
    status: 'QUOTED',
    request: generationRequestSchema.parse(request),
    summary: input.summary,
    providerId: offer.providerId,
    providerImplementation: offer.implementation,
    model: offer.model,
    estimatedSeconds,
    estimateMinMicros: priced.minMicros,
    estimateMaxMicros: priced.maxMicros,
    reserveCredits: priced.reserveCredits,
    identitySnapshot,
    expiresAt,
  });
  const budget = await generationBudget(context.deps, { workspaceId: context.workspaceId });
  const estimate = `${formatMicros(priced.minMicros)}–${formatMicros(priced.maxMicros)}`;
  return {
    content: json({
      quoteId: id,
      kind: input.kind,
      provider: { id: offer.providerId, model: offer.model, ...(offer.implementation === 'SCRIPTED' ? { note: 'test double' } : {}) },
      seconds: input.kind === 'AVATAR_CLIP' ? `about ${estimatedSeconds} (${String(priced.minSeconds)}-${String(priced.maxSeconds)})` : estimatedSeconds,
      estimate,
      expiresInMinutes: GENERATION_QUOTE_TTL_MINUTES,
      ...(budget.configured ? {} : { budget: 'No generation budget is set for this workspace; confirming will be refused until the owner sets one.' }),
      next: 'This is only a quote. The person confirms or declines it in the interface, where it is shown with the price; nothing is generated or charged until they confirm. Tell them the estimate; do not say it has been generated.',
    }),
    isError: false,
    summary: `quoted ${input.kind} ${estimate}`,
  };
}

const trimSeconds = (value: number): string => {
  const text = value.toFixed(3);
  return text.replace(/0+$/, '').replace(/\.$/, '');
};

const quoteGenerationTool: AgentToolDefinition<QuoteInput> = {
  descriptor: {
    name: 'quote_generation', capability: 'generation.quote', effect: 'GENERATE', permission: 'project:write', metered: true,
    description: [
      'Create a price quote for one paid generation; the person must confirm it in the interface before anything is generated or charged (you cannot confirm it).',
      'Kinds: AVATAR_CLIP (the person\'s digital human says a script, in their own voice; full frame or picture-in-picture),',
      'VIDEO_SHOT (a new shot from a prompt, placed at a time), VIDEO_REGION (regenerate a drawn region of a picture clip over a time range; outside the region stays the original).',
      'When confirmed, the result is generated once (no automatic retries), stored, and placed into the trial edit like any other change.',
      'Check list_generation_options first. Only quote what the person asked for or clearly needs; one quote per piece.',
    ].join(' '),
  },
  input: quoteInput,
  run: quote,
};

export const GENERATION_AGENT_TOOLS = [listGenerationOptionsTool, quoteGenerationTool] as const;
