import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ASPECT_RATIO_SIZES, BUILTIN_SCENE_TYPES, DEFAULT_THEME_TOKENS, EXTENDED_SCENE_TYPES, STANDARD_SCENE_TYPES, sceneRenderContextSchema } from '@ancs/contracts';
import { registerBuiltInComponents } from './builtin.js';
import { assertVariantCoverage, COMPONENT_VARIANT_NAMES, COMPONENT_VARIANTS, type ComponentVariantName } from './fixtures.js';
import { durationStatus, resolveSceneProps, validateComponentDefinition } from './protocol.js';
import { getComponent } from './registry.js';
import { SceneThemeProvider } from './theme.js';

/**
 * P05-02 验收（规范 §11.1、§64/§65；验收：正常/长文本/空值/极值/边界时长均有证据）：
 * - V1 标准 20 类**全部注册**且协议自检通过（missingStandardComponents 为空）；
 * - 每个组件 × 五类变体：props 可解析、可渲染、无未定义文本泄漏；
 * - **空值 → 明确占位**（绝不编造；图表空数据不产生绘制元素）；
 * - **长文本 → 字号自适应**（最大字号不增）；
 * - **极值原样呈现**（不换算）；边界时长在组件允许范围内。
 */

registerBuiltInComponents();
assertVariantCoverage();

const context = sceneRenderContextSchema.parse({
  frame: 15,
  fps: 30,
  durationMs: 6000,
  ...ASPECT_RATIO_SIZES['16:9'],
  aspectRatio: '16:9',
});

const renderVariant = (type: string, variant: ComponentVariantName): string => {
  const definition = getComponent(type);
  if (definition === null) throw new Error(`未注册组件：${type}`);
  const parsed = definition.inputSchema.parse(COMPONENT_VARIANTS[type]?.[variant]?.props ?? {});
  const Renderer = definition.renderer;
  return renderToStaticMarkup(
    <SceneThemeProvider>
      <Renderer props={parsed as never} context={context} />
    </SceneThemeProvider>,
  );
};

const fontSizesIn = (markup: string): number[] => [...markup.matchAll(/font-size:(\d+)px/g)].map((match) => Number(match[1]));

describe('V1 标准 20 类组件全集 + P10-04 扩展 14 类', () => {
  it('全部注册、协议自检通过、无缺口', () => {
    expect(STANDARD_SCENE_TYPES.length).toBe(20);
    expect(EXTENDED_SCENE_TYPES.length).toBe(14);
    for (const type of BUILTIN_SCENE_TYPES) {
      const definition = getComponent(type);
      expect(definition, `${type} 应已注册`).not.toBeNull();
      if (definition === null) continue;
      const validation = validateComponentDefinition(definition);
      expect(validation.ok, `${type}: ${validation.messages.join('；')}`).toBe(true);
      expect(definition.previewFixture.durationMs).toBeGreaterThanOrEqual(definition.minDurationMs);
      if (definition.maxDurationMs !== null) {
        expect(definition.previewFixture.durationMs).toBeLessThanOrEqual(definition.maxDurationMs);
      }
    }
  });
});

describe('五类变体 × 34 组件（标准 20 + 扩展 14；正常/长文本/空值/极值/边界时长）', () => {
  for (const type of BUILTIN_SCENE_TYPES) {
    it(`${type}：变体可解析、可渲染、无泄漏`, () => {
      const definition = getComponent(type);
      expect(definition).not.toBeNull();
      if (definition === null) return;

      const markups = new Map<ComponentVariantName, string>();
      for (const variant of COMPONENT_VARIANT_NAMES) {
        const fixture = COMPONENT_VARIANTS[type]?.[variant];
        expect(fixture, `${type}/${variant} 缺失`).toBeDefined();
        if (fixture === undefined) continue;

        // props 可解析（组件自身 schema）
        const resolution = resolveSceneProps(definition, fixture.props);
        expect(resolution.ok, `${type}/${variant} props 非法：${resolution.ok ? '' : resolution.messages.join('；')}`).toBe(true);

        // 边界时长在允许范围（boundary 取最小；所有变体都须在范围内）
        expect(durationStatus(definition, fixture.durationMs)).toBe('OK');

        const markup = renderVariant(type, variant);
        markups.set(variant, markup);
        expect(markup.length, `${type}/${variant} 渲染为空`).toBeGreaterThan(30);
        // 不泄漏未定义文本
        expect(markup).not.toContain('>undefined<');
        expect(markup).not.toContain('NaN');
        expect(markup).not.toContain('[object Object]');
      }

      // 空值 → 明确占位（统一 data-role="placeholder"）
      expect(markups.get('empty'), `${type} 空值应显示占位`).toContain('data-role="placeholder"');

      // 长文本 → 字号自适应（不超过正常变体的最大字号）
      const normalMax = Math.max(...fontSizesIn(markups.get('normal') ?? ''));
      const longMax = Math.max(...fontSizesIn(markups.get('longText') ?? ''));
      expect(longMax, `${type} 长文本字号不应增大`).toBeLessThanOrEqual(normalMax);

      // 边界时长：最大边界同样合法（null = 无上限）
      if (definition.maxDurationMs !== null) {
        expect(durationStatus(definition, definition.maxDurationMs)).toBe('OK');
      }
      expect(durationStatus(definition, definition.minDurationMs - 1)).toBe('TOO_SHORT');
    });
  }
});

describe('数据类组件的数据纪律（§10.3）', () => {
  it('图表空数据 → 占位且不产生绘制元素（绝不编造数列）', () => {
    for (const type of ['LINE_CHART', 'DUAL_LINE_CHART', 'BAR_CHART', 'SPREAD_AREA_CHART'] as const) {
      const markup = renderVariant(type, 'empty');
      expect(markup).toContain('data-role="placeholder"');
      expect(markup).not.toContain('data-role="chart"');
      expect(markup).not.toContain('data-role="series-line"');
      expect(markup).not.toContain('<path');
      expect(markup).not.toContain('data-role="bar"');
    }
  });

  it('极值原样呈现（不做换算）：巨大值与负值按输入文本/数字绘制', () => {
    const markup = renderVariant('BAR_CHART', 'extreme');
    expect(markup).toContain('data-role="bar"');
    const barCount = [...markup.matchAll(/data-role="bar"/g)].length;
    expect(barCount).toBe(2); // 两个数据点 = 两根柱（不多不少）
  });

  it('KPI 网格缺失单项显示占位横线而非猜测值', () => {
    const markup = renderVariant('KPI_GRID', 'extreme');
    expect(markup).toContain('—');
    expect(markup).toContain('999,999,999.99%');
  });

  it('媒体类未绑定素材 → 明确标识的占位（不冒充真实素材）', () => {
    for (const type of ['IMAGE_FULL', 'REAL_BROLL', 'HOST_FULL'] as const) {
      const markup = renderVariant(type, 'empty');
      expect(markup).toContain('data-role="placeholder"');
      expect(markup).not.toContain('data-role="media-image"');
    }
    expect(renderVariant('REAL_BROLL', 'empty')).toContain('不得用 AI 画面冒充');
  });

  it('主题控制对全部组件生效（换主题 → 全部输出变化）', () => {
    const magenta = {
      color: { background: '#FF00FF', foreground: '#00FF00', accent: '#0000FF', positive: '#FFFF00', negative: '#00FFFF' },
      font: { heading: 'Georgia, serif', body: 'Georgia, serif' },
    };
    for (const type of STANDARD_SCENE_TYPES) {
      const definition = getComponent(type);
      if (definition === null) continue;
      const props = definition.inputSchema.parse(COMPONENT_VARIANTS[type]?.['normal']?.props ?? {});
      const Renderer = definition.renderer;
      const themed = renderToStaticMarkup(
        <SceneThemeProvider theme={magenta}>
          <Renderer props={props as never} context={context} />
        </SceneThemeProvider>,
      );
      expect(themed, `${type} 应受主题控制`).not.toContain(DEFAULT_THEME_TOKENS.color.background);
      expect(themed, `${type} 应使用主题字体`).toContain('Georgia, serif');
    }
  });
});

describe('P10-04 扩展组件行为（数据纪律与语义）', () => {
  const renderProps = (type: string, rawProps: Record<string, unknown>, durationMs = 6000): string => {
    const definition = getComponent(type);
    if (definition === null) throw new Error(`未注册组件：${type}`);
    const parsed = definition.inputSchema.parse(rawProps);
    const Renderer = definition.renderer;
    const renderContext = sceneRenderContextSchema.parse({ frame: 15, fps: 30, durationMs, ...ASPECT_RATIO_SIZES['16:9'], aspectRatio: '16:9' });
    return renderToStaticMarkup(
      <SceneThemeProvider>
        <Renderer props={parsed as never} context={renderContext} />
      </SceneThemeProvider>,
    );
  };

  it('STACKED_BAR_CHART：含负值或列数不一致 → 占位（不绘制错误图形）', () => {
    const negative = renderProps('STACKED_BAR_CHART', {
      title: '含负值',
      series: [
        { name: 'A', points: [{ t: 'x', v: -5 }] },
        { name: 'B', points: [{ t: 'x', v: 3 }] },
      ],
    });
    expect(negative).toContain('data-role="placeholder"');
    expect(negative).not.toContain('data-role="stacked-bar"');

    const mismatch = renderProps('STACKED_BAR_CHART', {
      title: '列数不一致',
      series: [
        { name: 'A', points: [{ t: 'x', v: 1 }, { t: 'y', v: 2 }] },
        { name: 'B', points: [{ t: 'x', v: 3 }] },
      ],
    });
    expect(mismatch).not.toContain('data-role="stacked-bar"');
  });

  it('AREA_CHART：有数据时绘制面积填充且保留系列折线', () => {
    const markup = renderVariant('AREA_CHART', 'normal');
    expect(markup).toContain('data-role="area-fill"');
    expect(markup).toContain('data-role="series-line"');
  });

  it('PERCENT_DELTA：符号语义正确（上升 ▲ / 下降 ▼ / 持平 —），数值原样呈现', () => {
    expect(renderVariant('PERCENT_DELTA', 'normal')).toContain('▲');
    expect(renderVariant('PERCENT_DELTA', 'boundary')).toContain('—');

    const down = renderProps('PERCENT_DELTA', { label: '下降', valuePercent: -12.5 });
    expect(down).toContain('▼');
    expect(down).toContain('-12.5');
  });

  it('地图类组件明确标注"非真实地理投影"（不以地图外观冒充真实地理）', () => {
    expect(renderVariant('MAP_ZOOM', 'normal')).toContain('非真实地理投影');
    expect(renderVariant('MAP_FLOW', 'normal')).toContain('非真实地理投影');
  });

  it('实体组件：无事实字段 → 明确占位（不推算）', () => {
    expect(renderVariant('PERSON_PROFILE', 'boundary')).toContain('data-role="placeholder"');
  });
});
