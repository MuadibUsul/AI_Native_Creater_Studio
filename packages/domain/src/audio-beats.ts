/**
 * 音乐节拍检测（V6-6 蒸馏器用；纯函数，无 I/O）。
 *
 * 方法：短时傅里叶变换的对数幅度谱通量作为起音包络 → 去局部均值 → 在 60–200 BPM 的滞后范围内做自相关
 * （以 120 BPM 为中心的对数高斯先验，减少倍频/半频错误）→ 取全局最佳相位，沿网格在 ±10% 周期内对齐到包络峰值。
 * 置信度 = 自相关峰相对于滞后范围内平均值的突出程度（0–1）；规律节拍弱（说话、环境声）时置信度低，调用方据此判断"没有音乐节拍"。
 */

export interface DetectedBeats {
  bpm: number;
  confidence: number;
  /** 节拍时刻（秒） */
  times: number[];
}

const WINDOW = 1024;
const HOP = 256;
const ONSET_LATENCY_SECONDS = 0.02;

/** 原地迭代基 2 FFT（re/im 长度为 2 的幂）。 */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = (-2 * Math.PI) / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k += 1) {
        const angle = step * k;
        const wr = Math.cos(angle);
        const wi = Math.sin(angle);
        const a = start + k;
        const b = a + half;
        const tr = re[b]! * wr - im[b]! * wi;
        const ti = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
      }
    }
  }
}

/** 起音包络：对数幅度谱的正向通量（每帧一个值，帧间隔 HOP/sampleRate 秒）。 */
export function onsetEnvelope(samples: Float32Array, sampleRate: number): Float64Array {
  const frames = Math.max(0, Math.floor((samples.length - WINDOW) / HOP) + 1);
  const envelope = new Float64Array(frames);
  const window = new Float64Array(WINDOW);
  for (let i = 0; i < WINDOW; i += 1) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WINDOW - 1));
  let previous = new Float64Array(WINDOW / 2);
  const re = new Float64Array(WINDOW);
  const im = new Float64Array(WINDOW);
  // 只看 30 Hz – 5 kHz：去掉直流与高频嘶声
  const low = Math.max(1, Math.floor((30 * WINDOW) / sampleRate));
  const high = Math.min(WINDOW / 2, Math.ceil((5000 * WINDOW) / sampleRate));
  for (let frame = 0; frame < frames; frame += 1) {
    const offset = frame * HOP;
    for (let i = 0; i < WINDOW; i += 1) { re[i] = (samples[offset + i] ?? 0) * window[i]!; im[i] = 0; }
    fft(re, im);
    const current = new Float64Array(WINDOW / 2);
    let flux = 0;
    for (let bin = low; bin < high; bin += 1) {
      const magnitude = Math.log1p(100 * Math.hypot(re[bin]!, im[bin]!));
      current[bin] = magnitude;
      const rise = magnitude - previous[bin]!;
      if (rise > 0) flux += rise;
    }
    envelope[frame] = frame === 0 ? 0 : flux;
    previous = current;
  }
  // 去局部均值（约 0.5 秒窗）并半波整流：只留下"突然变响"的部分
  const radius = Math.max(1, Math.round((0.25 * sampleRate) / HOP));
  const out = new Float64Array(frames);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < Math.min(frames, radius); i += 1) { sum += envelope[i]!; count += 1; }
  for (let i = 0; i < frames; i += 1) {
    const enter = i + radius;
    if (enter < frames) { sum += envelope[enter]!; count += 1; }
    const leave = i - radius - 1;
    if (leave >= 0) { sum -= envelope[leave]!; count -= 1; }
    out[i] = Math.max(0, envelope[i]! - sum / count);
  }
  return out;
}

function gaussianSmooth(values: Float64Array, sigma: number): Float64Array {
  const radius = Math.ceil(sigma * 3);
  const kernel: number[] = [];
  for (let i = -radius; i <= radius; i += 1) kernel.push(Math.exp(-0.5 * (i / sigma) ** 2));
  const total = kernel.reduce((sum, value) => sum + value, 0);
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i += 1) {
    let sum = 0;
    for (let k = -radius; k <= radius; k += 1) sum += (values[Math.min(values.length - 1, Math.max(0, i + k))] ?? 0) * kernel[k + radius]!;
    out[i] = sum / total;
  }
  return out;
}

export function detectBeats(samples: Float32Array, sampleRate: number, options: { minBpm?: number; maxBpm?: number } = {}): DetectedBeats | null {
  const envelope = onsetEnvelope(samples, sampleRate);
  const framesPerSecond = sampleRate / HOP;
  if (envelope.length < framesPerSecond * 4) return null; // 少于 4 秒不判断
  // 轻微平滑（高斯 σ≈1.5 帧）：非整数周期时，尖峰不至于在整数滞后上错开而偏向倍周期
  const smoothed = gaussianSmooth(envelope, 1.5);
  const minBpm = options.minBpm ?? 60;
  const maxBpm = options.maxBpm ?? 200;
  const minLag = Math.floor((60 / maxBpm) * framesPerSecond);
  const maxLag = Math.ceil((60 / minBpm) * framesPerSecond);
  const mean = smoothed.reduce((total, value) => total + value, 0) / smoothed.length;
  const centered = smoothed.map((value) => value - mean);
  const acf = (lag: number): number => {
    let total = 0;
    for (let i = lag; i < centered.length; i += 1) total += centered[i]! * centered[i - lag]!;
    return total / (centered.length - lag);
  };
  const zero = acf(0);
  if (!(zero > 0)) return null;
  const values: number[] = [];
  for (let lag = minLag; lag <= maxLag; lag += 1) values.push(acf(lag));
  let best = -Infinity;
  let bestLag = minLag;
  for (let index = 0; index < values.length; index += 1) {
    const lag = minLag + index;
    const bpm = (60 * framesPerSecond) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 1) ** 2);
    const score = values[index]! * prior;
    if (score > best) { best = score; bestLag = lag; }
  }
  // 半周期处同样强（八分音符同样密）→ 取两倍速度：避免把快歌判成半速
  const halfLag = Math.round(bestLag / 2);
  if (halfLag >= minLag && values[halfLag - minLag]! > 0.7 * values[bestLag - minLag]!) bestLag = halfLag;
  // 抛物线插值细化周期
  const at = bestLag - minLag;
  const left = values[at - 1];
  const right = values[at + 1];
  const peak = values[at]!;
  const delta = left !== undefined && right !== undefined && left - 2 * peak + right !== 0 ? (0.5 * (left - right)) / (left - 2 * peak + right) : 0;
  const period = bestLag + Math.max(-0.5, Math.min(0.5, delta));
  // 置信度：周期处的归一化自相关（规律节拍接近 1，噪声/说话接近 0）
  const confidence = Math.max(0, Math.min(1, peak / zero));

  // 全局最佳相位
  let bestPhase = 0;
  let bestPhaseScore = -Infinity;
  for (let phase = 0; phase < Math.round(period); phase += 1) {
    let score = 0;
    for (let position = phase; position < smoothed.length; position += period) score += smoothed[Math.round(position)] ?? 0;
    if (score > bestPhaseScore) { bestPhaseScore = score; bestPhase = phase; }
  }
  // 沿网格对齐到 ±10% 周期内的包络峰值（跟随轻微的速度漂移）
  const times: number[] = [];
  const slack = Math.max(1, Math.round(period * 0.1));
  for (let expected = bestPhase; expected < envelope.length; expected += period) {
    const center = Math.round(expected);
    let peakIndex = center;
    for (let i = Math.max(0, center - slack); i <= Math.min(envelope.length - 1, center + slack); i += 1) {
      if (envelope[i]! > envelope[peakIndex]!) peakIndex = i;
    }
    // 帧中心时刻（窗口中点）+ 固定延迟补偿（用合成打击音标定：通量峰比起音早约 0.02 秒）
    times.push(Math.round(((peakIndex * HOP + WINDOW / 2) / sampleRate + ONSET_LATENCY_SECONDS) * 1000) / 1000);
  }
  return { bpm: Math.round(((60 * framesPerSecond) / period) * 10) / 10, confidence: Math.round(confidence * 1000) / 1000, times };
}
