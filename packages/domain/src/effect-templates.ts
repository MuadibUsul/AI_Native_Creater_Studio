import { effectTemplateSchema, type EffectTemplate } from '@ancs/contracts';

/**
 * V6-3 特效模板库（可信代码，数据形式）：AI 不写代码时的回退，也是 AI 写代码的参考范例。
 * 代码契约与 Custom Motion 沙箱一致（纯 JS、`registerMotion({ name, component })`、只用注入的全局、确定性 `random(key)`），
 * 测试里逐个过四道门禁（apps/motion-worker/src/effect-templates.test.ts）。组件的 props 就是模板参数。
 * 这里没有按视频类型分支的逻辑：模板只是 AI 可以选用的组件（裁决 0018）。
 */

const colorParam = (key: string, zh: string, en: string, fallback: string, description: string) => ({
  key, kind: 'color' as const, label: { 'zh-CN': zh, en }, description, default: fallback,
});
const numberParam = (key: string, zh: string, en: string, fallback: number, min: number, max: number, description: string) => ({
  key, kind: 'number' as const, label: { 'zh-CN': zh, en }, description, default: fallback, min, max,
});

const BURST = `
registerMotion({
  name: 'Burst',
  component: function Burst(props) {
    const frame = useCurrentFrame();
    const config = useVideoConfig();
    const t = frame / Math.max(1, config.durationInFrames - 1);
    const base = Math.min(config.width, config.height);
    const scale = Number(props.size) || 1;
    const intensity = Number(props.intensity) || 1;
    const hot = String(props.color || '#ff6a00');
    const bright = String(props.color2 || '#ffd25a');
    const core = interpolate(t, [0, 0.12, 0.5, 1], [0.05, 0.7, 0.85, 0.9]) * base * scale;
    const coreOpacity = interpolate(t, [0, 0.08, 0.45, 1], [0, 1, 0.7, 0]) * intensity;
    const smokeOpacity = interpolate(t, [0.2, 0.5, 1], [0, 0.55, 0], { extrapolateLeft: 'clamp' }) * intensity;
    const sparks = [];
    for (let i = 0; i < 20; i += 1) {
      const angle = (i / 20) * Math.PI * 2 + random('angle' + i) * 0.5;
      const reach = (0.3 + random('reach' + i) * 0.4) * base * scale;
      const travel = interpolate(t, [0, 0.7], [0, 1], { extrapolateRight: 'clamp' });
      const sparkOpacity = interpolate(t, [0, 0.1, 0.6, 0.85], [0, 1, 0.8, 0], { extrapolateRight: 'clamp' }) * intensity;
      const dot = base * 0.022 * scale;
      sparks.push(React.createElement('div', { key: 'spark' + i, style: {
        position: 'absolute', left: '50%', top: '50%', width: dot, height: dot, borderRadius: '50%', background: bright, opacity: sparkOpacity,
        boxShadow: '0 0 ' + dot * 2 + 'px ' + hot,
        transform: 'translate(-50%, -50%) translate(' + Math.cos(angle) * reach * travel + 'px, ' + Math.sin(angle) * reach * travel + 'px)',
      } }));
    }
    return React.createElement(AbsoluteFill, null,
      React.createElement('div', { style: { position: 'absolute', left: '50%', top: '50%', width: core * 1.5, height: core * 1.5, transform: 'translate(-50%, -50%)', borderRadius: '50%', opacity: smokeOpacity, background: 'radial-gradient(circle, rgba(90,80,70,0.9) 0%, rgba(60,55,50,0.5) 45%, rgba(40,40,40,0) 70%)' } }),
      React.createElement('div', { style: { position: 'absolute', left: '50%', top: '50%', width: core, height: core, transform: 'translate(-50%, -50%)', borderRadius: '50%', opacity: coreOpacity, background: 'radial-gradient(circle, #fffbe6 0%, ' + bright + ' 25%, ' + hot + ' 55%, rgba(255,80,0,0) 72%)' } }),
      sparks);
  },
});
`;

const GLOW = `
registerMotion({
  name: 'Glow',
  component: function Glow(props) {
    const frame = useCurrentFrame();
    const config = useVideoConfig();
    const t = frame / Math.max(1, config.durationInFrames - 1);
    const base = Math.max(config.width, config.height);
    const intensity = Number(props.intensity) || 0.8;
    const color = String(props.color || '#ffe3a0');
    const pulse = 1 + Math.sin(t * Math.PI * 2 * (Number(props.pulses) || 1)) * 0.06;
    const size = interpolate(t, [0, 0.35, 1], [0.3, 0.95, 1.05]) * base * pulse;
    const opacity = interpolate(t, [0, 0.25, 0.75, 1], [0, 1, 1, 0]) * intensity;
    return React.createElement(AbsoluteFill, null,
      React.createElement('div', { style: { position: 'absolute', left: '50%', top: '50%', width: size, height: size, transform: 'translate(-50%, -50%)', borderRadius: '50%', opacity: opacity, background: 'radial-gradient(circle, ' + color + ' 0%, rgba(255,255,255,0.35) 30%, rgba(255,255,255,0) 68%)' } }));
  },
});
`;

const SPARKLES = `
registerMotion({
  name: 'Sparkles',
  component: function Sparkles(props) {
    const frame = useCurrentFrame();
    const config = useVideoConfig();
    const count = Math.max(1, Math.min(80, Math.round(Number(props.count) || 24)));
    const color = String(props.color || '#ffffff');
    const scale = Number(props.size) || 1;
    const base = Math.min(config.width, config.height) * 0.06 * scale;
    const stars = [];
    for (let i = 0; i < count; i += 1) {
      const start = random('start' + i) * config.durationInFrames * 0.7;
      const life = config.durationInFrames * (0.25 + random('life' + i) * 0.3);
      const local = (frame - start) / life;
      if (local < 0 || local > 1) continue;
      const twinkle = Math.sin(local * Math.PI);
      const size = base * (0.4 + random('size' + i) * 0.8) * twinkle;
      stars.push(React.createElement('div', { key: 'star' + i, style: {
        position: 'absolute', left: (random('x' + i) * 100) + '%', top: (random('y' + i) * 100) + '%', width: size, height: size,
        transform: 'translate(-50%, -50%) rotate(' + (45 + local * 90) + 'deg)', opacity: twinkle,
        background: 'radial-gradient(circle, ' + color + ' 0%, ' + color + ' 18%, rgba(255,255,255,0) 60%)',
        clipPath: 'polygon(50% 0%, 60% 40%, 100% 50%, 60% 60%, 50% 100%, 40% 60%, 0% 50%, 40% 40%)',
      } }));
    }
    return React.createElement(AbsoluteFill, null, stars);
  },
});
`;

const SHOCKWAVE = `
registerMotion({
  name: 'Shockwave',
  component: function Shockwave(props) {
    const frame = useCurrentFrame();
    const config = useVideoConfig();
    const rings = Math.max(1, Math.min(4, Math.round(Number(props.rings) || 2)));
    const color = String(props.color || '#9fd8ff');
    const thickness = (Number(props.thickness) || 1) * Math.min(config.width, config.height) * 0.02;
    const base = Math.min(config.width, config.height);
    const items = [];
    for (let i = 0; i < rings; i += 1) {
      const delay = i * 0.18;
      const t = (frame / Math.max(1, config.durationInFrames - 1) - delay) / (1 - delay * 0.5);
      if (t < 0 || t > 1) continue;
      const size = interpolate(t, [0, 1], [0.05, 1]) * base;
      const opacity = interpolate(t, [0, 0.15, 1], [0, 1, 0]);
      items.push(React.createElement('div', { key: 'ring' + i, style: {
        position: 'absolute', left: '50%', top: '50%', width: size, height: size, transform: 'translate(-50%, -50%)', borderRadius: '50%',
        border: thickness + 'px solid ' + color, opacity: opacity, boxShadow: '0 0 ' + thickness * 2 + 'px ' + color,
      } }));
    }
    return React.createElement(AbsoluteFill, null, items);
  },
});
`;

const LIGHT_LEAK = `
registerMotion({
  name: 'LightLeak',
  component: function LightLeak(props) {
    const frame = useCurrentFrame();
    const config = useVideoConfig();
    const t = frame / Math.max(1, config.durationInFrames - 1);
    const intensity = Number(props.intensity) || 0.7;
    const color = String(props.color || '#ff9a4a');
    const fromLeft = String(props.direction || 'left') !== 'right';
    const travel = interpolate(t, [0, 1], fromLeft ? [-40, 120] : [140, -20]);
    const opacity = interpolate(t, [0, 0.2, 0.8, 1], [0, 1, 1, 0]) * intensity;
    return React.createElement(AbsoluteFill, { style: { opacity: opacity, mixBlendMode: 'screen' } },
      React.createElement('div', { style: { position: 'absolute', top: '-30%', left: travel + '%', width: '70%', height: '160%', transform: 'translateX(-50%) rotate(18deg)', background: 'radial-gradient(ellipse at center, ' + color + ' 0%, rgba(255,200,120,0.45) 35%, rgba(255,200,120,0) 70%)' } }),
      React.createElement('div', { style: { position: 'absolute', top: '10%', left: (travel * 0.6 + 20) + '%', width: '35%', height: '90%', transform: 'translateX(-50%) rotate(-10deg)', background: 'radial-gradient(ellipse at center, rgba(255,240,200,0.55) 0%, rgba(255,240,200,0) 70%)' } }));
  },
});
`;

const CONFETTI = `
registerMotion({
  name: 'Confetti',
  component: function Confetti(props) {
    const frame = useCurrentFrame();
    const config = useVideoConfig();
    const count = Math.max(5, Math.min(120, Math.round(Number(props.count) || 60)));
    const palettes = { party: ['#ff4d6d', '#ffd166', '#06d6a0', '#118ab2', '#ef476f'], warm: ['#ff7b00', '#ffb700', '#ff4800', '#ffd000'], cool: ['#4cc9f0', '#4361ee', '#7209b7', '#b5e48c'] };
    const palette = palettes[String(props.palette || 'party')] || palettes.party;
    const t = frame / config.fps;
    const pieces = [];
    for (let i = 0; i < count; i += 1) {
      const delay = random('delay' + i) * 0.8;
      const fall = (t - delay) * config.height * (0.35 + random('speed' + i) * 0.35);
      if (fall < -20) continue;
      const sway = Math.sin((t + random('phase' + i) * 6) * 3) * config.width * 0.03;
      const w = config.width * 0.012 + random('w' + i) * config.width * 0.01;
      pieces.push(React.createElement('div', { key: 'piece' + i, style: {
        position: 'absolute', left: (random('x' + i) * 100) + '%', top: -20 + fall, width: w, height: w * 0.45,
        background: palette[i % palette.length], transform: 'translateX(' + sway + 'px) rotate(' + (t * 360 * (0.5 + random('spin' + i))) + 'deg)',
        opacity: interpolate(frame, [config.durationInFrames - 10, config.durationInFrames], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
      } }));
    }
    return React.createElement(AbsoluteFill, null, pieces);
  },
});
`;

export const EFFECT_TEMPLATES: readonly EffectTemplate[] = [
  {
    id: 'burst', name: { 'zh-CN': '爆炸', en: 'Burst' },
    description: 'A stylized explosion: a hot core that blooms and fades, flying sparks and a little smoke. Good for impacts, reveals and comedic punches. Place it on the spot where the impact happens.',
    params: [
      colorParam('color', '火焰色', 'Flame color', '#ff6a00', 'Outer flame color.'),
      colorParam('color2', '高光色', 'Highlight color', '#ffd25a', 'Inner highlight and spark color.'),
      numberParam('size', '大小', 'Size', 1, 0.4, 1.6, 'Scale relative to the region.'),
      numberParam('intensity', '强度', 'Intensity', 1, 0.2, 1, 'Overall opacity.'),
    ],
    defaultSeconds: 1.5, coverage: 'REGION', code: BURST,
  },
  {
    id: 'glow', name: { 'zh-CN': '光晕', en: 'Glow' },
    description: 'A soft light bloom that swells and fades, optionally pulsing. Good for highlighting a person or object, magical moments, or a warm sunset accent.',
    params: [
      colorParam('color', '颜色', 'Color', '#ffe3a0', 'Glow color.'),
      numberParam('intensity', '强度', 'Intensity', 0.8, 0.2, 1, 'Overall opacity.'),
      numberParam('pulses', '脉动次数', 'Pulses', 1, 0, 4, 'How many gentle pulses during the effect.'),
    ],
    defaultSeconds: 2, coverage: 'REGION', code: GLOW,
  },
  {
    id: 'sparkles', name: { 'zh-CN': '闪光点', en: 'Sparkles' },
    description: 'Twinkling star-shaped sparkles appearing at random spots. Good for something shiny, new, clean or magical.',
    params: [
      colorParam('color', '颜色', 'Color', '#ffffff', 'Sparkle color.'),
      numberParam('count', '数量', 'Count', 24, 5, 80, 'How many sparkles in total.'),
      numberParam('size', '大小', 'Size', 1, 0.4, 2, 'Sparkle size multiplier.'),
    ],
    defaultSeconds: 2, coverage: 'REGION', code: SPARKLES,
  },
  {
    id: 'shockwave', name: { 'zh-CN': '冲击波', en: 'Shockwave' },
    description: 'Expanding rings radiating from the center. Good for a beat drop, a landing, a click or a sudden realization.',
    params: [
      colorParam('color', '颜色', 'Color', '#9fd8ff', 'Ring color.'),
      numberParam('rings', '圈数', 'Rings', 2, 1, 4, 'Number of rings.'),
      numberParam('thickness', '粗细', 'Thickness', 1, 0.3, 3, 'Ring thickness multiplier.'),
    ],
    defaultSeconds: 1.2, coverage: 'REGION', code: SHOCKWAVE,
  },
  {
    id: 'light-leak', name: { 'zh-CN': '漏光', en: 'Light leak' },
    description: 'A warm film light leak sweeping across the whole frame. Good for transitions between places, nostalgic or dreamy moments, and openings.',
    params: [
      colorParam('color', '颜色', 'Color', '#ff9a4a', 'Leak color.'),
      numberParam('intensity', '强度', 'Intensity', 0.7, 0.2, 1, 'Overall opacity.'),
      { key: 'direction', kind: 'choice', label: { 'zh-CN': '方向', en: 'Direction' }, description: 'Sweep from the left or from the right.', default: 'left', options: ['left', 'right'] },
    ],
    defaultSeconds: 1.5, coverage: 'FULL_FRAME', code: LIGHT_LEAK,
  },
  {
    id: 'confetti', name: { 'zh-CN': '彩纸', en: 'Confetti' },
    description: 'Colorful confetti falling across the frame. Good for celebrations, achievements, birthdays and finales.',
    params: [
      numberParam('count', '数量', 'Count', 60, 5, 120, 'How many pieces.'),
      { key: 'palette', kind: 'choice', label: { 'zh-CN': '配色', en: 'Palette' }, description: 'Color palette.', default: 'party', options: ['party', 'warm', 'cool'] },
    ],
    defaultSeconds: 3, coverage: 'FULL_FRAME', code: CONFETTI,
  },
].map((template) => effectTemplateSchema.parse(template));

export function findEffectTemplate(id: string): EffectTemplate | undefined {
  return EFFECT_TEMPLATES.find((template) => template.id === id);
}

/**
 * 参数取值：只保留模板声明过的键，按种类校验与夹取，缺省用默认值（AI 给错了值不会让渲染崩，而是落回合理范围）。
 * 返回问题列表供工具如实告诉 AI。
 */
export function resolveEffectParams(template: EffectTemplate, input: Record<string, unknown>): { params: Record<string, string | number>; issues: string[] } {
  const params: Record<string, string | number> = {};
  const issues: string[] = [];
  for (const param of template.params) {
    const value = input[param.key];
    if (value === undefined || value === null) { params[param.key] = param.default; continue; }
    if (param.kind === 'number') {
      const number = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(number)) { issues.push(`${param.key}: not a number, used ${String(param.default)}`); params[param.key] = param.default; continue; }
      const clamped = Math.min(param.max ?? number, Math.max(param.min ?? number, number));
      if (clamped !== number) issues.push(`${param.key}: clamped to ${String(clamped)}`);
      params[param.key] = clamped;
    } else if (param.kind === 'color') {
      const text = String(value);
      if (/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(text) || /^rgba?\([\d\s.,%]+\)$/.test(text)) params[param.key] = text;
      else { issues.push(`${param.key}: use a hex color like #ff8800, used ${String(param.default)}`); params[param.key] = param.default; }
    } else {
      const text = String(value);
      if (param.options?.includes(text) === true) params[param.key] = text;
      else { issues.push(`${param.key}: must be one of ${(param.options ?? []).join(', ')}, used ${String(param.default)}`); params[param.key] = param.default; }
    }
  }
  for (const key of Object.keys(input)) if (!template.params.some((param) => param.key === key)) issues.push(`${key}: not a parameter of ${template.id}, ignored`);
  return { params, issues };
}
