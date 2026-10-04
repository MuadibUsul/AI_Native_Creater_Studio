import { describe, expect, it } from 'vitest';
import {
  ApiFailure,
  DEFAULT_THEME_TOKENS,
  RENDER_MANIFEST_VERSION,
  masterNarrationSchema,
  renderRecordSchema,
  projectVersionSnapshotSchema,
} from '@ancs/contracts';
import { buildRenderExecutionSpec, persistRenderArtifacts } from './render-execution.js';
import type { RenderAssetRow, RenderAssetVersionRow } from './render-execution.js';

/**
 * P07-04 单测（纯投影，无 DB/渲染栈）：
 * 快照 + Master Narration + 冻结资产版本 → spec（staging/字幕/BGM 混音计划/Manifest 基线）；
 * 缺失输入/未冻结版本 → 明确失败或明确告警（绝不静默取"当前版本"）。
 */

const WORKSPACE = 'ws_render_exec';
const PROJECT = 'prj_render_exec';

function makeSnapshot(overrides: { durationMs?: number } = {}) {
  return projectVersionSnapshotSchema.parse({
    schemaVersion: '0.1',
    graph: {
      schemaVersion: 'scene-graph-v1',
      projectId: PROJECT,
      projectRevision: 3,
      channelSnapshot: { channelId: 'chn_1', channelStyleVersion: 'v1', speechProfileId: null, speechProfileVersion: null },
      identitySnapshot: { voiceIdentityId: 'vid_1', voiceIdentityVersion: '2' },
      format: { width: 1920, height: 1080, fps: 30, aspectRatio: '16:9' },
      timeline: { durationMs: overrides.durationMs ?? 6000, masterAudioAssetId: null },
      scenes: [
        {
          id: 'scn_1',
          revision: 1,
          position: 0,
          startMs: 0,
          durationMs: 3000,
          semanticType: 'HOST_STATEMENT',
          sceneType: 'CHAPTER_TITLE',
          props: { title: '第一章' },
          componentVersion: '1.0.0',
          assetBindings: [{ assetId: 'ast_img', role: 'visual' }],
          transition: { in: null, out: null },
          status: 'READY',
        },
        {
          id: 'scn_2',
          revision: 1,
          position: 1,
          startMs: 3000,
          durationMs: 3000,
          semanticType: 'NUMBER',
          sceneType: 'BIG_NUMBER',
          props: { value: '5.25%' },
          componentVersion: '1.0.0',
          assetBindings: [],
          transition: { in: null, out: null },
          status: 'READY',
        },
      ],
      captions: [],
      audioTracks: [
        { id: 'atr_music', kind: 'MUSIC', assetId: 'ast_music', volume: 0.8, fadeInMs: 500, fadeOutMs: 800, ducking: true },
      ],
      overlays: [],
      sourceReferences: [{ sourceId: 'src_1', datasetIds: ['ds_1'] }],
    },
    meta: { themeTokens: DEFAULT_THEME_TOKENS },
  });
}

function makeRender() {
  return renderRecordSchema.parse({
    id: 'rnd_1',
    workspaceId: WORKSPACE,
    projectId: PROJECT,
    profile: 'DRAFT_720',
    status: 'QUEUED',
    input: {
      projectVersionId: 'pv_1',
      masterNarrationId: 'mna_1',
      assetVersionIds: ['av_img', 'av_music'],
      format: { width: 1280, height: 720, fps: 30 },
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

function makeMaster(overrides: { totalDurationMs?: number; assetVersionId?: string | null } = {}) {
  return masterNarrationSchema.parse({
    id: 'mna_1',
    workspaceId: WORKSPACE,
    projectId: PROJECT,
    narrativePlanId: 'npl_1',
    narrativePlanRevision: 2,
    assetId: 'ast_narration',
    assetVersionId: overrides.assetVersionId === undefined ? 'av_narration' : overrides.assetVersionId,
    mimeType: 'audio/wav',
    sizeBytes: 100,
    checksumSha256: 'a'.repeat(64),
    totalDurationMs: overrides.totalDurationMs ?? 6000,
    alignmentMethod: 'PROVIDER_TIMESTAMPS',
    segments: [
      { narrationBlockId: 'nrg_1', text: '第一章：背景', charCount: 7, startMs: 0, durationMs: 3000, endMs: 3000, words: [], cacheKey: 'c1', reused: false },
      { narrationBlockId: 'nrg_2', text: '利率维持在 5.25% 不变。', charCount: 14, startMs: 3000, durationMs: 3000, endMs: 6000, words: [], cacheKey: 'c2', reused: false },
    ],
    cues: [
      { narrationBlockId: 'nrg_1', startMs: 0, durationMs: 3000 },
      { narrationBlockId: 'nrg_2', startMs: 3000, durationMs: 3000 },
    ],
    voice: { voiceIdentityId: 'vid_1', voiceIdentityVersion: 2 },
    cacheStats: { segments: 2, reused: 0, synthesized: 2 },
    warnings: [],
    createdAt: new Date().toISOString(),
  });
}

const ASSET_VERSIONS: RenderAssetVersionRow[] = [
  { id: 'av_narration', assetId: 'ast_narration', storageKey: `${WORKSPACE}/narration.wav`, mimeType: 'audio/wav' },
  { id: 'av_img', assetId: 'ast_img', storageKey: `${WORKSPACE}/image.png`, mimeType: 'image/png' },
  { id: 'av_music', assetId: 'ast_music', storageKey: `${WORKSPACE}/music.wav`, mimeType: 'audio/wav' },
];

const ASSET_ROWS: RenderAssetRow[] = [
  { id: 'ast_img', provider: null, providerAssetId: null, origin: 'USER_UPLOAD' },
  { id: 'ast_narration', provider: 'mock-voice', providerAssetId: null, origin: 'SYSTEM_RENDER' },
];

describe('buildRenderExecutionSpec（P07-04 纯投影）', () => {
  it('快照 + Master + 冻结版本 → spec：画幅/staging/字幕/混音计划/Manifest 基线', () => {
    const { spec, staging, warnings } = buildRenderExecutionSpec({
      render: makeRender(),
      snapshot: makeSnapshot(),
      versionNumber: 4,
      master: makeMaster(),
      assetVersionRows: ASSET_VERSIONS,
      assetRows: ASSET_ROWS,
    });

    // 画幅：档位权威（DRAFT_720 → 1280×720）；宽高比由画幅推导
    expect(spec.format).toEqual({ width: 1280, height: 720, fps: 30, aspectRatio: '16:9' });
    expect(spec.durationMs).toBe(6000);
    expect(warnings).toEqual([]);

    // 场景：透传（含 props 与组件版本）
    expect(spec.graph.scenes.map((scene) => scene.sceneType)).toEqual(['CHAPTER_TITLE', 'BIG_NUMBER']);
    expect(spec.graph.scenes[0]?.componentVersion).toBe('1.0.0');

    // staging：场景素材（visual）+ 旁白 + BGM（全部来自冻结清单）
    expect(staging.map((entry) => entry.role).sort()).toEqual(['music', 'narration', 'visual']);
    const imageEntry = staging.find((entry) => entry.assetId === 'ast_img');
    expect(imageEntry?.fileName).toBe('visual_av_img.png');
    expect(spec.narration?.fileName).toBe('narration_av_narration.wav');
    expect(spec.narration?.durationMs).toBe(6000);

    // 字幕：cue 数与 Alignment 段一致（时间权威 = Alignment）
    expect(spec.captions.cues).toHaveLength(2);
    expect(spec.captions.burnIn).toBe(true);
    expect(spec.captions.cues[1]?.text).toBe('利率维持在 5.25% 不变。');

    // BGM：混音计划的增益包络（ducking 在旁白区间压低）
    expect(spec.musicTracks).toHaveLength(1);
    const music = spec.musicTracks[0];
    expect(music?.trackId).toBe('atr_music');
    expect(music?.fileName).toBe('music_av_music.wav');
    expect(music?.keyframes.some((keyframe) => keyframe.reason === 'DUCKING')).toBe(true);
    expect(music?.keyframes.some((keyframe) => keyframe.reason === 'FADE_IN')).toBe(true);

    // 主题：随快照固化
    expect(spec.theme?.color.background).toBe(DEFAULT_THEME_TOKENS.color.background);

    // Manifest 基线（REQ-28-01）
    expect(spec.manifestBase.schemaVersion).toBe(RENDER_MANIFEST_VERSION);
    expect(spec.manifestBase.projectVersionId).toBe('pv_1');
    expect(spec.manifestBase.projectVersionNumber).toBe(4);
    expect(spec.manifestBase.sceneGraphSchemaVersion).toBe('scene-graph-v1');
    expect(spec.manifestBase.script).toEqual({ narrativePlanId: 'npl_1', narrativePlanRevision: 2 });
    expect(spec.manifestBase.componentVersions).toHaveLength(2);
    expect(spec.manifestBase.sceneAssets).toEqual([{ sceneId: 'scn_1', assetId: 'ast_img', assetVersionId: 'av_img', role: 'visual' }]);
    expect(spec.manifestBase.masterAudio?.masterNarrationId).toBe('mna_1');
    expect(spec.manifestBase.renderSettings.profile).toBe('DRAFT_720');
    expect(spec.manifestBase.renderSettings.audio.musicTrackCount).toBe(1);
    expect(spec.manifestBase.providerMetadata).toHaveLength(2);
    expect(spec.manifestBase.sourceReferences).toEqual([{ sourceId: 'src_1', datasetIds: ['ds_1'] }]);
  });

  it('时长偏差 > 1s → 明确告警（After-Alignment 重定时未实现，不静默）', () => {
    const { spec, warnings } = buildRenderExecutionSpec({
      render: makeRender(),
      snapshot: makeSnapshot({ durationMs: 6000 }),
      master: makeMaster({ totalDurationMs: 12_000 }),
      assetVersionRows: ASSET_VERSIONS,
    });
    expect(spec.durationMs).toBe(12_000);
    expect(warnings.some((warning) => warning.includes('After-Alignment'))).toBe(true);
    expect(spec.warnings).toHaveLength(warnings.length);
  });

  it('旁白音频版本缺失 → 明确失败（Audio-First：无音频不成片）', () => {
    expect(() =>
      buildRenderExecutionSpec({
        render: makeRender(),
        snapshot: makeSnapshot(),
        master: makeMaster({ assetVersionId: null }),
        assetVersionRows: ASSET_VERSIONS,
      }),
    ).toThrow(ApiFailure);
  });

  it('音轨资产未随 Render 输入冻结 → 跳过并告警（绝不取"当前版本"）', () => {
    const render = makeRender();
    const { spec, warnings } = buildRenderExecutionSpec({
      render: { ...render, input: { ...render.input, assetVersionIds: ['av_img'] } },
      snapshot: makeSnapshot(),
      master: makeMaster(),
      assetVersionRows: ASSET_VERSIONS,
    });
    expect(spec.musicTracks).toHaveLength(0);
    expect(warnings.some((warning) => warning.includes('atr_music'))).toBe(true);
  });
});

describe('persistRenderArtifacts 前置校验（fail-closed）', () => {
  const baseDeps = { db: null as never };

  it('未配置对象存储 → 501（产物必须落自有存储）', async () => {
    await expect(
      persistRenderArtifacts(baseDeps, {
        workspaceId: WORKSPACE,
        projectId: PROJECT,
        renderId: 'rnd_1',
        profile: 'DRAFT_720',
        artifacts: [],
        manifestHash: 'a'.repeat(64),
      }),
    ).rejects.toMatchObject({ httpStatus: 501 });
  });

  it('manifest_hash 与 Manifest 字节不一致 → 422（完整性优先）', async () => {
    const storage = {
      kind: 'fake',
      putObject: async () => undefined,
    } as never;
    await expect(
      persistRenderArtifacts({ db: null as never, storage: storage as never }, {
        workspaceId: WORKSPACE,
        projectId: PROJECT,
        renderId: 'rnd_1',
        profile: 'DRAFT_720',
        artifacts: [{ kind: 'MANIFEST', fileName: 'manifest.json', bytes: new Uint8Array([1]), sha256: 'b'.repeat(64) }],
        manifestHash: 'a'.repeat(64),
      }),
    ).rejects.toMatchObject({ httpStatus: 422 });
  });
});
