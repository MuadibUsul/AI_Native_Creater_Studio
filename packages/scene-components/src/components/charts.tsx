import type { ReactElement } from 'react';
import { z } from 'zod';
import { ChartFrame } from '../charts.js';
import { defineComponent, type ComponentRenderInput } from '../protocol.js';
import { fitFontSize, Headline, Placeholder, SceneRoot, SourceLabel } from '../primitives.js';
import { useSceneTheme } from '../theme.js';

/**
 * 数据类组件（P05-02）：KPI_GRID / LINE_CHART / DUAL_LINE_CHART / BAR_CHART / SPREAD_AREA_CHART。
 *
 * 纪律：数据点**只能来自 props（Scene.dataBindings → dataset）**；空数据一律占位，
 * 绝不补造数列/平滑外推（§10.3）；数值原样标注。
 */

const pointSchema = z.object({ t: z.string().min(1), v: z.number() });
const seriesSchema = z.object({
  name: z.string().min(1).max(80),
  points: z.array(pointSchema).default([]),
});

const chartCommon = {
  title: z.string().max(120).default(''),
  unit: z.string().max(20).default(''),
  series: z.array(seriesSchema).default([]),
  sourceLabel: z.string().max(200).nullable().default(null),
};

export const lineChartPropsSchema = z.object(chartCommon);
export type LineChartProps = z.infer<typeof lineChartPropsSchema>;

export const dualLineChartPropsSchema = z.object(chartCommon);
export type DualLineChartProps = z.infer<typeof dualLineChartPropsSchema>;

export const barChartPropsSchema = z.object(chartCommon);
export type BarChartProps = z.infer<typeof barChartPropsSchema>;

export const spreadAreaChartPropsSchema = z.object(chartCommon);
export type SpreadAreaChartProps = z.infer<typeof spreadAreaChartPropsSchema>;

const hasData = (series: readonly { points: { t: string; v: number }[] }[]): boolean =>
  series.length > 0 && series.some((item) => item.points.length > 0);

function ChartScene(props: LineChartProps & { mode: 'line' | 'dual' | 'bar' | 'spread' }): ReactElement {
  return (
    <SceneRoot>
      {props.title === '' ? null : <Headline text={props.title} maxFontSize={64} />}
      <div style={{ marginTop: 24, width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
        {hasData(props.series) ? (
          <ChartFrame series={props.series} mode={props.mode} unit={props.unit} showLegend={props.mode === 'dual' || props.mode === 'spread'} />
        ) : (
          <Placeholder text="数据待补充" detail="图表只呈现已绑定数据集；缺失时不得由 AI 编造" />
        )}
        <SourceLabel label={props.sourceLabel} />
      </div>
    </SceneRoot>
  );
}

export function LineChartScene(input: ComponentRenderInput<LineChartProps>): ReactElement {
  return <ChartScene {...input.props} mode="line" />;
}
export function DualLineChartScene(input: ComponentRenderInput<DualLineChartProps>): ReactElement {
  return <ChartScene {...input.props} mode="dual" />;
}
export function BarChartScene(input: ComponentRenderInput<BarChartProps>): ReactElement {
  return <ChartScene {...input.props} mode="bar" />;
}
export function SpreadAreaChartScene(input: ComponentRenderInput<SpreadAreaChartProps>): ReactElement {
  return <ChartScene {...input.props} mode="spread" />;
}

const chartFixtureProps = (): Record<string, unknown> => ({
  title: '联邦基金利率路径',
  unit: '%',
  series: [
    {
      name: '联邦基金利率',
      points: [
        { t: '2023', v: 4.5 },
        { t: '2024', v: 5.25 },
        { t: '2025', v: 4.0 },
      ],
    },
  ],
  sourceLabel: '示例数据集（anchor 数据点）',
});

export const lineChartComponent = defineComponent({
  type: 'LINE_CHART',
  version: '1.0.0',
  title: '折线图',
  description: '单序列时间趋势（数据来自绑定数据集；空数据占位）',
  inputSchema: lineChartPropsSchema,
  defaults: { title: '', unit: '', series: [], sourceLabel: null },
  supportedAspectRatios: ['16:9', '9:16', '1:1', '4:5'],
  minDurationMs: 3000,
  maxDurationMs: 30_000,
  previewFixture: { props: chartFixtureProps(), durationMs: 8000, aspectRatio: '16:9', note: '正常值：3 个真实数据点' },
  renderer: LineChartScene,
});

export const dualLineChartComponent = defineComponent({
  type: 'DUAL_LINE_CHART',
  version: '1.0.0',
  title: '双线对比',
  description: '两条序列同轴对比（legend；空数据占位）',
  inputSchema: dualLineChartPropsSchema,
  defaults: { title: '', unit: '', series: [], sourceLabel: null },
  supportedAspectRatios: ['16:9', '1:1'],
  minDurationMs: 3000,
  maxDurationMs: 30_000,
  previewFixture: {
    props: {
      title: '利率与通胀',
      unit: '%',
      series: [
        { name: '联邦基金利率', points: [{ t: '2023', v: 4.5 }, { t: '2024', v: 5.25 }, { t: '2025', v: 4.0 }] },
        { name: '核心 PCE', points: [{ t: '2023', v: 4.1 }, { t: '2024', v: 2.8 }, { t: '2025', v: 2.4 }] },
      ],
      sourceLabel: '示例数据集',
    },
    durationMs: 8000,
    aspectRatio: '16:9',
    note: '正常值：两条序列',
  },
  renderer: DualLineChartScene,
});

export const barChartComponent = defineComponent({
  type: 'BAR_CHART',
  version: '1.0.0',
  title: '柱状图',
  description: '类别对比（柱=真实数据点；空数据占位）',
  inputSchema: barChartPropsSchema,
  defaults: { title: '', unit: '', series: [], sourceLabel: null },
  supportedAspectRatios: ['16:9', '9:16', '1:1', '4:5'],
  minDurationMs: 3000,
  maxDurationMs: 30_000,
  previewFixture: {
    props: {
      title: '各机构预测降息幅度',
      unit: 'bp',
      series: [
        {
          name: '预测',
          points: [
            { t: 'A 银行', v: 50 },
            { t: 'B 银行', v: 75 },
            { t: 'C 银行', v: 25 },
            { t: 'D 银行', v: 100 },
          ],
        },
      ],
      sourceLabel: '示例数据集',
    },
    durationMs: 8000,
    aspectRatio: '16:9',
    note: '正常值：4 个类别',
  },
  renderer: BarChartScene,
});

export const spreadAreaChartComponent = defineComponent({
  type: 'SPREAD_AREA_CHART',
  version: '1.0.0',
  title: '利差面积图',
  description: '两条序列之差以面积呈现（§10.1 财经 YIELD_SPREAD；空数据占位）',
  inputSchema: spreadAreaChartPropsSchema,
  defaults: { title: '', unit: '', series: [], sourceLabel: null },
  supportedAspectRatios: ['16:9', '1:1'],
  minDurationMs: 3000,
  maxDurationMs: 30_000,
  previewFixture: {
    props: {
      title: '10 年期利差',
      unit: '%',
      series: [
        { name: '美国', points: [{ t: '2023', v: 3.9 }, { t: '2024', v: 4.5 }, { t: '2025', v: 4.2 }] },
        { name: '德国', points: [{ t: '2023', v: 2.3 }, { t: '2024', v: 2.4 }, { t: '2025', v: 2.5 }] },
      ],
      sourceLabel: '示例数据集',
    },
    durationMs: 8000,
    aspectRatio: '16:9',
    note: '正常值：利差面积',
  },
  renderer: SpreadAreaChartScene,
});

/** KPI_GRID：多指标网格（数值逐字来自 props）。 */
export const kpiGridPropsSchema = z.object({
  title: z.string().max(120).default(''),
  items: z
    .array(
      z.object({
        label: z.string().max(80),
        value: z.string().nullable().default(null),
        direction: z.enum(['UP', 'DOWN', 'FLAT']).nullable().default(null),
      }),
    )
    .default([]),
  sourceLabel: z.string().max(200).nullable().default(null),
});
export type KpiGridProps = z.infer<typeof kpiGridPropsSchema>;

export function KpiGridScene({ props }: ComponentRenderInput<KpiGridProps>): ReactElement {
  const theme = useSceneTheme();
  const valueColor = (direction: 'UP' | 'DOWN' | 'FLAT' | null): string =>
    direction === 'UP' ? theme.color.positive : direction === 'DOWN' ? theme.color.negative : theme.color.accent;
  return (
    <SceneRoot>
      {props.title === '' ? null : <Headline text={props.title} maxFontSize={64} />}
      <div style={{ marginTop: 40, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 24, width: '100%' }}>
        {props.items.length === 0 ? (
          <Placeholder text="指标待补充" />
        ) : (
          <div data-role="kpi-grid" style={{ display: 'grid', gridTemplateColumns: `repeat(${String(Math.min(props.items.length, 3))}, minmax(0, 1fr))`, gap: theme.spacing.lg, width: '100%', maxWidth: 1500 }}>
            {props.items.map((item, index) => (
              <div
                key={`${item.label}-${String(index)}`}
                data-role="kpi-item"
                style={{
                  backgroundColor: `${theme.color.foreground}0D`,
                  border: `2px solid ${theme.color.accent}44`,
                  borderRadius: theme.radius.md,
                  padding: theme.spacing.lg,
                  fontFamily: theme.font.body,
                }}
              >
                <div style={{ fontSize: 30, opacity: 0.75 }}>{item.label}</div>
                <div
                  style={{
                    fontSize: fitFontSize(item.value ?? '—', { max: 88, min: 30, comfortableChars: 9 }),
                    fontWeight: 700,
                    fontFamily: theme.font.heading,
                    color: valueColor(item.direction),
                    marginTop: theme.spacing.sm,
                    wordBreak: 'break-all',
                  }}
                >
                  {item.value ?? '—'}
                </div>
              </div>
            ))}
          </div>
        )}
        <SourceLabel label={props.sourceLabel} />
      </div>
    </SceneRoot>
  );
}

export const kpiGridComponent = defineComponent({
  type: 'KPI_GRID',
  version: '1.0.0',
  title: '指标网格',
  description: '多个关键指标的网格呈现（数值逐字来自事实；空值显示占位横线）',
  inputSchema: kpiGridPropsSchema,
  defaults: { title: '', items: [], sourceLabel: null },
  supportedAspectRatios: ['16:9', '9:16', '1:1', '4:5'],
  minDurationMs: 3000,
  maxDurationMs: 30_000,
  previewFixture: {
    props: {
      title: '三项关键指标',
      items: [
        { label: '联邦基金利率', value: '5.25%', direction: 'FLAT' },
        { label: '同比通胀', value: '2.8%', direction: 'DOWN' },
        { label: '失业率', value: '4.2%', direction: 'UP' },
      ],
      sourceLabel: '示例数据集',
    },
    durationMs: 9000,
    aspectRatio: '16:9',
    note: '正常值：3 指标',
  },
  renderer: KpiGridScene,
});
