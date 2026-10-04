import { describe, expect, it } from 'vitest';
import { buildAlignment, concatWavSegments, segmentCacheKey } from './alignment.js';
import { encodeWavPcm16, parseWavPcm16 } from './wav.js';

/**
 * P06-03 单元验收（纯函数部分）：
 * - WAV 编解码往返；拼接保持采样率/声道并累加数据长度；不一致格式 → null（不产出坏音频）；
 * - 全局对齐按**绝对时间轴**累加（段连续、无缝隙）；cues 与段一致；
 * - 缓存键对 内容/声音/语速/风格 的任一变化敏感（改一句话 → 仅该段失效）。
 */

const tone = (samples: number, frequency = 440, sampleRate = 16_000): Uint8Array => {
  const data = new Float32Array(samples);
  for (let index = 0; index < samples; index += 1) data[index] = 0.3 * Math.sin((2 * Math.PI * frequency * index) / sampleRate);
  return encodeWavPcm16(data, sampleRate);
};

describe('WAV 编解码与拼接', () => {
  it('编解码往返：采样率/声道/数据长度一致', () => {
    const wav = tone(1600);
    const parsed = parseWavPcm16(wav);
    expect(parsed).toMatchObject({ sampleRate: 16_000, channels: 1, dataLength: 3200 });
    expect(wav.length).toBe(44 + 3200);
  });

  it('拼接：头部正确、总长度 = 44 + Σdata；拼接结果可解析', () => {
    const merged = concatWavSegments([tone(800), tone(400)], parseWavPcm16);
    expect(merged).not.toBeNull();
    if (merged === null) return;
    const parsed = parseWavPcm16(merged);
    expect(parsed).toMatchObject({ sampleRate: 16_000, channels: 1, dataLength: 800 * 2 + 400 * 2 });
    expect(merged.length).toBe(44 + 800 * 2 + 400 * 2);
  });

  it('不一致格式（采样率不同）→ null（明确拒绝，不产出坏音频）；非 WAV → null', () => {
    expect(concatWavSegments([tone(100, 440, 16_000), tone(100, 440, 44_100)], parseWavPcm16)).toBeNull();
    expect(concatWavSegments([new Uint8Array([1, 2, 3])], parseWavPcm16)).toBeNull();
    expect(concatWavSegments([], parseWavPcm16)).toBeNull();
  });
});

describe('buildAlignment（绝对时间轴 + cues）', () => {
  it('段连续无缝隙；cues 与段一致；总时长 = 各段之和', () => {
    const result = buildAlignment([
      { narrationBlockId: 'nbr_1', text: '第一句。', durationMs: 1000, words: [{ word: '第', startMs: 0, endMs: 10 }], cacheKey: 'k1', reused: false },
      { narrationBlockId: 'nbr_2', text: '第二句。', durationMs: 1500, words: [], cacheKey: 'k2', reused: true },
    ]);
    expect(result.totalDurationMs).toBe(2500);
    expect(result.alignment.map((segment) => [segment.startMs, segment.durationMs, segment.endMs])).toEqual([
      [0, 1000, 1000],
      [1000, 1500, 2500],
    ]);
    expect(result.cues).toEqual([
      { narrationBlockId: 'nbr_1', startMs: 0, durationMs: 1000 },
      { narrationBlockId: 'nbr_2', startMs: 1000, durationMs: 1500 },
    ]);
    expect(result.alignment[1]?.reused).toBe(true);
  });

  it('零/负时长段被规整为至少 1ms（时间轴不倒退）', () => {
    const result = buildAlignment([{ narrationBlockId: 'nbr_1', text: 'x', durationMs: 0, words: [], cacheKey: 'k', reused: false }]);
    expect(result.alignment[0]?.durationMs).toBe(1);
    expect(result.totalDurationMs).toBe(1);
  });
});

describe('segmentCacheKey（局部重建的失效边界）', () => {
  const base = { text: '联邦基金利率维持在 5.25%。', speed: 1.05, styleInstruction: '稳定', voiceKey: 'voi_1@zh-CN' };

  it('同输入 → 同键（可复用）', () => {
    expect(segmentCacheKey(base)).toBe(segmentCacheKey({ ...base }));
  });

  it('文本/语速/风格/声音任一变化 → 键变化（该段必须重新合成）', () => {
    expect(segmentCacheKey({ ...base, text: '改一句话。' })).not.toBe(segmentCacheKey(base));
    expect(segmentCacheKey({ ...base, speed: 1.5 })).not.toBe(segmentCacheKey(base));
    expect(segmentCacheKey({ ...base, styleInstruction: '高能量' })).not.toBe(segmentCacheKey(base));
    expect(segmentCacheKey({ ...base, voiceKey: 'voi_2@zh-CN' })).not.toBe(segmentCacheKey(base));
  });
});
