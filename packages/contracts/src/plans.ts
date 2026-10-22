import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';

/**
 * 套餐与权益契约（P09-01 / 规范 §73、§35—36、§31；计划 §8 P09-01）。
 *
 * 原则（§73.1）：
 * - **软件价值与模型成本分离**：Subscription = 软件价值；AI Compute = Managed Credits 或 BYOK；
 * - **价格不得硬编码在业务逻辑中**：价格是 Plan 版本行中的**数据**（可为 null = 未定价，如内部/试用）；
 * - **版本化且不可篡改**：Plan 每次变更 = 新版本行（append-only）；Workspace 订阅引用**具体版本**——
 *   "修改套餐不篡改历史账单"（账本/订阅历史不被改写）；
 * - 所有额度**在 API 强制执行**（domain 层断言：上传/渠道/身份/BYOK/4K 渲染/Custom Motion 预算/席位/Pack）。
 */

export const PLAN_KEYS = ['FREE', 'CREATOR', 'PRO', 'STUDIO', 'ENTERPRISE'] as const;
export const planKeySchema = z.enum(PLAN_KEYS);
export type PlanKey = z.infer<typeof planKeySchema>;

/** 权益维度（§73.2）：数值上限 null = 不限；布尔 = 能力开关 */
export const planEntitlementsSchema = z.object({
  /** 团队席位（含 OWNER；null = 不限） */
  seats: z.number().int().positive().nullable().default(null),
  /** 存储上限（字节；null = 不限） */
  storageBytes: z.number().int().positive().nullable().default(null),
  maxChannels: z.number().int().positive().nullable().default(null),
  maxCreatorIdentities: z.number().int().positive().nullable().default(null),
  /** 月度 Managed Credits 授予（0 = 无；实际授予在 P09-03） */
  managedCreditsPerMonth: z.number().int().nonnegative().default(0),
  /** BYOK（自带 Provider 凭据）是否允许 */
  byok: z.boolean().default(false),
  /** 隐私模式（P09-04 完整实现；此处为权益位） */
  privacyMode: z.boolean().default(false),
  /** 4K 渲染档位（PREMIUM_4K）是否允许 */
  fourK: z.boolean().default(false),
  /** Analytics（后期） */
  analytics: z.boolean().default(false),
  /** 渲染优先级（映射到 jobs.priority；越大越先） */
  renderPriority: z.number().int().min(-100).max(100).default(0),
  /** Pack 白名单（空数组 = 仅内置；null = 全部可用） */
  packs: z.array(z.string().min(1).max(80)).nullable().default([]),
  /** Custom Motion 月度生成预算（次数；0 = 不可用；null = 不限） */
  customMotionPerMonth: z.number().int().nonnegative().nullable().default(0),
  /** Provider 高端特性白名单（如 'voice_clone_pro'；空 = 无） */
  providerPremiumFeatures: z.array(z.string().min(1).max(80)).default([]),
  /**
   * 每月 AI 模型费用上限（微美元；导演对话、审片执行、自主制作、风格撰写合计；0 = 不可用 AI）。
   * **null = 套餐不设**，按部署缺省 ANCS_AI_MONTHLY_CAP_USD（与其他维度"null = 不限"不同：防止忘记配置时无上限）。
   */
  aiSpendMicrosPerMonth: z.number().int().nonnegative().nullable().default(null),
});

export type PlanEntitlements = z.infer<typeof planEntitlementsSchema>;

export const PLAN_STATUSES = ['DRAFT', 'ACTIVE', 'RETIRED'] as const;
export const planStatusSchema = z.enum(PLAN_STATUSES);
export type PlanStatus = z.infer<typeof planStatusSchema>;

/** 价格（数据，不是业务逻辑；null = 未定价——内部/试用或由支付阶段写入） */
export const planPriceSchema = z
  .object({
    amountMinor: z.number().int().nonnegative(),
    currency: z.string().length(3),
    interval: z.enum(['MONTH', 'YEAR']),
  })
  .nullable()
  .default(null);

export const planSchema = z.object({
  id: opaqueIdSchema,
  /** Plan 代号（定价/展示稳定键） */
  planKey: planKeySchema,
  /** 版本（同 Key 内单调递增；版本行不可变） */
  version: z.number().int().positive(),
  name: z.string().min(1).max(80),
  entitlements: planEntitlementsSchema,
  price: planPriceSchema,
  status: planStatusSchema,
  note: z.string().max(300).nullable().default(null),
  createdAt: isoDateTimeSchema,
});

export type Plan = z.infer<typeof planSchema>;

export const SUBSCRIPTION_STATUSES = ['ACTIVE', 'CANCELLED'] as const;
export const subscriptionStatusSchema = z.enum(SUBSCRIPTION_STATUSES);

/** Workspace 订阅（append-only；最新 ACTIVE 为当前；supersededAt 标记被取代的历史行） */
export const workspaceSubscriptionSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  planId: opaqueIdSchema,
  planKey: planKeySchema,
  planVersion: z.number().int().positive(),
  status: subscriptionStatusSchema,
  startedAt: isoDateTimeSchema,
  /** 被后续订阅取代的时间（历史保留，不删除） */
  supersededAt: isoDateTimeSchema.nullable().default(null),
  cancelledAt: isoDateTimeSchema.nullable().default(null),
  assignedBy: z.string().nullable().default(null),
});

export type WorkspaceSubscription = z.infer<typeof workspaceSubscriptionSchema>;

/** 用量（额度执行与 UI 展示的同一口径；§36 存储用量核算） */
export const entitlementUsageSchema = z.object({
  storageBytesUsed: z.number().int().nonnegative(),
  seatsUsed: z.number().int().nonnegative(),
  channelsUsed: z.number().int().nonnegative(),
  creatorIdentitiesUsed: z.number().int().nonnegative(),
  customMotionUsedThisMonth: z.number().int().nonnegative(),
});

export type EntitlementUsage = z.infer<typeof entitlementUsageSchema>;

/**
 * 超额维度（P09-04 "降级套餐有清晰超额处理"）：用量 > 上限时进入本清单。
 * 语义：**新增被阻止**（额度断言）、**现有成员/数据保留**、档位不静默改写——
 * 界面明确提示"升级或显式调整"；系统绝不自动删除成员或数据。
 */
export const OVER_COMMITTED_DIMENSIONS = [
  'seats',
  'storageBytes',
  'maxChannels',
  'maxCreatorIdentities',
  'customMotionPerMonth',
  /** 隐私档位高于套餐权益（privacyMode=false 时启用 PRIVATE/ENTERPRISE） */
  'privacyMode',
] as const;

export const overCommittedDimensionSchema = z.enum(OVER_COMMITTED_DIMENSIONS);
export type OverCommittedDimension = z.infer<typeof overCommittedDimensionSchema>;

export const workspaceEntitlementSchema = z.object({
  workspaceId: opaqueIdSchema,
  /** 当前生效的 Plan 版本（workspace 无订阅 = 默认 FREE 版本） */
  plan: planSchema,
  entitlements: planEntitlementsSchema,
  usage: entitlementUsageSchema,
  /** 由订阅或默认 FREE 解析 */
  source: z.enum(['SUBSCRIPTION', 'DEFAULT_FREE']),
  /** 超额维度（降级后可能非空；新增被阻止、存量保留——见 OVER_COMMITTED_DIMENSIONS） */
  overCommitted: z.array(overCommittedDimensionSchema).default([]),
});

export type WorkspaceEntitlement = z.infer<typeof workspaceEntitlementSchema>;

export const ENTITLEMENT_ERROR_REASONS = {
  STORAGE_QUOTA_EXCEEDED: 'STORAGE_QUOTA_EXCEEDED',
  SEATS_EXCEEDED: 'SEATS_EXCEEDED',
  CHANNELS_EXCEEDED: 'CHANNELS_EXCEEDED',
  IDENTITIES_EXCEEDED: 'IDENTITIES_EXCEEDED',
  BYOK_NOT_ALLOWED: 'BYOK_NOT_ALLOWED',
  RENDER_PROFILE_NOT_ALLOWED: 'RENDER_PROFILE_NOT_ALLOWED',
  PACK_NOT_ENABLED: 'PACK_NOT_ENABLED',
  CUSTOM_MOTION_BUDGET_EXCEEDED: 'CUSTOM_MOTION_BUDGET_EXCEEDED',
  PRIVACY_MODE_NOT_ALLOWED: 'PRIVACY_MODE_NOT_ALLOWED',
} as const;

export type EntitlementErrorReason = (typeof ENTITLEMENT_ERROR_REASONS)[keyof typeof ENTITLEMENT_ERROR_REASONS];

export const assignPlanRequestSchema = z.object({
  planKey: planKeySchema,
  note: z.string().max(300).optional(),
});

export type AssignPlanRequest = z.input<typeof assignPlanRequestSchema>;

export const createPlanVersionRequestSchema = z.object({
  planKey: planKeySchema,
  name: z.string().min(1).max(80),
  entitlements: planEntitlementsSchema,
  price: planPriceSchema.optional(),
  status: planStatusSchema.default('ACTIVE'),
  note: z.string().max(300).optional(),
});

export type CreatePlanVersionRequest = z.input<typeof createPlanVersionRequestSchema>;

/**
 * 默认套餐种子（**数据**，非业务硬编码价格：price 一律 null；版本 1）。
 * 仅供 ensureDefaultPlans 首次播种与测试；运营可在不改代码的情况下追加新版本（版本化）。
 */
export const DEFAULT_PLAN_SEEDS: readonly { planKey: PlanKey; name: string; entitlements: PlanEntitlements }[] = [
  {
    planKey: 'FREE',
    name: 'Free / Trial',
    entitlements: planEntitlementsSchema.parse({
      seats: 1,
      storageBytes: 2 * 1024 * 1024 * 1024,
      maxChannels: 1,
      maxCreatorIdentities: 1,
      managedCreditsPerMonth: 0,
      byok: false,
      privacyMode: false,
      fourK: false,
      analytics: false,
      renderPriority: 0,
      packs: [],
      customMotionPerMonth: 0,
      providerPremiumFeatures: [],
    }),
  },
  {
    planKey: 'CREATOR',
    name: 'Creator',
    entitlements: planEntitlementsSchema.parse({
      seats: 1,
      storageBytes: 50 * 1024 * 1024 * 1024,
      maxChannels: 3,
      maxCreatorIdentities: 3,
      managedCreditsPerMonth: 0,
      byok: false,
      renderPriority: 10,
      packs: [],
      customMotionPerMonth: 20,
    }),
  },
  {
    planKey: 'PRO',
    name: 'Pro',
    entitlements: planEntitlementsSchema.parse({
      seats: 3,
      storageBytes: 250 * 1024 * 1024 * 1024,
      maxChannels: 10,
      maxCreatorIdentities: 10,
      managedCreditsPerMonth: 0,
      byok: true,
      privacyMode: false,
      fourK: true,
      renderPriority: 20,
      packs: [],
      customMotionPerMonth: 100,
    }),
  },
  {
    planKey: 'STUDIO',
    name: 'Studio',
    entitlements: planEntitlementsSchema.parse({
      seats: 10,
      storageBytes: 1024 * 1024 * 1024 * 1024,
      maxChannels: 50,
      maxCreatorIdentities: 50,
      managedCreditsPerMonth: 0,
      byok: true,
      privacyMode: true,
      fourK: true,
      analytics: true,
      renderPriority: 40,
      packs: null,
      customMotionPerMonth: 500,
    }),
  },
  {
    planKey: 'ENTERPRISE',
    name: 'Enterprise',
    entitlements: planEntitlementsSchema.parse({
      seats: null,
      storageBytes: null,
      maxChannels: null,
      maxCreatorIdentities: null,
      managedCreditsPerMonth: 0,
      byok: true,
      privacyMode: true,
      fourK: true,
      analytics: true,
      renderPriority: 60,
      packs: null,
      customMotionPerMonth: null,
    }),
  },
];
