import { z } from 'zod';
import { agentLocaleSchema, agentPointerSchema } from './agent.js';
import { opaqueIdSchema } from './common/ids.js';
import type { ProviderImplementation } from './provider-kind.js';

/**
 * V6-2 流式双语语音 + 共同注意力：浏览器 ⇄ Realtime Gateway（独立进程）的线协议，与流式语音识别的供应商端口。
 *
 * - 连接：`/realtime/v1/voice?session=<语音会话 id>&token=<短期凭证>`。凭证来自 API 创建的语音会话（N05-01，
 *   需要 project:write）；网关只认这个凭证，长期 Provider Key 只在网关进程里。
 * - 音频：二进制帧 = 16 kHz 单声道 PCM16 小端；客户端的**音频时钟**就是已发送的采样数。
 * - 指向：客户端每次选择或播放位置变化都发一条带音频时钟的指向样本；网关按**说出"这个/这里"那一刻**的样本绑定指代
 *   （V6 §5.2），没有指代词时用开口那一刻的明确选择。
 * - 一句话说完（服务端断句 + 不以"但是/不对/除了…"这类未闭合词结尾）→ `utterance`：客户端把它当作一轮对话发给 AI
 *   （与打字同一路径、同一套权限与幂等）。网关不写工程、不替用户采用任何东西。
 */

export const REALTIME_VOICE_PATH = '/realtime/v1/voice';
export const REALTIME_SAMPLE_RATE = 16_000;

/** 指向样本：音频时钟上的某一刻，用户在指着什么（显式选择）以及播放头在哪里。 */
export const realtimePointerSampleSchema = z.object({
  /** 音频时钟（自开始以来发送的采样数） */
  atSample: z.number().int().nonnegative(),
  pointer: agentPointerSchema,
  /** 播放头位置（十进制秒文本；没有视频时为 null） */
  playhead: z.string().max(20).nullable(),
  /** 给人看的标签（例如"片段 lake.mp4"），网关原样带回 */
  label: z.string().max(200).nullable(),
}).strict();
export type RealtimePointerSample = z.infer<typeof realtimePointerSampleSchema>;

export const realtimeClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start'), locale: agentLocaleSchema, sampleRate: z.literal(REALTIME_SAMPLE_RATE) }).strict(),
  z.object({ type: z.literal('pointer'), sample: realtimePointerSampleSchema }).strict(),
  /** 停止 AI 说话（打断播报）：本地已停播，告诉网关丢弃未播放的回应 */
  z.object({ type: z.literal('stop-speaking') }).strict(),
  /** 关麦：结束这一段采集（未说完的话按已识别的内容收尾） */
  z.object({ type: z.literal('end') }).strict(),
]);
export type RealtimeClientMessage = z.infer<typeof realtimeClientMessageSchema>;

export const realtimeWordSchema = z.object({
  text: z.string(),
  /** 相对音频开始的秒数 */
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
}).strict();
export type RealtimeWord = z.infer<typeof realtimeWordSchema>;

export const REALTIME_ATTENTION_EVIDENCE = ['DEICTIC_WORD', 'SELECTION_AT_START', 'PLAYHEAD_AT_WORD', 'NONE'] as const;
export const realtimeAttentionEvidenceSchema = z.enum(REALTIME_ATTENTION_EVIDENCE);
export type RealtimeAttentionEvidence = z.infer<typeof realtimeAttentionEvidenceSchema>;

export const realtimeAttentionSchema = z.object({
  pointer: agentPointerSchema,
  evidence: realtimeAttentionEvidenceSchema,
  /** 触发绑定的指代词（例如"这里"）与它在音频里的时间 */
  word: z.string().nullable(),
  atSeconds: z.number().nonnegative().nullable(),
  label: z.string().nullable(),
}).strict();
export type RealtimeAttention = z.infer<typeof realtimeAttentionSchema>;

export const realtimeServerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ready'),
    asr: z.object({ providerId: z.string(), implementation: z.enum(['REAL', 'MOCK', 'SCRIPTED']), model: z.string().nullable() }).strict(),
  }).strict(),
  /** 转写（同一句话内修订号单调递增，客户端用最新修订替换显示） */
  z.object({
    type: z.literal('transcript'),
    utteranceId: opaqueIdSchema,
    revision: z.number().int().positive(),
    text: z.string(),
    isFinal: z.boolean(),
  }).strict(),
  /** 当前理解的指向（一句话进行中就开始解析，便于本地高亮） */
  z.object({ type: z.literal('attention'), utteranceId: opaqueIdSchema, attention: realtimeAttentionSchema }).strict(),
  /** 一句话说完：交给 AI 的文字 + 绑定的指向 */
  z.object({ type: z.literal('utterance'), utteranceId: opaqueIdSchema, text: z.string().min(1), attention: realtimeAttentionSchema }).strict(),
  /** 说到一半停住（以"但是/不对/除了"等结尾）：先不交给 AI，等后半句 */
  z.object({ type: z.literal('held'), utteranceId: opaqueIdSchema, text: z.string() }).strict(),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string(), retryable: z.boolean() }).strict(),
]);
export type RealtimeServerMessage = z.infer<typeof realtimeServerMessageSchema>;

/** WebSocket 关闭码（应用自定义区间 4000–4999） */
export const REALTIME_CLOSE_CODES = {
  CREDENTIAL_INVALID: 4401,
  SESSION_NOT_OPEN: 4409,
  ORIGIN_REJECTED: 4403,
  PROTOCOL_ERROR: 4400,
  ASR_UNAVAILABLE: 4501,
} as const;

// ---------------------------------------------------------------------------
// 流式语音识别端口（供应商无关）
// ---------------------------------------------------------------------------

export interface StreamingAsrResult {
  /** 这段结果覆盖的音频（秒，相对开始） */
  start: number;
  duration: number;
  text: string;
  words: RealtimeWord[];
  /** 这段文字不会再变 */
  isFinal: boolean;
  /** 供应商判断一句话结束（端点检测） */
  speechFinal: boolean;
}

export interface StreamingAsrEvents {
  onResult(result: StreamingAsrResult): void;
  /** 一段静音后供应商确认这句话结束（最后一个词的结束时间，秒） */
  onUtteranceEnd(lastWordEnd: number | null): void;
  onError(error: { code: string; message: string; retryable: boolean }): void;
  onClose(): void;
}

export interface StreamingAsrSession {
  sendAudio(chunk: Uint8Array): void;
  /** 音频发完：请供应商把剩下的结果都给出来后关闭 */
  finish(): void;
  close(): void;
}

export interface StreamingSpeechRecognizer {
  readonly providerId: string;
  readonly implementation: ProviderImplementation;
  readonly model: string | null;
  open(options: { locale: 'zh-CN' | 'en'; sampleRate: number }, events: StreamingAsrEvents): Promise<StreamingAsrSession>;
}
