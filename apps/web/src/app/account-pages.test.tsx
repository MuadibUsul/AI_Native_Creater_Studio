import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiError, mockClient, renderWithClient } from '@/test-utils';
import { I18nProvider } from '@/i18n/I18nProvider';
import { PendingInvitations } from '@/ui/PendingInvitations';
import SignUpPage from './sign-up/page';
import SignInPage from './sign-in/page';
import ForgotPasswordPage from './forgot-password/page';
import ResetPasswordPage from './reset-password/page';
import VerifyEmailPage from './verify-email/page';

/** 账号自助页（D-04）：按部署的注册方式显示入口、答复不透露邮箱是否存在、邮件链接落地页的各种结果；中英双语。 */

let query = new URLSearchParams();
vi.mock('next/navigation', () => ({ useSearchParams: () => query }));

const capabilities = (signup: 'closed' | 'invite' | 'open', passwordReset = true) => vi.fn().mockResolvedValue({ packs: [], distributionProviders: [], outputFormats: [], outputFormatAvailability: null, providers: [], legacyPipeline: 'off', accounts: { signup, passwordReset } });

beforeEach(() => {
  query = new URLSearchParams();
});

describe('注册页', () => {
  it('invite：提示用受邀邮箱；从邀请链接预填邮箱；提交带界面语言；成功后请查收邮件并可重发', async () => {
    query = new URLSearchParams({ email: 'beta@example.com' });
    const signUp = vi.fn().mockResolvedValue({ status: 'EMAIL_SENT' });
    const resendVerification = vi.fn().mockResolvedValue({ status: 'EMAIL_SENT' });
    const { container } = renderWithClient(<I18nProvider initialLocale="en"><SignUpPage /></I18nProvider>, mockClient({ capabilities: capabilities('invite'), auth: { signUp, resendVerification } }));
    expect(await screen.findByText('Invite only for now: sign up with the email address your invitation was sent to.')).toBeTruthy();
    expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('beta@example.com');
    await userEvent.type(screen.getByLabelText('Your name'), 'Bea');
    await userEvent.type(screen.getByLabelText(/^Password/), 'password-1234');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeTruthy();
    expect(signUp).toHaveBeenCalledWith({ name: 'Bea', email: 'beta@example.com', password: 'password-1234', locale: 'en' });
    await userEvent.click(screen.getByRole('button', { name: 'Send again' }));
    expect(await screen.findByText('Sent again.')).toBeTruthy();
    expect(resendVerification).toHaveBeenCalledWith({ email: 'beta@example.com', locale: 'en' });
    expect(container.textContent).not.toMatch(/[一-鿿]/);
  });

  it('没有邀请：说明要用收到邀请的邮箱（不是服务端原文）', async () => {
    const signUp = vi.fn().mockRejectedValue(apiError(403, 'FORBIDDEN', 'Sign-up is by invitation only', { reason: 'SIGNUP_INVITE_REQUIRED' }));
    renderWithClient(<SignUpPage />, mockClient({ capabilities: capabilities('invite'), auth: { signUp } }));
    await userEvent.type(await screen.findByLabelText('怎么称呼你'), '小林');
    await userEvent.type(screen.getByLabelText('邮箱'), 'x@example.com');
    await userEvent.type(screen.getByLabelText(/^密码/), 'password-1234');
    await userEvent.click(screen.getByRole('button', { name: '创建账号' }));
    expect(await screen.findByText('这个邮箱还没有收到邀请。请用收到邀请的邮箱注册，或联系邀请你的人。')).toBeTruthy();
  });

  it('closed：不显示表单，只给登录入口', async () => {
    renderWithClient(<SignUpPage />, mockClient({ capabilities: capabilities('closed'), auth: {} }));
    expect(await screen.findByRole('heading', { name: '暂未开放注册' })).toBeTruthy();
    expect(screen.queryByLabelText('邮箱')).toBeNull();
    expect(screen.getByRole('link', { name: '登录' }).getAttribute('href')).toBe('/sign-in');
  });
});

describe('登录页的账号入口', () => {
  it('按能力显示"忘记密码"（带上已填的邮箱）与"创建账号"；closed 时不显示创建账号', async () => {
    renderWithClient(<I18nProvider initialLocale="en"><SignInPage /></I18nProvider>, mockClient({ capabilities: capabilities('invite'), auth: {} }));
    expect(await screen.findByRole('link', { name: 'Create one' })).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Email'), 'me@example.com');
    expect(screen.getByRole('link', { name: 'Forgot password?' }).getAttribute('href')).toBe('/forgot-password?email=me%40example.com');
  });

  it('closed 且未配置发信：两个入口都不显示', async () => {
    const caps = capabilities('closed', false);
    renderWithClient(<SignInPage />, mockClient({ capabilities: caps, auth: {} }));
    await waitFor(() => expect(caps).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: '创建账号' })).toBeNull();
    expect(screen.queryByRole('link', { name: '忘记密码？' })).toBeNull();
  });

  it('邮箱未验证：提示去收件箱（已重发），不显示通用失败', async () => {
    const signIn = vi.fn().mockRejectedValue(apiError(403, 'FORBIDDEN', 'Please verify your email before signing in', { reason: 'EMAIL_NOT_VERIFIED' }));
    renderWithClient(<SignInPage />, mockClient({ capabilities: capabilities('invite'), auth: { signIn } }));
    await userEvent.type(screen.getByLabelText('邮箱'), 'new@example.com');
    await userEvent.type(screen.getByLabelText('密码'), 'password-1234');
    await userEvent.click(screen.getByRole('button', { name: '登录' }));
    expect(await screen.findByRole('heading', { name: '邮箱还没确认' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '登录失败' })).toBeNull();
  });
});

describe('找回与重设密码', () => {
  it('找回：提交后统一说"如果已注册就发了"；未配置发信时如实说明', async () => {
    const requestPasswordReset = vi.fn().mockResolvedValue({ status: 'EMAIL_SENT' });
    query = new URLSearchParams({ email: 'Me@Example.com' });
    const { unmount } = renderWithClient(<I18nProvider initialLocale="en"><ForgotPasswordPage /></I18nProvider>, mockClient({ capabilities: capabilities('invite'), auth: { requestPasswordReset } }));
    await userEvent.click(await screen.findByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByText(/If me@example.com has an account, a reset link is on its way/)).toBeTruthy();
    expect(requestPasswordReset).toHaveBeenCalledWith({ email: 'Me@Example.com', locale: 'en' });
    unmount();
    renderWithClient(<ForgotPasswordPage />, mockClient({ capabilities: capabilities('closed', false), auth: {} }));
    expect(await screen.findByText('这个站点还没有配置发信，暂时不能自助找回密码，请联系管理员。')).toBeTruthy();
  });

  it('重设：两次不一致不提交；成功后去登录；链接失效引导重新申请；缺令牌直接说明', async () => {
    query = new URLSearchParams({ token: 'reset-token-0123456789' }); // secrets:check-ignore：测试专用假口令 / 令牌
    const resetPassword = vi.fn().mockResolvedValueOnce({ status: 'PASSWORD_RESET' });
    const { unmount } = renderWithClient(<I18nProvider initialLocale="en"><ResetPasswordPage /></I18nProvider>, mockClient({ auth: { resetPassword } }));
    await userEvent.type(screen.getByLabelText('New password'), 'new-password-1');
    await userEvent.type(screen.getByLabelText('Repeat it'), 'new-password-2');
    await userEvent.click(screen.getByRole('button', { name: 'Save new password' }));
    expect(screen.getByRole('alert').textContent).toBe("The two passwords don't match.");
    expect(resetPassword).not.toHaveBeenCalled();
    await userEvent.clear(screen.getByLabelText('Repeat it'));
    await userEvent.type(screen.getByLabelText('Repeat it'), 'new-password-1');
    await userEvent.click(screen.getByRole('button', { name: 'Save new password' }));
    expect(await screen.findByRole('heading', { name: 'Password updated' })).toBeTruthy();
    expect(resetPassword).toHaveBeenCalledWith({ token: 'reset-token-0123456789', newPassword: 'new-password-1' }); // secrets:check-ignore：测试专用假口令 / 令牌
    unmount();

    const expired = vi.fn().mockRejectedValue(apiError(400, 'VALIDATION_FAILED', 'This link is invalid or has expired', { reason: 'INVALID_TOKEN' }));
    const second = renderWithClient(<ResetPasswordPage />, mockClient({ auth: { resetPassword: expired } }));
    await userEvent.type(screen.getByLabelText('新密码'), 'new-password-1');
    await userEvent.type(screen.getByLabelText('再输一次'), 'new-password-1');
    await userEvent.click(screen.getByRole('button', { name: '保存新密码' }));
    expect(await screen.findByRole('link', { name: '重新申请' })).toBeTruthy();
    second.unmount();

    query = new URLSearchParams();
    renderWithClient(<ResetPasswordPage />, mockClient({ auth: {} }));
    expect(screen.getByText('链接不完整，请从邮件里重新点开。')).toBeTruthy();
  });
});

describe('验证邮箱落地页', () => {
  it('确认成功即登录；链接已用过时请直接登录；失效时可重新要一封', async () => {
    query = new URLSearchParams({ token: 'verify-token-0123456789' }); // secrets:check-ignore：测试专用假口令 / 令牌
    const verifyEmail = vi.fn().mockResolvedValue({ status: 'VERIFIED', user: { id: 'usr_1', email: 'a@example.com', name: 'A', emailVerified: true } });
    const first = renderWithClient(<I18nProvider initialLocale="en"><VerifyEmailPage /></I18nProvider>, mockClient({ auth: { verifyEmail } }));
    expect(await screen.findByRole('heading', { name: 'Email confirmed' })).toBeTruthy();
    expect(verifyEmail).toHaveBeenCalledTimes(1);
    expect(verifyEmail).toHaveBeenCalledWith({ token: 'verify-token-0123456789' }); // secrets:check-ignore：测试专用假口令 / 令牌
    first.unmount();

    const already = renderWithClient(<VerifyEmailPage />, mockClient({ auth: { verifyEmail: vi.fn().mockResolvedValue({ status: 'VERIFIED', user: null }) } }));
    expect(await screen.findByRole('heading', { name: '邮箱已经确认过了' })).toBeTruthy();
    already.unmount();

    const resendVerification = vi.fn().mockResolvedValue({ status: 'EMAIL_SENT' });
    renderWithClient(<VerifyEmailPage />, mockClient({ auth: { verifyEmail: vi.fn().mockRejectedValue(apiError(400, 'VALIDATION_FAILED', 'expired', { reason: 'INVALID_TOKEN' })), resendVerification } }));
    expect(await screen.findByRole('heading', { name: '链接无效或已过期' })).toBeTruthy();
    await userEvent.type(screen.getByLabelText('邮箱'), 'a@example.com');
    await userEvent.click(screen.getByRole('button', { name: '重新发送验证邮件' }));
    expect(await screen.findByRole('heading', { name: '请查收邮件' })).toBeTruthy();
    expect(resendVerification).toHaveBeenCalledWith({ email: 'a@example.com', locale: 'zh-CN' });
  });
});

describe('首页待接受邀请', () => {
  it('列出有效邀请，接受后加入并切到那个工作区；没有邀请时什么都不显示', async () => {
    const accept = vi.fn().mockResolvedValue({ workspace: { id: 'ws_9' }, invitation: { id: 'winv_1' } });
    const onJoined = vi.fn();
    const mine = vi.fn().mockResolvedValue([
      { id: 'winv_1', workspaceId: 'ws_9', workspaceName: 'Beta team', email: 'a@example.com', role: 'EDITOR', status: 'PENDING', invitedByUserId: null, createdAt: '2026-10-22T00:00:00.000Z', expiresAt: '2026-11-05T00:00:00.000Z', acceptedAt: null, acceptedByUserId: null },
      { id: 'winv_2', workspaceId: 'ws_8', workspaceName: 'Old', email: 'a@example.com', role: 'VIEWER', status: 'EXPIRED', invitedByUserId: null, createdAt: '2026-10-01T00:00:00.000Z', expiresAt: '2026-10-15T00:00:00.000Z', acceptedAt: null, acceptedByUserId: null },
    ]);
    const { unmount } = renderWithClient(<I18nProvider initialLocale="en"><PendingInvitations onJoined={onJoined} /></I18nProvider>, mockClient({ invitations: { mine, accept } }));
    expect(await screen.findByText('Join "Beta team"')).toBeTruthy();
    expect(screen.queryByText('Join "Old"')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(onJoined).toHaveBeenCalledWith('ws_9'));
    expect(accept).toHaveBeenCalledWith('winv_1');
    unmount();

    const { container } = renderWithClient(<PendingInvitations onJoined={onJoined} />, mockClient({ invitations: { mine: vi.fn().mockResolvedValue([]), accept } }));
    await waitFor(() => expect(container.querySelector('[data-pending-invitations]')).toBeNull());
  });
});
