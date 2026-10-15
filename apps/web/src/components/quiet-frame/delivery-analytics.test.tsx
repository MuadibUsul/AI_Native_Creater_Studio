import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n/I18nProvider';
import { mockClient, renderWithClient } from '@/test-utils';
import { DeliveryAnalytics, formatMetric, retentionSegments } from './delivery-analytics';

describe('Quiet Frame analytics data rendering', () => {
  it('keeps absent platform metrics unknown rather than turning them into zero', () => {
    expect(formatMetric(null)).toBe('—');
    expect(formatMetric(undefined)).toBe('—');
    expect(formatMetric(0)).toBe('0');
    expect(formatMetric(12480)).toBe('12,480');
  });

  it('draws only real samples and breaks the path across missing retention values', () => {
    const path = retentionSegments([
      { positionMs: 3000, rate: 0.7 },
      { positionMs: 0, rate: 1 },
      { positionMs: 1000, rate: 0.9 },
      { positionMs: 2000, rate: null },
      { positionMs: 4000, rate: 0.6 },
    ]);
    expect(path).toHaveLength(4);
    expect(path[0]).toMatch(/^M/);
    expect(path[1]).toMatch(/^L/);
    expect(path[2]).toMatch(/^M/);
    expect(path[3]).toMatch(/^L/);
    expect(retentionSegments([{ positionMs: 0, rate: null }, { positionMs: 1000, rate: 0.5 }])).toEqual([]);
  });

  it('keeps real performance visible when Finance is unavailable, including advanced learning tools', async () => {
    const listDataSources = vi.fn().mockRejectedValue(new Error('Finance 暂不可用'));
    const client = mockClient({
      publications: {
        list: vi.fn().mockResolvedValue({ items: [{ id: 'pub_1', title: '真实作品', platformId: 'YOUTUBE' }] }),
        listAnalytics: vi.fn().mockResolvedValue({ items: [{ id: 'perf_1', platformId: 'YOUTUBE', metrics: { views: 42, impressions: null, clickThroughRate: null, watchTimeMs: null, averageWatchTimeMs: null, retention: [] }, sampling: { source: 'provider', fetchedAt: '2026-10-07T08:00:00.000Z', granularity: 'LIFETIME', timezone: 'UTC' } }] }),
      },
      analytics: { listScenes: vi.fn().mockResolvedValue({ items: [] }), listLearnings: vi.fn().mockResolvedValue({ items: [] }) },
      finance: { listDataSources },
    });
    renderWithClient(<DeliveryAnalytics workspaceId="ws_1" projectId="prj_1" />, client);
    expect(await screen.findByText('42')).toBeTruthy();
    await userEvent.click(screen.getByText('高级表现与建议管理'));
    expect(await screen.findByTestId('analytics-workspace')).toBeTruthy();
    expect(screen.getAllByText('42').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('Finance Pack')).toBeNull();
    expect(listDataSources).not.toHaveBeenCalled();
  });

  it('renders performance, the retention chart and advanced tools in English without Chinese interface text', async () => {
    const client = mockClient({
      publications: {
        list: vi.fn().mockResolvedValue({ items: [{ id: 'pub_1', title: 'Launch cut', platformId: 'YOUTUBE' }] }),
        listAnalytics: vi.fn().mockResolvedValue({ items: [{ id: 'perf_1', platformId: 'YOUTUBE', metrics: { views: 12480, impressions: null, clickThroughRate: null, watchTimeMs: null, averageWatchTimeMs: 65_000, retention: [{ positionMs: 0, rate: 1 }, { positionMs: 30_000, rate: 0.6 }] }, sampling: { source: 'provider', fetchedAt: '2026-10-07T08:00:00.000Z', granularity: 'LIFETIME', timezone: 'UTC' } }] }),
      },
      analytics: {
        listScenes: vi.fn().mockResolvedValue({ items: [{ id: 'sp_1', sceneId: 'scn_00001', sceneType: 'LINE_CHART', position: 0, startMs: 0, durationMs: 30_000, retentionRate: null, derivation: { method: 'TIME_WINDOW_AVERAGE', sampleCount: 1 } }] }),
        listLearnings: vi.fn().mockResolvedValue({ items: [{ id: 'lrn_1', title: 'Shorter openings', explanation: 'Short scenes retained better.', status: 'ACTIVE', evidence: { sampleCount: 2 } }] }),
      },
    });
    const { container } = renderWithClient(<I18nProvider initialLocale="en"><DeliveryAnalytics workspaceId="ws_1" projectId="prj_1" /></I18nProvider>, client);
    expect(await screen.findByText('12,480')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'See how your work is understood.' })).toBeTruthy();
    expect(screen.getByText('YOUTUBE · Real snapshot')).toBeTruthy();
    expect(screen.getByText('Average watch time')).toBeTruthy();
    expect(screen.getByRole('img', { name: /^Real platform retention curve; 1 series; Video time and Relative retention; LIFETIME · UTC · Fetched / })).toBeTruthy();
    expect(screen.getByText('View data table')).toBeTruthy();
    expect(await screen.findByText('Correlation · 2 samples')).toBeTruthy();
    expect(await screen.findByText('Unknown')).toBeTruthy();
    await userEvent.click(screen.getByText('Advanced performance and suggestions'));
    expect(await screen.findByTestId('analytics-workspace')).toBeTruthy();
    expect(screen.getByText('Publishing performance')).toBeTruthy();
    expect(screen.getAllByText('Unknown (not returned by the platform)').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Correlation evidence · 2 samples · Channel unchanged')).toBeTruthy();
    expect(container.textContent).not.toMatch(/[\u4e00-\u9fff]/);
    expect(container.innerHTML).not.toMatch(/[\u4e00-\u9fff]/);
  });
});
