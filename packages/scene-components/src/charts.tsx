import type { ReactElement } from 'react';
import { useSceneTheme } from './theme.js';

/**
 * 基础绘图（P05-02："基础绘图可复用"）：
 * 纯 SVG、确定性（无随机、无网络、无 Canvas）——同一输入在预览与成片渲染中像素一致。
 *
 * **纪律（§10.3）**：图表只绘制**传入的数据点**；空数据 → 占位（绝不补造数列/不外推）；
 * 数值原样标注（不做换算、不做平滑插值——折线只连真实点）。
 */

export interface ChartPoint {
  t: string;
  v: number;
}

export interface ChartSeries {
  name: string;
  points: ChartPoint[];
}

const CHART_WIDTH = 1500;
const CHART_HEIGHT = 620;
const PADDING = { top: 40, right: 48, bottom: 72, left: 96 };

const plotWidth = CHART_WIDTH - PADDING.left - PADDING.right;
const plotHeight = CHART_HEIGHT - PADDING.top - PADDING.bottom;

interface Scale {
  x: (index: number) => number;
  y: (value: number) => number;
  minValue: number;
  maxValue: number;
  maxPoints: number;
}

const buildScale = (series: readonly ChartSeries[]): Scale | null => {
  const all = series.flatMap((item) => item.points);
  if (all.length === 0) return null;
  const values = all.map((point) => point.v);
  let minValue = Math.min(...values);
  let maxValue = Math.max(...values);
  if (minValue === maxValue) {
    // 全平序列：给一个对称窗口，避免除零（不改变数据，只影响绘制范围）
    minValue -= 1;
    maxValue += 1;
  }
  const maxPoints = Math.max(...series.map((item) => item.points.length));
  return {
    x: (index: number) => PADDING.left + (maxPoints <= 1 ? plotWidth / 2 : (index / (maxPoints - 1)) * plotWidth),
    y: (value: number) => PADDING.top + plotHeight - ((value - minValue) / (maxValue - minValue)) * plotHeight,
    minValue,
    maxValue,
    maxPoints,
  };
};

const pathFor = (points: readonly ChartPoint[], scale: Scale): string =>
  points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${scale.x(index).toFixed(2)} ${scale.y(point.v).toFixed(2)}`).join(' ');

const areaPathFor = (upper: readonly ChartPoint[], lower: readonly ChartPoint[], scale: Scale): string => {
  const up = upper.map((point, index) => `${index === 0 ? 'M' : 'L'} ${scale.x(index).toFixed(2)} ${scale.y(point.v).toFixed(2)}`).join(' ');
  const down = [...lower]
    .map((point, index) => ({ point, index }))
    .reverse()
    .map(({ point, index }) => `L ${scale.x(index).toFixed(2)} ${scale.y(point.v).toFixed(2)}`)
    .join(' ');
  return `${up} ${down} Z`;
};

export interface ChartFrameProps {
  series: readonly ChartSeries[];
  /** 'line' | 'dual' | 'bar' | 'spread' */
  mode: 'line' | 'dual' | 'bar' | 'spread';
  /** 纵轴单位（如 "%"、"bp"），仅用于轴标注 */
  unit: string;
  /** 数据点标签（x 轴） */
  xLabels?: readonly string[];
  /** 图例（mode=dual/spread 时显示系列名） */
  showLegend?: boolean;
  /** 空数据占位文案 */
  emptyText?: string;
}

/** 图表主体（数据为空 → null，由调用方渲染 Placeholder）。 */
export function ChartFrame(props: ChartFrameProps): ReactElement | null {
  const theme = useSceneTheme();
  const scale = buildScale(props.series);
  if (scale === null) return null;
  const first = props.series[0];
  if (first === undefined) return null;

  const xLabels =
    props.xLabels ??
    (first.points.length > 8
      ? first.points.filter((_, index) => index % Math.ceil(first.points.length / 8) === 0).map((point) => point.t)
      : first.points.map((point) => point.t));

  const colors = [theme.color.accent, theme.color.positive, theme.color.negative];

  return (
    <svg
      data-role="chart"
      data-chart-mode={props.mode}
      viewBox={`0 0 ${String(CHART_WIDTH)} ${String(CHART_HEIGHT)}`}
      style={{ width: '100%', height: 'auto', maxHeight: '62%' }}
      role="img"
    >
      {/* 轴与网格（绘制范围，不代表数据） */}
      <line x1={PADDING.left} y1={PADDING.top} x2={PADDING.left} y2={PADDING.top + plotHeight} stroke={`${theme.color.foreground}55`} strokeWidth={2} />
      <line x1={PADDING.left} y1={PADDING.top + plotHeight} x2={PADDING.left + plotWidth} y2={PADDING.top + plotHeight} stroke={`${theme.color.foreground}55`} strokeWidth={2} />
      {[0, 0.5, 1].map((fraction) => {
        const value = scale.maxValue - fraction * (scale.maxValue - scale.minValue);
        const y = PADDING.top + fraction * plotHeight;
        return (
          <g key={fraction}>
            <line x1={PADDING.left} y1={y} x2={PADDING.left + plotWidth} y2={y} stroke={`${theme.color.foreground}22`} strokeWidth={1} />
            <text x={PADDING.left - 16} y={y + 8} textAnchor="end" fill={theme.color.foreground} fontSize={24} opacity={0.7} fontFamily={theme.font.body}>
              {`${value.toFixed(2)}${props.unit}`}
            </text>
          </g>
        );
      })}
      {xLabels.map((label, index) => (
        <text
          key={label}
          x={scale.x(first.points.length > 8 ? index * Math.ceil(first.points.length / 8) : index)}
          y={PADDING.top + plotHeight + 44}
          textAnchor="middle"
          fill={theme.color.foreground}
          fontSize={24}
          opacity={0.7}
          fontFamily={theme.font.body}
        >
          {label}
        </text>
      ))}

      {props.mode === 'bar'
        ? first.points.map((point, index) => {
            const barWidth = Math.max(12, (plotWidth / Math.max(first.points.length, 1)) * 0.5);
            const y = scale.y(point.v);
            const baseline = scale.y(Math.max(0, scale.minValue));
            return (
              <rect
                key={`${point.t}-${String(index)}`}
                data-role="bar"
                x={scale.x(index) - barWidth / 2}
                y={Math.min(y, baseline)}
                width={barWidth}
                height={Math.max(2, Math.abs(baseline - y))}
                fill={colors[0]}
                rx={theme.radius.sm}
              />
            );
          })
        : null}

      {props.mode === 'spread' && props.series.length >= 2 && props.series[1] !== undefined
        ? <path data-role="spread-area" d={areaPathFor(first.points, props.series[1].points, scale)} fill={`${colors[0]}55`} stroke="none" />
        : null}

      {props.mode !== 'bar'
        ? props.series.map((item, seriesIndex) => (
            <path
              key={item.name}
              data-role="series-line"
              data-series-index={seriesIndex}
              d={pathFor(item.points, scale)}
              fill="none"
              stroke={colors[seriesIndex % colors.length]}
              strokeWidth={4}
              strokeLinejoin="round"
              strokeLinecap="round"
              strokeDasharray={props.mode === 'dual' && seriesIndex > 0 ? '14 10' : undefined}
            />
          ))
        : null}

      {props.mode !== 'bar'
        ? first.points.map((point, index) => (
            <circle key={`${point.t}-${String(index)}`} cx={scale.x(index)} cy={scale.y(point.v)} r={5} fill={colors[0]} />
          ))
        : null}

      {props.showLegend === true && props.series.length > 1
        ? props.series.map((item, seriesIndex) => (
            <g key={`legend-${item.name}`} transform={`translate(${String(PADDING.left + seriesIndex * 360)}, ${String(CHART_HEIGHT - 14)})`}>
              <rect width={22} height={22} y={-18} fill={colors[seriesIndex % colors.length]} rx={4} />
              <text x={32} y={0} fill={theme.color.foreground} fontSize={26} fontFamily={theme.font.body} opacity={0.85}>
                {item.name}
              </text>
            </g>
          ))
        : null}
    </svg>
  );
}
