import { z } from 'zod';

/**
 * 服务器维护的聚合 revision（计划 §4.1 / §4.6）。
 * - 初始为 1，单调递增，不下拨、不因历史恢复回退（§4.8）。
 * - 写操作携带 base revision；不匹配返回 409 VERSION_CONFLICT。
 */
export const revisionSchema = z.number().int().positive();

export type Revision = z.infer<typeof revisionSchema>;
