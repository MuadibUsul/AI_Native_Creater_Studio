import * as React from 'react';
import { AbsoluteFill, interpolate, random, useCurrentFrame, useVideoConfig } from 'remotion';

/**
 * 宣传片用的原创"素材"：四段程序生成的冰岛风光（极光、海岸日落、公路、瀑布）。
 * 全部由代码绘制（SVG 渐变 + 分形山脊 + 粒子），不含任何第三方素材或生成模型输出；
 * 既在真实产品界面里当作用户上传的素材，也在宣传片里直接作为画面。尺寸跟随合成（1280×720 或 1920×1080）。
 */

/** 山脊线：若干正弦的"脊形"叠加（1 − |sin|），得到尖峰。返回 SVG path（闭合到底部）。 */
export function ridgePath(input: { width: number; height: number; base: number; amp: number; seed: string; shift: number; octaves?: number; steps?: number }): string {
  const steps = input.steps ?? 96;
  const octaves = input.octaves ?? 4;
  const points: string[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const x = (i / steps) * input.width;
    const u = i / steps + input.shift;
    let value = 0;
    let weight = 1;
    let total = 0;
    for (let o = 0; o < octaves; o += 1) {
      const freq = 1.6 * 2 ** o;
      const phase = random(`${input.seed}:p${String(o)}`) * Math.PI * 2;
      value += (1 - Math.abs(Math.sin(u * freq * Math.PI + phase))) * weight;
      total += weight;
      weight *= 0.5;
    }
    const y = input.base - (value / total) * input.amp;
    points.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return `${points.join(' ')} L${input.width},${input.height} L0,${input.height} Z`;
}

/** 胶片颗粒（每帧换种子）+ 暗角：让矢量画面有"拍出来"的质感。 */
export const FilmFinish: React.FC<{ grain?: number; vignette?: number }> = ({ grain = 0.07, vignette = 0.55 }) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0, opacity: grain, mixBlendMode: 'overlay' }}>
        <filter id={`grain-${String(frame % 8)}`}>
          <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves={2} seed={frame % 8} stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter={`url(#grain-${String(frame % 8)})`} />
      </svg>
      <AbsoluteFill style={{ background: `radial-gradient(ellipse at 50% 50%, rgba(0,0,0,0) 55%, rgba(0,0,0,${String(vignette)}) 100%)` }} />
    </AbsoluteFill>
  );
};

const useLayout = () => {
  const frame = useCurrentFrame();
  const { width, height, durationInFrames } = useVideoConfig();
  const k = width / 1920;
  return { frame, W: width, H: height, k, t: frame / Math.max(1, durationInFrames - 1) };
};

/** 极光：夜空、闪烁的星、三条摆动的极光帘、三层雪山。 */
export const AuroraScene: React.FC = () => {
  const { frame, W, H, k, t } = useLayout();
  const push = interpolate(t, [0, 1], [1.02, 1.1]);
  const stars = Array.from({ length: 170 }, (_, i) => {
    const twinkle = 0.45 + 0.55 * Math.abs(Math.sin(frame * 0.06 + random(`st${String(i)}`) * 9));
    return <circle key={i} cx={random(`sx${String(i)}`) * W} cy={random(`sy${String(i)}`) * H * 0.62} r={(0.6 + random(`sr${String(i)}`) * 1.7) * k} fill="#e9f2ff" opacity={twinkle * (0.35 + random(`so${String(i)}`) * 0.65)} />;
  });
  const ribbon = (index: number, colors: [string, string]) => {
    const points: string[] = [];
    const bottoms: string[] = [];
    for (let i = 0; i <= 64; i += 1) {
      const u = i / 64;
      const x = -0.1 * W + u * 1.2 * W;
      const y = H * (0.2 + index * 0.07) + Math.sin(u * Math.PI * 2 * 1.2 + frame * 0.018 + index * 1.7) * H * 0.07 + Math.sin(u * Math.PI * 2 * 3.3 - frame * 0.011) * H * 0.022;
      points.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${(y - H * (0.22 - index * 0.03)).toFixed(1)}`);
      bottoms.unshift(`L${x.toFixed(1)},${y.toFixed(1)}`);
    }
    const id = `aur${String(index)}`;
    const rays = Array.from({ length: 46 }, (_, r) => {
      const u = random(`ray${String(index)}:${String(r)}`);
      const x = -0.1 * W + u * 1.2 * W;
      const y = H * (0.2 + index * 0.07) + Math.sin(u * Math.PI * 2 * 1.2 + frame * 0.018 + index * 1.7) * H * 0.07 + Math.sin(u * Math.PI * 2 * 3.3 - frame * 0.011) * H * 0.022;
      const flicker = 0.25 + 0.75 * Math.abs(Math.sin(frame * 0.07 + r * 1.9 + index));
      return <rect key={r} x={x} y={y - H * 0.26} width={(3 + random(`rw${String(index)}:${String(r)}`) * 9) * k} height={H * 0.27} fill={`url(#${id})`} opacity={0.5 * flicker} />;
    });
    return (
      <g key={index} style={{ mixBlendMode: 'screen' }} filter={`url(#blur-a${String(index)})`}>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={colors[1]} stopOpacity="0" />
            <stop offset="0.55" stopColor={colors[1]} stopOpacity="0.45" />
            <stop offset="1" stopColor={colors[0]} stopOpacity="0.95" />
          </linearGradient>
          <filter id={`blur-a${String(index)}`} x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation={18 * k} /></filter>
        </defs>
        <path d={`${points.join(' ')} ${bottoms.join(' ')} Z`} fill={`url(#${id})`} opacity={0.75 + 0.25 * Math.sin(frame * 0.05 + index)} />
        {rays}
      </g>
    );
  };
  const layers = [
    { base: 0.68, amp: 0.26, seed: 'far', top: '#c9dcf2', bottom: '#16233c', shift: frame * 0.0004 },
    { base: 0.8, amp: 0.2, seed: 'mid', top: '#5c7396', bottom: '#0b1424', shift: frame * 0.0009 + 0.3 },
    { base: 0.95, amp: 0.18, seed: 'near', top: '#141d2c', bottom: '#03060b', shift: frame * 0.0016 + 0.7 },
  ];
  return (
    <AbsoluteFill style={{ background: 'linear-gradient(180deg, #01040c 0%, #061327 45%, #0d2338 72%, #10283a 100%)', overflow: 'hidden' }}>
      <AbsoluteFill style={{ transform: `scale(${String(push)})` }}>
        <svg width={W} height={H} viewBox={`0 0 ${String(W)} ${String(H)}`}>
          {stars}
          {ribbon(0, ['#3dffb2', '#21c9a0'])}
          {ribbon(1, ['#6fffd0', '#7a5cff'])}
          {ribbon(2, ['#b46cff', '#3aa0ff'])}
          {layers.map((layer) => (
            <g key={layer.seed}>
              <defs>
                <linearGradient id={`m-${layer.seed}`} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2={H}>
                  <stop offset={String(layer.base - layer.amp * 0.75)} stopColor={layer.top} />
                  <stop offset={String(layer.base - layer.amp * 0.2)} stopColor={layer.bottom} />
                  <stop offset="1" stopColor={layer.bottom} />
                </linearGradient>
              </defs>
              <path d={ridgePath({ width: W, height: H, base: H * layer.base, amp: H * layer.amp, seed: layer.seed, shift: layer.shift })} fill={`url(#m-${layer.seed})`} />
            </g>
          ))}
          <ellipse cx={W * 0.5} cy={H * 0.95} rx={W * 0.7} ry={H * 0.08} fill="#9fd9ff" opacity={0.08} filter="url(#blur-a0)" />
        </svg>
      </AbsoluteFill>
      <FilmFinish />
    </AbsoluteFill>
  );
};

/** 海岸日落：渐变天空、低垂的太阳、海面反光柱、波纹与海蚀柱剪影、飞鸟。 */
export const CoastScene: React.FC = () => {
  const { frame, W, H, k, t } = useLayout();
  const horizon = H * 0.62;
  const sunY = horizon - H * 0.035 + t * H * 0.03;
  const drift = interpolate(t, [0, 1], [0, -W * 0.03]);
  const shimmer = Array.from({ length: 90 }, (_, i) => {
    const row = random(`ry${String(i)}`);
    const y = horizon + 6 * k + row ** 1.6 * (H - horizon);
    const width = (20 + random(`rw${String(i)}`) * 120) * (0.4 + row) * k;
    const x = W * 0.62 + (random(`rx${String(i)}`) - 0.5) * (60 + row * 360) * k + Math.sin(frame * 0.15 + i) * 6 * k;
    const opacity = (0.25 + 0.75 * Math.abs(Math.sin(frame * 0.09 + random(`rp${String(i)}`) * 7))) * (1 - row * 0.6);
    return <rect key={i} x={x - width / 2} y={y} width={width} height={(1.5 + row * 3) * k} rx={k} fill="#ffd3a0" opacity={opacity} />;
  });
  const waves = Array.from({ length: 9 }, (_, i) => {
    const y0 = horizon + (H - horizon) * ((i + 1) / 10) ** 1.5;
    const points: string[] = [];
    for (let s = 0; s <= 48; s += 1) {
      const x = (s / 48) * W;
      const y = y0 + Math.sin(s * 0.7 + frame * 0.06 * (1 + i * 0.15) + i) * (2 + i) * k;
      points.push(`${s === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`);
    }
    return <path key={i} d={points.join(' ')} stroke="#ffb98f" strokeOpacity={0.12 + i * 0.015} strokeWidth={(1 + i * 0.25) * k} fill="none" />;
  });
  const stack = (x: number, w: number, h: number, seed: string) => {
    const pts: string[] = [`M${String(x)},${String(horizon + 8 * k)}`];
    const n = 7;
    for (let i = 0; i <= n; i += 1) {
      const u = i / n;
      const px = x + u * w;
      const py = horizon - h * (1 - Math.abs(u - 0.5) * 1.6) * (0.7 + random(`${seed}${String(i)}`) * 0.3);
      pts.push(`L${px.toFixed(1)},${Math.min(horizon, py).toFixed(1)}`);
    }
    pts.push(`L${String(x + w)},${String(horizon + 8 * k)} Z`);
    return <path d={pts.join(' ')} fill="#150a20" />;
  };
  const birds = Array.from({ length: 6 }, (_, i) => {
    const x = (W * (0.15 + i * 0.07) + frame * (1.6 + i * 0.2) * k) % (W * 1.1);
    const y = H * (0.3 + random(`by${String(i)}`) * 0.12) + Math.sin(frame * 0.1 + i) * 4 * k;
    const flap = Math.sin(frame * 0.5 + i * 2) * 4 * k;
    const s = 9 * k;
    return <path key={i} d={`M${String(x - s)},${String(y - flap)} Q${String(x - s / 2)},${String(y - s / 2)} ${String(x)},${String(y)} Q${String(x + s / 2)},${String(y - s / 2)} ${String(x + s)},${String(y - flap)}`} stroke="#2a1430" strokeWidth={2 * k} fill="none" />;
  });
  return (
    <AbsoluteFill style={{ background: 'linear-gradient(180deg, #120a2a 0%, #3e1856 30%, #b13f62 52%, #ff8a5b 61%, #ffbe7a 62.5%, #42204f 63%, #1a0d2a 100%)', overflow: 'hidden' }}>
      <AbsoluteFill style={{ transform: `translateX(${String(drift)}px) scale(1.06)` }}>
        <svg width={W} height={H} viewBox={`0 0 ${String(W)} ${String(H)}`}>
          <defs>
            <radialGradient id="sun" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stopColor="#fff6d6" /><stop offset="0.55" stopColor="#ffd08a" /><stop offset="1" stopColor="#ff8a5b" /></radialGradient>
            <radialGradient id="sunglow" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stopColor="#ffc07a" stopOpacity="0.75" /><stop offset="1" stopColor="#ff6f61" stopOpacity="0" /></radialGradient>
            <filter id="cloudblur" x="-30%" y="-200%" width="160%" height="500%"><feGaussianBlur stdDeviation={10 * k} /></filter>
            <clipPath id="sky"><rect width={W} height={horizon} /></clipPath>
          </defs>
          <circle cx={W * 0.62} cy={sunY} r={W * 0.2} fill="url(#sunglow)" />
          <g clipPath="url(#sky)"><circle cx={W * 0.62} cy={sunY} r={W * 0.055} fill="url(#sun)" /></g>
          {[0, 1, 2, 3].map((i) => (
            <ellipse key={i} cx={(W * (0.2 + i * 0.25) + frame * 0.6 * k) % (W * 1.2)} cy={H * (0.22 + i * 0.07)} rx={W * 0.18} ry={H * 0.012} fill={i % 2 === 0 ? '#ff9a8a' : '#c66ab0'} opacity={0.45} filter="url(#cloudblur)" />
          ))}
          {shimmer}
          {waves}
          {stack(W * 0.06, W * 0.07, H * 0.2, 'a')}
          {stack(W * 0.15, W * 0.05, H * 0.13, 'b')}
          {stack(W * 0.21, W * 0.035, H * 0.09, 'c')}
          <path d={`M${String(W * 0.86)},${String(horizon + 10 * k)} L${String(W * 0.9)},${String(horizon - H * 0.12)} L${String(W * 0.95)},${String(horizon - H * 0.2)} L${String(W)},${String(horizon - H * 0.24)} L${String(W)},${String(H)} L${String(W * 0.84)},${String(H)} Z`} fill="#0f0718" />
          {birds}
        </svg>
      </AbsoluteFill>
      <FilmFinish />
    </AbsoluteFill>
  );
};

/** 公路：蓝调时刻的天空、雪山、向镜头奔来的车道线与路桩（速度感）。 */
export const RoadScene: React.FC = () => {
  const { frame, W, H, k } = useLayout();
  const vx = W * 0.5 + Math.sin(frame * 0.02) * W * 0.01;
  const vy = H * 0.52;
  const roadHalf = W * 0.75;
  const dashes = Array.from({ length: 14 }, (_, i) => {
    const d = ((i / 14) + frame * 0.022) % 1;
    const e = d ** 2.2;
    const y = vy + (H - vy) * e;
    const len = (H - vy) * 0.06 * (0.2 + e * 2.2);
    const w = 3 * k + 26 * k * e;
    const x = vx + (W * 0.5 - vx) * e;
    return <rect key={i} x={x - w / 2} y={y} width={w} height={len} fill="#f6c445" opacity={0.25 + 0.75 * e} />;
  });
  const posts = Array.from({ length: 16 }, (_, i) => {
    const side = i % 2 === 0 ? -1 : 1;
    const d = ((Math.floor(i / 2) / 8) + frame * 0.022) % 1;
    const e = d ** 2.2;
    const x = vx + side * (roadHalf * 1.08) * e;
    const y = vy + (H - vy) * e;
    const h = 6 * k + 120 * k * e;
    return (
      <g key={i} opacity={0.3 + 0.7 * e}>
        <rect x={x - (2 + 6 * e) * k} y={y - h} width={(4 + 12 * e) * k} height={h} fill="#e9eef7" />
        <rect x={x - (2 + 6 * e) * k} y={y - h} width={(4 + 12 * e) * k} height={h * 0.18} fill="#ff5a3c" />
      </g>
    );
  });
  return (
    <AbsoluteFill style={{ background: 'linear-gradient(180deg, #071a33 0%, #123a63 32%, #6f5a8a 46%, #f09a6a 52%, #2a2236 52.2%, #15131d 100%)', overflow: 'hidden' }}>
      <svg width={W} height={H} viewBox={`0 0 ${String(W)} ${String(H)}`}>
        <defs>
          <linearGradient id="peak" x1="0" y1="0" x2="0" y2="1"><stop offset="0.2" stopColor="#dfe8f7" /><stop offset="0.42" stopColor="#5b6a8f" /><stop offset="1" stopColor="#2a2a40" /></linearGradient>
          <linearGradient id="road" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#3a3a4a" /><stop offset="1" stopColor="#14141c" /></linearGradient>
          <radialGradient id="dusk" cx="0.5" cy="1" r="0.6"><stop offset="0" stopColor="#ffb07a" stopOpacity="0.55" /><stop offset="1" stopColor="#ffb07a" stopOpacity="0" /></radialGradient>
        </defs>
        {Array.from({ length: 60 }, (_, i) => <circle key={i} cx={random(`rs${String(i)}`) * W} cy={random(`rsy${String(i)}`) * H * 0.3} r={(0.5 + random(`rsr${String(i)}`)) * k} fill="#fff" opacity={0.25 + 0.4 * Math.abs(Math.sin(frame * 0.05 + i))} />)}
        <ellipse cx={vx} cy={vy} rx={W * 0.6} ry={H * 0.25} fill="url(#dusk)" />
        <path d={ridgePath({ width: W, height: vy + 2, base: vy + 2, amp: H * 0.24, seed: 'roadpeaks', shift: 0.12 })} fill="url(#peak)" />
        <path d={ridgePath({ width: W, height: vy + 2, base: vy + 2, amp: H * 0.1, seed: 'roadhills', shift: 0.5, octaves: 3 })} fill="#232235" />
        <path d={`M${String(vx - 3 * k)},${String(vy)} L${String(vx + 3 * k)},${String(vy)} L${String(W * 0.5 + roadHalf)},${String(H)} L${String(W * 0.5 - roadHalf)},${String(H)} Z`} fill="url(#road)" />
        <path d={`M${String(vx - 3 * k)},${String(vy)} L${String(W * 0.5 - roadHalf)},${String(H)}`} stroke="#e9eef7" strokeOpacity={0.6} strokeWidth={4 * k} />
        <path d={`M${String(vx + 3 * k)},${String(vy)} L${String(W * 0.5 + roadHalf)},${String(H)}`} stroke="#e9eef7" strokeOpacity={0.6} strokeWidth={4 * k} />
        {dashes}
        {posts}
        <circle cx={vx - 4 * k} cy={vy + 3 * k} r={2.2 * k} fill="#ff3b3b" opacity={0.8 + 0.2 * Math.sin(frame * 0.3)} />
        <circle cx={vx + 4 * k} cy={vy + 3 * k} r={2.2 * k} fill="#ff3b3b" opacity={0.8 + 0.2 * Math.sin(frame * 0.3)} />
      </svg>
      <FilmFinish vignette={0.6} />
    </AbsoluteFill>
  );
};

/** 瀑布：苔绿崖壁、自上而下奔流的水线、底部翻涌的水雾与一道淡彩虹。 */
export const WaterfallScene: React.FC = () => {
  const { frame, W, H, k, t } = useLayout();
  const push = interpolate(t, [0, 1], [1.08, 1.0]);
  const top = -H * 0.02;
  const bottom = H * 0.8;
  const left = W * 0.43;
  const right = W * 0.57;
  const streaks = Array.from({ length: 110 }, (_, i) => {
    const x = left + random(`wx${String(i)}`) * (right - left);
    const speed = 0.018 + random(`wv${String(i)}`) * 0.02;
    const phase = (random(`wp${String(i)}`) + frame * speed) % 1;
    const y = top + phase * (bottom - top);
    const len = (40 + random(`wl${String(i)}`) * 140) * k;
    return <rect key={i} x={x} y={y - len} width={(1.5 + random(`ww${String(i)}`) * 3) * k} height={len} fill="#f2fbff" opacity={0.35 + random(`wo${String(i)}`) * 0.55} />;
  });
  const mist = Array.from({ length: 16 }, (_, i) => {
    const x = W * 0.5 + (random(`mx${String(i)}`) - 0.5) * W * 0.45 + Math.sin(frame * 0.03 + i) * 20 * k;
    const y = bottom - H * 0.02 + Math.sin(frame * 0.04 + i * 1.3) * 10 * k - random(`my${String(i)}`) * H * 0.08;
    return <ellipse key={i} cx={x} cy={y} rx={(60 + random(`mr${String(i)}`) * 160) * k} ry={(25 + random(`mq${String(i)}`) * 50) * k} fill="#eef9ff" opacity={0.18 + 0.12 * Math.sin(frame * 0.05 + i)} />;
  });
  const cliff = (side: -1 | 1) => {
    const edge = side < 0 ? left : right;
    const outer = side < 0 ? 0 : W;
    const pts = [`M${String(outer)},0`, `L${String(edge + side * 6 * k)},0`];
    for (let i = 0; i <= 12; i += 1) {
      const y = (i / 12) * H;
      const jitter = (random(`c${String(side)}${String(i)}`) - 0.5) * 30 * k;
      pts.push(`L${(edge + side * (8 * k + (y > bottom ? (y - bottom) * 1.6 : 0)) + jitter).toFixed(1)},${y.toFixed(1)}`);
    }
    pts.push(`L${String(outer)},${String(H)} Z`);
    return pts.join(' ');
  };
  return (
    <AbsoluteFill style={{ background: 'linear-gradient(180deg, #a9c7cf 0%, #6f9aa0 12%, #1f3d38 40%, #0c1c19 100%)', overflow: 'hidden' }}>
      <AbsoluteFill style={{ transform: `scale(${String(push)})` }}>
        <svg width={W} height={H} viewBox={`0 0 ${String(W)} ${String(H)}`}>
          <defs>
            <linearGradient id="fall" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#e9f8ff" stopOpacity="0.85" /><stop offset="1" stopColor="#cfefff" stopOpacity="0.55" /></linearGradient>
            <linearGradient id="moss" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#0b1a14" /><stop offset="0.7" stopColor="#25503c" /><stop offset="1" stopColor="#3f7a4f" /></linearGradient>
            <linearGradient id="moss2" x1="1" y1="0" x2="0" y2="0"><stop offset="0" stopColor="#0b1a14" /><stop offset="0.7" stopColor="#25503c" /><stop offset="1" stopColor="#3f7a4f" /></linearGradient>
            <filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation={14 * k} /></filter>
            <filter id="streak"><feGaussianBlur stdDeviation={0.8 * k} /></filter>
            <filter id="rock" x="0" y="0" width="100%" height="100%">
              <feTurbulence type="fractalNoise" baseFrequency={`${String(0.006 / k)} ${String(0.02 / k)}`} numOctaves={5} seed={7} />
              <feColorMatrix type="matrix" values="0 0 0 0 0.02  0 0 0 0 0.08  0 0 0 0 0.05  -1.4 -1.4 -1.4 0 2.2" />
            </filter>
          </defs>
          <rect x={left} y={top} width={right - left} height={bottom - top} fill="url(#fall)" />
          <g filter="url(#streak)">{streaks}</g>
          <path d={cliff(-1)} fill="url(#moss)" />
          <path d={cliff(1)} fill="url(#moss2)" />
          <clipPath id="cliffs"><path d={cliff(-1)} /><path d={cliff(1)} /></clipPath>
          <rect width={W} height={H} filter="url(#rock)" clipPath="url(#cliffs)" opacity={0.55} style={{ mixBlendMode: 'multiply' }} />
          <rect x={0} y={bottom} width={W} height={H - bottom} fill="#13302b" />
          <g filter="url(#soft)">{mist}</g>
          {['#ff6b6b', '#ffd36b', '#7bff9a', '#6bc6ff', '#b46bff'].map((color, i) => (
            <circle key={color} cx={W * 0.62} cy={bottom + H * 0.32} r={H * (0.36 + i * 0.012)} fill="none" stroke={color} strokeWidth={H * 0.012} opacity={0.24 * (0.7 + 0.3 * Math.sin(frame * 0.04))} filter="url(#soft)" />
          ))}
        </svg>
      </AbsoluteFill>
      <FilmFinish />
    </AbsoluteFill>
  );
};

export const LANDSCAPES = { aurora: AuroraScene, coast: CoastScene, road: RoadScene, waterfall: WaterfallScene } as const;
export type LandscapeId = keyof typeof LANDSCAPES;
