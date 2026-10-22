import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { apiError, mockClient, renderWithClient } from '@/test-utils';
import { I18nProvider } from '@/i18n/I18nProvider';
import SignInPage from './page';

/** 登录页英文界面：表单、动态验证码与失败状态均为英文；服务端错误消息原样显示。 */
describe('登录页英文界面', () => {
  it('登录失败时显示英文标题与重试', async () => {
    const signIn = vi.fn().mockRejectedValue(apiError(401, 'INVALID_CREDENTIALS', 'Invalid email or password'));
    const { container } = renderWithClient(<I18nProvider initialLocale="en"><SignInPage /></I18nProvider>, mockClient({ auth: { signIn } }));
    expect(screen.getByRole('heading', { name: 'Sign in to Creator Studio' })).toBeTruthy();
    expect(screen.getByText('Sign in to continue with your workspaces and projects.')).toBeTruthy();
    expect(container.textContent).not.toMatch(/[一-鿿]/);

    await userEvent.type(screen.getByLabelText('Email'), 'a@test.local');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong-password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Sign-in failed' })).toBeTruthy();
    expect(screen.getByText('Invalid email or password')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(signIn).toHaveBeenCalledWith({ email: 'a@test.local', password: 'wrong-password', locale: 'en' });
    expect(container.textContent).not.toMatch(/[一-鿿]/);
  });

  it('需要二次验证时切换到英文动态验证码表单', async () => {
    const signIn = vi.fn().mockResolvedValue({ twoFactorRequired: true });
    const { container } = renderWithClient(<I18nProvider initialLocale="en"><SignInPage /></I18nProvider>, mockClient({ auth: { signIn } }));
    await userEvent.type(screen.getByLabelText('Email'), 'ops@test.local');
    await userEvent.type(screen.getByLabelText('Password'), 'secret-value');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByLabelText('Verification code')).toBeTruthy();
    expect(screen.getByText('Enter the 6-digit code from your authenticator app.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Verify and sign in' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in again' })).toBeTruthy();
    expect(container.textContent).not.toMatch(/[一-鿿]/);
  });
});
