import { describe, expect, it } from 'vitest';
import { effectTemplateSchema } from '@ancs/contracts';
import { EFFECT_TEMPLATES, findEffectTemplate, resolveEffectParams } from './effect-templates.js';
import { effectLayerSize, effectRegionTransform } from './agent-effects.js';

/**
 * V6-3 特效模板库与参数（纯函数）：模板形状、参数取值（夹取/校验/缺省/未知键如实报告）、图层尺寸与区域变换。
 * 模板代码过四道门禁见 apps/motion-worker/src/effect-templates.test.ts；真实透明渲染见 apps/render-worker/src/effect-render.test.ts。
 */
describe('特效模板库', () => {
  it('每个模板形状合法、id 唯一、默认参数不需要任何修正、代码遵守注册契约', () => {
    expect(EFFECT_TEMPLATES.length).toBeGreaterThanOrEqual(6);
    expect(new Set(EFFECT_TEMPLATES.map((template) => template.id)).size).toBe(EFFECT_TEMPLATES.length);
    for (const template of EFFECT_TEMPLATES) {
      expect(effectTemplateSchema.parse(template)).toEqual(template);
      const defaults = Object.fromEntries(template.params.map((param) => [param.key, param.default]));
      expect(resolveEffectParams(template, defaults)).toEqual({ params: defaults, issues: [] });
      expect(template.code).toMatch(/registerMotion\(\{\s*name: '/);
      expect(template.code).not.toMatch(/\b(import|require|fetch|eval|Function|window|document|setTimeout)\b/);
    }
    expect(findEffectTemplate('burst')?.name).toEqual({ 'zh-CN': '爆炸', en: 'Burst' });
    expect(findEffectTemplate('nope')).toBeUndefined();
  });

  it('参数取值：数字夹取、颜色与选项校验、缺省用默认值、未知键忽略并如实报告', () => {
    const burst = findEffectTemplate('burst')!;
    expect(resolveEffectParams(burst, { size: 9, intensity: '0.5', color: 'red', extra: 1 })).toEqual({
      params: { color: '#ff6a00', color2: '#ffd25a', size: 1.6, intensity: 0.5 },
      issues: ['color: use a hex color like #ff8800, used #ff6a00', 'size: clamped to 1.6', 'extra: not a parameter of burst, ignored'],
    });
    expect(resolveEffectParams(burst, { color: 'rgba(255, 0, 0, 0.5)', size: 'big' }).params).toMatchObject({ color: 'rgba(255, 0, 0, 0.5)', size: 1 });
    const leak = findEffectTemplate('light-leak')!;
    expect(resolveEffectParams(leak, { direction: 'up' })).toMatchObject({ params: { direction: 'left' }, issues: ['direction: must be one of left, right, used left'] });
    expect(resolveEffectParams(leak, { direction: 'right' }).issues).toEqual([]);
  });

  it('图层尺寸：区域在画布上的像素、最长边不超过 960、偶数；区域变换 = 中心锚点 + 区域尺寸 + 左上角位移', () => {
    expect(effectLayerSize('16:9', { x: 0, y: 0, width: 1, height: 1 })).toEqual({ width: 960, height: 540 });
    expect(effectLayerSize('9:16', { x: 0, y: 0, width: 1, height: 1 })).toEqual({ width: 540, height: 960 });
    expect(effectLayerSize('16:9', { x: 0.1, y: 0.1, width: 0.25, height: 0.25 })).toEqual({ width: 480, height: 270 });
    expect(effectLayerSize('1:1', { x: 0, y: 0, width: 0.001, height: 0.001 })).toEqual({ width: 16, height: 16 });
    expect(effectLayerSize('unknown', { x: 0, y: 0, width: 0.5, height: 0.5 })).toEqual({ width: 960, height: 540 });
    expect(effectRegionTransform({ x: 0.5, y: 0.25, width: 0.4, height: 0.5 })).toEqual({ position: { x: 0.5, y: 0.25 }, scale: { x: 0.4, y: 0.5 }, rotationDeg: 0, anchor: { x: 0.5, y: 0.5 } });
  });
});
