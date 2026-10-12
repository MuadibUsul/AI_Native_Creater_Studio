import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  ASSET_DEFAULT_RETENTION,
  ApiFailure,
  EFFECT_ERROR_REASONS,
  ERROR_CODES,
  compareMediaTime,
  effectLayerMetadataSchema,
  frameRegionSchema,
  mediaTimeSchema,
  mediaTimeToDisplaySecondsText,
  type EditOperation,
  type EffectLayerMetadata,
  type EffectTemplate,
  type FrameRegion,
  type MediaTime,
  type Rational,
} from '@ancs/contracts';
import type { KernelClip, TimelineState } from '@ancs/kernel';
import { assets, assetVersions, projects } from '@ancs/db';
import type { DomainDeps } from './deps.js';
import { agentSecondsToTime } from './agent-operations.js';
import { simulateAgentDraft, type AgentToolContext, type AgentToolDefinition, type AgentToolOutcome } from './agent-tools.js';
import { EFFECT_TEMPLATES, findEffectTemplate, resolveEffectParams } from './effect-templates.js';
import { assertProjectGenerationAllowed } from './project-document.js';

/**
 * V6-3 代码生成特效的导演工具（V6 §7.2）：`list_effects` / `add_effect` / `update_effect`。
 *
 * - 特效 = 特效代码（模板库里的可信代码，或部署方开启后 AI 当场写的代码）+ 参数 + 种子，
 *   由 Worker 在隔离子进程的无头浏览器里渲染成**带透明通道**的图层视频，存成资产，
 *   作为普通片段放在最上层的特效轨（FX）上：位置/大小由片段变换表达，时间由片段范围表达——
 *   预览分段缓存、终渲染、撤销、试改/采用都沿用时间线的同一套机制。
 * - 改参数 / "再来一个"只用同一段代码重渲图层（换参数或种子），不再让 AI 写代码。
 * - 程序化图形受项目制作规则约束（`graphics.procedural`；素材工程默认关闭，用户显式开启），每次渲染前服务端校验。
 * - AI 写的代码先过 Custom Motion 四道门禁（静态分析 / 类型检查 / 沙箱评估 / 抽帧）才渲染；不通过时把门禁报告交还 AI 修改。
 * 这里没有按视频类型或策略分支的逻辑：模板只是 AI 可以选用的组件（裁决 0018）。
 */

/** 工程画布（按画幅）；特效图层按区域占画布的像素尺寸渲染，最长边不超过 MAX_LAYER_SIDE。 */
const CANVAS: Readonly<Record<string, { width: number; height: number }>> = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
  '4:5': { width: 1080, height: 1350 },
};
const MAX_LAYER_SIDE = 960;
const MIN_LAYER_SIDE = 16;
const MIN_SECONDS = 0.2;
const MAX_SECONDS = 20;
const CODE_DEFAULT_SECONDS = 2;
const FULL_FRAME: FrameRegion = { x: 0, y: 0, width: 1, height: 1 };
const CENTER_REGION: FrameRegion = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };
const FX_TRACK_PREFIX = 'FX';

const json = (value: unknown): string => JSON.stringify(value);
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const seconds = (time: MediaTime): string => mediaTimeToDisplaySecondsText(time, 3);

const fail = (message: string, reason: string, details: Record<string, unknown> = {}): AgentToolOutcome =>
  ({ content: json({ error: message, reason, ...details }), isError: true, summary: `effect: ${reason}` });

/** 渲染尺寸：区域在工程画布上的像素尺寸，等比缩到最长边 ≤ MAX_LAYER_SIDE，取偶数。 */
export function effectLayerSize(aspectRatio: string, region: FrameRegion): { width: number; height: number } {
  const canvas = CANVAS[aspectRatio] ?? CANVAS['16:9']!;
  const width = canvas.width * region.width;
  const height = canvas.height * region.height;
  const scale = Math.min(1, MAX_LAYER_SIDE / Math.max(width, height));
  const even = (value: number): number => Math.max(MIN_LAYER_SIDE, Math.round((value * scale) / 2) * 2);
  return { width: even(width), height: even(height) };
}

/** 区域 → 片段变换（锚点在中心、缩放 = 区域尺寸、位移 = 区域左上角；与终渲染/预览的放置几何一致）。 */
export function effectRegionTransform(region: FrameRegion): { position: { x: number; y: number }; scale: { x: number; y: number }; rotationDeg: number; anchor: { x: number; y: number } } {
  return { position: { x: region.x, y: region.y }, scale: { x: region.width, y: region.height }, rotationDeg: 0, anchor: { x: 0.5, y: 0.5 } };
}

/** 序列编辑时基 → 渲染帧率（帧时基 1/30 → 30 fps；异常时基按 30 fps）。 */
function frameRateOf(timebase: Rational): number {
  const fps = timebase.den / timebase.num;
  return Number.isFinite(fps) && fps >= 1 && fps <= 120 ? fps : 30;
}

const trimDecimal = (text: string): string => (text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text);

// ---------------------------------------------------------------------------
// 特效图层资产
// ---------------------------------------------------------------------------

export interface EffectLayerRef {
  footageId: string;
  assetId: string;
  effect: EffectLayerMetadata;
}

/** 读这些资产版本里的特效图层（不是特效的版本不返回）。 */
export async function loadEffectLayers(deps: DomainDeps, workspaceId: string, versionIds: readonly string[]): Promise<Map<string, EffectLayerRef>> {
  if (versionIds.length === 0) return new Map();
  const rows = await deps.db.select({ versionId: assetVersions.id, assetId: assets.id, metadata: assets.metadata }).from(assetVersions)
    .innerJoin(assets, eq(assets.id, assetVersions.assetId))
    .where(and(eq(assetVersions.workspaceId, workspaceId), inArray(assetVersions.id, [...new Set(versionIds)]), eq(assets.assetType, 'CUSTOM_MOTION_RENDER')));
  const out = new Map<string, EffectLayerRef>();
  for (const row of rows) {
    const parsed = effectLayerMetadataSchema.safeParse((row.metadata as { effect?: unknown } | null)?.effect);
    if (parsed.success) out.set(row.versionId, { footageId: row.versionId, assetId: row.assetId, effect: parsed.data });
  }
  return out;
}

/** 时间线上引用的特效图层（给时间线视图、看画面、自检排除用）。 */
export async function effectLayersOnTimeline(context: Pick<AgentToolContext, 'deps' | 'workspaceId'>, timeline: TimelineState, sequenceId: string): Promise<Map<string, EffectLayerRef>> {
  const ids = timeline.clips.filter((clip) => clip.sequenceId === sequenceId && clip.assetVersionId !== null).map((clip) => clip.assetVersionId as string);
  return loadEffectLayers(context.deps, context.workspaceId, ids);
}

interface RenderedLayer {
  footageId: string;
  reused: boolean;
  renderMs: number;
  poster: Uint8Array | null;
}

/**
 * 渲染并存储一个特效图层（同一渲染键 = 同一代码/参数/种子/尺寸/时长 → 复用已有图层，重试与"同样再放一次"不重复渲染）。
 */
async function renderEffectLayer(context: AgentToolContext, effect: Omit<EffectLayerMetadata, 'render' | 'codeSha256'>, layout: { width: number; height: number; fps: number; durationInFrames: number }): Promise<RenderedLayer> {
  const ports = context.effects;
  if (ports === undefined) throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'effect rendering is not available in this deployment', 501, { reason: EFFECT_ERROR_REASONS.RENDERER_UNAVAILABLE });
  const storage = context.deps.storage;
  if (storage === undefined) throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'object storage is not configured', 501, { reason: EFFECT_ERROR_REASONS.RENDERER_UNAVAILABLE });
  const codeSha256 = sha256(effect.code);
  const renderKey = sha256(json({ codeSha256, params: Object.entries(effect.params).sort(([left], [right]) => left.localeCompare(right)), seed: effect.seed, ...layout }));
  const existing = await context.deps.db.select({ versionId: assets.currentVersionId }).from(assets)
    .where(and(eq(assets.workspaceId, context.workspaceId), eq(assets.projectId, context.projectId), eq(assets.assetType, 'CUSTOM_MOTION_RENDER'), eq(assets.status, 'READY'), sql`(${assets.metadata} ->> 'renderKey') = ${renderKey}`))
    .limit(1);
  const reuse = existing[0]?.versionId;
  if (reuse !== undefined && reuse !== null) return { footageId: reuse, reused: true, renderMs: 0, poster: null };

  const output = await ports.renderer.render({ code: effect.code, params: effect.params, seed: effect.seed, ...layout });
  if (output.probe.status !== 'READY') throw new ApiFailure(ERROR_CODES.INTERNAL, 'rendered effect layer is not decodable', 500, { reason: EFFECT_ERROR_REASONS.RENDER_FAILED });
  const metadata: EffectLayerMetadata = effectLayerMetadataSchema.parse({ ...effect, codeSha256, render: { ...layout, renderMs: Math.max(0, Math.round(output.renderMs)) } });
  const assetId = `ast_${randomUUID()}`;
  const versionId = `av_${randomUUID()}`;
  const prefix = `workspaces/${context.workspaceId}/projects/${context.projectId}/effects/${versionId}`;
  await storage.putObject(`${prefix}/layer.mov`, output.video);
  await storage.putObject(`${prefix}/poster.png`, output.poster);
  const durationMs = Math.ceil((layout.durationInFrames * 1000) / layout.fps);
  await context.deps.db.transaction(async (tx) => {
    await tx.insert(assets).values({
      id: assetId, workspaceId: context.workspaceId, projectId: context.projectId, assetType: 'CUSTOM_MOTION_RENDER', origin: 'GENERATED',
      provider: null, providerAssetId: null, status: 'READY', retentionClass: ASSET_DEFAULT_RETENTION.CUSTOM_MOTION_RENDER,
      license: { type: 'USER_OWNED', holder: null, attribution: null, sourceUrl: null, termsUrl: null, notes: `程序化特效图层（${metadata.source === 'TEMPLATE' ? `模板 ${String(metadata.templateId)}` : 'AI 写的代码，已过四道门禁'}）`, confirmedBy: null, confirmedAt: null },
      metadata: { filename: `${metadata.name}.mov`, mimeType: 'video/quicktime', effect: metadata, renderKey, posterStorageKey: `${prefix}/poster.png` },
      currentVersionId: versionId,
      createdBy: context.actorId === 'agent' ? null : context.actorId,
    });
    await tx.insert(assetVersions).values({
      id: versionId, assetId, workspaceId: context.workspaceId, versionNumber: 1, storageKey: `${prefix}/layer.mov`,
      mimeType: 'video/quicktime', sizeBytes: output.video.byteLength, checksumSha256: createHash('sha256').update(output.video).digest('hex'),
      durationMs, width: layout.width, height: layout.height, status: 'READY', probeStatus: 'READY', mediaProbe: output.probe,
      metadata: { effectRenderKey: renderKey },
    });
  });
  return { footageId: versionId, reused: false, renderMs: metadata.render.renderMs, poster: output.poster };
}

// ---------------------------------------------------------------------------
// 时间线放置
// ---------------------------------------------------------------------------

function overlaps(clip: KernelClip, start: MediaTime, end: MediaTime): boolean {
  return compareMediaTime(clip.sequenceRange.start, end) < 0 && compareMediaTime(start, clip.sequenceRange.end) < 0;
}

/** 放特效的轨：已有的 FX 视频轨中该时段空着的那一条；都占用了（或还没有）就在最上面新建一条。 */
function placementTrack(state: TimelineState, sequenceId: string, start: MediaTime, end: MediaTime, ignoreClipId: string | null): { trackId: string; create: EditOperation | null } {
  const tracks = state.tracks.filter((track) => track.sequenceId === sequenceId).sort((left, right) => left.position - right.position);
  const fx = tracks.filter((track) => track.kind === 'VIDEO' && track.name.startsWith(FX_TRACK_PREFIX) && !track.locked);
  for (const track of fx) {
    const busy = state.clips.some((clip) => clip.trackId === track.id && clip.id !== ignoreClipId && overlaps(clip, start, end));
    if (!busy) return { trackId: track.id, create: null };
  }
  const trackId = `trk_${randomUUID()}`;
  const position = tracks.length === 0 ? 0 : Math.max(...tracks.map((track) => track.position)) + 1;
  return { trackId, create: { op: 'create_track', sequenceId, track: { kind: 'VIDEO', position, name: `${FX_TRACK_PREFIX}${String(fx.length + 1)}` }, restoreTrackId: trackId } };
}

function placeLayerOperations(input: {
  state: TimelineState; sequenceId: string; timebase: Rational; footageId: string; at: MediaTime; durationSeconds: string; region: FrameRegion; replaceClipId: string | null;
}): { operations: EditOperation[]; clipId: string; end: MediaTime } {
  const length = agentSecondsToTime(input.durationSeconds, input.timebase);
  const end = mediaTimeSchema.parse({ ticks: (BigInt(input.at.ticks) + BigInt(length.ticks)).toString(), timebase: input.timebase });
  const { trackId, create } = placementTrack(input.state, input.sequenceId, input.at, end, input.replaceClipId);
  const sequence = input.state.sequences.get(input.sequenceId);
  const clipId = `clp_${randomUUID()}`;
  const operations: EditOperation[] = [
    ...(input.replaceClipId === null ? [] : [{ op: 'delete_clip' as const, clipId: input.replaceClipId }]),
    ...(create === null ? [] : [create]),
    ...(sequence !== undefined && compareMediaTime(end, sequence.duration) > 0 ? [{ op: 'set_sequence_duration' as const, sequenceId: input.sequenceId, duration: end }] : []),
    {
      op: 'insert_clip', sequenceId: input.sequenceId, trackId, assetVersionId: input.footageId, nestedSequenceId: null, sourceStreamId: null,
      sourceRange: { start: mediaTimeSchema.parse({ ticks: '0', timebase: input.timebase }), end: length },
      mode: 'OVERWRITE', sequenceStart: input.at, linkAudio: false, audioTrackId: null, createdClipId: clipId, createdAudioClipId: `clp_${randomUUID()}`,
    },
  ];
  const full = input.region.x === 0 && input.region.y === 0 && input.region.width === 1 && input.region.height === 1;
  if (!full) operations.push({ op: 'set_clip_transform', clipId, transform: effectRegionTransform(input.region) });
  return { operations, clipId, end };
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

const secondsSchema = z.union([z.string().max(20), z.number().nonnegative().max(1e6)]).describe('Seconds as a decimal string, e.g. "12.5".');
const paramsSchema = z.record(z.string().regex(/^[a-z][a-zA-Z0-9]{0,31}$/), z.union([z.string().max(40), z.number().finite()]));
const regionInputSchema = frameRegionSchema.describe('Part of the picture, 0–1 from the top-left: { x, y, width, height }.');

const CODE_CONTRACT = [
  'Plain JavaScript, no imports, no TypeScript, no JSX: build elements with React.createElement.',
  'Call registerMotion({ name, component }) exactly once at top level; component is a function component and receives your params as props.',
  'Globals you may use: React, useCurrentFrame, useVideoConfig (width, height, fps, durationInFrames of the layer), interpolate, spring, AbsoluteFill, random(key) (deterministic 0..1 for a string key), Math.',
  'The layer background is transparent: draw only the effect, sized to the layer (the layer is the region you choose). No network, DOM access, timers, storage, eval or dynamic code.',
].join(' ');

function templateView(template: EffectTemplate) {
  return {
    id: template.id,
    name: template.name.en,
    description: template.description,
    coverage: template.coverage,
    defaultSeconds: template.defaultSeconds,
    params: template.params.map((param) => ({ key: param.key, kind: param.kind, description: param.description, default: param.default, ...(param.min === undefined ? {} : { min: param.min }), ...(param.max === undefined ? {} : { max: param.max }), ...(param.options === undefined ? {} : { options: param.options }) })),
  };
}

async function projectAspectRatio(context: AgentToolContext): Promise<string> {
  const rows = await context.deps.db.select({ aspectRatio: projects.aspectRatio }).from(projects).where(eq(projects.id, context.projectId)).limit(1);
  return rows[0]?.aspectRatio ?? '16:9';
}

const listEffectsTool: AgentToolDefinition<Record<string, never>> = {
  descriptor: {
    name: 'list_effects', capability: 'effects.list', effect: 'READ', permission: 'project:read', metered: false,
    description: 'List the visual effects you can add (explosions, glows, sparkles, light leaks, confetti and more), each with its parameters, and the effects already on your draft timeline. Says whether the project rules allow effects and whether you may write your own effect code.',
  },
  input: z.object({}).strict(),
  async run(context) {
    const simulated = await simulateAgentDraft(context, context.draft);
    const layers = await effectLayersOnTimeline(context, simulated.timeline, context.sequenceId);
    const policy = await assertProjectGenerationAllowed(context.deps, { workspaceId: context.workspaceId, projectId: context.projectId, capability: 'graphics.procedural' })
      .then(() => true, () => false);
    const codeWriting = context.effects === undefined ? 'unavailable' : context.effects.codegen === 'enabled' && context.effects.validator !== undefined ? 'enabled' : 'disabled';
    const onTimeline = simulated.timeline.clips.filter((clip) => clip.sequenceId === context.sequenceId && clip.assetVersionId !== null && layers.has(clip.assetVersionId))
      .map((clip) => {
        const layer = layers.get(clip.assetVersionId as string)!;
        return { clipId: clip.id, name: layer.effect.name, template: layer.effect.templateId, params: layer.effect.params, seed: layer.effect.seed, region: layer.effect.region, at: [seconds(clip.sequenceRange.start), seconds(clip.sequenceRange.end)] };
      });
    return {
      content: json({
        allowedByProjectRules: policy,
        ...(policy ? {} : { note: 'The project rules do not allow procedural effects. Tell the person they can turn effects on for this project, then ask again.' }),
        rendering: context.effects === undefined ? 'unavailable in this deployment' : 'available',
        codeWriting,
        ...(codeWriting === 'enabled' ? { codeContract: CODE_CONTRACT, exampleCode: findEffectTemplate('glow')?.code } : {}),
        templates: EFFECT_TEMPLATES.map(templateView),
        onTimeline,
      }),
      isError: false,
      summary: `${String(EFFECT_TEMPLATES.length)} effect templates, ${String(onTimeline.length)} on timeline`,
    };
  },
};

const addEffectInput = z.object({
  template: z.string().max(41).optional().describe('Template id from list_effects.'),
  code: z.string().min(20).max(20_000).optional().describe('Your own effect code, only when list_effects says codeWriting is enabled and no template fits.'),
  name: z.string().min(1).max(80).optional().describe('Short name for an effect written as code.'),
  params: paramsSchema.optional().describe('Parameter values; omitted ones use the template defaults.'),
  at: secondsSchema.optional().describe('Timeline start; defaults to the start of the pointer time range, else 0.'),
  seconds: secondsSchema.optional().describe('How long the effect lasts; defaults to the template suggestion.'),
  region: regionInputSchema.optional().describe('Where in the picture; defaults to the region the person framed, else the whole frame for full-frame templates or a centered half-size box.'),
  seed: z.string().min(1).max(64).optional().describe('Variation seed. Use a new seed for "another one" with the same look.'),
}).strict();

const updateEffectInput = z.object({
  clipId: z.string().min(1).max(200).describe('An effect clip id from list_effects.'),
  params: paramsSchema.optional().describe('Changed parameter values (others keep their current values).'),
  seed: z.string().min(1).max(64).optional().describe('New variation seed.'),
  region: regionInputSchema.optional().describe('New place in the picture.'),
  seconds: secondsSchema.optional().describe('New duration.'),
}).strict();

interface EffectSpec {
  source: 'TEMPLATE' | 'CODE';
  templateId: string | null;
  name: string;
  code: string;
  params: Record<string, string | number>;
  seed: string;
  region: FrameRegion;
  durationSeconds: number;
  issues: string[];
  validation: EffectLayerMetadata['validation'];
}

function clampSeconds(value: number): number {
  return Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, value));
}

function parseSeconds(value: string | number | undefined, fallback: number): number | null {
  if (value === undefined) return fallback;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

/** AI 写的代码：四道门禁（不通过 → 报告交还 AI）。 */
async function validateCode(context: AgentToolContext, code: string, name: string, params: Record<string, string | number>, layout: { width: number; height: number; fps: number; durationInFrames: number }): Promise<EffectLayerMetadata['validation'] | AgentToolOutcome> {
  const validator = context.effects?.validator;
  if (validator === undefined) return fail('writing effect code is not available in this deployment; use a template', EFFECT_ERROR_REASONS.CODEGEN_DISABLED);
  const last = layout.durationInFrames - 1;
  const report = await validator.validate({ code, name, fixture: { props: params, ...layout }, sampleFrames: [...new Set([0, Math.floor(last / 2), last])] });
  if (report.verdict !== 'APPROVED') {
    const failed = report.stages.filter((stage) => !stage.ok).map((stage) => ({ stage: stage.stage, message: stage.message, details: JSON.stringify(stage.details).slice(0, 1500) }));
    return fail('your effect code did not pass the safety and quality checks; fix it and try again', EFFECT_ERROR_REASONS.VALIDATION_REJECTED, { failed, contract: CODE_CONTRACT });
  }
  return { verdict: 'APPROVED', sourceSha256: report.sourceSha256, stages: report.stages.map((stage) => stage.stage) };
}

/** 业务错误（4xx：非法时间、内核拒绝、规则拦截……）作为工具错误交还 AI，由它修正；5xx 照常抛出。 */
async function placeEffect(context: AgentToolContext, spec: EffectSpec, timing: { at: string | number | undefined; replace: KernelClip | null }): Promise<AgentToolOutcome> {
  try {
    return await placeEffectUnguarded(context, spec, timing);
  } catch (error) {
    if (error instanceof ApiFailure && error.httpStatus < 500) return fail(error.message, String(error.details['reason'] ?? error.code), { details: error.details });
    throw error;
  }
}

async function placeEffectUnguarded(context: AgentToolContext, spec: EffectSpec, timing: { at: string | number | undefined; replace: KernelClip | null }): Promise<AgentToolOutcome> {
  const baseline = await simulateAgentDraft(context, context.draft);
  const state = baseline.timeline;
  const sequence = state.sequences.get(context.sequenceId);
  if (sequence === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'sequence not found', 404);
  const timebase = mediaTimeSchema.parse(sequence.duration).timebase;
  const fps = frameRateOf(timebase);
  const durationInFrames = Math.max(2, Math.round(spec.durationSeconds * fps));
  const durationSeconds = trimDecimal((durationInFrames / fps).toFixed(6));
  const at = timing.replace !== null ? timing.replace.sequenceRange.start
    : agentSecondsToTime(timing.at ?? context.pointer?.timeRange?.start ?? '0', timebase);
  const size = effectLayerSize(await projectAspectRatio(context), spec.region);
  const layout = { ...size, fps, durationInFrames };

  let validation = spec.validation;
  // AI 写的代码：新代码必须过门禁；已过门禁的代码改参数时，验证器在就按新参数再验一次（抽帧依赖参数）
  if (spec.source === 'CODE' && (validation === null || context.effects?.validator !== undefined)) {
    const checked = await validateCode(context, spec.code, spec.name, spec.params, layout);
    if (checked !== null && 'isError' in checked) return checked;
    validation = checked;
  }
  let rendered: RenderedLayer;
  try {
    rendered = await renderEffectLayer(context, {
      kind: 'EFFECT_LAYER', source: spec.source, templateId: spec.templateId, name: spec.name, code: spec.code, params: spec.params, seed: spec.seed, region: spec.region, validation,
    }, layout);
  } catch (error) {
    if (error instanceof ApiFailure) return fail(error.message, String(error.details['reason'] ?? error.code));
    // 渲染子进程失败（例如 AI 写的代码在浏览器里运行出错）：如实交还 AI，由它修改或换模板；不自动重试
    return fail(`the effect failed to render: ${(error instanceof Error ? error.message : String(error)).slice(0, 500)}`, EFFECT_ERROR_REASONS.RENDER_FAILED);
  }
  const placed = placeLayerOperations({ state, sequenceId: context.sequenceId, timebase, footageId: rendered.footageId, at, durationSeconds, region: spec.region, replaceClipId: timing.replace?.id ?? null });
  const operations = [...context.draft.operations, ...placed.operations];
  // 整份草稿在内核里试改一次：被拒绝时（4xx）由外层交还 AI
  await simulateAgentDraft(context, { baseRevision: baseline.baseRevision, operations });
  const images = rendered.poster === null ? [] : [{ mediaType: 'image/png' as const, data: Buffer.from(rendered.poster).toString('base64') }];
  return {
    content: json({
      clipId: placed.clipId,
      effect: { name: spec.name, template: spec.templateId, params: spec.params, seed: spec.seed, region: spec.region, at: [seconds(at), seconds(placed.end)] },
      ...(spec.issues.length === 0 ? {} : { paramIssues: spec.issues }),
      render: rendered.reused ? 'reused an identical layer' : `rendered in ${String(rendered.renderMs)} ms`,
      ...(images.length === 0 ? {} : { note: 'the image is the middle frame of the effect layer alone (transparent areas show as empty); it is drawn over the video in the region' }),
    }),
    isError: false,
    summary: `${timing.replace === null ? 'added' : 'updated'} effect "${spec.name}" at ${seconds(at)}s`,
    draftOperations: operations,
    ...(baseline.baseRevision === context.draft.baseRevision ? {} : { baseRevision: baseline.baseRevision }),
    ...(images.length === 0 ? {} : { images }),
  };
}

const addEffectTool: AgentToolDefinition<z.infer<typeof addEffectInput>> = {
  descriptor: {
    name: 'add_effect', capability: 'effects.add', effect: 'DRAFT_EDIT', permission: 'project:write', metered: false,
    description: [
      'Add a visual effect over the video: renders an animated transparent layer and places it on an effects track above the footage, in a region of the picture, for a time range.',
      'Use a template from list_effects (preferred), or your own code when list_effects says codeWriting is enabled and no template fits.',
      'The effect goes into your draft like any edit; the person can move it, change its parameters, or remove it. Takes a few seconds to render.',
    ].join(' '),
  },
  input: addEffectInput,
  async run(context, input) {
    if (context.effects === undefined) return fail('effects are not available in this deployment', EFFECT_ERROR_REASONS.RENDERER_UNAVAILABLE);
    if ((input.template === undefined) === (input.code === undefined)) return fail('give exactly one of template or code', 'AGENT_EDIT_INVALID');
    try {
      await assertProjectGenerationAllowed(context.deps, { workspaceId: context.workspaceId, projectId: context.projectId, capability: 'graphics.procedural' });
    } catch (error) {
      if (error instanceof ApiFailure) return fail('the project rules do not allow procedural effects; the person can turn effects on for this project', 'PRODUCTION_POLICY_BLOCKED');
      throw error;
    }
    const template = input.template === undefined ? undefined : findEffectTemplate(input.template);
    if (input.template !== undefined && template === undefined) return fail(`unknown effect template ${input.template}`, EFFECT_ERROR_REASONS.TEMPLATE_NOT_FOUND, { templates: EFFECT_TEMPLATES.map((item) => item.id) });
    if (input.code !== undefined && (context.effects.codegen !== 'enabled' || context.effects.validator === undefined)) {
      return fail('writing effect code is turned off in this deployment; use a template from list_effects', EFFECT_ERROR_REASONS.CODEGEN_DISABLED);
    }
    const resolved = template === undefined ? { params: input.params ?? {}, issues: [] as string[] } : resolveEffectParams(template, input.params ?? {});
    const duration = parseSeconds(input.seconds, template?.defaultSeconds ?? CODE_DEFAULT_SECONDS);
    if (duration === null) return fail(`invalid seconds ${JSON.stringify(input.seconds)}`, 'AGENT_EDIT_INVALID');
    const region = input.region ?? context.pointer?.frameRegion ?? (template?.coverage === 'FULL_FRAME' ? FULL_FRAME : CENTER_REGION);
    return placeEffect(context, {
      source: template === undefined ? 'CODE' : 'TEMPLATE',
      templateId: template?.id ?? null,
      name: template?.name.en ?? input.name ?? 'Custom effect',
      code: template?.code ?? input.code ?? '',
      params: resolved.params,
      seed: input.seed ?? '1',
      region,
      durationSeconds: clampSeconds(duration),
      issues: resolved.issues,
      validation: null,
    }, { at: input.at, replace: null });
  },
};

const updateEffectTool: AgentToolDefinition<z.infer<typeof updateEffectInput>> = {
  descriptor: {
    name: 'update_effect', capability: 'effects.update', effect: 'DRAFT_EDIT', permission: 'project:write', metered: false,
    description: 'Change an effect already on the timeline: its parameters, variation seed, region or duration. Re-renders the same effect code with the new values (no new code); the clip keeps its start time.',
  },
  input: updateEffectInput,
  async run(context, input) {
    if (context.effects === undefined) return fail('effects are not available in this deployment', EFFECT_ERROR_REASONS.RENDERER_UNAVAILABLE);
    const simulated = await simulateAgentDraft(context, context.draft);
    const clip = simulated.timeline.clips.find((item) => item.id === input.clipId && item.sequenceId === context.sequenceId);
    if (clip === undefined) return fail(`clip ${input.clipId} is not on this timeline`, 'AGENT_EDIT_INVALID');
    const layer = clip.assetVersionId === null ? undefined : (await loadEffectLayers(context.deps, context.workspaceId, [clip.assetVersionId])).get(clip.assetVersionId);
    if (layer === undefined) return fail(`clip ${input.clipId} is not an effect`, EFFECT_ERROR_REASONS.NOT_AN_EFFECT);
    try {
      await assertProjectGenerationAllowed(context.deps, { workspaceId: context.workspaceId, projectId: context.projectId, capability: 'graphics.procedural' });
    } catch (error) {
      if (error instanceof ApiFailure) return fail('the project rules do not allow procedural effects; the person can turn effects on for this project', 'PRODUCTION_POLICY_BLOCKED');
      throw error;
    }
    const current = layer.effect;
    const template = current.templateId === null ? undefined : findEffectTemplate(current.templateId);
    const merged = { ...current.params, ...input.params };
    const resolved = template === undefined ? { params: merged, issues: [] as string[] } : resolveEffectParams(template, merged);
    const currentSeconds = current.render.durationInFrames / current.render.fps;
    const duration = parseSeconds(input.seconds, currentSeconds);
    if (duration === null) return fail(`invalid seconds ${JSON.stringify(input.seconds)}`, 'AGENT_EDIT_INVALID');
    return placeEffect(context, {
      source: current.source,
      templateId: current.templateId,
      name: current.name,
      // 模板以当前版本的模板代码为准（模板库升级后改参数也用新代码）；AI 写的代码原样复用
      code: template?.code ?? current.code,
      params: resolved.params,
      seed: input.seed ?? current.seed,
      region: input.region ?? current.region,
      durationSeconds: clampSeconds(duration),
      issues: resolved.issues,
      validation: current.validation,
    }, { at: undefined, replace: clip });
  },
};

export const EFFECT_AGENT_TOOLS = [listEffectsTool, addEffectTool, updateEffectTool] as const;
