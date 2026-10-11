/**
 * `@ancs/kernel` —— 编辑内核（V5 §6）。
 *
 * 纯函数：输入内存中的作品状态与编辑操作，输出确定的写入与事件草稿；
 * 不依赖数据库、网络、环境变量、墙钟或随机数（arch-check R9/R10 强制）。
 * 服务端（权威提交）、试改、属性测试与将来的客户端乐观预览共用同一份规则。
 */
export * from './timeline/types.js';
export { applyTimelineOperation, applyKernelResult } from './timeline/apply.js';
export { CLIP_IDENTITY_MAPPING } from './timeline/support.js';
