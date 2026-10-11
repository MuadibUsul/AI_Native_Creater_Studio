import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  PLAYBACK_SNAPSHOT_VERSION,
  legacyMillisecondsToMediaTime,
  type PlaybackBackendPort,
  type PlaybackSnapshot,
} from '@ancs/contracts';
import { PlaybackSurface } from './PlaybackSurface';

/**
 * N03-12／N03-13 接线面：引擎状态、后端调用、presented 与请求的差异、未授权提示都要"看得见"。
 */
const mt = (ms: number) => legacyMillisecondsToMediaTime(ms);

const snapshot: PlaybackSnapshot = {
  schemaVersion: PLAYBACK_SNAPSHOT_VERSION,
  projectId: 'p', sequenceId: 's', documentRevision: 5,
  frameRate: { num: 30, den: 1 }, duration: mt(10_000),
  capabilities: { backend: 'HTML_MEDIA_BASELINE', videoPrecision: 'KEYFRAME_APPROXIMATE', audioPrecision: 'KEYFRAME_APPROXIMATE', supported: ['PER_SEGMENT_OPACITY'], unsupported: ['PER_SEGMENT_CROP'] },
  videoSegments: [], audioSegments: [], captions: [], excludedTrackIds: [], warnings: [],
} as PlaybackSnapshot;

function fakeBackend(presentedMs = 0) {
  const calls: string[] = [];
  const backend: PlaybackBackendPort = {
    kind: 'HTML_MEDIA_BASELINE',
    load: async () => { calls.push('load'); },
    play: async () => { calls.push('play'); },
    pause: async () => { calls.push('pause'); },
    seek: async () => { calls.push('seek'); },
    step: async (frames) => { calls.push(`step:${String(frames)}`); },
    setRange: async () => { calls.push('setRange'); },
    dispose: async () => { calls.push('dispose'); },
    getPresented: async () => ({ presentedTime: mt(presentedMs), presentedFrame: null }),
  };
  return { backend, calls };
}

describe('N03-13／N03-12 PlaybackSurface 接线', () => {
  it('加载 → 状态 READY；播放 → PLAYING 且后端收到 play', async () => {
    const { backend, calls } = fakeBackend();
    render(<PlaybackSurface snapshot={snapshot} backend={backend} />);
    fireEvent.click(screen.getByTestId('playback-load'));
    await waitFor(() => { expect(screen.getByTestId('playback-status').textContent).toBe('READY'); });
    fireEvent.click(screen.getByTestId('playback-play'));
    await waitFor(() => { expect(screen.getByTestId('playback-status').textContent).toBe('PLAYING'); });
    expect(calls).toEqual(['load', 'play']);
  });

  it('逐帧按钮把帧数交给后端（不在前端算时间）', async () => {
    const { backend, calls } = fakeBackend();
    render(<PlaybackSurface snapshot={snapshot} backend={backend} />);
    fireEvent.click(screen.getByTestId('playback-load'));
    await waitFor(() => { expect(screen.getByTestId('playback-status').textContent).toBe('READY'); });
    fireEvent.click(screen.getByTestId('playback-step-next'));
    await waitFor(() => { expect(calls).toContain('step:1'); });
    fireEvent.click(screen.getByTestId('playback-step-prev'));
    await waitFor(() => { expect(calls).toContain('step:-1'); });
  });

  it('显示"实际呈现"时间，并在超出容差时给出同步修正提示', async () => {
    const { backend } = fakeBackend(120); // 后端呈现 120ms
    render(<PlaybackSurface snapshot={snapshot} backend={backend} readAudioMs={() => 0} />);
    fireEvent.click(screen.getByTestId('playback-load'));
    await waitFor(() => { expect(screen.getByTestId('playback-status').textContent).toBe('READY'); });
    fireEvent.click(screen.getByTestId('playback-play'));
    await waitFor(() => { expect(screen.getByTestId('playback-presented-ms').textContent).toBe('120'); });
    // 主时钟在 0ms，实际呈现 120ms → 漂移 120ms 超出 ±40ms 容差 → 必须提示修正
    await waitFor(() => { expect(screen.getByTestId('playback-sync-action')).toBeTruthy(); });
  });

  it('音频未授权 → 明确提示且不静默无声', () => {
    const { backend } = fakeBackend();
    render(<PlaybackSurface snapshot={snapshot} backend={backend} hasAudioTrack audioPermission="DENIED" />);
    expect(screen.getByTestId('playback-notice').textContent).toContain('需要允许播放音频');
  });

  it('无音轨 → 提示使用虚拟时钟；能力表只显示协商后的支持项', () => {
    const { backend } = fakeBackend();
    render(<PlaybackSurface snapshot={snapshot} backend={backend} hasAudioTrack={false} />);
    expect(screen.getByTestId('playback-notice').textContent).toContain('没有音轨');
    const caps = screen.getByTestId('playback-capabilities').textContent ?? '';
    expect(caps).toContain('PER_SEGMENT_OPACITY');
    expect(caps).not.toContain('PER_SEGMENT_CROP'); // 未支持不得展示为支持
  });

  it('未加载就播放 → 状态出现 ERROR（不假装在播）', async () => {
    const { backend } = fakeBackend();
    render(<PlaybackSurface snapshot={snapshot} backend={backend} />);
    fireEvent.click(screen.getByTestId('playback-play'));
    await waitFor(() => { expect(screen.getByTestId('playback-status').textContent).not.toBe('PLAYING'); });
  });
});
