import { z } from 'zod';
import { isoDateTimeSchema } from './common/time.js';

/**
 * v0.4 workspace release controls (N00-05).
 *
 * A workspace preference never grants a capability by itself. Effective write
 * access is the intersection of this preference and the server owned release
 * gate. Existing resources remain readable while a gate is blocked or disabled.
 */
export const WORKSPACE_FEATURE_KEYS = [
  'V04_MEDIA_EDITING',
  'V04_AI_COWATCH',
  'V04_THREE_MODES',
  'V04_PRO_TOOLS',
  'V04_EXTERNAL_DELIVERY',
] as const;
export const workspaceFeatureKeySchema = z.enum(WORKSPACE_FEATURE_KEYS);
export type WorkspaceFeatureKey = z.infer<typeof workspaceFeatureKeySchema>;

export const FEATURE_RELEASE_GATES = ['G0', 'G1', 'G2', 'G3', 'G4'] as const;
export const featureReleaseGateSchema = z.enum(FEATURE_RELEASE_GATES);
export type FeatureReleaseGate = z.infer<typeof featureReleaseGateSchema>;

export const FEATURE_CAPABILITY_LEVELS = ['PROTOTYPE', 'INTERNAL_VALIDATED', 'PRODUCTION_SUPPORTED'] as const;
export const featureCapabilityLevelSchema = z.enum(FEATURE_CAPABILITY_LEVELS);

export const FEATURE_PLATFORMS = ['WEB', 'DESKTOP', 'MOBILE'] as const;
export const featurePlatformSchema = z.enum(FEATURE_PLATFORMS);

export const FEATURE_EFFECTIVE_STATES = ['OFF', 'READ_ONLY', 'ENABLED'] as const;
export const featureEffectiveStateSchema = z.enum(FEATURE_EFFECTIVE_STATES);
export type FeatureEffectiveState = z.infer<typeof featureEffectiveStateSchema>;

export const FEATURE_AVAILABILITY_REASONS = [
  'WORKSPACE_DISABLED',
  'RELEASE_GATE_BLOCKED',
  'ENABLED',
] as const;
export const featureAvailabilityReasonSchema = z.enum(FEATURE_AVAILABILITY_REASONS);

export const workspaceFeatureSchema = z.object({
  key: workspaceFeatureKeySchema,
  label: z.string().min(1).max(80),
  description: z.string().min(1).max(500),
  platforms: z.array(featurePlatformSchema).min(1),
  minimumCapabilityLevel: featureCapabilityLevelSchema,
  releaseGate: featureReleaseGateSchema,
  releaseReady: z.boolean(),
  requestedEnabled: z.boolean(),
  effectiveState: featureEffectiveStateSchema,
  reason: featureAvailabilityReasonSchema,
  updatedAt: isoDateTimeSchema.nullable(),
});
export type WorkspaceFeature = z.infer<typeof workspaceFeatureSchema>;

export const workspaceFeatureListSchema = z.object({ items: z.array(workspaceFeatureSchema) });
export type WorkspaceFeatureList = z.infer<typeof workspaceFeatureListSchema>;

export const setWorkspaceFeatureRequestSchema = z.object({ enabled: z.boolean() }).strict();
export type SetWorkspaceFeatureRequest = z.infer<typeof setWorkspaceFeatureRequestSchema>;

export const WORKSPACE_FEATURE_ERROR_REASONS = {
  RELEASE_GATE_BLOCKED: 'RELEASE_GATE_BLOCKED',
  WORKSPACE_FEATURE_DISABLED: 'WORKSPACE_FEATURE_DISABLED',
} as const;
