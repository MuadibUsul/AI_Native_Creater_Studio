import * as React from 'react';
import { AbsoluteFill, Easing, Img, interpolate, random, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { EffectLayer } from '../effects/EffectLayer';

/**
 * 预告片的积木：背景、真实界面镜头（按截图里元素的真实位置推拉）、大字、标志、代码面板、特效（直接运行产品特效模板代码）。
 * 所有动画只依赖帧号（确定性渲染）。
 */

export const FPS = 30;
export const BEAT = 15; // 120 BPM
export const BAR = 60;
export const VIEW = { width: 1600, height: 900 }; // 截图视口（CSS 像素）

export const COLORS = { ink: '#05060c', violet: '#7c5cff', cyan: '#5ee7ff', magenta: '#ff4fd8', text: '#f4f5ff', dim: '#a9b0d6' };
export const DISPLAY = '"Inter Display", "Inter", system-ui, sans-serif';
export const MONO = '"DejaVu Sans Mono", "Liberation Mono", monospace';

export interface Box { x: number; y: number; width: number; height: number }
export interface Capture {
  captured: Record<string, string | string[]>;
  boxes: Record<string, Record<string, Box>>;
}

const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
export const ease = Easing.bezier(0.16, 1, 0.3, 1);
export const easeInOut = Easing.bezier(0.65, 0, 0.35, 1);
export const ramp = (frame: number, from: number, to: number, a: number, b: number, easing: (t: number) => number = ease) =>
  interpolate(frame, [from, to], [a, b], { ...clamp, easing });

/** 深色背景：两团缓慢移动的光、点阵（与产品画布同款）、上浮的微粒。 */
export const Backdrop: React.FC<{ hue?: 'violet' | 'cyan' | 'warm'; intensity?: number }> = ({ hue = 'violet', intensity = 1 }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const a = hue === 'warm' ? '#ff7a59' : COLORS.violet;
  const b = hue === 'cyan' ? '#2dd4ff' : hue === 'warm' ? '#ff4fd8' : COLORS.cyan;
  const x1 = 30 + Math.sin(frame / 90) * 12;
  const y1 = 28 + Math.cos(frame / 110) * 10;
  const x2 = 72 + Math.cos(frame / 100) * 12;
  const y2 = 76 + Math.sin(frame / 80) * 8;
  const particles = Array.from({ length: 70 }, (_, i) => {
    const speed = 0.4 + random(`ps${String(i)}`) * 1.2;
    const y = (random(`py${String(i)}`) * height - frame * speed + height * 4) % (height + 40) - 20;
    const x = random(`px${String(i)}`) * width + Math.sin(frame / 40 + i) * 8;
    const size = 1 + random(`pz${String(i)}`) * 2.4;
    return <div key={i} style={{ position: 'absolute', left: x, top: y, width: size, height: size, borderRadius: '50%', background: i % 3 === 0 ? b : '#ffffff', opacity: (0.15 + random(`po${String(i)}`) * 0.5) * intensity }} />;
  });
  // 景深光斑：几颗大而虚的光点缓慢漂移
  const bokeh = Array.from({ length: 9 }, (_, i) => {
    const size = 120 + random(`bk${String(i)}`) * 260;
    const x = (random(`bx${String(i)}`) * 1.2 - 0.1) * width + Math.sin(frame / (70 + i * 9) + i) * 60;
    const y = (random(`by${String(i)}`) * 1.1 - 0.05) * height + Math.cos(frame / (90 + i * 7) + i) * 40;
    return <div key={`b${String(i)}`} style={{ position: 'absolute', left: x - size / 2, top: y - size / 2, width: size, height: size, borderRadius: '50%', background: `radial-gradient(circle, ${i % 2 === 0 ? a : b}55 0%, transparent 70%)`, opacity: (0.35 + random(`bo${String(i)}`) * 0.4) * intensity, filter: 'blur(6px)' }} />;
  });
  return (
    <AbsoluteFill style={{ background: COLORS.ink, overflow: 'hidden' }}>
      <AbsoluteFill style={{ background: `radial-gradient(40% 50% at ${String(x1)}% ${String(y1)}%, ${a}55 0%, transparent 70%), radial-gradient(45% 55% at ${String(x2)}% ${String(y2)}%, ${b}44 0%, transparent 70%)`, opacity: intensity }} />
      {bokeh}
      <AbsoluteFill style={{ backgroundImage: 'radial-gradient(rgba(255,255,255,0.10) 1.2px, transparent 1.4px)', backgroundSize: '32px 32px', backgroundPosition: `${String(-frame * 0.3)}px ${String(-frame * 0.5)}px`, opacity: 0.6 * intensity, maskImage: 'radial-gradient(ellipse at center, black 30%, transparent 80%)' }} />
      {particles}
    </AbsoluteFill>
  );
};

export interface Cam { cx: number; cy: number; zoom: number }
export const FULL: Cam = { cx: VIEW.width / 2, cy: VIEW.height / 2, zoom: 1 };
/** 对准截图里某个元素：元素填满画面的 fill 比例（不超过 maxZoom）。 */
export function focus(box: Box | undefined, fill = 0.72, maxZoom = 3.2): Cam {
  if (box === undefined) return FULL;
  const zoom = Math.max(1, Math.min(maxZoom, (VIEW.width * fill) / box.width, (VIEW.height * fill) / box.height));
  return { cx: box.x + box.width / 2, cy: box.y + box.height / 2, zoom };
}
export const mixCam = (a: Cam, b: Cam, t: number): Cam => {
  // 缩放按对数插值（推拉匀速感），中心随之移动
  const zoom = Math.exp(Math.log(a.zoom) + (Math.log(b.zoom) - Math.log(a.zoom)) * t);
  return { cx: a.cx + (b.cx - a.cx) * t, cy: a.cy + (b.cy - a.cy) * t, zoom };
};

/**
 * 真实界面镜头：截图放在一块带光边的"屏幕"里，透视倾斜 + 推拉到元素。
 * src 可以是一张图，也可以是连拍序列（按 progress 选帧）。
 */
export const UiShot: React.FC<{
  src: string | string[] | undefined;
  from?: Cam; to?: Cam; duration: number; delay?: number;
  width?: number; x?: number; y?: number;
  tilt?: [number, number, number, number]; // rotX 起止、rotY 起止
  sequenceRate?: number; // 连拍：每帧画面前进几张
  chrome?: boolean; dim?: number; easing?: (t: number) => number;
  /** 镜面高光扫过屏幕的起点（相对本镜头的帧）；null 不扫 */
  sweepAt?: number | null;
  /** 标注：在截图坐标里圈出界面元素（圈线粗细不随推拉变化） */
  callouts?: Callout[];
}> = ({ src, from = FULL, to = FULL, duration, delay = 0, width = 1660, x, y, tilt = [0, 0, 0, 0], sequenceRate, chrome = true, dim = 0, easing = easeInOut, sweepAt = 4, callouts = [] }) => {
  const frame = useCurrentFrame();
  const { width: W, height: H } = useVideoConfig();
  const t = interpolate(frame - delay, [0, duration], [0, 1], { ...clamp, easing });
  const cam = mixCam(from, to, t);
  const height = width * (VIEW.height / VIEW.width);
  const s0 = width / VIEW.width;
  const left = x ?? (W - width) / 2;
  const top = y ?? (H - height) / 2;
  const rotX = tilt[0] + (tilt[1] - tilt[0]) * t;
  const rotY = tilt[2] + (tilt[3] - tilt[2]) * t;
  let file: string | undefined;
  if (Array.isArray(src)) {
    const index = Math.min(src.length - 1, Math.max(0, Math.floor((frame - delay) * (sequenceRate ?? src.length / Math.max(1, duration)))));
    file = src[index];
  } else file = src;
  // 镜头不越界：中心限制在能让画面铺满的范围里
  const halfW = VIEW.width / (2 * cam.zoom);
  const halfH = VIEW.height / (2 * cam.zoom);
  const cx = Math.min(VIEW.width - halfW, Math.max(halfW, cam.cx));
  const cy = Math.min(VIEW.height - halfH, Math.max(halfH, cam.cy));
  const scale = s0 * cam.zoom;
  const local = frame - delay;
  const sweep = sweepAt === null || !chrome ? null : interpolate(local, [sweepAt, sweepAt + 22], [-0.5, 1.5], { ...clamp, easing: Easing.inOut(Easing.cubic) });
  return (
    <AbsoluteFill style={{ perspective: 2400, perspectiveOrigin: '50% 40%' }}>
      {chrome && file !== undefined ? (
        // 屏幕的光溢出到背景（同一画面的大幅模糊放大），让窗口有"发光的屏幕"的深度
        <div style={{ position: 'absolute', left: left - width * 0.06, top: top - height * 0.06, width: width * 1.12, height: height * 1.12, opacity: 0.42, filter: 'blur(70px) saturate(1.4)', transform: `rotateX(${String(rotX)}deg) rotateY(${String(rotY)}deg)` }}>
          <Img src={staticFile(file)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        </div>
      ) : null}
      <div style={{
        position: 'absolute', left, top, width, height, borderRadius: chrome ? 18 : 0, overflow: 'hidden',
        transform: `rotateX(${String(rotX)}deg) rotateY(${String(rotY)}deg)`, transformStyle: 'preserve-3d',
        boxShadow: chrome ? `0 50px 140px rgba(0,0,0,0.65), 0 0 0 1px rgba(255,255,255,0.14), 0 0 90px ${COLORS.violet}40` : undefined,
        background: '#0b0c12',
      }}>
        <div style={{ position: 'absolute', left: 0, top: 0, width: VIEW.width, height: VIEW.height, transformOrigin: '0 0', transform: `translate(${String(width / 2)}px, ${String(height / 2)}px) scale(${String(s0 * cam.zoom)}) translate(${String(-cx)}px, ${String(-cy)}px)` }}>
          {file === undefined
            ? <div style={{ width: VIEW.width, height: VIEW.height, background: 'linear-gradient(135deg,#12131c,#1b1d2b)' }} />
            : <Img src={staticFile(file)} style={{ width: VIEW.width, height: VIEW.height, display: 'block' }} />}
          {callouts.map((callout) => <CalloutRing key={`${callout.label ?? ''}${String(callout.at)}`} callout={callout} local={local} scale={scale} />)}
        </div>
        {sweep !== null && sweep > -0.5 && sweep < 1.5 ? (
          <div style={{ position: 'absolute', inset: 0, background: `linear-gradient(105deg, rgba(255,255,255,0) ${String((sweep - 0.18) * 100)}%, rgba(255,255,255,0.16) ${String(sweep * 100)}%, rgba(255,255,255,0) ${String((sweep + 0.18) * 100)}%)`, mixBlendMode: 'screen', pointerEvents: 'none' }} />
        ) : null}
        {chrome ? <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(120deg, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0) 35%)', pointerEvents: 'none' }} /> : null}
        {dim > 0 ? <div style={{ position: 'absolute', inset: 0, background: `rgba(5,6,12,${String(dim)})` }} /> : null}
      </div>
    </AbsoluteFill>
  );
};

export interface Callout { box: Box | undefined; label?: string; at: number; until?: number; pad?: number }

/** 界面标注：圆角圈线从中心展开 + 发光，旁边一个小标签。坐标是截图里的 CSS 像素，圈线粗细按镜头缩放反算成恒定屏幕像素。 */
const CalloutRing: React.FC<{ callout: Callout; local: number; scale: number }> = ({ callout, local, scale }) => {
  const { box } = callout;
  if (box === undefined || local < callout.at || (callout.until !== undefined && local > callout.until)) return null;
  const p = interpolate(local - callout.at, [0, 10], [0, 1], { ...clamp, easing: ease });
  const fade = callout.until === undefined ? 1 : interpolate(local, [callout.until - 6, callout.until], [1, 0], clamp);
  const pad = (callout.pad ?? 10) / scale;
  const stroke = 3 / scale;
  const w = box.width + pad * 2;
  const h = box.height + pad * 2;
  return (
    <div style={{ position: 'absolute', left: box.x - pad + (w * (1 - p)) / 2, top: box.y - pad + (h * (1 - p)) / 2, width: w * p, height: h * p, opacity: fade }}>
      <div style={{ position: 'absolute', inset: 0, borderRadius: 14 / scale, border: `${String(stroke)}px solid ${COLORS.cyan}`, boxShadow: `0 0 ${String(24 / scale)}px ${COLORS.cyan}, inset 0 0 ${String(18 / scale)}px ${COLORS.violet}88` }} />
      {callout.label !== undefined && p > 0.6 ? (
        <div style={{ position: 'absolute', left: 0, top: -(46 / scale), transformOrigin: '0 0', transform: `scale(${String(1 / scale)})`, whiteSpace: 'nowrap', padding: '7px 14px', borderRadius: 999, fontFamily: DISPLAY, fontWeight: 600, fontSize: 22, color: '#fff', background: `linear-gradient(100deg, ${COLORS.violet}, ${COLORS.cyan})`, boxShadow: `0 6px 24px ${COLORS.violet}88`, opacity: interpolate(p, [0.6, 1], [0, 1]) }}>{callout.label}</div>
      ) : null}
    </div>
  );
};

/** 变形镜头光条：冲击时一道横向光条展开、渐隐（加一团柔光）。 */
export const LensStreak: React.FC<{ at: number; y?: number; length?: number; color?: string }> = ({ at, y = 540, length = 26, color = COLORS.cyan }) => {
  const frame = useCurrentFrame();
  const local = frame - at;
  if (local < 0 || local > length) return null;
  const p = local / length;
  const widthPx = interpolate(p, [0, 0.35, 1], [200, 2200, 2600]);
  const opacity = interpolate(p, [0, 0.12, 1], [0, 1, 0]);
  return (
    <AbsoluteFill style={{ pointerEvents: 'none', mixBlendMode: 'screen' }}>
      <div style={{ position: 'absolute', left: 960 - widthPx / 2, top: y - 3, width: widthPx, height: 6, borderRadius: 6, background: `linear-gradient(90deg, transparent, ${color} 30%, #ffffff 50%, ${color} 70%, transparent)`, opacity, filter: 'blur(1.5px)' }} />
      <div style={{ position: 'absolute', left: 960 - widthPx / 3, top: y - 40, width: (widthPx * 2) / 3, height: 80, borderRadius: '50%', background: `radial-gradient(ellipse, ${color}66 0%, transparent 70%)`, opacity: opacity * 0.8, filter: 'blur(10px)' }} />
    </AbsoluteFill>
  );
};

/** 大字：落下（缩放 + 模糊 + 色散）或上浮（逐词遮罩），可选渐变色。 */
export const BigWord: React.FC<{
  text: string; at?: number; out?: number; size?: number; mode?: 'slam' | 'rise' | 'track';
  x?: number | string; y?: number | string; align?: 'center' | 'left' | 'right'; gradient?: boolean; weight?: number; color?: string; maxWidth?: number;
  letterSpacing?: string; shadow?: boolean;
}> = ({ text, at = 0, out, size = 200, mode = 'slam', x = '50%', y = '50%', align = 'center', gradient = false, weight = 900, color = COLORS.text, maxWidth, letterSpacing = '-0.045em', shadow = true }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const local = frame - at;
  if (local < 0) return null;
  const exit = out === undefined ? 0 : ramp(frame, out - 5, out, 0, 1, Easing.in(Easing.cubic));
  if (exit >= 1) return null;
  const anchor = align === 'center' ? 'translate(-50%, -50%)' : align === 'left' ? 'translate(0, -50%)' : 'translate(-100%, -50%)';
  const fill: React.CSSProperties = gradient
    ? { backgroundImage: `linear-gradient(100deg, #ffffff 0%, #d9d0ff 45%, ${COLORS.cyan} 100%)`, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }
    : { color };
  const base: React.CSSProperties = {
    position: 'absolute', left: x, top: y, fontFamily: DISPLAY, fontWeight: weight, fontSize: size, lineHeight: 0.92, letterSpacing,
    whiteSpace: maxWidth === undefined ? 'nowrap' : 'normal', maxWidth, textAlign: align, opacity: 1 - exit,
  };
  if (mode === 'slam') {
    const s = spring({ frame: local, fps, config: { damping: 14, stiffness: 180, mass: 0.7 } });
    const scale = interpolate(s, [0, 1], [1.6, 1]) * (1 + exit * 0.15);
    const blur = interpolate(local, [0, 6], [24, 0], clamp) + exit * 10;
    const split = interpolate(local, [0, 10], [14, 0], clamp);
    return (
      <div style={{ ...base, transform: `${anchor} scale(${String(scale)})`, filter: `blur(${String(blur)}px)` }}>
        <span style={{ ...fill, textShadow: !gradient && shadow ? `${String(-split)}px 0 rgba(255,60,120,0.75), ${String(split)}px 0 rgba(60,220,255,0.75), 0 10px 60px rgba(0,0,0,0.55)` : undefined, filter: gradient && shadow ? `drop-shadow(${String(-split)}px 0 rgba(255,60,120,0.7)) drop-shadow(${String(split)}px 0 rgba(60,220,255,0.7))` : undefined }}>{text}</span>
      </div>
    );
  }
  if (mode === 'track') {
    const spacing = interpolate(local, [0, 40], [0.6, 0.18], { ...clamp, easing: ease });
    const opacity = interpolate(local, [0, 12], [0, 1], clamp);
    return <div style={{ ...base, letterSpacing: `${String(spacing)}em`, transform: anchor, opacity: opacity * (1 - exit) }}><span style={fill}>{text}</span></div>;
  }
  const words = text.split(' ');
  return (
    <div style={{ ...base, transform: anchor }}>
      {words.map((word, i) => {
        const p = ramp(local, i * 3, i * 3 + 14, 0, 1);
        return (
          <span key={`${word}${String(i)}`} style={{ display: 'inline-block', overflow: 'hidden', verticalAlign: 'bottom', paddingBottom: '0.08em', marginRight: i < words.length - 1 ? '0.24em' : 0 }}>
            <span style={{ display: 'inline-block', transform: `translateY(${String((1 - p) * 110)}%)`, ...fill, textShadow: shadow && !gradient ? '0 8px 40px rgba(0,0,0,0.5)' : undefined }}>{word}</span>
          </span>
        );
      })}
    </div>
  );
};

/** 小字说明（上浮淡入）。 */
export const Caption: React.FC<{ text: string; at: number; out?: number; x?: number | string; y?: number | string; size?: number; align?: 'center' | 'left'; color?: string; maxWidth?: number; weight?: number }> = ({ text, at, out, x = '50%', y = '80%', size = 40, align = 'center', color = COLORS.dim, maxWidth, weight = 500 }) => {
  const frame = useCurrentFrame();
  const p = ramp(frame, at, at + 16, 0, 1);
  const exit = out === undefined ? 0 : ramp(frame, out - 8, out, 0, 1);
  if (frame < at || exit >= 1) return null;
  return (
    <div style={{ position: 'absolute', left: x, top: y, transform: `translate(${align === 'center' ? '-50%' : '0'}, ${String((1 - p) * 24)}px)`, opacity: p * (1 - exit), fontFamily: DISPLAY, fontWeight: weight, fontSize: size, color, letterSpacing: '-0.01em', textAlign: align, maxWidth, lineHeight: 1.25, textShadow: '0 4px 24px rgba(0,0,0,0.6)' }}>{text}</div>
  );
};

/** 胶囊标签（例如 "PLAN · CUT · CHECK"），active 时发光。 */
export const Chip: React.FC<{ text: string; active?: boolean; size?: number }> = ({ text, active = false, size = 26 }) => (
  <div style={{
    display: 'inline-flex', alignItems: 'center', gap: 10, padding: `${String(size * 0.45)}px ${String(size * 0.9)}px`, borderRadius: 999,
    fontFamily: DISPLAY, fontWeight: 600, fontSize: size, color: active ? '#fff' : 'rgba(255,255,255,0.45)', letterSpacing: '0.02em',
    background: active ? `linear-gradient(100deg, ${COLORS.violet}cc, ${COLORS.cyan}99)` : 'rgba(255,255,255,0.06)',
    boxShadow: active ? `0 0 40px ${COLORS.violet}88, inset 0 0 0 1px rgba(255,255,255,0.35)` : 'inset 0 0 0 1px rgba(255,255,255,0.12)',
  }}>{text}</div>
);

/** 白闪（转场重音）。 */
export const Flash: React.FC<{ at: number; length?: number; color?: string; peak?: number }> = ({ at, length = 8, color = '#ffffff', peak = 0.9 }) => {
  const frame = useCurrentFrame();
  if (frame < at - 2 || frame > at + length) return null;
  const opacity = interpolate(frame, [at - 2, at, at + length], [0, peak, 0], clamp);
  return <AbsoluteFill style={{ background: color, opacity, mixBlendMode: 'screen' }} />;
};

/** 冲击时的画面抖动。 */
export function shake(frame: number, at: number, strength = 18, length = 12): string {
  const local = frame - at;
  if (local < 0 || local > length) return 'none';
  const decay = 1 - local / length;
  return `translate(${String((random(`sx${String(frame)}`) - 0.5) * strength * decay)}px, ${String((random(`sy${String(frame)}`) - 0.5) * strength * decay)}px)`;
}

/**
 * Kinora 标志（与 apps/web/src/brand/brand.tsx、docs/brand/ 同一图形）：竖笔是时间线播放头，两臂张开成"K"，臂间一道声波。
 * draw 0→1：竖笔从下往上长出 → 两臂描出 → 声波弹出；glow 控制外发光。
 */
export const LogoMark: React.FC<{ size: number; glow?: number; draw?: number; id?: string }> = ({ size, glow = 1, draw = 1, id = 'km' }) => {
  const stem = interpolate(draw, [0, 0.35], [0, 1], clamp);
  const arms = interpolate(draw, [0.2, 0.75], [0, 1], { ...clamp, easing: ease });
  const wave = interpolate(draw, [0.65, 1], [0, 1], { ...clamp, easing: Easing.out(Easing.back(2)) });
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" style={{ overflow: 'visible', filter: `drop-shadow(0 0 ${String(18 * glow)}px ${COLORS.violet}) drop-shadow(0 0 ${String(40 * glow)}px ${COLORS.cyan}55)` }}>
      <defs>
        <linearGradient id={id} x1="20" y1="8" x2="56" y2="58" gradientUnits="userSpaceOnUse"><stop stopColor="#B9A6FF" /><stop offset="0.5" stopColor="#7C5CFF" /><stop offset="1" stopColor="#4FD8FF" /></linearGradient>
      </defs>
      <rect x="11" y="7" width="7" height="50" rx="3.5" fill="#fff" style={{ transformOrigin: '14.5px 57px', transform: `scaleY(${String(stem)})` }} />
      <path d="M48 9 23.5 33 49 57" stroke={`url(#${id})`} strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray="1" strokeDashoffset={1 - arms} opacity={arms > 0 ? 1 : 0} />
      <path d="M40.5 23.5a19 19 0 0 1 0 19" stroke={`url(#${id})`} strokeWidth="4.5" strokeLinecap="round" style={{ transformOrigin: '23.5px 33px', transform: `scale(${String(wave)})` }} opacity={wave > 0 ? 1 : 0} />
    </svg>
  );
};

/** 字标 "kinora"：逐字从模糊里落定。 */
export const Wordmark: React.FC<{ text?: string; size: number; at: number; stagger?: number }> = ({ text = 'kinora', size, at, stagger = 2 }) => {
  const frame = useCurrentFrame();
  return (
    <div style={{ display: 'flex', fontFamily: DISPLAY, fontWeight: 700, fontSize: size, letterSpacing: '-0.05em', lineHeight: 1, color: '#fff', textShadow: `0 0 50px ${COLORS.violet}99` }}>
      {[...text].map((char, i) => {
        const p = interpolate(frame - at - i * stagger, [0, 10], [0, 1], { ...clamp, easing: ease });
        return <span key={`${char}${String(i)}`} style={{ display: 'inline-block', opacity: p, transform: `translateY(${String((1 - p) * 40)}px)`, filter: `blur(${String((1 - p) * 14)}px)` }}>{char}</span>;
      })}
    </div>
  );
};

/** 产品特效模板（真实代码）放在一块区域里运行：区域内的 useVideoConfig 尺寸 = 区域尺寸，时长 = 本段时长。 */
export const Effect: React.FC<{ code: string | undefined; params?: Record<string, unknown>; from: number; duration: number; x?: number; y?: number; width?: number; height?: number; seed?: string; blend?: React.CSSProperties['mixBlendMode'] }> = ({ code, params = {}, from, duration, x = 0, y = 0, width = 1920, height = 1080, seed = 'promo', blend = 'screen' }) => {
  if (code === undefined || code.length === 0) return null;
  return (
    <div style={{ position: 'absolute', left: x, top: y, width, height, mixBlendMode: blend, pointerEvents: 'none' }}>
      <Sequence from={from} durationInFrames={duration} width={width} height={height} layout="absolute-fill">
        <EffectLayer code={code} params={params} seed={seed} />
      </Sequence>
    </div>
  );
};

/** 代码面板：逐字打出（简单语法着色），自动滚到最后一行。 */
export const CodePanel: React.FC<{ code: string; title: string; at: number; charsPerFrame?: number; width: number; height: number; x: number; y: number }> = ({ code, title, at, charsPerFrame = 9, width, height, x, y }) => {
  const frame = useCurrentFrame();
  const shown = code.slice(0, Math.max(0, Math.floor((frame - at) * charsPerFrame)));
  const lines = shown.split('\n');
  const lineHeight = 30;
  const visible = Math.floor((height - 70) / lineHeight);
  const offset = Math.max(0, lines.length - visible);
  const appear = ramp(frame, at - 10, at + 6, 0, 1);
  const color = (token: string): string => {
    if (/^(const|let|for|if|return|function|continue)$/.test(token)) return '#c792ea';
    if (/^(registerMotion|useCurrentFrame|useVideoConfig|interpolate|random|React|AbsoluteFill)$/.test(token)) return COLORS.cyan;
    if (/^['"].*['"]$/.test(token)) return '#c3e88d';
    if (/^\d/.test(token)) return '#f78c6c';
    return '#d6deeb';
  };
  return (
    <div style={{ position: 'absolute', left: x, top: y, width, height, borderRadius: 18, overflow: 'hidden', background: 'rgba(12,13,22,0.92)', boxShadow: `0 40px 120px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.12), 0 0 80px ${COLORS.violet}33`, opacity: appear, transform: `translateY(${String((1 - appear) * 30)}px)` }}>
      <div style={{ height: 52, display: 'flex', alignItems: 'center', gap: 10, padding: '0 20px', borderBottom: '1px solid rgba(255,255,255,0.08)', fontFamily: DISPLAY, fontSize: 20, color: 'rgba(255,255,255,0.6)' }}>
        {['#ff5f57', '#febc2e', '#28c840'].map((c) => <span key={c} style={{ width: 13, height: 13, borderRadius: '50%', background: c }} />)}
        <span style={{ marginLeft: 12 }}>{title}</span>
      </div>
      <div style={{ padding: '14px 26px', fontFamily: MONO, fontSize: 20, lineHeight: `${String(lineHeight)}px`, whiteSpace: 'pre' }}>
        {lines.slice(offset).map((line, i) => (
          <div key={i + offset}>
            {line.split(/('[^']*'?|\b\w+\b|\s+|[^\w\s])/).filter((part) => part.length > 0).map((part, j) => <span key={j} style={{ color: color(part) }}>{part}</span>)}
            {i + offset === lines.length - 1 && frame % 16 < 9 ? <span style={{ background: COLORS.cyan, color: COLORS.cyan }}>▍</span> : null}
          </div>
        ))}
      </div>
    </div>
  );
};

/** 语音波形条（随节拍跳动的装饰，示意"正在听"）。 */
export const VoiceBars: React.FC<{ x: number; y: number; width: number; height: number; at: number; out: number }> = ({ x, y, width, height, at, out }) => {
  const frame = useCurrentFrame();
  if (frame < at || frame > out) return null;
  const appear = ramp(frame, at, at + 10, 0, 1) * (1 - ramp(frame, out - 8, out, 0, 1));
  const bars = 36;
  return (
    <div style={{ position: 'absolute', left: x, top: y, width, height, display: 'flex', alignItems: 'center', gap: 6, opacity: appear }}>
      {Array.from({ length: bars }, (_, i) => {
        const v = 0.15 + 0.85 * Math.abs(Math.sin(frame * 0.35 + i * 0.7) * Math.sin(frame * 0.11 + i * 0.23)) * (0.6 + 0.4 * random(`vb${String(i)}`));
        return <div key={i} style={{ flex: 1, height: `${String(v * 100)}%`, borderRadius: 4, background: `linear-gradient(180deg, ${COLORS.cyan}, ${COLORS.violet})`, boxShadow: `0 0 12px ${COLORS.violet}aa` }} />;
      })}
    </div>
  );
};

/** 画出来的指针：从 a 拖到 b 框出一个区域（框选动画）。 */
export const PointerDrag: React.FC<{ from: [number, number]; to: [number, number]; at: number; length?: number; hold?: number }> = ({ from, to, at, length = 22, hold = 60 }) => {
  const frame = useCurrentFrame();
  if (frame < at || frame > at + length + hold) return null;
  const p = ramp(frame, at + 4, at + length, 0, 1, easeInOut);
  const cx = from[0] + (to[0] - from[0]) * p;
  const cy = from[1] + (to[1] - from[1]) * p;
  const fade = 1 - ramp(frame, at + length + hold - 10, at + length + hold, 0, 1);
  return (
    <AbsoluteFill style={{ opacity: fade }}>
      <div style={{ position: 'absolute', left: Math.min(from[0], cx), top: Math.min(from[1], cy), width: Math.abs(cx - from[0]), height: Math.abs(cy - from[1]), border: `3px solid ${COLORS.cyan}`, borderRadius: 10, background: `${COLORS.cyan}1a`, boxShadow: `0 0 30px ${COLORS.cyan}88` }} />
      <svg width="44" height="44" viewBox="0 0 24 24" style={{ position: 'absolute', left: cx - 4, top: cy - 2, filter: 'drop-shadow(0 4px 10px rgba(0,0,0,0.6))' }}>
        <path d="M3 2 L20 12 L12.5 13.5 L9 21 Z" fill="#fff" stroke="#111" strokeWidth="1.2" />
      </svg>
    </AbsoluteFill>
  );
};
