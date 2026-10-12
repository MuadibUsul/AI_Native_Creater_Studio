import { mediaTimeSchema, mediaTimeToDisplaySecondsText, type FrameRate, type MediaTime } from '@ancs/contracts';

/**
 * 共看片室的时间显示与播放同步。
 * 权威时间一律是有理 MediaTime；这里的浮点秒只用于 <video> 同步与显示，
 * 发给 AI 的选区由时间带的有理换算（`@ancs/contracts` timeline-band）产生。
 */

/** 显示：mm:ss.d（十分之一秒，最近值舍入）。 */
export function formatClock(time: MediaTime): string {
  const text = mediaTimeToDisplaySecondsText(time, 1);
  const negative = text.startsWith('-');
  const [whole = '0', tenth = '0'] = (negative ? text.slice(1) : text).split('.');
  const seconds = Number(whole);
  const minutes = Math.floor(seconds / 60);
  return `${negative ? '-' : ''}${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}.${tenth}`;
}

/** 选区发给 AI 的十进制秒文本（毫秒精度足够指认，解析回有理时间由服务端完成）。 */
export function pointerSecondsText(time: MediaTime): string {
  return mediaTimeToDisplaySecondsText(time, 3);
}

/** 播放器位置（浮点秒，仅同步用）→ 帧网格上的 MediaTime。 */
export function frameTimeAtSeconds(seconds: number, frameRate: FrameRate): MediaTime {
  const frames = Number.isFinite(seconds) && seconds > 0 ? Math.round((seconds * frameRate.num) / frameRate.den) : 0;
  return mediaTimeSchema.parse({ ticks: String(frames), timebase: { num: frameRate.den, den: frameRate.num } });
}

/** MediaTime → 浮点秒（仅用于设置 <video>.currentTime）。 */
export function displaySeconds(time: MediaTime): number {
  return (Number(time.ticks) * time.timebase.num) / time.timebase.den;
}

/** 美元微单位 → 显示金额（未知不填零，由调用方处理 null）。 */
export function formatUsdMicros(micros: number): string {
  const dollars = micros / 1_000_000;
  return micros === 0 ? '$0' : dollars < 0.01 ? '<$0.01' : `$${dollars.toFixed(2)}`;
}
