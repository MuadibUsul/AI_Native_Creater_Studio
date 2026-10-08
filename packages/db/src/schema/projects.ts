import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { channelStyleVersions, channels } from './creator.js';
import { workspaces } from './workspaces.js';

const LEGACY_PROJECT_POLICY_DEFAULT = {
  mode: 'GENERATIVE',
  allowGeneratedVideo: true,
  allowGeneratedImage: true,
  allowGeneratedSpeech: true,
  allowVoiceReplacement: false,
  allowScriptRewrite: true,
  allowGeneratedMusic: true,
  allowGeneratedSfx: true,
  allowProceduralGraphics: true,
  allowCaptions: true,
  allowGenerativeFill: true,
  allowFrameInterpolation: true,
  allowExternalStock: true,
  allowExternalAnalysis: true,
  preserveOriginalSpeech: false,
  preserveOriginalChronology: false,
  allowedProviderIds: [],
  privacyClass: 'STANDARD',
  perProposalBudgetCredits: null,
  projectBudgetCredits: null,
};

/**
 * Project / Scene 规范化表（P02-01 / 规范 §22.3、§22.4；计划 §4.3 不变量 1—3）。
 *
 * - 所有记录携带 workspace_id（不变量 1）；
 * - Project 通过 channel_style_version_id 冻结创建时的样式快照（P01-04 义务）；
 * - Scene 有独立记录与 revision，不允许"一个大 JSON 作为唯一状态"（不变量 3）；
 * - current_version_id 的 FK 在 P02-03 建立 project_versions 后补挂（TODO 注释见字段）。
 */

export const projects = pgTable(
  'projects',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    channelId: text('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'restrict' }),
    /** 创建时冻结的样式快照（旧项目不因 Channel 后续修改而改变） */
    channelStyleVersionId: text('channel_style_version_id')
      .notNull()
      .references(() => channelStyleVersions.id, { onDelete: 'restrict' }),
    title: text('title').notNull(),
    sourceType: text('source_type').notNull().default('MANUAL_SCRIPT'),
    status: text('status').notNull().default('DRAFT'),
    /** 聚合 revision（任何编辑 +1；场景编辑协议 P02-02 以此做乐观并发） */
    revision: integer('revision').notNull().default(1),
    aspectRatio: text('aspect_ratio').notNull(),
    resolution: text('resolution').notNull(),
    fps: integer('fps').notNull().default(30),
    targetDurationMs: integer('target_duration_ms'),
    /** N01-02: ProjectDocument metadata stays on the normalized project aggregate. */
    documentSchemaVersion: text('document_schema_version').notNull().default('1.0'),
    brief: jsonb('brief').notNull().default({}),
    productionPolicy: jsonb('production_policy').notNull().default(LEGACY_PROJECT_POLICY_DEFAULT),
    /**
     * 当前项目版本（P02-03 起：指向不可变快照；restore 只产生新版本，不改写旧版本）。
     * 有意不建立指向 project_versions 的 FK：与 project_versions.project_id 的 FK 形成
     * 类型循环（两张表的行类型互相引用会坍缩）；版本行不可变、不会单独删除，
     * 其级联删除由 project_versions.project_id → projects 一侧负责。
     */
    currentVersionId: text('current_version_id'),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Trash 软删（保留策略与清理 Worker 见 P02-05） */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('projects_workspace_idx').on(table.workspaceId),
    index('projects_channel_idx').on(table.channelId),
  ],
);

/**
 * 项目版本快照（P02-03 / 规范 §23.2）：
 * 版本行**不可变**；快照在自动时机（AI 重编导前、Final/Publish、手动、每 N 编辑事件）建立；
 * Restore 从快照构建新的当前状态（不回拨 revision、不改写旧版本与历史事件）。
 */
export const projectVersions = pgTable(
  'project_versions',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    versionNumber: integer('version_number').notNull(),
    /** 快照内容：{ schemaVersion, graph, meta } */
    snapshot: jsonb('snapshot').notNull(),
    /** MANUAL / AI_REDIRECT / FINAL_RENDER / PUBLISH / AUTO_EVERY_N_EVENTS */
    reason: text('reason').notNull(),
    note: text('note'),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('project_versions_project_version_uq').on(table.projectId, table.versionNumber),
    index('project_versions_project_idx').on(table.projectId, table.createdAt),
  ],
);

export const scenes = pgTable(
  'scenes',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull().default(1),
    position: integer('position').notNull(),
    startMs: integer('start_ms').notNull(),
    durationMs: integer('duration_ms').notNull(),
    semanticType: text('semantic_type').notNull(),
    sceneType: text('scene_type').notNull(),
    narrationBlockIds: jsonb('narration_block_ids').notNull().default([]),
    narration: text('narration').notNull().default(''),
    visualIntent: text('visual_intent').notNull().default(''),
    componentId: text('component_id'),
    componentVersion: text('component_version'),
    props: jsonb('props').notNull().default({}),
    providerRequirement: jsonb('provider_requirement'),
    sourceBindings: jsonb('source_bindings').notNull().default([]),
    dataBindings: jsonb('data_bindings').notNull().default([]),
    assetBindings: jsonb('asset_bindings').notNull().default([]),
    transition: jsonb('transition').notNull().default({ in: null, out: null }),
    locked: boolean('locked').notNull().default(false),
    approved: boolean('approved').notNull().default(false),
    needsReview: boolean('needs_review').notNull().default(false),
    status: text('status').notNull().default('EMPTY'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('scenes_project_position_idx').on(table.projectId, table.position),
    index('scenes_workspace_idx').on(table.workspaceId),
  ],
);
