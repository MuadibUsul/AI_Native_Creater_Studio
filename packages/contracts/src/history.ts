import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';
import { revisionSchema } from './common/revision.js';
import { sceneGraphSchema } from './scene-graph.js';
import { projectDocumentSchema } from './project-document.js';
import { objectLockSchema } from './object-locks.js';

/**
 * 编辑历史契约（规范 §23、§24 / P02-02）。
 *
 * Intent/Content History（给创作者：Undo/Restore/History 视图）与 Audit Log（给安全/企业管理）
 * 是两套数据（§24 必须分开）；本文件是前者的事件记录。
 */

export const EDIT_ACTOR_TYPES = ['USER', 'AI', 'SYSTEM'] as const;
export const EDIT_EVENT_OBJECT_KINDS = ['PROJECT', 'SCENE', 'SEQUENCE', 'TRACK', 'CLIP', 'VISUAL_OBJECT', 'EFFECT', 'ANIMATION', 'CAPTION', 'AUDIO_REGION', 'OBJECT_LOCK'] as const;
export type EditEventObjectKind = (typeof EDIT_EVENT_OBJECT_KINDS)[number];

export const editEventSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  /** 与具体 Scene 无关的操作（如 update_project）为 null */
  sceneId: z.string().nullable().default(null),
  objectKind: z.enum(EDIT_EVENT_OBJECT_KINDS).nullable().default(null),
  objectId: z.string().nullable().default(null),
  actorType: z.enum(EDIT_ACTOR_TYPES),
  actorId: z.string().nullable().default(null),
  /** 操作类型（编辑注册表操作名的大写形式，如 UPDATE_SCENE / UPDATE_CLIP） */
  action: z.string().min(1),
  /** 用户/AI 的自然语言意图（可空；History UI 展示用，§5.7） */
  intentText: z.string().nullable().default(null),
  /** 操作补丁（显式操作对象本身；不是任意数据库补丁，§4.6） */
  patch: z.record(z.string(), z.unknown()),
  /** 该请求携带的基础 revision 与落库后的结果 revision */
  baseRevision: revisionSchema,
  resultRevision: revisionSchema,
  /** 补偿事件指向被补偿的原事件（Undo/Redo 链路，§4.8） */
  compensatesEventId: z.string().nullable().default(null),
  createdAt: isoDateTimeSchema,
});

export type EditEvent = z.infer<typeof editEventSchema>;

/** ---------- 项目版本快照（§23.2 / P02-03） ---------- */

export const VERSION_REASONS = [
  'MANUAL',
  'AI_REDIRECT',
  'FINAL_RENDER',
  'PUBLISH',
  'AUTO_EVERY_N_EVENTS',
  'RESTORE',
] as const;

export const versionReasonSchema = z.enum(VERSION_REASONS);
export type VersionReason = z.infer<typeof versionReasonSchema>;

/** 快照内容：场景图 + 元信息（脚本/身份的独立快照随 P04/P06 增补字段） */
export const projectVersionSnapshotSchema = z.object({
  schemaVersion: z.string().min(1),
  graph: sceneGraphSchema,
  document: projectDocumentSchema.optional(),
  locks: z.array(objectLockSchema).default([]),
  meta: z.record(z.string(), z.unknown()).default({}),
});

export type ProjectVersionSnapshot = z.infer<typeof projectVersionSnapshotSchema>;

/** 版本摘要（列表与创建响应；快照本体见详情） */
export const projectVersionSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  versionNumber: z.number().int().positive(),
  reason: versionReasonSchema,
  note: z.string().nullable().default(null),
  createdBy: z.string().nullable().default(null),
  createdAt: isoDateTimeSchema,
  /** 快照内场景数（列表展示用） */
  sceneCount: z.number().int().nonnegative(),
});

export type ProjectVersion = z.infer<typeof projectVersionSchema>;

export const projectVersionDetailSchema = projectVersionSchema.extend({
  snapshot: projectVersionSnapshotSchema,
});

export type ProjectVersionDetail = z.infer<typeof projectVersionDetailSchema>;

/** 手动/程序化建立版本；AUTO_EVERY_N_EVENTS 与 RESTORE 由系统产生 */
export const createProjectVersionRequestSchema = z.object({
  reason: z.enum(['MANUAL', 'AI_REDIRECT', 'FINAL_RENDER', 'PUBLISH']),
  note: z.string().max(200).optional(),
});
