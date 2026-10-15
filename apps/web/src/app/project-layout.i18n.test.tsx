import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n/I18nProvider';
import { mockClient, renderWithClient } from '@/test-utils.js';

let pathname = '/w/ws_1/p/prj_1/storyboard';
vi.mock('next/navigation', () => ({
  useParams: () => ({ workspaceId: 'ws_1', projectId: 'prj_1' }),
  usePathname: () => pathname,
}));
vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: unknown; href: string }) => <a href={href} {...rest}>{children as never}</a>,
}));

const { default: ProjectLayout } = await import('./w/[workspaceId]/p/[projectId]/layout.js');

/** 作品二级导航：中文为默认（与改造前逐字一致），英文界面覆盖全部导航文案。 */
describe('Project layout navigation', () => {
  const client = () => mockClient({ projects: { get: vi.fn().mockResolvedValue({ id: 'prj_1', title: 'Rates weekly', status: 'STORYBOARDING' }) } });

  it('默认中文：二级导航、状态与主操作文案不变', async () => {
    pathname = '/w/ws_1/p/prj_1/storyboard';
    renderWithClient(<ProjectLayout><p>child</p></ProjectLayout>, client());
    expect(await screen.findByText('分镜中')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: '项目导航' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '分镜与编辑' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: '返回创作台' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '版本历史' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '制作成片' })).toBeTruthy();
  });

  it('renders project navigation in English', async () => {
    pathname = '/w/ws_1/p/prj_1/storyboard';
    renderWithClient(<I18nProvider initialLocale="en"><ProjectLayout><p>child</p></ProjectLayout></I18nProvider>, client());
    expect(await screen.findByText('Storyboarding')).toBeTruthy();
    expect(screen.getByText('Rates weekly')).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'Project navigation' });
    expect(nav.textContent).toBe('ScriptStoryboard & editRenderDelivery');
    expect(screen.getByRole('link', { name: 'Storyboard & edit' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Back to home' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Version history' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Render video' })).toBeTruthy();
    expect(screen.getByTitle('Project status on the server')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/[一-鿿]/);
  });

  it('renders the More menu in English outside the editor and script pages', async () => {
    pathname = '/w/ws_1/p/prj_1/render';
    renderWithClient(<I18nProvider initialLocale="en"><ProjectLayout><p>child</p></ProjectLayout></I18nProvider>, client());
    expect(await screen.findByText('Rates weekly')).toBeTruthy();
    expect(screen.getByText('More')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Project assets' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Performance' })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/[一-鿿]/);
  });
});
