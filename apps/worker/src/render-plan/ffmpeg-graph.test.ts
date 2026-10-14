import { describe, expect, it } from 'vitest';
import {
  ApiFailure,
  PLAYBACK_ERROR_REASONS,
  RENDER_PLAN_IR_VERSION,
  projectVisualPoint,
  stereoPanCoefficients,
  type MediaRange,
  type RenderPlan,
  type RenderPlanAudioEntry,
  type RenderPlanVideoSegment,
} from '@ancs/contracts';
import { requirementsForDelivery, unsupportedRenderRequirements } from '@ancs/domain';
import { FFMPEG_MEDIA_GRAPH_CAPABILITIES, captionsToSrt, captionsToVtt, createFfmpegRenderPlanExecutor } from './ffmpeg-executor.js';
import { compileFfmpegMediaGraph, decimalSeconds, placementOf, type FfmpegStagedSource } from './ffmpeg-graph.js';

/** V5-M4：RenderPlan → FFmpeg 媒体图（纯函数）——帧窗口、精确时基、几何与命中检测一致、声像/淡变、确定性与注入防护。 */

const MS = { num: 1, den: 1000 };
const t = (ms: number) => ({ ticks: String(ms), timebase: MS });
const r = (start: number, end: number): MediaRange => ({ start: t(start), end: t(end) });
const IDENTITY_TRANSFORM = { position: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, rotationDeg: 0, anchor: { x: 0.5, y: 0.5 } };
const NO_CROP = { left: 0, top: 0, right: 0, bottom: 0 };
const PROFILE = { width: 256, height: 128, videoCrf: 18, audioBitrateKbps: 192, captionDelivery: 'SIDECAR' as const, encoderPreset: 'medium' as const };

const segment = (clipId: string, sequence: MediaRange, source: MediaRange, extra: Partial<RenderPlanVideoSegment> = {}): RenderPlanVideoSegment => ({
  clipId, sourceVersionId: 'avA', sourceStreamId: null, sequenceRange: sequence, sourceRange: source,
  timeMapping: { kind: 'LINEAR', rate: { num: 1, den: 1 }, direction: 'FORWARD', preservePitch: true },
  transform: IDENTITY_TRANSFORM, crop: NO_CROP, opacity: 1, ...extra,
});
const audio = (id: string, sequence: MediaRange, source: MediaRange, extra: Partial<RenderPlanAudioEntry> = {}): RenderPlanAudioEntry => ({
  kind: 'REGION', id, trackId: 'a1', sourceVersionId: 'avA', sourceStreamId: null, sequenceRange: sequence, sourceRange: source,
  channelMapping: null, gainDb: 0, pan: 0, fadeIn: t(0), fadeOut: t(0), audible: true, ...extra,
});

function plan(partial: Partial<RenderPlan> = {}): RenderPlan {
  return {
    irVersion: RENDER_PLAN_IR_VERSION, planHash: 'f'.repeat(64), projectId: 'prj', sequenceId: 'seq', documentRevision: 1,
    frameRate: { num: 30000, den: 1001 }, duration: t(3_500),
    sources: [], videoLayers: [{ trackId: 'v1', trackPosition: 0, segments: [segment('c1', r(0, 3_000), r(500, 3_500))] }],
    audio: [], captions: [], graphicsElementIds: [], animatedTargets: [], requirements: [], excludedTrackIds: [], warnings: [],
    ...partial,
  };
}
const SOURCES: FfmpegStagedSource[] = [
  { assetVersionId: 'avA', path: 'assets/a.mp4', videoTimeBase: { num: 1, den: 24000 }, audioChannels: 1 },
];

describe('decimalSeconds', () => {
  it('精确有理 → 十进制：-ss 向下取整，其余就近；不出现指数记法', () => {
    expect(decimalSeconds({ num: 1n, den: 2n }, 'floor')).toBe('0.5');
    expect(decimalSeconds({ num: 1001n, den: 30000n }, 'floor')).toBe('0.033366666');
    expect(decimalSeconds({ num: 1001n, den: 30000n }, 'nearest')).toBe('0.033366667');
    expect(decimalSeconds({ num: 3n, den: 1n }, 'nearest')).toBe('3');
    expect(decimalSeconds({ num: 1n, den: 10n ** 12n }, 'nearest')).toBe('0');
  });
});

describe('compileFfmpegMediaGraph', () => {
  it('偏移分母过大（纳秒四舍五入的时间）：吸附到源时基网格，公共时基不超出 FFmpeg 的 32 位整数', () => {
    const ns = (ticks: string) => ({ ticks, timebase: { num: 1, den: 1_000_000_000 } });
    const card = segment('c1', { start: ns('1266666667'), end: t(2_000) }, { start: t(0), end: { ticks: '22', timebase: { num: 1, den: 30 } } });
    const graph = compileFfmpegMediaGraph({
      plan: plan({ frameRate: { num: 30, den: 1 }, duration: t(2_000), videoLayers: [{ trackId: 'fx', trackPosition: 1, segments: [card] }] }),
      profile: PROFILE,
      sources: [{ assetVersionId: 'avA', path: 'assets/card.mov', videoTimeBase: { num: 1, den: 15360 }, audioChannels: null }],
    });
    const settb = /settb=1\/(\d+)/.exec(graph.filterGraph);
    expect(settb).not.toBeNull();
    expect(BigInt(settb![1]!)).toBeLessThanOrEqual(2_147_483_647n);
    // 1.266666667 s 吸附到 1/15360 网格 = 19456/15360 s
    expect(graph.filterGraph).toContain('settb=1/15360,setpts=PTS+19456');
  });

  it('帧窗口与精确公共时基：段起止换成输出帧号，源时基与偏移落在整数刻度；总帧数/采样数由时长向上取整', () => {
    const graph = compileFfmpegMediaGraph({ plan: plan(), profile: PROFILE, sources: SOURCES });
    // 3.5s @ 30000/1001 → ceil(104.895) = 105 帧；48 kHz → 168000 采样
    expect(graph.frameCount).toBe(105n);
    expect(graph.sampleCount).toBe(168_000n);
    // [0, 3s) → 帧 [0, 90)；源入点 0.5s 与序列起点 0 在 1/24000 时基下为 12000 / 0 刻度
    expect(graph.filterGraph).toContain('settb=1/24000,setpts=PTS-12000,tpad=stop_mode=clone:stop_duration=2,fps=fps=30000/1001:round=up,trim=start_pts=0:end_pts=90');
    expect(graph.args).toContain('-frames:v');
    expect(graph.args[graph.args.indexOf('-frames:v') + 1]).toBe('105');
  });

  it('段不在帧网格上：kStart = ceil(start·fps)，kEnd = ceil(end·fps)；公共时基取 lcm', () => {
    const graph = compileFfmpegMediaGraph({
      plan: plan({ videoLayers: [{ trackId: 'v1', trackPosition: 0, segments: [segment('c1', r(1_010, 2_000), r(0, 990))] }] }),
      profile: PROFILE, sources: SOURCES,
    });
    // 1.01s·29.97 = 30.27 → 31；2s·29.97 = 59.94 → 60；L = lcm(24000, 1, 100) = 24000，平移 +24240 刻度
    expect(graph.filterGraph).toContain('setpts=PTS+24240');
    expect(graph.filterGraph).toContain('trim=start_pts=31:end_pts=60');
  });

  it('每个输入都带协议白名单与关键帧向前定位（ss 不晚于源入点）', () => {
    const graph = compileFfmpegMediaGraph({ plan: plan({ audio: [audio('reg1', r(0, 1_000), r(500, 1_500))] }), profile: PROFILE, sources: SOURCES });
    const inputs = graph.args.flatMap((value, index) => (value === '-i' ? [index] : []));
    expect(inputs).toHaveLength(2);
    for (const index of inputs) {
      expect(graph.args.slice(index - 7, index + 2)).toEqual(['-protocol_whitelist', 'file,pipe', '-noaccurate_seek', '-ss', '0.5', '-copyts', '-start_at_zero', '-i', 'assets/a.mp4']);
    }
  });

  it('确定性：同一输入 → 同一 argv 与 graphHash；内容变化 → 哈希变化', () => {
    const first = compileFfmpegMediaGraph({ plan: plan(), profile: PROFILE, sources: SOURCES });
    expect(compileFfmpegMediaGraph({ plan: plan(), profile: PROFILE, sources: SOURCES })).toEqual(first);
    expect(compileFfmpegMediaGraph({ plan: plan(), profile: { ...PROFILE, videoCrf: 20 }, sources: SOURCES }).graphHash).not.toBe(first.graphHash);
  });

  it('音频：可听条目才进图；单声道缺省复制到双声道；增益、等功率淡变、整数采样延迟；无可听条目时为静音', () => {
    const graph = compileFfmpegMediaGraph({
      plan: plan({ audio: [
        audio('reg1', r(250, 1_250), r(500, 1_500), { gainDb: -6, fadeIn: t(100), fadeOut: t(200) }),
        audio('muted', r(0, 1_000), r(0, 1_000), { audible: false }),
      ] }),
      profile: PROFILE, sources: SOURCES,
    });
    expect(graph.filterGraph).toContain('pan=stereo|c0=1.000000*c0|c1=1.000000*c0,atrim=start=0.5:end=1.5,asetpts=PTS-STARTPTS,volume=-6.000000dB');
    expect(graph.filterGraph).toContain('afade=t=in:st=0:d=0.1:curve=qsin,afade=t=out:st=0.8:d=0.2:curve=qsin,adelay=delays=12000S:all=1');
    expect(graph.filterGraph).toContain('amix=inputs=1:normalize=0:duration=longest,apad,atrim=end_sample=168000[aout]');
    expect(compileFfmpegMediaGraph({ plan: plan(), profile: PROFILE, sources: SOURCES }).filterGraph).toContain('anullsrc=r=48000:cl=stereo,atrim=end_sample=168000[aout]');
  });

  it('声像：WebAudio StereoPanner 立体声公式（0 = 直通，-1 = 全左，+1 = 全右）；声道路由越界拒绝', () => {
    expect(stereoPanCoefficients(0)).toEqual({ leftFromLeft: 1, leftFromRight: 0, rightFromLeft: 0, rightFromRight: 1 });
    const left = stereoPanCoefficients(-1);
    expect(left.leftFromLeft).toBe(1);
    expect(left.leftFromRight).toBeCloseTo(1, 12);
    expect(left.rightFromRight).toBeCloseTo(0, 12);
    const right = stereoPanCoefficients(1);
    expect(right.rightFromRight).toBe(1);
    expect(right.rightFromLeft).toBeCloseTo(1, 12);
    expect(right.leftFromLeft).toBeCloseTo(0, 12);
    const stereo: FfmpegStagedSource[] = [{ ...SOURCES[0]!, audioChannels: 2 }];
    const panned = compileFfmpegMediaGraph({ plan: plan({ audio: [audio('reg1', r(0, 1_000), r(0, 1_000), { pan: -1 })] }), profile: PROFILE, sources: stereo });
    expect(panned.filterGraph).toContain('pan=stereo|c0=1.000000*c0+1.000000*c1|c1=0.000000*c0+0.000000*c1');
    expect(() => compileFfmpegMediaGraph({
      plan: plan({ audio: [audio('reg1', r(0, 1_000), r(0, 1_000), { channelMapping: [{ sourceChannel: 3, outputChannel: 0 }] })] }), profile: PROFILE, sources: stereo,
    })).toThrow(RangeError);
  });

  it('缺少源流事实 → 拒绝（不静默跳过段）', () => {
    expect(() => compileFfmpegMediaGraph({ plan: plan(), profile: PROFILE, sources: [] })).toThrow(/missing video stream/);
    expect(() => compileFfmpegMediaGraph({ plan: plan({ audio: [audio('reg1', r(0, 1_000), r(0, 1_000))] }), profile: PROFILE, sources: [{ ...SOURCES[0]!, audioChannels: null }] })).toThrow(/missing audio stream/);
  });
});

describe('placementOf 与命中检测几何一致（projectVisualPoint）', () => {
  const canvas = { width: 256, height: 128 };
  const cases = [
    { transform: IDENTITY_TRANSFORM, crop: NO_CROP },
    { transform: { ...IDENTITY_TRANSFORM, scale: { x: 0.5, y: 0.5 } }, crop: NO_CROP },
    { transform: { position: { x: 0.25, y: -0.1 }, scale: { x: 0.5, y: 0.75 }, rotationDeg: 0, anchor: { x: 0, y: 0 } }, crop: { left: 0.1, top: 0.2, right: 0.3, bottom: 0 } },
    { transform: { position: { x: 0.1, y: 0.05 }, scale: { x: 0.5, y: 0.5 }, rotationDeg: 90, anchor: { x: 0.5, y: 0.5 } }, crop: NO_CROP },
  ];
  it.each(cases)('可见矩形中心落在同一画布点（±1px）', ({ transform, crop }) => {
    const placement = placementOf({ transform, crop }, canvas);
    const center = projectVisualPoint({ point: { x: 0.5, y: 0.5 }, transform, crop, viewport: canvas });
    const visibleWidth = placement.crop?.width ?? placement.scaleWidth;
    const visibleHeight = placement.crop?.height ?? placement.scaleHeight;
    const rad = placement.rotationRad;
    const outWidth = rad === 0 ? visibleWidth : Math.ceil((Math.abs(visibleWidth * Math.cos(rad)) + Math.abs(visibleHeight * Math.sin(rad))) / 2) * 2;
    const outHeight = rad === 0 ? visibleHeight : Math.ceil((Math.abs(visibleWidth * Math.sin(rad)) + Math.abs(visibleHeight * Math.cos(rad))) / 2) * 2;
    expect(Math.abs(placement.x + outWidth / 2 - center.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(placement.y + outHeight / 2 - center.y)).toBeLessThanOrEqual(1);
  });

  it('无旋转时左上角与 projectVisualPoint(0,0) 一致（±1px）', () => {
    const { transform, crop } = cases[2]!;
    const placement = placementOf({ transform, crop }, canvas);
    const corner = projectVisualPoint({ point: { x: 0, y: 0 }, transform, crop, viewport: canvas });
    expect(Math.abs(placement.x - corner.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(placement.y - corner.y)).toBeLessThanOrEqual(1);
  });
});

describe('侧载字幕', () => {
  it('SRT/VTT 时间码由 MediaTime 显示换算；字幕文本不进入 FFmpeg argv', () => {
    const withCaption = plan({ captions: [{ captionId: 'cap1', trackId: 'c1', sequenceRange: r(1_234, 3_000), text: "x'; rm -rf / ;[evil]", languageTag: 'zh-CN', style: { schemaVersion: '1.0', values: {} } }] });
    expect(captionsToSrt(withCaption)).toBe("1\n00:00:01,234 --> 00:00:03,000\nx'; rm -rf / ;[evil]\n");
    expect(captionsToVtt(withCaption)).toBe("WEBVTT\n\n00:00:01.234 --> 00:00:03.000\nx'; rm -rf / ;[evil]\n");
    const graph = compileFfmpegMediaGraph({ plan: withCaption, profile: PROFILE, sources: SOURCES });
    expect(graph.args.join(' ')).not.toContain('evil');
  });
});

describe('FFmpeg 终渲染后端裁决（执行前、无 I/O）', () => {
  const executor = createFfmpegRenderPlanExecutor({ ffmpegPath: '/nonexistent/ffmpeg', ffprobePath: '/nonexistent/ffprobe' });
  const withCaption = plan({
    requirements: ['CAPTIONS_BURNED_IN'],
    captions: [{ captionId: 'cap1', trackId: 'c1', sequenceRange: r(0, 1_000), text: '字幕', languageTag: 'zh-CN', style: { schemaVersion: '1.0', values: {} } }],
  });

  it('字幕要求烧录 → 501 CAPTIONS_BURNED_IN（不把字幕静默丢掉）；改为侧载交付时不需要烧录能力', async () => {
    const refusal = await executor.execute({ plan: withCaption, profile: { ...PROFILE, captionDelivery: 'BURNED_IN' }, workDir: '/nonexistent', sources: [] }).then(() => null, (error: unknown) => error);
    expect(refusal).toBeInstanceOf(ApiFailure);
    expect((refusal as ApiFailure).details).toMatchObject({ reason: PLAYBACK_ERROR_REASONS.UNSUPPORTED_CAPABILITY, capability: 'CAPTIONS_BURNED_IN', backend: 'FFMPEG_MEDIA_GRAPH' });
    expect(requirementsForDelivery(withCaption, { captionDelivery: 'SIDECAR' }).requirements).toEqual([]);
    expect(unsupportedRenderRequirements(requirementsForDelivery(withCaption, { captionDelivery: 'SIDECAR' }), FFMPEG_MEDIA_GRAPH_CAPABILITIES)).toEqual([]);
  });

  it('图形、关键帧、变速、嵌套序列一并列出（全部缺失项，不止首个）', async () => {
    const refusal = await executor.execute({
      plan: plan({ requirements: ['GRAPHICS_COMPONENT_RENDER', 'KEYFRAME_ANIMATION', 'NESTED_SEQUENCE', 'TIME_REMAP'], graphicsElementIds: ['vo1'] }),
      profile: PROFILE, workDir: '/nonexistent', sources: [],
    }).then(() => null, (error: unknown) => error);
    expect((refusal as ApiFailure).httpStatus).toBe(501);
    expect((refusal as ApiFailure).details).toMatchObject({ capabilities: ['GRAPHICS_COMPONENT_RENDER', 'KEYFRAME_ANIMATION', 'NESTED_SEQUENCE', 'TIME_REMAP'], objectCount: 1 });
  });

  it('落盘文件名只允许安全字符（不经用户输入拼路径）', async () => {
    const failure = await executor.execute({ plan: plan(), profile: PROFILE, workDir: '/nonexistent', sources: [{ assetVersionId: 'avA', fileName: '../etc/passwd' }] }).then(() => null, (error: unknown) => error);
    expect(String(failure)).toMatch(/非法的落盘文件名/);
  });
});
