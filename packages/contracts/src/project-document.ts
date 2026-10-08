import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { creditsSchema } from './common/money.js';
import { frameRateSchema, mediaRangeSchema, mediaTimeSchema } from './common/media-time.js';
import { revisionSchema } from './common/revision.js';
import { identitySnapshotSchema, sceneGraphSchema, sourceReferenceSchema } from './scene-graph.js';
import { privacyTierSchema } from './workspaces.js';
import { clipSchema, sequenceSchema, trackSchema } from './composition.js';

/** N01-02: ProjectDocument is the single versioned project read model. */
export const PROJECT_DOCUMENT_SCHEMA_VERSION = '1.0' as const;

export const PROJECT_MODES = ['FOOTAGE_EDIT', 'GENERATIVE', 'HYBRID'] as const;
export const projectModeSchema = z.enum(PROJECT_MODES);
export type ProjectMode = z.infer<typeof projectModeSchema>;

/** Empty briefs are valid: a footage project may start from media only. */
export const projectBriefSchema = z.object({
  objective: z.string().max(4_000).default(''),
  audience: z.string().max(1_000).default(''),
  language: z.string().max(40).nullable().default(null),
  notes: z.string().max(8_000).default(''),
});
export type ProjectBrief = z.infer<typeof projectBriefSchema>;

/**
 * Generation permissions are deliberately split by capability. An empty provider
 * list means "no project-specific allowlist"; workspace/provider policy still applies.
 */
export const productionPolicySchema = z.object({
  mode: projectModeSchema,
  allowGeneratedVideo: z.boolean(),
  allowGeneratedImage: z.boolean(),
  allowGeneratedSpeech: z.boolean(),
  allowVoiceReplacement: z.boolean(),
  allowScriptRewrite: z.boolean(),
  allowGeneratedMusic: z.boolean(),
  allowGeneratedSfx: z.boolean(),
  allowProceduralGraphics: z.boolean(),
  allowCaptions: z.boolean(),
  allowGenerativeFill: z.boolean(),
  allowFrameInterpolation: z.boolean(),
  allowExternalStock: z.boolean(),
  allowExternalAnalysis: z.boolean(),
  preserveOriginalSpeech: z.boolean(),
  preserveOriginalChronology: z.boolean(),
  allowedProviderIds: z.array(opaqueIdSchema).max(100).default([]),
  privacyClass: privacyTierSchema.default('STANDARD'),
  perProposalBudgetCredits: creditsSchema.nonnegative().nullable().default(null),
  projectBudgetCredits: creditsSchema.nonnegative().nullable().default(null),
}).strict();
export type ProductionPolicy = z.infer<typeof productionPolicySchema>;

export const productionPolicyOverridesSchema = productionPolicySchema
  .omit({ mode: true })
  .partial()
  .strict();
export type ProductionPolicyOverrides = z.infer<typeof productionPolicyOverridesSchema>;

export function defaultProductionPolicy(mode: ProjectMode): ProductionPolicy {
  const shared = {
    mode,
    allowVoiceReplacement: false,
    allowedProviderIds: [],
    privacyClass: 'STANDARD' as const,
    perProposalBudgetCredits: null,
    projectBudgetCredits: null,
  };
  if (mode === 'FOOTAGE_EDIT') {
    return productionPolicySchema.parse({
      ...shared,
      allowGeneratedVideo: false,
      allowGeneratedImage: false,
      allowGeneratedSpeech: false,
      allowScriptRewrite: false,
      allowGeneratedMusic: false,
      allowGeneratedSfx: false,
      allowProceduralGraphics: false,
      allowCaptions: false,
      allowGenerativeFill: false,
      allowFrameInterpolation: false,
      allowExternalStock: false,
      allowExternalAnalysis: true,
      preserveOriginalSpeech: true,
      preserveOriginalChronology: true,
    });
  }
  if (mode === 'HYBRID') {
    return productionPolicySchema.parse({
      ...shared,
      allowGeneratedVideo: false,
      allowGeneratedImage: false,
      allowGeneratedSpeech: false,
      allowScriptRewrite: false,
      allowGeneratedMusic: false,
      allowGeneratedSfx: false,
      allowProceduralGraphics: true,
      allowCaptions: true,
      allowGenerativeFill: false,
      allowFrameInterpolation: false,
      allowExternalStock: false,
      allowExternalAnalysis: true,
      preserveOriginalSpeech: true,
      preserveOriginalChronology: true,
    });
  }
  return productionPolicySchema.parse({
    ...shared,
    allowGeneratedVideo: true,
    allowGeneratedImage: true,
    allowGeneratedSpeech: true,
    allowScriptRewrite: true,
    allowGeneratedMusic: true,
    allowGeneratedSfx: true,
    allowProceduralGraphics: true,
    allowCaptions: true,
    allowGenerativeFill: true,
    allowFrameInterpolation: true,
    allowExternalStock: true,
    allowExternalAnalysis: true,
    preserveOriginalSpeech: false,
    preserveOriginalChronology: false,
  });
}

export const semanticSceneSchema = z.object({
  id: opaqueIdSchema,
  purpose: z.string().default(''),
  narration: z.string().default(''),
  sourceReferences: z.array(sourceReferenceSchema).default([]),
  compositionObjectIds: z.array(opaqueIdSchema).default([]),
});

export const semanticPlanSchema = z.object({
  narrativePlanId: opaqueIdSchema.nullable().default(null),
  scenes: z.array(semanticSceneSchema).default([]),
});

export const compositionObjectSchema = z.object({
  id: opaqueIdSchema,
  kind: z.enum(['LEGACY_SCENE']),
  semanticSceneId: opaqueIdSchema.nullable().default(null),
  sequenceRange: mediaRangeSchema,
  legacySceneId: opaqueIdSchema,
});

export const projectCompositionSchema = z.object({
  sequenceId: opaqueIdSchema,
  frameRate: frameRateSchema,
  start: mediaTimeSchema,
  duration: mediaTimeSchema,
  objects: z.array(compositionObjectSchema).default([]),
  /** N01-03 normalized composition objects; legacy fields above remain a migration projection. */
  sequences: z.array(sequenceSchema).default([]),
  tracks: z.array(trackSchema).default([]),
  clips: z.array(clipSchema).default([]),
});

export const projectDocumentSchema = z.object({
  schemaVersion: z.literal(PROJECT_DOCUMENT_SCHEMA_VERSION),
  projectId: opaqueIdSchema,
  projectRevision: revisionSchema,
  brief: projectBriefSchema,
  productionPolicy: productionPolicySchema,
  identitySnapshot: identitySnapshotSchema,
  /** null is valid for footage-first and otherwise empty projects. */
  semanticPlan: semanticPlanSchema.nullable().default(null),
  composition: projectCompositionSchema,
  assetVersionIds: z.array(opaqueIdSchema).default([]),
  sourceReferences: z.array(sourceReferenceSchema).default([]),
  dependencyGraph: z.object({
    nodes: z.array(opaqueIdSchema).default([]),
    edges: z.array(z.object({ from: opaqueIdSchema, to: opaqueIdSchema, kind: z.string().min(1) })).default([]),
  }),
  decisionBindingIds: z.array(opaqueIdSchema).default([]),
  approvalBindingIds: z.array(opaqueIdSchema).default([]),
  lockedObjectIds: z.array(opaqueIdSchema).default([]),
  renderProfile: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    frameRate: frameRateSchema,
    aspectRatio: z.string().min(1),
  }),
  /** Read-only migration projection. It must never become a parallel write model. */
  compatibility: z.object({
    sceneGraphSchemaVersion: z.string().min(1),
    sceneGraph: sceneGraphSchema,
  }),
}).strict();

export type ProjectDocument = z.infer<typeof projectDocumentSchema>;

export const GENERATION_POLICY_FIELDS = {
  'video.generate': 'allowGeneratedVideo',
  'image.generate': 'allowGeneratedImage',
  'speech.generate': 'allowGeneratedSpeech',
  'voice.replace': 'allowVoiceReplacement',
  'script.rewrite': 'allowScriptRewrite',
  'music.generate': 'allowGeneratedMusic',
  'sfx.generate': 'allowGeneratedSfx',
  'graphics.procedural': 'allowProceduralGraphics',
  'captions.generate': 'allowCaptions',
  'image.generative_fill': 'allowGenerativeFill',
  'video.frame_interpolation': 'allowFrameInterpolation',
  'stock.external': 'allowExternalStock',
  'analysis.external': 'allowExternalAnalysis',
} as const satisfies Readonly<Record<string, keyof ProductionPolicy>>;

export type GovernedGenerationCapability = keyof typeof GENERATION_POLICY_FIELDS;
