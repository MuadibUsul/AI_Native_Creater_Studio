import { describe, expect, it } from 'vitest';
import { QA_CHECK_IDS } from '@ancs/contracts';
import { parseSrtCues, runContentChecks, runTechnicalChecks, summarizeQa, type QaArtifactBytes, type QaSubject } from './qa.js';

/**
 * P07-05 单测（纯函数，无 DB/渲染栈）：
 * 内容检查矩阵（占位/needs_review/图表数据/悬空来源/未冻结素材/缺 Master/未完成 Provider 任务）；
 * 技术核验（分辨率/fps、时长、音轨、字幕边界、校验和——**独立复核产物字节**）；
 * 汇总判定（BLOCKER 失败 → FAIL；SKIP 不影响判定）。
 */

const subject = (overrides: Partial<QaSubject> = {}): QaSubject => ({
  scenes: [
    {
      id: 'scn_1',
      sceneType: 'CHAPTER_TITLE',
      status: 'READY',
      needsReview: false,
      dataBindings: [],
      sourceBindings: [],
      assetBindings: [],
    },
    {
      id: 'scn_2',
      sceneType: 'LINE_CHART',
      status: 'READY',
      needsReview: false,
      dataBindings: [{ datasetId: 'dst_1' }],
      sourceBindings: [{ sourceId: 'src_1' }],
      assetBindings: [{ assetId: 'ast_1' }],
    },
  ],
  knownSourceIds: new Set(['src_1']),
  frozenAssetIds: new Set(['ast_1']),
  masterPresent: true,
  pendingProviderJobs: 0,
  ...overrides,
});

const status = (checks: ReturnType<typeof runContentChecks>, id: (typeof QA_CHECK_IDS)[number]) => checks.find((check) => check.id === id)?.status;

describe('内容/前置检查（预检与 Final QA 共用引擎）', () => {
  it('齐全的项目 → 全部 PASS', () => {
    const checks = runContentChecks(subject());
    expect(checks.every((check) => check.status === 'PASS')).toBe(true);
    expect(checks.map((check) => check.id)).toEqual([
      'SCENES_PRESENT',
      'SCENE_STATUS_NO_PLACEHOLDER',
      'MEDIA_SCENE_ASSETS_BOUND',
      'SCENES_NOT_NEEDS_REVIEW',
      'CHART_DATA_BINDINGS',
      'SOURCE_REFERENCES_PRESENT',
      'ASSET_BINDINGS_FROZEN',
      'MASTER_NARRATION_PRESENT',
      'NO_PENDING_PROVIDER_JOBS',
    ]);
  });

  it('空场景 → SCENES_PRESENT FAIL（明确失败）', () => {
    expect(status(runContentChecks(subject({ scenes: [] })), 'SCENES_PRESENT')).toBe('FAIL');
  });

  it('占位场景 → 阻止（未解决 placeholder 不允许进入 Final）', () => {
    const withPlaceholder = subject({ scenes: [{ ...subject().scenes[0]!, status: 'PLACEHOLDER' }] });
    const checks = runContentChecks(withPlaceholder);
    expect(status(checks, 'SCENE_STATUS_NO_PLACEHOLDER')).toBe('FAIL');
    expect(checks.find((check) => check.id === 'SCENE_STATUS_NO_PLACEHOLDER')?.message).toContain('占位场景');
  });

  it('needs_review → 阻止自动发布', () => {
    const flagged = subject({ scenes: [{ ...subject().scenes[0]!, needsReview: true }] });
    expect(status(runContentChecks(flagged), 'SCENES_NOT_NEEDS_REVIEW')).toBe('FAIL');
  });

  it('EMPTY 场景（V1 默认状态）→ 警告（可见但不假阻止）；PLACEHOLDER → 阻止', () => {
    const emptyScene = subject({ scenes: [{ ...subject().scenes[0]!, status: 'EMPTY' }] });
    const emptyCheck = runContentChecks(emptyScene).find((check) => check.id === 'SCENE_STATUS_NO_PLACEHOLDER');
    expect(emptyCheck?.status).toBe('FAIL');
    expect(emptyCheck?.severity).toBe('WARNING');
    const placeholderScene = subject({ scenes: [{ ...subject().scenes[0]!, status: 'PLACEHOLDER' }] });
    const placeholderCheck = runContentChecks(placeholderScene).find((check) => check.id === 'SCENE_STATUS_NO_PLACEHOLDER');
    expect(placeholderCheck?.severity).toBe('BLOCKER');
    expect(summarizeQa(runContentChecks(placeholderScene)).verdict).toBe('FAIL');
  });

  it('媒体类场景未绑定素材 → 阻止（占位不允许进入 Final）', () => {
    const mediaScene = subject({ scenes: [{ id: 'scn_m', sceneType: 'IMAGE_FULL', status: 'READY', needsReview: false, dataBindings: [], sourceBindings: [], assetBindings: [] }] });
    const checks = runContentChecks(mediaScene);
    expect(status(checks, 'MEDIA_SCENE_ASSETS_BOUND')).toBe('FAIL');
    expect(summarizeQa(checks).verdict).toBe('FAIL');
  });

  it('图表场景缺数据绑定 → 阻止（不得编造图形数据）', () => {
    const noData = subject({ scenes: [subject().scenes[1] === undefined ? subject().scenes[0]! : { ...subject().scenes[1]!, dataBindings: [] }] });
    const checks = runContentChecks(noData);
    expect(status(checks, 'CHART_DATA_BINDINGS')).toBe('FAIL');
  });

  it('悬空来源引用 → 阻止（来源必须可追溯）', () => {
    const dangling = subject({ knownSourceIds: new Set() });
    expect(status(runContentChecks(dangling), 'SOURCE_REFERENCES_PRESENT')).toBe('FAIL');
  });

  it('素材绑定未冻结 → 阻止（缺素材不允许发布）', () => {
    const notFrozen = subject({ frozenAssetIds: new Set() });
    expect(status(runContentChecks(notFrozen), 'ASSET_BINDINGS_FROZEN')).toBe('FAIL');
  });

  it('缺 Master Narration / 未完成 Provider 任务 → 阻止', () => {
    const checks = runContentChecks(subject({ masterPresent: false, pendingProviderJobs: 2 }));
    expect(status(checks, 'MASTER_NARRATION_PRESENT')).toBe('FAIL');
    expect(status(checks, 'NO_PENDING_PROVIDER_JOBS')).toBe('FAIL');
  });
});

/* ---------- 技术核验 ---------- */

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const SRT = ['1', '00:00:00,000 --> 00:00:03,000', '第一段', '', '2', '00:00:03,000 --> 00:00:06,000', '第二段', ''].join('\n');

async function makeArtifacts(overrides: { srt?: string; videoChecksum?: string | null } = {}): Promise<QaArtifactBytes[]> {
  const { createHash } = await import('node:crypto');
  const sha = (value: string): string => createHash('sha256').update(value).digest('hex');
  const videoBytes = bytes('fake-mp4');
  const srt = overrides.srt ?? SRT;
  return [
    { kind: 'VIDEO', fileName: 'final.mp4', bytes: videoBytes, recordedChecksumSha256: overrides.videoChecksum === undefined ? sha('fake-mp4') : overrides.videoChecksum },
    { kind: 'SUBTITLE_SRT', fileName: 'subtitles.srt', bytes: bytes(srt), recordedChecksumSha256: sha(srt) },
    { kind: 'SUBTITLE_VTT', fileName: 'subtitles.vtt', bytes: bytes(`WEBVTT\n\n${srt}`), recordedChecksumSha256: sha(`WEBVTT\n\n${srt}`) },
    { kind: 'MANIFEST', fileName: 'manifest.json', bytes: bytes('{}'), recordedChecksumSha256: sha('{}') },
  ];
}

const technicalInput = async (overrides: Parameters<typeof makeArtifacts>[0] = {}, probe: Record<string, unknown> = {}) => ({
  artifacts: await makeArtifacts(overrides),
  probeResult: {
    width: 1920,
    height: 1080,
    fps: 30,
    durationMs: 6000,
    hasAudio: true,
    audioCodec: 'aac',
    videoCodec: 'h264',
    ...probe,
  },
  expectedFormat: { width: 1920, height: 1080, fps: 30 },
  manifestDurationMs: 6000,
  masterDurationMs: 6000,
  expectedCueCount: 2,
  captionStyle: {},
  captionCues: [
    { startMs: 0, durationMs: 3000, text: '第一段' },
    { startMs: 3000, durationMs: 3000, text: '第二段' },
  ],
});

describe('技术核验（独立复核）', () => {
  it('全部通过：分辨率/fps、时长、音轨、字幕边界、校验和；响度与 AI QA 显式 SKIP', async () => {
    const { checks } = await runTechnicalChecks(await technicalInput());
    expect(checks.every((check) => check.status !== 'FAIL')).toBe(true);
    expect(checks.find((check) => check.id === 'AUDIO_LOUDNESS_RANGE')?.status).toBe('SKIP');
    expect(checks.find((check) => check.id === 'AI_VISUAL_QA')?.status).toBe('SKIP');
    expect(summarizeQa(checks).verdict).toBe('PASS');
  });

  it('分辨率不符 → 阻止（期望档位权威）', async () => {
    const { checks } = await runTechnicalChecks(await technicalInput({}, { width: 1280, height: 720 }));
    expect(checks.find((check) => check.id === 'VIDEO_RESOLUTION_FPS')?.status).toBe('FAIL');
    expect(summarizeQa(checks).verdict).toBe('FAIL');
  });

  it('时长与 Manifest 不一致（> 容差）→ 阻止', async () => {
    const { checks } = await runTechnicalChecks(await technicalInput({}, { durationMs: 6000 + 351 }));
    expect(checks.find((check) => check.id === 'VIDEO_DURATION_MATCHES_MANIFEST')?.status).toBe('FAIL');
  });

  it('无音轨 → 阻止', async () => {
    const { checks } = await runTechnicalChecks(await technicalInput({}, { hasAudio: false, audioCodec: null }));
    expect(checks.find((check) => check.id === 'AUDIO_TRACK_PRESENT')?.status).toBe('FAIL');
  });

  it('字幕越界（末 cue 超出成片时长）→ 阻止', async () => {
    const overrun = ['1', '00:00:00,000 --> 00:00:09,500', '越界段', ''].join('\n');
    const { checks } = await runTechnicalChecks(await technicalInput({ srt: overrun }));
    expect(checks.find((check) => check.id === 'SUBTITLE_TIMING_BOUNDS')?.status).toBe('FAIL');
  });

  it('校验和与入库记录不一致 → 阻止（独立重算为准）', async () => {
    const { checks } = await runTechnicalChecks(await technicalInput({ videoChecksum: 'f'.repeat(64) }));
    expect(checks.find((check) => check.id === 'ARTIFACT_CHECKSUM_MATCH')?.status).toBe('FAIL');
  });

  it('字幕行宽超安全区 → 警告（不阻止，但可见）', async () => {
    // 宽度检查以 Alignment 文本重算断行（不是解析 SRT 字节）：超 2 行（>36 视觉宽）触发截断警告
    const longText = '这是一段非常非常非常非常非常非常非常非常非常非常长的字幕文本用于触发宽度安全区警告';
    const { checks } = await runTechnicalChecks({
      ...(await technicalInput()),
      captionCues: [{ startMs: 0, durationMs: 3000, text: longText }],
    });
    const widthCheck = checks.find((check) => check.id === 'SUBTITLE_WIDTH_SAFE');
    expect(widthCheck?.status).toBe('FAIL');
    expect(widthCheck?.severity).toBe('WARNING');
    expect(summarizeQa(checks).verdict).toBe('PASS'); // 警告不阻止
  });

  it('SRT 时间解析：多位 cue 顺序解析（含毫秒）', () => {
    const cues = parseSrtCues(SRT);
    expect(cues).toEqual([
      { startMs: 0, endMs: 3000 },
      { startMs: 3000, endMs: 6000 },
    ]);
  });
});
