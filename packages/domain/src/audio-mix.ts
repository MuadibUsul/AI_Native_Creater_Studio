import { and, eq } from 'drizzle-orm';
import {
  ApiFailure,
  AUDIO_MIX_GUARD_REASONS,
  DEFAULT_SOURCE_PEAK_DB,
  ERROR_CODES,
  dbToLinear,
  linearToDb,
  mediaRangeSchema,
  mediaTimeSchema,
} from '@ancs/contracts';
import { compositionAudioRegions, sequenceTracks } from '@ancs/db';
import type { DomainDeps } from './channels.js';

/**
 * N03-06 基础混音计划（片段/区域级）。
 *
 * 目标（V03-04／V03-21）：
 * - **保留原音、非破坏**：计划只读区域参数（增益/淡入淡出/声像/声道映射）与轨道状态，不写任何数据、不改源素材；
 * - **无削波**：以"源峰值 + 增益"估计每轨峰值，超过 0 dBFS 直接 fail-closed（绝不静默削波）；
 * - **无意外静音**：存在音频区域但可听轨为 0（全被静音或未被独奏命中）即 fail-closed；
 * - **不重新合成讲话**：计划不触发任何生成式/重合成路径，只做增益与路由。
 */

export const AUDIO_MIX_PLAN_VERSION = 'clip-mix-plan/1.0';

export interface ClipMixTrackPlan {
  trackId: string;
  trackName: string;
  audible: boolean;
  muted: boolean;
  soloed: boolean;
  regionCount: number;
  /** 轨内最大区域增益（dB） */
  maxGainDb: number;
  /** 估计峰值（dBFS）：源峰值 + 增益 + 声像衰减 */
  estimatedPeakDb: number;
  /** 剩余余量（dB，正数表示未削波） */
  headroomDb: number;
  regions: {
    regionId: string;
    sourceStreamId: string;
    gainDb: number;
    pan: number;
    fadeInTicks: string;
    fadeOutTicks: string;
    channelCount: number;
    /** 该区域是否被完整淡出（可能成为静音段） */
    fullyFaded: boolean;
  }[];
}

export interface ClipMixPlan {
  schemaVersion: typeof AUDIO_MIX_PLAN_VERSION;
  sequenceId: string;
  soloActive: boolean;
  audibleTrackCount: number;
  /** 峰值最高的轨（null 表示无音频内容） */
  peakTrackId: string | null;
  estimatedPeakDb: number;
  headroomDb: number;
  tracks: ClipMixTrackPlan[];
}

const secondsOf = (range: unknown): number => {
  const parsed = mediaRangeSchema.parse(range);
  const start = (Number(parsed.start.ticks) * parsed.start.timebase.num) / parsed.start.timebase.den;
  const end = (Number(parsed.end.ticks) * parsed.end.timebase.num) / parsed.end.timebase.den;
  return end - start;
};

export async function planClipAudioMix(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; sequenceId: string },
): Promise<ClipMixPlan> {
  const tracks = await deps.db.select().from(sequenceTracks).where(and(
    eq(sequenceTracks.sequenceId, input.sequenceId),
    eq(sequenceTracks.workspaceId, input.workspaceId),
    eq(sequenceTracks.projectId, input.projectId),
  ));
  const audioTracks = tracks.filter((track) => track.kind === 'AUDIO');
  const regions = await deps.db.select().from(compositionAudioRegions).where(and(
    eq(compositionAudioRegions.sequenceId, input.sequenceId),
    eq(compositionAudioRegions.workspaceId, input.workspaceId),
    eq(compositionAudioRegions.projectId, input.projectId),
  ));
  const soloActive = audioTracks.some((track) => track.solo);

  const plans: ClipMixTrackPlan[] = audioTracks.map((track) => {
    const trackRegions = regions.filter((region) => region.trackId === track.id);
    const soloed = soloActive ? track.solo : false;
    const audible = !track.muted && (soloActive ? track.solo : true);
    const regionPlans = trackRegions.map((region) => {
      const gainDb = Number(region.gainDb);
      const pan = Number(region.pan);
      const parameters = (region.parameters ?? {}) as { values?: Record<string, unknown> };
      const declaredPeak = typeof parameters.values?.['sourcePeakDb'] === 'number' ? (parameters.values['sourcePeakDb'] as number) : DEFAULT_SOURCE_PEAK_DB;
      const duration = secondsOf(region.sequenceRange);
      const fadeInSeconds = (() => {
        const fade = mediaTimeSchema.parse(region.fadeIn);
        return (Number(fade.ticks) * fade.timebase.num) / fade.timebase.den;
      })();
      const fadeOutSeconds = (() => {
        const fade = mediaTimeSchema.parse(region.fadeOut);
        return (Number(fade.ticks) * fade.timebase.num) / fade.timebase.den;
      })();
      // 声像居中不衰减；极端声像按 -3 dB 计（保守估计）
      const panAttenuationDb = pan === 0 ? 0 : -3 * Math.abs(pan);
      const estimated = declaredPeak + gainDb + panAttenuationDb;
      return {
        regionId: region.id,
        sourceStreamId: region.sourceStreamId,
        gainDb,
        pan,
        fadeInTicks: mediaTimeSchema.parse(region.fadeIn).ticks,
        fadeOutTicks: mediaTimeSchema.parse(region.fadeOut).ticks,
        channelCount: (region.channelMapping as unknown[]).length,
        fullyFaded: fadeInSeconds >= duration && fadeOutSeconds >= duration,
        estimatedPeakDb: estimated,
      };
    });
    const maxGainDb = regionPlans.length === 0 ? 0 : Math.max(...regionPlans.map((plan) => plan.gainDb));
    const estimatedPeakDb = regionPlans.length === 0 ? Number.NEGATIVE_INFINITY : Math.max(...regionPlans.map((plan) => plan.estimatedPeakDb));
    return {
      trackId: track.id,
      trackName: track.name,
      audible,
      muted: track.muted,
      soloed,
      regionCount: trackRegions.length,
      maxGainDb,
      estimatedPeakDb: audible ? estimatedPeakDb : Number.NEGATIVE_INFINITY,
      headroomDb: audible ? -estimatedPeakDb : Number.POSITIVE_INFINITY,
      regions: regionPlans,
    };
  });

  const audibleTracks = plans.filter((plan) => plan.audible && plan.regionCount > 0);
  const peakPlan = audibleTracks.reduce<ClipMixTrackPlan | null>(
    (current, plan) => (current === null || plan.estimatedPeakDb > current.estimatedPeakDb ? plan : current),
    null,
  );
  const plan: ClipMixPlan = {
    schemaVersion: AUDIO_MIX_PLAN_VERSION,
    sequenceId: input.sequenceId,
    soloActive,
    audibleTrackCount: audibleTracks.length,
    peakTrackId: peakPlan?.trackId ?? null,
    estimatedPeakDb: peakPlan?.estimatedPeakDb ?? Number.NEGATIVE_INFINITY,
    headroomDb: peakPlan === null ? Number.POSITIVE_INFINITY : -peakPlan.estimatedPeakDb,
    tracks: plans,
  };

  // 无意外静音：存在区域却没有任何可听轨 → fail-closed（不要静默产出无声混音）
  if (regions.length > 0 && audibleTracks.length === 0) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'mix would produce silence: every audio track is muted or unsoloed', 409, {
      reason: AUDIO_MIX_GUARD_REASONS.EMPTY_OUTPUT,
      regionCount: regions.length,
    });
  }
  // 无削波：估计峰值超过 0 dBFS → fail-closed（要用户降增益，而不是静默削波）
  if (peakPlan !== null && peakPlan.estimatedPeakDb > 0) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'mix would clip: estimated peak exceeds 0 dBFS', 422, {
      reason: AUDIO_MIX_GUARD_REASONS.CLIPPING,
      trackId: peakPlan.trackId,
      estimatedPeakDb: peakPlan.estimatedPeakDb,
    });
  }
  return plan;
}

/** 校验用：把 dB 值转成线性增益（供测试与 UI 预览）。 */
export const mixGainLinear = (decibels: number): number => dbToLinear(decibels);
export const mixGainDb = (linear: number): number => linearToDb(linear);

/** 计划内的区域数量（供调用方快速断言）。 */
export const countMixRegions = (plan: ClipMixPlan): number => plan.tracks.reduce((total, track) => total + track.regions.length, 0);
