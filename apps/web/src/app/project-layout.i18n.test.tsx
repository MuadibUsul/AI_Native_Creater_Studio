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

  it('旧 V4 流水线下线：顶部说明 + 去共看片室新建（生成式作品）；素材剪辑作品直接在共看片室打开', async () => {
    pathname = '/w/ws_1/p/prj_1/storyboard';
    const off = { capabilities: vi.fn().mockResolvedValue({ legacyPipeline: 'off' }) };
    const generative = renderWithClient(<ProjectLayout><p>child</p></ProjectLayout>, mockClient({ ...off, projects: { get: vi.fn().mockResolvedValue({ id: 'prj_1', title: '旧作品', status: 'STORYBOARDING', mode: 'GENERATIVE' }) } }));
    expect(await screen.findByText('这里不再用旧版脚本 / 分镜流程制作')).toBeTruthy();
    expect(screen.getByRole('link', { name: '去共看片室新建' }).getAttribute('href')).toBe('/w/ws_1/studio/new');
    expect(screen.getByText('child')).toBeTruthy();
    generative.unmount();

    renderWithClient(<I18nProvider initialLocale="en"><ProjectLayout><p>child</p></ProjectLayout></I18nProvider>, mockClient({ ...off, projects: { get: vi.fn().mockResolvedValue({ id: 'prj_1', title: 'Glacier', status: 'DRAFT', mode: 'FOOTAGE_EDIT' }) } }));
    expect((await screen.findByRole('link', { name: 'Open this project in the studio' })).getAttribute('href')).toBe('/w/ws_1/studio/prj_1');
    expect(screen.getByRole('note').textContent).toContain('The old script / storyboard flow is retired here');
    expect(document.body.textContent).not.toMatch(/[一-鿿]/);
  });

  it('服务端未报告 off（旧服务端或查询失败）时不显示下线说明', async () => {
    pathname = '/w/ws_1/p/prj_1/storyboard';
    renderWithClient(<ProjectLayout><p>child</p></ProjectLayout>, mockClient({ capabilities: vi.fn().mockResolvedValue({ legacyPipeline: 'mock' }), projects: { get: vi.fn().mockResolvedValue({ id: 'prj_1', title: 'Rates weekly', status: 'STORYBOARDING' }) } }));
    expect(await screen.findByText('分镜中')).toBeTruthy();
    expect(screen.queryByRole('note')).toBeNull();
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
