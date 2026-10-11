import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  RENDER_EXECUTION_ERROR_REASONS,
  RENDER_EXECUTION_FILE_MIME_TYPES,
  RENDER_EXECUTION_SPEC_VERSION,
  RENDER_MANIFEST_VERSION,
  RENDER_QA_JOB_TYPE,
  planAudioMix,
  projectVersionSnapshotSchema,
  renderExecutionSpecSchema,
  renderManifestBaseSchema,
  themeTokensSchema,
  type MasterNarration,
  type MixInputTrack,
  type RenderExecutionFileKind,
  type RenderExecutionResult,
  type RenderExecutionSpec,
  type RenderExecutor,
  type RenderRecord,
  type RenderStatus,
  type StagedAsset,
} from '@ancs/contracts';
import { assetVersions, assets, projectVersions, renders } from '@ancs/db';
import type { DomainDeps } from './deps.js';
import { getMasterNarrationById } from './alignment.js';
import { captionCuesOf } from './mixdown.js';
import { canTransitionRender, getRender, transitionRender } from './render.js';
import { createJob } from './jobs.js';

/**
 * Final 合成执行服务（P07-04 / 规范 §28、§39、§58；计划 §8 P07-04）。
 *
 * 流程（Render=QUEUED 起）：
 *   冻结输入（P07-03）→ 读版本快照 / Master Narration / 资产版本 → **纯投影构建 spec**
 *   → 冻结对象落工作目录 → 执行器（Remotion，见 RenderExecutor 契约）→ 产物 sha256 复核
 *   → 产物落自有存储（Asset=SYSTEM_RENDER）→ manifest_hash 与 outputAssetIds 写回 → transition(QA)。
 *
 * 纪律：
 * - 渲染只消费**不可变引用**（快照 graph + 冻结资产版本 + 指定 Master Narration 行）；
 * - 执行器不触数据库/凭据；素材由编排层落本地，执行器只读文件；
 * - 产物哈希与执行回执不一致 → 失败（ARTIFACT_INTEGRITY_FAILED），绝不入 QA；
 * - 失败 → Render=FAILED（结构化 error）；恢复 = 人工以新 Render 重试（不允许无限自动重试）；
 * - 幂等：同 (renderId, kind) 产物复用；内容变化（重渲）→ 追加新 AssetVersion（不覆盖旧版本）。
 *
 * TODO(P07-04)：After-Alignment 场景重定时（合成后按 Alignment 实际时长回写场景起止）尚未实现——
 * 当前 spec 时长取"快照时间轴 vs Narration 实际时长"的较大者，偏差 > 1s 时写入 warnings（不静默）。
 * 依赖：编辑协议批量 update_scene（revision 单调）；计划在 P08 金样前补齐（REQ-39-01）。
 */

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
};

const extensionForMime = (mimeType: string): string => EXTENSION_BY_MIME[mimeType.split(';')[0]?.trim() ?? ''] ?? 'bin';

/** 工作目录文件名（版本 id 由服务端生成，URL 安全；用途前缀区分同版本多角色） */
const stagedFileName = (role: string, assetVersionId: string, mimeType: string): string =>
  `${role}_${assetVersionId.replace(/[^A-Za-z0-9_-]/g, '_')}.${extensionForMime(mimeType)}`;

/** 档位画幅 → 宽高比（与通道画幅契约一致；组件按此选择布局） */
function aspectRatioFor(width: number, height: number): '16:9' | '9:16' | '1:1' | '4:5' {
  const ratio = width / height;
  const candidates: { name: '16:9' | '9:16' | '1:1' | '4:5'; value: number }[] = [
    { name: '16:9', value: 16 / 9 },
    { name: '9:16', value: 9 / 16 },
    { name: '1:1', value: 1 },
    { name: '4:5', value: 4 / 5 },
  ];
  let best = candidates[0] as { name: '16:9' | '9:16' | '1:1' | '4:5'; value: number };
  for (const candidate of candidates) {
    if (Math.abs(candidate.value - ratio) < Math.abs(best.value - ratio)) best = candidate;
  }
  return best.name;
}

export interface RenderAssetVersionRow {
  id: string;
  assetId: string;
  storageKey: string;
  mimeType: string;
}

export interface RenderAssetRow {
  id: string;
  provider: string | null;
  providerAssetId: string | null;
  origin: string;
}

export interface BuildRenderExecutionInput {
  render: RenderRecord;
  snapshot: unknown;
  versionNumber?: number | null;
  master: MasterNarration;
  assetVersionRows: readonly RenderAssetVersionRow[];
  assetRows?: readonly RenderAssetRow[];
}

export interface BuiltRenderExecution {
  spec: RenderExecutionSpec;
  /** 需要在渲染前落盘的对象（编排层从存储取字节 → workDir/assets/<fileName>） */
  staging: StagedAsset[];
  warnings: string[];
}

/**
 * 构建渲染执行 spec（纯投影：快照 graph + Master Narration + 冻结资产版本清单）。
 * 不变量：不读"当前状态"——所有引用来自 Render.input 冻结的 id。
 */
/**
 * 封面帧位选择（P10-05；**纯函数、单一事实来源**——渲染 spec 与输出报告使用同一规则）。
 * 规则：取第一个非章节/结构类场景的起点 + min(1000ms, 该场景时长/5)；全为结构场景时取时长 10%。
 * 结果保证在 [0, durationMs - frameMs]（仅夹取到合法区间并记录；不改变场景数据）。
 */
export function chooseThumbnailFrameMs(input: { scenes: readonly { sceneType: string; startMs: number; durationMs: number }[]; durationMs: number; fps: number }): number {
  const structural = new Set(['CHAPTER_TITLE', 'SECTION_BREAK']);
  const content = input.scenes.find((scene) => !structural.has(scene.sceneType));
  const frameMs = Math.max(1, Math.round(1000 / input.fps));
  const candidate = content === undefined ? Math.round(input.durationMs * 0.1) : content.startMs + Math.min(1000, Math.round(content.durationMs / 5));
  const maxMs = Math.max(0, input.durationMs - frameMs);
  return Math.min(Math.max(0, candidate), maxMs);
}

export function buildRenderExecutionSpec(input: BuildRenderExecutionInput): BuiltRenderExecution {
  const snapshot = projectVersionSnapshotSchema.parse(input.snapshot);
  const graph = snapshot.graph;
  const warnings: string[] = [];
  const format = {
    ...input.render.input.format,
    aspectRatio: aspectRatioFor(input.render.input.format.width, input.render.input.format.height),
  };

  const versionById = new Map<string, RenderAssetVersionRow>();
  for (const row of input.assetVersionRows) versionById.set(row.id, row);
  /** 冻结版本清单的权威集合（Render.input.assetVersionIds） */
  const frozenVersionIds = new Set(input.render.input.assetVersionIds);
  const versionByAssetId = new Map<string, RenderAssetVersionRow>();
  for (const versionId of input.render.input.assetVersionIds) {
    const row = versionById.get(versionId);
    if (row !== undefined) versionByAssetId.set(row.assetId, row);
  }

  const staging: StagedAsset[] = [];
  const stagedByVersionId = new Map<string, StagedAsset>();
  const stage = (row: RenderAssetVersionRow, role: string): string => {
    const existing = stagedByVersionId.get(row.id);
    if (existing !== undefined) return existing.fileName;
    const entry: StagedAsset = { assetId: row.assetId, assetVersionId: row.id, fileName: stagedFileName(role, row.id, row.mimeType), mimeType: row.mimeType, role };
    stagedByVersionId.set(row.id, entry);
    staging.push(entry);
    return entry.fileName;
  };

  // 1) 场景（画面）+ 场景素材（assetBindings → 冻结版本；缺版本 → 明确 warning，绝不静默取当前）
  const sceneAssets: { sceneId: string | null; assetId: string; assetVersionId: string; role: string }[] = [];
  const scenes = graph.scenes.map((scene) => {
    for (const binding of scene.assetBindings) {
      const version = versionByAssetId.get(binding.assetId);
      if (version === undefined) {
        warnings.push(`场景 ${scene.id} 的绑定资产 ${binding.assetId} 无冻结版本：该素材按占位渲染（不静默取当前版本）。`);
        continue;
      }
      stage(version, binding.role);
      sceneAssets.push({ sceneId: scene.id, assetId: binding.assetId, assetVersionId: version.id, role: binding.role });
    }
    return {
      id: scene.id,
      position: scene.position,
      startMs: scene.startMs,
      durationMs: scene.durationMs,
      sceneType: scene.sceneType,
      componentVersion: scene.componentVersion,
      props: scene.props,
      assetBindings: scene.assetBindings.map((binding) => ({ assetId: binding.assetId, role: binding.role })),
    };
  });

  // 2) Master Narration 音频（Audio-First：无音频不成片——构建 spec 时缺失即失败）
  if (input.master.assetVersionId === null) {
    throw new ApiFailure(ERROR_CODES.INTERNAL, 'Master Narration 缺少音频资产版本（P06-03 数据不一致）', 500, {
      reason: RENDER_EXECUTION_ERROR_REASONS.NARRATION_MISSING,
      narrationId: input.master.id,
    });
  }
  const narrationVersion = versionById.get(input.master.assetVersionId);
  if (narrationVersion === undefined) {
    throw new ApiFailure(ERROR_CODES.INTERNAL, `Master Narration 音频版本 ${input.master.assetVersionId} 行缺失`, 500, {
      reason: RENDER_EXECUTION_ERROR_REASONS.NARRATION_MISSING,
      narrationId: input.master.id,
    });
  }
  const narrationFileName = stage(narrationVersion, 'narration');

  // 3) BGM/音效轨（P06-06 混音计划；旁白不在其中——无重叠双人声；未冻结版本 → 跳过并告警）
  const musicTracks: RenderExecutionSpec['musicTracks'] = [];
  const mixInputs: MixInputTrack[] = [];
  const musicFileByTrackId = new Map<string, string>();
  for (const track of graph.audioTracks) {
    if (track.kind === 'NARRATION' || track.assetId === null) continue;
    const version = versionByAssetId.get(track.assetId);
    if (version === undefined) {
      warnings.push(`音轨 ${track.id}（${track.kind}）的资产未随 Render 输入冻结：本次渲染跳过该轨（不静默取当前版本）。`);
      continue;
    }
    if (!frozenVersionIds.has(version.id)) {
      warnings.push(`音轨 ${track.id} 的资产版本未在冻结清单内：跳过（渲染输入只允许不可变引用）。`);
      continue;
    }
    musicFileByTrackId.set(track.id, stage(version, 'music'));
    mixInputs.push({
      id: track.id,
      kind: track.kind,
      assetId: track.assetId,
      volume: track.volume,
      fadeInMs: track.fadeInMs,
      fadeOutMs: track.fadeOutMs,
      ducking: track.ducking,
    });
  }
  if (mixInputs.length > 0) {
    const plan = planAudioMix({ projectId: input.render.projectId, durationMs: input.master.totalDurationMs, cues: input.master.cues, tracks: mixInputs });
    for (const track of plan.tracks) {
      if (track.kind === 'NARRATION') continue;
      const fileName = musicFileByTrackId.get(track.trackId);
      if (fileName === undefined) continue;
      musicTracks.push({ trackId: track.trackId, fileName, baseVolume: track.baseVolume, ducking: track.ducking, keyframes: track.keyframes });
    }
  }

  // 4) 字幕（时间权威 = Alignment；样式默认，后续可由 Channel/覆盖策略调整）
  const captions = { burnIn: true, cues: captionCuesOf(input.master) };
  if (captions.cues.length === 0) warnings.push('Master Narration 无对齐段：成片无字幕（空旁白）。');

  // 5) 时长：快照时间轴 vs Narration 实际时长（取较大者；偏差明确告警——After-Alignment 重定时未实现）
  const graphTimelineMs = graph.timeline.durationMs;
  const narrationMs = input.master.totalDurationMs;
  const durationMs = Math.max(1, graphTimelineMs, narrationMs);
  if (Math.abs(graphTimelineMs - narrationMs) > 1000) {
    warnings.push(
      `快照时间轴 ${String(graphTimelineMs)}ms 与 Master Narration ${String(narrationMs)}ms 偏差超过 1s：After-Alignment 重定时未实现（P08 金样前处理）。`,
    );
  }

  // 6) 主题（随快照固化的 tokens；缺失 → 组件默认主题）
  const themeParsed = themeTokensSchema.safeParse((snapshot.meta as Record<string, unknown>)['themeTokens']);
  const theme = themeParsed.success ? themeParsed.data : null;

  const manifestBase = renderManifestBaseSchema.parse({
    schemaVersion: RENDER_MANIFEST_VERSION,
    projectId: input.render.projectId,
    projectVersionId: input.render.input.projectVersionId,
    projectVersionNumber: input.versionNumber ?? null,
    sceneGraphSchemaVersion: graph.schemaVersion,
    script: { narrativePlanId: input.master.narrativePlanId, narrativePlanRevision: input.master.narrativePlanRevision },
    componentVersions: graph.scenes.map((scene) => ({ sceneId: scene.id, sceneType: scene.sceneType, componentVersion: scene.componentVersion })),
    sceneAssets,
    masterAudio: {
      masterNarrationId: input.master.id,
      assetVersionId: input.master.assetVersionId,
      mimeType: input.master.mimeType,
      durationMs: narrationMs,
      alignmentMethod: input.master.alignmentMethod,
    },
    identities: { ...graph.identitySnapshot, channelSnapshot: graph.channelSnapshot, voice: input.master.voice },
    renderSettings: {
      profile: input.render.profile,
      width: format.width,
      height: format.height,
      fps: format.fps,
      durationMs,
      captions: { burnIn: captions.burnIn, format: 'VTT+SRT' },
      audio: { musicTrackCount: musicTracks.length },
    },
    providerMetadata: (input.assetRows ?? []).map((row) => ({ assetId: row.id, provider: row.provider, providerAssetId: row.providerAssetId, origin: row.origin })),
    sourceReferences: graph.sourceReferences.map((reference) => ({ sourceId: reference.sourceId, datasetIds: reference.datasetIds })),
  });

  const spec = renderExecutionSpecSchema.parse({
    schemaVersion: RENDER_EXECUTION_SPEC_VERSION,
    renderId: input.render.id,
    workspaceId: input.render.workspaceId,
    projectId: input.render.projectId,
    profile: input.render.profile,
    format,
    durationMs,
    graph: {
      format: { fps: format.fps, width: format.width, height: format.height, aspectRatio: format.aspectRatio },
      timeline: { durationMs },
      scenes,
    },
    theme,
    narration: { fileName: narrationFileName, durationMs: narrationMs },
    musicTracks,
    captions: { burnIn: captions.burnIn, cues: captions.cues },
    thumbnail: { atMs: chooseThumbnailFrameMs({ scenes, durationMs, fps: format.fps }) },
    assets: staging,
    manifestBase,
    warnings,
  });

  return { spec, staging, warnings };
}

/* ---------- 产物入库（finalize） ---------- */

export interface FinalizeRenderArtifact {
  kind: RenderExecutionFileKind;
  fileName: string;
  bytes: Uint8Array;
  sha256: string;
}

const outputStorageKey = (workspaceId: string, projectId: string, renderId: string, fileName: string): string =>
  `workspaces/${workspaceId}/projects/${projectId}/renders/${renderId}/${fileName}`;

const assetTypeFor = (kind: RenderExecutionFileKind, profile: RenderRecord['profile']): string => {
  if (kind === 'VIDEO') return profile === 'DRAFT_720' ? 'DRAFT_RENDER' : profile === 'SHORT_1080x1920' ? 'SHORT_VIDEO' : 'FINAL_VIDEO';
  if (kind === 'MANIFEST') return 'MANIFEST';
  if (kind === 'THUMBNAIL') return 'THUMBNAIL';
  return 'SUBTITLE';
};

const mimeFor = (kind: RenderExecutionFileKind): string =>
  kind === 'VIDEO' ? 'video/mp4' : kind === 'MANIFEST' ? 'application/json' : RENDER_EXECUTION_FILE_MIME_TYPES[kind];

/**
 * 产物落库（幂等）：上传自有存储 → Asset/AssetVersion（SYSTEM_RENDER）→ 写回 Render。
 * 调用方须先完成 sha256 复核（不一致不得进入本函数）。
 */
export async function persistRenderArtifacts(
  deps: DomainDeps,
  input: {
    workspaceId: string;
    projectId: string;
    renderId: string;
    profile: RenderRecord['profile'];
    artifacts: readonly FinalizeRenderArtifact[];
    manifestHash: string;
  },
): Promise<{ outputAssetIds: string[]; createdAssets: number; reusedAssets: number }> {
  const storage = deps.storage;
  if (storage === undefined) {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, '未配置对象存储：渲染产物必须落自有存储（fail-closed）', 501, {
      reason: RENDER_EXECUTION_ERROR_REASONS.STORAGE_UNAVAILABLE,
    });
  }
  const manifestArtifact = input.artifacts.find((artifact) => artifact.kind === 'MANIFEST');
  if (manifestArtifact === undefined) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, '缺少 Manifest 产物：Final 渲染必须生成 manifest.json（§28）', 422, {
      reason: RENDER_EXECUTION_ERROR_REASONS.ARTIFACT_INTEGRITY_FAILED,
    });
  }
  if (manifestArtifact.sha256 !== input.manifestHash) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'manifest_hash 与 Manifest 字节不一致：拒绝入库', 422, {
      reason: RENDER_EXECUTION_ERROR_REASONS.ARTIFACT_INTEGRITY_FAILED,
      expected: input.manifestHash,
      actual: manifestArtifact.sha256,
    });
  }

  // 已入库产物复用（(renderId, kind) 幂等键；重试/重渲不产生重复资产行）
  const existingRows = await deps.db
    .select({ id: assets.id, metadata: assets.metadata, currentVersionId: assets.currentVersionId })
    .from(assets)
    .where(and(eq(assets.workspaceId, input.workspaceId), sql`(${assets.metadata} ->> 'renderId') = ${input.renderId}`));
  const existingByKind = new Map<string, { id: string; currentVersionId: string | null }>();
  for (const row of existingRows) {
    const metadata = row.metadata as Record<string, unknown>;
    const kind = metadata['kind'];
    if (typeof kind === 'string') existingByKind.set(kind, { id: row.id, currentVersionId: row.currentVersionId });
  }

  const outputAssetIds: string[] = [];
  let createdAssets = 0;
  let reusedAssets = 0;

  for (const artifact of input.artifacts) {
    const storageKey = outputStorageKey(input.workspaceId, input.projectId, input.renderId, artifact.fileName);
    await storage.putObject(storageKey, artifact.bytes);
    const existing = existingByKind.get(artifact.kind);
    if (existing === undefined) {
      const assetId = `ast_${randomUUID()}`;
      const versionId = `av_${randomUUID()}`;
      await deps.db.transaction(async (tx) => {
        await tx.insert(assets).values({
          id: assetId,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          assetType: assetTypeFor(artifact.kind, input.profile),
          origin: 'SYSTEM_RENDER',
          provider: null,
          providerAssetId: null,
          status: 'READY',
          retentionClass: 'KEEP_FINAL',
          license: {
            type: 'SYSTEM_GENERATED',
            holder: null,
            attribution: null,
            sourceUrl: null,
            termsUrl: null,
            notes: `Final 合成产物（render=${input.renderId}，kind=${artifact.kind}）`,
            confirmedBy: null,
            confirmedAt: null,
          },
          metadata: { renderId: input.renderId, kind: artifact.kind, profile: input.profile, manifestHash: input.manifestHash },
          currentVersionId: versionId,
        });
        await tx.insert(assetVersions).values({
          id: versionId,
          assetId,
          workspaceId: input.workspaceId,
          versionNumber: 1,
          storageKey,
          mimeType: mimeFor(artifact.kind),
          sizeBytes: artifact.bytes.byteLength,
          checksumSha256: artifact.sha256,
          status: 'READY',
          metadata: { renderId: input.renderId, kind: artifact.kind },
        });
      });
      outputAssetIds.push(assetId);
      createdAssets += 1;
      continue;
    }

    // 复用：现有版本内容一致 → 直接复用；不一致（重渲）→ 追加新版本（不可变版本纪律，不覆盖旧行）
    outputAssetIds.push(existing.id);
    const versionRows =
      existing.currentVersionId === null
        ? []
        : await deps.db
            .select({ id: assetVersions.id, checksumSha256: assetVersions.checksumSha256 })
            .from(assetVersions)
            .where(eq(assetVersions.id, existing.currentVersionId))
            .limit(1);
    const current = versionRows[0];
    if (current !== undefined && current.checksumSha256 === artifact.sha256) {
      reusedAssets += 1;
      continue;
    }
    const maxRows = await deps.db
      .select({ max: sql<number>`coalesce(max(${assetVersions.versionNumber}), 0)` })
      .from(assetVersions)
      .where(eq(assetVersions.assetId, existing.id));
    const versionNumber = Number(maxRows[0]?.max ?? 0) + 1;
    const versionId = `av_${randomUUID()}`;
    await deps.db.transaction(async (tx) => {
      await tx.insert(assetVersions).values({
        id: versionId,
        assetId: existing.id,
        workspaceId: input.workspaceId,
        versionNumber,
        storageKey,
        mimeType: mimeFor(artifact.kind),
        sizeBytes: artifact.bytes.byteLength,
        checksumSha256: artifact.sha256,
        status: 'READY',
        metadata: { renderId: input.renderId, kind: artifact.kind, rerender: true },
      });
      await tx.update(assets).set({ currentVersionId: versionId, updatedAt: new Date() }).where(eq(assets.id, existing.id));
    });
    createdAssets += 1;
  }

  await deps.db
    .update(renders)
    .set({ manifestHash: input.manifestHash, outputAssetIds, error: null, updatedAt: new Date() })
    .where(eq(renders.id, input.renderId));

  return { outputAssetIds, createdAssets, reusedAssets };
}

/* ---------- 编排（QUEUED → RENDERING → 执行 → 产物 → QA） ---------- */

export interface RunRenderExecutionResult {
  render: RenderRecord;
  result: RenderExecutionResult | null;
  /** 已终结（QA/READY/FAILED/CANCELLED）→ 跳过执行（幂等） */
  skipped: string | null;
}

async function loadFrozenInput(deps: DomainDeps, render: RenderRecord) {
  const versionRows = await deps.db.select().from(projectVersions).where(eq(projectVersions.id, render.input.projectVersionId)).limit(1);
  const versionRow = versionRows[0];
  if (versionRow === undefined) {
    throw new ApiFailure(ERROR_CODES.INTERNAL, 'Render 输入快照丢失（版本不可变，不应发生）', 500, {
      reason: RENDER_EXECUTION_ERROR_REASONS.RENDER_NOT_FOUND,
    });
  }
  if (render.input.masterNarrationId === null) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'Render 输入缺 Master Narration 引用', 409, {
      reason: RENDER_EXECUTION_ERROR_REASONS.NARRATION_MISSING,
    });
  }
  const master = await getMasterNarrationById(deps, { workspaceId: render.workspaceId, narrationId: render.input.masterNarrationId });
  if (master === null) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'Master Narration 行不存在（快照引用的输入缺失）', 409, {
      reason: RENDER_EXECUTION_ERROR_REASONS.NARRATION_MISSING,
    });
  }
  const versionIds = [...new Set([...render.input.assetVersionIds, ...(master.assetVersionId !== null ? [master.assetVersionId] : [])])];
  const assetVersionRows =
    versionIds.length === 0
      ? []
      : await deps.db
          .select({ id: assetVersions.id, assetId: assetVersions.assetId, storageKey: assetVersions.storageKey, mimeType: assetVersions.mimeType })
          .from(assetVersions)
          .where(and(eq(assetVersions.workspaceId, render.workspaceId), inArray(assetVersions.id, versionIds)));
  const assetIds = [...new Set(assetVersionRows.map((row) => row.assetId))];
  const assetRows =
    assetIds.length === 0
      ? []
      : await deps.db
          .select({ id: assets.id, provider: assets.provider, providerAssetId: assets.providerAssetId, origin: assets.origin })
          .from(assets)
          .where(and(eq(assets.workspaceId, render.workspaceId), inArray(assets.id, assetIds)));
  return { snapshot: versionRow.snapshot, versionNumber: versionRow.versionNumber, master, assetVersionRows, assetRows };
}

/**
 * 执行一次 Final 合成（编排层入口；执行器注入）。
 *
 * - Render 必须为 QUEUED（或崩溃恢复下的 RENDERING）；已终结 → 幂等跳过；
 * - 执行异常 → Render=FAILED（结构化 error）并向上抛出（任务层定性 FAILED_FINAL）；
 * - 产物 sha256 与执行回执不一致 → 同上失败（完整性优先，绝不入 QA）。
 */
export async function runRenderExecution(
  deps: DomainDeps,
  input: { workspaceId: string; renderId: string; executor: RenderExecutor; workDir: string },
): Promise<RunRenderExecutionResult> {
  const render = await getRender(deps, { workspaceId: input.workspaceId, renderId: input.renderId });
  if (render.status === 'QA' || render.status === 'READY' || render.status === 'FAILED' || render.status === 'CANCELLED') {
    return { render, result: null, skipped: render.status };
  }
  if (render.status === 'QUEUED') {
    await transitionRender(deps, { workspaceId: input.workspaceId, renderId: input.renderId, to: 'RENDERING', note: `执行器启动：${input.executor.kind}` });
  }

  try {
    const storage = deps.storage;
    if (storage === undefined) {
      throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, '未配置对象存储：产物必须落自有存储（fail-closed）', 501, {
        reason: RENDER_EXECUTION_ERROR_REASONS.STORAGE_UNAVAILABLE,
      });
    }
    const frozen = await loadFrozenInput(deps, render);
    const { spec, staging } = buildRenderExecutionSpec({
      render,
      snapshot: frozen.snapshot,
      versionNumber: frozen.versionNumber,
      master: frozen.master,
      assetVersionRows: frozen.assetVersionRows,
      assetRows: frozen.assetRows,
    });

    // 冻结对象：存储 → 工作目录（编排层负责 I/O；执行器只读本地文件）
    const assetsDir = join(input.workDir, 'assets');
    const outDir = join(input.workDir, 'out');
    await mkdir(assetsDir, { recursive: true });
    await mkdir(outDir, { recursive: true });
    const storageKeyByVersionId = new Map(frozen.assetVersionRows.map((row) => [row.id, row.storageKey]));
    for (const entry of staging) {
      const storageKey = storageKeyByVersionId.get(entry.assetVersionId);
      if (storageKey === undefined) {
        throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, `冻结资产版本行缺失：${entry.assetVersionId}`, 409, {
          reason: RENDER_EXECUTION_ERROR_REASONS.ASSET_OBJECT_MISSING,
          assetVersionId: entry.assetVersionId,
        });
      }
      const bytes = await storage.getObject(storageKey);
      if (bytes === null) {
        throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, `冻结资产对象缺失：${storageKey}（渲染输入不可得）`, 409, {
          reason: RENDER_EXECUTION_ERROR_REASONS.ASSET_OBJECT_MISSING,
          assetVersionId: entry.assetVersionId,
        });
      }
      await writeFile(join(assetsDir, entry.fileName), bytes);
    }
    // 输入证据（spec.json）：执行器/复盘统一消费（与内存 spec 逐字节一致）
    await writeFile(join(input.workDir, 'spec.json'), JSON.stringify(spec, null, 2), 'utf8');

    const result = await input.executor.execute({ renderId: render.id, spec, workDir: input.workDir });

    // 产物完整性：逐文件 sha256 与执行回执一致（不一致拒绝入库）
    const artifacts: FinalizeRenderArtifact[] = [];
    for (const file of result.files) {
      const bytes = await readFile(join(outDir, file.fileName));
      const digest = sha256Hex(bytes);
      if (digest !== file.sha256) {
        throw new ApiFailure(ERROR_CODES.INTERNAL, `产物 ${file.fileName} 哈希不一致（执行回执 ${file.sha256}，实际 ${digest}）`, 500, {
          reason: RENDER_EXECUTION_ERROR_REASONS.ARTIFACT_INTEGRITY_FAILED,
          fileName: file.fileName,
        });
      }
      artifacts.push({ kind: file.kind, fileName: file.fileName, bytes, sha256: digest });
    }
    const manifestFile = result.files.find((file) => file.kind === 'MANIFEST');
    if (manifestFile === undefined || manifestFile.sha256 !== result.manifestHash) {
      throw new ApiFailure(ERROR_CODES.INTERNAL, '执行回执的 manifestHash 与 Manifest 产物不一致', 500, {
        reason: RENDER_EXECUTION_ERROR_REASONS.ARTIFACT_INTEGRITY_FAILED,
      });
    }

    await persistRenderArtifacts(deps, {
      workspaceId: render.workspaceId,
      projectId: render.projectId,
      renderId: render.id,
      profile: render.profile,
      artifacts,
      manifestHash: result.manifestHash,
    });

    // §86：Final Render 后 MUST 经过自动 QA——QA 过渡同一流程内入队 RENDER_QA 任务
    // （小窗口：入队前进程崩溃 → Render 停在 QA，可由人工/维护重触发 POST /renders/:id/qa）
    const qa = await transitionRender(deps, {
      workspaceId: render.workspaceId,
      renderId: render.id,
      to: 'QA',
      note: `合成完成：${String(result.files.length)} 个产物入库（manifest ${result.manifestHash.slice(0, 12)}…），等待 QA（P07-05）`,
    });
    await createJob(deps, {
      workspaceId: render.workspaceId,
      projectId: render.projectId,
      type: RENDER_QA_JOB_TYPE,
      input: { renderId: render.id },
      maxAttempts: 2,
    }).catch(() => undefined); // 入队失败不改变渲染结果（QA 可经 API 重触发）
    return { render: qa, result, skipped: null };
  } catch (error) {
    // 明确失败（不落 QA）；恢复 = 人工以新 Render 重试（不允许无限自动重试）
    const fresh = await getRender(deps, { workspaceId: input.workspaceId, renderId: input.renderId }).catch(() => null);
    if (fresh !== null && canTransitionRender(fresh.status as RenderStatus, 'FAILED')) {
      const message = error instanceof Error ? error.message : String(error);
      const reason =
        error instanceof ApiFailure && typeof error.details === 'object' && error.details !== null
          ? String((error.details as Record<string, unknown>)['reason'] ?? RENDER_EXECUTION_ERROR_REASONS.EXECUTOR_FAILED)
          : RENDER_EXECUTION_ERROR_REASONS.EXECUTOR_FAILED;
      await deps.db
        .update(renders)
        .set({ error: { reason, message, executor: input.executor.kind }, updatedAt: new Date() })
        .where(eq(renders.id, input.renderId))
        .catch(() => undefined);
      await transitionRender(deps, {
        workspaceId: input.workspaceId,
        renderId: input.renderId,
        to: 'FAILED',
        note: `Final 合成失败（${reason}）：${message}`,
      }).catch(() => undefined);
    }
    throw error;
  }
}
