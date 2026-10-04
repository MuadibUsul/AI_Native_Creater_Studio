import {
  ApiFailure,
  DIRECTOR_APPLY_ERROR_REASONS,
  DIRECTOR_PLAN_VERSION,
  DIRECTOR_WARNING_CODES,
  ERROR_CODES,
  directorPlanSchema,
  directorPolicySchema,
  type DirectorAssetRequirement,
  type DirectorPlan,
  type DirectorPolicy,
  type DirectorPolicyInput,
  type DirectorScene,
  type DirectorWarning,
  type Money,
  type NarrativePlan,
  type VisualPlan,
  type VisualPlanItem,
} from '@ancs/contracts';
import { and, eq, inArray } from 'drizzle-orm';
import { claims as claimsTable, scenes as scenesTable } from '@ancs/db';
import { getBillingStatus } from './billing.js';
import { getCurrentCatalog } from './catalog.js';
import { resolveProviderRoute } from './credentials.js';
import { processEdits } from './edits.js';
import { getPlan } from './narrative.js';
import { getProject } from './projects.js';
import { planVisual } from './visual-plan.js';
import type { DomainDeps } from './channels.js';

/**
 * Director 服务（P04-05 / 规范 §9；计划 §8 P04-05）。
 *
 * 输入（§9.1）：NarrativePlan + VisualPlan（视觉语法，P04-04）+ Provider Catalog + 预算。
 * 输出（§9.2）：Scene 序列（草稿）+ 资产计划 + Provider 任务计划 + 成本估算 + 风险/告警 + 决策摘要。
 *
 * 纪律：
 * - **纯确定性规划**（本阶段不调用 LLM；generation.method 固定 DETERMINISTIC）；
 * - 应用前必须通过 **Schema / 来源 / Lock / 预算** 四类验证（`validateDirectorPlanForApply`）；
 * - 视觉策略（§9.4）为**可配置默认值**（请求可覆盖），不硬编码进业务判断；
 * - 不硬编码模型与价格：Provider 由 Router（resolveProviderRoute，REQ-16-01）决定，价格来自 Catalog；
 * - 应用 = 编辑协议的一次原子请求（insert_scene × N；空项目限定），不直接写库、不重复收费。
 */

export const DIRECTOR_SCHEMA_VERSION = '0.1';
export const DIRECTOR_VERSION = DIRECTOR_PLAN_VERSION;

/** 图表族场景类型（必须携带 data_source_ids；§10.3 MUST。BIG_NUMBER/KPI_GRID 为数值卡，允许来自文本事实） */
export const CHART_SCENE_TYPES: ReadonlySet<string> = new Set([
  'LINE_CHART',
  'DUAL_LINE_CHART',
  'BAR_CHART',
  'SPREAD_AREA_CHART',
]);

/** 语音合成能力标识（Audio-First §5.1；真实 Provider 随 P06/P04-06） */
export const SPEECH_CAPABILITY = 'speech.synthesize';

interface SceneAssetRule {
  role: DirectorAssetRequirement['role'];
  assetType: DirectorAssetRequirement['assetType'];
  required: boolean;
  strategy: 'USER_UPLOAD' | 'SOURCE_IMPORT' | 'PROVIDER_GENERATE' | 'SYSTEM_RENDER';
  capability: string | null;
  reason: string;
}

interface ScenePlanRule {
  modality: 'avatar' | 'data' | 'evidence' | 'image' | 'video' | 'explainer' | 'structure';
  /** 计入 AI Video 占比（§9.4） */
  aiVideo: boolean;
  assets: SceneAssetRule[];
  reason: string;
}

const HOST_ASSETS: SceneAssetRule[] = [
  { role: 'avatar', assetType: 'AVATAR_CLIP', required: true, strategy: 'PROVIDER_GENERATE', capability: 'avatar.generate', reason: '真人主持场景需要 Avatar 素材（生成或绑定已授权形象）' },
  { role: 'audio', assetType: 'VOICE_AUDIO', required: true, strategy: 'PROVIDER_GENERATE', capability: SPEECH_CAPABILITY, reason: '旁白语音（Audio-First：先合成本段音频）' },
];

/**
 * 场景类型 → 规划规则（V1 标准 20 类；数据驱动，便于按 Channel/Policy 覆盖）。
 * 说明：图表与解释类为**本地组件渲染**（SYSTEM_RENDER），不消耗 Provider 费用。
 */
export const SCENE_PLAN_RULES: Readonly<Record<string, ScenePlanRule>> = {
  HOST_FULL: { modality: 'avatar', aiVideo: false, assets: HOST_ASSETS, reason: '真人主持全屏' },
  HOST_SIDE: { modality: 'avatar', aiVideo: false, assets: HOST_ASSETS, reason: '真人主持侧栏（保留画面区）' },
  BIG_NUMBER: { modality: 'data', aiVideo: false, assets: [{ role: 'chart', assetType: 'CHART_RENDER', required: true, strategy: 'SYSTEM_RENDER', capability: null, reason: '数值卡由标准组件本地渲染' }], reason: '大字报数（数值必须来自可追溯事实）' },
  KPI_GRID: { modality: 'data', aiVideo: false, assets: [{ role: 'chart', assetType: 'CHART_RENDER', required: true, strategy: 'SYSTEM_RENDER', capability: null, reason: '指标网格由标准组件本地渲染' }], reason: '指标网格' },
  LINE_CHART: { modality: 'data', aiVideo: false, assets: [{ role: 'chart', assetType: 'CHART_RENDER', required: true, strategy: 'SYSTEM_RENDER', capability: null, reason: '折线图由标准组件本地渲染（绑定结构化数据）' }], reason: '折线图（必须绑定 data_source_ids）' },
  DUAL_LINE_CHART: { modality: 'data', aiVideo: false, assets: [{ role: 'chart', assetType: 'CHART_RENDER', required: true, strategy: 'SYSTEM_RENDER', capability: null, reason: '双线图由标准组件本地渲染（绑定结构化数据）' }], reason: '双线对比（必须绑定 data_source_ids）' },
  BAR_CHART: { modality: 'data', aiVideo: false, assets: [{ role: 'chart', assetType: 'CHART_RENDER', required: true, strategy: 'SYSTEM_RENDER', capability: null, reason: '柱状图由标准组件本地渲染（绑定结构化数据）' }], reason: '柱状图（必须绑定 data_source_ids）' },
  SPREAD_AREA_CHART: { modality: 'data', aiVideo: false, assets: [{ role: 'chart', assetType: 'CHART_RENDER', required: true, strategy: 'SYSTEM_RENDER', capability: null, reason: '利差面积图由标准组件本地渲染（绑定结构化数据）' }], reason: '利差图（必须绑定 data_source_ids）' },
  TIMELINE: { modality: 'explainer', aiVideo: false, assets: [], reason: '时间线（本地组件）' },
  CAUSAL_FLOW: { modality: 'explainer', aiVideo: false, assets: [], reason: '因果/流程（本地组件）' },
  CAUSAL_LOOP: { modality: 'explainer', aiVideo: false, assets: [], reason: '因果闭环（本地组件）' },
  MAP_STATIC: { modality: 'explainer', aiVideo: false, assets: [], reason: '静态地图（本地组件）' },
  NEWS_HEADLINE: { modality: 'evidence', aiVideo: false, assets: [{ role: 'source', assetType: 'SOURCE_DOCUMENT', required: false, strategy: 'SOURCE_IMPORT', capability: null, reason: '报道截图/标题（可选导入来源素材）' }], reason: '新闻标题卡' },
  SOURCE_CARD: { modality: 'evidence', aiVideo: false, assets: [{ role: 'source', assetType: 'SOURCE_IMAGE', required: false, strategy: 'SOURCE_IMPORT', capability: null, reason: '来源卡（可选导入来源截图）' }], reason: '来源卡（可追溯）' },
  QUOTE_CARD: { modality: 'evidence', aiVideo: false, assets: [{ role: 'source', assetType: 'SOURCE_DOCUMENT', required: false, strategy: 'SOURCE_IMPORT', capability: null, reason: '引文卡（可选导入原文截图）' }], reason: '引文卡（保留原文）' },
  DOCUMENT_HIGHLIGHT: { modality: 'evidence', aiVideo: false, assets: [{ role: 'source', assetType: 'SOURCE_DOCUMENT', required: false, strategy: 'SOURCE_IMPORT', capability: null, reason: '文档高亮（可选导入文档素材）' }], reason: '文档高亮卡' },
  IMAGE_FULL: { modality: 'image', aiVideo: false, assets: [{ role: 'visual', assetType: 'GENERATED_IMAGE', required: true, strategy: 'PROVIDER_GENERATE', capability: 'image.generate', reason: '全屏画面（AI 生成或作者上传）' }], reason: '全屏画面' },
  REAL_BROLL: { modality: 'video', aiVideo: false, assets: [{ role: 'broll', assetType: 'USER_UPLOAD', required: true, strategy: 'SOURCE_IMPORT', capability: null, reason: '真实素材（导入/上传；不得用 AI 冒充真实画面）' }], reason: '真实素材（B-roll）' },
  CHAPTER_TITLE: { modality: 'structure', aiVideo: false, assets: [], reason: '章节标题（结构场景）' },
  SUMMARY: { modality: 'structure', aiVideo: false, assets: [], reason: '总结卡' },
};

const ruleFor = (sceneType: string): ScenePlanRule => SCENE_PLAN_RULES[sceneType] ?? { modality: 'explainer', aiVideo: false, assets: [], reason: '通用场景（本地组件）' };

/** 定点十进制金额 × 非负整数（BigInt，绝不走浮点；结果最多 6 位小数并去尾零）。 */
export function multiplyMoney(amount: string, units: number): string {
  const match = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(amount);
  if (match === null) throw new Error(`非法金额：${amount}`);
  if (!Number.isInteger(units) || units < 0) throw new Error(`units 必须为非负整数：${String(units)}`);
  const negative = match[1] === '-';
  const intPart = BigInt(match[2] ?? '0');
  const fracPart = BigInt((match[3] ?? '').padEnd(6, '0'));
  const scale = 1_000_000n;
  const product = (intPart * scale + fracPart) * BigInt(units);
  const intResult = product / scale;
  const fracResult = product % scale;
  let result = intResult.toString();
  if (fracResult > 0n) result += `.${fracResult.toString().padStart(6, '0').replace(/0+$/, '')}`;
  return negative && result !== '0' ? `-${result}` : result;
}

/** 策略解析：默认值（§9.4）+ 请求覆盖。 */
export function resolveDirectorPolicy(override?: DirectorPolicyInput): { policy: DirectorPolicy; overridden: boolean } {
  const merged = directorPolicySchema.parse(override ?? {});
  return { policy: merged, overridden: override !== undefined };
}

/** 场景类型 → 能力需求（表达能力的集合；Provider 由 Router 决定）。 */
export function requiredCapabilities(scenes: readonly DirectorScene[]): string[] {
  const capabilities = new Set<string>();
  for (const scene of scenes) for (const capability of scene.capabilities) capabilities.add(capability);
  return [...capabilities].sort();
}

/** 场景族连续段与比例检查（§9.4；纯函数便于测试）。 */
export function evaluatePolicyWarnings(scenes: readonly DirectorScene[], policy: DirectorPolicy): DirectorWarning[] {
  const warnings: DirectorWarning[] = [];
  const totalMs = scenes.reduce((sum, scene) => sum + scene.durationMs, 0);
  if (totalMs === 0) return warnings;

  const avatarMs = scenes.filter((scene) => ruleFor(scene.sceneType).modality === 'avatar').reduce((sum, scene) => sum + scene.durationMs, 0);
  const avatarRatio = avatarMs / totalMs;
  if (avatarRatio < policy.avatarRatioMin && avatarMs > 0) {
    warnings.push({ code: DIRECTOR_WARNING_CODES.AVATAR_RATIO_BELOW_MIN, severity: 'INFO', message: `Avatar 占比 ${(avatarRatio * 100).toFixed(1)}% 低于策略下限 ${(policy.avatarRatioMin * 100).toFixed(0)}%`, sceneIds: [] });
  }
  if (avatarRatio > policy.avatarRatioMax) {
    warnings.push({ code: DIRECTOR_WARNING_CODES.AVATAR_RATIO_ABOVE_MAX, severity: 'WARNING', message: `Avatar 占比 ${(avatarRatio * 100).toFixed(1)}% 超过策略上限 ${(policy.avatarRatioMax * 100).toFixed(0)}%`, sceneIds: [] });
  }

  // 单段连续 Avatar / 视觉变化间隔
  let continuousAvatar = 0;
  let continuousAvatarIds: string[] = [];
  let lastSceneType: string | null = null;
  let unchangedMs = 0;
  let sparseIds: string[] = [];
  for (const scene of scenes) {
    if (ruleFor(scene.sceneType).modality === 'avatar') {
      continuousAvatar += scene.durationMs;
      continuousAvatarIds.push(scene.sceneId);
      if (continuousAvatar > policy.maxContinuousAvatarMs && continuousAvatarIds.length > 0) {
        warnings.push({ code: DIRECTOR_WARNING_CODES.AVATAR_CONTINUOUS_TOO_LONG, severity: 'WARNING', message: `连续 Avatar 达 ${(continuousAvatar / 1000).toFixed(1)}s 超过策略上限 ${(policy.maxContinuousAvatarMs / 1000).toFixed(0)}s`, sceneIds: [...continuousAvatarIds] });
        continuousAvatar = 0;
        continuousAvatarIds = [];
      }
    } else {
      continuousAvatar = 0;
      continuousAvatarIds = [];
    }

    if (scene.sceneType === lastSceneType) {
      unchangedMs += scene.durationMs;
      sparseIds.push(scene.sceneId);
    } else {
      unchangedMs = scene.durationMs;
      sparseIds = [scene.sceneId];
      lastSceneType = scene.sceneType;
    }
    if (unchangedMs > policy.visualChangeIntervalMs && sparseIds.length > 1) {
      warnings.push({ code: DIRECTOR_WARNING_CODES.VISUAL_CHANGE_TOO_SPARSE, severity: 'INFO', message: `连续 ${(unchangedMs / 1000).toFixed(1)}s 未出现视觉变化（策略期望每 ${(policy.visualChangeIntervalMs / 1000).toFixed(0)}s 变化）`, sceneIds: [...sparseIds] });
      unchangedMs = 0;
      sparseIds = [];
    }
  }

  const aiVideoMs = scenes.filter((scene) => ruleFor(scene.sceneType).aiVideo).reduce((sum, scene) => sum + scene.durationMs, 0);
  const aiVideoRatio = aiVideoMs / totalMs;
  if (aiVideoRatio > policy.maxAiVideoRatio) {
    warnings.push({ code: DIRECTOR_WARNING_CODES.AI_VIDEO_RATIO_ABOVE_MAX, severity: 'WARNING', message: `AI Video 占比 ${(aiVideoRatio * 100).toFixed(1)}% 超过策略上限 ${(policy.maxAiVideoRatio * 100).toFixed(0)}%`, sceneIds: [] });
  }

  return warnings;
}

/**
 * 由 NarrativePlan + VisualPlan 构建场景序列（**纯函数**；含章节标题结构场景）。
 *
 * 章节边界插入 CHAPTER_TITLE（semanticType=TRANSITION）——P04-04 未做块级 TRANSITION 识别的
 * 结构层补位（见 P04-04 交接的已知边界）。
 */
export function buildDirectorScenes(input: {
  plan: NarrativePlan;
  visual: VisualPlan;
  policy: DirectorPolicy;
}): { scenes: DirectorScene[]; warnings: DirectorWarning[] } {
  const { plan, visual, policy } = input;
  const itemByBlock = new Map<string, VisualPlanItem>();
  for (const item of visual.items) {
    if (item.narrationBlockId !== null) itemByBlock.set(item.narrationBlockId, item);
  }
  const chapterTitleById = new Map(plan.chapters.map((chapter) => [chapter.id, chapter.title]));

  const scenes: DirectorScene[] = [];
  const warnings: DirectorWarning[] = [];
  const lockedSceneIds: string[] = [];
  let lastChapterId: string | null = null;
  const sceneIdFor = (suffix: string): string => `dsc_${plan.id.replace(/[^0-9a-zA-Z]/g, '').slice(-8)}${suffix}`;

  for (const [index, block] of plan.narrationBlocks.entries()) {
    const chapterId = block.chapterId;
    if (chapterId !== null && chapterId !== lastChapterId) {
      const title = chapterTitleById.get(chapterId) ?? '本章';
      scenes.push({
        sceneId: sceneIdFor(`_ch${String(index)}`),
        position: scenes.length,
        chapterId,
        narrationBlockIds: [],
        narration: title,
        semanticType: 'TRANSITION',
        sceneType: 'CHAPTER_TITLE',
        durationMs: policy.titleSceneMs,
        locked: false,
        claimIds: [],
        datasetId: null,
        dataSourceIds: [],
        degraded: false,
        visualIntent: `章节标题：${title}`,
        capabilities: [],
        assetRequirements: [],
        warnings: [],
      });
      lastChapterId = chapterId;
    }

    const item = itemByBlock.get(block.id);
    const sceneType = item?.suggestedSceneType ?? 'HOST_FULL';
    const rule = ruleFor(sceneType);
    const degraded = item !== undefined && item.fallbackStrategy !== null;
    const sceneWarnings: string[] = [];
    if (item !== undefined && item.warnings.length > 0) sceneWarnings.push(...item.warnings);
    if (item !== undefined && item.datasetId === null && (item.semanticType === 'KPI_SET' || item.semanticType === 'NUMBER')) {
      sceneWarnings.push('无数据集绑定：数值必须来自 Claim 文本并保留来源标注');
    }

    const sceneId = sceneIdFor(`_s${String(index)}`);
    scenes.push({
      sceneId,
      position: scenes.length,
      chapterId,
      narrationBlockIds: [block.id],
      narration: block.text,
      semanticType: item?.semanticType ?? 'HOST_STATEMENT',
      sceneType,
      durationMs: block.estimatedDurationMs,
      locked: block.locked,
      claimIds: [...(item?.claimIds ?? block.claimIds)],
      datasetId: item?.datasetId ?? null,
      dataSourceIds: [...(item?.dataSourceIds ?? [])],
      degraded,
      visualIntent: item === undefined ? '无视觉计划：按主持人陈述处理' : `${item.semanticType} → ${sceneType}（${item.recognition.rule}）`,
      capabilities: [SPEECH_CAPABILITY, ...rule.assets.filter((asset) => asset.capability !== null).map((asset) => asset.capability as string)],
      assetRequirements: rule.assets.map((asset) => ({ role: asset.role, assetType: asset.assetType, required: asset.required, reason: asset.reason })),
      warnings: sceneWarnings,
    });

    if (block.locked) lockedSceneIds.push(sceneId);
    if (degraded) {
      warnings.push({
        code: DIRECTOR_WARNING_CODES.DATA_DEGRADED,
        severity: 'WARNING',
        message: `旁白块 ${block.id} 已按 §10.3 降级（${String(item?.fallbackStrategy)}）为 ${sceneType}`,
        sceneIds: [sceneId],
      });
    }
    if (item !== undefined && item.fallbackStrategy === 'REQUEST_DATA') {
      warnings.push({ code: DIRECTOR_WARNING_CODES.MISSING_DATA, severity: 'WARNING', message: `旁白块 ${block.id} 缺少可绑定数据：请在应用前补充数据集（不得由 AI 编造）`, sceneIds: [sceneId] });
    }
  }

  if (lockedSceneIds.length > 0) {
    warnings.push({ code: DIRECTOR_WARNING_CODES.LOCKED_PRESERVED, severity: 'INFO', message: `${String(lockedSceneIds.length)} 个锁定旁白块已逐字保留并生成为锁定场景（AI 不得静默修改）`, sceneIds: lockedSceneIds });
  }
  if (plan.narrationBlocks.length === 0) {
    warnings.push({ code: DIRECTOR_WARNING_CODES.EMPTY_PLAN, severity: 'WARNING', message: '叙事计划没有旁白块：Director 无场景可规划', sceneIds: [] });
  }

  const policyWarnings = evaluatePolicyWarnings(scenes, policy);
  return { scenes: scenes.map((scene, index) => ({ ...scene, position: index })), warnings: [...warnings, ...policyWarnings] };
}

/** 资产计划：按 (role, assetType, strategy) 聚合场景需求。 */
export function buildAssetPlan(scenes: readonly DirectorScene[]): DirectorPlan['assetPlan'] {
  const byKey = new Map<string, DirectorPlan['assetPlan'][number]>();
  const capabilityByAssetType: Record<string, string | null> = {
    AVATAR_CLIP: 'avatar.generate',
    GENERATED_IMAGE: 'image.generate',
    VOICE_AUDIO: SPEECH_CAPABILITY,
  };
  for (const scene of scenes) {
    const rule = ruleFor(scene.sceneType);
    for (const asset of rule.assets) {
      const key = `${asset.role}:${asset.assetType}`;
      const existing = byKey.get(key);
      if (existing !== undefined) {
        if (!existing.sceneIds.includes(scene.sceneId)) existing.sceneIds.push(scene.sceneId);
        existing.required = existing.required || asset.required;
        continue;
      }
      byKey.set(key, {
        key,
        role: asset.role as DirectorPlan['assetPlan'][number]['role'],
        assetType: asset.assetType as DirectorPlan['assetPlan'][number]['assetType'],
        required: asset.required,
        strategy: asset.strategy,
        capability: asset.capability ?? capabilityByAssetType[asset.assetType] ?? null,
        sceneIds: [scene.sceneId],
        reason: asset.reason,
      });
    }
  }
  return [...byKey.values()];
}

/** Provider 任务计划 + 成本估算（Provider 由 Router 决定；价格来自 Catalog——不硬编码）。 */
export async function planProviderJobs(
  deps: DomainDeps,
  input: { workspaceId: string; scenes: readonly DirectorScene[]; assetPlan: DirectorPlan['assetPlan'] },
): Promise<{ jobs: DirectorPlan['providerJobs']; warnings: DirectorWarning[]; cost: DirectorPlan['estimatedCost'] }> {
  const warnings: DirectorWarning[] = [];
  const jobs: DirectorPlan['providerJobs'] = [];

  const jobsByCapability = new Map<string, { sceneIds: string[]; units: number; unit: 'CHARACTER' | 'CALL' | 'SECOND' | 'IMAGE'; }>();
  for (const scene of input.scenes) {
    const hasNarration = scene.narration.trim() !== '';
    if (hasNarration) {
      const entry = jobsByCapability.get(SPEECH_CAPABILITY) ?? { sceneIds: [], units: 0, unit: 'CHARACTER' };
      entry.sceneIds.push(scene.sceneId);
      entry.units += [...scene.narration].length;
      jobsByCapability.set(SPEECH_CAPABILITY, entry);
    }
  }
  for (const asset of input.assetPlan) {
    if (asset.strategy !== 'PROVIDER_GENERATE' || asset.capability === null || asset.capability === SPEECH_CAPABILITY) continue;
    const entry = jobsByCapability.get(asset.capability) ?? { sceneIds: [], units: 0, unit: 'IMAGE' };
    entry.units += asset.sceneIds.length;
    for (const sceneId of asset.sceneIds) if (!entry.sceneIds.includes(sceneId)) entry.sceneIds.push(sceneId);
    jobsByCapability.set(asset.capability, entry);
  }

  const catalog = await getCurrentCatalog(deps);
  const money: { amount: string; currency: string }[] = [];

  for (const [capability, entry] of [...jobsByCapability.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    // Router（REQ-16-01）决定 Provider；无可用候选 → 明确阻止（fail-closed），而非静默规划
    let route: Awaited<ReturnType<typeof resolveProviderRoute>>;
    try {
      route = await resolveProviderRoute(deps, { workspaceId: input.workspaceId, capability });
    } catch (error) {
      if (error instanceof ApiFailure && error.code === ERROR_CODES.CAPABILITY_UNAVAILABLE) {
        warnings.push({ code: DIRECTOR_WARNING_CODES.NO_CALLABLE_PROVIDER, severity: 'WARNING', message: `能力「${capability}」当前没有可用 Provider（未核验/无凭据）；应用不阻塞，但生成任务会被明确阻止`, sceneIds: entry.sceneIds });
        jobs.push({ capability, jobCount: entry.sceneIds.length, sceneIds: entry.sceneIds, unit: null, units: entry.units, modelRef: null, estimatedCost: null, blocked: true, blockedReason: 'NO_CALLABLE_PROVIDER' });
        continue;
      }
      throw error;
    }
    if (route.decision === null) {
      warnings.push({ code: DIRECTOR_WARNING_CODES.NO_CALLABLE_PROVIDER, severity: 'WARNING', message: `能力「${capability}」当前没有可用 Provider（未核验/无凭据）；应用不阻塞，但生成任务会被明确阻止`, sceneIds: entry.sceneIds });
      jobs.push({ capability, jobCount: entry.sceneIds.length, sceneIds: entry.sceneIds, unit: null, units: entry.units, modelRef: null, estimatedCost: null, blocked: true, blockedReason: 'NO_CALLABLE_PROVIDER' });
      continue;
    }

    const model = catalog.catalog?.entries
      .find((candidate) => candidate.providerId === route.decision?.providerId)
      ?.models.find((candidate) => candidate.modelId === route.decision?.modelId);
    const price = model?.price ?? null;

    let unit: DirectorPlan['providerJobs'][number]['unit'] = entry.unit;
    let units: number | null = entry.units;
    let estimatedCost: Money | null = null;
    if (price === null) {
      warnings.push({ code: DIRECTOR_WARNING_CODES.COST_UNKNOWN, severity: 'INFO', message: `能力「${capability}」缺少价格档案：成本不可估`, sceneIds: entry.sceneIds });
    } else {
      if (price.unit === 'CHARACTER') { unit = 'CHARACTER'; units = entry.units; }
      else if (price.unit === 'CALL') { unit = 'CALL'; units = entry.sceneIds.length; }
      else if (price.unit === 'IMAGE') { unit = 'IMAGE'; units = entry.sceneIds.length; }
      else if (price.unit === 'SECOND' || price.unit === 'MINUTE') {
        const seconds = Math.ceil(input.scenes.filter((scene) => entry.sceneIds.includes(scene.sceneId)).reduce((sum, scene) => sum + scene.durationMs, 0) / 1000);
        unit = price.unit;
        units = price.unit === 'MINUTE' ? Math.ceil(seconds / 60) : seconds;
      } else {
        unit = null;
        units = null;
        warnings.push({ code: DIRECTOR_WARNING_CODES.COST_UNKNOWN, severity: 'INFO', message: `能力「${capability}」的计费单位（${price.unit}）暂不支持估算`, sceneIds: entry.sceneIds });
      }
      if (unit !== null && units !== null) {
        estimatedCost = { amount: multiplyMoney(price.unitPrice.amount, units), currency: price.unitPrice.currency };
        money.push(estimatedCost);
      }
    }
    jobs.push({ capability, jobCount: entry.sceneIds.length, sceneIds: entry.sceneIds, unit, units, modelRef: { providerId: route.decision.providerId, modelId: route.decision.modelId }, estimatedCost, blocked: false, blockedReason: null });
  }

  const currencies = new Set(money.map((item) => item.currency));
  const cost: DirectorPlan['estimatedCost'] =
    jobs.length === 0 || money.length === 0
      ? { certainty: 'UNKNOWN', total: null, note: '没有可用 Provider 价格（真实 Provider 核验随 P06）；成本不可估——生成前必须复核' }
      : currencies.size === 1 && money.length === jobs.length
        ? { certainty: 'KNOWN', total: { amount: money.reduce((sum, item) => addMoneyStrings(sum, item.amount), '0'), currency: [...currencies][0] ?? 'USD' }, note: null }
        : { certainty: 'PARTIAL', total: null, note: `仅部分任务可估（${String(money.length)}/${String(jobs.length)} 项，币种数 ${String(currencies.size)}）` };

  return { jobs, warnings, cost };
}

/** 定点十进制加法（BigInt，同币种；绝不走浮点）。 */
export function addMoneyStrings(left: string, right: string): string {
  const toScaled = (value: string): bigint => {
    const match = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(value);
    if (match === null) throw new Error(`非法金额：${value}`);
    const sign = match[1] === '-' ? -1n : 1n;
    return sign * (BigInt(match[2] ?? '0') * 1_000_000n + BigInt((match[3] ?? '').padEnd(6, '0')));
  };
  const sum = toScaled(left) + toScaled(right);
  const negative = sum < 0n;
  const absolute = negative ? -sum : sum;
  const intPart = absolute / 1_000_000n;
  const fracPart = absolute % 1_000_000n;
  let result = intPart.toString();
  if (fracPart > 0n) result += `.${fracPart.toString().padStart(6, '0').replace(/0+$/, '')}`;
  return negative && result !== '0' ? `-${result}` : result;
}

/** 预算规则检查（P03-05 的预算语义：spent + reserved ≤ limit）。 */
export async function checkBudget(
  deps: DomainDeps,
  input: { workspaceId: string },
): Promise<{ warnings: DirectorWarning[]; blocked: boolean; blockedReasons: string[] }> {
  const status = await getBillingStatus(deps, { workspaceId: input.workspaceId });
  const warnings: DirectorWarning[] = [];
  const blockedReasons: string[] = [];
  if (status.budget === null || status.budget.limitCredits === 0) {
    warnings.push({ code: DIRECTOR_WARNING_CODES.BUDGET_UNSET, severity: 'INFO', message: '未设置工作区预算（= 不限制）；建议在 Workspace 设置周期预算与单任务上限', sceneIds: [] });
    return { warnings, blocked: false, blockedReasons };
  }
  const remaining = status.budget.limitCredits - status.usage.spentCredits - status.usage.reservedCredits;
  if (remaining <= 0) {
    blockedReasons.push(DIRECTOR_APPLY_ERROR_REASONS.BUDGET_EXHAUSTED);
    warnings.push({ code: DIRECTOR_WARNING_CODES.BUDGET_EXHAUSTED, severity: 'BLOCKER', message: `本周期预算已耗尽（上限 ${String(status.budget.limitCredits)}，已用 ${String(status.usage.spentCredits)}，预留 ${String(status.usage.reservedCredits)}）：应用被阻止`, sceneIds: [] });
  }
  return { warnings, blocked: blockedReasons.length > 0, blockedReasons };
}

/** 组装 Director 计划（不落库；多次调用结果一致）。 */
export async function planDirector(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; planId: string; policy?: DirectorPolicyInput },
): Promise<DirectorPlan> {
  const plan = await getPlan(deps, { workspaceId: input.workspaceId, projectId: input.projectId, planId: input.planId });
  const visual = await planVisual(deps, input);
  const { policy, overridden } = resolveDirectorPolicy(input.policy);

  const { scenes, warnings: sceneWarnings } = buildDirectorScenes({ plan, visual, policy });
  const assetPlan = buildAssetPlan(scenes);
  const { jobs, warnings: jobWarnings, cost } = await planProviderJobs(deps, { workspaceId: input.workspaceId, scenes, assetPlan });
  const budget = await checkBudget(deps, { workspaceId: input.workspaceId });
  const warnings = [...sceneWarnings, ...jobWarnings, ...budget.warnings];
  const estimatedDurationMs = scenes.reduce((sum, scene) => sum + scene.durationMs, 0);

  const chartScenes = scenes.filter((scene) => CHART_SCENE_TYPES.has(scene.sceneType)).length;
  const degradedScenes = scenes.filter((scene) => scene.degraded).length;
  const blockingWarnings = warnings.filter((warning) => warning.severity === 'BLOCKER').length;
  const costText = cost.certainty === 'KNOWN' && cost.total !== null ? `合计 ${cost.total.amount} ${cost.total.currency}` : cost.certainty === 'PARTIAL' ? '部分可估' : '未知（无可用 Provider 价格）';
  const decisionSummary =
    `共 ${String(scenes.length)} 个场景（图表 ${String(chartScenes)} 个、降级 ${String(degradedScenes)} 个）；` +
    `估计时长 ${(estimatedDurationMs / 1000).toFixed(1)}s；成本估计：${costText}；` +
    `告警 ${String(warnings.length)} 条（阻塞 ${String(blockingWarnings)} 条）。` +
    (scenes.some((scene) => ruleFor(scene.sceneType).modality === 'avatar') ? '含真人主持场景，AI Video 使用受策略上限约束。' : '本计划未使用 Avatar。');

  return directorPlanSchema.parse({
    schemaVersion: DIRECTOR_SCHEMA_VERSION,
    directorVersion: DIRECTOR_PLAN_VERSION,
    projectId: input.projectId,
    narrativePlanId: plan.id,
    narrativePlanRevision: plan.revision,
    visualGrammarVersion: visual.grammarVersion,
    policy,
    policyOverridden: overridden,
    scenes,
    assetPlan,
    providerJobs: jobs,
    estimatedDurationMs,
    estimatedCost: cost,
    warnings,
    blocked: budget.blocked,
    blockedReasons: budget.blockedReasons,
    decisionSummary,
    generation: { method: 'DETERMINISTIC', modelVersion: null, promptVersion: null },
  });
}

/**
 * 应用前验证（计划 P04-05 验收：**Schema、来源、Lock、预算**规则）。
 * 假定 plan 已通过 directorPlanSchema（Schema 规则）；此处校验其余三类。
 */
export function validateDirectorPlanForApply(
  plan: DirectorPlan,
  context: { lockedBlockIds: ReadonlySet<string>; lockedNarrationById: ReadonlyMap<string, string> },
): void {
  if (plan.scenes.length === 0) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'Director 计划没有场景可应用', 409, { reason: DIRECTOR_APPLY_ERROR_REASONS.EMPTY_PLAN });
  }
  for (const scene of plan.scenes) {
    if (CHART_SCENE_TYPES.has(scene.sceneType) && (scene.datasetId === null || scene.dataSourceIds.length === 0)) {
      throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, `图表场景「${scene.sceneType}」缺少 data_source_ids：来源规则验证失败`, 409, {
        reason: DIRECTOR_APPLY_ERROR_REASONS.SOURCE_VALIDATION_FAILED,
        sceneId: scene.sceneId,
      });
    }
    const lockedIds = scene.narrationBlockIds.filter((blockId) => context.lockedBlockIds.has(blockId));
    if (lockedIds.length > 0) {
      if (!scene.locked) {
        throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, `锁定旁白 ${lockedIds.join(',')} 未被锁定保留：Lock 规则验证失败`, 409, {
          reason: DIRECTOR_APPLY_ERROR_REASONS.LOCK_VALIDATION_FAILED,
          sceneId: scene.sceneId,
        });
      }
      for (const blockId of lockedIds) {
        const expected = context.lockedNarrationById.get(blockId);
        if (expected !== undefined && scene.narration !== expected) {
          throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, `锁定旁白 ${blockId} 文本被改动：Lock 规则验证失败`, 409, {
            reason: DIRECTOR_APPLY_ERROR_REASONS.LOCK_VALIDATION_FAILED,
            sceneId: scene.sceneId,
          });
        }
      }
    }
  }
  if (plan.blocked) {
    throw new ApiFailure(ERROR_CODES.BUDGET_EXCEEDED, '预算规则验证失败：Director 计划被阻止', 402, {
      reason: DIRECTOR_APPLY_ERROR_REASONS.BUDGET_EXHAUSTED,
      blockedReasons: plan.blockedReasons,
    });
  }
}

/**
 * 应用 Director 计划 = 编辑协议的一次**原子**请求（insert_scene × N）。
 *
 * - 仅允许**空项目**（已有场景的项目走编辑协议，避免覆盖作者工作）；
 * - 逆序插入（每次插到最前）保证最终顺序 = 规划顺序（编辑协议不预知新场景 id）；
 * - 幂等键由 (planId, narrativePlanRevision) 派生：同计划重复应用由编辑幂等保证不重复插入；
 * - 锁定旁白 → 锁定场景（sceneDraft.locked；作者仍可显式 set_scene_lock 解锁）；
 * - 来源绑定：Scene.sourceBindings 按 Claim 的来源分组（携带 claimIds/datasetIds），
 *   无可追溯来源的 Claim 不编造 sourceId（对应场景已按 §10.3 降级）。
 */
export async function applyDirectorPlan(
  deps: DomainDeps,
  input: {
    workspaceId: string;
    projectId: string;
    planId: string;
    actorId: string;
    policy?: DirectorPolicyInput;
    intent?: string;
  },
): Promise<{ plan: DirectorPlan; edit: Awaited<ReturnType<typeof processEdits>> }> {
  const existing = await deps.db
    .select({ id: scenesTable.id })
    .from(scenesTable)
    .where(and(eq(scenesTable.workspaceId, input.workspaceId), eq(scenesTable.projectId, input.projectId)))
    .limit(1);
  if (existing.length > 0) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '项目已有场景：Director 应用仅限空项目（已有编辑请使用编辑协议继续修改）', 409, {
      reason: DIRECTOR_APPLY_ERROR_REASONS.SCENES_EXIST,
    });
  }

  const plan = await planDirector(deps, input);
  const narrative = await getPlan(deps, { workspaceId: input.workspaceId, projectId: input.projectId, planId: input.planId });
  const lockedBlockIds = new Set(narrative.narrationBlocks.filter((block) => block.locked).map((block) => block.id));
  const lockedNarrationById = new Map(narrative.narrationBlocks.filter((block) => block.locked).map((block) => [block.id, block.text]));
  validateDirectorPlanForApply(plan, { lockedBlockIds, lockedNarrationById });

  const project = await getProject(deps, { workspaceId: input.workspaceId, projectId: input.projectId });

  // 来源绑定：按 Claim 的真实来源分组（claimIds → sourceIds）
  const allClaimIds = [...new Set(plan.scenes.flatMap((scene) => scene.claimIds))];
  const claimRows =
    allClaimIds.length === 0
      ? []
      : await deps.db
          .select({ id: claimsTable.id, sourceIds: claimsTable.sourceIds })
          .from(claimsTable)
          .where(and(eq(claimsTable.workspaceId, input.workspaceId), inArray(claimsTable.id, allClaimIds)));
  const sourcesByClaim = new Map(claimRows.map((row) => [row.id, row.sourceIds as string[]]));

  // 逆序插入：每次插到项目最前 → 最终顺序即规划顺序
  const operations = [...plan.scenes].reverse().map((scene) => {
    const bySource = new Map<string, string[]>();
    for (const claimId of scene.claimIds) {
      for (const sourceId of sourcesByClaim.get(claimId) ?? []) {
        const list = bySource.get(sourceId) ?? [];
        list.push(claimId);
        bySource.set(sourceId, list);
      }
    }
    return {
      op: 'insert_scene' as const,
      afterSceneId: null,
      sceneDraft: {
        sceneType: scene.sceneType,
        semanticType: scene.semanticType,
        narration: scene.narration,
        visualIntent: scene.visualIntent,
        durationMs: scene.durationMs,
        componentId: null,
        componentVersion: null,
        props: {},
        providerRequirement: null,
        sourceBindings: [...bySource.entries()].map(([sourceId, claimIds]) => ({
          sourceId,
          datasetIds: scene.datasetId === null ? [] : [scene.datasetId],
          claimIds,
        })),
        dataBindings: scene.datasetId === null ? [] : [{ datasetId: scene.datasetId, seriesId: null, purpose: 'fact_chart' }],
        assetBindings: [],
        narrationBlockIds: scene.narrationBlockIds,
        locked: scene.locked,
      },
    };
  });

  const edit = await processEdits(deps, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    actor: { type: 'USER', id: input.actorId },
    request: {
      baseProjectRevision: project.revision,
      expectedSceneRevisions: {},
      operations,
      idempotencyKey: `dir_${input.planId}_${String(plan.narrativePlanRevision)}`,
      intent: input.intent ?? `Director 生成（${DIRECTOR_PLAN_VERSION}，${String(plan.scenes.length)} 个场景）`,
    },
  });
  return { plan, edit };
}
