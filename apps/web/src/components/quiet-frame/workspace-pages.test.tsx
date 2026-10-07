import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { mockClient, renderWithClient } from '@/test-utils.js';
import { WorkspaceIdentity } from './workspace-identity.js';
import { WorkspaceExtensions } from './workspace-extensions.js';
import { WorkspaceSettings } from './workspace-settings.js';
import { DesignSystemPage, WelcomePage } from './workspace-public.js';

vi.mock('next/link', () => ({ default: ({ children, href, ...props }: { children: unknown; href: string }) => <a href={href} {...props}>{children as never}</a> }));

describe('Quiet Frame 工作区与公开页', () => {
  it('身份页从真实 SDK 列表读取，并通过 create 提交新身份', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'cid_1' });
    const client = mockClient({
      workspaces: { get: vi.fn().mockResolvedValue({ role: 'OWNER' }) },
      creatorIdentities: { list: vi.fn().mockResolvedValue([]), create },
      speechProfiles: { list: vi.fn().mockResolvedValue([]) },
      voiceClone: { state: vi.fn() },
      assets: { list: vi.fn() },
    });
    renderWithClient(<WorkspaceIdentity workspaceId="ws_1" />, client);
    await screen.findByText('先创建身份，再配置声音、表达和品牌。');
    await userEvent.type(screen.getByLabelText('身份名称'), '我的创作身份');
    await userEvent.click(screen.getByRole('button', { name: '保存身份' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith('ws_1', { displayName: '我的创作身份' }));
    expect((await screen.findByRole('status')).textContent).toContain('身份已保存');
  });

  it('声音授权读取当前声明后才允许确认，不触发付费克隆任务', async () => {
    const confirmConsent = vi.fn().mockResolvedValue({});
    const submit = vi.fn();
    const identity = { id: 'cid_1', displayName: '作者', updatedAt: '2026-10-07T00:00:00Z', brandIdentity: null, voiceIdentity: null };
    const client = mockClient({
      workspaces: { get: vi.fn().mockResolvedValue({ role: 'EDITOR' }) },
      creatorIdentities: { list: vi.fn().mockResolvedValue([identity]) },
      speechProfiles: { list: vi.fn().mockResolvedValue([]) },
      voiceClone: { state: vi.fn().mockResolvedValue({ clone: null, consent: null, samples: [] }), consentStatement: vi.fn().mockResolvedValue({ statement: '授权声明正文' }), confirmConsent, submit },
      assets: { list: vi.fn().mockResolvedValue([]) },
    });
    renderWithClient(<WorkspaceIdentity workspaceId="ws_1" />, client);
    await userEvent.click(await screen.findByRole('button', { name: /创建我的声音/ }));
    await screen.findByText('授权声明正文');
    const confirm = screen.getByRole('button', { name: '确认授权' });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    await userEvent.click(screen.getByRole('checkbox', { name: /我已阅读并同意/ }));
    await userEvent.click(confirm);
    await waitFor(() => expect(confirmConsent).toHaveBeenCalledWith('ws_1', 'cid_1', { subjectType: 'SELF' }));
    expect(submit).not.toHaveBeenCalled();
  });

  it('扩展页只为实际安装的 Pack 启用，并保留项目绑定提醒', async () => {
    const enable = vi.fn().mockResolvedValue({ packId: 'ancs.pack.shorts-analyzer', version: '1.0', enabledAt: '2026-10-07T00:00:00Z' });
    const client = mockClient({
      packs: { list: vi.fn().mockResolvedValue([{ installation: { packId: 'ancs.pack.shorts-analyzer', status: 'INSTALLED', name: 'Shorts Analyzer', version: '1.0' }, enabled: false, enabledVersion: null }]), enable, disable: vi.fn() },
      workspaces: { get: vi.fn().mockResolvedValue({ role: 'OWNER' }) },
    });
    renderWithClient(<WorkspaceExtensions workspaceId="ws_1" />, client);
    await screen.findByText('Shorts');
    expect(screen.getByText('尚未安装')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '了解并管理 Shorts' }));
    expect(screen.getByRole('dialog', { name: 'Shorts扩展详情' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '启用' }));
    await waitFor(() => expect(enable).toHaveBeenCalledWith('ws_1', 'ancs.pack.shorts-analyzer'));
    expect((await screen.findByRole('status')).textContent).toContain('项目仍需单独绑定版本');
  });

  it('设置页按真实账单状态显示余额，并提交服务端预算', async () => {
    const setBudget = vi.fn().mockResolvedValue({});
    const client = mockClient({
      workspaces: { get: vi.fn().mockResolvedValue({ name: '工作区', role: 'OWNER', privacyTier: 'STANDARD' }) },
      providerConnections: { list: vi.fn().mockResolvedValue([]) },
      providerSettings: { list: vi.fn().mockResolvedValue([]) },
      billing: { status: vi.fn().mockResolvedValue({ balanceCredits: 60, budget: null, usage: { spentCredits: 5, reservedCredits: 2 } }), setBudget },
    });
    renderWithClient(<WorkspaceSettings workspaceId="ws_1" />, client);
    await userEvent.click(screen.getByRole('button', { name: '用量与预算' }));
    await screen.findByText('60 Credits');
    fireEvent.change(screen.getByLabelText('周期上限（Credits）'), { target: { value: '25' } });
    await userEvent.click(screen.getByRole('button', { name: '保存预算' }));
    await waitFor(() => expect(setBudget).toHaveBeenCalledWith('ws_1', { period: 'MONTHLY', limitCredits: 25, perJobMaxCredits: 0 }));
  });

  it('BYOK 密钥只在创建请求中提交一次，响应仅显示掩码', async () => {
    const fixture = 'synthetic-ui-value';
    const create = vi.fn().mockResolvedValue({ id: 'pcon_1', maskedToken: '••••abcd' });
    const client = mockClient({
      workspaces: { get: vi.fn().mockResolvedValue({ name: '工作区', role: 'OWNER', privacyTier: 'STANDARD' }) },
      providerConnections: { list: vi.fn().mockResolvedValue([]), create },
      providerSettings: { list: vi.fn().mockResolvedValue([]) },
    });
    renderWithClient(<WorkspaceSettings workspaceId="ws_1" />, client);
    const secret = await screen.findByLabelText('API Key / Token');
    fireEvent.change(screen.getByLabelText('Provider ID'), { target: { value: 'provider.test' } });
    fireEvent.change(screen.getByLabelText('连接名称'), { target: { value: '个人 LLM' } });
    fireEvent.change(secret, { target: { value: fixture } });
    await userEvent.click(screen.getByRole('button', { name: '安全保存连接' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith('ws_1', { providerId: 'provider.test', kind: 'LLM', label: '个人 LLM', secret: fixture }));
    await waitFor(() => expect((secret as HTMLInputElement).value).toBe(''));
    expect(screen.queryByText(fixture)).toBeNull();
  });

  it('欢迎页匿名入口前往登录，设计系统中的操作样本不伪装成真实数据', () => {
    const client = mockClient({ auth: { session: vi.fn().mockRejectedValue(new Error('未登录')) } });
    const landing = renderWithClient(<WelcomePage />, client);
    expect(screen.getByRole('link', { name: /开始你的第一部作品/ }).getAttribute('href')).toBe('/sign-in');
    expect(screen.getByRole('link', { name: /进入工作室/ }).getAttribute('href')).toBe('/sign-in');
    expect(screen.getByLabelText('静态产品界面示意，不含真实项目数据')).toBeTruthy();
    landing.unmount();
    renderWithClient(<DesignSystemPage />, client);
    expect(screen.getByText('Quiet Frame · 静框')).toBeTruthy();
    expect(screen.getByRole('link', { name: /返回创作台/ }).getAttribute('href')).toBe('/');
  });

  it('欢迎页已有会话时直接进入创作台', async () => {
    const client = mockClient({ auth: { session: vi.fn().mockResolvedValue({ user: { id: 'usr_1', email: 'a@test.local' } }) } });
    renderWithClient(<WelcomePage />, client);
    await waitFor(() => expect(screen.getByRole('link', { name: /开始你的第一部作品/ }).getAttribute('href')).toBe('/'));
  });
});
