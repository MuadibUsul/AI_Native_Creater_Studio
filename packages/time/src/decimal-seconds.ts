import { mediaTimeSchema, type MediaTime, type MediaRounding } from './media-time.js';
import { timeToFraction } from './fraction.js';

/**
 * 十进制秒文本 ↔ MediaTime（V6 §6.3：AI 工具以"秒"交流，内核只认有理时间）。
 *
 * - `parseDecimalSeconds`：把 "12" / "12.5" / "0.033" 这样的文本**精确**转成 MediaTime
 *   （"12.345" → 12345 ticks @ 1/1000），不经过浮点；最多 6 位小数，拒绝负数、指数与多余前导零；
 * - `mediaTimeToDisplaySecondsText`：显示/提示词边界，把 MediaTime 按显式舍入格式化成定长小数文本；
 *   结果只给人或模型阅读，不得回写权威字段（回写一律先经 `parseDecimalSeconds` 再对齐帧网格）。
 */

const DECIMAL_SECONDS = /^(0|[1-9]\d{0,8})(?:\.(\d{1,6}))?$/;

export function parseDecimalSeconds(text: string): MediaTime {
  const match = DECIMAL_SECONDS.exec(text.trim());
  if (match === null) throw new RangeError(`Invalid decimal seconds: ${JSON.stringify(text)}`);
  const whole = match[1] ?? '0';
  const fraction = match[2] ?? '';
  const scale = 10n ** BigInt(fraction.length);
  const ticks = BigInt(whole) * scale + (fraction.length === 0 ? 0n : BigInt(fraction));
  return mediaTimeSchema.parse({ ticks: ticks.toString(), timebase: { num: 1, den: Number(scale) } });
}

export function isDecimalSecondsText(text: string): boolean {
  return DECIMAL_SECONDS.test(text.trim());
}

/** 显示边界：MediaTime → 定长小数秒文本（默认 3 位，最近值舍入，ties away from zero）。 */
export function mediaTimeToDisplaySecondsText(time: MediaTime, decimals = 3, rounding: MediaRounding = 'nearest'): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 6) throw new RangeError('decimals must be an integer in [0, 6]');
  const value = timeToFraction(mediaTimeSchema.parse(time));
  const scale = 10n ** BigInt(decimals);
  const scaled = roundDivide(value.num * scale, value.den, rounding);
  const negative = scaled < 0n;
  const magnitude = negative ? -scaled : scaled;
  const whole = magnitude / scale;
  const rest = (magnitude % scale).toString().padStart(decimals, '0');
  return `${negative ? '-' : ''}${whole.toString()}${decimals === 0 ? '' : `.${rest}`}`;
}

function roundDivide(numerator: bigint, denominator: bigint, mode: MediaRounding): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n) return quotient;
  switch (mode) {
    case 'floor': return numerator < 0n ? quotient - 1n : quotient;
    case 'ceil': return numerator > 0n ? quotient + 1n : quotient;
    case 'towardZero': return quotient;
    case 'nearest': {
      const magnitude = remainder < 0n ? -remainder : remainder;
      return magnitude * 2n >= denominator ? quotient + (numerator < 0n ? -1n : 1n) : quotient;
    }
  }
}
