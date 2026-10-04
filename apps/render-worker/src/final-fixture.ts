import {
  RENDER_EXECUTION_SPEC_VERSION,
  RENDER_MANIFEST_VERSION,
  renderExecutionSpecSchema,
  type RenderExecutionSpec,
} from '@ancs/contracts';

/**
 * FinalComposition 的默认 props（Remotion Composition 要求 defaultProps；实际渲染一律由
 * `renderMedia({ inputProps: { spec } })` 覆盖）。此 fixture 同时是"spec 结构可渲染"的最小样例
 * （组件画廊/单测可参考）。
 */
export const FINAL_COMPOSITION_FIXTURE_SPEC: RenderExecutionSpec = renderExecutionSpecSchema.parse({
  schemaVersion: RENDER_EXECUTION_SPEC_VERSION,
  renderId: 'rnd_fixture',
  workspaceId: 'ws_fixture',
  projectId: 'prj_fixture',
  profile: 'DRAFT_720',
  format: { width: 1280, height: 720, fps: 30, aspectRatio: '16:9' },
  durationMs: 3000,
  graph: {
    format: { fps: 30, width: 1280, height: 720, aspectRatio: '16:9' },
    timeline: { durationMs: 3000 },
    scenes: [
      {
        id: 'scn_fixture_1',
        position: 0,
        startMs: 0,
        durationMs: 3000,
        sceneType: 'CHAPTER_TITLE',
        componentVersion: null,
        props: { title: 'Final 合成（fixture）', subtitle: 'defaultProps 样例', index: 1 },
        assetBindings: [],
      },
    ],
  },
  theme: null,
  narration: null,
  musicTracks: [],
  captions: { burnIn: false, cues: [] },
  assets: [],
  manifestBase: {
    schemaVersion: RENDER_MANIFEST_VERSION,
    projectId: 'prj_fixture',
    projectVersionId: 'pv_fixture',
    projectVersionNumber: 1,
    sceneGraphSchemaVersion: '0.1',
    script: null,
    componentVersions: [{ sceneId: 'scn_fixture_1', sceneType: 'CHAPTER_TITLE', componentVersion: null }],
    sceneAssets: [],
    masterAudio: null,
    identities: {},
    renderSettings: {
      profile: 'DRAFT_720',
      width: 1280,
      height: 720,
      fps: 30,
      durationMs: 3000,
      captions: { burnIn: false, format: 'VTT+SRT' },
      audio: { musicTrackCount: 0 },
    },
    providerMetadata: [],
    sourceReferences: [],
  },
  warnings: [],
});
