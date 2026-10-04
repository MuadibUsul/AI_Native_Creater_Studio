import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces.js';
import { projects, scenes } from './projects.js';

/**
 * Custom Motion 组件与版本（P07-02 / 规范 §11.2）。
 *
 * - **仅 APPROVED 落库**：四道门禁（静态分析/类型检查/沙箱评估/抽帧）任一失败 → 无行、无对象
 *   （"失败不能进入项目"；拒绝细节留在任务错误中，不污染项目资产）；
 * - 版本不可变（append-only）：同组件再次生成 → 新版本行（latest_version_number 指向最新）；
 * - 代码/抽帧证据落自有存储（只存 storage_key + sha256，§75 第 5 条）；
 * - deps/input/validation 以 JSONB 整体消费（依赖集合 = 白名单子集；input = LLM 看到的上下文）。
 */

export const customMotionComponents = pgTable(
  'custom_motion_components',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sceneId: text('scene_id')
      .notNull()
      .references(() => scenes.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    latestVersionNumber: integer('latest_version_number').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('custom_motion_components_project_idx').on(table.projectId, table.createdAt),
    index('custom_motion_components_scene_idx').on(table.sceneId),
  ],
);

export const customMotionComponentVersions = pgTable(
  'custom_motion_component_versions',
  {
    id: text('id').primaryKey(),
    componentId: text('component_id')
      .notNull()
      .references(() => customMotionComponents.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    versionNumber: integer('version_number').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    code: text('code').notNull(),
    codeSha256: text('code_sha256').notNull(),
    /** 依赖集合（V1 = 空集；白名单见 contracts MOTION_DEPENDENCY_WHITELIST） */
    dependencies: jsonb('dependencies').notNull().default([]),
    /** 生成输入（LLM 所见上下文：场景/时长/画幅/主题/fixture/brief/promptVersion/llmModel） */
    input: jsonb('input').notNull(),
    /** 四道门禁的完整报告（APPROVED 才落库，report.verdict 必为 APPROVED） */
    validation: jsonb('validation').notNull(),
    sourceStorageKey: text('source_storage_key').notNull(),
    framesStorageKey: text('frames_storage_key').notNull(),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('custom_motion_component_versions_uq').on(table.componentId, table.versionNumber),
    index('custom_motion_component_versions_ws_idx').on(table.workspaceId, table.createdAt),
  ],
);
