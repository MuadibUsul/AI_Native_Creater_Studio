/**
 * AI 语音回应的播放（Issue #9）：网关边合成边下发的 PCM16 小端单声道块 → Web Audio 首尾相接地排队播放。
 *
 * - `begin` 开始一轮（只认这一轮之后到的音频块）；`push` 追加；`end` 表示这一轮不会再有新块，播完即回到空闲；
 * - `stop` 立刻静音并丢弃所有已排队、未播完的块（打断 / 停止说话），之后到的旧块一律丢掉，直到下一次 `begin`；
 * - 状态只有三种：idle（没在说）/ preparing（等第一块）/ playing（正在出声），供界面区分"AI 思考中"与"AI 正在说"。
 */

export type ReplyPlaybackState = 'idle' | 'preparing' | 'playing';

/** 第一块的起播余量（秒）：给解码和调度留出时间，避免开头爆音 */
const START_LEAD_SECONDS = 0.06;

export function pcm16ToFloat32(bytes: ArrayBuffer): Float32Array<ArrayBuffer> {
  const view = new DataView(bytes);
  const samples = new Float32Array(Math.floor(bytes.byteLength / 2));
  for (let index = 0; index < samples.length; index += 1) samples[index] = view.getInt16(index * 2, true) / 32768;
  return samples;
}

export class ReplyPlayer {
  private turn: { id: string; sampleRate: number; ended: boolean } | null = null;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private nextAt = 0;
  private state: ReplyPlaybackState = 'idle';

  constructor(
    private readonly context: () => AudioContext | null,
    private readonly onState: (state: ReplyPlaybackState, turnId: string | null) => void,
  ) {}

  get current(): string | null { return this.turn?.id ?? null; }

  begin(turnId: string, sampleRate: number): void {
    this.stop();
    this.turn = { id: turnId, sampleRate, ended: false };
    this.set('preparing');
  }

  push(bytes: ArrayBuffer): void {
    const turn = this.turn;
    const context = this.context();
    if (turn === null || context === null || bytes.byteLength < 2) return;
    const samples = pcm16ToFloat32(bytes);
    const buffer = context.createBuffer(1, samples.length, turn.sampleRate);
    buffer.copyToChannel(samples, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const startAt = Math.max(this.nextAt, context.currentTime + (this.sources.size === 0 ? START_LEAD_SECONDS : 0.01));
    source.start(startAt);
    this.nextAt = startAt + buffer.duration;
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      source.disconnect();
      if (this.sources.size === 0 && this.turn === turn && turn.ended) this.finish();
    };
    if (this.state !== 'playing') this.set('playing');
  }

  /** 这一轮的音频发完了（或网关报失败）：已排队的播完再回到空闲 */
  end(turnId: string): void {
    if (this.turn === null || this.turn.id !== turnId) return;
    this.turn.ended = true;
    if (this.sources.size === 0) this.finish();
  }

  /** 立刻静音并丢弃未播放的音频 */
  stop(): void {
    for (const source of this.sources) {
      source.onended = null;
      try { source.stop(); } catch { /* 还没开始播的块：stop 可能抛错，丢弃即可 */ }
      source.disconnect();
    }
    this.sources.clear();
    this.nextAt = 0;
    const wasActive = this.turn !== null;
    this.turn = null;
    if (wasActive || this.state !== 'idle') this.set('idle');
  }

  private finish(): void {
    this.turn = null;
    this.nextAt = 0;
    this.set('idle');
  }

  private set(state: ReplyPlaybackState): void {
    this.state = state;
    this.onState(state, this.turn?.id ?? null);
  }
}
