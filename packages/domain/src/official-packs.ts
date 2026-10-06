import {
  SHORT_LAYOUT_PROP_KEY,
  SHORT_VALIDATION_CODES,
  SHORT_VERTICAL_FRAME,
  SHORT_VERTICAL_SAFE_AREA,
  packManifestSchema,
  shortSceneLayoutSchema,
  type ChannelRecipe,
  type ContentAtom,
  type DerivedSceneGraphPayload,
  type OutputPlan,
  type PackPlugin,
  type RestrictedPluginContext,
  type Scene,
  type ValidationResult,
} from '@ancs/contracts';
import { estimateDurationMs } from './narrative-repair.js';

/**
 * 官方 Pack：Shorts Analyzer / Shorts Pack（P11-03 analyze；P12-01 generate+validate / §92.1、§93.2）。
 *
 * 定位：**从 Atom 重新编导**（不机械裁切长视频时间轴，REQ-93-03）——
 * - analyze：Fit/Atom → 规划（P11-03）；
 * - generate：单主题 Atom → 9:16 派生 Scene Graph（Hook 前置 / 逐句字幕 / 来源卡；**不写回源项目**）；
 * - validate：对照 Recipe 时长窗口、竖屏安全区、来源链、Hook 规则逐项检查（问题逐条，不静默）。
 * 纯逻辑：不触 DB、不持 Secret——数据全部来自能力门控后的 ctx.data。
 */

export const SHORTS_ANALYZER_MANIFEST = packManifestSchema.parse({
  manifestVersion: 'pack-manifest-v1',
  packId: 'ancs.pack.shorts-analyzer',
  name: 'Shorts Analyzer',
  version: '1.0.0',
  description: '从 Atom/Fit 产出 Short 规划骨架（官方 Pack；证明 Pack 公开契约可工作）',
  capabilities: ['read_content_core'],
  compatibility: { coreRange: '>=1.0.0', sceneGraphSchemaVersion: null },
  outputFormats: ['shorts_9x16'],
  defaultChannelKey: 'SHORT_INSIGHT',
  quota: null,
  signature: null,
});

const MAX_PLAN_ATOMS = 3;
const HOOK_MAX_MS = 3000;

/** Atom 优先级（可传播性）：KEY_NUMBER > SUB_TOPIC > 其余 */
const atomWeight = (kind: string): number => (kind === 'KEY_NUMBER' ? 0 : kind === 'SUB_TOPIC' ? 1 : 2);

const sortAtoms = (atoms: readonly ContentAtom[]): ContentAtom[] =>
  [...atoms].sort((left, right) => atomWeight(left.kind) - atomWeight(right.kind) || left.createdAt.localeCompare(right.createdAt));

/** 句子切分（逐字保留；标点随句） */
const splitSentences = (text: string): string[] =>
  text
    .split(/(?<=[。！？!?；;.\n])/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

/** Hook 文本：Atom 标题 ≤3s → 用标题；否则首句 ≤3s → 用首句；否则截断（截断即披露 source=TRUNCATED）。 */
function buildHook(atom: ContentAtom): { text: string; source: 'ATOM_TITLE' | 'ATOM_FIRST_SENTENCE' | 'TRUNCATED' } {
  if (estimateDurationMs(atom.title) <= HOOK_MAX_MS) return { text: atom.title, source: 'ATOM_TITLE' };
  const first = splitSentences(atom.text)[0] ?? atom.text;
  if (estimateDurationMs(first) <= HOOK_MAX_MS) return { text: first, source: 'ATOM_FIRST_SENTENCE' };
  // 220 字/分钟 ≈ 3s → 11 字；保守取 10 字 + 省略号
  return { text: `${[...first].slice(0, 10).join('')}…`, source: 'TRUNCATED' };
}

/** 场景布局盒（全部落在安全区内；role 决定纵向带位） */
const LAYOUT_BOXES = {
  HOOK: { x: 48, y: 560, width: 984, height: 420 },
  CONTENT: { x: 48, y: 620, width: 984, height: 680 },
  SOURCE: { x: 48, y: 1320, width: 984, height: 260 },
} as const;

/** 稳定的内容指纹（同一文本 → 同一场景 id；重生成产物可对账） */
function hashText(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return hash;
}

function makeScene(input: {
  position: number;
  startMs: number;
  durationMs: number;
  role: 'HOOK' | 'CONTENT' | 'SOURCE';
  semanticType: string;
  componentId: string;
  text: string;
  props: Record<string, unknown>;
}): Scene {
  return {
    id: `scene_short_${String(input.position)}_${String(Math.abs(hashText(`${input.semanticType}:${input.text}`)))}`,
    revision: 1,
    position: input.position,
    startMs: input.startMs,
    durationMs: input.durationMs,
    semanticType: input.semanticType,
    sceneType: input.role,
    narrationBlockIds: [],
    narration: input.role === 'HOOK' ? '' : input.text,
    visualIntent: '',
    componentId: input.componentId,
    componentVersion: null,
    props: { ...input.props, [SHORT_LAYOUT_PROP_KEY]: { role: input.role, box: LAYOUT_BOXES[input.role] } },
    providerRequirement: null,
    sourceBindings: [],
    dataBindings: [],
    assetBindings: [],
    transition: { in: null, out: null },
    locked: false,
    approved: false,
    needsReview: false,
    status: 'PLACEHOLDER',
  };
}

/** 来源 → Atom 链（claimIds 直接来自 ref；sourceIds = ref.sourceId ∪ claim→source 索引） */
function provenanceFor(atom: ContentAtom, sceneId: string, claimSources: Map<string, string[]>): DerivedSceneGraphPayload['provenance'][number] {
  const claimIds = atom.sourceRefs.map((ref) => ref.claimId).filter((value): value is string => value !== null);
  const sourceIds = new Set(atom.sourceRefs.map((ref) => ref.sourceId).filter((value): value is string => value !== null));
  for (const claimId of claimIds) {
    for (const sourceId of claimSources.get(claimId) ?? []) sourceIds.add(sourceId);
  }
  return { sceneId, atomId: atom.id, claimIds, sourceIds: [...sourceIds] };
}

function generateShorts(ctx: RestrictedPluginContext): DerivedSceneGraphPayload {
  const atoms = sortAtoms(ctx.data.atoms);
  const primary = atoms[0];
  const projectId = ctx.projectId;
  if (primary === undefined) {
    throw new Error('Shorts Pack 无法生成：项目无 Atom（先创建 Content Atom）');
  }
  if (projectId === null) {
    throw new Error('Shorts Pack 无法生成：上下文缺少 projectId（项目域插件必须携带项目）');
  }
  const claimSources = new Map(ctx.data.claimSources.map((entry) => [entry.claimId, entry.sourceIds]));
  const recipe = ctx.data.recipe;
  const windowMax = recipe?.requirements.durationMaxMs ?? 90_000;
  const sourceSceneMs = 4000;

  const hook = buildHook(primary);
  const hookScene = makeScene({
    position: 0,
    startMs: 0,
    durationMs: Math.max(1200, Math.min(estimateDurationMs(hook.text), HOOK_MAX_MS)),
    role: 'HOOK',
    semanticType: 'HOOK',
    componentId: primary.kind === 'KEY_NUMBER' ? 'BIG_NUMBER' : 'SUMMARY',
    text: hook.text,
    props: { text: hook.text, atomId: primary.id, kind: primary.kind, ...primary.payload },
  });

  // 内容场景：逐句采用（1 句/场景）；累积时长不超窗口（超出部分 = 节选，coverage 披露）
  const sentences = splitSentences(primary.text);
  const budgetMs = windowMax - hookScene.durationMs - sourceSceneMs;
  const contentScenes: Scene[] = [];
  let usedMs = 0;
  let startMs = hookScene.durationMs;
  let sentencesUsed = 0;
  for (const sentence of sentences) {
    const durationMs = estimateDurationMs(sentence);
    if (contentScenes.length > 0 && usedMs + durationMs > budgetMs) break;
    contentScenes.push(
      makeScene({
        position: contentScenes.length + 1,
        startMs,
        durationMs,
        role: 'CONTENT',
        semanticType: 'TEXTUAL_EXPLANATION',
        componentId: 'SUMMARY',
        text: sentence,
        props: { text: sentence, atomId: primary.id, kind: primary.kind },
      }),
    );
    usedMs += durationMs;
    startMs += durationMs;
    sentencesUsed += 1;
  }
  if (contentScenes.length === 0) {
    // 单句即超预算也要有内容场景（否则短片为空壳）；节选披露由 coverage 承担
    const sentence = sentences[0] ?? primary.text;
    const durationMs = estimateDurationMs(sentence);
    contentScenes.push(
      makeScene({
        position: 1,
        startMs,
        durationMs,
        role: 'CONTENT',
        semanticType: 'TEXTUAL_EXPLANATION',
        componentId: 'SUMMARY',
        text: sentence,
        props: { text: sentence, atomId: primary.id, kind: primary.kind },
      }),
    );
    startMs += durationMs;
    sentencesUsed = 1;
  }

  const sourceIds = [...new Set(provenanceFor(primary, hookScene.id, claimSources).sourceIds)];
  const sourceScene = makeScene({
    position: contentScenes.length + 1,
    startMs,
    durationMs: sourceSceneMs,
    role: 'SOURCE',
    semanticType: 'SOURCE',
    componentId: 'SOURCE_CARD',
    text: '来源与完整论述见原视频与描述',
    props: { text: '来源与完整论述见原视频与描述', sourceIds },
  });
  const scenes = [hookScene, ...contentScenes, sourceScene];
  const totalMs = startMs + sourceSceneMs;

  const captions = scenes
    .filter((scene) => scene.sceneType !== 'SOURCE')
    .map((scene) => ({
      id: `cap_${scene.id}`,
      sceneId: scene.id,
      startMs: scene.startMs,
      durationMs: scene.durationMs,
      text: scene.narration === '' ? hook.text : scene.narration,
      words: [],
    }));

  return {
    kind: 'DERIVED_SCENE_GRAPH',
    format: { ...SHORT_VERTICAL_FRAME },
    graph: {
      schemaVersion: 'scene-graph-v1',
      projectId,
      projectRevision: 1,
      channelSnapshot: ctx.data.channelSnapshot ?? {
        channelId: 'channel_unknown',
        channelStyleVersion: '0',
        speechProfileId: null,
        speechProfileVersion: null,
      },
      identitySnapshot: {
        avatarIdentityId: null,
        avatarIdentityVersion: null,
        voiceIdentityId: null,
        voiceIdentityVersion: null,
        brandIdentityId: null,
        brandIdentityVersion: null,
      },
      format: { ...SHORT_VERTICAL_FRAME },
      timeline: { durationMs: totalMs, masterAudioAssetId: null },
      scenes,
      captions,
      audioTracks: [],
      overlays: [],
      sourceReferences: sourceIds.map((sourceId) => ({ sourceId, datasetIds: [] })),
    },
    topic: {
      title: primary.title,
      atomIds: [primary.id],
      coverage: { sentencesUsed, sentencesTotal: sentences.length },
    },
    hook: { sceneId: hookScene.id, text: hook.text, durationMs: hookScene.durationMs, source: hook.source },
    provenance: scenes.map((scene) => provenanceFor(primary, scene.id, claimSources)),
    safeArea: { ...SHORT_VERTICAL_SAFE_AREA },
  };
}

function validateShorts(artifact: DerivedSceneGraphPayload, ctx: RestrictedPluginContext): ValidationResult {
  const issues: ValidationResult['issues'] = [];
  const push = (severity: 'error' | 'warning', code: string, message: string, artifactId: string | null = null): void => {
    issues.push({ severity, code, message, artifactId });
  };
  const frame = artifact.format;

  // 1) 竖屏格式
  if (frame.width !== SHORT_VERTICAL_FRAME.width || frame.height !== SHORT_VERTICAL_FRAME.height || frame.aspectRatio !== SHORT_VERTICAL_FRAME.aspectRatio) {
    push('error', SHORT_VALIDATION_CODES.FORMAT_NOT_VERTICAL, `帧不是 9:16 竖屏（当前 ${String(frame.width)}×${String(frame.height)} ${frame.aspectRatio}）`);
  }

  // 2) 安全区：逐场景检查自报盒位
  for (const scene of artifact.graph.scenes) {
    const parsed = shortSceneLayoutSchema.safeParse(scene.props[SHORT_LAYOUT_PROP_KEY]);
    if (!parsed.success) {
      push('error', SHORT_VALIDATION_CODES.LAYOUT_DECLARATION_MISSING, `场景 ${scene.id} 未声明 ${SHORT_LAYOUT_PROP_KEY} 盒位（安全区无法检查）`, scene.id);
      continue;
    }
    const { box } = parsed.data;
    const area = artifact.safeArea;
    const violations: string[] = [];
    if (box.x < area.leftPx) violations.push(`左越界 ${String(box.x)} < ${String(area.leftPx)}`);
    if (box.y < area.topPx) violations.push(`上越界 ${String(box.y)} < ${String(area.topPx)}`);
    if (box.x + box.width > frame.width - area.leftPx) violations.push(`右越界 ${String(box.x + box.width)} > ${String(frame.width - area.leftPx)}`);
    if (box.y + box.height > frame.height - area.bottomPx) violations.push(`下越界 ${String(box.y + box.height)} > ${String(frame.height - area.bottomPx)}`);
    if (violations.length > 0) {
      push('error', SHORT_VALIDATION_CODES.SAFE_AREA_VIOLATION, `场景 ${scene.id}（${parsed.data.role}）超出竖屏安全区：${violations.join('；')}`, scene.id);
    }
  }

  // 3) 来源保留：逐场景 provenance ≥1（Atom→Claim→Source）
  const provenanceByScene = new Map(artifact.provenance.map((entry) => [entry.sceneId, entry]));
  for (const scene of artifact.graph.scenes) {
    const entry = provenanceByScene.get(scene.id);
    if (entry === undefined || (entry.claimIds.length === 0 && entry.sourceIds.length === 0)) {
      push('error', SHORT_VALIDATION_CODES.PROVENANCE_MISSING, `场景 ${scene.id} 缺少可追溯来源（Atom→Claim→Source）`, scene.id);
    }
  }

  // 4) Hook：首场景 + ≤3s
  const firstScene = artifact.graph.scenes[0];
  if (firstScene === undefined || firstScene.id !== artifact.hook.sceneId) {
    push('error', SHORT_VALIDATION_CODES.HOOK_NOT_FIRST, 'Hook 必须是首场景（独立可理解的钩子前置）');
  }
  if (artifact.hook.durationMs > HOOK_MAX_MS) {
    push('error', SHORT_VALIDATION_CODES.HOOK_TOO_LONG, `Hook 时长 ${String(artifact.hook.durationMs)}ms 超过 3s`);
  }

  // 5) 单主题：所有溯源 Atom ∈ topic.atomIds
  const topicAtoms = new Set(artifact.topic.atomIds);
  for (const entry of artifact.provenance) {
    if (!topicAtoms.has(entry.atomId)) {
      push('error', SHORT_VALIDATION_CODES.MIXED_TOPIC, `溯源 Atom ${entry.atomId} 不属于本 Short 主题（单主题约束）`, entry.sceneId);
    }
  }

  // 6) 字幕（大字幕 Recipe 要求）
  if (artifact.graph.captions.length === 0) {
    push('error', SHORT_VALIDATION_CODES.CAPTIONS_MISSING, '缺少字幕（竖屏 Short 依赖大字幕）');
  }

  // 7) 来源卡（来源在片内可见；缺失为建议项）
  if (!artifact.graph.scenes.some((scene) => scene.sceneType === 'SOURCE')) {
    push('warning', SHORT_VALIDATION_CODES.SOURCE_SCENE_MISSING, '缺少来源卡场景（建议片尾展示来源）');
  }

  // 8) 节选披露（覆盖率 < 100% = 节选，明示不静默）
  const coverage = artifact.topic.coverage;
  if (coverage.sentencesUsed < coverage.sentencesTotal) {
    push(
      'warning',
      SHORT_VALIDATION_CODES.PARTIAL_COVERAGE,
      `节选披露：采用 ${String(coverage.sentencesUsed)}/${String(coverage.sentencesTotal)} 句（完整论述见原长视频与来源）`,
    );
  }

  // 9) Recipe 时长窗口（窗口取自版本化数据；不可用则明示）
  const recipe: ChannelRecipe | null = ctx.data.recipe;
  const durationMs = artifact.graph.timeline.durationMs;
  if (recipe === null) {
    push('warning', SHORT_VALIDATION_CODES.RECIPE_UNAVAILABLE, '渠道 Recipe 不可用：时长窗口未核验');
  } else {
    const { durationMinMs, durationMaxMs } = recipe.requirements;
    if ((durationMinMs !== null && durationMs < durationMinMs) || (durationMaxMs !== null && durationMs > durationMaxMs)) {
      push(
        'warning',
        SHORT_VALIDATION_CODES.DURATION_OUT_OF_RECIPE_WINDOW,
        `时长 ${String(durationMs)}ms 超出 Recipe「${recipe.name}」窗口 [${durationMinMs === null ? '—' : String(durationMinMs)}, ${durationMaxMs === null ? '—' : String(durationMaxMs)}]ms`,
      );
    }
  }

  return { ok: issues.every((issue) => issue.severity !== 'error'), issues };
}

export function createShortsAnalyzerPlugin(): PackPlugin {
  return {
    manifest: SHORTS_ANALYZER_MANIFEST,
    async analyze(ctx: RestrictedPluginContext): Promise<OutputPlan> {
      const fit = ctx.data.fit;
      const blocking = fit?.reasons.filter((reason) => reason.severity === 'BLOCKING') ?? [];

      if (fit === null) {
        return {
          schemaVersion: 'output-plan-v1',
          summary: '无法评估 Channel Fit（渠道不可用）：请检查项目内容后重试。',
          items: [],
          requiresApproval: true,
        };
      }
      if (blocking.length > 0) {
        return {
          schemaVersion: 'output-plan-v1',
          summary: `Channel Fit = ${fit.verdict}：${blocking.map((reason) => reason.message).join('；')}——不建议生成该渠道版本（可补足素材后重新分析）。`,
          items: [],
          requiresApproval: true,
        };
      }

      // 可传播 Atom 优先级：KEY_NUMBER > SUB_TOPIC > 其余（上限 3 条——Short 单点洞察）
      const selected = sortAtoms(ctx.data.atoms).slice(0, MAX_PLAN_ATOMS);
      const verdictNote = fit.verdict === 'OPTIONAL' ? '（素材偏薄：建议补足 Atom 后生成）' : '';

      return {
        schemaVersion: 'output-plan-v1',
        summary: `Channel Fit = ${fit.verdict}${verdictNote}：规划 ${String(selected.length)} 条 Short 观点（45–90s 单点洞察；hook < 3s）。`,
        items: selected.map((atom) => ({
          id: `planitem_atom_${atom.id}`,
          kind: 'generate' as const,
          description: `以「${atom.title}」为核心观点生成 Short（来源可追溯：${atom.sourceRefs.map((ref) => ref.claimId ?? ref.sourceId ?? '').filter((value) => value !== '').join(' / ')}）`,
        })),
        requiresApproval: true,
      };
    },
    generate: async (ctx) => generateShorts(ctx),
    validate: async (artifact, ctx) =>
      artifact.kind === 'DERIVED_SCENE_GRAPH'
        ? validateShorts(artifact, ctx)
        : { ok: false, issues: [{ severity: 'error', code: 'PAYLOAD_KIND_MISMATCH', message: `载荷类型 ${artifact.kind} 不属于 Shorts Pack`, artifactId: null }] },
  };
}
