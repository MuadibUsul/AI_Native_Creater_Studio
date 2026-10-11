/**
 * `@ancs/time` —— 唯一有理时间库（V5 §7）。
 *
 * - 权威计算：`MediaTime`（BigInt ticks + 有理时基）与 `Fraction`（精确有理秒）；
 * - 显示边界：`mediaTimeToDisplayMilliseconds/Seconds`（近似值，不得回写权威字段）；
 * - 旧数据兼容：`legacyMillisecondsToMediaTime` / `mediaTimeToLegacyMilliseconds`（只在无损时成功）。
 * 本包无 I/O、无运行时环境依赖，可在服务端、浏览器与 Worker 中共用。
 */
export * from './media-time.js';
export * from './fraction.js';
