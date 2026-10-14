'use client';

import { useCallback } from 'react';
import { useQueries } from '@tanstack/react-query';
import type { MediaIndexEntry, MediaIndexPage } from '@ancs/contracts';
import { useAncsClient } from '@/lib/client';

/**
 * 时间带上的音频波形（界面精修第四阶段）。
 * 数据只来自 Worker 的媒体索引（WAVEFORM：每 10 ms 一个实测峰值，0–1000）；没有索引、索引属于别的版本、
 * 或这一段没有测量值时就不画——不补点、不画装饰波形（v0.4 禁止虚构数据）。
 */

export interface FootageWaveform {
  /** 每个峰值覆盖的时长（毫秒） */
  intervalMs: number;
  /** 下标 i 覆盖源时间 [i·intervalMs, (i+1)·intervalMs)；null = 这一段没有测量值 */
  peaks: (number | null)[];
}

const MAX_PAGES = 60;
const PAGE_SIZE = 100;
const SETTLED = new Set<MediaIndexPage['status']>(['READY', 'EMPTY', 'FAILED']);

/** 纯函数：把一页页索引条目拼成按源时间排列的峰值数组（可单测）。 */
export function mergeWaveformEntries(entries: Pick<MediaIndexEntry, 'payload'>[]): FootageWaveform | null {
  let intervalMs: number | null = null;
  const peaks: (number | null)[] = [];
  for (const entry of entries) {
    const interval = entry.payload['sampleIntervalMs'];
    const start = entry.payload['sourceStartMs'];
    const values = entry.payload['peaks'];
    if (typeof interval !== 'number' || interval <= 0 || typeof start !== 'number' || !Array.isArray(values)) continue;
    if (intervalMs === null) intervalMs = interval;
    if (interval !== intervalMs) continue;
    const offset = Math.round(start / intervalMs);
    values.forEach((value, index) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return;
      while (peaks.length <= offset + index) peaks.push(null);
      peaks[offset + index] = Math.max(0, Math.min(1000, value));
    });
  }
  return intervalMs === null || peaks.length === 0 ? null : { intervalMs, peaks };
}

/**
 * 纯函数：片段用到的源区间 [startSeconds, endSeconds) 均分成 bars 根柱子，每根取区间内峰值的最大值（0–1）。
 * 倒放的片段左右翻转；某根柱子覆盖的范围里没有测量值时为 null（画成空白，不插值）。
 */
export function waveformBars(wave: FootageWaveform, startSeconds: number, endSeconds: number, bars: number, reverse = false): (number | null)[] {
  if (bars <= 0 || !(endSeconds > startSeconds)) return [];
  const result: (number | null)[] = [];
  const perBar = (endSeconds - startSeconds) / bars;
  for (let bar = 0; bar < bars; bar += 1) {
    const from = Math.floor(((startSeconds + bar * perBar) * 1000) / wave.intervalMs);
    const to = Math.max(from + 1, Math.ceil(((startSeconds + (bar + 1) * perBar) * 1000) / wave.intervalMs));
    let peak: number | null = null;
    for (let index = Math.max(0, from); index < Math.min(to, wave.peaks.length); index += 1) {
      const value = wave.peaks[index];
      if (value !== null && value !== undefined) peak = Math.max(peak ?? 0, value);
    }
    result.push(peak === null ? null : peak / 1000);
  }
  return reverse ? result.reverse() : result;
}

/** 读取这些素材的波形（按资产版本对应；索引不是这个版本的就不用）。索引还在进行中时每 5 秒再读一次。 */
export function useFootageWaveforms(workspaceId: string, footage: { assetId: string; versionId: string }[]): ReadonlyMap<string, FootageWaveform> {
  const client = useAncsClient();
  const combine = useCallback((results: { data?: { wave: FootageWaveform | null } | undefined }[]): ReadonlyMap<string, FootageWaveform> => {
    const waves = new Map<string, FootageWaveform>();
    results.forEach((result, index) => {
      const item = footage[index];
      if (item !== undefined && result.data?.wave) waves.set(item.versionId, result.data.wave);
    });
    return waves;
  }, [footage]);
  return useQueries({
    combine,
    queries: footage.map((item) => ({
      queryKey: ['studio', 'waveform', workspaceId, item.assetId, item.versionId],
      queryFn: async (): Promise<{ status: MediaIndexPage['status']; wave: FootageWaveform | null }> => {
        const entries: MediaIndexEntry[] = [];
        let cursor: string | undefined;
        let status: MediaIndexPage['status'] = 'EMPTY';
        for (let page = 0; page < MAX_PAGES; page += 1) {
          const result = await client.assets.mediaIndex(workspaceId, item.assetId, { kind: 'WAVEFORM', limit: PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) });
          if (result.sourceAssetVersionId !== item.versionId) return { status: 'STALE', wave: null };
          status = result.status;
          entries.push(...result.items);
          if (result.nextCursor === null) break;
          cursor = result.nextCursor;
        }
        return { status, wave: mergeWaveformEntries(entries) };
      },
      staleTime: Infinity,
      retry: false,
      refetchInterval: (query: { state: { data?: { status: MediaIndexPage['status'] } } }) => (query.state.data === undefined || SETTLED.has(query.state.data.status) || query.state.data.status === 'STALE' ? false : 5_000),
    })),
  });
}
