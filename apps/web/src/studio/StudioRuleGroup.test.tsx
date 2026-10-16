import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { StudioRuleGroup, type StudioRule } from './StudioRuleGroup';

/**
 * 制作规则开关组的键盘模型（Radix Toggle Group 同款）：整组一个 Tab 停靠点（第一个开启项，没有则第一项），
 * ←/→ 循环移动、Home/End 到首尾，Space/Enter 切换；被禁用的项跳过，停靠点不落在禁用项上。
 */

const rule = (key: string, overrides: Partial<StudioRule> = {}): StudioRule => ({
  key, pressed: false, disabled: false, title: `${key} hint`, icon: null, label: `${key}: off`, onToggle: vi.fn(), ...overrides,
});

describe('StudioRuleGroup', () => {
  it('Tab 落在第一个开启项；方向键循环移动、Home/End 到首尾；Space/Enter 切换', async () => {
    const generation = rule('generation', { pressed: true, label: 'generation: on' });
    const rules = [rule('effects'), rule('narration'), generation];
    render(<><button type="button">before</button><StudioRuleGroup label="Production rules" rules={rules} /><button type="button">after</button></>);
    expect(screen.getByRole('group', { name: 'Production rules' })).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'before' }));
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'generation: on' }));
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'after' }));
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'generation: on' }));

    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'effects: off' }));
    await userEvent.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'generation: on' }));
    await userEvent.keyboard('{Home}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'effects: off' }));
    await userEvent.keyboard('{End}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'generation: on' }));

    await userEvent.keyboard('{Home}{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'narration: off' }));
    await userEvent.keyboard(' ');
    expect(rules[1]!.onToggle).toHaveBeenCalledTimes(1);
    await userEvent.keyboard('{Enter}');
    expect(rules[1]!.onToggle).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'narration: off' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: 'generation: on' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('跳过禁用项；没有开启项时停靠在第一个可用项', async () => {
    render(<><button type="button">before</button><StudioRuleGroup label="rules" rules={[rule('effects', { disabled: true }), rule('narration'), rule('generation')]} /></>);
    await userEvent.click(screen.getByRole('button', { name: 'before' }));
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'narration: off' }));
    await userEvent.keyboard('{ArrowRight}{ArrowRight}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'narration: off' }));
    await userEvent.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'generation: off' }));
  });
});
