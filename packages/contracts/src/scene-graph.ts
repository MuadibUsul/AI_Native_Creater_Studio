import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { revisionSchema } from './common/revision.js';
import { durationMsSchema, videoMsSchema } from './common/time.js';

/**
 * Scene Graph 契约（计划 §4.5 / 规范 §12）：
 * Scene Graph 是跨 Web/Desktop/Mobile 的统一数据模型，是项目视频表达的唯一 Source of Truth。
 * 数据库持久化形态见 P02-01（规范化表）；本契约定义快照（Snapshot）形态。
 */

/** Scene 生成状态（TODO(P02-01)：与资产就绪状态合并评估后定稿；先冻结最小集合） */
export const sceneStatusSchema = z.enum(['EMPTY', 'PLACEHOLDER', 'READY', 'FAILED']);

export const sceneFormatSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().int().positive(),
  aspectRatio: z.string().min(1),
});

/** 转场（TODO(P05-01)：具体转场集合随组件协议定稿；此处为开放字符串 + null） */
export const sceneTransitionSchema = z.object({
  in: z.string().nullable().default(null),
  out: z.string().nullable().default(null),
});

/**
 * Provider 需求（§4.5）：表达"需要什么能力"，不保存任何供应商请求字段。
 * capabilities 取自 Capability Registry 的词汇表（P03-03 提供版本化目录）。
 */
export const providerRequirementSchema = z.object({
  modality: z.string().min(1),
  capabilities: z.array(z.string()).default([]),
  constraints: z.record(z.string(), z.unknown()).default({}),
});

export const sourceBindingSchema = z.object({
  sourceId: opaqueIdSchema,
  datasetIds: z.array(opaqueIdSchema).default([]),
  claimIds: z.array(opaqueIdSchema).default([]),
});

export const dataBindingSchema = z.object({
  datasetId: opaqueIdSchema,
  seriesId: z.string().nullable().default(null),
  purpose: z.string().optional(),
});

export const assetBindingSchema = z.object({
  assetId: opaqueIdSchema,
  /** 例如 visual / audio / avatar / broll（TODO(P02-04)：随资产角色枚举定稿） */
  role: z.string().min(1),
});

export const sceneSchema = z.object({
  id: opaqueIdSchema,
  revision: revisionSchema,
  position: z.number().int().nonnegative(),
  startMs: videoMsSchema,
  durationMs: durationMsSchema,
  semanticType: z.string().min(1),
  sceneType: z.string().min(1),
  narrationBlockIds: z.array(opaqueIdSchema).default([]),
  narration: z.string().default(''),
  visualIntent: z.string().default(''),
  componentId: z.string().nullable().default(null),
  componentVersion: z.string().nullable().default(null),
  props: z.record(z.string(), z.unknown()).default({}),
  providerRequirement: providerRequirementSchema.nullable().default(null),
  sourceBindings: z.array(sourceBindingSchema).default([]),
  dataBindings: z.array(dataBindingSchema).default([]),
  assetBindings: z.array(assetBindingSchema).default([]),
  transition: sceneTransitionSchema,
  locked: z.boolean().default(false),
  approved: z.boolean().default(false),
  needsReview: z.boolean().default(false),
  status: sceneStatusSchema,
});

export const captionWordSchema = z.object({
  startMs: videoMsSchema,
  endMs: videoMsSchema,
  text: z.string(),
});

export const captionSchema = z.object({
  id: opaqueIdSchema,
  sceneId: opaqueIdSchema.nullable().default(null),
  startMs: videoMsSchema,
  durationMs: durationMsSchema,
  text: z.string(),
  /** 词/短语级 timing（§58） */
  words: z.array(captionWordSchema).default([]),
});

/** 音频轨（§59 MVP：旁白 + BGM + Scene 原声） */
export const AUDIO_TRACK_KINDS = ['NARRATION', 'MUSIC', 'SCENE'] as const;

export const audioTrackSchema = z.object({
  id: opaqueIdSchema,
  kind: z.enum(AUDIO_TRACK_KINDS),
  assetId: opaqueIdSchema.nullable().default(null),
  volume: z.number().min(0).max(2).default(1),
  fadeInMs: videoMsSchema.default(0),
  fadeOutMs: videoMsSchema.default(0),
  ducking: z.boolean().default(false),
});

export const overlaySchema = z.object({
  id: opaqueIdSchema,
  /** 例如 source_label / chapter_marker（TODO(P05-03)：随叠加层协议定稿） */
  kind: z.string().min(1),
  startMs: videoMsSchema,
  durationMs: durationMsSchema,
  props: z.record(z.string(), z.unknown()).default({}),
});

export const sourceReferenceSchema = z.object({
  sourceId: opaqueIdSchema,
  datasetIds: z.array(opaqueIdSchema).default([]),
});

/** Channel 快照（§4.3 不变量 8：引用必须能确定具体版本） */
export const channelSnapshotSchema = z.object({
  channelId: opaqueIdSchema,
  channelStyleVersion: z.string().min(1),
  speechProfileId: z.string().nullable().default(null),
  speechProfileVersion: z.string().nullable().default(null),
});

/** 创作者身份快照（Avatar/Voice/Brand；空表示该版本未使用对应身份） */
export const identitySnapshotSchema = z.object({
  avatarIdentityId: z.string().nullable().default(null),
  avatarIdentityVersion: z.string().nullable().default(null),
  voiceIdentityId: z.string().nullable().default(null),
  voiceIdentityVersion: z.string().nullable().default(null),
  brandIdentityId: z.string().nullable().default(null),
  brandIdentityVersion: z.string().nullable().default(null),
});

export const sceneTimelineSchema = z.object({
  durationMs: durationMsSchema,
  masterAudioAssetId: opaqueIdSchema.nullable().default(null),
});

export const sceneGraphSchema = z.object({
  /** 每种可持久化文档都带 schemaVersion（计划 §4.1） */
  schemaVersion: z.string().min(1),
  projectId: opaqueIdSchema,
  projectRevision: revisionSchema,
  channelSnapshot: channelSnapshotSchema,
  identitySnapshot: identitySnapshotSchema,
  format: sceneFormatSchema,
  timeline: sceneTimelineSchema,
  scenes: z.array(sceneSchema),
  captions: z.array(captionSchema).default([]),
  audioTracks: z.array(audioTrackSchema).default([]),
  overlays: z.array(overlaySchema).default([]),
  sourceReferences: z.array(sourceReferenceSchema).default([]),
});

export type SceneGraph = z.infer<typeof sceneGraphSchema>;
export type Scene = z.infer<typeof sceneSchema>;
export type SceneStatus = z.infer<typeof sceneStatusSchema>;
export type Caption = z.infer<typeof captionSchema>;
export type AudioTrack = z.infer<typeof audioTrackSchema>;
export type ProviderRequirement = z.infer<typeof providerRequirementSchema>;
