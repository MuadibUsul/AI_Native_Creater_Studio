import { z } from 'zod';
import type { SourceMediaProbeResult } from './assets.js';

/**
 * V6-5 讲述（配音）与文章入口（V6 §4.2、§11）。
 *
 * - 文章被当作"详细的提示词"：原文存在工程简报里（`brief.article`），作为参考数据进入 AI 上下文；
 *   AI 决定讲什么、怎么分段、配哪些图解——导演与调度代码不按"文章类型"分支（裁决 0018）。
 * - 讲述 = AI 写好的一段讲述稿，由 Worker 装配的语音合成引擎逐句合成，拼成一条音频资产（来源 GENERATED），
 *   作为普通片段放在讲述轨（VO*，音频轨）上；字幕按每句在音频里的真实位置生成（逐句合成，句界精确）。
 *   预览、终渲染、试改/采用/撤销沿用时间线的同一套机制。
 * - 合成语音受项目制作规则约束（`speech.generate` → `allowGeneratedSpeech`）：素材工程默认关闭，
 *   从文章开始的工程在用户选择"AI 配音讲述"时开启；每次合成前服务端校验。
 * - 引擎能力如实声明：每个声音说明它能说的语言；说不了的语言明确拒绝，不用别的语言硬读。
 */

/** 文章原文上限（字符） */
export const MAX_ARTICLE_CHARS = 40_000;
/** 一段讲述稿上限（字符；更长的内容分成多段讲述） */
export const MAX_NARRATION_CHARS = 1_500;
/** 讲述轨名前缀（音频轨） */
export const NARRATION_TRACK_PREFIX = 'VO';

export const projectArticleSchema = z.object({
  title: z.string().trim().max(200).default(''),
  text: z.string().trim().min(1).max(MAX_ARTICLE_CHARS),
  /** 从链接导入时的来源（抓取后的最终地址）；粘贴的文章没有 */
  sourceUrl: z.string().url().max(2048).optional(),
}).strict();
export type ProjectArticle = z.infer<typeof projectArticleSchema>;

export const narrationVoiceSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/),
  name: z.string().min(1).max(80),
  /** 能说的语言（BCP 47 主标签，例如 en、zh） */
  languages: z.array(z.string().regex(/^[a-z]{2,3}$/)).min(1).max(20),
  /** 给 AI 的说明（英文）：音色、适合什么 */
  description: z.string().max(200),
}).strict();
export type NarrationVoice = z.infer<typeof narrationVoiceSchema>;

export interface NarrationSynthesisRequest {
  /** 逐句文本（引擎逐句合成并拼接，返回每句的位置） */
  sentences: readonly string[];
  voice: string;
  /** 语速倍率（1 = 正常） */
  speed: number;
}

export interface NarrationSynthesisResult {
  /** 拼接好的音频（WAV 等 FFmpeg 可解码格式） */
  audio: Uint8Array;
  mimeType: string;
  probe: SourceMediaProbeResult;
  durationMs: number;
  /** 每句在音频里的位置（毫秒，与 sentences 一一对应） */
  sentences: readonly { startMs: number; endMs: number }[];
}

/** 语音合成端口（Worker 装配：本地引擎或部署方接入的供应商）。 */
export interface NarrationSynthesizer {
  readonly implementation: 'REAL' | 'SCRIPTED';
  /** 引擎名（记入资产来源，例如 flite、process:<name>） */
  readonly engine: string;
  voices(): readonly NarrationVoice[];
  synthesize(request: NarrationSynthesisRequest): Promise<NarrationSynthesisResult>;
}

/** 导演工具用到的讲述端口（Worker 装配）。未装配时讲述工具明确报"本部署没有配置配音"。 */
export interface AgentNarrationPorts {
  synthesizer: NarrationSynthesizer;
}

/** 讲述音频资产的元数据（存在资产 metadata.narration 里；时间带标名、字幕与重配都据此）。 */
export const narrationMetadataSchema = z.object({
  kind: z.literal('NARRATION'),
  text: z.string().min(1).max(MAX_NARRATION_CHARS),
  sentences: z.array(z.object({ text: z.string().min(1).max(MAX_NARRATION_CHARS), startMs: z.number().int().nonnegative(), endMs: z.number().int().nonnegative() }).strict()).min(1).max(200),
  voice: z.string().min(1).max(64),
  engine: z.string().min(1).max(80),
  speed: z.number().positive().max(4),
  language: z.string().max(16).nullable(),
  synthesisMs: z.number().int().nonnegative(),
}).strict();
export type NarrationMetadata = z.infer<typeof narrationMetadataSchema>;

export const NARRATION_ERROR_REASONS = {
  UNAVAILABLE: 'NARRATION_UNAVAILABLE',
  VOICE_NOT_FOUND: 'NARRATION_VOICE_NOT_FOUND',
  LANGUAGE_UNSUPPORTED: 'NARRATION_LANGUAGE_UNSUPPORTED',
  SYNTHESIS_FAILED: 'NARRATION_SYNTHESIS_FAILED',
  NOT_NARRATION: 'NARRATION_CLIP_NOT_NARRATION',
} as const;
