import {
  SOCIAL_PLATFORM_FRAMES,
  SOCIAL_TEXT_BUDGET,
  SOCIAL_VALIDATION_CODES,
  packManifestSchema,
  type ArtifactPayload,
  type ChannelRecipe,
  type ContentAtom,
  type OutputPlan,
  type PackPlugin,
  type RestrictedPluginContext,
  type SocialPlatformKey,
  type SocialVisualPage,
  type SocialVisualSetPayload,
  type ValidationResult,
} from '@ancs/contracts';

/**
 * 官方 Pack：Social Visual（P12-02 / §3.2、§93.3；计划 §8 P12）。
 *
 * 定位：从 Content Atom 派生**图文/信息图产物**——
 * - 1:1 单图（封面）与 4:5 单图（竖版封面）；Carousel 页序（封面 → 逐点 → 图表 → 来源页）；
 * - **信息图**= 数字 Atom 的 KPI 网格（数值逐字来自 Atom 载荷，不虚构）；
 * - **长文本**= 按页文字预算拆页（续页显式 continuationOf；节选在 coverage 披露）；
 * - **署名**= 来源页从受限上下文的来源元数据生成（P10-03 同源纪律：不编造署名）。
 * 纯逻辑：不触 DB、不持 Secret——数据全部来自能力门控后的 ctx.data。
 */

export const SOCIAL_VISUAL_MANIFEST = packManifestSchema.parse({
  manifestVersion: 'pack-manifest-v1',
  packId: 'ancs.pack.social-visual',
  name: 'Social Visual',
  version: '1.0.0',
  description: '从 Atom 派生 1:1 / 4:5 / Carousel / 信息图（官方 Pack；页序与署名可校验）',
  capabilities: ['read_content_core'],
  compatibility: { coreRange: '>=1.0.0', sceneGraphSchemaVersion: null },
  outputFormats: ['social_1x1', 'social_4x5', 'carousel', 'infographic'],
  defaultChannelKey: 'CAROUSEL',
  quota: null,
  signature: null,
});

const atomWeight = (kind: string): number => (kind === 'KEY_NUMBER' ? 0 : kind === 'SUB_TOPIC' ? 1 : 2);

const sortAtoms = (atoms: readonly ContentAtom[]): ContentAtom[] =>
  [...atoms].sort((left, right) => atomWeight(left.kind) - atomWeight(right.kind) || left.createdAt.localeCompare(right.createdAt));

/** 句子切分（逐字保留；标点随句） */
const splitSentences = (text: string): string[] =>
  text
    .split(/(?<=[。！？!?；;.\n])/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

function hashText(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return hash;
}

type Provenance = SocialVisualPage['provenance'];

function provenanceFor(atom: ContentAtom, claimSources: Map<string, string[]>): Provenance {
  const claimIds = atom.sourceRefs.map((ref) => ref.claimId).filter((value): value is string => value !== null);
  const sourceIds = new Set(atom.sourceRefs.map((ref) => ref.sourceId).filter((value): value is string => value !== null));
  for (const claimId of claimIds) {
    for (const sourceId of claimSources.get(claimId) ?? []) sourceIds.add(sourceId);
  }
  return [{ atomId: atom.id, claimIds, sourceIds: [...sourceIds] }];
}

function makePage(input: {
  index: number;
  role: SocialVisualPage['role'];
  platformKey: SocialPlatformKey;
  componentId: string;
  text: string;
  title: string;
  provenance: Provenance;
  dataSource?: SocialVisualPage['dataSource'];
  attribution?: SocialVisualPage['attribution'];
  continuationOf?: string | null;
  key?: string;
}): SocialVisualPage {
  const pageId = `page_${input.role.toLowerCase()}_${String(input.index)}_${String(Math.abs(hashText(`${input.title}:${input.text}`)))}`;
  return {
    pageId,
    index: input.index,
    role: input.role,
    platformKey: input.platformKey,
    format: { ...SOCIAL_PLATFORM_FRAMES[input.platformKey] },
    componentId: input.componentId,
    text: input.text,
    textChars: [...input.text].length,
    dataSource: input.dataSource ?? null,
    attribution: input.attribution ?? null,
    provenance: input.provenance,
    continuationOf: input.continuationOf ?? null,
  };
}

/** 按页文字预算切分文本（逐字保留；返回段落 + 是否截断） */
function packByBudget(text: string, budget: number): { parts: string[]; truncated: boolean } {
  const sentences = splitSentences(text);
  const parts: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    const candidate = current === '' ? sentence : `${current}${sentence}`;
    if ([...candidate].length <= budget || current === '') {
      current = candidate;
    } else {
      parts.push(current);
      current = sentence;
    }
  }
  if (current !== '') parts.push(current);
  if (parts.length === 0) parts.push(text);
  // 单句即超预算 → 截断（显式披露）
  const truncated = parts.some((part) => [...part].length > budget);
  return { parts, truncated };
}

function generateSocialVisual(ctx: RestrictedPluginContext): SocialVisualSetPayload {
  const atoms = sortAtoms(ctx.data.atoms);
  const primary = atoms[0];
  if (primary === undefined) {
    throw new Error('Social Visual 无法生成：项目无 Atom（先创建 Content Atom）');
  }
  const claimSources = new Map(ctx.data.claimSources.map((entry) => [entry.claimId, entry.sourceIds]));
  const sourceMeta = ctx.data.sources;
  const recipe = ctx.data.recipe;
  const pageMax = recipe?.requirements.pageCountMax ?? 10;

  const primaryProvenance = provenanceFor(primary, claimSources);
  const sourceIds = primaryProvenance[0]?.sourceIds ?? [];
  const attributionText =
    sourceMeta.length === 0
      ? null
      : `来源：${sourceMeta
          .filter((source) => sourceIds.length === 0 || sourceIds.includes(source.sourceId))
          .slice(0, 3)
          .map((source) => `《${source.title}》（${source.publisher}）`)
          .join('、')}`;
  const attribution = attributionText === null ? null : { text: attributionText, sourceIds };

  const pages: SocialVisualPage[] = [];
  let index = 0;

  // 封面（1:1 单图）：标题逐字（≤ 预算，超出截断披露）
  const cover = packByBudget(primary.title, SOCIAL_TEXT_BUDGET.COVER);
  pages.push(
    makePage({
      index: index++,
      role: 'COVER',
      platformKey: 'SQUARE_1X1',
      componentId: 'SUMMARY',
      text: cover.parts[0] ?? primary.title,
      title: primary.title,
      provenance: primaryProvenance,
    }),
  );

  // 竖版封面（4:5 单图）
  pages.push(
    makePage({
      index: index++,
      role: 'COVER',
      platformKey: 'PORTRAIT_4X5',
      componentId: 'SUMMARY',
      text: cover.parts[0] ?? primary.title,
      title: primary.title,
      provenance: primaryProvenance,
    }),
  );

  // 数字 Atom → 图表页（数值逐字来自 Atom payload；不虚构）
  const numberAtoms = atoms.filter((atom) => atom.kind === 'KEY_NUMBER');
  for (const atom of numberAtoms.slice(0, 4)) {
    if (pages.filter((page) => page.role === 'CHART').length >= 4) break;
    const payload = atom.payload as { value?: unknown; unit?: unknown };
    const value = typeof payload.value === 'number' || typeof payload.value === 'string' ? String(payload.value) : '';
    pages.push(
      makePage({
        index: index++,
        role: 'CHART',
        platformKey: 'PORTRAIT_4X5',
        componentId: 'BIG_NUMBER',
        text: value === '' ? atom.title : `${atom.title}：${value}${typeof payload.unit === 'string' ? payload.unit : ''}`,
        title: atom.title,
        provenance: provenanceFor(atom, claimSources),
        dataSource: { kind: 'ATOM_PAYLOAD', atomId: atom.id },
      }),
    );
  }

  // 观点页：主 Atom 文本按页预算拆页（长文本 → 续页显式衔接；超出页数上限 → 节选披露）
  const body = packByBudget(primary.text, SOCIAL_TEXT_BUDGET.POINT);
  const reservedTail = 2; // 信息图 + 来源页
  const bodyBudget = Math.max(1, pageMax - index - reservedTail);
  let truncatedPages = 0;
  const usedParts = body.parts.slice(0, bodyBudget);
  if (body.parts.length > bodyBudget || body.truncated) truncatedPages += 1;
  let previousPageId: string | null = null;
  for (const part of usedParts) {
    const page = makePage({
      index: index++,
      role: 'POINT',
      platformKey: 'PORTRAIT_4X5',
      componentId: 'SUMMARY',
      text: part,
      title: primary.title,
      provenance: primaryProvenance,
      continuationOf: previousPageId,
    });
    previousPageId = page.pageId;
    pages.push(page);
  }

  // 信息图（1:1）：数字 Atom 的 KPI 网格（数值逐字来自 Atom payload；无数字 → 观点汇总）
  const infoRows = numberAtoms.slice(0, 6).map((atom) => {
    const payload = atom.payload as { value?: unknown; unit?: unknown };
    const value = typeof payload.value === 'number' || typeof payload.value === 'string' ? String(payload.value) : '—';
    return `${atom.title}：${value}${typeof payload.unit === 'string' ? payload.unit : ''}`;
  });
  pages.push(
    makePage({
      index: index++,
      role: 'INFOGRAPHIC',
      platformKey: 'SQUARE_1X1',
      componentId: numberAtoms.length > 0 ? 'KPI_GRID' : 'SUMMARY',
      text: infoRows.length > 0 ? infoRows.join('\n') : primary.title,
      title: primary.title,
      provenance: primaryProvenance,
      dataSource: numberAtoms[0] === undefined ? null : { kind: 'ATOM_PAYLOAD', atomId: numberAtoms[0].id },
    }),
  );

  // 来源页（署名；对外发布必须可署名）
  pages.push(
    makePage({
      index,
      role: 'SOURCE',
      platformKey: 'PORTRAIT_4X5',
      componentId: 'SOURCE_CARD',
      text: attribution?.text ?? '来源见原文（未收录来源元数据）',
      title: primary.title,
      provenance: primaryProvenance,
      attribution,
    }),
  );

  const atomIds = [...new Set([primary.id, ...numberAtoms.slice(0, 4).map((atom) => atom.id)])];
  return {
    kind: 'SOCIAL_VISUAL_SET',
    topic: {
      title: primary.title,
      atomIds,
      coverage: { atomsUsed: atomIds.length, atomsTotal: atoms.length, textTruncatedPages: truncatedPages },
    },
    pages,
  };
}

function validateSocialVisual(artifact: SocialVisualSetPayload, ctx: RestrictedPluginContext): ValidationResult {
  const issues: ValidationResult['issues'] = [];
  const push = (severity: 'error' | 'warning', code: string, message: string, artifactId: string | null = null): void => {
    issues.push({ severity, code, message, artifactId });
  };

  // 1) 平台尺寸：页规格必须等于平台帧（1:1 / 4:5）
  for (const page of artifact.pages) {
    const expected = SOCIAL_PLATFORM_FRAMES[page.platformKey];
    if (page.format.width !== expected.width || page.format.height !== expected.height || page.format.aspectRatio !== expected.aspectRatio) {
      push(
        'error',
        SOCIAL_VALIDATION_CODES.PLATFORM_SIZE_INVALID,
        `页 ${page.pageId} 尺寸 ${String(page.format.width)}×${String(page.format.height)} ${page.format.aspectRatio} 与平台 ${page.platformKey}（${String(expected.width)}×${String(expected.height)} ${expected.aspectRatio}）不符`,
        page.pageId,
      );
    }
  }

  // 2) 页序：封面在前（两页 1:1/4:5 封面）、来源页最后、index 单调
  const sorted = [...artifact.pages].sort((left, right) => left.index - right.index);
  const ordered = artifact.pages.every((page, position) => page.index === position);
  if (!ordered) {
    push('error', SOCIAL_VALIDATION_CODES.PAGE_ORDER_INVALID, '页序无效：index 必须从 0 连续递增（页序即发布顺序）');
  }
  if (sorted[0]?.role !== 'COVER') {
    push('error', SOCIAL_VALIDATION_CODES.PAGE_ORDER_INVALID, '页序无效：首页必须是封面（COVER）');
  }
  if (sorted[sorted.length - 1]?.role !== 'SOURCE') {
    push('error', SOCIAL_VALIDATION_CODES.PAGE_ORDER_INVALID, '页序无效：末页必须是来源页（SOURCE）');
  }

  // 3) 页数 vs Recipe 窗口（数据驱动；窗口未定义 → 明示未核验）
  const recipe: ChannelRecipe | null = ctx.data.recipe;
  const carouselPages = artifact.pages.filter((page) => page.platformKey === 'PORTRAIT_4X5').length;
  if (recipe === null || (recipe.requirements.pageCountMin === null && recipe.requirements.pageCountMax === null)) {
    push('warning', SOCIAL_VALIDATION_CODES.PAGE_COUNT_UNVERIFIED, `页数 ${String(carouselPages)} 未核验：Recipe 未定义页数窗口`);
  } else {
    const { pageCountMin, pageCountMax } = recipe.requirements;
    if ((pageCountMin !== null && carouselPages < pageCountMin) || (pageCountMax !== null && carouselPages > pageCountMax)) {
      push(
        'warning',
        SOCIAL_VALIDATION_CODES.PAGE_COUNT_OUT_OF_RECIPE,
        `竖版页数 ${String(carouselPages)} 超出 Recipe「${recipe.name}」窗口 [${pageCountMin === null ? '—' : String(pageCountMin)}, ${pageCountMax === null ? '—' : String(pageCountMax)}]（素材偏薄时可先发布并补足内容）`,
      );
    }
  }

  // 4) 署名：来源页必须携带署名文本与来源引用
  const sourcePage = artifact.pages.find((page) => page.role === 'SOURCE');
  if (sourcePage === undefined) {
    push('error', SOCIAL_VALIDATION_CODES.ATTRIBUTION_MISSING, '缺少来源页（SOURCE）：对外发布必须可署名');
  } else if (sourcePage.attribution === null || sourcePage.attribution.text.trim() === '' || sourcePage.attribution.sourceIds.length === 0) {
    push('error', SOCIAL_VALIDATION_CODES.ATTRIBUTION_MISSING, '署名缺失：来源页必须携带署名文本与来源引用（不编造署名）', sourcePage.pageId);
  }

  // 5) 图表可追溯：图表组件的数值来源必须是本主题内的真实 Atom（不虚构数值）
  const topicAtoms = new Set(artifact.topic.atomIds);
  const chartComponents = new Set(['BIG_NUMBER', 'KPI_GRID', 'NUMBER_COMPARE']);
  let traceableChartPages = 0;
  for (const page of artifact.pages) {
    const isChartComponent = chartComponents.has(page.componentId);
    if (page.role === 'CHART' && !isChartComponent) {
      push('error', SOCIAL_VALIDATION_CODES.CHART_DATA_UNTRACEABLE, `页 ${page.pageId} 声明为图表页（CHART）但组件 ${page.componentId} 不是图表组件`, page.pageId);
      continue;
    }
    if (!isChartComponent) continue;
    if (page.dataSource === null || !topicAtoms.has(page.dataSource.atomId)) {
      push('error', SOCIAL_VALIDATION_CODES.CHART_DATA_UNTRACEABLE, `页 ${page.pageId} 图表数值不可追溯（dataSource 缺失或不在主题 Atom 内——数值不虚构）`, page.pageId);
    } else {
      traceableChartPages += 1;
    }
  }
  if (traceableChartPages === 0) {
    push('warning', SOCIAL_VALIDATION_CODES.NO_CHART_PAGE, '无图表/信息图页：项目缺少数字 Atom（可补足关键数字后重生成）');
  }

  // 6) 长文本：页文字不超预算（超 = 拆页或披露截断，不静默溢出）
  for (const page of artifact.pages) {
    const budget = page.role === 'COVER' ? SOCIAL_TEXT_BUDGET.COVER : page.role === 'POINT' ? SOCIAL_TEXT_BUDGET.POINT : null;
    if (budget !== null && page.textChars > budget) {
      push('error', SOCIAL_VALIDATION_CODES.TEXT_OVERFLOW, `页 ${page.pageId}（${page.role}）文字 ${String(page.textChars)} 字超出预算 ${String(budget)} 字——请拆页`, page.pageId);
    }
  }
  if (artifact.topic.coverage.textTruncatedPages > 0) {
    push('warning', SOCIAL_VALIDATION_CODES.TEXT_OVERFLOW, `节选披露：${String(artifact.topic.coverage.textTruncatedPages)} 页文本超出版面预算（完整内容见原长视频/来源）`);
  }

  // 7) 来源链：逐页 provenance 必须链到主题 Atom 且带具体引用
  for (const page of artifact.pages) {
    const hasRefs = page.provenance.some((entry) => entry.claimIds.length > 0 || entry.sourceIds.length > 0);
    const inTopic = page.provenance.every((entry) => topicAtoms.has(entry.atomId));
    if (!hasRefs) {
      push('error', SOCIAL_VALIDATION_CODES.PROVENANCE_MISSING, `页 ${page.pageId} 缺少可追溯来源（Atom→Claim→Source）`, page.pageId);
    }
    if (!inTopic) {
      push('error', SOCIAL_VALIDATION_CODES.MIXED_TOPIC, `页 ${page.pageId} 溯源 Atom 不属于本内容集主题（单主题约束）`, page.pageId);
    }
  }

  return { ok: issues.every((issue) => issue.severity !== 'error'), issues };
}

export function createSocialVisualPlugin(): PackPlugin {
  return {
    manifest: SOCIAL_VISUAL_MANIFEST,
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
          summary: `Channel Fit = ${fit.verdict}：${blocking.map((reason) => reason.message).join('；')}——不建议生成图文内容（可补足素材后重新分析）。`,
          items: [],
          requiresApproval: true,
        };
      }
      const numberAtoms = ctx.data.atoms.filter((atom) => atom.kind === 'KEY_NUMBER').length;
      const verdictNote = fit.verdict === 'OPTIONAL' ? '（素材偏薄：建议补足 Atom 后生成）' : '';
      return {
        schemaVersion: 'output-plan-v1',
        summary: `Channel Fit = ${fit.verdict}${verdictNote}：规划图文集（1:1 单图 + 4:5 竖版 + Carousel 页序 + 信息图；${String(numberAtoms)} 个数字 Atom 可出图表）。`,
        items: [
          { id: 'planitem_social_cover_1x1', kind: 'generate' as const, description: '生成 1:1 封面单图' },
          { id: 'planitem_social_cover_4x5', kind: 'generate' as const, description: '生成 4:5 竖版封面单图' },
          { id: 'planitem_social_carousel', kind: 'generate' as const, description: `生成 Carousel 页序（${String(pageWindowLabel(ctx.data.recipe))}）+ 信息图 + 来源页` },
        ],
        requiresApproval: true,
      };
    },
    generate: async (ctx) => generateSocialVisual(ctx),
    validate: async (artifact: ArtifactPayload, ctx) =>
      artifact.kind === 'SOCIAL_VISUAL_SET'
        ? validateSocialVisual(artifact, ctx)
        : {
            ok: false,
            issues: [
              {
                severity: 'error',
                code: SOCIAL_VALIDATION_CODES.PAYLOAD_KIND_MISMATCH,
                message: `载荷类型 ${artifact.kind} 不属于 Social Visual Pack`,
                artifactId: null,
              },
            ],
          },
  };
}

function pageWindowLabel(recipe: ChannelRecipe | null): string {
  const min = recipe?.requirements.pageCountMin;
  const max = recipe?.requirements.pageCountMax;
  if (min === null || min === undefined) return max === null || max === undefined ? '页数未约束' : `≤${String(max)} 页`;
  return max === null || max === undefined ? `≥${String(min)} 页` : `${String(min)}–${String(max)} 页`;
}
