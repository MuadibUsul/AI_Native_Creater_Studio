/* global AudioWorkletProcessor, sampleRate, registerProcessor -- AudioWorkletGlobalScope 提供 */
// V6-2 麦克风采集（AudioWorklet，音频线程）：把设备采样率重采样为 16 kHz 单声道 PCM16，每 20 ms 发一块给主线程。
// 只做重采样与格式转换（不在音频线程做识别或推理）；采样数就是语音的"音频时钟"。
const TARGET_RATE = 16000;
const CHUNK = 320; // 20 ms

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE;
    this.position = 0; // 下一个输出样本在本块输入中的位置（可为 [-1, 0)：落在上一块的最后一个样本与本块之间）
    this.last = 0;
    this.chunk = new Int16Array(CHUNK);
    this.filled = 0;
    this.energy = 0;
  }

  push(value) {
    const clamped = Math.max(-1, Math.min(1, value));
    this.chunk[this.filled] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    this.energy += clamped * clamped;
    this.filled += 1;
    if (this.filled === CHUNK) {
      const level = Math.sqrt(this.energy / CHUNK);
      this.port.postMessage({ pcm: this.chunk.buffer, level }, [this.chunk.buffer]);
      this.chunk = new Int16Array(CHUNK);
      this.filled = 0;
      this.energy = 0;
    }
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel || channel.length === 0) return true;
    let t = this.position;
    while (t < channel.length - 1) {
      const index = Math.floor(t);
      const fraction = t - index;
      const from = index < 0 ? this.last : channel[index];
      const to = channel[index + 1];
      this.push(from + (to - from) * fraction);
      t += this.ratio;
    }
    this.position = t - channel.length;
    this.last = channel[channel.length - 1];
    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
