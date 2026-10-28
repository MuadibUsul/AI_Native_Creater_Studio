import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  AIGC_EXPLICIT_TEXT,
  ApiFailure,
  COMPOSITION_FINAL_RENDER_ERROR_REASONS,
  COMPOSITION_FINAL_RENDER_WORKFLOW,
  COMPOSITION_FINAL_RENDER_WORKFLOW_VERSION,
  ERROR_CODES,
  contentLabelLanguageSchema,
  finalRenderProfileSchema,
  renderPlanSchema,
  serializeAigcMetadata,
  startCompositionFinalRenderRequestSchema,
  type ContentLabel,
  type ContentLabelLanguage,
  type FinalRenderProfile,
  type RenderPlan,
  type RenderPlanExecutionFile,
  type RenderPlanExecutor,
  type SourceMediaProbe,
  type StartCompositionFinalRenderRequest,
  type WorkflowRun,
} from '@ancs/contracts';
import { assets, assetVersions, projectSequences } from '@ancs/db';
import { assertRenderPlanSupported, requirementsForDelivery } from '@ancs/kernel';
import type { DomainDeps } from './deps.js';
import { assertRenderProfileAllowed, resolveRenderPriority } from './plans.js';
import { compileSequenceRenderPlan } from './playback.js';
import { createProjectVersionInTx } from './versions.js';
import { startWorkflow, type WorkflowDefinition, type WorkflowStepContext } from './workflow.js';

/**
 * V5-M4（§11.2 FinalRender）：素材工程终渲染工作流——冻结 → 渲染 → 技术 QA。
 *
 * - freeze：同一一致性快照（REPEATABLE READ）内编译 RenderPlan 并建 FINAL_RENDER 项目版本；revision 与发起时不一致 → 409；
 *   后端能力不足 → 501（在任何渲染工作之前）。计划 JSON 存入运行上下文，此后不可变（冻结清单）。
 * - render：按计划逐个取冻结源字节，**哈希必须等于计划记录的校验和**（源被替换/损坏 → 不可重试失败）；
 *   执行器只消费 RenderPlan；产物逐文件复核哈希后落自有存储（SYSTEM_RENDER，按 (runId, kind) 幂等）。
 * - qa：从存储重新读回产物（读真实输出，不信执行回执）：解码检查、编码/画幅/帧数/声道/采样率、Manifest 的 planHash
 *   与产物哈希；任一不符 → 不可重试失败，补偿把产物标为不可交付（FAILED + 草稿保留期）。
 */

export interface CompositionFinalRenderPorts {
  executor: RenderPlanExecutor;
  /** 读真实输出的探测器（QA） */
  outputProbe: SourceMediaProbe;
  workDirRoot?: string;
  /** AI 生成合成内容标识：服务提供者编码（运营方配置；未配置时元数据里为空串，导出结果如实报告） */
  aigc?: { producerCode?: string };
}

/** 视为 AI 生成合成媒体的资产来源（付费生成的镜头与数字人、合成讲述、AI 写的特效图层都记为 GENERATED） */
const AI_GENERATED_ORIGINS = ['GENERATED', 'PROVIDER_GENERATED'];
/** 显式标识在开头的持续秒数（标准要求 ≥2 秒） */
const AIGC_EXPLICIT_SECONDS = 3;
/** 未指定语言时的显式标识语言（面向全球市场：英文） */
const DEFAULT_LABEL_LANGUAGE: ContentLabelLanguage = 'en';

/** 成片含 AI 生成合成媒体时的标识（显式文字按导出语言 + 文件元数据）；不含则为 null */
export function contentLabelFor(input: { generatedSources: number; runId: string; producerCode: string | undefined; language?: ContentLabelLanguage }): ContentLabel | null {
  if (input.generatedSources === 0) return null;
  const producer = input.producerCode ?? '';
  return {
    explicitText: AIGC_EXPLICIT_TEXT[input.language ?? DEFAULT_LABEL_LANGUAGE],
    explicitSeconds: AIGC_EXPLICIT_SECONDS,
    metadata: { Label: '1', ContentProducer: producer, ProduceID: input.runId, ReservedCode1: '', ContentPropagator: producer, PropagateID: input.runId, ReservedCode2: '' },
  };
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const ARTIFACT_META: Record<RenderPlanExecutionFile['kind'], { assetType: string; mimeType: string }> = {
  VIDEO: { assetType: 'FINAL_VIDEO', mimeType: 'video/mp4' },
  SUBTITLE_SRT: { assetType: 'SUBTITLE', mimeType: 'application/x-subrip' },
  SUBTITLE_VTT: { assetType: 'SUBTITLE', mimeType: 'text/vtt' },
  MANIFEST: { assetType: 'MANIFEST', mimeType: 'application/json' },
};

const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
  'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac',
};

interface FrozenOutput {
  plan: RenderPlan;
  projectVersionId: string;
  planHash: string;
  /** 用到的 AI 生成合成媒体（冻结时按资产来源判定；旧运行没有此字段） */
  aiGenerated?: { assetVersionId: string; assetType: string }[];
}
interface RenderedOutput {
  graphHash: string;
  frameCount: string;
  sampleCount: string;
  outputs: { kind: RenderPlanExecutionFile['kind']; fileName: string; assetId: string; assetVersionId: string; sha256: string; sizeBytes: number }[];
  /** 加在成片上的 AI 生成合成内容标识；null = 不含 AI 生成合成媒体 */
  contentLabel?: ContentLabel | null;
}

function failure(reason: string, message: string, status: number, details: Record<string, unknown> = {}): ApiFailure {
  return new ApiFailure(status === 409 ? ERROR_CODES.PRECONDITION_FAILED : status === 422 ? ERROR_CODES.VALIDATION_FAILED : status === 501 ? ERROR_CODES.CAPABILITY_UNAVAILABLE : ERROR_CODES.INTERNAL, message, status, { reason, ...details });
}

const inputOf = (context: WorkflowStepContext): { sequenceId: string; profile: FinalRenderProfile; expectedRevision: number | undefined; labelLanguage: ContentLabelLanguage | undefined } => {
  const raw = context.run.input as { sequenceId?: unknown; profile?: unknown; expectedRevision?: unknown; labelLanguage?: unknown };
  if (typeof raw.sequenceId !== 'string') throw failure('FINAL_RENDER_INPUT_INVALID', 'workflow input missing sequenceId', 500);
  const labelLanguage = contentLabelLanguageSchema.safeParse(raw.labelLanguage);
  return {
    sequenceId: raw.sequenceId, profile: finalRenderProfileSchema.parse(raw.profile),
    expectedRevision: typeof raw.expectedRevision === 'number' ? raw.expectedRevision : undefined,
    labelLanguage: labelLanguage.success ? labelLanguage.data : undefined,
  };
};

/** 产物落自有存储（按 (runId, kind) 幂等：重试/崩溃恢复不产生重复资产行；内容变化则追加新版本）。 */
async function persistArtifact(deps: DomainDeps, input: { workspaceId: string; projectId: string; runId: string; kind: RenderPlanExecutionFile['kind']; fileName: string; bytes: Uint8Array; sha256: string; planHash: string }): Promise<{ assetId: string; assetVersionId: string }> {
  const storage = deps.storage;
  if (storage === undefined) throw failure(COMPOSITION_FINAL_RENDER_ERROR_REASONS.STORAGE_UNAVAILABLE, '未配置对象存储：产物必须落自有存储', 501);
  const meta = ARTIFACT_META[input.kind];
  const existing = await deps.db.select({ id: assets.id, currentVersionId: assets.currentVersionId }).from(assets)
    .where(and(eq(assets.workspaceId, input.workspaceId), sql`(${assets.metadata} ->> 'workflowRunId') = ${input.runId}`, sql`(${assets.metadata} ->> 'kind') = ${input.kind}`)).limit(1);
  const found = existing[0];
  if (found !== undefined && found.currentVersionId !== null) {
    const current = await deps.db.select({ checksumSha256: assetVersions.checksumSha256 }).from(assetVersions).where(eq(assetVersions.id, found.currentVersionId)).limit(1);
    if (current[0]?.checksumSha256 === input.sha256) return { assetId: found.id, assetVersionId: found.currentVersionId };
  }
  // 版本不可变：每个版本独立对象键（重渲内容变化时追加新版本，不覆盖旧字节）
  const versionId = `av_${randomUUID()}`;
  const storageKey = `workspaces/${input.workspaceId}/projects/${input.projectId}/final-renders/${input.runId}/${versionId}/${input.fileName}`;
  await storage.putObject(storageKey, input.bytes);
  const assetId = found?.id ?? `ast_${randomUUID()}`;
  await deps.db.transaction(async (tx) => {
    if (found === undefined) {
      await tx.insert(assets).values({
        id: assetId, workspaceId: input.workspaceId, projectId: input.projectId, assetType: meta.assetType, origin: 'SYSTEM_RENDER',
        provider: null, providerAssetId: null, status: 'READY', retentionClass: 'KEEP_FINAL',
        license: { type: 'SYSTEM_GENERATED', holder: null, attribution: null, sourceUrl: null, termsUrl: null, notes: `素材工程终渲染产物（workflowRun=${input.runId}，kind=${input.kind}）`, confirmedBy: null, confirmedAt: null },
        metadata: { workflowRunId: input.runId, kind: input.kind, planHash: input.planHash },
        currentVersionId: versionId,
      });
    }
    const maxRows = await tx.select({ max: sql<number>`coalesce(max(${assetVersions.versionNumber}), 0)` }).from(assetVersions).where(eq(assetVersions.assetId, assetId));
    await tx.insert(assetVersions).values({
      id: versionId, assetId, workspaceId: input.workspaceId, versionNumber: Number(maxRows[0]?.max ?? 0) + 1, storageKey,
      mimeType: meta.mimeType, sizeBytes: input.bytes.byteLength, checksumSha256: input.sha256, status: 'READY',
      metadata: { workflowRunId: input.runId, kind: input.kind },
    });
    if (found !== undefined) await tx.update(assets).set({ currentVersionId: versionId, updatedAt: new Date() }).where(eq(assets.id, assetId));
  });
  return { assetId, assetVersionId: versionId };
}

export function compositionFinalRenderWorkflow(ports: CompositionFinalRenderPorts): WorkflowDefinition {
  return {
    type: COMPOSITION_FINAL_RENDER_WORKFLOW,
    version: COMPOSITION_FINAL_RENDER_WORKFLOW_VERSION,
    steps: [
      {
        key: 'freeze',
        maxAttempts: 2,
        async run(context) {
          const { sequenceId, profile, expectedRevision } = inputOf(context);
          const projectId = context.run.projectId as string;
          const scope = { workspaceId: context.run.workspaceId, projectId, sequenceId };
          // 同一一致性快照内编译计划并建冻结版本（编辑并发时二者对应同一 revision）
          const frozen = await context.deps.db.transaction(async (tx) => {
            const plan = await compileSequenceRenderPlan({ ...context.deps, db: tx }, scope);
            if (expectedRevision !== undefined && plan.documentRevision !== expectedRevision) {
              throw new ApiFailure(ERROR_CODES.VERSION_CONFLICT, '工程在发起导出后又被修改：请确认最新版本后重新导出', 409, {
                reason: COMPOSITION_FINAL_RENDER_ERROR_REASONS.REVISION_CHANGED, expectedRevision, actualRevision: plan.documentRevision,
              });
            }
            assertRenderPlanSupported(requirementsForDelivery(plan, profile), ports.executor.capabilities);
            const version = await createProjectVersionInTx(tx, { workspaceId: context.run.workspaceId, projectId, reason: 'FINAL_RENDER', note: `素材工程终渲染（${context.run.id}）` });
            return { plan, projectVersionId: version.id };
          }, { isolationLevel: 'repeatable read' });
          const sourceIds = frozen.plan.sources.map((source) => source.assetVersionId);
          const aiGenerated = sourceIds.length === 0 ? [] : await context.deps.db.select({ assetVersionId: assetVersions.id, assetType: assets.assetType })
            .from(assetVersions).innerJoin(assets, eq(assets.id, assetVersions.assetId))
            .where(and(eq(assetVersions.workspaceId, context.run.workspaceId), inArray(assetVersions.id, sourceIds), inArray(assets.origin, AI_GENERATED_ORIGINS)));
          const output: FrozenOutput = { plan: frozen.plan, projectVersionId: frozen.projectVersionId, planHash: frozen.plan.planHash, aiGenerated };
          return { kind: 'DONE', output: output as unknown as Record<string, unknown> };
        },
      },
      {
        key: 'render',
        maxAttempts: 2,
        async run(context) {
          const frozen = context.run.outputs['freeze'] as FrozenOutput;
          const plan = renderPlanSchema.parse(frozen.plan);
          const { profile, labelLanguage } = inputOf(context);
          const storage = context.deps.storage;
          if (storage === undefined) throw failure(COMPOSITION_FINAL_RENDER_ERROR_REASONS.STORAGE_UNAVAILABLE, '未配置对象存储：冻结源与产物必须走自有存储', 501);
          const projectId = context.run.projectId as string;
          const workDir = await mkdtemp(join(ports.workDirRoot ?? tmpdir(), 'ancs-final-'));
          try {
            await mkdir(join(workDir, 'assets'), { recursive: true });
            const versionRows = plan.sources.length === 0 ? [] : await context.deps.db.select({
              id: assetVersions.id, storageKey: assetVersions.storageKey, checksumSha256: assetVersions.checksumSha256, mimeType: assetVersions.mimeType,
            }).from(assetVersions).where(and(eq(assetVersions.workspaceId, context.run.workspaceId), inArray(assetVersions.id, plan.sources.map((source) => source.assetVersionId))));
            const staged: { assetVersionId: string; fileName: string }[] = [];
            for (const [index, source] of plan.sources.entries()) {
              const row = versionRows.find((candidate) => candidate.id === source.assetVersionId);
              if (row === undefined || row.storageKey === null || row.checksumSha256 !== source.checksumSha256) {
                throw failure(COMPOSITION_FINAL_RENDER_ERROR_REASONS.SOURCE_CHANGED, `冻结源已不可用或校验和已变：${source.assetVersionId}`, 409, { assetVersionId: source.assetVersionId });
              }
              const bytes = await storage.getObject(row.storageKey);
              if (bytes === null || sha256(bytes) !== source.checksumSha256) {
                throw failure(COMPOSITION_FINAL_RENDER_ERROR_REASONS.SOURCE_INTEGRITY_FAILED, `冻结源字节与计划校验和不一致：${source.assetVersionId}`, 409, { assetVersionId: source.assetVersionId });
              }
              const fileName = `src_${String(index)}.${EXTENSION_BY_MIME[row.mimeType.split(';')[0]?.trim() ?? ''] ?? 'bin'}`;
              await writeFile(join(workDir, 'assets', fileName), bytes);
              staged.push({ assetVersionId: source.assetVersionId, fileName });
            }
            const contentLabel = contentLabelFor({ generatedSources: frozen.aiGenerated?.length ?? 0, runId: context.run.id, producerCode: ports.aigc?.producerCode, ...(labelLanguage === undefined ? {} : { language: labelLanguage }) });
            const result = await ports.executor.execute({ plan, profile, workDir, sources: staged, label: contentLabel });
            if (result.planHash !== plan.planHash) throw failure('FINAL_RENDER_PLAN_MISMATCH', '执行回执的 planHash 与冻结计划不一致', 500);
            const outputs: RenderedOutput['outputs'] = [];
            for (const file of result.files) {
              const bytes = await readFile(join(workDir, 'out', file.fileName));
              const digest = sha256(bytes);
              if (digest !== file.sha256) throw failure('FINAL_RENDER_ARTIFACT_INTEGRITY_FAILED', `产物 ${file.fileName} 哈希与执行回执不一致`, 500);
              const persisted = await persistArtifact(context.deps, { workspaceId: context.run.workspaceId, projectId, runId: context.run.id, kind: file.kind, fileName: file.fileName, bytes, sha256: digest, planHash: plan.planHash });
              outputs.push({ kind: file.kind, fileName: file.fileName, sha256: digest, sizeBytes: bytes.byteLength, ...persisted });
            }
            const output: RenderedOutput = { graphHash: result.graphHash, frameCount: result.frameCount, sampleCount: result.sampleCount, outputs, contentLabel };
            return { kind: 'DONE', output: output as unknown as Record<string, unknown> };
          } finally {
            await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
          }
        },
        // QA 失败或取消：产物不可交付（保留供排查，按草稿保留期清理）
        async compensate(context) {
          const rendered = context.run.outputs['render'] as RenderedOutput | undefined;
          const ids = rendered?.outputs.map((output) => output.assetId) ?? [];
          if (ids.length === 0) return;
          await context.deps.db.update(assets).set({ status: 'FAILED', retentionClass: 'DRAFT_RENDER_30D', updatedAt: new Date() })
            .where(and(eq(assets.workspaceId, context.run.workspaceId), inArray(assets.id, ids)));
        },
      },
      {
        key: 'qa',
        maxAttempts: 2,
        async run(context) {
          const frozen = context.run.outputs['freeze'] as FrozenOutput;
          const rendered = context.run.outputs['render'] as RenderedOutput;
          const plan = renderPlanSchema.parse(frozen.plan);
          const { profile } = inputOf(context);
          const storage = context.deps.storage;
          if (storage === undefined) throw failure(COMPOSITION_FINAL_RENDER_ERROR_REASONS.STORAGE_UNAVAILABLE, '未配置对象存储', 501);
          const checks: { name: string; passed: boolean; expected: unknown; actual: unknown }[] = [];
          const check = (name: string, expected: unknown, actual: unknown): void => { checks.push({ name, passed: JSON.stringify(expected) === JSON.stringify(actual), expected, actual }); };
          // 从存储读回（读真实输出，不信执行回执）
          const readBack = async (kind: RenderPlanExecutionFile['kind']): Promise<Uint8Array | null> => {
            const output = rendered.outputs.find((candidate) => candidate.kind === kind);
            if (output === undefined) return null;
            const row = (await context.deps.db.select({ storageKey: assetVersions.storageKey }).from(assetVersions).where(eq(assetVersions.id, output.assetVersionId)).limit(1))[0];
            const bytes = row?.storageKey == null ? null : await storage.getObject(row.storageKey);
            check(`${kind}.storedHash`, output.sha256, bytes === null ? null : sha256(bytes));
            return bytes;
          };
          const video = await readBack('VIDEO');
          const manifestBytes = await readBack('MANIFEST');
          check('captions.sidecar', plan.captions.length > 0, rendered.outputs.some((output) => output.kind === 'SUBTITLE_SRT') && rendered.outputs.some((output) => output.kind === 'SUBTITLE_VTT'));
          if (manifestBytes !== null) {
            const manifest = JSON.parse(Buffer.from(manifestBytes).toString('utf8')) as { planHash?: string; graphHash?: string; frameCount?: string };
            check('manifest.planHash', plan.planHash, manifest.planHash);
            check('manifest.graphHash', rendered.graphHash, manifest.graphHash);
            check('manifest.frameCount', rendered.frameCount, manifest.frameCount);
          }
          // AI 生成合成内容的隐式标识必须真的写进了成片文件（执行器忽略标识时在这里拦下，不交付无标识的文件）
          if (video !== null && rendered.contentLabel != null) {
            check('aigc.metadata', true, Buffer.from(video).includes(Buffer.from(serializeAigcMetadata(rendered.contentLabel.metadata), 'utf8')));
          }
          if (video !== null) {
            const workDir = await mkdtemp(join(ports.workDirRoot ?? tmpdir(), 'ancs-final-qa-'));
            try {
              const filePath = join(workDir, 'final.mp4');
              await writeFile(filePath, video);
              const probe = await ports.outputProbe.probe({ filePath, declaredMimeType: 'video/mp4' });
              const videoStream = probe.streams.find((stream) => stream.type === 'VIDEO');
              const audioStream = probe.streams.find((stream) => stream.type === 'AUDIO');
              check('decode', 'PASSED', probe.decodeCheck.status);
              check('video.codec', 'h264', videoStream?.codecName ?? null);
              check('video.size', [profile.width, profile.height], [videoStream?.width ?? null, videoStream?.height ?? null]);
              check('video.frameCount', rendered.frameCount, videoStream?.frameCount ?? null);
              check('audio.codec', 'aac', audioStream?.codecName ?? null);
              check('audio.layout', [48_000, 2], [audioStream?.sampleRate ?? null, audioStream?.channels ?? null]);
            } finally {
              await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
            }
          }
          const failed = checks.filter((item) => !item.passed);
          if (video === null || manifestBytes === null || failed.length > 0) {
            throw failure(COMPOSITION_FINAL_RENDER_ERROR_REASONS.QA_FAILED, `技术 QA 未通过：${failed.map((item) => item.name).join(', ') || '缺少成片或 Manifest'}`, 422, { failedChecks: failed });
          }
          return { kind: 'DONE', output: { passed: true, checks } };
        },
      },
    ],
  };
}

/** 发起素材工程终渲染（API 入口）：权益/档位检查后启动工作流；幂等键命中返回同一运行。 */
export async function startCompositionFinalRender(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; sequenceId: string; request: StartCompositionFinalRenderRequest; idempotencyKey?: string | null; createdBy?: string | null },
): Promise<WorkflowRun> {
  const request = startCompositionFinalRenderRequestSchema.parse(input.request);
  const sequence = await deps.db.select({ id: projectSequences.id }).from(projectSequences).where(and(
    eq(projectSequences.id, input.sequenceId), eq(projectSequences.workspaceId, input.workspaceId), eq(projectSequences.projectId, input.projectId),
  )).limit(1);
  if (sequence[0] === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'sequence not found', 404);
  // 超过 1080p 的画布按 4K 权益判定（与旧渲染档位 PREMIUM_4K 同一权益）
  if (request.profile.width * request.profile.height > 1920 * 1080) await assertRenderProfileAllowed(deps, { workspaceId: input.workspaceId, profile: 'PREMIUM_4K' });
  const priority = await resolveRenderPriority(deps, { workspaceId: input.workspaceId });
  return startWorkflow(deps, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    type: COMPOSITION_FINAL_RENDER_WORKFLOW,
    version: COMPOSITION_FINAL_RENDER_WORKFLOW_VERSION,
    subjectRef: `sequence:${input.sequenceId}`,
    input: {
      sequenceId: input.sequenceId, profile: request.profile,
      ...(request.expectedRevision === undefined ? {} : { expectedRevision: request.expectedRevision }),
      ...(request.labelLanguage === undefined ? {} : { labelLanguage: request.labelLanguage }),
    },
    idempotencyKey: input.idempotencyKey ?? null,
    createdBy: input.createdBy ?? null,
    priority,
  });
}
