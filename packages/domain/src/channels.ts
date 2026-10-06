import { randomUUID } from 'node:crypto';
import type { PackPlugin } from '@ancs/contracts';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  ApiFailure,
  channelStyleDefaultsSchema,
  type ObjectStorageAdapter,
  ERROR_CODES,
  mergeChannelStyle,
  type ChannelStyleDefaults,
  type ChannelStyleVersion,
  type ChannelWithStyle,
  type CreateChannelRequest,
  type UpdateChannelRequest,
} from '@ancs/contracts';
import { channelStyleVersions, channels } from '@ancs/db';
import { assertChannelQuota } from './plans.js';
import type {
  AlignmentProvider,
  ArticleFetcher,
  AudioSynthesisAdapter,
  CredentialCipher,
  JobQueueAdapter,
  LlmAdapter,
  PlatformCredentialRegistry,
  ProviderTestHook,
  ResultFetcher,
} from '@ancs/contracts';
import type { BillingPolicy } from './billing.js';
import type { RetryPolicy } from './jobs.js';
import type { RetentionConfig } from './retention.js';

/**
 * Channel 服务（P01-04）。
 *
 * 约定：
 * - 服务层不做鉴权（由 API 的统一授权入口保证）；**所有查询强制携带 workspace_id**（§4.3 不变量 2）；
 * - 样式不可变：修改 defaults 产生新的 channel_style_versions 行；
 *   消费方（P02-01 起：创建 Project）必须快照 (channelId, styleVersion) ——
 *   这是"修改 Channel 后旧项目不变、新项目继承新默认值"的实现机制。
 */

export interface DomainDeps {
  db: NodePgDatabase;
  /** 自动快照间隔（每 N 个编辑事件，§23.2）；默认 50，测试可调小 */
  autoSnapshotEveryEvents?: number;
  /** 对象存储适配器（P02-04；接口在 contracts，实现由 API 注入，domain 不依赖 providers/*） */
  storage?: ObjectStorageAdapter;
  /** 上传意图/直传 URL 的 TTL 秒数（§26.1）；默认 15 分钟，测试可调小/构造过期 */
  uploadIntentTtlSeconds?: number;
  /** 保留策略配置（P02-05）：Trash 天数与幂等键 TTL；默认 30 天 / 24 小时 */
  retention?: RetentionConfig;
  /** 任务队列适配器（P03-01）：缺省为 DB 轮询（权威状态即队列）；Redis/BullMQ 见 providers/queue-bullmq */
  queue?: JobQueueAdapter;
  /** 重试退避策略（P03-02）：base/cap/jitter + 可注入随机源（测试确定性） */
  retryPolicy?: RetryPolicy;
  /** Pack 插件实例（P11-03；接口在 contracts，官方/测试实例由 API 装配注入） */
  packPlugins?: readonly PackPlugin[];
  /** 凭据密文服务（P03-04；接口在 contracts，实现由 API/Worker 注入，domain 不依赖 providers/*） */
  credentials?: CredentialCipher;
  /** 平台托管凭据来源（P03-04；运行时环境/KMS） */
  platformCredentials?: PlatformCredentialRegistry;
  /** Provider 连接测试钩子（P03-04/P03-07：真实适配器或 Mock） */
  providerTestHooks?: readonly ProviderTestHook[];
  /** 计费策略（P03-05；§35.2：BYOK 计费不得硬编码在 generation service） */
  billingPolicy?: BillingPolicy;
  /** 结果拉取器（P03-06）：HTTP 等 I/O 由宿主注入（apps/worker 的 HTTP 实现；测试脚本化） */
  resultFetcher?: ResultFetcher;
  /** 文章抓取器（P04-01）：URL 输入归一化的 I/O（逐跳 SSRF 校验由实现方保证） */
  articleFetcher?: ArticleFetcher;
  /** LLM 适配器（P04-03）：叙事/导演等结构化生成（真实适配器 P06-01；Mock 见 providers/mock-llm） */
  llm?: LlmAdapter;
  /** TTS 适配器（P06-03）：逐段语音合成（必须带词级时间戳或配置 aligner；Mock 见 providers/mock-tts） */
  tts?: AudioSynthesisAdapter;
  /** 强制对齐器（P06-03）：Provider 无时间戳时使用；首期不接受按字数估计（§5.1） */
  aligner?: AlignmentProvider;
}

const newId = (prefix: string): string => `${prefix}_${randomUUID()}`;

interface ChannelRow {
  id: string;
  workspaceId: string;
  name: string;
  language: string;
  currentStyleVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

interface StyleVersionRow {
  id: string;
  channelId: string;
  version: number;
  defaults: unknown;
  note: string | null;
  createdAt: Date;
}

const toStyleVersionDto = (row: StyleVersionRow): ChannelStyleVersion => ({
  id: row.id,
  channelId: row.channelId,
  version: row.version,
  defaults: channelStyleDefaultsSchema.parse(row.defaults),
  note: row.note,
  createdAt: row.createdAt.toISOString(),
});

const toChannelDto = (row: ChannelRow): Omit<ChannelWithStyle, 'styleVersion'> => ({
  id: row.id,
  name: row.name,
  language: row.language,
  currentStyleVersion: row.currentStyleVersion,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

async function loadChannelRow(
  db: NodePgDatabase,
  workspaceId: string,
  channelId: string,
): Promise<ChannelRow> {
  const rows = await db
    .select()
    .from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.workspaceId, workspaceId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'channel not found', 404);
  return row;
}

async function loadStyleVersionRow(
  db: NodePgDatabase,
  workspaceId: string,
  channelId: string,
  version: number,
): Promise<StyleVersionRow> {
  const rows = await db
    .select()
    .from(channelStyleVersions)
    .where(
      and(
        eq(channelStyleVersions.channelId, channelId),
        eq(channelStyleVersions.workspaceId, workspaceId),
        eq(channelStyleVersions.version, version),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, `channel style version ${String(version)} not found`, 404);
  return row;
}

export async function createChannel(
  deps: DomainDeps,
  input: { workspaceId: string; createdBy?: string; input: CreateChannelRequest },
): Promise<ChannelWithStyle> {
  // P09-01：栏目额度强制执行
  await assertChannelQuota(deps, { workspaceId: input.workspaceId });
  const defaults: ChannelStyleDefaults = channelStyleDefaultsSchema.parse(
    mergeChannelStyle(input.input.defaults, { language: input.input.language }),
  );
  const now = new Date();
  const channelId = newId('chn');
  const styleVersionId = newId('chs');

  await deps.db.transaction(async (tx) => {
    await tx.insert(channels).values({
      id: channelId,
      workspaceId: input.workspaceId,
      name: input.input.name,
      language: defaults.language,
      currentStyleVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(channelStyleVersions).values({
      id: styleVersionId,
      workspaceId: input.workspaceId,
      channelId,
      version: 1,
      defaults,
      note: null,
      createdBy: input.createdBy ?? null,
      createdAt: now,
    });
  });

  return {
    id: channelId,
    name: input.input.name,
    language: defaults.language,
    currentStyleVersion: 1,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    styleVersion: { id: styleVersionId, channelId, version: 1, defaults, note: null, createdAt: now.toISOString() },
  };
}

export async function getChannel(
  deps: DomainDeps,
  input: { workspaceId: string; channelId: string },
): Promise<ChannelWithStyle> {
  const row = await loadChannelRow(deps.db, input.workspaceId, input.channelId);
  const style = await loadStyleVersionRow(deps.db, input.workspaceId, input.channelId, row.currentStyleVersion);
  return { ...toChannelDto(row), styleVersion: toStyleVersionDto(style) };
}

export async function listChannels(
  deps: DomainDeps,
  input: { workspaceId: string },
): Promise<ChannelWithStyle[]> {
  const rows = await deps.db
    .select()
    .from(channels)
    .where(eq(channels.workspaceId, input.workspaceId))
    .orderBy(channels.createdAt);
  const result: ChannelWithStyle[] = [];
  for (const row of rows) {
    const style = await loadStyleVersionRow(deps.db, input.workspaceId, row.id, row.currentStyleVersion);
    result.push({ ...toChannelDto(row), styleVersion: toStyleVersionDto(style) });
  }
  return result;
}

export async function listChannelStyleVersions(
  deps: DomainDeps,
  input: { workspaceId: string; channelId: string },
): Promise<ChannelStyleVersion[]> {
  await loadChannelRow(deps.db, input.workspaceId, input.channelId);
  const rows = await deps.db
    .select()
    .from(channelStyleVersions)
    .where(
      and(eq(channelStyleVersions.channelId, input.channelId), eq(channelStyleVersions.workspaceId, input.workspaceId)),
    )
    .orderBy(desc(channelStyleVersions.version));
  return rows.map(toStyleVersionDto);
}

/** 读取指定样式版本（快照消费方使用：旧项目持有 version，永远解析到当时的内容）。 */
export async function getChannelStyleVersion(
  deps: DomainDeps,
  input: { workspaceId: string; channelId: string; version: number },
): Promise<ChannelStyleVersion> {
  await loadChannelRow(deps.db, input.workspaceId, input.channelId);
  const row = await loadStyleVersionRow(deps.db, input.workspaceId, input.channelId, input.version);
  return toStyleVersionDto(row);
}

/**
 * 更新 Channel：仅改名不产生新样式版本；提供 defaults 则生成新版本（旧版本不可变）。
 * 版本号在锁定 Channel 行的前提下递增，保证并发更新得到连续且唯一的版本序列。
 */
export async function updateChannel(
  deps: DomainDeps,
  input: { workspaceId: string; channelId: string; createdBy?: string; input: UpdateChannelRequest },
): Promise<ChannelWithStyle> {
  await loadChannelRow(deps.db, input.workspaceId, input.channelId);

  await deps.db.transaction(async (tx) => {
    await tx.execute(sql`select id from channels where id = ${input.channelId} for update`);

    const freshRows = await tx
      .select()
      .from(channels)
      .where(and(eq(channels.id, input.channelId), eq(channels.workspaceId, input.workspaceId)))
      .limit(1);
    const fresh = freshRows[0];
    if (!fresh) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'channel not found', 404);

    const now = new Date();
    let nextVersion = fresh.currentStyleVersion;

    if (input.input.defaults !== undefined) {
      const currentStyle = channelStyleDefaultsSchema.parse(
        (
          await tx
            .select({ defaults: channelStyleVersions.defaults })
            .from(channelStyleVersions)
            .where(
              and(
                eq(channelStyleVersions.channelId, input.channelId),
                eq(channelStyleVersions.version, fresh.currentStyleVersion),
              ),
            )
            .limit(1)
        )[0]?.defaults,
      );
      // 基于当前版本合并覆盖（浅合并；嵌套对象整体替换）
      const merged = channelStyleDefaultsSchema.parse({ ...currentStyle, ...input.input.defaults });
      nextVersion = fresh.currentStyleVersion + 1;
      await tx.insert(channelStyleVersions).values({
        id: newId('chs'),
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        version: nextVersion,
        defaults: merged,
        note: input.input.note ?? null,
        createdBy: input.createdBy ?? null,
        createdAt: now,
      });
    }

    await tx
      .update(channels)
      .set({
        name: input.input.name ?? fresh.name,
        currentStyleVersion: nextVersion,
        updatedAt: now,
      })
      .where(eq(channels.id, input.channelId));
  });

  return getChannel(deps, { workspaceId: input.workspaceId, channelId: input.channelId });
}
