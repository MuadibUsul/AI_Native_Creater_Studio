import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';
import { revisionSchema } from './common/revision.js';

/**
 * 编辑历史契约（规范 §23、§24 / P02-02）。
 *
 * Intent/Content History（给创作者：Undo/Restore/History 视图）与 Audit Log（给安全/企业管理）
 * 是两套数据（§24 必须分开）；本文件是前者的事件记录。
 */

export const EDIT_ACTOR_TYPES = ['USER', 'AI', 'SYSTEM'] as const;

export const editEventSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  /** 与具体 Scene 无关的操作（如 update_project）为 null */
  sceneId: z.string().nullable().default(null),
  actorType: z.enum(EDIT_ACTOR_TYPES),
  actorId: z.string().nullable().default(null),
  /** 操作类型（§4.6 的 14 种操作名，大写形式，如 UPDATE_SCENE） */
  action: z.string().min(1),
  /** 用户/AI 的自然语言意图（可空；History UI 展示用，§5.7） */
  intentText: z.string().nullable().default(null),
  /** 操作补丁（显式操作对象本身；不是任意数据库补丁，§4.6） */
  patch: z.record(z.string(), z.unknown()),
  /** 该请求携带的基础 revision 与落库后的结果 revision */
  baseRevision: revisionSchema,
  resultRevision: revisionSchema,
  createdAt: isoDateTimeSchema,
});

export type EditEvent = z.infer<typeof editEventSchema>;
