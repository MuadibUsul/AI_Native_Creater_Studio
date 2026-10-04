import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';

/**
 * SpeechProfile 契约（规范 §6.4 / P01-04）：
 * Creator Identity 不止"像不像"，还包括"怎么说"。
 * 版本语义：更新产生**不可变的新版本**（发音词典等随版本保存，§95）；
 * P04-06 Speech Director 消费本结构生成供应商无关的 SpeechPlan。
 */

export const speechProfileFieldsSchema = z.object({
  defaultSpeed: z.number().min(0.5).max(2),
  /** 能量/情绪强度（0—1） */
  energy: z.number().min(0).max(1),
  tone: z.string().min(1),
  pauseStyle: z.string().min(1),
  sentenceGapMs: z.number().int().min(0),
  hookStyle: z.string().min(1),
  bodyStyle: z.string().min(1),
  explanationStyle: z.string().min(1),
  quoteStyle: z.string().min(1),
  conclusionStyle: z.string().min(1),
  numberReadingStyle: z.string().min(1),
  acronymPolicy: z.string().min(1),
  /** 发音词典（品牌/人名/财经术语；版本化保存，§95 SHOULD） */
  pronunciationDictionary: z.array(
    z.object({
      term: z.string().min(1),
      reading: z.string().min(1),
    }),
  ),
  disfluencyPolicy: z.string().min(1),
});

export type SpeechProfileFields = z.infer<typeof speechProfileFieldsSchema>;
export const speechProfileFieldsOverrideSchema = speechProfileFieldsSchema.partial();
export type SpeechProfileFieldsOverride = z.infer<typeof speechProfileFieldsOverrideSchema>;

export const DEFAULT_SPEECH_PROFILE: SpeechProfileFields = {
  defaultSpeed: 1,
  energy: 0.6,
  tone: '专业、克制、清晰',
  pauseStyle: '关键数字前后短暂停顿',
  sentenceGapMs: 180,
  hookStyle: '高能量开场，快速进入重点',
  bodyStyle: '稳定节奏，长句拆分',
  explanationStyle: '复杂概念适度降速，逐层展开',
  quoteStyle: '与主叙述轻微语气区分',
  conclusionStyle: '稳定、清晰，避免过度情绪',
  numberReadingStyle: '数字逐位读清，单位紧跟其后',
  acronymPolicy: '常见缩写按字母读，财经术语按业内习惯',
  pronunciationDictionary: [],
  disfluencyPolicy: '不注入口头禅；保留自然停顿',
};

export function mergeSpeechProfileFields(
  override: SpeechProfileFieldsOverride | undefined,
): SpeechProfileFields {
  const merged = { ...DEFAULT_SPEECH_PROFILE, ...override };
  if (override?.pronunciationDictionary !== undefined) {
    merged.pronunciationDictionary = override.pronunciationDictionary;
  }
  return merged;
}

export const speechProfileVersionSchema = z.object({
  id: opaqueIdSchema,
  speechProfileId: opaqueIdSchema,
  version: z.number().int().positive(),
  fields: speechProfileFieldsSchema,
  createdAt: isoDateTimeSchema,
});

export const speechProfileSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  name: z.string().min(1).max(80),
  currentVersion: z.number().int().positive(),
  latest: speechProfileVersionSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export type SpeechProfile = z.infer<typeof speechProfileSchema>;
export type SpeechProfileVersion = z.infer<typeof speechProfileVersionSchema>;

export const createSpeechProfileRequestSchema = z.object({
  name: z.string().min(1).max(80),
  fields: speechProfileFieldsOverrideSchema.optional(),
});

export const updateSpeechProfileRequestSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  /** 提供 fields 即产生新版本（旧版本不可变） */
  fields: speechProfileFieldsOverrideSchema.optional(),
});
