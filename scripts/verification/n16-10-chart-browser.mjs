/* global document, getComputedStyle, window */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { DEFAULT_CHANNEL_STYLE } from '../../packages/contracts/dist/index.js';

const baseUrl = process.env.ANCS_WEB_URL ?? 'http://127.0.0.1:4200';
const now = '2026-10-08T00:00:00.000Z';
const workspaceId = 'ws_chart_fixture';
const projectId = 'prj_chart_fixture';
const base = `/api/v1/workspaces/${workspaceId}/projects/${projectId}`;
const workspace = { id: workspaceId, name: '图表排版测试', privacyTier: 'STANDARD', createdAt: now, updatedAt: now, role: 'OWNER' };
const project = { id: projectId, workspaceId, channelId: 'chn_chart_fixture', title: '图表测试项目', sourceType: 'MANUAL_SCRIPT', status: 'READY', revision: 1, aspectRatio: '16:9', resolution: '1920x1080', fps: 30, targetDurationMs: 30000, createdAt: now, updatedAt: now };
const publication = { id: 'pub_chart_fixture', workspaceId, projectId, platformId: 'YOUTUBE', accountId: 'acc_chart_fixture', projectVersionId: 'pv_chart_fixture', outputAssetId: 'ast_chart_fixture', state: 'PUBLISHED', remoteId: 'remote_chart_fixture', remoteUrl: null, publishedAt: now, title: '真实平台接口数据形状的视觉样本', description: null, tags: [], scheduledAt: null, disclosure: null, lastError: null, transferInstructions: null, createdAt: now, updatedAt: now };
const performance = { id: 'perf_chart_fixture', workspaceId, projectId, publicationId: publication.id, projectVersionId: publication.projectVersionId, platformId: 'YOUTUBE', remoteId: publication.remoteId, sampling: { from: null, to: null, granularity: 'LIFETIME', timezone: 'UTC', source: 'browser-fixture', fetchedAt: now }, metrics: { views: 42, impressions: null, clickThroughRate: null, watchTimeMs: null, averageWatchTimeMs: null, retention: [{ positionMs: 0, rate: 1 }, { positionMs: 10000, rate: null }, { positionMs: 20000, rate: 0 }, { positionMs: 30000, rate: 0.4 }] }, rawEventId: 'aevt_chart_fixture', createdAt: now };
const routes = new Map([
  ['/api/v1/auth/session', { user: { id: 'usr_chart_fixture', email: 'chart-fixture@example.test', name: '图表测试', emailVerified: true }, sessionId: 'ses_chart_fixture', method: 'web_session', expiresAt: '2026-12-31T00:00:00.000Z' }],
  ['/api/v1/users/me/appearance', { userId: 'usr_chart_fixture', mode: 'system', updatedAt: null }],
  ['/api/v1/workspaces', { items: [workspace], nextCursor: null }],
  [`/api/v1/workspaces/${workspaceId}`, workspace],
  [`/api/v1/workspaces/${workspaceId}/projects`, { items: [project], nextCursor: null }],
  [`/api/v1/projects/${projectId}`, { ...project, channelSnapshot: { channelId: project.channelId, channelStyleVersionId: 'chsv_chart_fixture', styleVersion: 1, defaults: DEFAULT_CHANNEL_STYLE } }],
  [`${base}/publications`, { items: [publication] }],
  [`${base}/publications/${publication.id}/analytics`, { items: [performance] }],
  [`${base}/analytics/performance/${performance.id}/scenes`, { items: [] }],
  [`${base}/analytics/learnings`, { items: [] }],
]);
const evidenceDir = resolve('.artifacts/v04/N16-10');
await mkdir(evidenceDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const requests = [];
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    requests.push(`${request.method()} ${path}`);
    assert.equal(request.method(), 'GET');
    if (!routes.has(path)) throw new Error(`Missing browser-only fixture: ${path}`);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(routes.get(path)) });
  });
  assert.equal((await page.goto(`${baseUrl}/w/${workspaceId}/p/${projectId}/analytics`, { waitUntil: 'networkidle' }))?.status(), 200);
  await page.getByTestId('monochrome-series-chart').waitFor({ state: 'visible' });
  assert.equal(await page.getByRole('img', { name: /真实平台留存曲线/ }).count(), 1);
  const chart = page.getByTestId('monochrome-series-chart');
  const sample = await chart.evaluate((figure) => ({
    path: figure.querySelector('[data-series-id="retention"] > path')?.getAttribute('d'),
    rows: [...figure.querySelectorAll('tbody tr')].map((row) => row.textContent?.trim()),
    lineColor: getComputedStyle(figure.querySelector('[data-series-id="retention"] > path')).stroke,
    chartColor: getComputedStyle(figure).color,
  }));
  assert.match(sample.path, /^M[^L]+M[^L]+L/);
  assert(sample.rows.some((row) => row?.includes('未知')));
  assert(sample.rows.some((row) => row?.includes('0.0%')));
  assert.equal(sample.lineColor, sample.chartColor);
  await chart.screenshot({ path: resolve(evidenceDir, 'chart-light.png') });
  await page.evaluate(() => document.body.classList.add('theme-dark'));
  const dark = await chart.evaluate((figure) => ({ lineColor: getComputedStyle(figure.querySelector('[data-series-id="retention"] > path')).stroke, chartColor: getComputedStyle(figure).color }));
  assert.equal(dark.lineColor, dark.chartColor);
  assert.notEqual(dark.lineColor, sample.lineColor);
  await chart.screenshot({ path: resolve(evidenceDir, 'chart-dark.png') });
  await page.setViewportSize({ width: 320, height: 800 });
  const mobile = await chart.evaluate((figure) => {
    const scroll = figure.querySelector('svg')?.parentElement;
    const panel = figure.closest('.panel');
    const split = figure.closest('.split');
    return { viewportWidth: window.innerWidth, documentWidth: document.documentElement.scrollWidth, chartScrollWidth: scroll?.scrollWidth, chartClientWidth: scroll?.clientWidth, overflowX: scroll ? getComputedStyle(scroll).overflowX : null, figureWidth: figure.getBoundingClientRect().width, panelWidth: panel?.getBoundingClientRect().width, splitWidth: split?.getBoundingClientRect().width, gridTemplateColumns: split ? getComputedStyle(split).gridTemplateColumns : null };
  });
  assert.equal(mobile.viewportWidth, 320);
  assert.equal(mobile.overflowX, 'auto');
  assert(mobile.chartScrollWidth > mobile.chartClientWidth, JSON.stringify(mobile));
  assert(mobile.documentWidth <= mobile.viewportWidth + 1, JSON.stringify(mobile));
  await chart.screenshot({ path: resolve(evidenceDir, 'chart-mobile-320.png') });
  process.stdout.write(`${JSON.stringify({ result: 'PASS', route: `${baseUrl}/w/${workspaceId}/p/${projectId}/analytics`, requests, sample, lightLine: sample.lineColor, darkLine: dark.lineColor, mobile, boundary: 'browser-only GET fixtures shaped like public SDK responses; no database or third-party platform call' }, null, 2)}\n`);
} finally {
  await browser.close();
}
