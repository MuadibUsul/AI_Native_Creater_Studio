import { z } from 'zod';
import { channelStyleDefaultsSchema } from './channels.js';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';
import { revisionSchema } from './common/revision.js';
import { sceneDraftSchema } from './edits.js';
import { sceneSchema } from './scene-graph.js';

/**
 * Project 契约（规范 §22.3 / 计划 §4.1、P02-01）。
 *
 * 关键语义：
 * - 所有业务记录归属 Workspace（§4.3 不变量 1）；关联引用的双方必须同 Workspace（不变量 2）；
 * - 创建 Project 必须指定 Channel，并**快照其当前样式版本**（channelStyleVersionId）——
 *   "修改 Channel 后旧项目不变、新项目继承新默认值"由此保证（P01-04 义务）。
 */

/** 项目级状态机（规范 §19.1） */
export const PROJECT_STATUSES = [
  'DRAFT',
  'SCRIPTING',
  'STORYBOARDING',
  'GENERATING_AUDIO',
  'GENERATING_ASSETS',
  'READY_FOR_REVIEW',
  'RENDER_QUEUED',
  'RENDERING',
  'READY',
  'FAILED',
  'ARCHIVED',
] as const;

export const projectStatusSchema = z.enum(PROJECT_STATUSES);
export type ProjectStatus = z.infer<typeof projectStatusSchema>;

/** 内容来源类型（§22.3 source_type；各导入方式自 P04-01 起接入） */
export const PROJECT_SOURCE_TYPES = ['URL', 'PASTED_TEXT', 'MANUAL_SCRIPT', 'FILE', 'CMS', 'API'] as const;

export const projectSourceTypeSchema = z.enum(PROJECT_SOURCE_TYPES);
export type ProjectSourceType = z.infer<typeof projectSourceTypeSchema>;

export const projectSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  channelId: opaqueIdSchema,
  title: z.string().min(1).max(200),
  sourceType: projectSourceTypeSchema,
  status: projectStatusSchema,
  /** 服务器维护的聚合 revision（任何编辑 +1，§4.1） */
  revision: revisionSchema,
  aspectRatio: z.string().min(1),
  /** 例如 "1920x1080" */
  resolution: z.string().regex(/^\d{2,5}x\d{2,5}$/, 'resolution 形如 1920x1080'),
  fps: z.number().int().positive(),
  targetDurationMs: z.number().int().positive().nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export type Project = z.infer<typeof projectSchema>;

/** 创建时冻结的 Channel 样式快照引用（消费方永远可按该版本解析，不受后续修改影响） */
export const projectChannelSnapshotSchema = z.object({
  channelId: opaqueIdSchema,
  channelStyleVersionId: opaqueIdSchema,
  styleVersion: z.number().int().positive(),
  defaults: channelStyleDefaultsSchema,
});

export type ProjectChannelSnapshot = z.infer<typeof projectChannelSnapshotSchema>;

export const projectDetailSchema = projectSchema.extend({
  channelSnapshot: projectChannelSnapshotSchema,
});

export type ProjectDetail = z.infer<typeof projectDetailSchema>;

/** 创建请求：Channel 必填；aspectRatio 可覆盖 Channel 默认（§6） */
export const createProjectRequestSchema = z.object({
  title: z.string().min(1).max(200),
  channelId: opaqueIdSchema,
  sourceType: projectSourceTypeSchema.default('MANUAL_SCRIPT'),
  /** 覆盖 Channel 的 defaultAspectRatio（可选） */
  aspectRatio: z.string().min(1).max(16).optional(),
  /** 覆盖由样式范围推导的目标时长（可选） */
  targetDurationMs: z.number().int().positive().optional(),
});

/** 客户端入参类型（z.input：带 default 的字段可省略，如 sourceType） */
export type CreateProjectRequest = z.input<typeof createProjectRequestSchema>;

/** 追加 Scene（P02-01 基础形态；统一操作协议与并发控制在 P02-02 扩展） */
export const createSceneRequestSchema = sceneDraftSchema;

/** 客户端入参类型（z.input：带 default 的字段可省略） */
export type CreateSceneRequest = z.input<typeof createSceneRequestSchema>;

/** 追加 Scene 的服务端权威结果（含更新后的 Project revision） */
export const createSceneResponseSchema = z.object({
  project: projectSchema,
  scene: sceneSchema,
});

export type CreateSceneResponse = z.infer<typeof createSceneResponseSchema>;
