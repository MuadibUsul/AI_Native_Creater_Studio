import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { voiceCaptureStatusSchema, type VoiceCaptureStatus } from '@ancs/contracts';
import type { MicrophoneCapture } from '@/lib/useMicrophoneCapture';
import { VoiceCaptureControl } from './VoiceCaptureControl';

/** N05-02：可见麦克风采集开关——状态可见、可停止、被拒/不可用可辨；真实识别未接。 */

const status = (state: VoiceCaptureStatus['state'], extra: Partial<VoiceCaptureStatus> = {}): VoiceCaptureStatus =>
  voiceCaptureStatusSchema.parse({ state, listening: state === 'CAPTURING', visible: true, startedAtMonotonicMs: null, lastErrorCode: null, ...extra });

const fakeCapture = (overrides: Partial<MicrophoneCapture> = {}): MicrophoneCapture => ({
  status: status('IDLE'),
  level: 0,
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn(),
  toggle: vi.fn(),
  ...overrides,
});

const originalMediaDevices = Object.getOwnPropertyDescriptor(globalThis.navigator, 'mediaDevices');

afterEach(() => {
  if (originalMediaDevices === undefined) {
    delete (globalThis.navigator as { mediaDevices?: unknown }).mediaDevices;
  } else {
    Object.defineProperty(globalThis.navigator, 'mediaDevices', originalMediaDevices);
  }
});

const installGetUserMedia = (impl: () => Promise<MediaStream>): void => {
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(impl) },
  });
};

describe('VoiceCaptureControl 渲染与注入状态', () => {
  it('默认未开启：显示状态与"开始聆听"，点击调用 toggle', () => {
    const capture = fakeCapture();
    render(<VoiceCaptureControl capture={capture} />);
    expect(screen.getByTestId('voice-capture-state').textContent).toContain('未开启');
    fireEvent.click(screen.getByTestId('voice-capture-toggle'));
    expect(capture.toggle).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('voice-capture-listening')).toBeNull();
  });

  it('采集中：显示"正在聆听"与电平，按钮为"停止聆听"', () => {
    render(<VoiceCaptureControl capture={fakeCapture({ status: status('CAPTURING'), level: 0.5 })} />);
    expect(screen.getByTestId('voice-capture-listening')).toBeTruthy();
    expect(screen.getByTestId('voice-capture-toggle').textContent).toContain('停止聆听');
    expect(screen.getByTestId('voice-capture-level').getAttribute('aria-valuenow')).toBe('0.5');
  });

  it('被拒：明确提示并要求在浏览器设置允许（不静默）', () => {
    render(<VoiceCaptureControl capture={fakeCapture({ status: status('DENIED') })} />);
    expect(screen.getByTestId('voice-capture-error').textContent).toContain('麦克风被拒');
    expect(screen.getByTestId('voice-capture-toggle').textContent).toContain('开始聆听');
  });
});

describe('useMicrophoneCapture（真实 hook，mock 浏览器能力）', () => {
  it('授权成功 → 采集中；停止后释放音轨并回到未开启', async () => {
    const stopTrack = vi.fn();
    installGetUserMedia(() => Promise.resolve({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream));
    render(<VoiceCaptureControl />);
    fireEvent.click(screen.getByTestId('voice-capture-toggle'));
    await waitFor(() => expect(screen.getByTestId('voice-capture-listening')).toBeTruthy());
    fireEvent.click(screen.getByTestId('voice-capture-toggle'));
    await waitFor(() => expect(screen.getByTestId('voice-capture-state').textContent).toContain('未开启'));
    expect(stopTrack).toHaveBeenCalled();
  });

  it('权限被拒（NotAllowedError）→ DENIED，并提示用户', async () => {
    installGetUserMedia(() => Promise.reject(new DOMException('denied', 'NotAllowedError')));
    render(<VoiceCaptureControl />);
    fireEvent.click(screen.getByTestId('voice-capture-toggle'));
    await waitFor(() => expect(screen.getByTestId('voice-capture-state').textContent).toContain('麦克风被拒'));
  });

  it('环境不支持 mediaDevices → UNAVAILABLE（不报"已通"）', async () => {
    Object.defineProperty(globalThis.navigator, 'mediaDevices', { configurable: true, value: undefined });
    render(<VoiceCaptureControl />);
    fireEvent.click(screen.getByTestId('voice-capture-toggle'));
    await waitFor(() => expect(screen.getByTestId('voice-capture-state').textContent).toContain('不支持麦克风采集'));
  });

  it('卸载即停止采集（离开会话不得继续采集）', async () => {
    const stopTrack = vi.fn();
    installGetUserMedia(() => Promise.resolve({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream));
    const { unmount } = render(<VoiceCaptureControl />);
    fireEvent.click(screen.getByTestId('voice-capture-toggle'));
    await waitFor(() => expect(screen.getByTestId('voice-capture-listening')).toBeTruthy());
    unmount();
    expect(stopTrack).toHaveBeenCalled();
  });
});
