import { beforeEach, describe, expect, it } from 'vitest';
import { deviceAppearance, initialAppearance, parseAppearanceCookie, saveDeviceAppearance } from './appearance';

describe('设备外观偏好', () => {
  beforeEach(() => { window.localStorage.clear(); document.cookie = 'ancs-qf-appearance=; Path=/; Max-Age=0'; });

  it('只接受合法固定值且首屏必须匹配当前会话用户', () => {
    expect(parseAppearanceCookie('usr_a.dark')).toEqual({ userId: 'usr_a', mode: 'dark' });
    expect(parseAppearanceCookie('usr_a.system')).toBeNull();
    expect(parseAppearanceCookie('usr_a.dark;evil=1')).toBeNull();
    expect(initialAppearance('usr_a.dark', 'usr_a')).toBe('dark');
    expect(initialAppearance('usr_a.dark', 'usr_b')).toBe('system');
    expect(initialAppearance('usr_a.dark', null)).toBe('system');
  });

  it('两个账号的覆盖互不继承，system 清除当前设备固定值', () => {
    saveDeviceAppearance('usr_a', 'dark');
    expect(deviceAppearance('usr_a')).toBe('dark');
    expect(deviceAppearance('usr_b')).toBe('system');
    saveDeviceAppearance('usr_b', 'light');
    expect(deviceAppearance('usr_a')).toBe('dark');
    expect(deviceAppearance('usr_b')).toBe('light');
    saveDeviceAppearance('usr_a', 'system');
    expect(deviceAppearance('usr_a')).toBe('system');
  });
});
