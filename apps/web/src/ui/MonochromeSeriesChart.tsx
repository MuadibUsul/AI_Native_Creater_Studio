import { useId, type ReactElement } from 'react';
import { useI18n } from '@/i18n/I18nProvider';
import styles from './monochrome-series-chart.module.css';

export type ChartPoint = { x: number; y: number | null };
export type ChartSeries = { id: string; label: string; points: readonly ChartPoint[] };

type Props = {
  title: string;
  series: readonly ChartSeries[];
  xLabel: string;
  yLabel: string;
  windowLabel: string;
  formatX: (value: number) => string;
  formatY: (value: number) => string;
  yDomain?: readonly [number, number];
};

const WIDTH = 760;
const PLOT_LEFT = 48;
const PLOT_RIGHT = 520;
const PLOT_TOP = 20;
const PLOT_BOTTOM = 178;
const DASHES = [undefined, '9 5', '2 5', '10 4 2 4'] as const;

function mark(shape: number, key: number, x: number, y: number, label: string): ReactElement {
  const point = shape % 4;
  return <g key={key} aria-label={label}>
    <title>{label}</title>
    {point === 0 ? <circle cx={x} cy={y} r="4" /> : point === 1 ? <rect x={x - 4} y={y - 4} width="8" height="8" /> : point === 2 ? <path d={`M${x} ${y - 5}l5 5-5 5-5-5Z`} /> : <path d={`M${x} ${y - 5}l5 9h-10Z`} />}
  </g>;
}

/** UI chart only. Values always come from caller data; null creates a gap, never a zero. */
export function MonochromeSeriesChart({ title, series, xLabel, yLabel, windowLabel, formatX, formatY, yDomain }: Props): ReactElement {
  const t = useI18n().messages.delivery.chart;
  const patternPrefix = useId().replaceAll(':', '');
  const ordered = series.map((entry) => ({ ...entry, points: [...entry.points].sort((a, b) => a.x - b.x) }));
  const known = ordered.flatMap((entry) => entry.points.filter((point): point is { x: number; y: number } => point.y !== null && Number.isFinite(point.x) && Number.isFinite(point.y)));
  const xValues = ordered.flatMap((entry) => entry.points.filter((point) => Number.isFinite(point.x)).map((point) => point.x));
  const xMin = Math.min(...xValues);
  const xMax = Math.max(...xValues);
  const yMin = yDomain?.[0] ?? Math.min(...known.map((point) => point.y));
  const yMax = yDomain?.[1] ?? Math.max(...known.map((point) => point.y));
  const sx = (x: number) => PLOT_LEFT + ((x - xMin) / (xMax - xMin || 1)) * (PLOT_RIGHT - PLOT_LEFT);
  const sy = (y: number) => PLOT_BOTTOM - ((y - yMin) / (yMax - yMin || 1)) * (PLOT_BOTTOM - PLOT_TOP);
  const tableOnly = series.length > 4;
  const plot = known.length > 0 && !tableOnly;
  const endpoints = ordered.map((entry, index) => {
    const last = [...entry.points].reverse().find((point) => point.y !== null && Number.isFinite(point.y) && Number.isFinite(point.x));
    return last ? { index, x: sx(last.x), y: sy(last.y as number), value: last.y as number, label: entry.label } : null;
  }).filter((entry): entry is NonNullable<typeof entry> => entry !== null).sort((a, b) => a.y - b.y);
  let prior = PLOT_TOP - 20;
  const labelPositions = endpoints.map((entry) => { prior = Math.max(entry.y, prior + 20); return { ...entry, labelY: prior }; });
  const excess = Math.max(0, (labelPositions.at(-1)?.labelY ?? 0) - PLOT_BOTTOM);
  const labels = new Map(labelPositions.map((entry) => [entry.index, { ...entry, labelY: entry.labelY - excess }]));

  return <figure className={styles['chart']} data-testid="monochrome-series-chart">
    <figcaption><strong>{title}</strong><span>{xLabel} · {yLabel} · {windowLabel}</span></figcaption>
    {tableOnly ? <p className={styles['note']}>{t.tooManySeries}</p> : null}
    {!plot && !tableOnly ? <p className={styles['note']}>{t.noSamples}</p> : null}
    {plot ? <div className={styles['plotScroll']}><svg viewBox={`0 0 ${WIDTH} 220`} role="img" aria-label={t.ariaLabel(title, ordered.length, xLabel, yLabel, windowLabel)}>
      <defs>
        <pattern id={`${patternPrefix}-stripe`} width="6" height="6" patternUnits="userSpaceOnUse"><path d="M0 3h6" stroke="currentColor" strokeWidth="1.5" /></pattern>
        <pattern id={`${patternPrefix}-dot`} width="6" height="6" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.2" fill="currentColor" /></pattern>
        <pattern id={`${patternPrefix}-diagonal`} width="6" height="6" patternUnits="userSpaceOnUse"><path d="M-2 6 4 0M2 8 8 2" stroke="currentColor" strokeWidth="1.5" /></pattern>
      </defs>
      <path className={styles['grid']} d={`M${PLOT_LEFT} ${PLOT_TOP}H${PLOT_RIGHT}M${PLOT_LEFT} ${PLOT_BOTTOM}H${PLOT_RIGHT}`} />
      {ordered.map((entry, index) => {
        let started = false;
        const commands = entry.points.flatMap((point) => {
          if (point.y === null || !Number.isFinite(point.y) || !Number.isFinite(point.x)) { started = false; return []; }
          const command = `${started ? 'L' : 'M'}${sx(point.x).toFixed(1)} ${sy(point.y).toFixed(1)}`;
          started = true;
          return [command];
        });
        const end = labels.get(index);
        return <g data-series-id={entry.id} key={entry.id} className={styles['series']}>
          {commands.length > 0 ? <path d={commands.join(' ')} strokeDasharray={DASHES[index]} /> : null}
          {entry.points.filter((point): point is { x: number; y: number } => point.y !== null && Number.isFinite(point.y) && Number.isFinite(point.x)).map((point, pointIndex) => mark(index, pointIndex, sx(point.x), sy(point.y), t.pointLabel(entry.label, formatX(point.x), formatY(point.y))))}
          {end ? <g className={styles['directLabel']}><path d={`M${end.x + 5} ${end.y}L${PLOT_RIGHT + 12} ${end.labelY}`} strokeDasharray={DASHES[index]} /><rect x={PLOT_RIGHT + 16} y={end.labelY - 7} width="12" height="12" fill={index === 0 ? 'currentColor' : `url(#${patternPrefix}-${['', 'stripe', 'dot', 'diagonal'][index]})`} /><text x={PLOT_RIGHT + 34} y={end.labelY + 5}>{entry.label} · {formatY(end.value)}</text></g> : null}
        </g>;
      })}
      <text className={styles['axis']} x={PLOT_LEFT} y="211">{formatX(xMin)}</text>
      {xMin !== xMax ? <text className={styles['axis']} x={PLOT_RIGHT} y="211" textAnchor="end">{formatX(xMax)}</text> : null}
      <text className={styles['axis']} x="2" y={PLOT_TOP + 4}>{formatY(yMax)}</text>
      <text className={styles['axis']} x="2" y={PLOT_BOTTOM + 4}>{formatY(yMin)}</text>
    </svg></div> : null}
    {series.length > 0 ? <details open={tableOnly} className={styles['details']}>
      <summary>{t.viewTable}</summary>
      <div className={styles['tableWrap']}><table><caption>{title} · {windowLabel}</caption><thead><tr><th scope="col">{t.series}</th><th scope="col">{xLabel}</th><th scope="col">{yLabel}</th></tr></thead><tbody>{ordered.flatMap((entry) => entry.points.map((point, index) => <tr key={`${entry.id}:${index}`}><th scope="row">{entry.label}</th><td>{Number.isFinite(point.x) ? formatX(point.x) : t.unknown}</td><td>{point.y === null || !Number.isFinite(point.y) ? t.unknown : formatY(point.y)}</td></tr>))}</tbody></table></div>
    </details> : null}
  </figure>;
}
