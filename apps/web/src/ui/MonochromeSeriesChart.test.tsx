import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MonochromeSeriesChart, type ChartSeries } from './MonochromeSeriesChart';

const props = {
  title: '平台留存',
  xLabel: '作品时间',
  yLabel: '留存率',
  windowLabel: 'LIFETIME · UTC',
  formatX: (value: number) => `${value}s`,
  formatY: (value: number) => `${value}%`,
};

describe('MonochromeSeriesChart', () => {
  it('uses distinct strokes, point shapes, textures, direct labels and a data table', () => {
    const series: ChartSeries[] = ['甲', '乙', '丙', '丁'].map((label, index) => ({ id: label, label, points: [{ x: 0, y: index + 1 }, { x: 1, y: index + 2 }] }));
    const { container } = render(<MonochromeSeriesChart {...props} series={series} />);
    expect(screen.getByRole('img', { name: /平台留存；4 条系列/ })).toBeTruthy();
    const groups = [...container.querySelectorAll('[data-series-id]')];
    expect(groups).toHaveLength(4);
    expect(groups.map((group) => group.querySelector(':scope > path')?.getAttribute('stroke-dasharray'))).toEqual([null, '9 5', '2 5', '10 4 2 4']);
    expect(groups.map((group) => group.querySelector(':scope > g:not([class]) > :last-child')?.tagName.toLowerCase())).toEqual(['circle', 'rect', 'path', 'path']);
    expect(groups.map((group) => group.querySelector('rect[fill]')?.getAttribute('fill'))).toEqual(expect.arrayContaining(['currentColor', expect.stringMatching(/stripe/), expect.stringMatching(/dot/), expect.stringMatching(/diagonal/)]));
    expect(container.querySelectorAll('g text')).toHaveLength(4);
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(9);
  });

  it('uses the full data table for ten series and does not invent pale colour encodings', () => {
    const series: ChartSeries[] = Array.from({ length: 10 }, (_, index) => ({ id: `${index}`, label: `系列${index + 1}`, points: [{ x: 0, y: index }] }));
    const { container } = render(<MonochromeSeriesChart {...props} series={series} />);
    expect(screen.getByText('系列超过 4 条，改用数据表逐项查看。')).toBeTruthy();
    expect(container.querySelector('svg')).toBeNull();
    expect(screen.getByRole('table').querySelectorAll('tbody tr')).toHaveLength(10);
    expect(container.querySelector('details')?.open).toBe(true);
  });

  it('keeps missing values unknown, splits the drawn path, and retains real zero', () => {
    const series: ChartSeries[] = [{ id: 'one', label: '留存', points: [{ x: 0, y: 80 }, { x: 1, y: null }, { x: 2, y: 0 }, { x: 3, y: 20 }] }];
    const { container } = render(<MonochromeSeriesChart {...props} series={series} />);
    expect(container.querySelector('[data-series-id="one"] > path')?.getAttribute('d')).toMatch(/^M[^L]+M[^L]+L/);
    const cells = [...screen.getByRole('table').querySelectorAll('tbody td:last-child')].map((cell) => cell.textContent);
    expect(cells).toEqual(['80%', '未知', '0%', '20%']);
  });

  it('does not draw a zero line for an absent sample', () => {
    const { container } = render(<MonochromeSeriesChart {...props} series={[{ id: 'empty', label: '留存', points: [{ x: 0, y: null }] }]} />);
    expect(container.querySelector('svg')).toBeNull();
    expect(screen.getByText('暂无可绘制的采样值；缺失值保持未知。')).toBeTruthy();
    expect(screen.getByRole('table').querySelector('tbody td:last-child')?.textContent).toBe('未知');
  });
});
