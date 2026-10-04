import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { timelineOf } from '@ancs/remotion-core';
import { PreviewPlayer } from './PreviewPlayer';
import { mockClient, renderWithClient } from '@/test-utils.js';

/**
 * P05-04 验收（预览）：
 * - Remotion Player 消费 Scene Graph：帧数/时长来自 timeline（与成片同一映射）；
 * - 画面是帧的纯函数：首帧渲染对应场景的**真实组件**（同源注册表）；
 * - 素材缺失/解析失败 → 明确占位（Draft 占位策略），不静默空白；
 * - **编辑不会隐式触发昂贵视频调用**：预览路径只访问只读查询与编辑协议命名空间
 *   （记录 SDK 访问清单；触碰 jobs/billing/generations 即失败）。
 */

const scene = (overrides: Record<string, unknown> = {}) => ({
  id: 'scn_1',
  revision: 1,
  position: 0,
  startMs: 0,
  durationMs: 4000,
  semanticType: 'PRICE_SERIES',
  sceneType: 'LINE_CHART',
  narrationBlockIds: [],
  narration: '利率路径',
  visualIntent: '',
  componentId: null,
  componentVersion: null,
  props: {
    title: '联邦基金利率路径',
    unit: '%',
    series: [{ name: '利率', points: [{ t: '2023', v: 4.5 }, { t: '2024', v: 5.25 }] }],
    sourceLabel: '示例数据集',
  },
  providerRequirement: null,
  sourceBindings: [],
  dataBindings: [],
  assetBindings: [],
  transition: { in: null, out: null },
  locked: false,
  approved: false,
  needsReview: false,
  status: 'DRAFT',
  ...overrides,
});

const graph = (scenes: unknown[], durationMs = 4000) => ({
  format: { width: 1920, height: 1080, fps: 30, aspectRatio: '16:9' },
  timeline: { durationMs },
  scenes,
});

describe('PreviewPlayer（Remotion Player 消费 Graph）', () => {
  it('帧数/时长按 timeline 绝对边界换算（与成片同一模块）', async () => {
    const g = graph([scene({ durationMs: 4000 }), scene({ id: 'scn_2', position: 1, startMs: 4000, durationMs: 2000 })], 6000);
    const timing = timelineOf(g as never);
    renderWithClient(<PreviewPlayer graph={g as never} />, mockClient({}));
    expect(await screen.findByTestId('preview-player')).toBeTruthy();
    expect(screen.getByText(`${String(timing.durationInFrames)} 帧 · 30fps · 6000 ms · 预览为本地渲染（不触发 Provider 调用）`)).toBeTruthy();
  });

  it('首帧渲染对应场景的真实组件（同源注册表，非占位空屏）', async () => {
    renderWithClient(<PreviewPlayer graph={graph([scene()]) as never} />, mockClient({}));
    // Remotion Player 需在布局后挂载合成；等待首帧内容出现
    await waitFor(() => expect(screen.getByText('联邦基金利率路径')).toBeTruthy(), { timeout: 5000 });
  });

  it('素材缺失 → 组件明确占位（不静默空白）；解析成功 → 注入 assetUrl 渲染画面', async () => {
    const mediaScene = (assetUrl: string | null) => ({
      ...scene({
        sceneType: 'IMAGE_FULL',
        semanticType: 'IMAGE_EVIDENCE',
        props: { assetId: 'ast_1', assetUrl, headline: null, caption: null, sourceLabel: null },
        assetBindings: [{ assetId: 'ast_1', role: 'visual' }],
      }),
    });

    // 缺失（未解析）：占位
    const missing = renderWithClient(<PreviewPlayer graph={graph([mediaScene(null)]) as never} />, mockClient({}));
    await waitFor(() => expect(document.querySelector('[data-role="placeholder"]')).toBeTruthy(), { timeout: 5000 });
    expect(document.querySelector('[data-role="media-image"]')).toBeNull();
    missing.unmount();

    // 解析成功：注入 URL 后渲染 <img>（预览不等于成片落盘；URL 由资产系统签发）
    renderWithClient(
      <PreviewPlayer graph={graph([mediaScene('http://localhost:9000/objects/signed/cover.png')]) as never} />,
      mockClient({}),
    );
    await waitFor(() => {
      const image = document.querySelector('[data-role="media-image"]');
      expect(image?.getAttribute('src')).toBe('http://localhost:9000/objects/signed/cover.png');
    }, { timeout: 5000 });
  });

  it('编辑不隐式触发昂贵调用：预览路径的 SDK 访问清单只含只读查询与编辑协议', async () => {
    const accessed: string[] = [];
    // 场景带素材绑定：预览的素材解析（downloadUrl）也应只走只读查询
    const graphFn = vi.fn().mockResolvedValue(graph([scene({ assetBindings: [{ assetId: 'ast_1', role: 'visual' }] })]));
    const editFn = vi.fn().mockResolvedValue({ project: { revision: 2 }, scenes: [], editEvents: [] });
    const downloadFn = vi.fn().mockResolvedValue({ url: 'http://localhost:9000/objects/signed/cover.png' });
    const base: Record<string, unknown> = {
      projects: { graph: graphFn, edit: editFn },
      assets: { downloadUrl: downloadFn },
    };
    const client = new Proxy(base, {
      get(target, prop) {
        accessed.push(String(prop));
        if (prop in target) return target[prop as string];
        // 触碰预览路径之外的命名空间（jobs/billing/generations/providerConnections…）即失败
        throw new Error(`预览路径不得访问 SDK 命名空间：${String(prop)}`);
      },
    }) as never;

    const { StoryboardHarness } = await import('./preview-harness.js');
    renderWithClient(<StoryboardHarness client={client} />, client);
    await waitFor(() => expect(graphFn).toHaveBeenCalled());
    await userEvent.click(await screen.findByRole('button', { name: '模拟编辑（时长微调）' }));
    await waitFor(() => expect(editFn).toHaveBeenCalledTimes(1));

    // 允许的访问面：只读查询 + 编辑协议（不含任何生成/计费/任务命名空间）
    expect(new Set(accessed)).toEqual(new Set(['projects', 'assets']));
  });
});
