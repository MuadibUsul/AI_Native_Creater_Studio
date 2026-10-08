import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  SUPPORTED_EFFECTS,
  animationBindingSchema,
  audioRegionSchema,
  captionSpanSchema,
  clipTimeMappingSchema,
  compareMediaTime,
  createAnimationBindingRequestSchema,
  createAudioRegionRequestSchema,
  createCaptionSpanRequestSchema,
  createEffectInstanceRequestSchema,
  createVisualObjectRequestSchema,
  effectInstanceSchema,
  mapRangeBoundary,
  mediaRangeDuration,
  mediaRangeSchema,
  mediaTimeSchema,
  repositionVisualObjectRequestSchema,
  sourcePtsToSequenceTime,
  timeBindingSchema,
  visualObjectSchema,
  type AnimationBinding,
  type AudioRegion,
  type CaptionSpan,
  type CreateAnimationBindingRequest,
  type CreateAudioRegionRequest,
  type CreateCaptionSpanRequest,
  type CreateEffectInstanceRequest,
  type CreateVisualObjectRequest,
  type EffectInstance,
  type MediaRange,
  type MediaTime,
  type RepositionVisualObjectRequest,
  type TimeBinding,
  type VisualObject,
} from '@ancs/contracts';
import {
  compositionAnimationBindings,
  compositionAudioRegions,
  compositionCaptionSpans,
  compositionEffectInstances,
  compositionVisualObjects,
  projectSequences,
  sequenceClips,
  sequenceTracks,
} from '@ancs/db';
import type { DomainDeps } from './channels.js';
import { loadProjectRow } from './projects.js';

const newId = (prefix: string): string => `${prefix}_${randomUUID()}`;
const zeroLike = (time: MediaTime): MediaTime => ({ ticks: '0', timebase: time.timebase });

type Fraction = { num: bigint; den: bigint };
const seconds = (time: MediaTime): Fraction => ({
  num: BigInt(time.ticks) * BigInt(time.timebase.num),
  den: BigInt(time.timebase.den),
});
const add = (left: Fraction, right: Fraction): Fraction => ({
  num: left.num * right.den + right.num * left.den,
  den: left.den * right.den,
});
const fractionLte = (left: Fraction, right: Fraction): boolean => left.num * right.den <= right.num * left.den;

function assertRangeWithin(inner: MediaRange, outer: MediaRange, reason: string): void {
  if (compareMediaTime(inner.start, outer.start) < 0 || compareMediaTime(inner.end, outer.end) > 0) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'bound local range exceeds its time domain', 422, { reason });
  }
}

function exactMapBoundary(time: MediaTime, from: MediaRange, to: MediaRange): MediaTime {
  const mapped = mapRangeBoundary(time, from, to, 'nearest');
  const roundTrip = mapRangeBoundary(mapped, to, from, 'nearest');
  if (compareMediaTime(roundTrip, time) !== 0) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'time mapping would lose precision', 422, {
      reason: 'TIME_PRECISION_LOSS',
    });
  }
  return mapped;
}

type ClipRow = typeof sequenceClips.$inferSelect;
async function resolveBoundRange(
  deps: DomainDeps,
  scope: { workspaceId: string; projectId: string; sequenceId: string },
  bindingInput: TimeBinding,
  localInput: MediaRange,
): Promise<{ binding: TimeBinding; localRange: MediaRange; sequenceRange: MediaRange; clip: ClipRow | null }> {
  const binding = timeBindingSchema.parse(bindingInput);
  const localRange = mediaRangeSchema.parse(localInput);
  const sequenceRows = await deps.db.select().from(projectSequences).where(and(
    eq(projectSequences.id, scope.sequenceId),
    eq(projectSequences.workspaceId, scope.workspaceId),
    eq(projectSequences.projectId, scope.projectId),
  )).limit(1);
  const sequence = sequenceRows[0];
  if (!sequence) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'sequence not found', 404);

  if (binding.basis === 'SEQUENCE') {
    const sequenceBounds = mediaRangeSchema.parse({ start: sequence.start, end: sequence.duration });
    assertRangeWithin(localRange, sequenceBounds, 'SEQUENCE_RANGE_OUT_OF_BOUNDS');
    return { binding, localRange, sequenceRange: localRange, clip: null };
  }
  if (binding.basis === 'SEMANTIC_CUE') {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'semantic cue timing must be resolved before persistence', 409, {
      reason: 'SEMANTIC_CUE_UNRESOLVED',
      semanticCueId: binding.semanticCueId,
    });
  }

  const clipRows = await deps.db.select().from(sequenceClips).where(and(
    eq(sequenceClips.id, binding.clipId!),
    eq(sequenceClips.workspaceId, scope.workspaceId),
    eq(sequenceClips.projectId, scope.projectId),
    eq(sequenceClips.sequenceId, scope.sequenceId),
  )).limit(1);
  const clip = clipRows[0];
  if (!clip) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'time binding clip not found', 404);
  const clipSequenceRange = mediaRangeSchema.parse(clip.sequenceRange);

  if (binding.basis === 'CLIP_LOCAL') {
    const duration = mediaRangeDuration(clipSequenceRange);
    const localDomain = mediaRangeSchema.parse({ start: zeroLike(duration), end: duration });
    assertRangeWithin(localRange, localDomain, 'CLIP_LOCAL_RANGE_OUT_OF_BOUNDS');
    return {
      binding,
      localRange,
      sequenceRange: mediaRangeSchema.parse({
        start: exactMapBoundary(localRange.start, localDomain, clipSequenceRange),
        end: exactMapBoundary(localRange.end, localDomain, clipSequenceRange),
      }),
      clip,
    };
  }

  if (clipTimeMappingSchema.parse(clip.timeMapping).direction === 'REVERSE') {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'source-bound objects on reverse clips require reverse interval mapping', 409, {
      reason: 'REVERSE_SOURCE_BINDING_UNSUPPORTED',
    });
  }
  const sourceRange = mediaRangeSchema.parse(clip.sourceRange);
  assertRangeWithin(localRange, sourceRange, 'SOURCE_RANGE_OUT_OF_BOUNDS');
  const start = sourcePtsToSequenceTime(localRange.start, sourceRange, clipSequenceRange, 'nearest');
  const end = sourcePtsToSequenceTime(localRange.end, sourceRange, clipSequenceRange, 'nearest');
  if (
    compareMediaTime(mapRangeBoundary(start, clipSequenceRange, sourceRange, 'nearest'), localRange.start) !== 0 ||
    compareMediaTime(mapRangeBoundary(end, clipSequenceRange, sourceRange, 'nearest'), localRange.end) !== 0
  ) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'source timing would lose precision', 422, { reason: 'TIME_PRECISION_LOSS' });
  }
  return { binding, localRange, sequenceRange: mediaRangeSchema.parse({ start, end }), clip };
}

async function requireTrack(
  deps: DomainDeps,
  scope: { workspaceId: string; projectId: string; sequenceId: string },
  trackId: string,
  kinds: readonly string[],
) {
  const rows = await deps.db.select().from(sequenceTracks).where(and(
    eq(sequenceTracks.id, trackId),
    eq(sequenceTracks.workspaceId, scope.workspaceId),
    eq(sequenceTracks.projectId, scope.projectId),
    eq(sequenceTracks.sequenceId, scope.sequenceId),
  )).limit(1);
  const track = rows[0];
  if (!track) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'track not found', 404);
  if (track.locked) throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'track is locked', 409, { reason: 'TRACK_LOCKED' });
  if (!kinds.includes(track.kind)) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, `track kind ${track.kind} does not accept this object`, 422, {
      reason: 'TRACK_KIND_MISMATCH',
      allowedKinds: kinds,
    });
  }
  return track;
}

const toVisualObject = (row: typeof compositionVisualObjects.$inferSelect): VisualObject => visualObjectSchema.parse({ ...row, createdAt: row.createdAt.toISOString() });
const toEffectInstance = (row: typeof compositionEffectInstances.$inferSelect): EffectInstance => effectInstanceSchema.parse({ ...row, createdAt: row.createdAt.toISOString() });
const toAnimationBinding = (row: typeof compositionAnimationBindings.$inferSelect): AnimationBinding => animationBindingSchema.parse({ ...row, createdAt: row.createdAt.toISOString() });
const toCaptionSpan = (row: typeof compositionCaptionSpans.$inferSelect): CaptionSpan => captionSpanSchema.parse({ ...row, createdAt: row.createdAt.toISOString() });
const toAudioRegion = (row: typeof compositionAudioRegions.$inferSelect): AudioRegion => audioRegionSchema.parse({ ...row, gainDb: Number(row.gainDb), pan: Number(row.pan), createdAt: row.createdAt.toISOString() });

export async function createVisualObject(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; sequenceId: string; input: CreateVisualObjectRequest },
): Promise<VisualObject> {
  await loadProjectRow(deps.db, input.workspaceId, input.projectId);
  const request = createVisualObjectRequestSchema.parse(input.input);
  await requireTrack(deps, input, request.trackId, ['VIDEO', 'GRAPHIC']);
  const timing = await resolveBoundRange(deps, input, request.timeBinding, request.localRange);
  if (request.parentObjectId != null) {
    const parent = await deps.db.select({ id: compositionVisualObjects.id }).from(compositionVisualObjects).where(and(
      eq(compositionVisualObjects.id, request.parentObjectId),
      eq(compositionVisualObjects.workspaceId, input.workspaceId),
      eq(compositionVisualObjects.projectId, input.projectId),
      eq(compositionVisualObjects.sequenceId, input.sequenceId),
    )).limit(1);
    if (!parent[0]) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'parent visual object not found', 404);
  }
  const id = newId('vobj');
  const now = new Date();
  await deps.db.insert(compositionVisualObjects).values({
    id,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    sequenceId: input.sequenceId,
    trackId: request.trackId,
    kind: request.kind,
    parentObjectId: request.parentObjectId ?? null,
    semanticSceneId: request.semanticSceneId ?? null,
    timeBinding: timing.binding,
    localRange: timing.localRange,
    sequenceRange: timing.sequenceRange,
    component: request.component ?? null,
    parameters: request.parameters,
    createdAt: now,
    updatedAt: now,
  });
  return toVisualObject((await deps.db.select().from(compositionVisualObjects).where(eq(compositionVisualObjects.id, id)).limit(1))[0]!);
}

export async function repositionVisualObject(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; sequenceId: string; objectId: string; input: RepositionVisualObjectRequest },
): Promise<VisualObject> {
  const request = repositionVisualObjectRequestSchema.parse(input.input);
  const rows = await deps.db.select().from(compositionVisualObjects).where(and(
    eq(compositionVisualObjects.id, input.objectId),
    eq(compositionVisualObjects.workspaceId, input.workspaceId),
    eq(compositionVisualObjects.projectId, input.projectId),
    eq(compositionVisualObjects.sequenceId, input.sequenceId),
  )).limit(1);
  if (!rows[0]) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'visual object not found', 404);
  await requireTrack(deps, input, request.trackId, ['VIDEO', 'GRAPHIC']);
  const timing = await resolveBoundRange(deps, input, request.timeBinding, request.localRange);
  await deps.db.update(compositionVisualObjects).set({
    trackId: request.trackId,
    timeBinding: timing.binding,
    localRange: timing.localRange,
    sequenceRange: timing.sequenceRange,
    updatedAt: new Date(),
  }).where(eq(compositionVisualObjects.id, input.objectId));
  return toVisualObject((await deps.db.select().from(compositionVisualObjects).where(eq(compositionVisualObjects.id, input.objectId)).limit(1))[0]!);
}

const effectRegistry = SUPPORTED_EFFECTS as Record<string, { versions: readonly string[]; requiredCapability: string }>;

async function resolveEffectTarget(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; targetKind: string; targetId: string },
): Promise<string> {
  if (input.targetKind === 'CLIP') {
    const rows = await deps.db.select({ sequenceId: sequenceClips.sequenceId }).from(sequenceClips).where(and(eq(sequenceClips.id, input.targetId), eq(sequenceClips.workspaceId, input.workspaceId), eq(sequenceClips.projectId, input.projectId))).limit(1);
    if (!rows[0]) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'effect target clip not found', 404);
    return rows[0].sequenceId;
  }
  if (input.targetKind === 'VISUAL_OBJECT') {
    const rows = await deps.db.select({ sequenceId: compositionVisualObjects.sequenceId }).from(compositionVisualObjects).where(and(eq(compositionVisualObjects.id, input.targetId), eq(compositionVisualObjects.workspaceId, input.workspaceId), eq(compositionVisualObjects.projectId, input.projectId))).limit(1);
    if (!rows[0]) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'effect target visual object not found', 404);
    return rows[0].sequenceId;
  }
  if (input.targetKind === 'AUDIO_REGION') {
    const rows = await deps.db.select({ sequenceId: compositionAudioRegions.sequenceId }).from(compositionAudioRegions).where(and(eq(compositionAudioRegions.id, input.targetId), eq(compositionAudioRegions.workspaceId, input.workspaceId), eq(compositionAudioRegions.projectId, input.projectId))).limit(1);
    if (!rows[0]) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'effect target audio region not found', 404);
    return rows[0].sequenceId;
  }
  const rows = await deps.db.select({ sequenceId: sequenceTracks.sequenceId }).from(sequenceTracks).where(and(eq(sequenceTracks.id, input.targetId), eq(sequenceTracks.workspaceId, input.workspaceId), eq(sequenceTracks.projectId, input.projectId))).limit(1);
  if (!rows[0]) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'effect target track not found', 404);
  return rows[0].sequenceId;
}

export async function createEffectInstance(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; input: CreateEffectInstanceRequest },
): Promise<EffectInstance> {
  const request = createEffectInstanceRequestSchema.parse(input.input);
  const definition = effectRegistry[request.effectType];
  if (!definition || !definition.versions.includes(request.effectVersion)) {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'effect type or version is not supported', 422, { reason: 'UNSUPPORTED_EFFECT', effectType: request.effectType, effectVersion: request.effectVersion });
  }
  const sequenceId = await resolveEffectTarget(deps, { ...input, ...request });
  const id = newId('efx');
  const now = new Date();
  await deps.db.insert(compositionEffectInstances).values({
    id,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    sequenceId,
    targetKind: request.targetKind,
    targetId: request.targetId,
    effectType: request.effectType,
    effectVersion: request.effectVersion,
    requiredCapability: definition.requiredCapability,
    parameters: request.parameters,
    enabled: request.enabled ?? true,
    createdAt: now,
    updatedAt: now,
  });
  return toEffectInstance((await deps.db.select().from(compositionEffectInstances).where(eq(compositionEffectInstances.id, id)).limit(1))[0]!);
}

export function assertEffectExecutionSupported(effect: EffectInstance, capabilities: ReadonlySet<string>): void {
  if (!capabilities.has(effect.requiredCapability)) {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'effect execution capability is unavailable', 409, { reason: 'EFFECT_EXECUTION_UNAVAILABLE', effectId: effect.id, requiredCapability: effect.requiredCapability });
  }
}

async function animationTargetContext(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; targetKind: string; targetId: string },
): Promise<{ sequenceId: string; binding: TimeBinding; range: MediaRange }> {
  if (input.targetKind === 'VISUAL_OBJECT') {
    const rows = await deps.db.select().from(compositionVisualObjects).where(and(eq(compositionVisualObjects.id, input.targetId), eq(compositionVisualObjects.workspaceId, input.workspaceId), eq(compositionVisualObjects.projectId, input.projectId))).limit(1);
    const row = rows[0];
    if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'animation target visual object not found', 404);
    return { sequenceId: row.sequenceId, binding: timeBindingSchema.parse(row.timeBinding), range: mediaRangeSchema.parse(row.localRange) };
  }
  if (input.targetKind === 'AUDIO_REGION') {
    const rows = await deps.db.select().from(compositionAudioRegions).where(and(eq(compositionAudioRegions.id, input.targetId), eq(compositionAudioRegions.workspaceId, input.workspaceId), eq(compositionAudioRegions.projectId, input.projectId))).limit(1);
    const row = rows[0];
    if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'animation target audio region not found', 404);
    return { sequenceId: row.sequenceId, binding: timeBindingSchema.parse(row.timeBinding), range: mediaRangeSchema.parse(row.localRange) };
  }
  const effects = await deps.db.select().from(compositionEffectInstances).where(and(eq(compositionEffectInstances.id, input.targetId), eq(compositionEffectInstances.workspaceId, input.workspaceId), eq(compositionEffectInstances.projectId, input.projectId))).limit(1);
  const effect = effects[0];
  if (!effect) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'animation target effect not found', 404);
  if (effect.targetKind === 'VISUAL_OBJECT' || effect.targetKind === 'AUDIO_REGION') {
    return animationTargetContext(deps, { ...input, targetKind: effect.targetKind, targetId: effect.targetId });
  }
  if (effect.targetKind === 'CLIP') {
    const clips = await deps.db.select().from(sequenceClips).where(and(eq(sequenceClips.id, effect.targetId), eq(sequenceClips.workspaceId, input.workspaceId), eq(sequenceClips.projectId, input.projectId))).limit(1);
    const clip = clips[0];
    if (!clip) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'effect target clip not found', 404);
    const duration = mediaRangeDuration(mediaRangeSchema.parse(clip.sequenceRange));
    return { sequenceId: clip.sequenceId, binding: timeBindingSchema.parse({ basis: 'CLIP_LOCAL', clipId: clip.id, semanticCueId: null }), range: mediaRangeSchema.parse({ start: zeroLike(duration), end: duration }) };
  }
  const tracks = await deps.db.select().from(sequenceTracks).where(and(eq(sequenceTracks.id, effect.targetId), eq(sequenceTracks.workspaceId, input.workspaceId), eq(sequenceTracks.projectId, input.projectId))).limit(1);
  const track = tracks[0];
  if (!track) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'effect target track not found', 404);
  const sequences = await deps.db.select().from(projectSequences).where(eq(projectSequences.id, track.sequenceId)).limit(1);
  const sequence = sequences[0]!;
  return { sequenceId: track.sequenceId, binding: timeBindingSchema.parse({ basis: 'SEQUENCE', clipId: null, semanticCueId: null }), range: mediaRangeSchema.parse({ start: sequence.start, end: sequence.duration }) };
}

export async function createAnimationBinding(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; input: CreateAnimationBindingRequest },
): Promise<AnimationBinding> {
  const request = createAnimationBindingRequestSchema.parse(input.input);
  const context = await animationTargetContext(deps, { ...input, ...request });
  if (JSON.stringify(context.binding) !== JSON.stringify(request.timeBinding)) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'animation time binding must match its target', 422, { reason: 'TIME_BINDING_MISMATCH' });
  }
  for (const keyframe of request.keyframes) {
    if (compareMediaTime(keyframe.time, context.range.start) < 0 || compareMediaTime(keyframe.time, context.range.end) > 0) {
      throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'keyframe lies outside target local range', 422, { reason: 'KEYFRAME_OUT_OF_BOUNDS' });
    }
  }
  const id = newId('anim');
  const now = new Date();
  await deps.db.insert(compositionAnimationBindings).values({
    id,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    sequenceId: context.sequenceId,
    targetKind: request.targetKind,
    targetId: request.targetId,
    propertyPath: request.propertyPath,
    parameterSchemaVersion: request.parameterSchemaVersion,
    timeBinding: request.timeBinding,
    keyframes: request.keyframes.map((keyframe) => ({ ...keyframe, id: newId('kf') })),
    createdAt: now,
    updatedAt: now,
  });
  return toAnimationBinding((await deps.db.select().from(compositionAnimationBindings).where(eq(compositionAnimationBindings.id, id)).limit(1))[0]!);
}

export async function createCaptionSpan(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; sequenceId: string; input: CreateCaptionSpanRequest },
): Promise<CaptionSpan> {
  const request = createCaptionSpanRequestSchema.parse(input.input);
  await requireTrack(deps, input, request.trackId, ['CAPTION']);
  const timing = await resolveBoundRange(deps, input, request.timeBinding, request.localRange);
  for (const word of request.words) assertRangeWithin(word.range, request.localRange, 'CAPTION_WORD_OUT_OF_BOUNDS');
  const id = newId('cap');
  const now = new Date();
  await deps.db.insert(compositionCaptionSpans).values({
    id,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    sequenceId: input.sequenceId,
    trackId: request.trackId,
    timeBinding: timing.binding,
    localRange: timing.localRange,
    sequenceRange: timing.sequenceRange,
    text: request.text,
    languageTag: request.languageTag,
    style: request.style,
    words: request.words.map((word) => ({ ...word, id: newId('cw') })),
    speechAnchorId: request.speechAnchorId ?? null,
    createdAt: now,
    updatedAt: now,
  });
  return toCaptionSpan((await deps.db.select().from(compositionCaptionSpans).where(eq(compositionCaptionSpans.id, id)).limit(1))[0]!);
}

export async function createAudioRegion(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; sequenceId: string; input: CreateAudioRegionRequest },
): Promise<AudioRegion> {
  const request = createAudioRegionRequestSchema.parse(input.input);
  await requireTrack(deps, input, request.trackId, ['AUDIO']);
  if (request.timeBinding.basis !== 'CLIP_LOCAL' && request.timeBinding.basis !== 'SOURCE') {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'audio regions require a clip-bound time basis', 422, { reason: 'AUDIO_SOURCE_REQUIRED' });
  }
  const timing = await resolveBoundRange(deps, input, request.timeBinding, request.localRange);
  if (timing.clip?.sourceStreamId != null && timing.clip.sourceStreamId !== request.sourceStreamId) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'audio source stream does not match the bound clip', 422, { reason: 'SOURCE_STREAM_MISMATCH' });
  }
  const sourceChannels = new Set(request.channelMapping.map((item) => item.sourceChannel));
  if (sourceChannels.size !== request.channelMapping.length) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'each source channel may be mapped once', 422, { reason: 'DUPLICATE_SOURCE_CHANNEL' });
  }
  const duration = seconds(mediaRangeDuration(request.localRange));
  const fadeIn = seconds(mediaTimeSchema.parse(request.fadeIn));
  const fadeOut = seconds(mediaTimeSchema.parse(request.fadeOut));
  if (fadeIn.num < 0n || fadeOut.num < 0n || !fractionLte(add(fadeIn, fadeOut), duration)) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'audio fades exceed the local region duration', 422, { reason: 'AUDIO_FADE_OUT_OF_BOUNDS' });
  }
  const id = newId('areg');
  const now = new Date();
  await deps.db.insert(compositionAudioRegions).values({
    id,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    sequenceId: input.sequenceId,
    trackId: request.trackId,
    timeBinding: timing.binding,
    localRange: timing.localRange,
    sequenceRange: timing.sequenceRange,
    sourceStreamId: request.sourceStreamId,
    channelMapping: request.channelMapping,
    gainDb: String(request.gainDb),
    pan: String(request.pan),
    fadeIn: request.fadeIn,
    fadeOut: request.fadeOut,
    parameters: request.parameters,
    createdAt: now,
    updatedAt: now,
  });
  return toAudioRegion((await deps.db.select().from(compositionAudioRegions).where(eq(compositionAudioRegions.id, id)).limit(1))[0]!);
}

export async function listProjectCompositionObjects(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string },
): Promise<{ visualObjects: VisualObject[]; effects: EffectInstance[]; animations: AnimationBinding[]; captions: CaptionSpan[]; audioRegions: AudioRegion[] }> {
  await loadProjectRow(deps.db, input.workspaceId, input.projectId);
  const [visualObjects, effects, animations, captions, audioRegions] = await Promise.all([
    deps.db.select().from(compositionVisualObjects).where(and(eq(compositionVisualObjects.workspaceId, input.workspaceId), eq(compositionVisualObjects.projectId, input.projectId))).orderBy(asc(compositionVisualObjects.createdAt)),
    deps.db.select().from(compositionEffectInstances).where(and(eq(compositionEffectInstances.workspaceId, input.workspaceId), eq(compositionEffectInstances.projectId, input.projectId))).orderBy(asc(compositionEffectInstances.createdAt)),
    deps.db.select().from(compositionAnimationBindings).where(and(eq(compositionAnimationBindings.workspaceId, input.workspaceId), eq(compositionAnimationBindings.projectId, input.projectId))).orderBy(asc(compositionAnimationBindings.createdAt)),
    deps.db.select().from(compositionCaptionSpans).where(and(eq(compositionCaptionSpans.workspaceId, input.workspaceId), eq(compositionCaptionSpans.projectId, input.projectId))).orderBy(asc(compositionCaptionSpans.createdAt)),
    deps.db.select().from(compositionAudioRegions).where(and(eq(compositionAudioRegions.workspaceId, input.workspaceId), eq(compositionAudioRegions.projectId, input.projectId))).orderBy(asc(compositionAudioRegions.createdAt)),
  ]);
  return { visualObjects: visualObjects.map(toVisualObject), effects: effects.map(toEffectInstance), animations: animations.map(toAnimationBinding), captions: captions.map(toCaptionSpan), audioRegions: audioRegions.map(toAudioRegion) };
}
