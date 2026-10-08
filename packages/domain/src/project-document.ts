import { and, eq } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  GENERATION_POLICY_FIELDS,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  legacyFpsToFrameRate,
  legacyMillisecondsToMediaTime,
  projectBriefSchema,
  projectDocumentSchema,
  productionPolicySchema,
  type GovernedGenerationCapability,
  type ProductionPolicy,
  type ProjectDocument,
  type SceneGraph,
} from '@ancs/contracts';
import { projects } from '@ancs/db';
import type { DomainDeps } from './channels.js';
import { assembleSceneGraph } from './projects.js';

const compositionObjectId = (sceneId: string): string => `cmp_${sceneId}`;

/** Map the legacy read projection into the unified document without creating a second write model. */
export function projectDocumentFromSceneGraph(input: {
  graph: SceneGraph;
  brief: unknown;
  productionPolicy: unknown;
  documentSchemaVersion?: string;
}): ProjectDocument {
  if ((input.documentSchemaVersion ?? PROJECT_DOCUMENT_SCHEMA_VERSION) !== PROJECT_DOCUMENT_SCHEMA_VERSION) {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'ProjectDocument schema version is not supported', 409, {
      reason: 'PROJECT_DOCUMENT_SCHEMA_UNSUPPORTED',
      schemaVersion: input.documentSchemaVersion,
    });
  }
  const graph = input.graph;
  const frameRate = legacyFpsToFrameRate(graph.format.fps);
  const semanticScenes = graph.scenes.map((scene) => ({
    id: scene.id,
    purpose: scene.visualIntent,
    narration: scene.narration,
    sourceReferences: scene.sourceBindings.map((binding) => ({
      sourceId: binding.sourceId,
      datasetIds: binding.datasetIds,
    })),
    compositionObjectIds: [compositionObjectId(scene.id)],
  }));
  const objects = graph.scenes.map((scene) => ({
    id: compositionObjectId(scene.id),
    kind: 'LEGACY_SCENE' as const,
    semanticSceneId: scene.id,
    sequenceRange: {
      start: legacyMillisecondsToMediaTime(scene.startMs),
      end: legacyMillisecondsToMediaTime(scene.startMs + scene.durationMs),
    },
    legacySceneId: scene.id,
  }));
  const dependencyNodes = [...graph.scenes.map((scene) => scene.id), ...objects.map((object) => object.id)];

  return projectDocumentSchema.parse({
    schemaVersion: PROJECT_DOCUMENT_SCHEMA_VERSION,
    projectId: graph.projectId,
    projectRevision: graph.projectRevision,
    brief: projectBriefSchema.parse(input.brief),
    productionPolicy: productionPolicySchema.parse(input.productionPolicy),
    identitySnapshot: graph.identitySnapshot,
    semanticPlan: semanticScenes.length === 0 ? null : { narrativePlanId: null, scenes: semanticScenes },
    composition: {
      sequenceId: `seq_${graph.projectId}`,
      frameRate,
      start: legacyMillisecondsToMediaTime(0),
      duration: legacyMillisecondsToMediaTime(graph.timeline.durationMs),
      objects,
    },
    assetVersionIds: [],
    sourceReferences: graph.sourceReferences,
    dependencyGraph: {
      nodes: dependencyNodes,
      edges: objects.map((object) => ({ from: object.id, to: object.legacySceneId, kind: 'REPRESENTS' })),
    },
    decisionBindingIds: [],
    approvalBindingIds: [],
    lockedObjectIds: graph.scenes.filter((scene) => scene.locked).map((scene) => compositionObjectId(scene.id)),
    renderProfile: {
      width: graph.format.width,
      height: graph.format.height,
      frameRate,
      aspectRatio: graph.format.aspectRatio,
    },
    compatibility: { sceneGraphSchemaVersion: graph.schemaVersion, sceneGraph: graph },
  });
}

export async function assembleProjectDocument(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string },
): Promise<ProjectDocument> {
  const rows = await deps.db
    .select({
      documentSchemaVersion: projects.documentSchemaVersion,
      brief: projects.brief,
      productionPolicy: projects.productionPolicy,
    })
    .from(projects)
    .where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, input.workspaceId)))
    .limit(1);
  const project = rows[0];
  if (!project) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'project not found', 404);
  const graph = await assembleSceneGraph(deps, input);
  return projectDocumentFromSceneGraph({
    graph,
    brief: project.brief,
    productionPolicy: project.productionPolicy,
    documentSchemaVersion: project.documentSchemaVersion,
  });
}

export async function getProjectProductionPolicy(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string },
): Promise<ProductionPolicy> {
  const rows = await deps.db
    .select({ productionPolicy: projects.productionPolicy })
    .from(projects)
    .where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, input.workspaceId)))
    .limit(1);
  const project = rows[0];
  if (!project) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'project not found', 404);
  return productionPolicySchema.parse(project.productionPolicy);
}

/** Server-side enforcement point for every governed generation capability. */
export async function assertProjectGenerationAllowed(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; capability: GovernedGenerationCapability },
): Promise<ProductionPolicy> {
  const policy = await getProjectProductionPolicy(deps, input);
  const field = GENERATION_POLICY_FIELDS[input.capability];
  if (policy[field] !== true) {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, '项目制作规则禁止此生成能力', 409, {
      reason: 'PRODUCTION_POLICY_BLOCKED',
      capability: input.capability,
      policyField: field,
      mode: policy.mode,
      alternative: policy.mode === 'FOOTAGE_EDIT'
        ? '使用已有素材、字幕或常规剪辑完成；如确需生成，请先显式修改项目制作规则。'
        : '调整项目制作规则后重试。',
    });
  }
  return policy;
}
