import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  clipSchema,
  compareMediaTime,
  createClipRequestSchema,
  createSequenceRequestSchema,
  createTrackRequestSchema,
  frameRateSchema,
  legacyMillisecondsToMediaTime,
  mediaRangeSchema,
  mediaTimeSchema,
  sequenceSchema,
  trackSchema,
  type Clip,
  type CreateClipRequest,
  type CreateSequenceRequest,
  type CreateTrackRequest,
  type MediaRange,
  type MediaTime,
  type Sequence,
  type Track,
} from '@ancs/contracts';
import {
  assetVersions,
  projectSequences,
  sequenceClips,
  sequenceTracks,
} from '@ancs/db';
import type { DomainDeps } from './channels.js';
import { inOrder } from './in-order.js';
import { writeCompositionDirect } from './composition-projector.js';
import { loadProjectRow } from './projects.js';

const newId = (prefix: string): string => `${prefix}_${randomUUID()}`;
const zeroAt = (time: MediaTime): MediaTime => ({ ticks: '0', timebase: time.timebase });

type Fraction = { num: bigint; den: bigint };
function rangeDuration(range: MediaRange): Fraction {
  const startTicks = BigInt(range.start.ticks);
  const endTicks = BigInt(range.end.ticks);
  const startNum = BigInt(range.start.timebase.num);
  const startDen = BigInt(range.start.timebase.den);
  const endNum = BigInt(range.end.timebase.num);
  const endDen = BigInt(range.end.timebase.den);
  return {
    num: endTicks * endNum * startDen - startTicks * startNum * endDen,
    den: endDen * startDen,
  };
}

function assertLinearMapping(sourceRange: MediaRange, sequenceRange: MediaRange, rate: { num: number; den: number }): void {
  const source = rangeDuration(sourceRange);
  const sequence = rangeDuration(sequenceRange);
  const left = source.num * sequence.den * BigInt(rate.den);
  const right = BigInt(rate.num) * source.den * sequence.num;
  if (left !== right) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'timeMapping rate does not match source and sequence ranges', 422, {
      reason: 'TIME_MAPPING_MISMATCH',
    });
  }
}

const toSequence = (row: typeof projectSequences.$inferSelect): Sequence => sequenceSchema.parse({
  id: row.id,
  workspaceId: row.workspaceId,
  projectId: row.projectId,
  name: row.name,
  frameRate: row.frameRate,
  start: row.start,
  duration: row.duration,
  parentSequenceId: row.parentSequenceId,
  createdAt: row.createdAt.toISOString(),
});

const toTrack = (row: typeof sequenceTracks.$inferSelect): Track => trackSchema.parse({
  id: row.id,
  workspaceId: row.workspaceId,
  projectId: row.projectId,
  sequenceId: row.sequenceId,
  kind: row.kind,
  position: row.position,
  name: row.name,
  locked: row.locked,
  muted: row.muted,
  hidden: row.hidden,
  solo: row.solo,
  syncLocked: row.syncLocked,
  createdAt: row.createdAt.toISOString(),
});

const toClip = (row: typeof sequenceClips.$inferSelect): Clip => clipSchema.parse({
  id: row.id,
  workspaceId: row.workspaceId,
  projectId: row.projectId,
  sequenceId: row.sequenceId,
  trackId: row.trackId,
  assetVersionId: row.assetVersionId,
  nestedSequenceId: row.nestedSequenceId,
  sourceStreamId: row.sourceStreamId,
  sourceRange: row.sourceRange,
  sequenceRange: row.sequenceRange,
  timeMapping: row.timeMapping,
  avGroupId: row.avGroupId,
  parentClipId: row.parentClipId,
  ...(row.parameters === null || row.parameters === undefined ? {} : { parameters: row.parameters }),
  createdAt: row.createdAt.toISOString(),
});

export async function createSequence(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; input: CreateSequenceRequest },
): Promise<Sequence> {
  await loadProjectRow(deps.db, input.workspaceId, input.projectId);
  const request = createSequenceRequestSchema.parse(input.input);
  if (compareMediaTime(request.duration, zeroAt(request.duration)) <= 0) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'sequence duration must be positive', 422);
  }
  if (request.parentSequenceId != null) {
    const parent = await deps.db.select({ id: projectSequences.id }).from(projectSequences).where(and(
      eq(projectSequences.id, request.parentSequenceId),
      eq(projectSequences.workspaceId, input.workspaceId),
      eq(projectSequences.projectId, input.projectId),
    )).limit(1);
    if (!parent[0]) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'parent sequence not found', 404);
  }
  const now = new Date();
  const id = newId('seq');
  const start = mediaTimeSchema.parse({ ticks: '0', timebase: request.duration.timebase });
  const scope = { workspaceId: input.workspaceId, projectId: input.projectId };
  const row = await writeCompositionDirect(deps.db, scope, { op: 'create_sequence', sequenceId: id }, (projector) => projector.insert('sequence', {
    id,
    ...scope,
    name: request.name,
    frameRate: frameRateSchema.parse(request.frameRate),
    start,
    duration: request.duration,
    parentSequenceId: request.parentSequenceId ?? null,
    createdAt: now,
    updatedAt: now,
  }));
  return toSequence(row);
}

export async function createTrack(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; sequenceId: string; input: CreateTrackRequest },
): Promise<Track> {
  const request = createTrackRequestSchema.parse(input.input);
  const sequence = await deps.db.select({ id: projectSequences.id }).from(projectSequences).where(and(
    eq(projectSequences.id, input.sequenceId),
    eq(projectSequences.workspaceId, input.workspaceId),
    eq(projectSequences.projectId, input.projectId),
  )).limit(1);
  if (!sequence[0]) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'sequence not found', 404);
  const now = new Date();
  const id = newId('trk');
  const scope = { workspaceId: input.workspaceId, projectId: input.projectId };
  const row = await writeCompositionDirect(deps.db, scope, { op: 'create_track', trackId: id }, (projector) => projector.insert('track', {
    id,
    ...scope,
    sequenceId: input.sequenceId,
    kind: request.kind,
    position: request.position,
    name: request.name,
    locked: request.locked ?? false,
    muted: request.muted ?? false,
    hidden: request.hidden ?? false,
    solo: request.solo ?? false,
    syncLocked: request.syncLocked ?? false,
    createdAt: now,
    updatedAt: now,
  }));
  return toTrack(row);
}

async function assertNoNestedCycle(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; sequenceId: string; nestedSequenceId: string },
): Promise<void> {
  if (input.sequenceId === input.nestedSequenceId) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'sequence cannot nest itself', 422, { reason: 'SEQUENCE_CYCLE' });
  }
  const rows = await deps.db.select({ from: sequenceClips.sequenceId, to: sequenceClips.nestedSequenceId })
    .from(sequenceClips)
    .where(and(eq(sequenceClips.workspaceId, input.workspaceId), eq(sequenceClips.projectId, input.projectId)));
  const adjacency = new Map<string, string[]>();
  for (const row of rows) {
    if (row.to === null) continue;
    adjacency.set(row.from, [...(adjacency.get(row.from) ?? []), row.to]);
  }
  adjacency.set(input.sequenceId, [...(adjacency.get(input.sequenceId) ?? []), input.nestedSequenceId]);
  const stack = [input.nestedSequenceId];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === input.sequenceId) {
      throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'nested sequence would create a cycle', 422, { reason: 'SEQUENCE_CYCLE' });
    }
    if (visited.has(current)) continue;
    visited.add(current);
    stack.push(...(adjacency.get(current) ?? []));
  }
}

export async function createClip(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; sequenceId: string; input: CreateClipRequest },
): Promise<Clip> {
  const request = createClipRequestSchema.parse(input.input);
  const sequenceRows = await deps.db.select().from(projectSequences).where(and(
    eq(projectSequences.id, input.sequenceId),
    eq(projectSequences.workspaceId, input.workspaceId),
    eq(projectSequences.projectId, input.projectId),
  )).limit(1);
  const sequence = sequenceRows[0];
  if (!sequence) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'sequence not found', 404);
  const trackRows = await deps.db.select().from(sequenceTracks).where(and(
    eq(sequenceTracks.id, request.trackId),
    eq(sequenceTracks.workspaceId, input.workspaceId),
    eq(sequenceTracks.projectId, input.projectId),
    eq(sequenceTracks.sequenceId, input.sequenceId),
  )).limit(1);
  const track = trackRows[0];
  if (!track) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'track not found', 404);
  if (track.locked) throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'track is locked', 409, { reason: 'TRACK_LOCKED' });

  const sourceRange = mediaRangeSchema.parse(request.sourceRange);
  const sequenceRange = mediaRangeSchema.parse(request.sequenceRange);
  const sequenceDuration = mediaTimeSchema.parse(sequence.duration);
  if (compareMediaTime(sequenceRange.start, zeroAt(sequenceRange.start)) < 0 || compareMediaTime(sequenceRange.end, sequenceDuration) > 0) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'clip sequence range exceeds sequence bounds', 422, { reason: 'SEQUENCE_RANGE_OUT_OF_BOUNDS' });
  }

  if (request.assetVersionId != null) {
    const versions = await deps.db.select({
      id: assetVersions.id,
      durationMs: assetVersions.durationMs,
      status: assetVersions.status,
      checksumSha256: assetVersions.checksumSha256,
    }).from(assetVersions).where(and(
      eq(assetVersions.id, request.assetVersionId),
      eq(assetVersions.workspaceId, input.workspaceId),
    )).limit(1);
    const source = versions[0];
    if (!source) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'asset version not found', 404);
    if (source.status !== 'READY') throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'asset version is not ready', 409);
    if (source.checksumSha256 === null) {
      throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'asset version has no immutable checksum', 409, { reason: 'SOURCE_CHECKSUM_MISSING' });
    }
    if (source.durationMs === null) {
      throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'asset duration is unknown', 422, { reason: 'SOURCE_DURATION_UNKNOWN' });
    }
    if (
      compareMediaTime(sourceRange.start, zeroAt(sourceRange.start)) < 0 ||
      compareMediaTime(sourceRange.end, legacyMillisecondsToMediaTime(source.durationMs)) > 0
    ) {
      throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'clip source range exceeds asset duration', 422, { reason: 'SOURCE_RANGE_OUT_OF_BOUNDS' });
    }
  }

  if (request.nestedSequenceId != null) {
    const nestedRows = await deps.db.select({ duration: projectSequences.duration }).from(projectSequences).where(and(
      eq(projectSequences.id, request.nestedSequenceId),
      eq(projectSequences.workspaceId, input.workspaceId),
      eq(projectSequences.projectId, input.projectId),
    )).limit(1);
    const nested = nestedRows[0];
    if (!nested) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'nested sequence not found', 404);
    if (compareMediaTime(sourceRange.start, zeroAt(sourceRange.start)) < 0 || compareMediaTime(sourceRange.end, mediaTimeSchema.parse(nested.duration)) > 0) {
      throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'clip source range exceeds nested sequence duration', 422, { reason: 'SOURCE_RANGE_OUT_OF_BOUNDS' });
    }
    await assertNoNestedCycle(deps, { ...input, nestedSequenceId: request.nestedSequenceId });
  }

  if (request.parentClipId != null) {
    const parent = await deps.db.select({ id: sequenceClips.id }).from(sequenceClips).where(and(
      eq(sequenceClips.id, request.parentClipId),
      eq(sequenceClips.workspaceId, input.workspaceId),
      eq(sequenceClips.projectId, input.projectId),
      eq(sequenceClips.sequenceId, input.sequenceId),
    )).limit(1);
    if (!parent[0]) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'parent clip not found', 404);
  }

  assertLinearMapping(sourceRange, sequenceRange, request.timeMapping.rate);
  const now = new Date();
  const id = newId('clp');
  const scope = { workspaceId: input.workspaceId, projectId: input.projectId };
  const row = await writeCompositionDirect(deps.db, scope, { op: 'create_clip', clipId: id }, (projector) => projector.insert('clip', {
    id,
    ...scope,
    sequenceId: input.sequenceId,
    trackId: request.trackId,
    assetVersionId: request.assetVersionId ?? null,
    nestedSequenceId: request.nestedSequenceId ?? null,
    sourceStreamId: request.sourceStreamId ?? null,
    sourceRange,
    sequenceRange,
    timeMapping: request.timeMapping,
    avGroupId: request.avGroupId ?? null,
    parentClipId: request.parentClipId ?? null,
    createdAt: now,
    updatedAt: now,
  }));
  return toClip(row);
}

export async function listProjectComposition(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string },
): Promise<{ sequences: Sequence[]; tracks: Track[]; clips: Clip[] }> {
  await loadProjectRow(deps.db, input.workspaceId, input.projectId);
  const [sequences, tracks, clips] = await inOrder([
    () => deps.db.select().from(projectSequences).where(and(eq(projectSequences.workspaceId, input.workspaceId), eq(projectSequences.projectId, input.projectId))).orderBy(asc(projectSequences.createdAt)),
    () => deps.db.select().from(sequenceTracks).where(and(eq(sequenceTracks.workspaceId, input.workspaceId), eq(sequenceTracks.projectId, input.projectId))).orderBy(asc(sequenceTracks.sequenceId), asc(sequenceTracks.position)),
    () => deps.db.select().from(sequenceClips).where(and(eq(sequenceClips.workspaceId, input.workspaceId), eq(sequenceClips.projectId, input.projectId))).orderBy(asc(sequenceClips.createdAt)),
  ]);
  return { sequences: sequences.map(toSequence), tracks: tracks.map(toTrack), clips: clips.map(toClip) };
}
