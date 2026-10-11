import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import {
  ApiFailure,
  ATOM_ERROR_REASONS,
  CHANNEL_FIT_ERROR_REASONS,
  ERROR_CODES,
  channelFitSchema,
  channelRecipeSchema,
  channelRequirementsSchema,
  contentAtomSchema,
  createAtomRequestSchema,
  type ChannelFit,
  type ChannelFitReason,
  type ChannelRecipe,
  type ContentAtom,
} from '@ancs/contracts';
import { channelRecipes, claims, contentAtoms, projectSources } from '@ancs/db';
import type { DomainDeps } from './deps.js';
import { getProjectContentCoreState } from './content-core.js';

/**
 * Content Atom 与 Channel Recipe/Fit（P11-02 / 规范 §93.2—93.4）。
 *
 * - **Atom 可独立追溯来源**：创建时逐条校验 sourceRefs（claimId 必须存在于项目 claims；
 *   sourceId 必须存在于 project_sources）——**无来源/悬空引用 → 422**；
 * - **Recipe 是版本化数据**：官方种子幂等（channelKey+version 唯一）；评估引擎只消费 requirements；
 * - **Fit 规则化评估**：核心计数（P11-01 state 实时口径）+ Atom 计数对照 requirements——
 *   BLOCKING 原因 → NOT_RECOMMENDED；仅 ADVISORY → OPTIONAL；全满足 → RECOMMENDED（各带 SATISFIED 记录）；
 *   **NOT_RECOMMENDED 是 200 正常结果**（不制造平台垃圾内容的产品化表达）。
 */

/* ---------- Atom ---------- */

const toAtomDto = (row: typeof contentAtoms.$inferSelect): ContentAtom =>
  contentAtomSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    kind: row.kind,
    title: row.title,
    text: row.text,
    sourceRefs: row.sourceRefs,
    payload: row.payload,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  });

export async function createAtom(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; request: unknown; actorId: string | null },
): Promise<ContentAtom> {
  const body = createAtomRequestSchema.parse(input.request);

  // 逐条追溯校验：claimId ∈ 项目 claims；sourceId ∈ project_sources（至少一侧命中）
  const claimIds = new Set(
    (
      await deps.db
        .select({ id: claims.id })
        .from(claims)
        .where(and(eq(claims.workspaceId, input.workspaceId), eq(claims.projectId, input.projectId)))
    ).map((row) => row.id),
  );
  const sourceIds = new Set(
    (
      await deps.db
        .select({ id: projectSources.id })
        .from(projectSources)
        .where(and(eq(projectSources.workspaceId, input.workspaceId), eq(projectSources.projectId, input.projectId)))
    ).map((row) => row.id),
  );
  for (const ref of body.sourceRefs) {
    const claimOk = ref.claimId !== null && claimIds.has(ref.claimId);
    const sourceOk = ref.sourceId !== null && sourceIds.has(ref.sourceId);
    if (!claimOk && !sourceOk) {
      throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, `来源引用不可追溯：claimId=${ref.claimId ?? 'null'} / sourceId=${ref.sourceId ?? 'null'} 均不存在于项目内`, 422, {
        reason: ATOM_ERROR_REASONS.SOURCE_REF_NOT_TRACEABLE,
        ref,
      });
    }
  }

  const inserted = await deps.db
    .insert(contentAtoms)
    .values({
      id: `atom_${randomUUID()}`,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      kind: body.kind,
      title: body.title,
      text: body.text,
      sourceRefs: body.sourceRefs,
      payload: body.payload,
      createdBy: input.actorId,
    })
    .returning();
  const row = inserted[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'atom insert failed', 500);
  return toAtomDto(row);
}

export async function listAtoms(deps: DomainDeps, input: { workspaceId: string; projectId: string }): Promise<ContentAtom[]> {
  const rows = await deps.db
    .select()
    .from(contentAtoms)
    .where(and(eq(contentAtoms.workspaceId, input.workspaceId), eq(contentAtoms.projectId, input.projectId)))
    .orderBy(desc(contentAtoms.createdAt));
  return rows.map(toAtomDto);
}

/* ---------- Channel Recipe（版本化数据；官方种子幂等） ---------- */

const toRecipeDto = (row: typeof channelRecipes.$inferSelect): ChannelRecipe =>
  channelRecipeSchema.parse({
    id: row.id,
    channelKey: row.channelKey,
    version: row.version,
    name: row.name,
    description: row.description,
    requirements: row.requirements,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  });

/** 官方 Recipe 种子（需求为**数据**——新增渠道 = 追加版本行，不改评估引擎）。 */
export const DEFAULT_CHANNEL_RECIPES: readonly { channelKey: string; name: string; description: string; requirements: ChannelRecipe['requirements'] }[] = [
  {
    channelKey: 'YOUTUBE_EXPLAINER',
    name: 'YouTube 深度解读',
    description: '8–12 分钟叙事解释（narrative_depth: high；图表多；来源可见）',
    requirements: { durationMinMs: 480_000, durationMaxMs: 720_000, minFacts: 2, minNumberAtoms: 0, minAtoms: 0, requiresTimeline: false, pageCountMin: null, pageCountMax: null, postMaxChars: null, threadMaxPosts: null, threadPostMaxChars: null, newsletterMaxChars: null },
  },
  {
    channelKey: 'SHORT_INSIGHT',
    name: '短洞察（竖屏 Short）',
    description: '45–90 秒单点洞察（hook < 3s；一个核心观点；大字幕）',
    requirements: { durationMinMs: 45_000, durationMaxMs: 90_000, minFacts: 0, minNumberAtoms: 1, minAtoms: 0, requiresTimeline: false, pageCountMin: null, pageCountMax: null, postMaxChars: null, threadMaxPosts: null, threadPostMaxChars: null, newsletterMaxChars: null },
  },
  {
    channelKey: 'CAROUSEL',
    name: '图文 Carousel',
    description: '6–10 页（每页一个观点；信息密度高）',
    requirements: { durationMinMs: null, durationMaxMs: null, minFacts: 1, minNumberAtoms: 0, minAtoms: 3, requiresTimeline: false, pageCountMin: 6, pageCountMax: 10, postMaxChars: null, threadMaxPosts: null, threadPostMaxChars: null, newsletterMaxChars: null },
  },
  // 文字类渠道（P12-03；长度限制为**平台保守默认值**，可经 Recipe 版本化升级覆盖——代码不硬编码平台）
  {
    channelKey: 'TEXT_THREAD',
    name: 'Thread（线程贴）',
    description: '≤12 条、单条 ≤280 字符的线程贴（逐字引用，不改写事实）',
    requirements: { durationMinMs: null, durationMaxMs: null, minFacts: 1, minNumberAtoms: 0, minAtoms: 1, requiresTimeline: false, pageCountMin: null, pageCountMax: null, threadMaxPosts: 12, threadPostMaxChars: 280, postMaxChars: null, newsletterMaxChars: null },
  },
  {
    channelKey: 'TEXT_POST',
    name: '短文 / 平台文案',
    description: '≤220 字符的单条短文（标题 + 要点，逐字引用）',
    requirements: { durationMinMs: null, durationMaxMs: null, minFacts: 1, minNumberAtoms: 0, minAtoms: 1, requiresTimeline: false, pageCountMin: null, pageCountMax: null, postMaxChars: 220, threadMaxPosts: null, threadPostMaxChars: null, newsletterMaxChars: null },
  },
  {
    channelKey: 'NEWSLETTER',
    name: 'Newsletter 长文',
    description: '≤6000 字符的分节长文（每节一个 Atom，逐字引用，来源清单）',
    requirements: { durationMinMs: null, durationMaxMs: null, minFacts: 1, minNumberAtoms: 0, minAtoms: 1, requiresTimeline: false, pageCountMin: null, pageCountMax: null, newsletterMaxChars: 6000, postMaxChars: null, threadMaxPosts: null, threadPostMaxChars: null },
  },
] as const;

/**
 * 官方渠道 Recipe 种子（幂等）：
 * - 无 ACTIVE 行 → 建新版本（首次 v1；全部 RETIRED 时继续递增）；
 * - ACTIVE 需求与种子一致 → 复用（不产生第二份）；
 * - **需求变化 → 新版本 + 旧版本 RETIRED**（版本化数据纪律：不改写历史行）。
 */
export async function ensureDefaultChannelRecipes(deps: DomainDeps): Promise<{ created: string[] }> {
  const created: string[] = [];
  for (const seed of DEFAULT_CHANNEL_RECIPES) {
    const nextRequirements = channelRequirementsSchema.parse(seed.requirements);
    // 并发安全（多进程/多测试文件并行调用）：读 → （必要时）插新版本；插入冲突 = 其他进程已处理 → 重读判定
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const rows = await deps.db
        .select()
        .from(channelRecipes)
        .where(eq(channelRecipes.channelKey, seed.channelKey))
        .orderBy(desc(channelRecipes.version));
      const active = rows.find((row) => row.status === 'ACTIVE');
      if (active !== undefined) {
        const currentRequirements = channelRequirementsSchema.parse(active.requirements);
        if (JSON.stringify(currentRequirements) === JSON.stringify(nextRequirements) && active.name === seed.name) break; // 幂等复用
        await deps.db.update(channelRecipes).set({ status: 'RETIRED' }).where(eq(channelRecipes.id, active.id));
        const inserted = await deps.db
          .insert(channelRecipes)
          .values({
            id: `rcp_${randomUUID()}`,
            channelKey: seed.channelKey,
            version: active.version + 1,
            name: seed.name,
            description: seed.description,
            requirements: nextRequirements,
            status: 'ACTIVE',
          })
          .onConflictDoNothing()
          .returning({ id: channelRecipes.id });
        if (inserted.length > 0) created.push(`${seed.channelKey}@v${String(active.version + 1)}`);
        break;
      }
      const nextVersion = (rows[0]?.version ?? 0) + 1;
      const inserted = await deps.db
        .insert(channelRecipes)
        .values({
          id: `rcp_${randomUUID()}`,
          channelKey: seed.channelKey,
          version: nextVersion,
          name: seed.name,
          description: seed.description,
          requirements: nextRequirements,
          status: 'ACTIVE',
        })
        .onConflictDoNothing()
        .returning({ id: channelRecipes.id });
      if (inserted.length > 0) {
        created.push(nextVersion === 1 ? seed.channelKey : `${seed.channelKey}@v${String(nextVersion)}`);
        break;
      }
      // 冲突：其他进程刚插入 → 重读后再判定
    }
  }
  return { created };
}

export async function listChannelRecipes(deps: DomainDeps): Promise<ChannelRecipe[]> {
  await ensureDefaultChannelRecipes(deps);
  const rows = await deps.db.select().from(channelRecipes).where(eq(channelRecipes.status, 'ACTIVE')).orderBy(channelRecipes.channelKey, desc(channelRecipes.version));
  const latestByChannel = new Map<string, ChannelRecipe>();
  for (const row of rows) {
    if (!latestByChannel.has(row.channelKey)) latestByChannel.set(row.channelKey, toRecipeDto(row));
  }
  return [...latestByChannel.values()];
}

/* ---------- Channel Fit（规则化评估） ---------- */

export async function evaluateChannelFit(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; channelKey: string },
): Promise<ChannelFit> {
  await ensureDefaultChannelRecipes(deps);
  const recipeRows = await deps.db
    .select()
    .from(channelRecipes)
    .where(and(eq(channelRecipes.channelKey, input.channelKey), eq(channelRecipes.status, 'ACTIVE')))
    .orderBy(desc(channelRecipes.version))
    .limit(1);
  const recipeRow = recipeRows[0];
  if (recipeRow === undefined) {
    throw new ApiFailure(ERROR_CODES.NOT_FOUND, `渠道「${input.channelKey}」无 ACTIVE Recipe`, 404, { reason: CHANNEL_FIT_ERROR_REASONS.CHANNEL_NOT_FOUND, channelKey: input.channelKey });
  }
  const recipe = toRecipeDto(recipeRow);
  const requirements = channelRecipeSchema.parse(recipe).requirements;

  // 评估输入：实时口径（claims 的 fact 子集 + Atom 计数）——单一权威、可解释；
  // coreInputsDigest 仅为参考（P11-01 核心未迁移时为 null，不阻断评估）
  const [state, atomRows, claimRows] = await Promise.all([
    getProjectContentCoreState(deps, { workspaceId: input.workspaceId, projectId: input.projectId }),
    listAtoms(deps, input),
    deps.db.select({ factuality: claims.factuality }).from(claims).where(and(eq(claims.workspaceId, input.workspaceId), eq(claims.projectId, input.projectId))),
  ]);
  const effectiveFactCount = claimRows.filter((row) => row.factuality === 'fact').length;
  const numberAtomCount = atomRows.filter((atom) => atom.kind === 'KEY_NUMBER').length;
  const timelineAtomCount = atomRows.filter((atom) => atom.kind === 'TIMELINE_SPAN').length;

  const reasons: ChannelFitReason[] = [];
  let blocking = 0;
  let advisory = 0;

  if (requirements.minFacts > 0 && effectiveFactCount < requirements.minFacts) {
    blocking += 1;
    reasons.push({ code: 'INSUFFICIENT_VERIFIED_FACTS', message: `已核实事实 ${String(effectiveFactCount)} 条，低于该渠道要求 ${String(requirements.minFacts)} 条——不足以支撑可信表达`, severity: 'BLOCKING' });
  } else if (requirements.minFacts > 0) {
    reasons.push({ code: 'FACTS_SUFFICIENT', message: `已核实事实 ${String(effectiveFactCount)} 条（≥ ${String(requirements.minFacts)}）`, severity: 'SATISFIED' });
  }

  if (requirements.minNumberAtoms > 0 && numberAtomCount < requirements.minNumberAtoms) {
    blocking += 1;
    reasons.push({ code: 'NO_NUMBER_ATOMS', message: `缺少关键数字 Atom（需 ≥ ${String(requirements.minNumberAtoms)}）——该渠道形式以数字洞察为主`, severity: 'BLOCKING' });
  } else if (requirements.minNumberAtoms > 0) {
    reasons.push({ code: 'NUMBER_ATOMS_SUFFICIENT', message: `关键数字 Atom ${String(numberAtomCount)} 条`, severity: 'SATISFIED' });
  }

  if (requirements.minAtoms > 0 && atomRows.length < requirements.minAtoms) {
    advisory += 1;
    reasons.push({ code: 'MATERIAL_THIN', message: `可用 Atom ${String(atomRows.length)} 条（建议 ≥ ${String(requirements.minAtoms)}）——素材偏薄，产出质量可能受限`, severity: 'ADVISORY' });
  } else if (requirements.minAtoms > 0) {
    reasons.push({ code: 'ATOMS_SUFFICIENT', message: `可用 Atom ${String(atomRows.length)} 条`, severity: 'SATISFIED' });
  }

  if (requirements.requiresTimeline && timelineAtomCount === 0) {
    advisory += 1;
    reasons.push({ code: 'NO_TIMELINE_MATERIAL', message: '该渠道适合时间线叙事，但暂无 TIMELINE_SPAN Atom', severity: 'ADVISORY' });
  }

  const hasContent = atomRows.length > 0 || state.liveCounts.claimCount > 0;
  if (!hasContent) {
    blocking += 1;
    reasons.unshift({ code: 'NO_CONTENT', message: '项目无可传播内容（无 Atom 且无声明）', severity: 'BLOCKING' });
  }

  const verdict: ChannelFit['verdict'] = blocking > 0 ? 'NOT_RECOMMENDED' : advisory > 0 ? 'OPTIONAL' : 'RECOMMENDED';

  return channelFitSchema.parse({
    projectId: input.projectId,
    channelKey: recipe.channelKey,
    recipeId: recipe.id,
    recipeVersion: recipe.version,
    verdict,
    reasons,
    inputs: {
      factCount: effectiveFactCount,
      claimCount: state.liveCounts.claimCount,
      atomCount: atomRows.length,
      numberAtomCount,
      timelineAtomCount,
      coreInputsDigest: state.consistency?.inputsDigest ?? null,
    },
    evaluatedAt: new Date().toISOString(),
  });
}


