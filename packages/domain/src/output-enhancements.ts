import { and, eq, inArray } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  RENDER_OUTPUT_ENHANCEMENTS_VERSION,
  RENDER_OUTPUTS_ERROR_REASONS,
  renderManifestSchema,
  renderOutputEnhancementsSchema,
  projectVersionSnapshotSchema,
  type OutputAssetAttribution,
  type OutputChapter,
  type OutputSourceEntry,
  type RenderOutputEnhancements,
} from '@ancs/contracts';
import { assetVersions, assets, projectSources, projectVersions, projects } from '@ancs/db';
import type { DomainDeps } from './channels.js';
import { chooseThumbnailFrameMs } from './render-execution.js';
import { getRender } from './render.js';
import { getLatestRenderApproval } from './approval.js';

/**
 * 输出增强包（P10-05 / 规范 §4.2、§84、§85、§87）。
 *
 * - **正式版本绑定**：仅对 READY + **已批准且未失效**（approval.manifestHashAtApproval === render.manifestHash）
 *   的渲染生成；全部字段从**冻结快照 + 已批准 manifest** 派生（不读当前项目状态）；
 * - **章节时间与正式成片一致**：章节 = 冻结快照的章节类场景；逐条校验（0 ≤ startMs < manifest 时长、
 *   单调递增）——不一致 → 422 CONSISTENCY_VIOLATION（不静默夹取）；
 * - **编码参数**：width/height/fps 取自 manifest（正式版本事实，不重算）；
 * - **授权署名**：绑定资产的许可元数据（P10-03）；attributionRequired 且缺文本 → warning（不编造）；
 * - **可溯源**：标题/描述逐项 derivedFrom；来源 = 冻结快照 sourceBindings → project_sources。
 */

const sceneText = (props: Record<string, unknown>): string | null => {
  for (const key of ['text', 'title', 'headline', 'heading', 'label']) {
    const value = props[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
};

export async function buildRenderOutputEnhancements(
  deps: DomainDeps,
  input: { workspaceId: string; renderId: string },
): Promise<RenderOutputEnhancements> {
  const storage = deps.storage;
  if (storage === undefined) {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, '未配置对象存储：无法读取正式 manifest（fail-closed）', 501, {
      reason: RENDER_OUTPUTS_ERROR_REASONS.STORAGE_UNAVAILABLE,
    });
  }

  const render = await getRender(deps, { workspaceId: input.workspaceId, renderId: input.renderId });
  if (render.status !== 'READY' || render.manifestHash === null) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, `Render 未就绪（当前 ${render.status}）`, 409, {
      reason: RENDER_OUTPUTS_ERROR_REASONS.RENDER_NOT_READY,
      status: render.status,
    });
  }
  const approval = await getLatestRenderApproval(deps, { workspaceId: input.workspaceId, renderId: input.renderId });
  if (approval === null || approval.decision !== 'APPROVED') {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '未批准不能生成发布物（§87）：请先完成人工批准', 409, {
      reason: RENDER_OUTPUTS_ERROR_REASONS.NOT_APPROVED,
      decision: approval?.decision ?? null,
    });
  }
  if (approval.manifestHashAtApproval !== render.manifestHash) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '批准已失效（批准后 manifest 变化）：需重新审批', 409, {
      reason: RENDER_OUTPUTS_ERROR_REASONS.APPROVAL_STALE,
      approvedHash: approval.manifestHashAtApproval,
      currentHash: render.manifestHash,
    });
  }

  // 冻结快照（正式版本）
  const versionRows = await deps.db
    .select()
    .from(projectVersions)
    .where(and(eq(projectVersions.id, render.input.projectVersionId), eq(projectVersions.workspaceId, input.workspaceId)))
    .limit(1);
  const versionRow = versionRows[0];
  if (versionRow === undefined) {
    throw new ApiFailure(ERROR_CODES.INTERNAL, '冻结版本缺失（Render 引用的 projectVersionId 不存在）', 500);
  }
  const snapshot = projectVersionSnapshotSchema.parse(versionRow.snapshot);

  // 已批准 manifest（正式版本事实：时长/编码参数/产物清单）
  const manifestArtifact = render.outputAssetIds.length === 0
    ? null
    : (
        await deps.db
          .select({ storageKey: assetVersions.storageKey })
          .from(assets)
          .innerJoin(assetVersions, eq(assetVersions.assetId, assets.id))
          .where(and(eq(assets.workspaceId, input.workspaceId), inArray(assets.id, render.outputAssetIds)))
      ).find((row) => row.storageKey.endsWith('manifest.json'));
  const manifestBytes = manifestArtifact === undefined || manifestArtifact === null ? null : await storage.getObject(manifestArtifact.storageKey);
  if (manifestBytes === null) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '正式 manifest 不可读（产物缺失）', 409, {
      reason: RENDER_OUTPUTS_ERROR_REASONS.MANIFEST_UNAVAILABLE,
    });
  }
  const manifest = renderManifestSchema.parse(JSON.parse(Buffer.from(manifestBytes).toString('utf8')));

  const checked: string[] = [];
  const warnings: string[] = [];

  // ① manifest 与冻结版本绑定
  if (manifest.projectVersionId !== render.input.projectVersionId) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'manifest 与冻结版本不一致（绑定校验失败）', 422, {
      reason: RENDER_OUTPUTS_ERROR_REASONS.CONSISTENCY_VIOLATION,
      check: 'MANIFEST_VERSION_BINDING',
      manifestProjectVersionId: manifest.projectVersionId,
      expected: render.input.projectVersionId,
    });
  }
  checked.push('MANIFEST_VERSION_BINDING');

  // ② 章节：来自冻结快照；时间必须在 manifest 时长内且单调递增
  const scenes = snapshot.graph.scenes;
  const chapterScenes = scenes.filter((scene) => scene.sceneType === 'CHAPTER_TITLE').sort((left, right) => left.startMs - right.startMs);
  const chapters: OutputChapter[] = [];
  const violations: Record<string, unknown>[] = [];
  for (const [index, scene] of chapterScenes.entries()) {
    const title = sceneText(scene.props) ?? (() => {
      warnings.push(`章节场景 ${scene.id} 无标题文本：以场景类型占位（不编造标题）`);
      return '未命名章节';
    })();
    if (scene.startMs >= manifest.renderSettings.durationMs) {
      violations.push({ sceneId: scene.id, startMs: scene.startMs, durationMs: manifest.renderSettings.durationMs, check: 'CHAPTER_WITHIN_DURATION' });
    }
    const previous = chapters[chapters.length - 1];
    if (previous !== undefined && scene.startMs <= previous.startMs) {
      violations.push({ sceneId: scene.id, startMs: scene.startMs, previousStartMs: previous.startMs, check: 'CHAPTER_MONOTONIC' });
    }
    chapters.push({ index, sceneId: scene.id, startMs: scene.startMs, title: title.slice(0, 200) });
  }
  if (violations.length > 0) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, `章节时间与正式成片不一致（${String(violations.length)} 处）：拒绝生成发布物`, 422, {
      reason: RENDER_OUTPUTS_ERROR_REASONS.CONSISTENCY_VIOLATION,
      violations,
    });
  }
  checked.push('CHAPTER_WITHIN_DURATION', 'CHAPTER_MONOTONIC');

  // ③ 封面帧位（与渲染 spec 同一规则）+ manifest 产物引用
  const thumbnailAtMs = chooseThumbnailFrameMs({ scenes: scenes.map((scene) => ({ sceneType: scene.sceneType, startMs: scene.startMs, durationMs: scene.durationMs })), durationMs: manifest.renderSettings.durationMs, fps: manifest.renderSettings.fps });
  if (thumbnailAtMs >= manifest.renderSettings.durationMs) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, '封面帧位超出正式成片时长（一致性失败）', 422, {
      reason: RENDER_OUTPUTS_ERROR_REASONS.CONSISTENCY_VIOLATION,
      check: 'THUMBNAIL_WITHIN_DURATION',
      atMs: thumbnailAtMs,
      durationMs: manifest.renderSettings.durationMs,
    });
  }
  checked.push('THUMBNAIL_WITHIN_DURATION');
  const thumbnailOutput = manifest.outputs.find((output) => output.kind === 'THUMBNAIL');
  if (thumbnailOutput === undefined) {
    warnings.push('本渲染无封面产物（THUMBNAIL 缺失——先于 P10-05 的渲染或执行器未产出）：不假称有封面');
  }
  const thumbnail = {
    atMs: thumbnailAtMs,
    frame: Math.round((thumbnailAtMs / 1000) * manifest.renderSettings.fps),
    fileName: thumbnailOutput?.fileName ?? null,
    sha256: thumbnailOutput?.sha256 ?? null,
  };
  checked.push('THUMBNAIL_ARTIFACT_MATCH');

  // ④ 文本来源（冻结快照 sourceBindings → project_sources；悬空引用 = 一致性失败——来源必须可追溯）
  const referencedSourceIds: string[] = [];
  const sourceRefsByScene = new Map<string, string[]>();
  for (const scene of scenes) {
    for (const binding of scene.sourceBindings) {
      sourceRefsByScene.set(binding.sourceId, [...(sourceRefsByScene.get(binding.sourceId) ?? []), scene.id]);
      if (!referencedSourceIds.includes(binding.sourceId)) referencedSourceIds.push(binding.sourceId);
    }
  }
  const sourceRows = referencedSourceIds.length === 0 ? [] : await deps.db.select().from(projectSources).where(and(eq(projectSources.workspaceId, input.workspaceId), inArray(projectSources.id, referencedSourceIds)));
  const sourceById = new Map(sourceRows.map((row) => [row.id, row]));
  const dangling = referencedSourceIds.filter((sourceId) => !sourceById.has(sourceId));
  if (dangling.length > 0) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, `来源引用悬空（${String(dangling.length)} 个）：来源必须可追溯（§86）`, 422, {
      reason: RENDER_OUTPUTS_ERROR_REASONS.CONSISTENCY_VIOLATION,
      check: 'SOURCES_TRACEABLE',
      dangling,
    });
  }
  const sources: OutputSourceEntry[] = referencedSourceIds.map((sourceId) => {
    const row = sourceById.get(sourceId);
    if (row === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'source row missing after check', 500);
    return {
      sourceId,
      title: row.title.slice(0, 500),
      url: row.url.slice(0, 1000),
      publisher: row.publisher.slice(0, 200),
      author: row.author,
      excerpt: row.excerpt.slice(0, 500),
      snapshotKind: row.snapshotKind.slice(0, 40),
      referencedBySceneIds: sourceRefsByScene.get(sourceId) ?? [],
    };
  });
  checked.push('SOURCES_TRACEABLE');

  // ⑤ 素材署名（资产许可元数据；缺署名文本 → warning，不编造）
  const boundAssetIds: string[] = [];
  const assetRoles = new Map<string, string>();
  for (const scene of scenes) {
    for (const binding of scene.assetBindings) {
      if (!boundAssetIds.includes(binding.assetId)) boundAssetIds.push(binding.assetId);
      if (!assetRoles.has(binding.assetId)) assetRoles.set(binding.assetId, binding.role);
    }
  }
  const assetRows = boundAssetIds.length === 0 ? [] : await deps.db.select().from(assets).where(and(eq(assets.workspaceId, input.workspaceId), inArray(assets.id, boundAssetIds)));
  const assetAttributions: OutputAssetAttribution[] = assetRows.map((row) => {
    const license = (row.license ?? {}) as { type?: unknown; attribution?: unknown; sourceUrl?: unknown };
    const metadata = (row.metadata ?? {}) as { stockLicense?: { attributionRequired?: unknown; licenseType?: unknown; sourceUrl?: unknown }; title?: unknown };
    const stock = metadata.stockLicense ?? {};
    const attributionRequired = stock.attributionRequired === true;
    const attributionText = typeof license.attribution === 'string' && license.attribution !== '' ? license.attribution : null;
    if (attributionRequired && attributionText === null) {
      warnings.push(`素材 ${row.id} 标记需署名但缺少署名文本——请补全许可元数据（不编造署名）`);
    }
    return {
      assetId: row.id,
      role: assetRoles.get(row.id) ?? 'visual',
      displayName: typeof metadata.title === 'string' ? metadata.title.slice(0, 200) : null,
      origin: row.origin.slice(0, 40),
      licenseType: typeof license.type === 'string' ? license.type.slice(0, 40) : typeof stock.licenseType === 'string' ? stock.licenseType.slice(0, 40) : null,
      attributionRequired,
      attributionText,
      sourceUrl: typeof license.sourceUrl === 'string' ? license.sourceUrl.slice(0, 1000) : typeof stock.sourceUrl === 'string' ? stock.sourceUrl.slice(0, 1000) : null,
    };
  });
  checked.push('ASSET_ATTRIBUTIONS_RESOLVED');

  // ⑥ 标题建议与描述（模板化派生；逐项可溯源；不虚构卖点）
  const projectRows = await deps.db.select({ title: projects.title }).from(projects).where(and(eq(projects.id, render.projectId), eq(projects.workspaceId, input.workspaceId))).limit(1);
  const projectTitle = projectRows[0]?.title ?? `项目 ${render.projectId}`;
  const summaryScene = scenes.find((scene) => scene.sceneType === 'SUMMARY');
  const summaryText = summaryScene === undefined ? null : sceneText(summaryScene.props);
  const titles = [
    { text: projectTitle, source: 'PROJECT_TITLE' as const },
    ...(summaryText !== null && summaryText !== projectTitle ? [{ text: summaryText.slice(0, 200), source: 'SUMMARY_SCENE' as const }] : []),
    ...(chapters[0] !== undefined && chapters[0].title !== projectTitle && chapters[0].title !== summaryText ? [{ text: chapters[0].title, source: 'CHAPTER_TITLE' as const }] : []),
  ];
  const derivedFrom: string[] = ['PROJECT_TITLE'];
  const descriptionParts: string[] = [projectTitle];
  if (summaryText !== null) {
    descriptionParts.push(summaryText);
    derivedFrom.push('SUMMARY_SCENE');
  }
  if (chapters.length > 0) {
    descriptionParts.push(`章节：${chapters.map((chapter) => chapter.title).join(' / ')}`);
    derivedFrom.push('CHAPTERS');
  }
  if (sources.length > 0) {
    descriptionParts.push(`来源：${sources.map((source, index) => `${String(index + 1)}. ${source.title}（${source.publisher}）`).join('；')}`);
    derivedFrom.push('SOURCES');
  }
  const attributed = assetAttributions.filter((entry) => entry.attributionText !== null);
  if (attributed.length > 0) {
    descriptionParts.push(`素材署名：${attributed.map((entry) => entry.attributionText).join('；')}`);
    derivedFrom.push('ASSET_ATTRIBUTIONS');
  }

  return renderOutputEnhancementsSchema.parse({
    schemaVersion: RENDER_OUTPUT_ENHANCEMENTS_VERSION,
    renderId: render.id,
    projectId: render.projectId,
    projectVersionId: render.input.projectVersionId,
    profile: render.profile,
    manifestHash: render.manifestHash,
    approvalId: approval.id,
    format: { width: manifest.renderSettings.width, height: manifest.renderSettings.height, fps: manifest.renderSettings.fps },
    durationMs: manifest.renderSettings.durationMs,
    titles,
    description: { text: descriptionParts.join('\n\n').slice(0, 5000), derivedFrom },
    chapters,
    sources,
    assetAttributions,
    thumbnail,
    consistency: { checked, warnings: warnings.map((warning) => warning.slice(0, 300)) },
    generatedAt: new Date().toISOString(),
  });
}

