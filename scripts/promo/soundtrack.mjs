#!/usr/bin/env node
// 宣传片配乐：纯代码合成的原创电子乐（不含采样、不含第三方音乐），与 LaunchTrailer 同一节拍网格。
// 120 BPM、4/4、50 秒 = 25 小节（每拍 0.5 秒 = 15 帧 @30fps）。F 小调 i–VI–III–VII（Fm–D♭–A♭–E♭）。
//
// 结构（与预告片场景对齐）：
//   0–4 s   引子：低频长音 + 渐强噪声上扬 + 打字般的细碎高频
//   4 s     标志落下：重低音冲击 + 混响尾巴；4–8 s 铺底和弦进来、滤波鼓组渐起
//   8 s     主段落：四拍底鼓、二四拍拍手、十六分镲、低音线、和弦切奏（侧链压缩）
//   16–24 s 对话与指点：同一律动，滤波器稍收，加琶音
//   24–32 s 特效：全频段 + 琶音 + 每小节冲击
//   32–40 s 交给 AI：半速过门，四小节上扬
//   40–46 s 快剪：全能量，最后一小节军鼓滚奏
//   46 s    片尾冲击，和弦长尾淡出
//
// 用法：node scripts/promo/soundtrack.mjs --out <file.wav>   （48 kHz / 立体声 / 16 bit；响度归一在合成视频时由 FFmpeg loudnorm 完成）
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { out: { type: 'string' } } });
if (values.out === undefined) throw new Error('usage: soundtrack.mjs --out <file.wav>');

const SR = 48_000;
const BPM = 120;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;
const DURATION = 50;
const N = Math.round(SR * DURATION);
const L = new Float32Array(N);
const R = new Float32Array(N);
const revL = new Float32Array(N); // 混响发送
const revR = new Float32Array(N);
const duck = new Float32Array(N).fill(1); // 侧链（底鼓压低铺底与低音）

// 确定性随机（同一脚本每次生成同一首）
let seed = 0x2f6b1d3;
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const noise = () => rand() * 2 - 1;
const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);
const at = (seconds) => Math.max(0, Math.min(N - 1, Math.round(seconds * SR)));

/** RBJ 双二阶滤波器（逐块更新系数）。 */
function biquad(type) {
  let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
  let b0 = 1; let b1 = 0; let b2 = 0; let a1 = 0; let a2 = 0;
  return {
    set(freq, q = 0.707) {
      const w = 2 * Math.PI * Math.min(freq, SR * 0.45) / SR;
      const cos = Math.cos(w); const alpha = Math.sin(w) / (2 * q);
      let c0; let c1; let c2;
      if (type === 'lp') { c0 = (1 - cos) / 2; c1 = 1 - cos; c2 = (1 - cos) / 2; }
      else if (type === 'hp') { c0 = (1 + cos) / 2; c1 = -(1 + cos); c2 = (1 + cos) / 2; }
      else { c0 = alpha; c1 = 0; c2 = -alpha; }
      const a0 = 1 + alpha;
      b0 = c0 / a0; b1 = c1 / a0; b2 = c2 / a0; a1 = (-2 * cos) / a0; a2 = (1 - alpha) / a0;
    },
    run(x) {
      const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      return y;
    },
  };
}

const add = (i, l, r, send = 0) => { L[i] += l; R[i] += r; if (send > 0) { revL[i] += l * send; revR[i] += r * send; } };

// ---------- 鼓 ----------
function kick(t, gain = 1) {
  const start = at(t);
  let phase = 0;
  for (let k = 0; k < SR * 0.5 && start + k < N; k += 1) {
    const s = k / SR;
    const f = 45 + 110 * Math.exp(-s * 38);
    phase += (2 * Math.PI * f) / SR;
    const env = Math.exp(-s * 7.5);
    const click = k < SR * 0.004 ? noise() * 0.5 * (1 - k / (SR * 0.004)) : 0;
    const v = (Math.tanh(Math.sin(phase) * 2.2) * env + click) * 0.9 * gain;
    add(start + k, v, v);
  }
  // 侧链：底鼓之后 0.25 秒内压低
  for (let k = 0; k < SR * 0.3 && start + k < N; k += 1) duck[start + k] = Math.min(duck[start + k], 0.25 + 0.75 * Math.min(1, k / (SR * 0.22)));
}

function clap(t, gain = 1) {
  const start = at(t);
  const bp = biquad('bp'); bp.set(1400, 0.9);
  for (let k = 0; k < SR * 0.35 && start + k < N; k += 1) {
    const s = k / SR;
    const bursts = s < 0.03 ? Math.exp(-((s % 0.01) * 300)) : Math.exp(-(s - 0.03) * 16); // 三次快速拍击后衰减
    const body = Math.sin(2 * Math.PI * 190 * s) * Math.exp(-s * 40) * 0.4;
    const v = (bp.run(noise()) * 2.2 * bursts + body) * 0.55 * gain;
    add(start + k, v * 0.95, v, 0.35);
  }
}

function hat(t, open = false, gain = 1) {
  const start = at(t);
  const hp = biquad('hp'); hp.set(7500, 0.8);
  const decay = open ? 9 : 55;
  for (let k = 0; k < SR * (open ? 0.3 : 0.08) && start + k < N; k += 1) {
    const s = k / SR;
    const v = hp.run(noise()) * Math.exp(-s * decay) * 0.22 * gain;
    add(start + k, v * (open ? 0.8 : 1), v * (open ? 1 : 0.85), 0.08);
  }
}

function snareRoll(from, to) {
  // 越来越密、越来越响
  let t = from;
  while (t < to) {
    const p = (t - from) / (to - from);
    clap(t, 0.25 + 0.6 * p);
    t += p < 0.5 ? BEAT / 4 : BEAT / 8;
  }
}

// ---------- 音色 ----------
/** 超级锯齿（7 个失谐锯齿）+ 低通，用于铺底与切奏。 */
function supersaw(notes, t, length, { gain = 0.08, cutoff = 2400, attack = 0.02, release = 0.3, sidechain = true, send = 0.3, sweep = null } = {}) {
  const start = at(t);
  const total = Math.round((length + release) * SR);
  const lpL = biquad('lp'); const lpR = biquad('lp');
  const detunes = [-0.11, -0.065, -0.03, 0, 0.03, 0.065, 0.11];
  const phases = notes.map(() => detunes.map(() => rand()));
  for (let k = 0; k < total && start + k < N; k += 1) {
    const s = k / SR;
    if (k % 64 === 0) {
      const c = sweep === null ? cutoff : sweep[0] * (sweep[1] / sweep[0]) ** Math.min(1, s / length);
      lpL.set(c, 0.8); lpR.set(c * 1.03, 0.8);
    }
    const env = Math.min(1, s / attack) * (s < length ? 1 : Math.exp(-(s - length) / (release / 4)));
    let vl = 0; let vr = 0;
    notes.forEach((note, n) => {
      const f = hz(note);
      detunes.forEach((d, j) => {
        const ph = phases[n][j];
        const value = ((ph + (f * (1 + d / 100 * 4)) * s) % 1) * 2 - 1;
        if (j % 2 === 0) vl += value; else vr += value;
        if (j === 3) { vl += value * 0.5; vr += value * 0.5; }
      });
    });
    const i = start + k;
    const sc = sidechain ? duck[i] : 1;
    const l = lpL.run(vl) * gain * env * sc;
    const r = lpR.run(vr) * gain * env * sc;
    add(i, l, r, send);
  }
}

function bass(note, t, length, gain = 0.32) {
  const start = at(t);
  const lp = biquad('lp');
  const f = hz(note);
  for (let k = 0; k < (length + 0.05) * SR && start + k < N; k += 1) {
    const s = k / SR;
    if (k % 64 === 0) lp.set(220 + 900 * Math.exp(-s * 14), 1.1);
    const saw = ((f * s) % 1) * 2 - 1;
    const sub = Math.sin(2 * Math.PI * f * s);
    const env = Math.min(1, s / 0.005) * (s < length ? 1 : Math.max(0, 1 - (s - length) / 0.05));
    const v = (lp.run(saw) * 0.7 + sub * 0.6) * env * gain;
    add(start + k, v, v);
  }
}

function pluck(note, t, gain = 0.09, pan = 0) {
  const start = at(t);
  const lp = biquad('lp');
  const f = hz(note);
  for (let k = 0; k < SR * 0.4 && start + k < N; k += 1) {
    const s = k / SR;
    if (k % 64 === 0) lp.set(400 + 5200 * Math.exp(-s * 18), 2);
    const sq = ((f * s) % 1) < 0.5 ? 1 : -1;
    const v = lp.run(sq) * Math.exp(-s * 9) * gain;
    add(start + k, v * (1 - pan), v * (1 + pan), 0.4);
  }
}

function riser(from, to, gain = 0.5) {
  const start = at(from);
  const length = to - from;
  const bp = biquad('bp');
  let phase = 0;
  for (let k = 0; k < length * SR && start + k < N; k += 1) {
    const s = k / SR;
    const p = s / length;
    if (k % 64 === 0) bp.set(300 * (40 ** p), 1.6);
    phase += (2 * Math.PI * (120 * 2 ** (p * 3))) / SR;
    const tone = (((phase / (2 * Math.PI)) % 1) * 2 - 1) * 0.15;
    const v = (bp.run(noise()) * 1.8 + tone) * p ** 2.2 * gain;
    add(start + k, v * (0.8 + 0.2 * Math.sin(s * 9)), v * (0.8 + 0.2 * Math.cos(s * 9)), 0.4);
  }
}

function impact(t, gain = 1) {
  const start = at(t);
  const lp = biquad('lp');
  let phase = 0;
  for (let k = 0; k < SR * 3 && start + k < N; k += 1) {
    const s = k / SR;
    if (k % 64 === 0) lp.set(200 + 6000 * Math.exp(-s * 6), 0.7);
    phase += (2 * Math.PI * (32 + 60 * Math.exp(-s * 5))) / SR;
    const boom = Math.tanh(Math.sin(phase) * 2.5) * Math.exp(-s * 1.4) * 0.9;
    const crash = lp.run(noise()) * Math.exp(-s * 2.2) * 0.55;
    const v = (boom + crash) * gain;
    add(start + k, v, v, 0.6);
  }
  for (let k = 0; k < SR * 0.6 && start + k < N; k += 1) duck[start + k] = Math.min(duck[start + k], 0.15 + 0.85 * Math.min(1, k / (SR * 0.6)));
}

/** 甩镜呼啸：带通噪声从低扫到高再落下，峰值落在 at（画面甩镜转场的那一刻）。 */
function whoosh(at, length = 0.42, gain = 0.5) {
  const start = at - length * 0.7;
  const s0 = Math.max(0, Math.round(start * SR));
  const bp = biquad('bp');
  for (let k = 0; k < length * SR && s0 + k < N; k += 1) {
    const p = k / (length * SR);
    if (k % 64 === 0) bp.set(300 * 20 ** Math.sin(Math.PI * Math.min(1, p * 1.2)), 1.3);
    const env = Math.sin(Math.PI * p) ** 2;
    const v = bp.run(noise()) * env * gain;
    const pan = p * 2 - 1;
    add(s0 + k, v * (1 - pan * 0.6), v * (1 + pan * 0.6), 0.25);
  }
}

function typing(from, to) {
  // 打字：随机的细小高频点击（跟画面里一句话打出来的节奏一致，约每 70 ms 一个字）
  for (let t = from; t < to; t += 0.055 + rand() * 0.04) {
    const start = at(t);
    const hp = biquad('hp'); hp.set(4000 + rand() * 3000, 1.2);
    for (let k = 0; k < SR * 0.02 && start + k < N; k += 1) {
      const v = hp.run(noise()) * Math.exp(-(k / SR) * 260) * 0.08;
      add(start + k, v, v, 0.15);
    }
  }
}

function drone(from, to, notes, gain = 0.05) {
  const start = at(from);
  const length = to - from;
  for (let k = 0; k < length * SR && start + k < N; k += 1) {
    const s = k / SR;
    const env = Math.min(1, s / 1.5) * Math.min(1, (length - s) / 0.4);
    let v = 0;
    for (const note of notes) v += Math.sin(2 * Math.PI * hz(note) * s + Math.sin(s * 0.7) * 0.6);
    add(start + k, v * gain * env, v * gain * env * 0.97, 0.5);
  }
}

// ---------- 编曲 ----------
const CHORDS = [
  { root: 41, pad: [53, 56, 60, 65], arp: [65, 68, 72, 77] }, // Fm
  { root: 37, pad: [49, 53, 56, 60], arp: [61, 65, 68, 72] }, // D♭maj7
  { root: 44, pad: [56, 60, 63, 67], arp: [68, 72, 75, 79] }, // A♭maj7
  { root: 39, pad: [51, 55, 58, 63], arp: [63, 67, 70, 75] }, // E♭
];
const chordAt = (bar) => CHORDS[bar % 4];
const barTime = (bar) => bar * BAR;

// 引子 0–4 s（第 0–1 小节）
drone(0, 4.6, [29, 41, 48], 0.06);
typing(0.6, 3.4);
riser(1.0, 4.0, 0.55);
for (let b = 4; b < 8; b += 1) hat(b * BEAT, false, 0.35 + b * 0.05);

// 4 s：标志落下（标志描出时一串高音钟声）
impact(4.0, 1.0);
kick(4.0, 1.1);
[77, 80, 84, 89, 92].forEach((note, i) => pluck(note, 4.18 + i * 0.09, 0.07, i % 2 === 0 ? -0.3 : 0.3));
// 4–8 s（第 2–3 小节）：铺底 + 渐起的滤波鼓组
for (let bar = 2; bar < 4; bar += 1) {
  supersaw(chordAt(bar).pad, barTime(bar), BAR, { gain: 0.05, sweep: bar === 2 ? [400, 1200] : [1200, 3600], attack: 0.3, send: 0.45 });
  for (let beat = 0; beat < 4; beat += 1) {
    const t = barTime(bar) + beat * BEAT;
    if (bar === 3) kick(t, 0.55);
    hat(t + BEAT / 2, false, 0.6);
  }
}
riser(6.0, 8.0, 0.6);
snareRoll(7.0, 8.0);

// 主段落：8–40 s（第 4–19 小节），40–46 s（第 20–22 小节）
const groove = (bar, { energy = 1, arp = false, stabs = true, filter = 5200 } = {}) => {
  const t0 = barTime(bar);
  const chord = chordAt(bar);
  for (let beat = 0; beat < 4; beat += 1) {
    const t = t0 + beat * BEAT;
    kick(t, 0.95 * energy);
    if (beat % 2 === 1) clap(t, 0.85 * energy);
    for (let s = 0; s < 4; s += 1) hat(t + (s * BEAT) / 4, s === 2, (s % 2 === 0 ? 0.55 : 0.9) * energy);
    // 低音：八分音符，反拍
    bass(chord.root + (beat === 3 ? 12 : 0), t + BEAT / 2, BEAT / 2 - 0.02, 0.3 * energy);
    bass(chord.root, t, BEAT / 2 - 0.04, 0.22 * energy);
  }
  supersaw(chord.pad, t0, BAR, { gain: 0.045 * energy, cutoff: filter * 0.6, attack: 0.05, send: 0.35 });
  if (stabs) for (const offset of [0, 1.5, 2.5]) supersaw(chord.arp, t0 + offset * BEAT, BEAT * 0.35, { gain: 0.035 * energy, cutoff: filter, release: 0.12, send: 0.25 });
  if (arp) for (let s = 0; s < 16; s += 1) pluck(chord.arp[(s * 3) % 4] + (s % 8 === 7 ? 12 : 0), t0 + (s * BEAT) / 4, 0.07 * energy, s % 2 === 0 ? -0.4 : 0.4);
};

impact(8.0, 0.9);
// 8–11 s：四个大字之间的甩镜转场
for (const at of [9.0, 10.0, 11.0, 12.0]) whoosh(at, 0.42, 0.45);
for (let bar = 4; bar < 8; bar += 1) groove(bar, { energy: 1, stabs: true });        // 8–16 s  SAY IT / POINT / CUT / KEEP
for (let bar = 8; bar < 12; bar += 1) groove(bar, { energy: 0.85, arp: true, filter: 3000 }); // 16–24 s 对话与指点
impact(24.0, 0.7);
for (let bar = 12; bar < 16; bar += 1) { groove(bar, { energy: 1, arp: true, filter: 6500 }); if (bar % 2 === 0) impact(barTime(bar) + 2 * BEAT, 0.35); } // 24–32 s 特效
// 32–40 s：半速过门（第 16–19 小节）+ 上扬
for (let bar = 16; bar < 20; bar += 1) {
  const t0 = barTime(bar);
  const chord = chordAt(bar);
  kick(t0, 0.8); kick(t0 + 2.5 * BEAT, 0.6);
  clap(t0 + 2 * BEAT, 0.8);
  for (let s = 0; s < 8; s += 1) hat(t0 + (s * BEAT) / 2, false, 0.5);
  supersaw(chord.pad, t0, BAR, { gain: 0.055, sweep: [900 + (bar - 16) * 600, 1500 + (bar - 16) * 1500], attack: 0.08, send: 0.5 });
  bass(chord.root, t0, BEAT * 1.5, 0.3); bass(chord.root, t0 + 2.5 * BEAT, BEAT, 0.26);
  for (let s = 0; s < 8; s += 1) pluck(chord.arp[s % 4], t0 + (s * BEAT) / 2, 0.06, s % 2 === 0 ? -0.5 : 0.5);
}
riser(36.0, 40.0, 0.7);
snareRoll(38.0, 40.0);
// 40–46 s：快剪全能量（第 20–22 小节）
impact(40.0, 1.0);
for (let bar = 20; bar < 23; bar += 1) groove(bar, { energy: 1.05, arp: true, filter: 7000 });
snareRoll(45.0, 46.0);
// 46 s：片尾
impact(46.0, 1.1);
kick(46.0, 1.1);
supersaw(CHORDS[0].pad.concat([77]), 46.0, 2.6, { gain: 0.05, cutoff: 2600, attack: 0.02, release: 1.4, sidechain: false, send: 0.7 });
drone(46.0, 50.0, [29, 41], 0.05);

// ---------- 混响（Freeverb 简化版：8 梳状 + 4 全通）----------
function reverb(input, spread) {
  const combs = [1557, 1617, 1491, 1422, 1277, 1356, 1188, 1116].map((n) => ({ buf: new Float32Array(n + spread), i: 0, store: 0 }));
  const alls = [556, 441, 341, 225].map((n) => ({ buf: new Float32Array(n + spread), i: 0 }));
  const outBuf = new Float32Array(N);
  const feedback = 0.84; const damp = 0.3;
  for (let k = 0; k < N; k += 1) {
    const x = input[k] * 0.015;
    let y = 0;
    for (const c of combs) {
      const o = c.buf[c.i];
      c.store = o * (1 - damp) + c.store * damp;
      c.buf[c.i] = x + c.store * feedback;
      c.i = (c.i + 1) % c.buf.length;
      y += o;
    }
    for (const a of alls) {
      const o = a.buf[a.i];
      a.buf[a.i] = y + o * 0.5;
      a.i = (a.i + 1) % a.buf.length;
      y = o - y;
    }
    outBuf[k] = y;
  }
  return outBuf;
}
const wetL = reverb(revL, 0);
const wetR = reverb(revR, 23);

// ---------- 母带：混响混回、软削波、首尾淡入淡出 ----------
const pcm = Buffer.alloc(N * 4);
let peak = 0;
for (let k = 0; k < N; k += 1) {
  const fade = Math.min(1, k / (SR * 0.05)) * Math.min(1, (N - k) / (SR * 1.2));
  const l = Math.tanh((L[k] + wetL[k] * 0.9) * 0.9) * fade;
  const r = Math.tanh((R[k] + wetR[k] * 0.9) * 0.9) * fade;
  peak = Math.max(peak, Math.abs(l), Math.abs(r));
  pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, l * 0.98)) * 32767), k * 4);
  pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, r * 0.98)) * 32767), k * 4 + 2);
}
const header = Buffer.alloc(44);
header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
header.writeUInt32LE(SR, 24); header.writeUInt32LE(SR * 4, 28); header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34);
header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
await writeFile(values.out, Buffer.concat([header, pcm]));
console.log(JSON.stringify({ out: values.out, seconds: DURATION, bpm: BPM, peak: Number(peak.toFixed(3)) }));
