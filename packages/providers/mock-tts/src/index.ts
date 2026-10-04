import type { AlignmentWord, AudioSynthesisAdapter, SynthesizedAudio, SynthesisVoiceRef } from '@ancs/contracts';
import { encodeWavPcm16 } from '@ancs/domain';

/**
 * Mock TTS 适配器（P06-03 / §5.1；同 P03-07/P04-03 的 Mock 范式）。
 *
 * 用途：无真实凭据时确定性重现"带时间戳的语音合成"：
 *   valid（WAV + 词级时间戳）/ no_timestamps（Provider 不返回时间戳 → 触发 AlignmentProvider 路径）/
 *   timeout|error（上游失败）。
 *
 * 输出为**真实 WAV（PCM 单声道 16kHz）**：字节内容由文本确定性派生（每字符一个正弦音高），
 * 时长按语速折算（基准 220 字/分钟 → 与叙事/语音计划的估计口径一致），词级时间戳按字符边界均匀分布
 * （Mock 的"时间戳"是确定性的，真实 Provider 由引擎给出真实时间）。
 */

export const MOCK_TTS_MODES = ['valid', 'no_timestamps', 'timeout', 'error'] as const;
export type MockTtsMode = (typeof MOCK_TTS_MODES)[number];

export interface MockTtsOptions {
  /** 默认模式（未排队时使用） */
  defaultMode?: MockTtsMode;
  /** 基准朗读速度（字符/分钟；默认 220 与 estimateDurationMs 一致） */
  charsPerMinute?: number;
  sampleRate?: number;
}

export class MockTtsAdapter implements AudioSynthesisAdapter {
  readonly kind = 'mock';
  /** 可观测：调用次数与最后一次输入（断言缓存命中/局部重建） */
  callCount = 0;
  lastInput: { text: string; voiceRef: SynthesisVoiceRef; speed: number } | null = null;
  private readonly modes: MockTtsMode[] = [];
  private readonly options: Required<MockTtsOptions>;

  constructor(options: MockTtsOptions = {}) {
    this.options = {
      defaultMode: options.defaultMode ?? 'valid',
      charsPerMinute: options.charsPerMinute ?? 220,
      sampleRate: options.sampleRate ?? 16_000,
    };
  }

  scriptNext(mode: MockTtsMode): this {
    this.modes.push(mode);
    return this;
  }

  async synthesize(input: { text: string; voiceRef: SynthesisVoiceRef; speed: number; styleInstruction: string | null }): Promise<SynthesizedAudio> {
    this.callCount += 1;
    this.lastInput = { text: input.text, voiceRef: input.voiceRef, speed: input.speed };
    const mode = this.modes.shift() ?? this.options.defaultMode;
    if (mode === 'timeout') throw new Error('Mock TTS：上游超时（模拟）');
    if (mode === 'error') throw new Error('Mock TTS：上游 500（模拟）');

    const chars = [...input.text];
    const charsPerSecond = (this.options.charsPerMinute / 60) * Math.max(input.speed, 0.1);
    const durationMs = Math.max(300, Math.round((chars.length / charsPerSecond) * 1000));
    const sampleRate = this.options.sampleRate;
    const totalSamples = Math.round((durationMs / 1000) * sampleRate);
    const samples = new Float32Array(totalSamples);
    // 确定性音频内容：每字符一个音高段（可听辨差异，便于人工检查；内容不承载语义）
    const segmentSamples = Math.max(1, Math.floor(totalSamples / Math.max(chars.length, 1)));
    for (let index = 0; index < chars.length; index += 1) {
      const code = chars[index]?.codePointAt(0) ?? 65;
      const frequency = 180 + (code % 24) * 24;
      for (let sample = 0; sample < segmentSamples; sample += 1) {
        const position = index * segmentSamples + sample;
        if (position >= totalSamples) break;
        samples[position] = 0.22 * Math.sin((2 * Math.PI * frequency * sample) / sampleRate);
      }
    }

    const wordTimestamps: AlignmentWord[] | null =
      mode === 'no_timestamps'
        ? null
        : chars.map((char, index) => {
            const startMs = Math.round((index / charsPerSecond) * 1000);
            const endMs = Math.round(((index + 1) / charsPerSecond) * 1000);
            return { word: char, startMs, endMs: Math.max(endMs, startMs + 1) };
          });

    return {
      bytes: encodeWavPcm16(samples, sampleRate),
      mimeType: 'audio/wav',
      durationMs,
      wordTimestamps,
    };
  }
}
