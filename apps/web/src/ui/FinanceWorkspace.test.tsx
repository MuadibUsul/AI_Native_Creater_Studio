import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { mockClient, renderWithClient } from '@/test-utils.js';
import { FinanceWorkspace } from './FinanceWorkspace.js';

describe('FinanceWorkspace', () => {
  it('keeps all six visualization types and rejects missing numeric data', async () => {
    const client = mockClient({ finance: {
      listDataSources: vi.fn().mockResolvedValue({ items: [] }),
      listTemplates: vi.fn().mockResolvedValue({ items: [] }),
      listArtifacts: vi.fn().mockResolvedValue({ items: [] }),
      createDataSource: vi.fn(), createTemplate: vi.fn(), generateArtifact: vi.fn(),
    } });
    renderWithClient(<FinanceWorkspace workspaceId="ws_1" />, client);
    await screen.findByText('Finance Pack');
    const pack = screen.getByTestId('finance-pack');
    expect(pack.classList.contains('panel')).toBe(true);
    expect(pack.querySelectorAll('form.panel')).toHaveLength(3);
    expect(pack.querySelectorAll('.field').length).toBeGreaterThan(10);
    expect(pack.querySelector('[class*="slate"]')).toBeNull();
    expect(screen.getByLabelText('可视化类型').querySelectorAll('option')).toHaveLength(6);
    await userEvent.type(screen.getByLabelText('产物标题'), '政策利率路径');
    await userEvent.type(screen.getByLabelText('数据标签'), '2026 Q4');
    await userEvent.click(screen.getByRole('button', { name: '生成并冻结快照' }));
    expect(await screen.findByText(/缺失数据不可生成图表/)).toBeTruthy();
    await userEvent.type(screen.getByLabelText('数据值'), '无效数值');
    await userEvent.click(screen.getByRole('button', { name: '生成并冻结快照' }));
    expect(await screen.findByText(/请输入有效数值/)).toBeTruthy();
  });

  it('shows Finance errors locally and can retry without other app data', async () => {
    const listDataSources = vi.fn().mockRejectedValueOnce(new Error('来源暂不可用')).mockResolvedValue({ items: [] });
    const client = mockClient({ finance: {
      listDataSources,
      listTemplates: vi.fn().mockResolvedValue({ items: [] }),
      listArtifacts: vi.fn().mockResolvedValue({ items: [] }),
    } });
    renderWithClient(<FinanceWorkspace workspaceId="ws_1" />, client);
    expect(await screen.findByText('Finance 图表素材加载失败')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    await screen.findByText('Finance Pack');
    await waitFor(() => expect(listDataSources).toHaveBeenCalledTimes(2));
  });

  it('preserves licensed source, template version, unit and observation metadata in SDK calls', async () => {
    const source = { id: 'fds_1', name: '来源 A', license: { name: '许可 A' } };
    const template = { id: 'fmt_1', key: 'rates', name: '利率模板', version: 1, visualizationType: 'CANDLE' };
    let sources: typeof source[] = [];
    let templates: typeof template[] = [];
    const createDataSource = vi.fn().mockImplementation(async () => { sources = [source]; return source; });
    const createTemplate = vi.fn().mockImplementation(async () => { templates = [template]; return template; });
    const generateArtifact = vi.fn().mockResolvedValue({ id: 'fart_1' });
    const client = mockClient({ finance: {
      listDataSources: vi.fn().mockImplementation(async () => ({ items: sources })),
      listTemplates: vi.fn().mockImplementation(async () => ({ items: templates })),
      listArtifacts: vi.fn().mockResolvedValue({ items: [] }),
      createDataSource, createTemplate, generateArtifact,
    } });
    renderWithClient(<FinanceWorkspace workspaceId="ws_1" />, client);
    await screen.findByText('Finance Pack');
    await userEvent.type(screen.getByLabelText('来源名称'), '来源 A');
    await userEvent.type(screen.getByLabelText('许可证 ID'), 'lic_1');
    await userEvent.type(screen.getByLabelText('许可证名称'), '许可 A');
    await userEvent.click(screen.getByRole('button', { name: '保存来源' }));
    await waitFor(() => expect(createDataSource).toHaveBeenCalledWith('ws_1', expect.objectContaining({ name: '来源 A', license: expect.objectContaining({ licenseId: 'lic_1', name: '许可 A', allowedUse: '内部视频制作', effectiveAt: expect.any(String) }) })));
    await waitFor(() => expect(screen.getByLabelText('产物数据来源').querySelector('option[value="fds_1"]')).not.toBeNull());

    await userEvent.type(screen.getByLabelText('模板 Key'), 'rates');
    await userEvent.type(screen.getByLabelText('模板名称'), '利率模板');
    await userEvent.click(screen.getByRole('button', { name: '保存新版本' }));
    await waitFor(() => expect(createTemplate).toHaveBeenCalledWith('ws_1', { key: 'rates', name: '利率模板', visualizationType: 'CANDLE', config: {} }));
    await waitFor(() => expect(screen.getByLabelText('产物模板').querySelector('option[value="fmt_1"]')).not.toBeNull());

    await userEvent.type(screen.getByLabelText('产物标题'), '利率观察');
    await userEvent.type(screen.getByLabelText('数据标签'), '本期');
    await userEvent.type(screen.getByLabelText('数据值'), '4.25');
    await userEvent.clear(screen.getByLabelText('单位'));
    await userEvent.type(screen.getByLabelText('单位'), 'bps');
    await userEvent.clear(screen.getByLabelText('时区'));
    await userEvent.type(screen.getByLabelText('时区'), 'Asia/Shanghai');
    await userEvent.click(screen.getByRole('button', { name: '生成并冻结快照' }));
    await waitFor(() => expect(generateArtifact).toHaveBeenCalledWith('ws_1', expect.objectContaining({
      visualizationType: 'CANDLE', title: '利率观察', dataSourceId: 'fds_1', templateId: 'fmt_1',
      data: [expect.objectContaining({ label: '本期', value: 4.25, unit: 'bps', timezone: 'Asia/Shanghai', adjustment: 'UNADJUSTED', sourceId: 'fds_1', observedAt: expect.any(String) })],
    })));
  });
});
