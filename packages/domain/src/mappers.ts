import { projectModeSchema, sceneSchema, type Project, type Scene } from '@ancs/contracts';
import type { projects, scenes } from '@ancs/db';

/** 行 → DTO 映射（projects 与 edits 处理器共用；出口一律经契约校验）。 */

export type ProjectRow = typeof projects.$inferSelect;
export type SceneRow = typeof scenes.$inferSelect;

export const toProjectDto = (row: ProjectRow): Project => ({
  id: row.id,
  workspaceId: row.workspaceId,
  channelId: row.channelId,
  title: row.title,
  sourceType: row.sourceType as Project['sourceType'],
  status: row.status as Project['status'],
  mode: projectModeSchema.catch('GENERATIVE').parse((row.productionPolicy as { mode?: unknown } | null)?.mode),
  revision: row.revision,
  aspectRatio: row.aspectRatio,
  resolution: row.resolution,
  fps: row.fps,
  targetDurationMs: row.targetDurationMs,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export const toSceneDto = (row: SceneRow): Scene =>
  sceneSchema.parse({
    id: row.id,
    revision: row.revision,
    position: row.position,
    startMs: row.startMs,
    durationMs: row.durationMs,
    semanticType: row.semanticType,
    sceneType: row.sceneType,
    narrationBlockIds: row.narrationBlockIds,
    narration: row.narration,
    visualIntent: row.visualIntent,
    componentId: row.componentId,
    componentVersion: row.componentVersion,
    props: row.props,
    providerRequirement: row.providerRequirement,
    sourceBindings: row.sourceBindings,
    dataBindings: row.dataBindings,
    assetBindings: row.assetBindings,
    transition: row.transition,
    locked: row.locked,
    approved: row.approved,
    needsReview: row.needsReview,
    status: row.status,
  });
