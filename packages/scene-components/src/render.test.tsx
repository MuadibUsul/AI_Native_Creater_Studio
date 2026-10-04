import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ASPECT_RATIO_SIZES, DEFAULT_THEME_TOKENS, sceneRenderContextSchema, type ThemeTokens } from '@ancs/contracts';
import { bigNumberComponent, bigNumberPropsSchema } from './components/big-number.js';
import { registerBuiltInComponents } from './builtin.js';
import { getComponent } from './registry.js';
import { SceneThemeProvider } from './theme.js';

/**
 * P05-01 单元验收（规范 §11.1、§57）：
 * - **每个组件可独立渲染**：fixture / 正常 / 空值三条路径都产出非空标记；
 * - **字体和颜色可由主题控制**：同一组件在两个主题下渲染结果不同，且不残留组件内写死的颜色/字体；
 * - 空值不编造：value=null 显示占位文案；
 * - 注册表解析 → 渲染链路一致（componentVersion 可解析）。
 */

registerBuiltInComponents();

const BigNumberRenderer = bigNumberComponent.renderer;

const renderFixture = (theme?: Partial<ThemeTokens>): string =>
  renderToStaticMarkup(
    <SceneThemeProvider theme={theme}>
      <BigNumberRenderer
        props={bigNumberPropsSchema.parse(bigNumberComponent.previewFixture.props)}
        context={sceneRenderContextSchema.parse({
          frame: 0,
          fps: 30,
          durationMs: 6000,
          ...ASPECT_RATIO_SIZES['16:9'],
          aspectRatio: '16:9',
        })}
      />
    </SceneThemeProvider>,
  );

describe('组件独立渲染与主题控制（§57）', () => {
  it('fixture 可直接渲染（非空标记 + 数值 + 来源标注）', () => {
    const markup = renderFixture();
    expect(markup.length).toBeGreaterThan(50);
    expect(markup).toContain('5.25%');
    expect(markup).toContain('联邦基金利率');
    expect(markup).toContain('来源：');
    expect(markup).toContain('data-component="BIG_NUMBER"');
  });

  it('字体和颜色由主题控制（同一组件、两个主题 → 输出不同且使用主题值）', () => {
    const themeA = {
      font: { heading: 'Font-A', body: 'Font-B' },
      color: { accent: '#111111', background: '#222222', foreground: '#333333', positive: '#11aa11', negative: '#aa1111' },
    };
    const themeB = {
      font: { heading: 'Font-C', body: 'Font-D' },
      color: { accent: '#aaaaaa', background: '#bbbbbb', foreground: '#cccccc', positive: '#aaeeaa', negative: '#eeaaaa' },
    };
    const markupA = renderFixture(themeA);
    const markupB = renderFixture(themeB);

    expect(markupA).toContain('Font-A');
    expect(markupA).toContain('#222222');
    expect(markupB).toContain('Font-C');
    expect(markupB).toContain('#bbbbbb');
    expect(markupA).not.toBe(markupB);
    // 组件不得写死主题色/字体（全部经 tokens 渲染）
    expect(markupB).not.toContain(DEFAULT_THEME_TOKENS.color.background);
    expect(markupB).not.toContain(DEFAULT_THEME_TOKENS.font.heading);
  });

  it('空值不编造：value=null 显示占位', () => {
    const markup = renderToStaticMarkup(
      <SceneThemeProvider>
        <BigNumberRenderer
          props={bigNumberPropsSchema.parse({ value: null, label: '缺口数据' })}
          context={sceneRenderContextSchema.parse({ frame: 0, fps: 30, durationMs: 3000, ...ASPECT_RATIO_SIZES['9:16'], aspectRatio: '9:16' })}
        />
      </SceneThemeProvider>,
    );
    expect(markup).toContain('数据待补充');
    expect(markup).toContain('缺口数据');
  });

  it('注册表解析出的组件可渲染（注册链路与渲染链路一致）', () => {
    const resolved = getComponent('BIG_NUMBER');
    expect(resolved).not.toBeNull();
    if (resolved === null) return;
    const RegisteredRenderer = resolved.renderer;
    const markup = renderToStaticMarkup(
      <SceneThemeProvider>
        <RegisteredRenderer
          props={resolved.inputSchema.parse({ value: '42', label: '答案' }) as never}
          context={sceneRenderContextSchema.parse({ frame: 0, fps: 30, durationMs: 3000, ...ASPECT_RATIO_SIZES['1:1'], aspectRatio: '1:1' })}
        />
      </SceneThemeProvider>,
    );
    expect(markup).toContain('42');
  });
});
