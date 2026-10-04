import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { durationMsSchema, isoDateTimeSchema, videoMsSchema } from './common/time.js';
import { renderProfileSchema } from './render.js';
import { captionStyleSchema, gainKeyframeSchema } from './mixdown.js';
import { themeTokensSchema } from './theme.js';

/**
 * Final 合成执行契约（P07-04 / 规范 §28、§39、§58、§86；计划 §8 P07-04）。
 *
 * 分工（§39）：
 * - **domain 构建** spec（纯投影：快照 graph + Master Narration + 冻结资产版本清单），不触渲染栈；
 * - **render-worker 执行**（`RenderExecutor` 实现）：Remotion 服务端渲染（画面 + 音频轨 + 字幕烧录）
 *   → 产物 final.mp4 / subtitles.srt / subtitles.vtt / manifest.json；
 * - 产物经自有存储落库（Asset=SYSTEM_RENDER；MP4/字幕/清单分别入库），manifest_hash = manifest.json 字节的 SHA-256
 *   （QA/P07-06 以字节复核，无 canonical JSON 歧义）。
 *
 * 纪律：
 * - spec 只引用**不可变对象**（版本 id / 资产版本 id / Master Narration id），无"当前状态"指针；
 * - 组件不得访问网络/凭据（素材由执行器落到静态服务目录，组件只消费同源 URL）；
 * - 音频：旁白唯一来源 = Master Narration（§59 无重叠双人声）；BGM 增益包络来自 P06-06 混音计划。
 */

export const RENDER_EXECUTION_SPEC_VERSION = 'render-exec-v1';
export const RENDER_EXECUTION_RESULT_VERSION = 'render-exec-result-v1';
export const RENDER_MANIFEST_VERSION = 'manifest-v1';

export const RENDER_EXECUTION_ERROR_REASONS = {
  /** 未配置对象存储（产物必须落自有存储，fail-closed） */
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
  /** 冻结资产版本缺失（快照引用的对象在存储中不可得） */
  ASSET_OBJECT_MISSING: 'ASSET_OBJECT_MISSING',
  /** Master Narration 行/音频资产缺失 */
  NARRATION_MISSING: 'NARRATION_MISSING',
  /** 执行器失败（Remotion/编码/超时） */
  EXECUTOR_FAILED: 'EXECUTOR_FAILED',
  /** 产物哈希与执行回执不一致（完整性失败，绝不入 QA） */
  ARTIFACT_INTEGRITY_FAILED: 'ARTIFACT_INTEGRITY_FAILED',
  /** 版本/渲染记录不存在或跨工作区 */
  RENDER_NOT_FOUND: 'RENDER_NOT_FOUND',
} as const;

export type RenderExecutionErrorReason =
  (typeof RENDER_EXECUTION_ERROR_REASONS)[keyof typeof RENDER_EXECUTION_ERROR_REASONS];

/** 合成场景输入（与 remotion-core 的 VideoComposition 输入兼容；纯数据，无渲染栈依赖） */
export const compositionSceneInputSchema = z.object({
  id: opaqueIdSchema,
  position: z.number().int().nonnegative(),
  startMs: videoMsSchema,
  durationMs: durationMsSchema,
  sceneType: z.string().min(1),
  componentVersion: z.string().nullable().default(null),
  props: z.record(z.string(), z.unknown()).default({}),
  assetBindings: z.array(z.object({ assetId: opaqueIdSchema, role: z.string().min(1) })).default([]),
});

export type CompositionSceneInputDto = z.infer<typeof compositionSceneInputSchema>;

/** 需要在渲染前由编排层落到工作目录的冻结对象（执行器只接收"本地文件名"） */
export const stagedAssetSchema = z.object({
  assetId: opaqueIdSchema,
  assetVersionId: opaqueIdSchema,
  /** 工作目录内的文件名（URL 安全；执行器映射到 /assets/<fileName>） */
  fileName: z.string().min(1).max(200),
  mimeType: z.string().min(1),
  /** 用途（visual/audio/broll/...） */
  role: z.string().min(1),
});

export type StagedAsset = z.infer<typeof stagedAssetSchema>;

/** BGM/音效轨（增益包络来自 P06-06 混音计划；旁白不在其中） */
export const renderExecutionMusicTrackSchema = z.object({
  trackId: z.string().min(1).max(120),
  fileName: z.string().min(1).max(200),
  baseVolume: z.number().min(0).max(2),
  ducking: z.boolean(),
  keyframes: z.array(gainKeyframeSchema).min(1),
});

export type RenderExecutionMusicTrack = z.infer<typeof renderExecutionMusicTrackSchema>;

export const renderExecutionCaptionsSchema = z.object({
  /** 烧录进画面（渲染选项；关闭时仍导出 SRT/VTT 产物） */
  burnIn: z.boolean().default(true),
  style: captionStyleSchema.default(() => captionStyleSchema.parse({})),
  /** 字幕 cue（时间权威 = Master Narration Alignment） */
  cues: z.array(z.object({ startMs: videoMsSchema, durationMs: durationMsSchema, text: z.string() })).default([]),
});

export type RenderExecutionCaptions = z.infer<typeof renderExecutionCaptionsSchema>;

/** Manifest 基线（REQ-28-01：两年后能重建理解；"可重建"不等于像素级复现外部生成模型结果） */
export const renderManifestBaseSchema = z.object({
  schemaVersion: z.literal(RENDER_MANIFEST_VERSION),
  projectId: opaqueIdSchema,
  projectVersionId: opaqueIdSchema,
  projectVersionNumber: z.number().int().positive().nullable().default(null),
  /** Scene Graph schemaVersion（快照声明） */
  sceneGraphSchemaVersion: z.string().min(1),
  /** 脚本（叙事计划）版本 */
  script: z
    .object({ narrativePlanId: opaqueIdSchema, narrativePlanRevision: z.number().int().positive() })
    .nullable()
    .default(null),
  /** 组件版本（每个场景） */
  componentVersions: z
    .array(z.object({ sceneId: opaqueIdSchema, sceneType: z.string().min(1), componentVersion: z.string().nullable().default(null) }))
    .default([]),
  /** 场景素材（冻结的资产版本） */
  sceneAssets: z
    .array(z.object({ sceneId: opaqueIdSchema.nullable().default(null), assetId: opaqueIdSchema, assetVersionId: opaqueIdSchema, role: z.string().min(1) }))
    .default([]),
  /** Master 音频（Audio-First 的权威音轨） */
  masterAudio: z
    .object({
      masterNarrationId: opaqueIdSchema,
      assetVersionId: opaqueIdSchema.nullable().default(null),
      mimeType: z.string().nullable().default(null),
      durationMs: z.number().int().nonnegative(),
      alignmentMethod: z.string().min(1),
    })
    .nullable()
    .default(null),
  /** 身份/风格快照（Voice/Avatar/Brand 版本） */
  identities: z.record(z.string(), z.unknown()).default({}),
  /** 渲染设置（档位/画幅/fps/字幕/音频策略） */
  renderSettings: z.object({
    profile: renderProfileSchema,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().int().positive(),
    durationMs: z.number().int().nonnegative(),
    captions: z.object({ burnIn: z.boolean(), format: z.literal('VTT+SRT') }).default({ burnIn: true, format: 'VTT+SRT' }),
    audio: z.object({ musicTrackCount: z.number().int().nonnegative() }).default({ musicTrackCount: 0 }),
  }),
  /** Provider/模型元数据（生成式资产的来源，便于模型不可用时识别依赖缺口） */
  providerMetadata: z
    .array(z.object({ assetId: opaqueIdSchema, provider: z.string().nullable().default(null), providerAssetId: z.string().nullable().default(null), origin: z.string().min(1).nullable().default(null) }))
    .default([]),
  /** 来源引用（可追溯 §85） */
  sourceReferences: z.array(z.object({ sourceId: opaqueIdSchema, datasetIds: z.array(opaqueIdSchema).default([]) })).default([]),
});

export type RenderManifestBase = z.infer<typeof renderManifestBaseSchema>;

export const RENDER_EXECUTION_FILE_KINDS = ['VIDEO', 'SUBTITLE_SRT', 'SUBTITLE_VTT', 'MANIFEST'] as const;
export const renderExecutionFileKindSchema = z.enum(RENDER_EXECUTION_FILE_KINDS);
export type RenderExecutionFileKind = z.infer<typeof renderExecutionFileKindSchema>;

export const renderExecutionFileSchema = z.object({
  kind: renderExecutionFileKindSchema,
  fileName: z.string().min(1).max(200),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export type RenderExecutionFile = z.infer<typeof renderExecutionFileSchema>;

/** manifest.json 本体（基线 + 产物事实 + 时间戳；manifest_hash = 本文件字节的 SHA-256） */
export const renderManifestSchema = renderManifestBaseSchema.extend({
  outputs: z.array(renderExecutionFileSchema),
  createdAt: isoDateTimeSchema,
  warnings: z.array(z.string().max(300)).default([]),
});

export type RenderManifest = z.infer<typeof renderManifestSchema>;

/** 渲染执行输入（编排层构建；序列化后写入工作目录 spec.json 作为执行证据） */
export const renderExecutionSpecSchema = z.object({
  schemaVersion: z.literal(RENDER_EXECUTION_SPEC_VERSION),
  renderId: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  profile: renderProfileSchema,
  /** 输出画幅（档位权威） */
  format: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().int().positive(),
    aspectRatio: z.enum(['16:9', '9:16', '1:1', '4:5']),
  }),
  /**
   * 成片总时长（毫秒）。取"快照时间轴"与"Master Narration 实际时长"的较大者；
   * 两者偏差 > 1s 时写入 warnings（After-Alignment 重定时尚未实现——见 TODO(P07-04)）。
   */
  durationMs: z.number().int().positive(),
  graph: z.object({
    format: z.object({
      fps: z.number().int().positive(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      aspectRatio: z.string().min(1),
    }),
    timeline: z.object({ durationMs: durationMsSchema }),
    scenes: z.array(compositionSceneInputSchema).min(1),
  }),
  theme: themeTokensSchema.nullable().default(null),
  narration: z.object({ fileName: z.string().min(1).max(200), durationMs: z.number().int().positive() }).nullable().default(null),
  musicTracks: z.array(renderExecutionMusicTrackSchema).default([]),
  captions: renderExecutionCaptionsSchema.default(() => renderExecutionCaptionsSchema.parse({})),
  assets: z.array(stagedAssetSchema).default([]),
  manifestBase: renderManifestBaseSchema,
  warnings: z.array(z.string().max(300)).default([]),
});

export type RenderExecutionSpec = z.infer<typeof renderExecutionSpecSchema>;

/** 渲染执行回执（执行器返回；worker 据此校验产物完整性并入库） */
export const renderExecutionResultSchema = z.object({
  schemaVersion: z.literal(RENDER_EXECUTION_RESULT_VERSION),
  renderId: opaqueIdSchema,
  /** 执行器标识（如 'remotion-server'） */
  executorKind: z.string().min(1),
  format: z.object({ width: z.number().int().positive(), height: z.number().int().positive(), fps: z.number().int().positive() }),
  durationMs: z.number().int().nonnegative(),
  durationInFrames: z.number().int().positive(),
  files: z.array(renderExecutionFileSchema).min(1),
  /** = MANIFEST 文件的 sha256（同一事实，便于快速比对） */
  manifestHash: z.string().regex(/^[0-9a-f]{64}$/),
  warnings: z.array(z.string().max(300)).default([]),
});

export type RenderExecutionResult = z.infer<typeof renderExecutionResultSchema>;

export const RENDER_EXECUTION_FILE_NAMES = {
  VIDEO: 'final.mp4',
  SUBTITLE_SRT: 'subtitles.srt',
  SUBTITLE_VTT: 'subtitles.vtt',
  MANIFEST: 'manifest.json',
} as const;

export const RENDER_EXECUTION_FILE_MIME_TYPES: Readonly<Record<RenderExecutionFileKind, string>> = {
  VIDEO: 'video/mp4',
  SUBTITLE_SRT: 'application/x-subrip',
  SUBTITLE_VTT: 'text/vtt',
  MANIFEST: 'application/json',
};

/**
 * 渲染执行器接口（实现：apps/render-worker 的 Remotion 执行器；编排层（domain/worker）只依赖本接口）。
 * - `workDir` 布局约定：`<workDir>/spec.json`（输入证据）、`<workDir>/assets/`（冻结对象）、
 *   `<workDir>/out/`（产物与 result.json）；
 * - 执行器**不得**访问数据库/凭据；只消费 spec 与本地文件。
 */
export interface RenderExecutor {
  readonly kind: string;
  execute(input: {
    renderId: string;
    spec: RenderExecutionSpec;
    workDir: string;
    onProgress?: (progress: { renderedFrames: number; encodedFrames: number; progress: number }) => void | Promise<void>;
  }): Promise<RenderExecutionResult>;
}
