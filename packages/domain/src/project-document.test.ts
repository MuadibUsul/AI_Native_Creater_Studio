import { describe, expect, it } from 'vitest';
import {
  defaultProductionPolicy,
  projectDocumentSchema,
  sceneGraphSchema,
} from '@ancs/contracts';
import { projectDocumentFromSceneGraph } from './project-document.js';

const emptyGraph = sceneGraphSchema.parse({
  schemaVersion: '0.1',
  projectId: 'prj_empty',
  projectRevision: 1,
  channelSnapshot: {
    channelId: 'chn_1',
    channelStyleVersion: '1',
    speechProfileId: null,
    speechProfileVersion: null,
  },
  identitySnapshot: {
    avatarIdentityId: null,
    avatarIdentityVersion: null,
    voiceIdentityId: null,
    voiceIdentityVersion: null,
    brandIdentityId: null,
    brandIdentityVersion: null,
  },
  format: { width: 1920, height: 1080, fps: 30, aspectRatio: '16:9' },
  timeline: { durationMs: 60_000, masterAudioAssetId: null },
  scenes: [],
});

describe('N01-02 ProjectDocument and production modes', () => {
  it('accepts a footage-first empty document without NarrativePlan or narration', () => {
    const document = projectDocumentFromSceneGraph({
      graph: emptyGraph,
      brief: {},
      productionPolicy: defaultProductionPolicy('FOOTAGE_EDIT'),
    });
    expect(() => projectDocumentSchema.parse(document)).not.toThrow();
    expect(document.semanticPlan).toBeNull();
    expect(document.composition.objects).toEqual([]);
    expect(document.productionPolicy).toMatchObject({
      mode: 'FOOTAGE_EDIT',
      allowGeneratedVideo: false,
      allowGeneratedSpeech: false,
      preserveOriginalSpeech: true,
    });
  });

  it('maps a legacy SceneGraph into linked semantic and composition projections', () => {
    const sceneGraph = sceneGraphSchema.parse({
      ...emptyGraph,
      projectId: 'prj_legacy',
      projectRevision: 2,
      timeline: { durationMs: 5_000, masterAudioAssetId: null },
      scenes: [{
        id: 'scn_1', revision: 1, position: 0, startMs: 0, durationMs: 5_000,
        semanticType: 'BROLL', sceneType: 'REAL_BROLL', narrationBlockIds: [], narration: '',
        visualIntent: '保留原始街景', componentId: null, componentVersion: null, props: {},
        providerRequirement: null, sourceBindings: [{ sourceId: 'src_1', datasetIds: [], claimIds: [] }],
        dataBindings: [], assetBindings: [], transition: { in: null, out: null },
        locked: true, approved: false, needsReview: false, status: 'READY',
      }],
    });
    const document = projectDocumentFromSceneGraph({
      graph: sceneGraph,
      brief: { objective: '素材剪辑' },
      productionPolicy: defaultProductionPolicy('HYBRID'),
    });
    expect(document.semanticPlan?.narrativePlanId).toBeNull();
    expect(document.semanticPlan?.scenes[0]).toMatchObject({
      id: 'scn_1', compositionObjectIds: ['cmp_scn_1'], narration: '',
    });
    expect(document.composition.objects[0]).toMatchObject({
      id: 'cmp_scn_1', semanticSceneId: 'scn_1', legacySceneId: 'scn_1',
    });
    expect(document.lockedObjectIds).toEqual(['cmp_scn_1']);
    expect(document.compatibility.sceneGraph).toEqual(sceneGraph);
  });

  it('keeps permissions distinct instead of treating mode as one broad AI switch', () => {
    const hybrid = defaultProductionPolicy('HYBRID');
    expect(hybrid.allowExternalAnalysis).toBe(true);
    expect(hybrid.allowProceduralGraphics).toBe(true);
    expect(hybrid.allowGeneratedVideo).toBe(false);
    expect(hybrid.allowVoiceReplacement).toBe(false);
  });
});
