import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n/I18nProvider';
import { mockClient, renderWithClient } from '@/test-utils.js';

vi.mock('next/navigation', () => ({
  useParams: () => ({ workspaceId: 'ws_1' }),
  usePathname: () => '/w/ws_1/team',
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: unknown; href: string }) => <a href={href}>{children as never}</a>,
}));

const { default: TeamPage } = await import('@/app/w/[workspaceId]/team/page.js');

/**
 * 团队与隐私（P09-04）状态矩阵：
 * - 成员列表 + 角色变更调用 SDK；移除成员提示"立即失效"；
 * - 邀请创建（邮箱+角色）与撤销调用 SDK；PENDING 唯一；
 * - 超额提示（降级 seats）可见且文案明确"存量保留"；
 * - 隐私档位：无权益时非 STANDARD 按钮禁用；有权益可设置（调用 SDK）。
 */

const member = (overrides: Record<string, unknown> = {}) => ({
  userId: 'usr_1',
  email: 'owner@test.local',
  name: 'Owner',
  role: 'OWNER',
  joinedAt: '2026-10-05T10:00:00.000Z',
  ...overrides,
});

const invitation = (overrides: Record<string, unknown> = {}) => ({
  id: 'winv_1',
  workspaceId: 'ws_1',
  email: 'invitee@test.local',
  role: 'EDITOR',
  status: 'PENDING',
  invitedByUserId: 'usr_1',
  createdAt: '2026-10-05T10:00:00.000Z',
  expiresAt: '2026-10-19T10:00:00.000Z',
  acceptedAt: null,
  acceptedByUserId: null,
  ...overrides,
});

const entitlement = (overrides: Record<string, unknown> = {}) => ({
  workspaceId: 'ws_1',
  plan: { id: 'pln_1', planKey: 'STUDIO', version: 1, name: 'Studio', entitlements: {}, price: null, status: 'ACTIVE', createdAt: '2026-10-05T10:00:00.000Z' },
  entitlements: { seats: 10, storageBytes: null, privacyMode: true },
  usage: { storageBytesUsed: 0, seatsUsed: 2, channelsUsed: 0, creatorIdentitiesUsed: 0, customMotionUsedThisMonth: 0 },
  source: 'SUBSCRIPTION',
  overCommitted: [],
  ...overrides,
});

const workspace = (overrides: Record<string, unknown> = {}) => ({
  id: 'ws_1',
  name: '工作室',
  privacyTier: 'STANDARD',
  role: 'OWNER',
  createdAt: '2026-10-05T10:00:00.000Z',
  updatedAt: '2026-10-05T10:00:00.000Z',
  ...overrides,
});

function teamClient(overrides: Record<string, unknown> = {}) {
  return mockClient({
    workspaces: {
      get: vi.fn().mockResolvedValue(workspace()),
      members: { list: vi.fn().mockResolvedValue([member()]), add: vi.fn(), updateRole: vi.fn(), remove: vi.fn() },
      invitations: { list: vi.fn().mockResolvedValue([invitation()]), create: vi.fn(), revoke: vi.fn() },
      setPrivacyTier: vi.fn(),
      entitlements: vi.fn().mockResolvedValue(entitlement()),
      ...overrides,
    },
  });
}

describe('团队与隐私（P09-04）', () => {
  it('成员：角色变更与移除调用 SDK；移除提示访问立即失效', async () => {
    const updateRole = vi.fn().mockResolvedValue(member({ role: 'ADMIN' }));
    const remove = vi.fn().mockResolvedValue(undefined);
    const client = teamClient({
      members: { list: vi.fn().mockResolvedValue([member(), member({ userId: 'usr_2', email: 'co-owner@test.local', name: 'Co-owner' })]), add: vi.fn(), updateRole, remove },
    });
    renderWithClient(<TeamPage />, client);

    expect(await screen.findByText('owner@test.local')).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText('角色-owner@test.local'), 'ADMIN');
    await waitFor(() => expect(updateRole).toHaveBeenCalledWith('ws_1', 'usr_1', { role: 'ADMIN' }));

    await userEvent.click(within(screen.getByTestId('member-usr_1')).getByRole('button', { name: '移除' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('ws_1', 'usr_1'));
    expect((await screen.findByTestId('team-notice')).textContent).toMatch(/立即失效/);
  });

  it('最后一名所有者不能在界面中降级或移除，并解释原因', async () => {
    renderWithClient(<TeamPage />, teamClient());

    const role = await screen.findByLabelText('角色-owner@test.local');
    const remove = screen.getByRole('button', { name: '移除' });
    expect((role as HTMLSelectElement).disabled).toBe(true);
    expect(role.getAttribute('title')).toMatch(/至少一名所有者/);
    expect((remove as HTMLButtonElement).disabled).toBe(true);
    expect(remove.getAttribute('title')).toMatch(/最后一名所有者/);
  });

  it('邀请：创建（邮箱+角色）与撤销调用 SDK；PENDING 唯一与接受条件有明确说明', async () => {
    const create = vi.fn().mockResolvedValue(invitation({ email: 'new@test.local' }));
    const revoke = vi.fn().mockResolvedValue(invitation({ status: 'REVOKED' }));
    const client = teamClient({
      invitations: { list: vi.fn().mockResolvedValue([invitation()]), create, revoke },
    });
    renderWithClient(<TeamPage />, client);

    await userEvent.type(await screen.findByLabelText('邀请邮箱'), 'new@test.local');
    await userEvent.selectOptions(screen.getByLabelText('邀请角色'), 'VIEWER');
    await userEvent.click(screen.getByRole('button', { name: '邀请' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith('ws_1', { email: 'new@test.local', role: 'VIEWER' }));

    await userEvent.click(screen.getAllByRole('button', { name: '撤销' })[0] as HTMLButtonElement);
    await waitFor(() => expect(revoke).toHaveBeenCalledWith('ws_1', 'winv_1'));
    expect(screen.getByText(/接受条件：登录邮箱 = 邀请邮箱/)).toBeTruthy();
  });

  it('降级超额：提示可见且明确"存量保留"；隐私档位无权益时禁用非 STANDARD', async () => {
    const setPrivacyTier = vi.fn().mockResolvedValue(workspace({ privacyTier: 'PRIVATE' }));
    const client = teamClient({
      entitlements: vi.fn().mockResolvedValue(entitlement({ entitlements: { seats: 1, storageBytes: null, privacyMode: false }, overCommitted: ['seats', 'privacyMode'] })),
      setPrivacyTier,
    });
    renderWithClient(<TeamPage />, client);

    const banner = await screen.findByTestId('over-committed');
    expect(banner.textContent).toMatch(/席位/);
    expect(banner.textContent).toMatch(/隐私档位/);
    expect(banner.textContent).toMatch(/现有成员与数据保留/);

    // 无 privacyMode 权益：选择 PRIVATE 后按钮禁用（不可发送无效请求）
    await userEvent.selectOptions(screen.getByLabelText('隐私档位'), 'PRIVATE');
    const apply = screen.getByRole('button', { name: '应用档位' });
    expect((apply as HTMLButtonElement).disabled).toBe(true);
  });

  it('隐私档位有权益：设置调用 SDK', async () => {
    const setPrivacyTier = vi.fn().mockResolvedValue(workspace({ privacyTier: 'PRIVATE' }));
    const client = teamClient({ setPrivacyTier });
    renderWithClient(<TeamPage />, client);

    expect((await screen.findByTestId('privacy-tier')).textContent).toBe('STANDARD');
    await userEvent.selectOptions(screen.getByLabelText('隐私档位'), 'PRIVATE');
    await userEvent.click(screen.getByRole('button', { name: '应用档位' }));
    await waitFor(() => expect(setPrivacyTier).toHaveBeenCalledWith('ws_1', { privacyTier: 'PRIVATE' }));
  });

  it('英文界面：成员、邀请、超额提示与隐私档位显示英文，没有中文残留', async () => {
    const client = teamClient({
      get: vi.fn().mockResolvedValue(workspace({ name: 'Studio' })),
      invitations: { list: vi.fn().mockResolvedValue([invitation()]), create: vi.fn(), revoke: vi.fn() },
      entitlements: vi.fn().mockResolvedValue(entitlement({ entitlements: { seats: 1, storageBytes: null, privacyMode: false }, overCommitted: ['seats', 'privacyMode'] })),
    });
    const { container } = renderWithClient(<I18nProvider initialLocale="en"><TeamPage /></I18nProvider>, client);

    expect(await screen.findByText('owner@test.local')).toBeTruthy();
    expect(screen.getAllByRole('heading', { name: 'Team & privacy' }).length).toBe(2);
    expect(screen.getByRole('heading', { name: 'Members (1)' })).toBeTruthy();
    expect(screen.getByText(/^Joined /)).toBeTruthy();
    const banner = await screen.findByTestId('over-committed');
    expect(banner.textContent).toBe('Over the current plan limits: Seats, Privacy tier. New additions are blocked; existing members and data are kept (nothing is removed or deleted automatically). Upgrade your plan or adjust explicitly.');
    const role = screen.getByLabelText('Role for owner@test.local');
    expect(role.getAttribute('title')).toBe('A workspace must keep at least one owner');
    expect(screen.getByLabelText('Invitation email')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Invite' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeTruthy();
    expect(screen.getByText(/your plan does not include privacy mode/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Apply tier' })).toBeTruthy();
    expect(container.textContent).not.toMatch(/[一-鿿]/);
  });
});
