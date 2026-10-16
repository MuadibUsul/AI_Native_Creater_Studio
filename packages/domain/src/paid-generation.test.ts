import { describe, expect, it } from 'vitest';
import { IDENTITY_CONSENT_STATEMENTS, MICROS_PER_CREDIT, generationOfferSchema, mediaTimeSchema, type GenerationOffer, type GenerationRequest } from '@ancs/contracts';
import type { KernelClip, KernelTrack, TimelineState } from '@ancs/kernel';
import { AGENT_SYSTEM_PROMPT } from './agent-prompt.js';
import { defaultAgentToolCatalog } from './agent-tools.js';
import { identityConsentStatementSha256 } from './identity-profiles.js';
import { generationPlacementOperations } from './paid-generation.js';
import { billedSeconds, estimateSpeechSeconds, formatMicros, quoteGeneration } from './paid-generation-quote.js';

/**
 * V6-7 / V6-8 付费生成的纯计算部分：
 * - 报价 = 时长区间 × 每秒价格区间，确认时按上限预留（Credits 向上取整）；数字人按讲稿语速浮动且不超过供应商单次上限；
 * - 放置：数字人 = GEN 画面 + AV 人声（画中画时缩到右下角）；生成镜头 = GEN 全屏；选区重绘 = GEN + 裁切到选区（圈外仍是原画面）；
 *   已占用的 GEN 轨不覆盖，另起一条；超出序列时延长；
 * - 授权声明哈希随版本与语言变化；
 * - 通用性：AI 只能报价（GENERATE 工具只有 quote_generation），系统提示不按类型分支。
 */

const mt = (ticks: number) => mediaTimeSchema.parse({ ticks: String(ticks), timebase: { num: 1, den: 30 } });
const track = (id: string, kind: string, position: number, name: string): KernelTrack => ({ id, sequenceId: 'seq_1', kind, position, name, locked: false, muted: false, hidden: false, solo: false, syncLocked: false });
const clip = (id: string, trackId: string, start: number, end: number): KernelClip => ({
  id, sequenceId: 'seq_1', trackId, assetVersionId: `av_${id}`, nestedSequenceId: null, sourceStreamId: null,
  sourceRange: { start: mt(0), end: mt(end - start) }, sequenceRange: { start: mt(start), end: mt(end) }, timeMapping: null, avGroupId: null, parentClipId: null, parameters: null,
});
const state = (clips: KernelClip[] = [clip('c1', 'trk_v1', 0, 90)], extraTracks: KernelTrack[] = []): TimelineState => ({
  sequences: new Map([['seq_1', { id: 'seq_1', duration: mt(90) }]]),
  tracks: [track('trk_v1', 'VIDEO', 0, 'V1'), track('trk_a1', 'AUDIO', 1, 'A1'), ...extraTracks],
  clips,
  audioRegions: [],
  captions: [],
  locks: { objects: new Map() } as unknown as TimelineState['locks'],
  sources: new Map() as unknown as TimelineState['sources'],
  policy: {} as TimelineState['policy'],
});

const offer = (kind: GenerationOffer['kind'], min: number, max: number, maxSeconds = 8): GenerationOffer =>
  ({ kind, providerId: 'vendor', implementation: 'REAL', model: 'm', perSecondMicros: { min, max }, maxSeconds, languages: [] });

describe('付费生成：报价', () => {
  it('生成镜头/选区重绘：时长 × 每秒价格区间；预留 = 上限换算的 Credits（向上取整）', () => {
    const quote = quoteGeneration(offer('VIDEO_SHOT', 50_000, 400_000), 'VIDEO_SHOT', 4);
    expect(quote).toEqual({ minSeconds: 4, maxSeconds: 4, minMicros: 200_000, maxMicros: 1_600_000, reserveCredits: 1_600_000 / MICROS_PER_CREDIT });
    expect(quoteGeneration(offer('VIDEO_REGION', 33_333, 77_777), 'VIDEO_REGION', 1.5)).toMatchObject({ minMicros: 50_000, maxMicros: 116_666, reserveCredits: 12 });
  });

  it('数字人：按讲稿语速浮动 0.8–1.3 倍，上限不超过供应商单次上限', () => {
    expect(quoteGeneration(offer('AVATAR_CLIP', 35_000, 100_000, 20), 'AVATAR_CLIP', 10)).toMatchObject({ minSeconds: 8, maxSeconds: 13, minMicros: 280_000, maxMicros: 1_300_000 });
    expect(quoteGeneration(offer('AVATAR_CLIP', 35_000, 100_000, 12), 'AVATAR_CLIP', 10).maxSeconds).toBe(12);
  });

  it('只能生成固定时长的供应商（如 Veo 4/6/8 秒）：按不短于所需的最短一档报价与预留', () => {
    const veo = { ...offer('VIDEO_SHOT', 150_000, 150_000), durationOptions: [8, 4, 6] };
    expect(billedSeconds(veo, 3)).toBe(4);
    expect(billedSeconds(veo, 4)).toBe(4);
    expect(billedSeconds(veo, 4.2)).toBe(6);
    expect(billedSeconds(veo, 9)).toBe(8);
    expect(quoteGeneration(veo, 'VIDEO_SHOT', 2.5)).toEqual({ minSeconds: 4, maxSeconds: 4, minMicros: 600_000, maxMicros: 600_000, reserveCredits: 60 });
    expect(billedSeconds(offer('VIDEO_SHOT', 1, 2), 2.5)).toBe(2.5);
    expect(generationOfferSchema.safeParse({ ...veo, durationOptions: [4, 10] }).success).toBe(false);
  });

  it('讲稿时长估计：英文按词、中文按字，外加起止留白', () => {
    expect(estimateSpeechSeconds('Water covers about seventy one percent of the Earth.', 'en')).toBe(4.1);
    expect(estimateSpeechSeconds('城市里的树能让夏天凉快好几度。', 'zh')).toBe(3.7);
    expect(estimateSpeechSeconds('', 'en')).toBe(1);
    expect(formatMicros(1_234_567)).toBe('$1.23');
  });
});

describe('付费生成：放进时间线', () => {
  const base = { footageId: 'av_gen', durationMs: 2_000, hasAudio: false };

  it('选区重绘：GEN 轨，时间 = 选的范围，裁切到选区（圈外仍是原画面）', () => {
    const request: GenerationRequest = { kind: 'VIDEO_REGION', prompt: 'sunset sky', clipId: 'c1', start: mt(30), end: mt(75), region: { x: 0.5, y: 0, width: 0.5, height: 0.4 } };
    const ops = generationPlacementOperations({ state: state(), sequenceId: 'seq_1', request, ...base });
    expect(ops.map((op) => op.op)).toEqual(['create_track', 'insert_clip', 'set_clip_crop']);
    expect(ops[0]).toMatchObject({ track: { kind: 'VIDEO', position: 2, name: 'GEN1' } });
    const insert = ops[1] as Extract<typeof ops[number], { op: 'insert_clip' }>;
    // 产物 2 s 但选的范围只有 1.5 s：只取 1.5 s
    expect(insert).toMatchObject({ sequenceStart: mt(30), sourceRange: { start: mt(0), end: mt(45) }, linkAudio: false, mode: 'OVERWRITE' });
    expect(ops[2]).toMatchObject({ crop: { left: 0.5, top: 0, right: 0, bottom: expect.closeTo(0.6, 6) as number } });
  });

  it('生成镜头：已占用的 GEN 轨不覆盖而是另起一条；超出序列时延长序列', () => {
    const busy = [clip('c1', 'trk_v1', 0, 90), clip('g1', 'trk_gen', 60, 90)];
    const request: GenerationRequest = { kind: 'VIDEO_SHOT', prompt: 'drone over a lake', at: mt(75), duration: mt(60) };
    const ops = generationPlacementOperations({ state: state(busy, [track('trk_gen', 'VIDEO', 2, 'GEN1')]), sequenceId: 'seq_1', request, ...base });
    expect(ops.map((op) => op.op)).toEqual(['create_track', 'set_sequence_duration', 'insert_clip']);
    expect(ops[0]).toMatchObject({ track: { name: 'GEN2', position: 3 } });
    expect(ops[1]).toMatchObject({ duration: mt(135) });
    // 时长取请求与产物中较短的
    expect(ops[2]).toMatchObject({ sourceRange: { end: mt(60) }, sequenceStart: mt(75) });
  });

  it('数字人：画面 + 关联的人声（AV 轨）；画中画时缩到右下角', () => {
    const request: GenerationRequest = { kind: 'AVATAR_CLIP', identityId: 'cid_1', script: 'Hello', language: 'en', at: mt(0), framing: 'CORNER' };
    const ops = generationPlacementOperations({ state: state(), sequenceId: 'seq_1', request, footageId: 'av_gen', durationMs: 4_000, hasAudio: true });
    expect(ops.map((op) => op.op)).toEqual(['create_track', 'create_track', 'set_sequence_duration', 'insert_clip', 'set_clip_transform']);
    expect(ops[1]).toMatchObject({ track: { kind: 'AUDIO', name: 'AV1' } });
    const insert = ops[3] as Extract<typeof ops[number], { op: 'insert_clip' }>;
    expect(insert.linkAudio).toBe(true);
    expect(insert.audioTrackId).toBe((ops[1] as { restoreTrackId: string }).restoreTrackId);
    expect(insert.sourceRange.end).toEqual(mt(120));
    expect(ops[4]).toMatchObject({ transform: { position: { x: 0.67, y: 0.67 }, scale: { x: 0.3, y: 0.3 } } });
    const full = generationPlacementOperations({ state: state(), sequenceId: 'seq_1', request: { ...request, framing: 'FULL' }, footageId: 'av_gen', durationMs: 4_000, hasAudio: false });
    expect(full.map((op) => op.op)).toEqual(['create_track', 'set_sequence_duration', 'insert_clip']);
  });

  it('产物太短（不足一帧）：明确拒绝放置', () => {
    const request: GenerationRequest = { kind: 'VIDEO_SHOT', prompt: 'x', at: mt(0), duration: mt(30) };
    expect(() => generationPlacementOperations({ state: state(), sequenceId: 'seq_1', request, footageId: 'av_gen', durationMs: 10, hasAudio: false })).toThrow(/too short/);
  });
});

describe('身份授权与通用性', () => {
  it('授权声明哈希随版本与语言变化（记录能证明当时同意的是哪段话）', () => {
    const zh = identityConsentStatementSha256('LIKENESS', 'zh-CN');
    expect(zh).toMatch(/^[0-9a-f]{64}$/);
    expect(identityConsentStatementSha256('LIKENESS', 'en')).not.toBe(zh);
    expect(identityConsentStatementSha256('LIKENESS', 'zh-CN', 'v0')).not.toBe(zh);
    expect(identityConsentStatementSha256('VOICE', 'zh-CN')).not.toBe(zh);
    expect(IDENTITY_CONSENT_STATEMENTS.VOICE.en.length).toBeGreaterThan(0);
  });

  it('AI 只能报价：GENERATE 类工具只有 quote_generation；系统提示说明必须由人确认，不按类型分支', () => {
    const descriptors = defaultAgentToolCatalog().descriptors();
    expect(descriptors.filter((tool) => tool.effect === 'GENERATE').map((tool) => `${tool.name}:${String(tool.metered)}`)).toEqual(['quote_generation:true']);
    expect(AGENT_SYSTEM_PROMPT).toContain('quote_generation only creates a quote');
    expect(AGENT_SYSTEM_PROMPT.toLowerCase()).not.toMatch(/mr\.? ?beast|entertainment video|explainer video|travel vlog/);
  });
});
