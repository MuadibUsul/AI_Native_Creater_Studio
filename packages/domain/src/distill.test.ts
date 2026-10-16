import { describe, expect, it } from 'vitest';
import { referenceMeasurementSchema, strategyPackSchema, type AgentModelAdapter, type ReferenceMeasurement } from '@ancs/contracts';
import { detectBeats } from './audio-beats.js';
import { beatCutRatio, describeColor, distillStats, editingDnaFromStats, pacingCurve, shotDurations } from './distill-dna.js';
import { composeStrategyFromStats, composeStrategyWithModel } from './distill-compose.js';
import { strategyGuidanceText } from './strategies.js';

/**
 * V6-6 蒸馏器纯函数（合成信号与手算真值）：节拍检测（速度、对齐、噪声低置信度）、镜头时长与节奏曲线、
 * 卡点比例、多条参考合并、规则版说明（中英、可信度说明、数值来自测量）、模型版（数值不被模型改写、坏回复明确失败）。
 */

const SR = 11025;
function rng(seed: number) {
  let state = seed;
  return () => { state = (state + 0x6D2B79F5) | 0; let t = Math.imul(state ^ (state >>> 15), 1 | state); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5; };
}
function clickTrack(bpm: number, seconds: number, noise: number, offset = 0.13) {
  const samples = new Float32Array(Math.round(SR * seconds));
  const random = rng(bpm);
  for (let i = 0; i < samples.length; i += 1) samples[i] = random() * noise;
  const truth: number[] = [];
  for (let t = offset; t < seconds; t += 60 / bpm) {
    truth.push(t);
    const start = Math.round(t * SR);
    for (let k = 0; k < 800 && start + k < samples.length; k += 1) samples[start + k]! += Math.exp(-k / 120) * Math.sin((2 * Math.PI * 180 * k) / SR) * 0.9;
  }
  return { samples, truth };
}

const measurement = (overrides: Partial<ReferenceMeasurement> = {}): ReferenceMeasurement => referenceMeasurementSchema.parse({
  label: 'ref.mp4', durationSeconds: 60, analyzedSeconds: 60, width: 1920, height: 1080, frameRate: 30, hasAudio: true,
  cuts: [], blackDips: [], sceneActivity: 0.05, color: null, audio: null, beats: null, speech: null, ...overrides,
});

describe('节拍检测', () => {
  it.each([[82, 0.3], [97, 0.1], [120, 0.05], [140, 0.2], [174, 0.1]])('%i BPM（噪声 %f）：速度误差 < 1 BPM；节拍平均偏差 ≤ 20 ms、最大 ≤ 60 ms（卡点判定窗口 ±70 ms）', (bpm, noise) => {
    const { samples, truth } = clickTrack(bpm, 30, noise);
    const beats = detectBeats(samples, SR)!;
    expect(Math.abs(beats.bpm - bpm)).toBeLessThan(1);
    expect(beats.confidence).toBeGreaterThan(0.5);
    const offsets = truth.slice(1, -1).map((t) => Math.abs(beats.times.reduce((best, time) => (Math.abs(time - t) < Math.abs(best - t) ? time : best), Infinity) - t));
    expect(Math.max(...offsets)).toBeLessThanOrEqual(0.06);
    expect(offsets.reduce((sum, value) => sum + value, 0) / offsets.length).toBeLessThanOrEqual(0.02);
  });

  it('白噪声与随机爆发音（像说话）：置信度很低（< 0.2）', () => {
    for (const seed of [3, 7, 11]) {
      const random = rng(seed);
      const noise = new Float32Array(SR * 30).map(() => random());
      expect(detectBeats(noise, SR)!.confidence).toBeLessThan(0.2);
    }
    const random = rng(5);
    const bursts = new Float32Array(SR * 30);
    for (let t = 0; t < 29;) {
      const length = 0.1 + (random() + 0.5) * 0.4;
      const start = Math.round(t * SR);
      for (let k = 0; k < length * SR; k += 1) bursts[start + k] = random() * Math.sin((Math.PI * k) / (length * SR));
      t += length + (random() + 0.5) * 0.3;
    }
    expect(detectBeats(bursts, SR)!.confidence).toBeLessThan(0.2);
    expect(detectBeats(new Float32Array(SR * 2), SR)).toBeNull();
  });
});

describe('剪辑 DNA', () => {
  it('镜头时长、节奏曲线、卡点比例（含对照：随机剪的比例）', () => {
    const cuts = [2, 4, 6, 8, 10, 12.03, 15.5, 30, 45];
    const m = measurement({ cuts, beats: { bpm: 120, confidence: 0.9, times: Array.from({ length: 120 }, (_, index) => index * 0.5) } });
    expect(shotDurations(m)).toEqual([2, 2, 2, 2, 2, 2.0299999999999994, 3.4700000000000006, 14.5, 15, 15]);
    expect(pacingCurve(m)).toEqual([20, 30, 20, 0, 0, 10, 0, 10, 0, 0]); // 每段 6 秒
    expect(beatCutRatio(m)).toEqual({ onBeat: 9, cuts: 9 }); // 全在 0.5 s 网格上；12.03 在 ±70 ms 内
    const grid = { bpm: 120, confidence: 0.9, times: Array.from({ length: 20 }, (_, index) => index * 0.5) };
    expect(beatCutRatio(measurement({ cuts: [1.25, 2.0, 3.3, 4.04, 5.75], beats: grid }))).toEqual({ onBeat: 2, cuts: 5 });
    expect(beatCutRatio(measurement({ cuts, beats: { bpm: 120, confidence: 0.1, times: [] } }))).toBeNull();
    const stats = distillStats([m]);
    expect(stats).toMatchObject({ references: 1, analyzedSeconds: 60, shots: 10, shotMedian: 2.01, cutsPerMinute: 9, beatCutRatio: 1, beatChanceRatio: 0.28, bpm: 120 });
  });

  it('多条参考合并：镜头时长合并统计，节奏曲线按相对位置平均，色彩/响度按时长加权', () => {
    const fast = measurement({ label: 'a.mp4', cuts: Array.from({ length: 59 }, (_, index) => index + 1), color: { luma: 0.7, saturation: 0.5, contrast: 0.8, warmth: 0.2 }, audio: { integratedLufs: -12, loudnessRange: 5, silenceRatio: 0.01 } });
    const slow = measurement({ label: 'b.mp4', durationSeconds: 120, analyzedSeconds: 120, cuts: [30, 60, 90], color: { luma: 0.4, saturation: 0.2, contrast: 0.5, warmth: -0.1 }, audio: { integratedLufs: -18, loudnessRange: 8, silenceRatio: 0.1 } });
    const stats = distillStats([fast, slow]);
    expect(stats.references).toBe(2);
    expect(stats.shots).toBe(64);
    expect(stats.cutsPerMinute).toBe(20.7);
    expect(stats.pacing[0]).toBe(25); // 第一段：a 有 5 个剪点/6 秒 = 50/分，b 没有 = 0 → 平均 25
    expect(stats.color).toEqual({ luma: 0.5, saturation: 0.3, contrast: 0.6, warmth: 0 });
    expect(stats.loudness).toEqual({ integratedLufs: -16, silenceRatio: 0.07 });
    expect(describeColor({ luma: 0.7, saturation: 0.5, contrast: 0.8, warmth: 0.2 })).toBe('bright, high-key images, vivid, saturated color, high contrast, a warm cast');
    const dna = editingDnaFromStats(stats);
    expect(dna).toMatchObject({ cutsPerMinute: 20.7, measured: { references: 2, analyzedSeconds: 180, shots: 64 }, shotScaleVariety: null, zoomsPerMinute: null, speedRampsPerMinute: null });
  });
});

describe('风格说明撰写', () => {
  const beatCuts = Array.from({ length: 80 }, (_, index) => 0.5 * (index + 1) + (index < 20 ? 0 : index * 0.25));
  const fast = measurement({
    label: 'Creator — Tokyo vlog', cuts: beatCuts.filter((cut) => cut < 60),
    beats: { bpm: 120, confidence: 0.9, times: Array.from({ length: 120 }, (_, index) => index * 0.5) },
    color: { luma: 0.65, saturation: 0.45, contrast: 0.8, warmth: 0.1 }, audio: { integratedLufs: -11, loudnessRange: 4, silenceRatio: 0.0 },
  });
  const stats = distillStats([fast]);
  const dna = editingDnaFromStats(stats);
  const sources = [{ label: 'Creator — Tokyo vlog', url: 'https://example.com/v/1', assetId: 'ast_ref1' }];

  it('规则版：中英说明里的数都来自测量；旋钮含节奏/卡点/开场；可信度说明列出测了什么、没测什么', () => {
    const pack = composeStrategyFromStats({ stats, dna, sources, name: null });
    expect(() => strategyPackSchema.parse({ ...pack, id: 'stp_x' })).not.toThrow();
    expect(pack).toMatchObject({ kind: 'DISTILLED', genre: 'reference', name: { 'zh-CN': '「Creator — Tokyo vlog」的风格', en: 'Style of “Creator — Tokyo vlog”' } });
    expect(pack.summary['zh-CN']).toContain(`每分钟约 ${String(stats.cutsPerMinute)} 次剪切`);
    expect(pack.summary['zh-CN']).toContain('落在音乐节拍上');
    expect(pack.summary.en).toContain(`median shot ${String(stats.shotMedian)} s`);
    expect(pack.knobs.map((knob) => knob.key)).toEqual(['pacing', 'beat_sync', 'opening']);
    expect(pack.source).toMatchObject({ referenceAssetId: 'ast_ref1', referenceUrl: 'https://example.com/v/1' });
    expect(pack.source?.confidenceNote).toContain('Not measured: shot scale');
    expect(pack.source?.confidenceNote).toContain('no model viewed the video');
    const guidance = strategyGuidanceText({ ...pack, id: 'stp_x' }, { pacing: 'as_reference' });
    expect(guidance).toContain(`about ${String(stats.cutsPerMinute)} cuts per minute on average`);
    expect(guidance).toContain('pacing curve');
  });

  it('模型版：用模型写的文字，数值仍是测量值；画面类观察标为模型推断；坏回复明确失败', async () => {
    const base = composeStrategyFromStats({ stats, dna, sources, name: null });
    const reply = {
      name: { 'zh-CN': '东京快剪', en: 'Tokyo quick cuts' },
      summary: { 'zh-CN': '快节奏卡点。', en: 'Fast beat-driven cutting.' },
      structureHints: ['Hook with the busiest moments.'],
      agentGuidance: 'Cut on the beat with short, punchy shots.',
      styleRubric: [{ key: 'beat_sync', criterion: 'Most cuts on the beat.', weight: 2 }],
      captionStyle: 'bold white captions with black outline',
      visualNotes: 'mostly handheld medium shots',
    };
    const model = (text: string): AgentModelAdapter => ({ providerId: 'scripted', implementation: 'SCRIPTED', model: 'claude-opus-5-5', respond: () => Promise.resolve({ model: 'claude-opus-5-5', content: [{ type: 'text', text }], stopReason: 'end_turn', usage: { inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } }) });
    const frame = { mediaType: 'image/jpeg' as const, data: 'AAAA' };
    const result = await composeStrategyWithModel(model(`Here you go:\n${JSON.stringify(reply)}`), { stats, base, sources, frames: [frame], name: null });
    expect(result.pack.name).toEqual(reply.name);
    expect(result.pack.editingDna).toEqual({ ...dna, captionStyle: 'bold white captions with black outline' });
    expect(result.pack.knobs).toEqual(base.knobs);
    expect(result.pack.agentGuidance).toContain('model inference');
    expect(result.pack.source?.confidenceNote).toContain('Descriptions written by claude-opus-5-5');
    expect(result.costMicros).toBe(8000);
    await expect(composeStrategyWithModel(model('I cannot do that.'), { stats, base, sources, frames: [], name: null })).rejects.toMatchObject({ details: { reason: 'STRATEGY_COMPOSE_FAILED' } });
  });
});
