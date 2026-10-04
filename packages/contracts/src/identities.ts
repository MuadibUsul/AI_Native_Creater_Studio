import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';
import { themeTokensSchema } from './theme.js';

/**
 * Creator Identity 契约（规范 §6.1 / P01-04）。
 *
 * 拆分：CreatorIdentity { AvatarIdentity, VoiceIdentity, BrandIdentity, PresenterStyle }。
 * 说明：PresenterStyle（"怎么说"）由 SpeechProfile（§6.4）表达，与 Brand 主题共同
 * 构成呈现风格；不单独建表，避免同一语义两处维护。
 * 版本：各子身份拥有独立 version（更新即 +1）；历史 Project/Manifest 记录
 * id+version（见 SceneGraph identitySnapshot）；Provider 资产退役后的重渲染限制按 §6.1 处理。
 */

export const IDENTITY_STATUSES = ['ACTIVE', 'RETIRED'] as const;

export const avatarIdentitySchema = z.object({
  id: opaqueIdSchema,
  creatorIdentityId: opaqueIdSchema,
  version: z.number().int().positive(),
  provider: z.string().nullable(),
  providerAvatarId: z.string().nullable(),
  /** Provider 账号范围 / 凭据引用（不保存明文凭据，§17.3） */
  providerAccountScope: z.string().nullable(),
  displayName: z.string().nullable(),
  status: z.enum(IDENTITY_STATUSES),
  /** consent / ownership 元数据（§20.3、§95） */
  consentMetadata: z.record(z.string(), z.unknown()),
  /** Provider 支持时的默认形象/动作配置 */
  defaultLook: z.record(z.string(), z.unknown()),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  retiredAt: isoDateTimeSchema.nullable(),
});

export const VOICE_CLONE_TYPES = ['INSTANT', 'PROFESSIONAL', 'PROVIDER_NATIVE', 'PUBLIC'] as const;
export const VOICE_OWNERSHIP_TYPES = ['SELF_VERIFIED', 'SHARED_LICENSED', 'PLATFORM_PUBLIC'] as const;
export const VOICE_MANAGED_MODES = ['PLATFORM_MANAGED', 'BYOK'] as const;

export const voiceIdentitySchema = z.object({
  id: opaqueIdSchema,
  creatorIdentityId: opaqueIdSchema,
  version: z.number().int().positive(),
  provider: z.string().nullable(),
  providerVoiceId: z.string().nullable(),
  cloneType: z.enum(VOICE_CLONE_TYPES).nullable(),
  ownershipType: z.enum(VOICE_OWNERSHIP_TYPES).nullable(),
  /** Provider 要求本人验证时的验证状态（§95：必须保留） */
  verificationStatus: z.string().nullable(),
  managedMode: z.enum(VOICE_MANAGED_MODES).nullable(),
  languageProfile: z.string().nullable(),
  defaultSpeechProfileId: z.string().nullable(),
  status: z.enum(IDENTITY_STATUSES),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  retiredAt: isoDateTimeSchema.nullable(),
});

export const brandIdentitySchema = z.object({
  id: opaqueIdSchema,
  creatorIdentityId: opaqueIdSchema,
  version: z.number().int().positive(),
  name: z.string().min(1),
  themeTokens: themeTokensSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export const creatorIdentitySchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  displayName: z.string().min(1).max(80),
  avatarIdentity: avatarIdentitySchema.nullable(),
  voiceIdentity: voiceIdentitySchema.nullable(),
  brandIdentity: brandIdentitySchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export type AvatarIdentity = z.infer<typeof avatarIdentitySchema>;
export type VoiceIdentity = z.infer<typeof voiceIdentitySchema>;
export type BrandIdentity = z.infer<typeof brandIdentitySchema>;
export type CreatorIdentity = z.infer<typeof creatorIdentitySchema>;

export const createCreatorIdentityRequestSchema = z.object({
  displayName: z.string().min(1).max(80),
});

/** 子身份 upsert：提供即整段替换并 version+1（版本语义见文件头注释）。 */
export const avatarIdentityUpsertSchema = z.object({
  provider: z.string().min(1).nullable().default(null),
  providerAvatarId: z.string().min(1).nullable().default(null),
  providerAccountScope: z.string().min(1).nullable().default(null),
  displayName: z.string().min(1).nullable().default(null),
  status: z.enum(IDENTITY_STATUSES).default('ACTIVE'),
  consentMetadata: z.record(z.string(), z.unknown()).default({}),
  defaultLook: z.record(z.string(), z.unknown()).default({}),
});

export const voiceIdentityUpsertSchema = z.object({
  provider: z.string().min(1).nullable().default(null),
  providerVoiceId: z.string().min(1).nullable().default(null),
  cloneType: z.enum(VOICE_CLONE_TYPES).nullable().default(null),
  ownershipType: z.enum(VOICE_OWNERSHIP_TYPES).nullable().default(null),
  verificationStatus: z.string().min(1).nullable().default(null),
  managedMode: z.enum(VOICE_MANAGED_MODES).nullable().default(null),
  languageProfile: z.string().min(1).nullable().default(null),
  defaultSpeechProfileId: z.string().min(1).nullable().default(null),
  status: z.enum(IDENTITY_STATUSES).default('ACTIVE'),
});

export const brandIdentityUpsertSchema = z.object({
  name: z.string().min(1).max(80),
  themeTokens: themeTokensSchema,
});

export const updateCreatorIdentityRequestSchema = z.object({
  displayName: z.string().min(1).max(80).optional(),
  avatarIdentity: avatarIdentityUpsertSchema.optional(),
  voiceIdentity: voiceIdentityUpsertSchema.optional(),
  brandIdentity: brandIdentityUpsertSchema.optional(),
});

export type CreateCreatorIdentityRequest = z.infer<typeof createCreatorIdentityRequestSchema>;
export type UpdateCreatorIdentityRequest = z.infer<typeof updateCreatorIdentityRequestSchema>;
