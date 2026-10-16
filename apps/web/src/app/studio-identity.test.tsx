import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { IDENTITY_CONSENT_STATEMENTS } from '@ancs/contracts';
import { mockClient, renderWithClient } from '@/test-utils.js';

vi.mock('next/navigation', () => ({ useParams: () => ({ workspaceId: 'ws_1' }) }));

const { default: IdentityPage } = await import('./w/[workspaceId]/studio/identity/page.js');

const part = (overrides: Record<string, unknown> = {}) => ({ reference: null, consent: null, ready: false, ...overrides });
const reference = (kind: 'LIKENESS' | 'VOICE', filename: string) => ({ kind, assetId: `ast_${kind}`, footageId: `av_${kind}`, filename, mimeType: kind === 'LIKENESS' ? 'image/png' : 'audio/wav', durationMs: null, addedAt: '2026-10-14T00:00:00.000Z' });
const profile = (overrides: Record<string, unknown> = {}) => ({
  id: 'cid_1', name: '我自己', likeness: part(), voice: part(), history: [], createdAt: '2026-10-14T00:00:00.000Z', ...overrides,
});
const statement = { version: 'v6-7.1', statements: IDENTITY_CONSENT_STATEMENTS };

/**
 * V6-7 我的形象与声音：建档案；上传照片/声音样本后读到授权声明并选择"本人/已获授权"再同意（带当前声明版本与界面语言）；
 * 已授权可撤回；授权记录可查。
 */
describe('我的形象与声音', () => {
  it('新建档案；有参考照片时显示声明，同意时带上声明版本、语言与"本人/已获授权"', async () => {
    const create = vi.fn().mockResolvedValue(profile());
    const grantConsent = vi.fn().mockResolvedValue(profile());
    const list = vi.fn().mockResolvedValue([profile({ likeness: part({ reference: reference('LIKENESS', 'me.png') }) })]);
    renderWithClient(<IdentityPage />, mockClient({ identities: { list, create, consentStatement: vi.fn().mockResolvedValue(statement), grantConsent, revokeConsent: vi.fn(), setReference: vi.fn() } }));
    const card = await screen.findByRole('region', { name: '我自己' });
    const likeness = within(card).getByText('形象').closest('div')!.parentElement!;
    expect(within(likeness).getByText('参考：me.png')).toBeTruthy();
    expect(within(likeness).getByText('需要授权')).toBeTruthy();
    expect(within(likeness).getByText(IDENTITY_CONSENT_STATEMENTS.LIKENESS['zh-CN'])).toBeTruthy();
    await userEvent.click(within(likeness).getByRole('radio', { name: '我已获得本人授权' }));
    await userEvent.click(within(likeness).getByRole('button', { name: '我同意以上声明' }));
    await waitFor(() => expect(grantConsent).toHaveBeenCalledWith('ws_1', 'cid_1', { kind: 'LIKENESS', subject: 'AUTHORIZED_OTHER', statementVersion: 'v6-7.1', locale: 'zh-CN' }, expect.anything()));
    // 声音还没有样本：不显示声明，只能先上传
    const voice = within(card).getByText('声音').closest('div')!.parentElement!;
    expect(within(voice).getByText('先上传参考素材')).toBeTruthy();
    expect(within(voice).queryByRole('button', { name: '我同意以上声明' })).toBeNull();

    await userEvent.type(screen.getByLabelText('档案名字'), '我妈妈');
    await userEvent.click(screen.getByRole('button', { name: '新建档案' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith('ws_1', '我妈妈', expect.anything()));
  });

  it('已授权：可用于生成，可撤回；授权记录可查', async () => {
    const revokeConsent = vi.fn().mockResolvedValue(profile());
    const granted = { subject: 'SELF', statementVersion: 'v6-7.1', grantedAt: '2026-10-14T01:00:00.000Z' };
    const list = vi.fn().mockResolvedValue([profile({
      voice: part({ reference: reference('VOICE', 'voice.wav'), consent: granted, ready: true }),
      history: [{ id: 'icr_1', kind: 'VOICE', action: 'GRANT', subject: 'SELF', statementVersion: 'v6-7.1', locale: 'zh-CN', statementSha256: 'a'.repeat(64), actorId: 'usr_1', createdAt: '2026-10-14T01:00:00.000Z' }],
    })]);
    renderWithClient(<IdentityPage />, mockClient({ identities: { list, create: vi.fn(), consentStatement: vi.fn().mockResolvedValue(statement), grantConsent: vi.fn(), revokeConsent, setReference: vi.fn() } }));
    const card = await screen.findByRole('region', { name: '我自己' });
    const voice = within(card).getByText('声音').closest('div')!.parentElement!;
    expect(within(voice).getByText('可用于生成')).toBeTruthy();
    await userEvent.click(within(voice).getByRole('button', { name: '撤回授权' }));
    await waitFor(() => expect(revokeConsent).toHaveBeenCalledWith('ws_1', 'cid_1', 'VOICE', expect.anything()));
    expect(within(card).getByText('授权记录 (1)')).toBeTruthy();
    expect(within(card).getByText(/声音 · 授权 · 声明 v6-7\.1$/)).toBeTruthy();
  });
});
