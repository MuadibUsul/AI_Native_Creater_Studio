import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { mockClient, renderWithClient } from '@/test-utils.js';
import { I18nProvider } from '@/i18n/I18nProvider';
import { DesignSystemPage, WelcomePage } from './workspace-public.js';

vi.mock('next/link', () => ({ default: ({ children, href, ...props }: { children: unknown; href: string }) => <a href={href} {...props}>{children as never}</a> }));

/** 欢迎页与设计系统页英文界面：文案、无障碍名称与示例对话框均为英文。 */
describe('欢迎页与设计系统页英文界面', () => {
  it('欢迎页匿名入口为英文，并前往登录', () => {
    const client = mockClient({ auth: { session: vi.fn().mockRejectedValue(new Error('signed out')) } });
    const { container } = renderWithClient(<I18nProvider initialLocale="en"><WelcomePage /></I18nProvider>, client);
    expect(screen.getByRole('link', { name: /Start your first project/ }).getAttribute('href')).toBe('/sign-in');
    expect(screen.getByRole('link', { name: /Enter the studio/ }).getAttribute('href')).toBe('/sign-in');
    expect(screen.getByRole('navigation', { name: 'Welcome page navigation' })).toBeTruthy();
    expect(screen.getByLabelText('Director workspace layout preview; no real footage or tasks loaded')).toBeTruthy();
    expect(screen.getByTestId('landing-canvas-title').textContent).toBe('Keep your work in view.');
    expect(container.textContent).not.toMatch(/[一-鿿]/);
  });

  it('设计系统页与示例对话框为英文', async () => {
    const client = mockClient({ auth: { session: vi.fn().mockRejectedValue(new Error('signed out')) } });
    const { container } = renderWithClient(<I18nProvider initialLocale="en"><DesignSystemPage /></I18nProvider>, client);
    expect(screen.getByRole('heading', { name: 'Quiet Frame' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Back to home/ }).getAttribute('href')).toBe('/');
    expect(screen.getByText('Canvas · Page background')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Toggle light/dark' })).toBeTruthy();
    expect(container.textContent).not.toMatch(/[一-鿿]/);

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('status').textContent).toBe('This is a design system example; there is nothing to cancel.');
    await userEvent.click(screen.getByRole('button', { name: /See how to resolve/ }));
    expect(screen.getByRole('heading', { name: 'The project has been updated. Your changes are still here.' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Got it' }));
    await userEvent.click(screen.getByRole('button', { name: /See the consent flow/ }));
    expect(screen.getByRole('heading', { name: 'Is this voice yours?' })).toBeTruthy();
    expect(container.textContent).not.toMatch(/[一-鿿]/);
  });
});
