import { z } from 'zod';
import { PLAYBACK_PRECISIONS } from './playback.js';

/**
 * N03-16：播放基础矩阵的**测量与判定**（记录 presentedPTS／输出帧／音频偏移／冷热 seek／掉帧／内存）。
 *
 * 纪律：
 * - **路径必须分开报告**：`LOCAL_REALTIME`（浏览器本地实时）与 `PRERENDER`（预渲染产物）不可混算；
 * - **不支持帧级精度不得通过逐帧门**（`FRAME_ACCURACY_NOT_SUPPORTED`）——不许把"关键帧近似"当帧级交差；
 * - 未测到的指标记为 `unknown`（**不是** pass）——缺证据不等于通过；
 * - 阈值取自 §20.4/§20.6，属**起始目标**（`START_TARGET`），实测后按真实数据校准，不得反向放宽以凑通过。
 */

export const PLAYBACK_SYNC_PATHS = ['LOCAL_REALTIME', 'PRERENDER'] as const;
export const playbackSyncPathSchema = z.enum(PLAYBACK_SYNC_PATHS);
export type PlaybackSyncPath = z.infer<typeof playbackSyncPathSchema>;

/**
 * 阈值来源：
 * - `cachedSeekP95Ms: 1000`  ← §20.4「已缓存片段 seek／局部回放 … 初始 p95 ≤1s」
 * - `firstFrameColdMs: 3000` ← §20.6「试剪预览首帧」起始目标
 * - 其余为**起始目标（待真实数据校准）**，标注 `START_TARGET`，不要在报告里当成已达成的 SLA。
 */
export const PLAYBACK_SYNC_THRESHOLDS = {
  cachedSeekP95Ms: 1_000,
  cachedSeekP50Ms: 500,
  /**
   * **累计漂移**容差（毫秒）：衡量"越播越偏"，是 §20.6「长片无累计漂移」的硬门。
   * 只看偏移量随时间的**变化**，不含启动时的固定偏移。
   */
  driftAccumulationMs: 40,
  /**
   * **启动偏移**上限（毫秒）：起播瞬间"落后墙上时钟"的固定偏移（首帧延迟/缓冲所致）。
   * 与 `MEDIA_CLOCK_SYNC.reseekThresholdMs` 一致——超过它就该重定位而不是硬播。
   * 二者必须分开：**固定偏移**≠**持续漂移**（把前者当后者会误报）。
   */
  startupOffsetMs: 250,
  driftPerMinuteMs: 120,
  droppedFrameRatio: 0.02,
  firstFrameColdMs: 3_000,
  maxMemoryMb: 512,
} as const;
export const PLAYBACK_SYNC_THRESHOLD_SOURCE = 'SPEC_20_4_AND_20_6_START_TARGET' as const;

/** 一次采样：请求位置、实际呈现位置、掉帧与内存。 */
export const playbackSyncSampleSchema = z.object({
  /** 请求的序列时间（毫秒） */
  requestedMs: z.number().finite().nonnegative(),
  /** 实际呈现的序列时间（毫秒）——**只能来自浏览器**，不得由请求推算 */
  presentedMs: z.number().finite().nonnegative(),
  /** 自上次采样以来掉帧数（无该指标时为 null） */
  droppedFrames: z.number().int().nonnegative().nullable().default(null),
  /** 自上次采样以来应呈现帧数（用于算掉帧比例） */
  expectedFrames: z.number().int().nonnegative().nullable().default(null),
  /** 采样时刻的 JS 堆（MB；无该指标时为 null） */
  memoryMb: z.number().finite().nonnegative().nullable().default(null),
}).strict();
export type PlaybackSyncSample = z.infer<typeof playbackSyncSampleSchema>;

export const playbackSyncFixtureResultSchema = z.object({
  fixtureId: z.string().min(1),
  path: playbackSyncPathSchema,
  backendKind: z.string().min(1),
  /** 该夹具声称/实测的精度（帧级门据此判定） */
  precision: z.enum(PLAYBACK_PRECISIONS),
  /** 是否要求帧级（true 时精度达不到即失败） */
  frameAccurateRequired: z.boolean().default(false),
  /** 冷/热缓存首帧耗时（毫秒；未测为 null） */
  coldFirstFrameMs: z.number().finite().nonnegative().nullable().default(null),
  hotFirstFrameMs: z.number().finite().nonnegative().nullable().default(null),
  /** 冷/热 seek 耗时样本（毫秒） */
  seekSamplesMs: z.array(z.number().finite().nonnegative()).default([]),
  samples: z.array(playbackSyncSampleSchema).default([]),
  /** 夹具时长（毫秒；用于把漂折算成"每分钟"） */
  durationMs: z.number().finite().nonnegative().nullable().default(null),
}).strict();
export type PlaybackSyncFixtureResult = z.infer<typeof playbackSyncFixtureResultSchema>;

export const PLAYBACK_SYNC_METRICS = [
  'CACHED_SEEK_P50', 'CACHED_SEEK_P95',
  /** 启动偏移（首个采样点的固定偏移） */
  'STARTUP_OFFSET',
  /** 累计漂移（偏移量随时间的最大变化）——长片判定的真正依据 */
  'DRIFT_ACCUMULATION',
  'DRIFT_PER_MINUTE',
  'DROPPED_FRAME_RATIO', 'COLD_FIRST_FRAME', 'HOT_FIRST_FRAME', 'MEMORY_PEAK', 'FRAME_ACCURACY',
] as const;
export const playbackSyncMetricSchema = z.enum(PLAYBACK_SYNC_METRICS);
export type PlaybackSyncMetric = z.infer<typeof playbackSyncMetricSchema>;

export const playbackSyncVerdictSchema = z.object({
  metric: playbackSyncMetricSchema,
  value: z.number().finite().nullable(),
  threshold: z.number().finite().nullable(),
  verdict: z.enum(['PASS', 'FAIL', 'UNKNOWN']),
  note: z.string().max(200).default(''),
}).strict();
export type PlaybackSyncVerdict = z.infer<typeof playbackSyncVerdictSchema>;

export const playbackSyncFixtureReportSchema = z.object({
  fixtureId: z.string().min(1),
  path: playbackSyncPathSchema,
  backendKind: z.string().min(1),
  precision: z.enum(PLAYBACK_PRECISIONS),
  verdicts: z.array(playbackSyncVerdictSchema),
  /** 总体：任一 FAIL → FAIL；否则任一 UNKNOWN → UNKNOWN；全 PASS → PASS */
  verdict: z.enum(['PASS', 'FAIL', 'UNKNOWN']),
  failureReasons: z.array(z.string().max(120)),
}).strict();
export type PlaybackSyncFixtureReport = z.infer<typeof playbackSyncFixtureReportSchema>;

export const playbackSyncReportSchema = z.object({
  generatedAt: z.string().min(1),
  thresholdSource: z.literal(PLAYBACK_SYNC_THRESHOLD_SOURCE),
  thresholds: z.record(z.string(), z.number()),
  fixtures: z.array(playbackSyncFixtureReportSchema),
  /** 按路径分组的总体结论（**预渲染与本地实时不得混算**） */
  byPath: z.array(z.object({
    path: playbackSyncPathSchema,
    fixtures: z.number().int().min(0),
    verdict: z.enum(['PASS', 'FAIL', 'UNKNOWN']),
  }).strict()),
  overall: z.enum(['PASS', 'FAIL', 'UNKNOWN']),
}).strict();
export type PlaybackSyncReport = z.infer<typeof playbackSyncReportSchema>;

const percentile = (values: readonly number[], fraction: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index]!;
};

/** 由原始结果算指标与逐项判定（纯函数）。 */
export function summarizePlaybackSyncReport(input: {
  results: readonly PlaybackSyncFixtureResult[];
  generatedAt?: string;
}): PlaybackSyncReport {
  const fixtures = input.results.map((raw): PlaybackSyncFixtureReport => {
    const result = playbackSyncFixtureResultSchema.parse(raw);
    const verdicts: PlaybackSyncVerdict[] = [];
    const failureReasons: string[] = [];
    const push = (metric: PlaybackSyncMetric, value: number | null, threshold: number | null, pass: boolean | null, note = ''): void => {
      const verdict = value === null || threshold === null ? 'UNKNOWN' : pass === true ? 'PASS' : 'FAIL';
      if (verdict === 'FAIL') failureReasons.push(`${metric}${note === '' ? '' : `（${note}）`}`);
      verdicts.push({ metric, value, threshold, verdict, note });
    };

    // 冷/热首帧
    push('COLD_FIRST_FRAME', result.coldFirstFrameMs, PLAYBACK_SYNC_THRESHOLDS.firstFrameColdMs,
      result.coldFirstFrameMs === null ? null : result.coldFirstFrameMs <= PLAYBACK_SYNC_THRESHOLDS.firstFrameColdMs);
    push('HOT_FIRST_FRAME', result.hotFirstFrameMs, PLAYBACK_SYNC_THRESHOLDS.firstFrameColdMs,
      result.hotFirstFrameMs === null ? null : result.hotFirstFrameMs <= PLAYBACK_SYNC_THRESHOLDS.firstFrameColdMs,
      '热缓存应以冷缓存为参照', );

    // 缓存 seek p50/p95
    const p50 = percentile(result.seekSamplesMs, 0.5);
    const p95 = percentile(result.seekSamplesMs, 0.95);
    push('CACHED_SEEK_P50', p50, PLAYBACK_SYNC_THRESHOLDS.cachedSeekP50Ms, p50 === null ? null : p50 <= PLAYBACK_SYNC_THRESHOLDS.cachedSeekP50Ms);
    push('CACHED_SEEK_P95', p95, PLAYBACK_SYNC_THRESHOLDS.cachedSeekP95Ms, p95 === null ? null : p95 <= PLAYBACK_SYNC_THRESHOLDS.cachedSeekP95Ms);

    // 偏移序列（呈现 - 请求，带正负号）：区分**固定启动偏移**与**持续漂移**
    const offsets = result.samples.map((sample) => sample.presentedMs - sample.requestedMs);
    const startupOffset = offsets.length === 0 ? null : Math.abs(offsets[0]!);
    push('STARTUP_OFFSET', startupOffset, PLAYBACK_SYNC_THRESHOLDS.startupOffsetMs,
      startupOffset === null ? null : startupOffset <= PLAYBACK_SYNC_THRESHOLDS.startupOffsetMs, '固定偏移，非漂移');
    const accumulation = offsets.length === 0
      ? null
      : Math.max(...offsets.map((offset) => Math.abs(offset - offsets[0]!)));
    push('DRIFT_ACCUMULATION', accumulation, PLAYBACK_SYNC_THRESHOLDS.driftAccumulationMs,
      accumulation === null ? null : accumulation <= PLAYBACK_SYNC_THRESHOLDS.driftAccumulationMs);
    const driftPerMinute = accumulation === null || result.durationMs === null || result.durationMs === 0
      ? null
      : (accumulation / result.durationMs) * 60_000;
    push('DRIFT_PER_MINUTE', driftPerMinute, PLAYBACK_SYNC_THRESHOLDS.driftPerMinuteMs,
      driftPerMinute === null ? null : driftPerMinute <= PLAYBACK_SYNC_THRESHOLDS.driftPerMinuteMs);

    // 掉帧比例
    const dropped = result.samples.reduce((sum, sample) => sum + (sample.droppedFrames ?? 0), 0);
    const expected = result.samples.reduce((sum, sample) => sum + (sample.expectedFrames ?? 0), 0);
    const droppedRatio = expected === 0 ? null : dropped / expected;
    push('DROPPED_FRAME_RATIO', droppedRatio, PLAYBACK_SYNC_THRESHOLDS.droppedFrameRatio,
      droppedRatio === null ? null : droppedRatio <= PLAYBACK_SYNC_THRESHOLDS.droppedFrameRatio);

    // 内存峰值
    const memoryPeak = result.samples.reduce<number | null>((peak, sample) => {
      if (sample.memoryMb === null) return peak;
      return peak === null ? sample.memoryMb : Math.max(peak, sample.memoryMb);
    }, null);
    push('MEMORY_PEAK', memoryPeak, PLAYBACK_SYNC_THRESHOLDS.maxMemoryMb,
      memoryPeak === null ? null : memoryPeak <= PLAYBACK_SYNC_THRESHOLDS.maxMemoryMb);

    // 帧级门：要求帧级但精度不是 FRAME_ACCURATE → 直接 FAIL（"不支持帧级精度不能通过逐帧门"）
    const frameAccurateOk = !result.frameAccurateRequired || result.precision === 'FRAME_ACCURATE';
    push('FRAME_ACCURACY', result.precision === 'FRAME_ACCURATE' ? 1 : 0, 1, frameAccurateOk,
      result.frameAccurateRequired && result.precision !== 'FRAME_ACCURATE' ? '不支持帧级精度' : '');

    const verdict = verdicts.some((entry) => entry.verdict === 'FAIL')
      ? 'FAIL'
      : verdicts.some((entry) => entry.verdict === 'UNKNOWN') ? 'UNKNOWN' : 'PASS';
    return playbackSyncFixtureReportSchema.parse({
      fixtureId: result.fixtureId, path: result.path, backendKind: result.backendKind, precision: result.precision,
      verdicts, verdict, failureReasons,
    });
  });

  const byPath = PLAYBACK_SYNC_PATHS.map((path) => {
    const group = fixtures.filter((fixture) => fixture.path === path);
    const verdict = group.some((fixture) => fixture.verdict === 'FAIL')
      ? 'FAIL' as const
      : group.some((fixture) => fixture.verdict === 'UNKNOWN') ? 'UNKNOWN' as const : 'PASS' as const;
    return { path, fixtures: group.length, verdict: group.length === 0 ? 'UNKNOWN' as const : verdict };
  });
  const overall = fixtures.some((fixture) => fixture.verdict === 'FAIL')
    ? 'FAIL' as const
    : fixtures.some((fixture) => fixture.verdict === 'UNKNOWN') ? 'UNKNOWN' as const : 'PASS' as const;

  return playbackSyncReportSchema.parse({
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    thresholdSource: PLAYBACK_SYNC_THRESHOLD_SOURCE,
    thresholds: { ...PLAYBACK_SYNC_THRESHOLDS },
    fixtures, byPath, overall,
  });
}
