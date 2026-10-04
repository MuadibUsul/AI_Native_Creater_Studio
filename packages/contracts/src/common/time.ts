import { z } from 'zod';

/**
 * 时间契约（计划 §4.1 / DEC-02）。
 *
 * - 时间戳：UTC ISO 8601（带 Z 的完整时间戳），用于事件、创建/更新时间等。
 * - 日粒度日期：ISO 8601 日期（YYYY-MM-DD），用于发布日、检索日等"当天"语义的字段
 *   （规范 §85 的 published_at/retrieved_at 即此类）。
 * - 视频时间：整数毫秒（DEC-02：持久化权威时间统一为整数毫秒；渲染边界再转 frame）。
 */

export const isoDateTimeSchema = z.iso.datetime();

/** ISO 8601 日期或完整时间戳（日粒度字段） */
export const isoDateOrDateTimeSchema = z.union([z.iso.date(), isoDateTimeSchema]);

/** 视频时间：非负整数毫秒 */
export const videoMsSchema = z.number().int().nonnegative();

/** 时长：正整数毫秒 */
export const durationMsSchema = z.number().int().positive();

export type IsoDateTime = z.infer<typeof isoDateTimeSchema>;
export type VideoMs = z.infer<typeof videoMsSchema>;
