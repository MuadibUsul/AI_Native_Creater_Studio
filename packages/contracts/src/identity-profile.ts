import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';

/**
 * V6-7 我的形象与声音（V6 §4.3）：在档案里建一次，项目自动继承；只在用户明确要求时生成；授权记录可查。
 *
 * - 档案 = 创作者身份（creator_identities）+ 一张参考照片（形象）+ 一段声音样本（声音）。参考素材是工作区资产。
 * - 授权按"形象""声音"分开记录，**只增不改**：每次授权或撤回都追加一条记录（谁、何时、对哪段声明文本的哪个版本、本人还是获授权的他人）；
 *   当前是否有效 = 该类最近一条记录是授权。撤回立即生效：之后的报价与确认都会被拒绝。
 * - 声明文本有版本；记录里存声明版本、语言与文本哈希（能证明当时同意的是哪段话）。
 */

export const IDENTITY_CONSENT_KINDS = ['LIKENESS', 'VOICE'] as const;
export const identityConsentKindSchema = z.enum(IDENTITY_CONSENT_KINDS);
export type IdentityConsentKind = z.infer<typeof identityConsentKindSchema>;

export const IDENTITY_CONSENT_SUBJECTS = ['SELF', 'AUTHORIZED_OTHER'] as const;
export const identityConsentSubjectSchema = z.enum(IDENTITY_CONSENT_SUBJECTS);

export const IDENTITY_CONSENT_STATEMENT_VERSION = 'v6-7.1';

/** 授权声明（中英文同义；记录里存所用语言的文本哈希） */
export const IDENTITY_CONSENT_STATEMENTS = {
  LIKENESS: {
    'zh-CN': '我确认：这张照片里的人是我本人，或我已获得本人明确授权。我同意在我明确要求时，用它生成数字人出镜画面；生成的画面只放进我的作品里，我可以随时撤回授权，撤回后不再生成。',
    en: 'I confirm that the person in this photo is me, or that I have their explicit permission. I agree that it may be used to generate on-camera digital-human footage when I explicitly ask for it; the footage only goes into my own projects, and I can withdraw this consent at any time, after which nothing more is generated.',
  },
  VOICE: {
    'zh-CN': '我确认：这段声音是我本人的，或我已获得本人明确授权。我同意在我明确要求时，用它合成这个声音说的话；合成的声音只放进我的作品里，我可以随时撤回授权，撤回后不再合成。',
    en: 'I confirm that this voice is mine, or that I have the speaker\'s explicit permission. I agree that it may be used to synthesize speech in this voice when I explicitly ask for it; the speech only goes into my own projects, and I can withdraw this consent at any time, after which nothing more is synthesized.',
  },
} as const satisfies Record<IdentityConsentKind, { 'zh-CN': string; en: string }>;

export const identityConsentLocaleSchema = z.enum(['zh-CN', 'en']);

export const identityConsentRecordSchema = z.object({
  id: opaqueIdSchema,
  kind: identityConsentKindSchema,
  action: z.enum(['GRANT', 'REVOKE']),
  subject: identityConsentSubjectSchema.nullable(),
  statementVersion: z.string(),
  locale: identityConsentLocaleSchema.nullable(),
  statementSha256: z.string().nullable(),
  actorId: z.string().nullable(),
  createdAt: z.string(),
}).strict();
export type IdentityConsentRecord = z.infer<typeof identityConsentRecordSchema>;

export const identityReferenceSchema = z.object({
  kind: identityConsentKindSchema,
  assetId: opaqueIdSchema,
  footageId: opaqueIdSchema,
  filename: z.string(),
  mimeType: z.string(),
  durationMs: z.number().int().nonnegative().nullable(),
  addedAt: z.string(),
}).strict();
export type IdentityReference = z.infer<typeof identityReferenceSchema>;

const identityPartSchema = z.object({
  reference: identityReferenceSchema.nullable(),
  /** 当前有效的授权（最近一条记录是授权）；没有或已撤回为 null */
  consent: z.object({ subject: identityConsentSubjectSchema, statementVersion: z.string(), grantedAt: z.string() }).strict().nullable(),
  /** 可以用来生成：有参考素材且授权有效 */
  ready: z.boolean(),
}).strict();

export const identityProfileSchema = z.object({
  id: opaqueIdSchema,
  name: z.string(),
  likeness: identityPartSchema,
  voice: identityPartSchema,
  /** 授权记录（新的在前，最多 50 条） */
  history: z.array(identityConsentRecordSchema),
  createdAt: z.string(),
}).strict();
export type IdentityProfile = z.infer<typeof identityProfileSchema>;

export const createIdentityProfileRequestSchema = z.object({ name: z.string().trim().min(1).max(80) }).strict();
export type CreateIdentityProfileRequest = z.infer<typeof createIdentityProfileRequestSchema>;

export const setIdentityReferenceRequestSchema = z.object({ kind: identityConsentKindSchema, assetId: opaqueIdSchema }).strict();
export type SetIdentityReferenceRequest = z.infer<typeof setIdentityReferenceRequestSchema>;

export const grantIdentityConsentRequestSchema = z.object({
  kind: identityConsentKindSchema,
  subject: identityConsentSubjectSchema,
  /** 必须是当前声明版本（界面展示的就是这一版） */
  statementVersion: z.string().min(1).max(40),
  locale: identityConsentLocaleSchema,
}).strict();
export type GrantIdentityConsentRequest = z.infer<typeof grantIdentityConsentRequestSchema>;

export const revokeIdentityConsentRequestSchema = z.object({ kind: identityConsentKindSchema }).strict();
export type RevokeIdentityConsentRequest = z.infer<typeof revokeIdentityConsentRequestSchema>;

export const IDENTITY_PROFILE_ERROR_REASONS = {
  NOT_FOUND: 'IDENTITY_NOT_FOUND',
  STATEMENT_OUTDATED: 'IDENTITY_STATEMENT_OUTDATED',
  REFERENCE_INVALID: 'IDENTITY_REFERENCE_INVALID',
  NOT_GRANTED: 'IDENTITY_CONSENT_NOT_GRANTED',
} as const;

/** 参考素材允许的类型：形象 = 照片；声音 = 音频 */
export const IDENTITY_REFERENCE_MIME_PREFIX = { LIKENESS: 'image/', VOICE: 'audio/' } as const satisfies Record<IdentityConsentKind, string>;
