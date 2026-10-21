import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n/I18nProvider';
import NotFound from './not-found';
import PageError from './error';
import GlobalError from './global-error';

vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: unknown; href: string }) => <a href={href} {...rest}>{children as never}</a>,
}));

/** 系统页：找不到页面、页面出错（中英），根布局出错时的中英并列兜底页；不展示错误详情。 */
describe('系统页', () => {
  it('找不到页面：中文说明并回到创作台；英文界面没有中文', () => {
    const zh = render(<I18nProvider initialLocale="zh-CN"><NotFound /></I18nProvider>);
    expect(screen.getByRole('heading', { name: '这个页面不存在' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '回到创作台' }).getAttribute('href')).toBe('/');
    zh.unmount();
    render(<I18nProvider initialLocale="en"><NotFound /></I18nProvider>);
    expect(screen.getByRole('link', { name: 'Back to home' })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/[一-鿿]/);
  });

  it('页面出错：重试调用 reset，显示错误编号但不显示错误详情', () => {
    const reset = vi.fn();
    const error = Object.assign(new Error('secret internal detail'), { digest: 'abc123' });
    render(<I18nProvider initialLocale="zh-CN"><PageError error={error} reset={reset} /></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(reset).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert').textContent).toContain('abc123');
    expect(document.body.textContent).not.toContain('secret internal detail');
  });

  it('根布局出错：中英并列，重试可用，不显示错误详情', () => {
    const reset = vi.fn();
    render(<GlobalError error={Object.assign(new Error('boom detail'), { digest: 'd1' })} reset={reset} />);
    expect(screen.getByRole('heading', { name: '这个页面出了点问题' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Something went wrong on this page' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button'));
    expect(reset).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain('boom detail');
  });
});
