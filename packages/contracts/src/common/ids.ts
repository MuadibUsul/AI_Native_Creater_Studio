import { z } from 'zod';

/**
 * 不透明 ID（计划 §4.1）：客户端不得解析 ID 的内部含义。
 * 生成规则（前缀、随机源、编码）属于服务端实现细节，不进入契约。
 */
export const opaqueIdSchema = z.string().min(1).max(128);

export type OpaqueId = z.infer<typeof opaqueIdSchema>;
