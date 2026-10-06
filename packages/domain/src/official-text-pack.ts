import {
  TEXT_VALIDATION_CODES,
  packManifestSchema,
  type ArtifactPayload,
  type ChannelRecipe,
  type ContentAtom,
  type OutputPlan,
  type PackPlugin,
  type RestrictedPluginContext,
  type TextSetPayload,
  type TextUnit,
  type ValidationResult,
} from '@ancs/contracts';

/**
 * 官方 Pack：Text Pack（P12-03 / §4.2、§93.3；计划 §8 P12）。
 *
 * 定位：从 Content Atom 派生**文字形态**——Thread / 短文 / 平台文案 / Newsletter。
 * - **引用和事实不丢失**：正文由 Atom 的句子**逐字**组成，每单元携带 quotes（逐字引文 + 来源引用）——
 *   validate 用引文重建正文（不一致 = error），事实不可追溯 = error；
 * - **平台长度限制由 Recipe 校验**（数据驱动：threadMaxPosts / threadPostMaxChars / postMaxChars /
 *   newsletterMaxChars；未定义 → 明示未核验，不猜）；**生成器绝不产出超限单元**——
 *   不满足时将形态列入 unavailableFormats 并说明原因（不改文字、不截断、不静默省略）。
 * 纯逻辑：不触 DB、不持 Secret——数据全部来自能力门控后的 ctx.data。
 */

export const TEXT_PACK_MANIFEST = packManifestSchema.parse({
  manifestVersion: 'pack-manifest-v1',
  packId: 'ancs.pack.text',
  name: 'Text Pack',
  version: '1.0.0',
  description: '从 Atom 派生 Thread/短文/平台文案/Newsletter（逐字引用；长度限制按 Recipe 校验）',
  capabilities: ['read_content_core'],
  compatibility: { coreRange: '>=1.0.0', sceneGraphSchemaVersion: null },
  outputFormats: ['thread', 'short_post', 'platform_copy', 'newsletter'],
  defaultChannelKey: 'TEXT_POST',
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

const charCount = (value: string): number => [...value].length;

function hashText(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return hash;
}

function findByKey(recipes: readonly ChannelRecipe[], channelKey: string): ChannelRecipe | null {
  return recipes.find((recipe) => recipe.channelKey === channelKey && recipe.status === 'ACTIVE') ?? null;
}

/** 逐字引文（来自 Atom 的句子）+ 溯源引用 */
function quotesFor(atom: ContentAtom, sentences: readonly string[], claimSources: Map<string, string[]>): TextUnit['quotes'] {
  const claimIds = atom.sourceRefs.map((ref) => ref.claimId).filter((value): value is string => value !== null);
  const sourceIds = new Set(atom.sourceRefs.map((ref) => ref.sourceId).filter((value): value is string => value !== null));
  for (const claimId of claimIds) {
    for (const sourceId of claimSources.get(claimId) ?? []) sourceIds.add(sourceId);
  }
  const firstClaim = claimIds[0] ?? null;
  const firstSource = [...sourceIds][0] ?? null;
  return sentences.map((sentence) => ({ claimId: firstClaim, sourceId: firstSource, text: sentence }));
}

function provenanceFor(atom: ContentAtom, claimSources: Map<string, string[]>): TextUnit['provenance'] {
  const claimIds = atom.sourceRefs.map((ref) => ref.claimId).filter((value): value is string => value !== null);
  const sourceIds = new Set(atom.sourceRefs.map((ref) => ref.sourceId).filter((value): value is string => value !== null));
  for (const claimId of claimIds) {
    for (const sourceId of claimSources.get(claimId) ?? []) sourceIds.add(sourceId);
  }
  return [{ atomId: atom.id, claimIds, sourceIds: [...sourceIds] }];
}

/** 按字符上限把句子装条（逐字；单句超限 → 该形态不可用，不截断） */
function packUnits(texts: readonly string[], maxChars: number): { chunks: string[][]; oversizeSentence: string | null } {
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentChars = 0;
  for (const sentence of texts) {
    const sentenceChars = charCount(sentence);
    if (sentenceChars > maxChars) return { chunks, oversizeSentence: sentence };
    if (currentChars + sentenceChars > maxChars && current.length > 0) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(sentence);
    currentChars += sentenceChars;
  }
  if (current.length > 0) chunks.push(current);
  return { chunks, oversizeSentence: null };
}

function generateTextSet(ctx: RestrictedPluginContext): TextSetPayload {
  const atoms = sortAtoms(ctx.data.atoms);
  const primary = atoms[0];
  if (primary === undefined) {
    throw new Error('Text Pack 无法生成：项目无 Atom（先创建 Content Atom）');
  }
  const claimSources = new Map(ctx.data.claimSources.map((entry) => [entry.claimId, entry.sourceIds]));
  const recipes = ctx.data.recipes;

  const units: TextUnit[] = [];
  const unavailableFormats: TextSetPayload['unavailableFormats'] = [];
  let index = 0;
  let sentencesUsed = 0;

  const primarySentences = splitSentences(primary.text);
  const primaryProvenance = provenanceFor(primary, claimSources);

  const pushUnit = (input: {
    kind: TextUnit['kind'];
    channelKey: string;
    prefix: string;
    sentences: string[];
    atom: ContentAtom;
  }): void => {
    const body = input.sentences.join('');
    units.push({
      unitId: `unit_${input.kind.toLowerCase()}_${String(index)}_${String(Math.abs(hashText(`${input.channelKey}:${body}`)))}`,
      index,
      kind: input.kind,
      channelKey: input.channelKey,
      prefix: input.prefix,
      text: `${input.prefix}${body}`,
      textChars: charCount(body),
      quotes: quotesFor(input.atom, input.sentences, claimSources),
      provenance: provenanceFor(input.atom, claimSources),
    });
    index += 1;
    sentencesUsed += input.sentences.length;
  };

  // 1) Thread：主 Atom 句子按 threadPostMaxChars 装条（上限 threadMaxPosts；溢出 = 节选披露）
  const threadRecipe = findByKey(recipes, 'TEXT_THREAD');
  const threadPostMax = threadRecipe?.requirements.threadPostMaxChars ?? null;
  const threadMaxPosts = threadRecipe?.requirements.threadMaxPosts ?? null;
  if (threadPostMax === null) {
    unavailableFormats.push({ channelKey: 'TEXT_THREAD', reason: 'Recipe 未定义 threadPostMaxChars（长度限制未核验，拒绝猜）' });
  } else {
    const { chunks, oversizeSentence } = packUnits(primarySentences, threadPostMax);
    if (oversizeSentence !== null) {
      unavailableFormats.push({ channelKey: 'TEXT_THREAD', reason: `存在单句 ${String(charCount(oversizeSentence))} 字符超过单条上限 ${String(threadPostMax)}——不改文字、不截断，该形态不可用` });
    } else {
      const capped = threadMaxPosts === null ? chunks : chunks.slice(0, threadMaxPosts);
      const total = capped.length;
      capped.forEach((chunk, position) => {
        pushUnit({ kind: 'THREAD_POST', channelKey: 'TEXT_THREAD', prefix: `[${String(position + 1)}/${String(total)}] `, sentences: chunk, atom: primary });
      });
    }
  }

  // 2) 短文（SHORT_POST）与平台文案（PLATFORM_COPY）：单条 ≤ postMaxChars
  const postRecipe = findByKey(recipes, 'TEXT_POST');
  const postMax = postRecipe?.requirements.postMaxChars ?? null;
  const firstSentence = primarySentences[0];
  if (postMax === null) {
    unavailableFormats.push({ channelKey: 'TEXT_POST', reason: 'Recipe 未定义 postMaxChars（长度限制未核验，拒绝猜）' });
  } else if (firstSentence === undefined) {
    unavailableFormats.push({ channelKey: 'TEXT_POST', reason: '主 Atom 无可切分句子' });
  } else {
    if (charCount(firstSentence) <= postMax) {
      pushUnit({ kind: 'SHORT_POST', channelKey: 'TEXT_POST', prefix: '', sentences: [firstSentence], atom: primary });
    } else {
      unavailableFormats.push({ channelKey: 'TEXT_POST', reason: `首句 ${String(charCount(firstSentence))} 字符超过短文上限 ${String(postMax)}——不改文字、不截断，该形态不可用` });
    }
    const copyPrefix = `${primary.title}｜`;
    const copyCandidate = [copyPrefix, firstSentence];
    if (charCount(copyCandidate.join('')) <= postMax) {
      // 平台文案 = 标题（逐字，作为前缀）+ 首句（逐字引文）；引文只含句子，正文重建按"去前缀"口径
      units.push({
        unitId: `unit_platform_copy_${String(index)}_${String(Math.abs(hashText(`${primary.title}:${firstSentence}`)))}`,
        index,
        kind: 'PLATFORM_COPY',
        channelKey: 'TEXT_POST',
        prefix: copyPrefix,
        text: copyCandidate.join(''),
        textChars: charCount(copyCandidate.join('')),
        quotes: quotesFor(primary, [firstSentence], claimSources),
        provenance: primaryProvenance,
      });
      index += 1;
      sentencesUsed += 1;
    } else if (charCount(primary.title) <= postMax) {
      // 标题单独成文案（无引文句 → 引文取标题本身在 Atom 中逐字出现，仍可追溯）
      units.push({
        unitId: `unit_platform_copy_${String(index)}_${String(Math.abs(hashText(primary.title)))}`,
        index,
        kind: 'PLATFORM_COPY',
        channelKey: 'TEXT_POST',
        prefix: '',
        text: primary.title,
        textChars: charCount(primary.title),
        quotes: [{ claimId: primaryProvenance[0]?.claimIds[0] ?? null, sourceId: primaryProvenance[0]?.sourceIds[0] ?? null, text: primary.title }],
        provenance: primaryProvenance,
      });
      index += 1;
    } else {
      unavailableFormats.push({ channelKey: 'TEXT_POST', reason: `标题 ${String(charCount(primary.title))} 字符超过文案上限 ${String(postMax)}——不改文字、不截断，平台文案不可用` });
    }
  }

  // 3) Newsletter：逐 Atom 分节（整篇 ≤ newsletterMaxChars；装不下 → 节选披露）
  const newsletterRecipe = findByKey(recipes, 'NEWSLETTER');
  const newsletterMax = newsletterRecipe?.requirements.newsletterMaxChars ?? null;
  if (newsletterMax === null) {
    unavailableFormats.push({ channelKey: 'NEWSLETTER', reason: 'Recipe 未定义 newsletterMaxChars（长度限制未核验，拒绝猜）' });
  } else {
    let used = 0;
    let sections = 0;
    for (const atom of atoms) {
      const body = atom.text;
      if (used + charCount(body) > newsletterMax) break;
      pushUnit({ kind: 'NEWSLETTER_SECTION', channelKey: 'NEWSLETTER', prefix: `## ${atom.title}\n`, sentences: splitSentences(body), atom });
      used += charCount(body);
      sections += 1;
    }
    if (sections === 0) {
      unavailableFormats.push({ channelKey: 'NEWSLETTER', reason: `首个 Atom 正文超过上限 ${String(newsletterMax)} 字符——不改文字、不截断，Newsletter 不可用` });
    }
  }

  return {
    kind: 'TEXT_SET',
    topic: {
      title: primary.title,
      atomIds: atoms.map((atom) => atom.id),
      coverage: { sentencesUsed, sentencesTotal: primarySentences.length },
    },
    units,
    unavailableFormats,
  };
}

function validateTextSet(artifact: TextSetPayload, ctx: RestrictedPluginContext): ValidationResult {
  const issues: ValidationResult['issues'] = [];
  const push = (severity: 'error' | 'warning', code: string, message: string, unitId: string | null = null): void => {
    issues.push({ severity, code, message, artifactId: unitId });
  };
  const recipes = ctx.data.recipes;
  const topicAtoms = new Set(artifact.topic.atomIds);

  // 1) 单元顺序：index 连续递增（发布顺序）
  const ordered = artifact.units.every((unit, position) => unit.index === position);
  if (!ordered) {
    push('error', TEXT_VALIDATION_CODES.UNIT_ORDER_INVALID, '单元顺序无效：index 必须从 0 连续递增（即发布顺序）');
  }

  // 2) 引用与事实不丢失：正文（去前缀）必须由引文逐字重建；引文必须可追溯
  for (const unit of artifact.units) {
    const rebuilt = unit.quotes.map((quote) => quote.text).join('');
    const body = unit.text.startsWith(unit.prefix) ? unit.text.slice(unit.prefix.length) : unit.text;
    if (rebuilt !== body) {
      push('error', TEXT_VALIDATION_CODES.QUOTE_MISMATCH, `单元 ${unit.unitId} 正文与逐字引文不一致（引用/事实丢失或改写）：引文重建 ${String(charCount(rebuilt))} 字 ≠ 正文 ${String(charCount(body))} 字`, unit.unitId);
    }
    for (const quote of unit.quotes) {
      if (quote.claimId === null && quote.sourceId === null) {
        push('error', TEXT_VALIDATION_CODES.FACT_QUOTE_UNTRACEABLE, `单元 ${unit.unitId} 存在无来源引文（不可追溯的事实引用）`, unit.unitId);
        break;
      }
    }
    const hasRefs = unit.provenance.some((entry) => entry.claimIds.length > 0 || entry.sourceIds.length > 0);
    const inTopic = unit.provenance.every((entry) => topicAtoms.has(entry.atomId));
    if (!hasRefs) push('error', TEXT_VALIDATION_CODES.PROVENANCE_MISSING, `单元 ${unit.unitId} 缺少可追溯来源（Atom→Claim→Source）`, unit.unitId);
    if (!inTopic) push('error', TEXT_VALIDATION_CODES.MIXED_TOPIC, `单元 ${unit.unitId} 溯源 Atom 不属于本主题`, unit.unitId);
  }

  // 3) 长度限制（按渠道 Recipe；未定义 → 明示未核验）
  const limitsOf = (channelKey: string): ChannelRecipe | null => recipes.find((recipe) => recipe.channelKey === channelKey && recipe.status === 'ACTIVE') ?? null;
  for (const unit of artifact.units) {
    const recipe = limitsOf(unit.channelKey);
    const limit =
      unit.kind === 'THREAD_POST'
        ? recipe?.requirements.threadPostMaxChars ?? null
        : unit.kind === 'NEWSLETTER_SECTION'
          ? recipe?.requirements.newsletterMaxChars ?? null
          : recipe?.requirements.postMaxChars ?? null;
    if (limit === null) {
      push('warning', TEXT_VALIDATION_CODES.LIMIT_UNVERIFIED, `单元 ${unit.unitId}（${unit.channelKey}）长度限制未核验：Recipe 未定义对应上限`, unit.unitId);
      continue;
    }
    if (unit.textChars > limit) {
      push('error', TEXT_VALIDATION_CODES.LENGTH_LIMIT_EXCEEDED, `单元 ${unit.unitId}（${unit.channelKey}）${String(unit.textChars)} 字超过上限 ${String(limit)} 字`, unit.unitId);
    }
  }

  // 4) Thread 条数上限
  const threadUnits = artifact.units.filter((unit) => unit.kind === 'THREAD_POST');
  const threadRecipe = limitsOf('TEXT_THREAD');
  if (threadUnits.length > 0) {
    const maxPosts = threadRecipe?.requirements.threadMaxPosts ?? null;
    if (maxPosts === null) {
      push('warning', TEXT_VALIDATION_CODES.LIMIT_UNVERIFIED, `Thread 条数 ${String(threadUnits.length)} 未核验：Recipe 未定义 threadMaxPosts`);
    } else if (threadUnits.length > maxPosts) {
      push('error', TEXT_VALIDATION_CODES.THREAD_TOO_LONG, `Thread ${String(threadUnits.length)} 条超过上限 ${String(maxPosts)} 条`);
    }
  }

  // 5) Newsletter 总字数上限
  const newsletterUnits = artifact.units.filter((unit) => unit.kind === 'NEWSLETTER_SECTION');
  const newsletterRecipe = limitsOf('NEWSLETTER');
  if (newsletterUnits.length > 0) {
    const total = newsletterUnits.reduce((sum, unit) => sum + unit.textChars, 0);
    const maxChars = newsletterRecipe?.requirements.newsletterMaxChars ?? null;
    if (maxChars === null) {
      push('warning', TEXT_VALIDATION_CODES.LIMIT_UNVERIFIED, `Newsletter 总字数 ${String(total)} 未核验：Recipe 未定义 newsletterMaxChars`);
    } else if (total > maxChars) {
      push('error', TEXT_VALIDATION_CODES.NEWSLETTER_TOO_LONG, `Newsletter 总字数 ${String(total)} 超过上限 ${String(maxChars)}`);
    }
  }

  // 6) 节选披露（句子覆盖率 < 100%）
  const coverage = artifact.topic.coverage;
  if (coverage.sentencesUsed < coverage.sentencesTotal) {
    push('warning', TEXT_VALIDATION_CODES.PARTIAL_COVERAGE, `节选披露：采用 ${String(coverage.sentencesUsed)}/${String(coverage.sentencesTotal)} 句（完整内容见原长视频与来源）`);
  }

  return { ok: issues.every((issue) => issue.severity !== 'error'), issues };
}

export function createTextPackPlugin(): PackPlugin {
  return {
    manifest: TEXT_PACK_MANIFEST,
    async analyze(ctx: RestrictedPluginContext): Promise<OutputPlan> {
      const fit = ctx.data.fit;
      const blocking = fit?.reasons.filter((reason) => reason.severity === 'BLOCKING') ?? [];
      if (fit === null) {
        return { schemaVersion: 'output-plan-v1', summary: '无法评估 Channel Fit（渠道不可用）：请检查项目内容后重试。', items: [], requiresApproval: true };
      }
      if (blocking.length > 0) {
        return {
          schemaVersion: 'output-plan-v1',
          summary: `Channel Fit = ${fit.verdict}：${blocking.map((reason) => reason.message).join('；')}——不建议生成文字形态（可补足素材后重新分析）。`,
          items: [],
          requiresApproval: true,
        };
      }
      return {
        schemaVersion: 'output-plan-v1',
        summary: `Channel Fit = ${fit.verdict}：规划文字集（Thread/短文/平台文案/Newsletter；逐字引用、长度按 Recipe 校验）。`,
        items: [
          { id: 'planitem_text_thread', kind: 'generate' as const, description: '生成 Thread（逐句装条；单条上限按 Recipe）' },
          { id: 'planitem_text_post', kind: 'generate' as const, description: '生成短文与平台文案（标题 + 首句，逐字）' },
          { id: 'planitem_text_newsletter', kind: 'generate' as const, description: '生成 Newsletter 分节长文（逐 Atom 分节）' },
        ],
        requiresApproval: true,
      };
    },
    generate: async (ctx) => generateTextSet(ctx),
    validate: async (artifact: ArtifactPayload, ctx) =>
      artifact.kind === 'TEXT_SET'
        ? validateTextSet(artifact, ctx)
        : { ok: false, issues: [{ severity: 'error', code: TEXT_VALIDATION_CODES.QUOTE_MISMATCH, message: `载荷类型 ${artifact.kind} 不属于 Text Pack`, artifactId: null }] },
  };
}
