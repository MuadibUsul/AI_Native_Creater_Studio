import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Providers } from '@/app/providers';
import { render } from '@testing-library/react';
import { StateBlock, type StateBlockVariant } from './StateBlock';
import { mockClient } from '@/test-utils';

/**
 * P05-03 状态矩阵原语验收：每个状态都有自己的标识与**可操作动作**（不得只有错误文字）。
 */

const VARIANTS: StateBlockVariant[] = ['loading', 'empty', 'error', 'forbidden', 'unauthenticated', 'conflict', 'unavailable', 'info'];

describe('StateBlock（状态矩阵原语）', () => {
  it('全部状态可渲染且带 data-state 标识', () => {
    for (const variant of VARIANTS) {
      const { unmount } = render(
        <Providers client={mockClient({})}>
          <StateBlock variant={variant} title={`状态 ${variant}`} />
        </Providers>,
      );
      expect(screen.getByText(`状态 ${variant}`)).toBeTruthy();
      expect(document.querySelector(`[data-state="${variant}"]`)).toBeTruthy();
      unmount();
    }
  });

  it('动作按钮可点击（状态"可操作"）', async () => {
    const onClick = vi.fn();
    render(
      <Providers client={mockClient({})}>
        <StateBlock variant="error" title="失败" action={{ label: '重试', onClick }} secondaryAction={{ label: '返回', onClick }} />
      </Providers>,
    );
    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('诊断信息（服务端 code）只在提供时展示', () => {
    const { unmount } = render(
      <Providers client={mockClient({})}>
        <StateBlock variant="conflict" title="冲突" diagnostics="VERSION_CONFLICT" />
      </Providers>,
    );
    expect(screen.getByTestId('state-diagnostics').textContent).toBe('VERSION_CONFLICT');
    unmount();

    render(
      <Providers client={mockClient({})}>
        <StateBlock variant="empty" title="空" />
      </Providers>,
    );
    expect(screen.queryByTestId('state-diagnostics')).toBeNull();
  });
});
