import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  WORKSPACE_FEATURE_ERROR_REASONS,
  workspaceFeatureSchema,
  type WorkspaceFeature,
  type WorkspaceFeatureKey,
} from '@ancs/contracts';
import { outboxEvents, workspaceFeaturePreferences } from '@ancs/db';
import type { DomainDeps } from './deps.js';

type Definition = Omit<WorkspaceFeature, 'requestedEnabled' | 'effectiveState' | 'reason' | 'updatedAt'>;

/**
 * Server owned release registry. Gates stay blocked until their owning tasks
 * have real evidence; a workspace preference cannot override this registry.
 */
export const WORKSPACE_FEATURE_DEFINITIONS: readonly Definition[] = [
  { key: 'V04_MEDIA_EDITING', label: '素材剪辑', description: '纯素材导入、预览与非破坏性剪辑。', platforms: ['WEB'], minimumCapabilityLevel: 'INTERNAL_VALIDATED', releaseGate: 'G0', releaseReady: false },
  { key: 'V04_AI_COWATCH', label: 'AI 共看片室', description: '围绕画面、选区和时间范围进行对话与试改。', platforms: ['WEB'], minimumCapabilityLevel: 'INTERNAL_VALIDATED', releaseGate: 'G1', releaseReady: false },
  { key: 'V04_THREE_MODES', label: '三种制作模式', description: '纯素材、纯生成与混合制作的策略入口。', platforms: ['WEB'], minimumCapabilityLevel: 'INTERNAL_VALIDATED', releaseGate: 'G2', releaseReady: false },
  { key: 'V04_PRO_TOOLS', label: '专业工具', description: '多轨、关键帧、蒙版、调色、专业音频与多机位。', platforms: ['WEB'], minimumCapabilityLevel: 'PRODUCTION_SUPPORTED', releaseGate: 'G3', releaseReady: false },
  { key: 'V04_EXTERNAL_DELIVERY', label: '外部交付', description: '对外发布、多端和商业交付能力。', platforms: ['WEB', 'DESKTOP', 'MOBILE'], minimumCapabilityLevel: 'PRODUCTION_SUPPORTED', releaseGate: 'G4', releaseReady: false },
] as const;

const byKey = new Map(WORKSPACE_FEATURE_DEFINITIONS.map((definition) => [definition.key, definition]));

function toView(definition: Definition, preference?: typeof workspaceFeaturePreferences.$inferSelect): WorkspaceFeature {
  const requestedEnabled = preference?.requestedEnabled ?? false;
  const effectiveState = requestedEnabled ? (definition.releaseReady ? 'ENABLED' : 'READ_ONLY') : 'OFF';
  const reason = !requestedEnabled ? 'WORKSPACE_DISABLED' : definition.releaseReady ? 'ENABLED' : 'RELEASE_GATE_BLOCKED';
  return workspaceFeatureSchema.parse({
    ...definition,
    requestedEnabled,
    effectiveState,
    reason,
    updatedAt: preference?.updatedAt.toISOString() ?? null,
  });
}

export async function listWorkspaceFeatures(deps: DomainDeps, input: { workspaceId: string }): Promise<WorkspaceFeature[]> {
  const rows = await deps.db
    .select()
    .from(workspaceFeaturePreferences)
    .where(eq(workspaceFeaturePreferences.workspaceId, input.workspaceId));
  const preferences = new Map(rows.map((row) => [row.featureKey, row]));
  return WORKSPACE_FEATURE_DEFINITIONS.map((definition) => toView(definition, preferences.get(definition.key)));
}

export async function setWorkspaceFeaturePreference(
  deps: DomainDeps,
  input: { workspaceId: string; featureKey: WorkspaceFeatureKey; enabled: boolean; actorId: string },
): Promise<WorkspaceFeature> {
  const definition = byKey.get(input.featureKey);
  if (definition === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'workspace feature not found', 404);
  const now = new Date();
  const rows = await deps.db
    .insert(workspaceFeaturePreferences)
    .values({
      id: `wfp_${randomUUID()}`,
      workspaceId: input.workspaceId,
      featureKey: input.featureKey,
      requestedEnabled: input.enabled,
      createdBy: input.actorId,
      updatedBy: input.actorId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [workspaceFeaturePreferences.workspaceId, workspaceFeaturePreferences.featureKey],
      set: { requestedEnabled: input.enabled, updatedBy: input.actorId, updatedAt: now },
    })
    .returning();
  const row = rows[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'workspace feature preference update failed', 500);
  await deps.db.insert(outboxEvents).values({
    id: `obx_${randomUUID()}`,
    workspaceId: input.workspaceId,
    type: 'workspace.feature.preference.updated',
    payload: { featureKey: input.featureKey, requestedEnabled: input.enabled, actorId: input.actorId },
  });
  return toView(definition, row);
}

/** New v0.4 write/cost entry points call this before mutation or quote creation. */
export async function assertWorkspaceFeatureWriteAllowed(
  deps: DomainDeps,
  input: { workspaceId: string; featureKey: WorkspaceFeatureKey },
): Promise<void> {
  const definition = byKey.get(input.featureKey);
  if (definition === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'workspace feature not found', 404);
  const rows = await deps.db
    .select()
    .from(workspaceFeaturePreferences)
    .where(and(eq(workspaceFeaturePreferences.workspaceId, input.workspaceId), eq(workspaceFeaturePreferences.featureKey, input.featureKey)))
    .limit(1);
  const view = toView(definition, rows[0]);
  if (view.effectiveState === 'ENABLED') return;
  const reason = view.reason === 'RELEASE_GATE_BLOCKED'
    ? WORKSPACE_FEATURE_ERROR_REASONS.RELEASE_GATE_BLOCKED
    : WORKSPACE_FEATURE_ERROR_REASONS.WORKSPACE_FEATURE_DISABLED;
  throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, '该 v0.4 能力当前只读或未启用；现有项目和版本仍可读取', 409, {
    reason,
    featureKey: view.key,
    releaseGate: view.releaseGate,
    effectiveState: view.effectiveState,
  });
}
