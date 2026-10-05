import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';

/**
 * Content Core 契约（P11-01 / 规范 §92—93；计划 §8）。
 *
 * 迁移纪律（验收："旧项目迁移前后来源与关键事实一致，保留原文档"）：
 * - **派生而非改写**：核心模型从既有 ContentDocument/claims/project_sources **1:1 映射**——
 *   不推断关系、不编造论点（relations 迁移为空并注明；thesis 缺失即为 null）；
 * - **原文档保留**：迁移只读旧结构并追加核心行——原文档/声明/来源零改动；
 * - **一致性可核对**：`consistency` 记录迁移前计数与**输入摘要 `inputsDigest`**（canonical JSON 的 sha256）——
 *   重跑摘要一致 → **幂等复用**（不产生第二份核心）；不一致（旧数据变了）→ 生成新核心版本行；
 * - 迁移记录含**迁移前后计数对照**（验收证据直接引用）。
 */

export const CONTENT_CORE_VERSION = 'content-core-v1' as const;

/** 声明（1:1 映射自 claims 表；不改写文本/事实性/来源引用） */
export const coreClaimSchema = z.object({
  claimId: opaqueIdSchema,
  documentId: opaqueIdSchema.nullable(),
  blockId: opaqueIdSchema.nullable(),
  text: z.string().min(1),
  factuality: z.enum(['fact', 'analysis', 'opinion', 'uncertain']),
  sourceIds: z.array(opaqueIdSchema),
  extractionMethod: z.enum(['DETERMINISTIC', 'LLM', 'MANUAL']).nullable(),
});

export type CoreClaim = z.infer<typeof coreClaimSchema>;

/** 事实 = factuality === 'fact' 的声明（**不新增、不改写**——事实即已核实声明的投影） */
export const coreFactSchema = z.object({
  factId: opaqueIdSchema,
  claimId: opaqueIdSchema,
  text: z.string().min(1),
  sourceIds: z.array(opaqueIdSchema),
});

export type CoreFact = z.infer<typeof coreFactSchema>;

/** 关系（迁移**不推断**——恒空数组并注明；关系编辑属后续任务） */
export const coreRelationSchema = z.object({
  fromClaimId: opaqueIdSchema,
  toClaimId: opaqueIdSchema,
  kind: z.enum(['SUPPORTS', 'CONTRADICTS', 'RELATED']),
});

export type CoreRelation = z.infer<typeof coreRelationSchema>;

/** 证据 = 来源快照（1:1 映射自 project_sources；URL 为来源出处——非平台产物地址） */
export const coreEvidenceSchema = z.object({
  sourceId: opaqueIdSchema,
  title: z.string().min(1).max(500),
  url: z.string().max(1000),
  publisher: z.string().max(200),
  excerpt: z.string().max(500),
  snapshotKind: z.string().min(1).max(40),
  /** 引用该来源的声明数（迁移时计数；可核对） */
  referencedByClaims: z.number().int().nonnegative(),
});

export type CoreEvidence = z.infer<typeof coreEvidenceSchema>;

/** 原文档引用（**保留原文档**——核心只记引用与摘要，不复制正文） */
export const coreDocumentRefSchema = z.object({
  documentId: opaqueIdSchema,
  title: z.string().min(1).max(300),
  sourceType: z.string().min(1).max(40),
  blockCount: z.number().int().nonnegative(),
  claimCount: z.number().int().nonnegative(),
});

export type CoreDocumentRef = z.infer<typeof coreDocumentRefSchema>;

export const contentCoreSchema = z.object({
  schemaVersion: z.literal(CONTENT_CORE_VERSION),
  projectId: opaqueIdSchema,
  /** 论点（迁移不编造：无叙事计划/显式论点时为 null + note） */
  thesis: z.object({ text: z.string().min(1).max(500), derivedFrom: z.enum(['MANUAL']) }).nullable(),
  claims: z.array(coreClaimSchema),
  facts: z.array(coreFactSchema),
  /** 迁移恒为空（不推断关系）；关系建立属后续编辑能力 */
  relations: z.array(coreRelationSchema),
  evidence: z.array(coreEvidenceSchema),
  documents: z.array(coreDocumentRefSchema),
  /** 迁移说明（如"thesis 未由迁移生成""relations 不推断"） */
  notes: z.array(z.string().max(300)),
});

export type ContentCore = z.infer<typeof contentCoreSchema>;

/** 一致性摘要（验收核对依据；inputsDigest = 迁移输入 canonical JSON 的 sha256——幂等键） */
export const contentCoreConsistencySchema = z.object({
  documentCount: z.number().int().nonnegative(),
  claimCount: z.number().int().nonnegative(),
  factCount: z.number().int().nonnegative(),
  sourceCount: z.number().int().nonnegative(),
  /** 迁移输入的 sha256（重跑一致 → 幂等复用；旧数据变化 → 生成新版本） */
  inputsDigest: z.string().regex(/^[0-9a-f]{64}$/),
  checked: z.array(z.string().max(120)),
});

export type ContentCoreConsistency = z.infer<typeof contentCoreConsistencySchema>;

/** 迁移记录（前后计数对照——验收证据） */
export const contentCoreMigrationSchema = z.object({
  core: contentCoreSchema,
  consistency: contentCoreConsistencySchema,
  /** reused = 幂等复用（输入未变，未重写） */
  reused: z.boolean(),
  migratedAt: isoDateTimeSchema,
});

export type ContentCoreMigration = z.infer<typeof contentCoreMigrationSchema>;

/** 核心读取（含原始对照计数——"迁移前后一致"的直接证据） */
export const contentCoreStateSchema = z.object({
  core: contentCoreSchema.nullable(),
  consistency: contentCoreConsistencySchema.nullable(),
  /** 当前原始侧计数（读取时实时统计——与 consistency 对照即"迁移后未漂移"） */
  liveCounts: z.object({
    documentCount: z.number().int().nonnegative(),
    claimCount: z.number().int().nonnegative(),
    sourceCount: z.number().int().nonnegative(),
  }),
  migratedAt: isoDateTimeSchema.nullable(),
});

export type ContentCoreState = z.infer<typeof contentCoreStateSchema>;

export const CONTENT_CORE_ERROR_REASONS = {
  /** 项目无任何内容文档（无可迁移对象） */
  NOTHING_TO_MIGRATE: 'NOTHING_TO_MIGRATE',
} as const;
