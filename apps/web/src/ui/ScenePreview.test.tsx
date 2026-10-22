import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { STANDARD_SCENE_TYPES } from '@ancs/contracts';
import { getComponent } from '@ancs/scene-components';
import { ScenePreview } from './ScenePreview';
import SignInPage from '@/app/sign-in/page';
import { apiError, mockClient, renderWithClient } from '@/test-utils.js';

/**
 * ScenePreview（与成片同源组件注册表）+ SignIn 状态矩阵：
 * 已注册类型渲染静帧；未注册/非法 props 明确说明（不冒充）；登录成功/失败路径。
 */

describe('ScenePreview（同源组件渲染）', () => {
  it('V1 全部 20 类标准组件都能以其 fixture props 渲染（预览链路与成片一致）', () => {
    for (const type of STANDARD_SCENE_TYPES) {
      const definition = getComponent(type);
      expect(definition, `${type} 应已注册`).not.toBeNull();
      if (definition === null) continue;
      const { unmount } = renderWithClient(
        <ScenePreview
          sceneType={type}
          componentVersion={definition.version}
          props={definition.previewFixture.props as Record<string, unknown>}
          durationMs={definition.previewFixture.durationMs}
          width={320}
        />,
        mockClient({}),
      );
      const rendered = document.querySelector(`[data-state="rendered"][data-scene-type="${type}"]`);
      expect(rendered, `${type} 应渲染成功`).toBeTruthy();
      unmount();
    }
  });

  it('未注册类型：明确说明（不拿别的组件冒充）', () => {
    renderWithClient(<ScenePreview sceneType="NOT_A_COMPONENT" componentVersion={null} props={{}} durationMs={3000} />, mockClient({}));
    expect(screen.getByText(/组件未注册：NOT_A_COMPONENT/)).toBeTruthy();
  });

  it('props 非法：提示编辑器修正（渲染不放行坏数据）', () => {
    renderWithClient(
      <ScenePreview sceneType="BIG_NUMBER" componentVersion="1.0.0" props={{ value: 12345 }} durationMs={3000} />,
      mockClient({}),
    );
    expect(screen.getByText(/props 未通过 BIG_NUMBER 校验/)).toBeTruthy();
  });
});

describe('SignIn', () => {
  it('提交调用 SDK 登录；失败显示可重试的错误块', async () => {
    const signIn = vi.fn().mockRejectedValue(apiError(401, 'INVALID_GRANT', '邮箱或密码不正确'));
    const client = mockClient({ auth: { signIn } });
    renderWithClient(<SignInPage />, client);
    expect(screen.getByRole('main').id).toBe('main');
    expect(screen.getByRole('button', { name: '登录' }).classList.contains('primary')).toBe(true);
    await userEvent.type(screen.getByLabelText('邮箱'), 'a@test.local');
    await userEvent.type(screen.getByLabelText('密码'), 'password-1234');
    await userEvent.click(screen.getByRole('button', { name: '登录' }));
    await waitFor(() => expect(signIn).toHaveBeenCalledWith({ email: 'a@test.local', password: 'password-1234', locale: 'zh-CN' }));
    expect(await screen.findByText('登录失败')).toBeTruthy();
    expect(screen.getByText('邮箱或密码不正确')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });
});
