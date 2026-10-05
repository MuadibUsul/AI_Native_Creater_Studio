import type { ReactElement } from 'react';
import { z } from 'zod';
import { ChartFrame, stackedSeriesRenderable, type ChartSeries } from '../charts.js';
import { defineComponent, type ComponentRenderInput } from '../protocol.js';
import { BodyText, CardShell, Headline, Kicker, Placeholder, SceneRoot, SourceLabel } from '../primitives.js';
import { useSceneTheme } from '../theme.js';

/**
 * P10-04 组件扩展（规范 §10.2 补全）：Host 变体 / 数值对比 / 面积·堆叠图 / Process / Map Flow·Zoom / 实体组件。
 *
 * 纪律（与 P05-02 一致）：
 * - **数据类组件只呈现已绑定数据**（空数据 → 明确占位，绝不补造数列/增幅——§10.3）；
 * - 地图类为**示意**（明确标注"非真实地理投影"，位置由作者显式给出——不以地图外观冒充真实地理）；
 * - 实体组件（Person/Company/Country/LogoWall）只呈现显式给出的事实字段与其 source label；
 * - 布局变体以 props（layout/columns/position）表达，预览与成片一致。
 */

const sourceLabelCommon = { sourceLabel: z.string().max(200).nullable().default(null) };
const titleCommon = { title: z.string().max(120).default('') };

/* ---------- Charts：AREA_CHART / STACKED_BAR_CHART ---------- */

const pointSchema = z.object({ t: z.string().min(1), v: z.number() });
const seriesSchema = z.object({ name: z.string().min(1).max(80), points: z.array(pointSchema).default([]) });
const chartCommon = { ...titleCommon, unit: z.string().max(20).default(''), series: z.array(seriesSchema).default([]), ...sourceLabelCommon };

export const areaChartPropsSchema = z.object(chartCommon);
export type AreaChartProps = z.infer<typeof areaChartPropsSchema>;
export const stackedBarChartPropsSchema = z.object(chartCommon);
export type StackedBarChartProps = z.infer<typeof stackedBarChartPropsSchema>;

const hasData = (series: readonly ChartSeries[]): boolean => series.length > 0 && series.some((item) => item.points.length > 0);

function ExtendedChartScene(props: AreaChartProps & { mode: 'area' | 'stacked' }): ReactElement {
  return (
    <SceneRoot>
      {props.title === '' ? null : <Headline text={props.title} maxFontSize={64} />}
      <div style={{ marginTop: 24, width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
        {props.mode === 'stacked' && hasData(props.series) && !stackedSeriesRenderable(props.series) ? (
          <Placeholder text="数据不满足堆叠条件" detail="堆叠图要求各系列列数一致且无负值（当前数据不满足）——不绘制错误图形，请修复数据或改用其它图表" />
        ) : hasData(props.series) ? (
          <ChartFrame series={props.series} mode={props.mode} unit={props.unit} showLegend={props.mode === 'stacked'} />
        ) : (
          <Placeholder
            text="数据待补充"
            detail={props.mode === 'stacked' ? '堆叠图只呈现已绑定数据集（列数需一致且无负值）；缺失时不得由 AI 编造' : '图表只呈现已绑定数据集；缺失时不得由 AI 编造'}
          />
        )}
        <SourceLabel label={props.sourceLabel} />
      </div>
    </SceneRoot>
  );
}

export const AreaChartScene = (input: ComponentRenderInput<AreaChartProps>): ReactElement => <ExtendedChartScene {...input.props} mode="area" />;
export const StackedBarChartScene = (input: ComponentRenderInput<StackedBarChartProps>): ReactElement => <ExtendedChartScene {...input.props} mode="stacked" />;

const areaFixture = (): Record<string, unknown> => ({
  title: '累计订阅数',
  unit: '万',
  series: [{ name: '订阅数', points: [{ t: '2024', v: 12 }, { t: '2025', v: 31 }, { t: '2026', v: 58 }] }],
  sourceLabel: '示例数据集（anchor 数据点）',
});
const stackedFixture = (): Record<string, unknown> => ({
  title: '收入结构（按业务线）',
  unit: '万',
  series: [
    { name: '订阅', points: [{ t: '2024', v: 60 }, { t: '2025', v: 95 }] },
    { name: '广告', points: [{ t: '2024', v: 25 }, { t: '2025', v: 38 }] },
    { name: '授权', points: [{ t: '2024', v: 10 }, { t: '2025', v: 22 }] },
  ],
  sourceLabel: '示例数据集（anchor 数据点）',
});

export const areaChartComponent = defineComponent({
  type: 'AREA_CHART',
  version: '1.0.0',
  title: '面积图',
  description: '单/多序列面积趋势（数据来自绑定数据集；基线 0；空数据占位）',
  inputSchema: areaChartPropsSchema,
  defaults: { title: '', unit: '', series: [], sourceLabel: null },
  supportedAspectRatios: ['16:9', '9:16', '1:1', '4:5'],
  minDurationMs: 3000,
  maxDurationMs: 30_000,
  previewFixture: { props: areaFixture(), durationMs: 8000, aspectRatio: '16:9', note: '正常值：3 个真实数据点（面积填充）' },
  renderer: AreaChartScene,
});

export const stackedBarChartComponent = defineComponent({
  type: 'STACKED_BAR_CHART',
  version: '1.0.0',
  title: '堆叠柱状图',
  description: '多序列堆叠柱（列数一致且无负值；含 0 基线；不满足条件时占位——不绘制错误图形）',
  inputSchema: stackedBarChartPropsSchema,
  defaults: { title: '', unit: '', series: [], sourceLabel: null },
  supportedAspectRatios: ['16:9', '1:1'],
  minDurationMs: 3000,
  maxDurationMs: 30_000,
  previewFixture: { props: stackedFixture(), durationMs: 9000, aspectRatio: '16:9', note: '正常值：3 系列 × 2 列堆叠' },
  renderer: StackedBarChartScene,
});

/* ---------- 数值对比：NUMBER_COMPARE / PERCENT_DELTA ---------- */

export const numberComparePropsSchema = z.object({
  ...titleCommon,
  /** 对比项（2–4 项；数值显式给出——不推算） */
  items: z
    .array(z.object({ label: z.string().min(1).max(60), value: z.number(), unit: z.string().max(20).default(''), note: z.string().max(80).nullable().default(null) }))
    .max(4)
    .default([]),
  /** 布局变体：row（横排）/ column（纵排） */
  layout: z.enum(['row', 'column']).default('row'),
  /** 高亮项（标注"领先/基准"由调用方给出；null = 无高亮） */
  highlightIndex: z.number().int().min(0).max(3).nullable().default(null),
  ...sourceLabelCommon,
});
export type NumberCompareProps = z.infer<typeof numberComparePropsSchema>;

export function NumberCompareScene({ props }: ComponentRenderInput<NumberCompareProps>): ReactElement {
  const theme = useSceneTheme();
  return (
    <SceneRoot>
      {props.title === '' ? null : <Headline text={props.title} maxFontSize={64} />}
      <div style={{ marginTop: 32, width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        {props.items.length < 2 ? (
          <Placeholder text="对比数据待补充" detail="数值对比需要 2–4 项显式数值；缺失时不得由 AI 推算" />
        ) : (
          <div
            data-role="number-compare"
            data-layout={props.layout}
            style={{ display: 'flex', flexDirection: props.layout === 'row' ? 'row' : 'column', gap: theme.spacing.lg, alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap' }}
          >
            {props.items.map((item, index) => (
              <CardShell
                key={`${item.label}-${String(index)}`}
                style={{
                  minWidth: props.layout === 'row' ? 320 : 480,
                  borderColor: props.highlightIndex === index ? theme.color.accent : undefined,
                }}
              >
                <div data-role="compare-item" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 30, opacity: 0.85 }}>{item.label}</span>
                  <span style={{ fontSize: 96, fontWeight: 700, color: props.highlightIndex === index ? theme.color.accent : theme.color.foreground }}>
                    {`${item.value.toLocaleString('en-US')}${item.unit}`}
                  </span>
                  {item.note === null ? null : <span style={{ fontSize: 26, opacity: 0.75 }}>{item.note}</span>}
                </div>
              </CardShell>
            ))}
          </div>
        )}
        <div style={{ marginTop: 24 }}>
          <SourceLabel label={props.sourceLabel} />
        </div>
      </div>
    </SceneRoot>
  );
}

export const percentDeltaPropsSchema = z.object({
  /** 指标名（空 = 明确占位） */
  label: z.string().max(80).default(''),
  /** 变化百分比（显式输入；正=上升、负=下降、0=持平——组件只呈现符号语义；label 空则占位） */
  valuePercent: z.number().default(0),
  /** 比较口径说明（如"同比"、"环比 2025Q4"） */
  comparison: z.string().max(60).default(''),
  note: z.string().max(120).nullable().default(null),
  ...sourceLabelCommon,
});
export type PercentDeltaProps = z.infer<typeof percentDeltaPropsSchema>;

export function PercentDeltaScene({ props }: ComponentRenderInput<PercentDeltaProps>): ReactElement {
  const theme = useSceneTheme();
  const direction = props.valuePercent > 0 ? 'up' : props.valuePercent < 0 ? 'down' : 'flat';
  const color = direction === 'up' ? theme.color.positive : direction === 'down' ? theme.color.negative : theme.color.foreground;
  const arrow = direction === 'up' ? '▲' : direction === 'down' ? '▼' : '—';
  const formatted = `${props.valuePercent > 0 ? '+' : ''}${props.valuePercent.toFixed(1)}%`;
  return (
    <SceneRoot>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18 }}>
        {props.label === '' ? (
          <Placeholder text="指标待补充" detail="百分比变化需要显式指标名与数值" />
        ) : (
          <Kicker text={props.label} />
        )}
        <div data-role="percent-delta" data-direction={direction} style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
          <span style={{ fontSize: 84, color }}>{arrow}</span>
          <span style={{ fontSize: 160, fontWeight: 800, color }}>{formatted}</span>
        </div>
        {props.comparison === '' ? null : <BodyText text={props.comparison} maxFontSize={38} />}
        {props.note === null ? null : <BodyText text={props.note} maxFontSize={30} />}
        <SourceLabel label={props.sourceLabel} />
      </div>
    </SceneRoot>
  );
}

export const numberCompareComponent = defineComponent({
  type: 'NUMBER_COMPARE',
  version: '1.0.0',
  title: '数值对比',
  description: '2–4 项数值对比卡（row/column 布局变体；数值显式给出，不推算）',
  inputSchema: numberComparePropsSchema,
  defaults: { title: '', items: [], layout: 'row', highlightIndex: null, sourceLabel: null },
  supportedAspectRatios: ['16:9', '9:16', '1:1', '4:5'],
  minDurationMs: 2500,
  maxDurationMs: 20_000,
  previewFixture: {
    props: {
      title: '季度收入对比',
      items: [
        { label: 'Q1', value: 120, unit: '万', note: null },
        { label: 'Q2', value: 158, unit: '万', note: '新高' },
        { label: 'Q3', value: 149, unit: '万', note: null },
      ],
      layout: 'row',
      highlightIndex: 1,
      sourceLabel: '示例数据集',
    },
    durationMs: 7000,
    aspectRatio: '16:9',
    note: '正常值：3 项对比（Q2 高亮）',
  },
  renderer: NumberCompareScene,
});

export const percentDeltaComponent = defineComponent({
  type: 'PERCENT_DELTA',
  version: '1.0.0',
  title: '百分比变化',
  description: '单一百分比变化（↑/↓/持平；比较口径可标注；显式数值）',
  inputSchema: percentDeltaPropsSchema,
  defaults: { label: '', valuePercent: 0, comparison: '', note: null, sourceLabel: null },
  supportedAspectRatios: ['16:9', '9:16', '1:1'],
  minDurationMs: 2000,
  maxDurationMs: 15_000,
  previewFixture: {
    props: { label: '订阅收入', valuePercent: 32.5, comparison: '同比 2025', note: null, sourceLabel: '示例数据集' },
    durationMs: 5000,
    aspectRatio: '16:9',
    note: '正常值：+32.5%（上升语义）',
  },
  renderer: PercentDeltaScene,
});

/* ---------- Host 变体：HOST_PIP / HOST_OVERLAY ---------- */

const hostCommon = {
  /** 主持画面资产（未绑定 → 明确占位；不冒充真实出镜） */
  assetId: z.string().max(120).nullable().default(null),
  assetUrl: z.string().max(1000).nullable().default(null),
  presenterName: z.string().max(60).nullable().default(null),
  ...sourceLabelCommon,
};

export const hostPipPropsSchema = z.object({
  ...hostCommon,
  /** PiP 位置（布局变体） */
  position: z.enum(['bottom-right', 'bottom-left', 'top-right', 'top-left']).default('bottom-right'),
  /** PiP 画面占比（宽：0.2–0.45） */
  scale: z.number().min(0.2).max(0.45).default(0.32),
  /** 主画面说明（主持人小窗之外的正文画面占位说明） */
  stageNote: z.string().max(200).default('主画面（素材/组件由上游场景提供）'),
});
export type HostPipProps = z.infer<typeof hostPipPropsSchema>;

export function HostPipScene({ props }: ComponentRenderInput<HostPipProps>): ReactElement {
  const theme = useSceneTheme();
  const positionStyle: Record<HostPipProps['position'], { top?: number; bottom?: number; left?: number; right?: number }> = {
    'bottom-right': { bottom: theme.spacing.lg, right: theme.spacing.lg },
    'bottom-left': { bottom: theme.spacing.lg, left: theme.spacing.lg },
    'top-right': { top: theme.spacing.lg, right: theme.spacing.lg },
    'top-left': { top: theme.spacing.lg, left: theme.spacing.lg },
  };
  return (
    <SceneRoot>
      <div data-role="pip-stage" style={{ display: 'flex', width: '100%', height: '78%', alignItems: 'center', justifyContent: 'center' }}>
        <BodyText text={props.stageNote} maxFontSize={44} />
      </div>
      <div
        data-role="host-pip"
        data-position={props.position}
        style={{
          position: 'absolute',
          ...positionStyle[props.position],
          width: `${String(Math.round(props.scale * 100))}%`,
          aspectRatio: '16 / 9',
          border: `4px solid ${theme.color.accent}66`,
          borderRadius: theme.radius.lg,
          overflow: 'hidden',
          backgroundColor: `${theme.color.accent}11`,
        }}
      >
        {props.assetUrl === null ? (
          <Placeholder text="主持小窗（待绑定素材）" detail={props.assetId === null ? '未绑定 Avatar 资产：Draft 占位' : `资产 ${props.assetId} 的预览地址未就绪`} />
        ) : (
          <img data-role="pip-image" src={props.assetUrl} alt={props.presenterName ?? '主持人'} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        )}
      </div>
      {props.presenterName === null ? null : (
        <div style={{ position: 'absolute', left: theme.spacing.lg, bottom: theme.spacing.md }}>
          <Kicker text={props.presenterName} />
        </div>
      )}
      <div style={{ position: 'absolute', right: theme.spacing.lg, bottom: theme.spacing.md }}>
        <SourceLabel label={props.sourceLabel} />
      </div>
    </SceneRoot>
  );
}

export const hostOverlayPropsSchema = z.object({
  ...hostCommon,
  /** 下三分之一信息条：姓名 + 头衔/职务（布局变体：left/center；空 = 明确占位） */
  name: z.string().max(60).default(''),
  title: z.string().max(80).default(''),
  accent: z.string().max(20).default(''),
  align: z.enum(['left', 'center']).default('left'),
});
export type HostOverlayProps = z.infer<typeof hostOverlayPropsSchema>;

export function HostOverlayScene({ props }: ComponentRenderInput<HostOverlayProps>): ReactElement {
  const theme = useSceneTheme();
  return (
    <SceneRoot padding={0}>
      {props.assetUrl === null ? (
        <div style={{ display: 'flex', width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' }}>
          <Placeholder text="主持画面（待绑定素材）" detail={props.assetId === null ? '未绑定 Avatar 资产：Draft 占位，不冒充真实出镜' : `资产 ${props.assetId} 的预览地址未就绪`} />
        </div>
      ) : (
        <img data-role="overlay-image" src={props.assetUrl} alt={props.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      )}
      {props.name === '' ? (
        <div style={{ position: 'absolute', left: theme.spacing.lg, bottom: theme.spacing.lg }}>
          <Placeholder text="信息条待补充" detail="姓名/头衔需显式给出" />
        </div>
      ) : (
      <div
        data-role="host-overlay"
        data-align={props.align}
        style={{
          position: 'absolute',
          left: props.align === 'center' ? '50%' : theme.spacing.lg,
          transform: props.align === 'center' ? 'translateX(-50%)' : undefined,
          bottom: theme.spacing.lg,
          padding: `${String(theme.spacing.sm)}px ${String(theme.spacing.lg)}px`,
          backgroundColor: `${theme.color.background}CC`,
          borderLeft: `8px solid ${props.accent === '' ? theme.color.accent : props.accent}`,
          borderRadius: theme.radius.sm,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        <span style={{ fontSize: 56, fontWeight: 700 }}>{props.name}</span>
        {props.title === '' ? null : <span style={{ fontSize: 32, opacity: 0.85 }}>{props.title}</span>}
      </div>
      )}
    </SceneRoot>
  );
}

export const hostPipComponent = defineComponent({
  type: 'HOST_PIP',
  version: '1.0.0',
  title: '主持小窗（PiP）',
  description: '主画面 + 主持小窗（四角位置与占比为布局变体；未绑定素材明确占位）',
  inputSchema: hostPipPropsSchema,
  defaults: { assetId: null, assetUrl: null, presenterName: null, sourceLabel: null, position: 'bottom-right', scale: 0.32, stageNote: '主画面（素材/组件由上游场景提供）' },
  supportedAspectRatios: ['16:9', '9:16'],
  minDurationMs: 3000,
  maxDurationMs: 120_000,
  previewFixture: { props: { presenterName: '林主播', position: 'bottom-right', scale: 0.32, stageNote: '主画面（数据看板）' }, durationMs: 8000, aspectRatio: '16:9', note: '正常值：右下 PiP 占位（未绑定素材——明确占位）' },
  renderer: HostPipScene,
});

export const hostOverlayComponent = defineComponent({
  type: 'HOST_OVERLAY',
  version: '1.0.0',
  title: '主持下三分之一',
  description: '主持画面 + 下三分之一信息条（left/center 对齐为布局变体）',
  inputSchema: hostOverlayPropsSchema,
  defaults: { assetId: null, assetUrl: null, presenterName: null, sourceLabel: null, name: '', title: '', accent: '', align: 'left' },
  supportedAspectRatios: ['16:9', '9:16'],
  minDurationMs: 2000,
  maxDurationMs: 60_000,
  previewFixture: { props: { name: '林主播', title: '财经评论员', align: 'left' }, durationMs: 6000, aspectRatio: '16:9', note: '正常值：下三分之一信息条' },
  renderer: HostOverlayScene,
});

/* ---------- Process / 时序：PROCESS_FLOW ---------- */

export const processFlowPropsSchema = z.object({
  ...titleCommon,
  /** 步骤（2–6 步；箭头链式呈现；显式给出，不自动推断） */
  steps: z.array(z.object({ label: z.string().min(1).max(40), detail: z.string().max(80).nullable().default(null) })).max(6).default([]),
  /** 布局变体：horizontal（横向）/ vertical（纵向） */
  layout: z.enum(['horizontal', 'vertical']).default('horizontal'),
  ...sourceLabelCommon,
});
export type ProcessFlowProps = z.infer<typeof processFlowPropsSchema>;

export function ProcessFlowScene({ props }: ComponentRenderInput<ProcessFlowProps>): ReactElement {
  const theme = useSceneTheme();
  const horizontal = props.layout === 'horizontal';
  return (
    <SceneRoot>
      {props.title === '' ? null : <Headline text={props.title} maxFontSize={60} />}
      <div style={{ marginTop: 32, width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        {props.steps.length < 2 ? (
          <Placeholder text="流程步骤待补充" detail="流程需要 2–6 个显式步骤；缺失时不得由 AI 推断流程" />
        ) : (
          <div data-role="process-flow" data-layout={props.layout} style={{ display: 'flex', flexDirection: horizontal ? 'row' : 'column', gap: 0, alignItems: 'center', justifyContent: 'center', width: horizontal ? '92%' : '60%' }}>
            {props.steps.map((step, index) => (
              <div key={`${step.label}-${String(index)}`} style={{ display: 'flex', flexDirection: horizontal ? 'row' : 'column', alignItems: 'center', flex: horizontal ? 1 : undefined }}>
                <CardShell style={{ minWidth: horizontal ? 220 : 520, borderColor: index === 0 ? theme.color.accent : undefined }}>
                  <div data-role="process-step" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 26, opacity: 0.7 }}>{`步骤 ${String(index + 1)}`}</span>
                    <span style={{ fontSize: 40, fontWeight: 700 }}>{step.label}</span>
                    {step.detail === null ? null : <span style={{ fontSize: 26, opacity: 0.8 }}>{step.detail}</span>}
                  </div>
                </CardShell>
                {index < props.steps.length - 1 ? (
                  <span data-role="process-arrow" style={{ fontSize: 56, color: theme.color.accent, padding: horizontal ? '0 12px' : '8px 0' }}>
                    {horizontal ? '→' : '↓'}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        )}
        <div style={{ marginTop: 24 }}>
          <SourceLabel label={props.sourceLabel} />
        </div>
      </div>
    </SceneRoot>
  );
}

export const processFlowComponent = defineComponent({
  type: 'PROCESS_FLOW',
  version: '1.0.0',
  title: '流程图',
  description: '领式步骤链（horizontal/vertical 布局变体；步骤显式给出，2–6 步）',
  inputSchema: processFlowPropsSchema,
  defaults: { title: '', steps: [], layout: 'horizontal', sourceLabel: null },
  supportedAspectRatios: ['16:9', '9:16', '1:1'],
  minDurationMs: 3500,
  maxDurationMs: 25_000,
  previewFixture: {
    props: {
      title: '内容生产流程',
      steps: [
        { label: '取材', detail: 'URL/文档导入' },
        { label: '叙事', detail: '结构化成稿' },
        { label: '分镜', detail: '场景图' },
        { label: '渲染', detail: 'QA 通过' },
      ],
      layout: 'horizontal',
      sourceLabel: null,
    },
    durationMs: 9000,
    aspectRatio: '16:9',
    note: '正常值：4 步横向流程',
  },
  renderer: ProcessFlowScene,
});

/* ---------- Map Flow / Zoom（示意；非真实地理投影） ---------- */

const mapPointSchema = z.object({ /** 标注名（空 = 未命名，画面显式标注未命名） */ label: z.string().max(40).default(''), x: z.number().min(0).max(1), y: z.number().min(0).max(1) });

export const mapZoomPropsSchema = z.object({
  ...titleCommon,
  /** 缩放目标区域名（空 = 明确占位；区域名需显式给出） */
  region: z.string().max(60).default(''),
  /** 缩放档位（1–4；仅视觉档位，不代表真实比例尺） */
  zoomLevel: z.number().int().min(1).max(4).default(2),
  markers: z.array(mapPointSchema).max(6).default([]),
  ...sourceLabelCommon,
});
export type MapZoomProps = z.infer<typeof mapZoomPropsSchema>;

export function MapZoomScene({ props }: ComponentRenderInput<MapZoomProps>): ReactElement {
  const theme = useSceneTheme();
  return (
    <SceneRoot>
      {props.title === '' ? null : <Headline text={props.title} maxFontSize={60} />}
      <div style={{ marginTop: 24, width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        {props.region === '' ? (
          <Placeholder text="缩放区域待补充" detail="区域需作者/AI 显式给出，不以地图外观冒充真实地理" />
        ) : (
        <div
          data-role="map-zoom"
          data-zoom-level={props.zoomLevel}
          style={{
            position: 'relative',
            width: '78%',
            height: 620,
            border: `3px solid ${theme.color.accent}55`,
            borderRadius: theme.radius.lg,
            backgroundColor: `${theme.color.accent}0F`,
            overflow: 'hidden',
          }}
        >
          <div style={{ position: 'absolute', top: 12, right: 20, fontSize: 22, opacity: 0.6 }}>示意位置（非真实地理投影）</div>
          {/* 缩放区域框（视觉档位；区域名显式给出） */}
          <div
            data-role="zoom-frame"
            style={{
              position: 'absolute',
              left: '18%',
              top: '16%',
              width: `${String(52 - props.zoomLevel * 6)}%`,
              height: `${String(48 - props.zoomLevel * 5)}%`,
              border: `4px dashed ${theme.color.accent}`,
              borderRadius: theme.radius.md,
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'center',
            }}
          >
            <span style={{ marginTop: 8, fontSize: 30, fontWeight: 700 }}>{`${props.region}（缩放 ${String(props.zoomLevel)}×）`}</span>
          </div>
          {props.markers.map((marker, index) => (
            <div key={`${marker.label}-${String(index)}`} data-role="map-marker" style={{ position: 'absolute', left: `${String(marker.x * 100)}%`, top: `${String(marker.y * 100)}%`, transform: 'translate(-50%, -50%)', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <span style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: theme.color.accent }} />
              <span style={{ fontSize: 24, marginTop: 4 }}>{marker.label === '' ? '（未命名）' : marker.label}</span>
            </div>
          ))}
        </div>
        )}
        <div style={{ marginTop: 16 }}>
          <SourceLabel label={props.sourceLabel} />
        </div>
      </div>
    </SceneRoot>
  );
}

export const mapFlowPropsSchema = z.object({
  ...titleCommon,
  from: mapPointSchema.default({ label: '', x: 0.5, y: 0.5 }),
  to: mapPointSchema.default({ label: '', x: 0.5, y: 0.5 }),
  /** 流动说明（如"贸易流向/资金流向"） */
  flowLabel: z.string().max(60).default(''),
  ...sourceLabelCommon,
});
export type MapFlowProps = z.infer<typeof mapFlowPropsSchema>;

export function MapFlowScene({ props }: ComponentRenderInput<MapFlowProps>): ReactElement {
  const theme = useSceneTheme();
  const fromX = props.from.x * 100;
  const fromY = props.from.y * 100;
  const toX = props.to.x * 100;
  const toY = props.to.y * 100;
  const midX = (fromX + toX) / 2;
  const midY = Math.min(fromY, toY) - 8;
  return (
    <SceneRoot>
      {props.title === '' ? null : <Headline text={props.title} maxFontSize={60} />}
      <div style={{ marginTop: 24, width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        {props.from.label === '' && props.to.label === '' ? (
          <Placeholder text="流向标注待补充" detail="起止点需显式给出，不以地图外观冒充真实地理" />
        ) : (
        <div data-role="map-flow" style={{ position: 'relative', width: '78%', height: 620, border: `3px solid ${theme.color.accent}55`, borderRadius: theme.radius.lg, backgroundColor: `${theme.color.accent}0F` }}>
          <div style={{ position: 'absolute', top: 12, right: 20, fontSize: 22, opacity: 0.6 }}>示意位置（非真实地理投影）</div>
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
            <path data-role="flow-arc" d={`M ${fromX.toFixed(1)} ${fromY.toFixed(1)} Q ${midX.toFixed(1)} ${midY.toFixed(1)} ${toX.toFixed(1)} ${toY.toFixed(1)}`} fill="none" stroke={theme.color.accent} strokeWidth={1.4} strokeDasharray="4 2" vectorEffect="non-scaling-stroke" />
          </svg>
          {[props.from, props.to].map((endpoint, index) => (
            <div key={`${endpoint.label}-${String(index)}`} data-role="map-endpoint" style={{ position: 'absolute', left: `${String(endpoint.x * 100)}%`, top: `${String(endpoint.y * 100)}%`, transform: 'translate(-50%, -50%)', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <span style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: index === 0 ? theme.color.accent : theme.color.positive }} />
              <span style={{ fontSize: 26, marginTop: 4 }}>{endpoint.label === '' ? '（未命名）' : endpoint.label}</span>
            </div>
          ))}
          {props.flowLabel === '' ? null : (
            <div data-role="flow-label" style={{ position: 'absolute', left: `${String(midX)}%`, top: `${String(Math.max(4, midY))}%`, transform: 'translate(-50%, -100%)', fontSize: 30, fontWeight: 600 }}>
              {props.flowLabel}
            </div>
          )}
        </div>
        )}
        <div style={{ marginTop: 16 }}>
          <SourceLabel label={props.sourceLabel} />
        </div>
      </div>
    </SceneRoot>
  );
}

export const mapZoomComponent = defineComponent({
  type: 'MAP_ZOOM',
  version: '1.0.0',
  title: '地图缩放',
  description: '区域缩放示意（位置与档位显式给出；标注"非真实地理投影"）',
  inputSchema: mapZoomPropsSchema,
  defaults: { title: '', region: '', zoomLevel: 2, markers: [], sourceLabel: null },
  supportedAspectRatios: ['16:9', '1:1'],
  minDurationMs: 3000,
  maxDurationMs: 20_000,
  previewFixture: {
    props: { title: '重点区域', region: '华东', zoomLevel: 3, markers: [{ label: '上海', x: 0.6, y: 0.45 }], sourceLabel: '示例标注' },
    durationMs: 7000,
    aspectRatio: '16:9',
    note: '正常值：区域框 + 1 个标注（示意）',
  },
  renderer: MapZoomScene,
});

export const mapFlowComponent = defineComponent({
  type: 'MAP_FLOW',
  version: '1.0.0',
  title: '地图流向',
  description: '两地流向示意（起止点显式给出；弧线为示意，标注"非真实地理投影"）',
  inputSchema: mapFlowPropsSchema,
  defaults: { title: '', from: { label: '', x: 0, y: 0 }, to: { label: '', x: 0, y: 0 }, flowLabel: '', sourceLabel: null },
  supportedAspectRatios: ['16:9', '1:1'],
  minDurationMs: 3000,
  maxDurationMs: 20_000,
  previewFixture: {
    props: { title: '资金流向', from: { label: '香港', x: 0.68, y: 0.62 }, to: { label: '新加坡', x: 0.42, y: 0.78 }, flowLabel: '净流入', sourceLabel: '示例标注' },
    durationMs: 7000,
    aspectRatio: '16:9',
    note: '正常值：两点流向弧（示意）',
  },
  renderer: MapFlowScene,
});

/* ---------- 实体组件：PERSON / COMPANY / COUNTRY_PROFILE + LOGO_WALL ---------- */

const factSchema = z.object({ label: z.string().min(1).max(40), value: z.string().min(1).max(80) });
const entityCommon = {
  /** 名称（空 = 明确占位；名称需显式给出） */
  name: z.string().max(60).default(''),
  subtitle: z.string().max(80).nullable().default(null),
  /** 事实字段（显式给出；2–5 条；组件不推算/不补造） */
  facts: z.array(factSchema).max(5).default([]),
  ...sourceLabelCommon,
};

export const personProfilePropsSchema = z.object({ ...entityCommon, avatarAssetId: z.string().max(120).nullable().default(null), accent: z.string().max(20).default('') });
export type PersonProfileProps = z.infer<typeof personProfilePropsSchema>;
export const companyProfilePropsSchema = z.object({ ...entityCommon, ticker: z.string().max(20).nullable().default(null) });
export type CompanyProfileProps = z.infer<typeof companyProfilePropsSchema>;
export const countryProfilePropsSchema = z.object({ ...entityCommon, regionCode: z.string().max(12).nullable().default(null) });
export type CountryProfileProps = z.infer<typeof countryProfilePropsSchema>;

function EntityProfileCard(props: { name: string; subtitle: string | null; facts: { label: string; value: string }[]; accent: string; sourceLabel: string | null; monogram: string; badge?: string | null }): ReactElement {
  const theme = useSceneTheme();
  if (props.name === '') {
    return (
      <SceneRoot>
        <Placeholder text="实体信息待补充" detail="名称与事实字段需显式给出（不推算）" />
      </SceneRoot>
    );
  }
  return (
    <SceneRoot>
      <div style={{ display: 'flex', width: '100%', alignItems: 'center', gap: theme.spacing.lg }}>
        <div
          data-role="entity-avatar"
          style={{
            width: 260,
            height: 260,
            borderRadius: 130,
            backgroundColor: props.accent === '' ? `${theme.color.accent}22` : props.accent,
            border: `6px solid ${theme.color.accent}66`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 96,
            fontWeight: 800,
          }}
        >
          {props.monogram}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
            <span style={{ fontSize: 84, fontWeight: 800 }}>{props.name}</span>
            {props.badge == null ? null : <span style={{ fontSize: 36, opacity: 0.8 }}>{props.badge}</span>}
          </div>
          {props.subtitle === null ? null : <span style={{ fontSize: 40, opacity: 0.85 }}>{props.subtitle}</span>}
          {props.facts.length === 0 ? (
            <Placeholder text="实体信息待补充" detail="事实字段需显式给出（不推算）" />
          ) : (
            <ul data-role="entity-facts" style={{ display: 'flex', flexDirection: 'column', gap: 10, margin: 0, padding: 0, listStyle: 'none' }}>
              {props.facts.map((fact) => (
                <li key={`${fact.label}-${fact.value}`} style={{ display: 'flex', gap: 16, fontSize: 34 }}>
                  <span style={{ opacity: 0.7, minWidth: 220 }}>{fact.label}</span>
                  <span style={{ fontWeight: 600 }}>{fact.value}</span>
                </li>
              ))}
            </ul>
          )}
          <SourceLabel label={props.sourceLabel} />
        </div>
      </div>
    </SceneRoot>
  );
}

export function PersonProfileScene({ props }: ComponentRenderInput<PersonProfileProps>): ReactElement {
  const monogram = props.name.trim().slice(0, 1);
  return <EntityProfileCard {...props} monogram={monogram} badge={null} accent={props.accent} />;
}
export function CompanyProfileScene({ props }: ComponentRenderInput<CompanyProfileProps>): ReactElement {
  const monogram = props.name.trim().slice(0, 1);
  return <EntityProfileCard {...props} monogram={monogram} badge={props.ticker === null ? null : props.ticker} accent="" />;
}
export function CountryProfileScene({ props }: ComponentRenderInput<CountryProfileProps>): ReactElement {
  return <EntityProfileCard {...props} monogram={props.name.trim().slice(0, 1)} badge={props.regionCode} accent="" />;
}

export const logoWallPropsSchema = z.object({
  ...titleCommon,
  /** 名称墙（显式给出；以文字缩合呈现——不伪造真实商标图形） */
  logos: z.array(z.object({ name: z.string().min(1).max(40) })).max(24).default([]),
  /** 列数（布局变体） */
  columns: z.number().int().min(2).max(6).default(4),
  ...sourceLabelCommon,
});
export type LogoWallProps = z.infer<typeof logoWallPropsSchema>;

export function LogoWallScene({ props }: ComponentRenderInput<LogoWallProps>): ReactElement {
  const theme = useSceneTheme();
  return (
    <SceneRoot>
      {props.title === '' ? null : <Headline text={props.title} maxFontSize={56} />}
      <div style={{ marginTop: 28, width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        {props.logos.length === 0 ? (
          <Placeholder text="名称墙待补充" detail="名称需显式给出（以文字缩合呈现，不伪造商标）" />
        ) : (
          <div data-role="logo-wall" data-columns={props.columns} style={{ display: 'grid', gridTemplateColumns: `repeat(${String(props.columns)}, 1fr)`, gap: 18, width: '90%' }}>
            {props.logos.map((logo) => (
              <div key={logo.name} data-role="logo-chip" style={{ border: `3px solid ${theme.color.accent}44`, borderRadius: theme.radius.md, padding: '18px 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 34, fontWeight: 700, backgroundColor: `${theme.color.accent}0D` }}>
                {logo.name}
              </div>
            ))}
          </div>
        )}
        <div style={{ marginTop: 20 }}>
          <SourceLabel label={props.sourceLabel} />
        </div>
      </div>
    </SceneRoot>
  );
}

export const personProfileComponent = defineComponent({
  type: 'PERSON_PROFILE',
  version: '1.0.0',
  title: '人物档案',
  description: '人物事实卡（姓名/头衔/2–5 条显式事实；缩合头像为文字，不伪造真实肖像）',
  inputSchema: personProfilePropsSchema,
  defaults: { name: '', subtitle: null, facts: [], sourceLabel: null, avatarAssetId: null, accent: '' },
  supportedAspectRatios: ['16:9', '1:1'],
  minDurationMs: 3000,
  maxDurationMs: 25_000,
  previewFixture: {
    props: { name: '林述', subtitle: '宏观研究员', facts: [{ label: '机构', value: '示例研究院' }, { label: '领域', value: '利率与汇率' }], sourceLabel: '示例资料' },
    durationMs: 8000,
    aspectRatio: '16:9',
    note: '正常值：2 条事实',
  },
  renderer: PersonProfileScene,
});

export const companyProfileComponent = defineComponent({
  type: 'COMPANY_PROFILE',
  version: '1.0.0',
  title: '公司档案',
  description: '公司事实卡（名称/代码/显式事实；不推算财务数据）',
  inputSchema: companyProfilePropsSchema,
  defaults: { name: '', subtitle: null, facts: [], sourceLabel: null, ticker: null },
  supportedAspectRatios: ['16:9', '1:1'],
  minDurationMs: 3000,
  maxDurationMs: 25_000,
  previewFixture: {
    props: { name: '示例科技', subtitle: '云计算服务商', ticker: 'EXMPL', facts: [{ label: '成立', value: '2015' }, { label: '总部', value: '上海' }], sourceLabel: '示例资料' },
    durationMs: 8000,
    aspectRatio: '16:9',
    note: '正常值：ticker + 2 条事实',
  },
  renderer: CompanyProfileScene,
});

export const countryProfileComponent = defineComponent({
  type: 'COUNTRY_PROFILE',
  version: '1.0.0',
  title: '国家档案',
  description: '国家/地区事实卡（名称/代码/显式事实）',
  inputSchema: countryProfilePropsSchema,
  defaults: { name: '', subtitle: null, facts: [], sourceLabel: null, regionCode: null },
  supportedAspectRatios: ['16:9', '1:1'],
  minDurationMs: 3000,
  maxDurationMs: 25_000,
  previewFixture: {
    props: { name: '示例国', subtitle: '亚太经济体', regionCode: 'EX', facts: [{ label: '货币', value: 'EXD' }, { label: '时区', value: 'UTC+8' }], sourceLabel: '示例资料' },
    durationMs: 8000,
    aspectRatio: '16:9',
    note: '正常值：regionCode + 2 条事实',
  },
  renderer: CountryProfileScene,
});

export const logoWallComponent = defineComponent({
  type: 'LOGO_WALL',
  version: '1.0.0',
  title: '品牌墙',
  description: '名称墙（文字缩合；2–6 列布局变体；不伪造商标图形）',
  inputSchema: logoWallPropsSchema,
  defaults: { title: '', logos: [], columns: 4, sourceLabel: null },
  supportedAspectRatios: ['16:9', '1:1'],
  minDurationMs: 2500,
  maxDurationMs: 20_000,
  previewFixture: {
    props: { title: '合作机构', logos: [{ name: '示例银行' }, { name: '示例基金' }, { name: '示例保险' }, { name: '示例证券' }], columns: 4, sourceLabel: '示例名单' },
    durationMs: 6000,
    aspectRatio: '16:9',
    note: '正常值：4 项 × 4 列',
  },
  renderer: LogoWallScene,
});

/* ---------- 对比分栏：COMPARE_SPLIT（REQ-65-01 余额项） ---------- */

export const compareSplitPropsSchema = z.object({
  ...titleCommon,
  /** 左栏（label 空 = 明确占位） */
  left: z
    .object({ label: z.string().max(40).default(''), value: z.string().max(40).default(''), bullets: z.array(z.string().min(1).max(80)).max(6).default([]) })
    .default({ label: '', value: '', bullets: [] }),
  right: z
    .object({ label: z.string().max(40).default(''), value: z.string().max(40).default(''), bullets: z.array(z.string().min(1).max(80)).max(6).default([]) })
    .default({ label: '', value: '', bullets: [] }),
  ...sourceLabelCommon,
});
export type CompareSplitProps = z.infer<typeof compareSplitPropsSchema>;

function SplitSide({ side, accent }: { side: { label: string; value: string; bullets: string[] }; accent: string }): ReactElement {
  return (
    <div data-role="compare-side" style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 14, padding: '32px 40px', borderTop: `6px solid ${accent}` }}>
      <span style={{ fontSize: 44, fontWeight: 700 }}>{side.label}</span>
      {side.value === '' ? null : <span style={{ fontSize: 64, fontWeight: 800 }}>{side.value}</span>}
      {side.bullets.length === 0 ? null : (
        <ul style={{ display: 'flex', flexDirection: 'column', gap: 10, margin: 0, paddingLeft: 28, fontSize: 30 }}>
          {side.bullets.map((bullet) => (
            <li key={bullet}>{bullet}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function CompareSplitScene({ props }: ComponentRenderInput<CompareSplitProps>): ReactElement {
  const theme = useSceneTheme();
  const empty = props.left.label === '' && props.right.label === '';
  return (
    <SceneRoot>
      {props.title === '' ? null : <Headline text={props.title} maxFontSize={60} />}
      <div style={{ marginTop: 28, width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        {empty ? (
          <Placeholder text="对比内容待补充" detail="左右两栏均需显式给出；缺失时不得由 AI 填充对比项" />
        ) : (
          <div data-role="compare-split" style={{ display: 'flex', width: '92%', gap: 0, border: `3px solid ${theme.color.accent}33`, borderRadius: theme.radius.lg, overflow: 'hidden' }}>
            <SplitSide side={props.left} accent={theme.color.accent} />
            <div style={{ width: 3, backgroundColor: `${theme.color.accent}55` }} />
            <SplitSide side={props.right} accent={theme.color.positive} />
          </div>
        )}
        <div style={{ marginTop: 20 }}>
          <SourceLabel label={props.sourceLabel} />
        </div>
      </div>
    </SceneRoot>
  );
}

export const compareSplitComponent = defineComponent({
  type: 'COMPARE_SPLIT',
  version: '1.0.0',
  title: '对比分栏',
  description: '左右分栏对比（每栏 label/value/bullets 显式给出；空栏明确占位）',
  inputSchema: compareSplitPropsSchema,
  defaults: { title: '', left: { label: '', value: '', bullets: [] }, right: { label: '', value: '', bullets: [] }, sourceLabel: null },
  supportedAspectRatios: ['16:9', '1:1'],
  minDurationMs: 3000,
  maxDurationMs: 25_000,
  previewFixture: {
    props: {
      title: '方案对比',
      left: { label: '方案 A', value: '成本优先', bullets: ['上线快', '覆盖面小'] },
      right: { label: '方案 B', value: '质量优先', bullets: ['覆盖广', '周期长'] },
      sourceLabel: '示例资料',
    },
    durationMs: 8000,
    aspectRatio: '16:9',
    note: '正常值：左右两栏对比',
  },
  renderer: CompareSplitScene,
});
