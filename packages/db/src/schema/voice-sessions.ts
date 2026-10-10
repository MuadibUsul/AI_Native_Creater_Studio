import { index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { projects } from './projects.js';
import { workspaces } from './workspaces.js';

/**
 * N05-01 实时语音会话（短期凭证 + 流式协议状态）。
 *
 * - 会话是**短期**的（TTL），只持有短期凭证与流式状态；长期 Provider Key 永不入库于客户端，也不下发给浏览器；
 * - `generation` 提供代际隔离：旧代际/已撤销/过期会话的晚到事件一律拒绝；
 * - `transcriptDraft` / `utterances` 只存**预备或已封存**的转写修订：partial 属于只读预备，
 *   不写 `edit_events`、不推进工程 revision；封存后的 IntentRevision 才进入正式编辑。
 */
export const voiceSessions = pgTable(
  'voice_sessions',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    actorId: text('actor_id'),
    selectionAnchorId: text('selection_anchor_id'),
    status: text('status').notNull(),
    generation: integer('generation').notNull(),
    clockEpoch: integer('clock_epoch').notNull(),
    capabilities: jsonb('capabilities').notNull(),
    transport: text('transport').notNull(),
    credentialFingerprint: text('credential_fingerprint').notNull(),
    /** 转写修订（按 utteranceId 组织；partial 可被后续修订取代） */
    transcriptDraft: jsonb('transcript_draft').notNull().default([]),
    /** 已封存的 IntentRevision（送 planRangeEdit 的唯一入口） */
    utterances: jsonb('utterances').notNull().default([]),
    /** 已接受事件的最大序号（会话流内有序；跨连接不推导全局顺序） */
    lastEventSeq: integer('last_event_seq').notNull().default(0),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('voice_sessions_scope_idx').on(table.workspaceId, table.projectId, table.status),
    index('voice_sessions_actor_idx').on(table.actorId, table.issuedAt),
  ],
);
