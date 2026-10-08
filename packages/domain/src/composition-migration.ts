import { createHash } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import {
  ApiFailure,
  COMPOSITION_MIGRATION_ERROR_REASONS,
  ERROR_CODES,
  compositionMigrationSchema,
  legacyFpsToFrameRate,
  legacyMillisecondsToMediaTime,
  projectVersionCompositionProjectionSchema,
  projectVersionProjectionRecordSchema,
  projectVersionSnapshotSchema,
  type AudioRegion,
  type CaptionSpan,
  type CompositionMigration,
  type CompositionMigrationStep,
  type ProjectVersionCompositionProjection,
  type SceneGraph,
  type Sequence,
  type Track,
  type VisualObject,
} from '@ancs/contracts';
import {
  compositionAudioRegions,
  compositionCaptionSpans,
  compositionVisualObjects,
  projectCompositionMigrations,
  projectSequences,
  projectVersionCompositionProjections,
  projectVersions,
  projects,
  sequenceTracks,
} from '@ancs/db';
import type { DomainDeps } from './channels.js';
import { assembleSceneGraph } from './projects.js';

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
};

export const canonicalCompositionJson = (value: unknown): string => JSON.stringify(canonicalValue(value));
export const compositionDigestSha256 = (value: unknown): string => createHash('sha256').update(canonicalCompositionJson(value)).digest('hex');
const stableId = (prefix: string, ...parts: string[]): string => `${prefix}_${createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 24)}`;
const mt = legacyMillisecondsToMediaTime;
const range = (startMs: number, durationMs: number) => ({ start: mt(startMs), end: mt(startMs + durationMs) });
const zero = mt(0);
const binding = { basis: 'SEQUENCE' as const, clipId: null, semanticCueId: null };
const params = (values: Record<string, unknown>) => ({ schemaVersion: '1.0', values });

interface ProjectionParts {
  sequence: Sequence;
  tracks: Track[];
  visualObjects: VisualObject[];
  captions: CaptionSpan[];
  audioRegions: AudioRegion[];
}

function projectLegacyGraph(graph: SceneGraph, namespace: string, createdAt: string): ProjectionParts {
  const sequenceId = stableId('seq', namespace, 'main');
  const trackSpecs = [
    ['GRAPHIC', '旧版场景'] as const,
    ['CAPTION', '旧版字幕'] as const,
    ['AUDIO', '旧版音频'] as const,
  ];
  const tracks: Track[] = trackSpecs.map(([kind, name], position) => ({
    id: stableId('trk', namespace, kind),
    workspaceId: graph.channelSnapshot.channelId.startsWith('ws_') ? graph.channelSnapshot.channelId : stableId('legacyws', graph.projectId),
    projectId: graph.projectId,
    sequenceId,
    kind,
    position,
    name,
    locked: false,
    muted: false,
    hidden: false,
    createdAt,
  }));
  // workspaceId is replaced by the caller because SceneGraph intentionally has no workspace field.
  const sequence: Sequence = {
    id: sequenceId,
    workspaceId: tracks[0]!.workspaceId,
    projectId: graph.projectId,
    name: '旧版主序列',
    frameRate: legacyFpsToFrameRate(graph.format.fps),
    start: zero,
    duration: mt(graph.timeline.durationMs),
    parentSequenceId: null,
    createdAt,
  };
  const visualObjects: VisualObject[] = graph.scenes.map((scene) => {
    const hasComponent = scene.componentId !== null && scene.componentVersion !== null;
    const sceneRange = range(scene.startMs, scene.durationMs);
    return {
      id: stableId('vobj', namespace, scene.id),
      workspaceId: sequence.workspaceId,
      projectId: graph.projectId,
      sequenceId,
      trackId: tracks[0]!.id,
      kind: hasComponent ? 'COMPONENT' : 'OVERLAY',
      parentObjectId: null,
      semanticSceneId: scene.id,
      timeBinding: binding,
      localRange: sceneRange,
      sequenceRange: sceneRange,
      component: hasComponent ? { componentId: scene.componentId!, componentVersion: scene.componentVersion! } : null,
      parameters: params({
        legacySceneId: scene.id,
        revision: scene.revision,
        semanticType: scene.semanticType,
        sceneType: scene.sceneType,
        narrationBlockIds: scene.narrationBlockIds,
        narration: scene.narration,
        visualIntent: scene.visualIntent,
        props: scene.props,
        providerRequirement: scene.providerRequirement,
        sourceBindings: scene.sourceBindings,
        dataBindings: scene.dataBindings,
        assetBindings: scene.assetBindings,
        transition: scene.transition,
        locked: scene.locked,
        approved: scene.approved,
        needsReview: scene.needsReview,
        status: scene.status,
      }),
      createdAt,
    };
  });
  const captions: CaptionSpan[] = graph.captions.map((caption) => ({
    id: stableId('cap', namespace, caption.id),
    workspaceId: sequence.workspaceId,
    projectId: graph.projectId,
    sequenceId,
    trackId: tracks[1]!.id,
    timeBinding: binding,
    localRange: range(caption.startMs, caption.durationMs),
    sequenceRange: range(caption.startMs, caption.durationMs),
    text: caption.text,
    languageTag: 'und',
    style: params({ legacyCaptionId: caption.id }),
    words: caption.words.map((word, index) => ({
      id: stableId('word', namespace, caption.id, String(index)),
      text: word.text,
      range: { start: mt(word.startMs), end: mt(word.endMs) },
    })),
    speechAnchorId: caption.sceneId,
    createdAt,
  }));
  const audioRegions: AudioRegion[] = graph.timeline.durationMs === 0 ? [] : graph.audioTracks.map((audio) => ({
    id: stableId('aud', namespace, audio.id),
    workspaceId: sequence.workspaceId,
    projectId: graph.projectId,
    sequenceId,
    trackId: tracks[2]!.id,
    timeBinding: binding,
    localRange: range(0, graph.timeline.durationMs),
    sequenceRange: range(0, graph.timeline.durationMs),
    sourceStreamId: `legacy-${audio.kind.toLowerCase()}-${audio.id}`.slice(0, 200),
    channelMapping: [{ sourceChannel: 0, outputChannel: 0 }, { sourceChannel: 1, outputChannel: 1 }],
    gainDb: audio.volume === 0 ? -96 : Math.max(-96, Math.min(24, 20 * Math.log10(audio.volume))),
    pan: 0,
    fadeIn: mt(audio.fadeInMs),
    fadeOut: mt(audio.fadeOutMs),
    parameters: params({ legacyAudioTrackId: audio.id, assetId: audio.assetId, volume: audio.volume, ducking: audio.ducking }),
    createdAt,
  }));
  return { sequence, tracks, visualObjects, captions, audioRegions };
}

function withWorkspace(parts: ProjectionParts, workspaceId: string): ProjectionParts {
  return {
    sequence: { ...parts.sequence, workspaceId },
    tracks: parts.tracks.map((item) => ({ ...item, workspaceId })),
    visualObjects: parts.visualObjects.map((item) => ({ ...item, workspaceId })),
    captions: parts.captions.map((item) => ({ ...item, workspaceId })),
    audioRegions: parts.audioRegions.map((item) => ({ ...item, workspaceId })),
  };
}

function toMigration(row: typeof projectCompositionMigrations.$inferSelect): CompositionMigration {
  const { createdAt: _createdAt, ...publicRow } = row;
  return compositionMigrationSchema.parse({
    ...publicRow,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  });
}

async function loadProject(deps: DomainDeps, workspaceId: string, projectId: string) {
  const rows = await deps.db.select().from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId))).limit(1);
  if (!rows[0]) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'project not found', 404);
  return rows[0];
}

export async function setProjectCompositionMigrationEnabled(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; enabled: boolean },
): Promise<CompositionMigration> {
  await loadProject(deps, input.workspaceId, input.projectId);
  const id = stableId('cmig', input.projectId);
  const now = new Date();
  const rows = await deps.db.insert(projectCompositionMigrations).values({
    id,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    enabled: input.enabled,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: projectCompositionMigrations.projectId,
    set: { enabled: input.enabled, updatedAt: now },
  }).returning();
  const row = rows[0]!;
  if (!input.enabled && row.authorityMode === 'COMPOSITION') {
    // Cutover is one-way: immediately restore the persisted flag and reject the misleading request.
    await deps.db.update(projectCompositionMigrations).set({ enabled: true, updatedAt: now })
      .where(eq(projectCompositionMigrations.id, row.id));
    throw new ApiFailure(ERROR_CODES.VERSION_CONFLICT, 'composition authority cannot be disabled after cutover', 409, {
      reason: COMPOSITION_MIGRATION_ERROR_REASONS.LEGACY_WRITE_BLOCKED,
    });
  }
  return toMigration(row);
}

export async function getProjectCompositionMigration(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string },
): Promise<CompositionMigration | null> {
  await loadProject(deps, input.workspaceId, input.projectId);
  const rows = await deps.db.select().from(projectCompositionMigrations)
    .where(and(eq(projectCompositionMigrations.projectId, input.projectId), eq(projectCompositionMigrations.workspaceId, input.workspaceId))).limit(1);
  return rows[0] ? toMigration(rows[0]) : null;
}

export async function assertLegacyProjectWriteAllowed(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string },
): Promise<void> {
  const rows = await deps.db.select({ authorityMode: projectCompositionMigrations.authorityMode })
    .from(projectCompositionMigrations)
    .where(and(eq(projectCompositionMigrations.projectId, input.projectId), eq(projectCompositionMigrations.workspaceId, input.workspaceId))).limit(1);
  if (rows[0]?.authorityMode === 'COMPOSITION') {
    throw new ApiFailure(ERROR_CODES.VERSION_CONFLICT, 'legacy project edits are read-only after composition cutover', 409, {
      reason: COMPOSITION_MIGRATION_ERROR_REASONS.LEGACY_WRITE_BLOCKED,
    });
  }
}

export interface CompositionMigrationHooks {
  /** Test/operations seam used to prove restartability after a committed step. */
  afterStep?: (step: Exclude<CompositionMigrationStep, 'NONE' | 'COMPLETE'>) => void | Promise<void>;
}

export async function migrateLegacyProjectComposition(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string },
  hooks: CompositionMigrationHooks = {},
): Promise<CompositionMigration> {
  await loadProject(deps, input.workspaceId, input.projectId);
  const migrationRows = await deps.db.select().from(projectCompositionMigrations)
    .where(and(eq(projectCompositionMigrations.projectId, input.projectId), eq(projectCompositionMigrations.workspaceId, input.workspaceId))).limit(1);
  let migration = migrationRows[0];
  if (!migration?.enabled) {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'composition migration feature is disabled', 409, {
      reason: COMPOSITION_MIGRATION_ERROR_REASONS.FEATURE_DISABLED,
    });
  }
  if (migration.authorityMode === 'COMPOSITION' && migration.status === 'COMPLETE') return toMigration(migration);

  const graph = await assembleSceneGraph(deps, input);
  const versions = await deps.db.select().from(projectVersions)
    .where(and(eq(projectVersions.workspaceId, input.workspaceId), eq(projectVersions.projectId, input.projectId)))
    .orderBy(asc(projectVersions.versionNumber));
  const sourceDigestSha256 = compositionDigestSha256({ graph, versions: versions.map((item) => ({ id: item.id, snapshot: item.snapshot })) });
  if (migration.sourceDigestSha256 !== null && migration.sourceDigestSha256 !== sourceDigestSha256) {
    throw new ApiFailure(ERROR_CODES.VERSION_CONFLICT, 'legacy source changed after composition migration started', 409, {
      reason: COMPOSITION_MIGRATION_ERROR_REASONS.SOURCE_CHANGED,
    });
  }

  const createdAt = migration.startedAt ?? new Date();
  const live = withWorkspace(projectLegacyGraph(graph, input.projectId, createdAt.toISOString()), input.workspaceId);
  const existingSequences = await deps.db.select({ id: projectSequences.id }).from(projectSequences)
    .where(and(eq(projectSequences.workspaceId, input.workspaceId), eq(projectSequences.projectId, input.projectId)));
  if (existingSequences.some((item) => item.id !== live.sequence.id)) {
    throw new ApiFailure(ERROR_CODES.VERSION_CONFLICT, 'project already has independently authored composition data', 409, {
      reason: COMPOSITION_MIGRATION_ERROR_REASONS.ALREADY_HAS_COMPOSITION,
    });
  }

  migration = (await deps.db.update(projectCompositionMigrations).set({
    status: 'RUNNING',
    attemptCount: migration.attemptCount + 1,
    sourceDigestSha256,
    lastError: null,
    startedAt: migration.startedAt ?? createdAt,
    updatedAt: new Date(),
  }).where(eq(projectCompositionMigrations.id, migration.id)).returning())[0]!;

  const fail = async (error: unknown): Promise<never> => {
    const summary = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
    await deps.db.update(projectCompositionMigrations).set({ status: 'FAILED', lastError: summary, updatedAt: new Date() })
      .where(eq(projectCompositionMigrations.id, migration!.id));
    throw error;
  };

  try {
    const stepIndex = (step: CompositionMigrationStep) => ['NONE', 'BASE', 'SCENES', 'VERSIONS', 'COMPLETE'].indexOf(step);
    if (stepIndex(migration.completedStep as CompositionMigrationStep) < stepIndex('BASE')) {
      await deps.db.transaction(async (tx) => {
        await tx.insert(projectSequences).values({
          ...live.sequence,
          start: live.sequence.start,
          duration: live.sequence.duration,
          updatedAt: createdAt,
          createdAt,
        }).onConflictDoNothing();
        await tx.insert(sequenceTracks).values(live.tracks.map((item) => ({ ...item, createdAt, updatedAt: createdAt }))).onConflictDoNothing();
        await tx.update(projectCompositionMigrations).set({ completedStep: 'BASE', updatedAt: new Date() })
          .where(eq(projectCompositionMigrations.id, migration!.id));
      });
      migration.completedStep = 'BASE';
      await hooks.afterStep?.('BASE');
    }
    if (stepIndex(migration.completedStep as CompositionMigrationStep) < stepIndex('SCENES')) {
      await deps.db.transaction(async (tx) => {
        if (live.visualObjects.length > 0) await tx.insert(compositionVisualObjects).values(live.visualObjects.map((item) => ({ ...item, createdAt, updatedAt: createdAt }))).onConflictDoNothing();
        if (live.captions.length > 0) await tx.insert(compositionCaptionSpans).values(live.captions.map((item) => ({ ...item, createdAt, updatedAt: createdAt }))).onConflictDoNothing();
        if (live.audioRegions.length > 0) await tx.insert(compositionAudioRegions).values(live.audioRegions.map((item) => ({ ...item, gainDb: String(item.gainDb), pan: String(item.pan), createdAt, updatedAt: createdAt }))).onConflictDoNothing();
        await tx.update(projectCompositionMigrations).set({ completedStep: 'SCENES', updatedAt: new Date() })
          .where(eq(projectCompositionMigrations.id, migration!.id));
      });
      migration.completedStep = 'SCENES';
      await hooks.afterStep?.('SCENES');
    }
    if (stepIndex(migration.completedStep as CompositionMigrationStep) < stepIndex('VERSIONS')) {
      await deps.db.transaction(async (tx) => {
        for (const version of versions) {
          const snapshot = projectVersionSnapshotSchema.parse(version.snapshot);
          const parts = withWorkspace(projectLegacyGraph(snapshot.graph, version.id, version.createdAt.toISOString()), input.workspaceId);
          const projection: ProjectVersionCompositionProjection = projectVersionCompositionProjectionSchema.parse({
            schemaVersion: '1.0',
            projectVersionId: version.id,
            ...parts,
            compatibility: { sceneGraph: snapshot.graph },
          });
          await tx.insert(projectVersionCompositionProjections).values({
            id: stableId('pvcp', version.id),
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            projectVersionId: version.id,
            sourceSnapshotSha256: compositionDigestSha256(snapshot),
            projectionSha256: compositionDigestSha256(projection),
            projection,
            createdAt: version.createdAt,
          }).onConflictDoNothing();
        }
        await tx.update(projectCompositionMigrations).set({ completedStep: 'VERSIONS', updatedAt: new Date() })
          .where(eq(projectCompositionMigrations.id, migration!.id));
      });
      migration.completedStep = 'VERSIONS';
      await hooks.afterStep?.('VERSIONS');
    }
    const projectionHashes = await deps.db.select({ hash: projectVersionCompositionProjections.projectionSha256 })
      .from(projectVersionCompositionProjections)
      .where(and(eq(projectVersionCompositionProjections.workspaceId, input.workspaceId), eq(projectVersionCompositionProjections.projectId, input.projectId)))
      .orderBy(asc(projectVersionCompositionProjections.projectVersionId));
    const targetDigestSha256 = compositionDigestSha256({ ...live, versionProjectionHashes: projectionHashes.map((item) => item.hash) });
    const completed = (await deps.db.update(projectCompositionMigrations).set({
      status: 'COMPLETE',
      completedStep: 'COMPLETE',
      authorityMode: 'COMPOSITION',
      targetDigestSha256,
      lastError: null,
      completedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(projectCompositionMigrations.id, migration.id)).returning())[0]!;
    return toMigration(completed);
  } catch (error) {
    return fail(error);
  }
}

export async function listProjectVersionCompositionProjections(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string },
) {
  await loadProject(deps, input.workspaceId, input.projectId);
  const rows = await deps.db.select().from(projectVersionCompositionProjections)
    .where(and(eq(projectVersionCompositionProjections.workspaceId, input.workspaceId), eq(projectVersionCompositionProjections.projectId, input.projectId)))
    .orderBy(asc(projectVersionCompositionProjections.projectVersionId));
  return rows.map((row) => projectVersionProjectionRecordSchema.parse({
    ...row,
    createdAt: row.createdAt.toISOString(),
  }));
}
