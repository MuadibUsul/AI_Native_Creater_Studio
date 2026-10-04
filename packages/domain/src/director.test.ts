import { describe, expect, it } from 'vitest';
import {
  DIRECTOR_APPLY_ERROR_REASONS,
  DIRECTOR_WARNING_CODES,
  directorPlanSchema,
  directorPolicySchema,
  type DirectorPlan,
  type DirectorScene,
  type NarrativePlan,
  type VisualPlan,
} from '@ancs/contracts';
import {
  addMoneyStrings,
  buildAssetPlan,
  buildDirectorScenes,
  CHART_SCENE_TYPES,
  evaluatePolicyWarnings,
  multiplyMoney,
  requiredCapabilities,
  resolveDirectorPolicy,
  SCENE_PLAN_RULES,
  SPEECH_CAPABILITY,
  validateDirectorPlanForApply,
} from './director.js';

/**
 * P04-05 单元验收（规范 §9；计划 §8 P04-05）：
 * - 场景规划确定性（含章节标题结构场景、锁定保留、降级告警）；
 * - §9.4 视觉策略为可配置默认值（比例/连续时长/视觉变化/AI Video 上限）；
 * - 金额运算为定点十进制（BigInt，绝不走浮点）；
 * - 应用前验证：Schema/来源/Lock/预算四类规则的**纯函数**部分可直接测试。
 */

const narrativePlan = (overrides: Partial<NarrativePlan> = {}): NarrativePlan =>
  ({
    schemaVersion: '0.1',
    id: 'npl_test_1',
    revision: 3,
    title: '利率周报',
    thesis: '利率决定一切',
    hook: '开场',
    chapters: [
      { id: 'nch_1', title: '开场与核心事实', intent: null, narrationBlockIds: ['nbr_1'] },
      { id: 'nch_2', title: '影响与总结', intent: null, narrationBlockIds: ['nbr_2'] },
    ],
    narrationBlocks: [
      {
        id: 'nbr_1',
        position: 0,
        text: '联邦基金利率维持在 5.25% 不变。',
        chapterId: 'nch_1',
        claimIds: ['clm_1'],
        estimatedDurationMs: 4000,
        locked: false,
        status: 'DRAFT',
      },
      {
        id: 'nbr_2',
        position: 1,
        text: '这是作者锁定的总结段落，不得改写。',
        chapterId: 'nch_2',
        claimIds: [],
        estimatedDurationMs: 3000,
        locked: true,
        status: 'APPROVED',
      },
    ],
    keyClaims: ['clm_1'],
    requiredVisualFacts: [],
    ending: '结尾',
    estimatedDurationMs: 7000,
    generation: { method: 'LLM', providerId: 'mock.llm', modelVersion: null, promptVersion: 'narrative-v1' },
    ...overrides,
  }) as NarrativePlan;

const visualPlan = (overrides: Partial<VisualPlan> = {}): VisualPlan =>
  ({
    schemaVersion: '0.1',
    grammarVersion: 'visual-grammar-v1',
    planId: 'npl_test_1',
    items: [
      {
        narrationBlockId: 'nbr_1',
        claimIds: ['clm_1'],
        semanticType: 'PRICE_SERIES',
        recognition: { method: 'DETERMINISTIC', confidence: 0.85, rule: 'dataset_price_series', reasons: [] },
        allowedSceneTypes: ['LINE_CHART'],
        suggestedSceneType: 'LINE_CHART',
        datasetId: 'dst_1',
        dataSourceIds: ['src_1'],
        fallbackStrategy: null,
        warnings: [],
      },
      {
        narrationBlockId: 'nbr_2',
        claimIds: [],
        semanticType: 'NUMBER',
        recognition: { method: 'DETERMINISTIC', confidence: 0.6, rule: 'numeric_single', reasons: [] },
        allowedSceneTypes: ['BIG_NUMBER'],
        suggestedSceneType: 'BIG_NUMBER',
        datasetId: null,
        dataSourceIds: [],
        fallbackStrategy: 'REQUEST_DATA',
        warnings: ['缺少可绑定的结构化数据集：请补充数据集或来源（不得由 AI 编造数列）'],
      },
    ],
    summary: { total: 2, chartItems: 1, degradedItems: 1, bySemanticType: {} },
    ...overrides,
  }) as VisualPlan;

describe('金额定点运算（BigInt；禁止浮点）', () => {
  it('乘法保留精度并去尾零', () => {
    expect(multiplyMoney('2.50', 4)).toBe('10');
    expect(multiplyMoney('0.5', 3)).toBe('1.5');
    expect(multiplyMoney('0.000001', 3)).toBe('0.000003');
    expect(multiplyMoney('0', 5)).toBe('0');
    expect(multiplyMoney('12.345678', 0)).toBe('0');
  });

  it('拒绝非整数单位与非法金额', () => {
    expect(() => multiplyMoney('1', 1.5)).toThrow();
    expect(() => multiplyMoney('abc', 2)).toThrow();
    expect(() => multiplyMoney('1', -1)).toThrow();
  });

  it('加法（同币种定点）', () => {
    expect(addMoneyStrings('0.1', '0.2')).toBe('0.3');
    expect(addMoneyStrings('1.999999', '0.000001')).toBe('2');
  });
});

describe('视觉策略（§9.4 默认值，可覆盖）', () => {
  it('默认值为 §9.4 建议值；覆盖合并且标记 overridden', () => {
    const { policy, overridden } = resolveDirectorPolicy();
    expect(policy).toMatchObject({ avatarRatioMin: 0.15, avatarRatioMax: 0.3, maxContinuousAvatarMs: 22_000, visualChangeIntervalMs: 8_000, maxAiVideoRatio: 0.15, titleSceneMs: 2_500 });
    expect(overridden).toBe(false);

    const custom = resolveDirectorPolicy({ avatarRatioMax: 0.4 });
    expect(custom.overridden).toBe(true);
    expect(custom.policy.avatarRatioMax).toBe(0.4);
    expect(custom.policy.avatarRatioMin).toBe(0.15);
  });
});

describe('buildDirectorScenes（确定性规划）', () => {
  const policy = directorPolicySchema.parse({});

  it('按章节边界插入 CHAPTER_TITLE 结构场景；顺序与位置连续', () => {
    const { scenes } = buildDirectorScenes({ plan: narrativePlan(), visual: visualPlan(), policy });
    expect(scenes.map((scene) => scene.sceneType)).toEqual(['CHAPTER_TITLE', 'LINE_CHART', 'CHAPTER_TITLE', 'BIG_NUMBER']);
    expect(scenes.map((scene) => scene.position)).toEqual([0, 1, 2, 3]);
    expect(scenes[0]).toMatchObject({ semanticType: 'TRANSITION', narration: '开场与核心事实', durationMs: 2_500 });
    expect(scenes[2]).toMatchObject({ semanticType: 'TRANSITION', narration: '影响与总结' });
  });

  it('图表绑定与来源保留（data_source_ids）；降级块带告警并标记 degraded', () => {
    const { scenes } = buildDirectorScenes({ plan: narrativePlan(), visual: visualPlan(), policy });
    expect(scenes[1]).toMatchObject({ datasetId: 'dst_1', dataSourceIds: ['src_1'], degraded: false, narrationBlockIds: ['nbr_1'] });
    expect(scenes[3]).toMatchObject({ datasetId: null, degraded: true, narrationBlockIds: ['nbr_2'] });
    expect(scenes[3]?.warnings.length).toBeGreaterThan(0);
  });

  it('锁定旁白 → 锁定场景 + LOCKED_PRESERVED 告警；降级/缺数据告警可审计', () => {
    const { scenes, warnings } = buildDirectorScenes({ plan: narrativePlan(), visual: visualPlan(), policy });
    expect(scenes[3]?.locked).toBe(true);
    expect(warnings.map((warning) => warning.code)).toContain(DIRECTOR_WARNING_CODES.LOCKED_PRESERVED);
    expect(warnings.map((warning) => warning.code)).toContain(DIRECTOR_WARNING_CODES.DATA_DEGRADED);
    expect(warnings.map((warning) => warning.code)).toContain(DIRECTOR_WARNING_CODES.MISSING_DATA);
  });

  it('能力需求：旁白场景必有语音合成；图片场景追加图像生成', () => {
    const visual = visualPlan({
      items: [
        {
          narrationBlockId: 'nbr_1',
          claimIds: [],
          semanticType: 'IMAGE_EVIDENCE',
          recognition: { method: 'DETERMINISTIC', confidence: 0.6, rule: 'image_block', reasons: [] },
          allowedSceneTypes: ['IMAGE_FULL'],
          suggestedSceneType: 'IMAGE_FULL',
          datasetId: null,
          dataSourceIds: [],
          fallbackStrategy: null,
          warnings: [],
        },
      ],
    });
    const plan = narrativePlan({ narrationBlocks: [narrativePlan().narrationBlocks[0]!] , chapters: [narrativePlan().chapters[0]!] });
    const { scenes } = buildDirectorScenes({ plan, visual, policy });
    const image = scenes.find((scene) => scene.sceneType === 'IMAGE_FULL');
    expect(image?.capabilities).toContain(SPEECH_CAPABILITY);
    expect(image?.capabilities).toContain('image.generate');
    expect(requiredCapabilities(scenes)).toContain(SPEECH_CAPABILITY);
  });

  it('资产计划按 (role, assetType) 聚合去重', () => {
    const { scenes } = buildDirectorScenes({ plan: narrativePlan(), visual: visualPlan(), policy });
    const assetPlan = buildAssetPlan(scenes);
    const chart = assetPlan.find((asset) => asset.assetType === 'CHART_RENDER');
    expect(chart).toMatchObject({ role: 'chart', strategy: 'SYSTEM_RENDER', required: true });
    expect(chart?.sceneIds.length).toBeGreaterThanOrEqual(2);
  });
});

describe('evaluatePolicyWarnings（§9.4 策略检查）', () => {
  const scene = (sceneType: string, durationMs: number, index: number): DirectorScene => ({
    sceneId: `dsc_${String(index)}`,
    position: index,
    chapterId: null,
    narrationBlockIds: [],
    narration: '',
    semanticType: 'HOST_STATEMENT',
    sceneType,
    durationMs,
    locked: false,
    claimIds: [],
    datasetId: null,
    dataSourceIds: [],
    degraded: false,
    visualIntent: '',
    capabilities: [],
    assetRequirements: [],
    warnings: [],
  });
  const policy = directorPolicySchema.parse({});

  it('Avatar 占比超上限与连续 Avatar 过长', () => {
    const warnings = evaluatePolicyWarnings(
      [scene('HOST_FULL', 30_000, 0), scene('LINE_CHART', 5_000, 1), scene('HOST_FULL', 20_000, 2)],
      policy,
    );
    const codes = warnings.map((warning) => warning.code);
    expect(codes).toContain(DIRECTOR_WARNING_CODES.AVATAR_RATIO_ABOVE_MAX);
    expect(codes).toContain(DIRECTOR_WARNING_CODES.AVATAR_CONTINUOUS_TOO_LONG);
  });

  it('视觉变化过疏（长时间同类型）产生 INFO', () => {
    const warnings = evaluatePolicyWarnings([scene('LINE_CHART', 10_000, 0), scene('LINE_CHART', 10_000, 1)], policy);
    expect(warnings.map((warning) => warning.code)).toContain(DIRECTOR_WARNING_CODES.VISUAL_CHANGE_TOO_SPARSE);
  });

  it('合规计划不产生告警', () => {
    // Avatar 4s / 总 14s ≈ 28.6%：落在 15%～30% 策略区间内
    const warnings = evaluatePolicyWarnings([scene('HOST_FULL', 4_000, 0), scene('LINE_CHART', 6_000, 1), scene('BIG_NUMBER', 4_000, 2)], policy);
    expect(warnings).toEqual([]);
  });
});

describe('validateDirectorPlanForApply（Schema/来源/Lock/预算）', () => {
  const baseScenes: DirectorScene[] = [
    {
      sceneId: 'dsc_a',
      position: 0,
      chapterId: null,
      narrationBlockIds: ['nbr_1'],
      narration: '联邦基金利率维持在 5.25% 不变。',
      semanticType: 'PRICE_SERIES',
      sceneType: 'LINE_CHART',
      durationMs: 4000,
      locked: false,
      claimIds: ['clm_1'],
      datasetId: 'dst_1',
      dataSourceIds: ['src_1'],
      degraded: false,
      visualIntent: '',
      capabilities: [SPEECH_CAPABILITY],
      assetRequirements: [],
      warnings: [],
    },
  ];
  const basePlan = (scenes: DirectorScene[], extra: Partial<DirectorPlan> = {}): DirectorPlan =>
    directorPlanSchema.parse({
      schemaVersion: '0.1',
      directorVersion: 'director-v1',
      projectId: 'prj_1',
      narrativePlanId: 'npl_test_1',
      narrativePlanRevision: 3,
      visualGrammarVersion: 'visual-grammar-v1',
      policy: directorPolicySchema.parse({}),
      scenes,
      assetPlan: [],
      providerJobs: [],
      estimatedDurationMs: scenes.reduce((sum, s) => sum + s.durationMs, 0),
      estimatedCost: { certainty: 'UNKNOWN', total: null, note: null },
      warnings: [],
      blocked: false,
      blockedReasons: [],
      decisionSummary: '测试',
      generation: { method: 'DETERMINISTIC', modelVersion: null, promptVersion: null },
      ...extra,
    });

  const emptyContext = { lockedBlockIds: new Set<string>(), lockedNarrationById: new Map<string, string>() };

  it('合法计划通过；图表缺 data_source_ids → SOURCE_VALIDATION_FAILED', () => {
    expect(() => validateDirectorPlanForApply(basePlan(baseScenes), emptyContext)).not.toThrow();
    const broken = basePlan([{ ...baseScenes[0]!, dataSourceIds: [] }]);
    expect(() => validateDirectorPlanForApply(broken, emptyContext)).toThrowError(/来源规则验证失败/);
  });

  it('锁定旁白未被锁定保留 → LOCK_VALIDATION_FAILED；文本被改动同样失败', () => {
    const context = { lockedBlockIds: new Set(['nbr_1']), lockedNarrationById: new Map([['nbr_1', '原文']]) };
    const unlocked = basePlan([{ ...baseScenes[0]!, locked: false }]);
    expect(() => validateDirectorPlanForApply(unlocked, context)).toThrowError(/Lock 规则验证失败/);

    const changed = basePlan([{ ...baseScenes[0]!, locked: true, narration: '被改动' }]);
    expect(() => validateDirectorPlanForApply(changed, context)).toThrowError(/文本被改动/);

    expect(() => validateDirectorPlanForApply(basePlan([{ ...baseScenes[0]!, locked: true }]), context)).toThrowError(/文本被改动/);
    expect(() =>
      validateDirectorPlanForApply(basePlan([{ ...baseScenes[0]!, locked: true, narration: '原文' }]), context),
    ).not.toThrow();
  });

  it('空计划与预算阻止', () => {
    expect(() => validateDirectorPlanForApply(basePlan([]), emptyContext)).toThrowError(/没有场景/);
    const blocked = basePlan(baseScenes, { blocked: true, blockedReasons: [DIRECTOR_APPLY_ERROR_REASONS.BUDGET_EXHAUSTED] });
    expect(() => validateDirectorPlanForApply(blocked, emptyContext)).toThrowError(/预算规则验证失败/);
  });

  it('图表场景集合与场景规划规则一致（V1 20 类全覆盖）', () => {
    for (const sceneType of Object.keys(SCENE_PLAN_RULES)) {
      expect(typeof SCENE_PLAN_RULES[sceneType]?.modality).toBe('string');
    }
    expect([...CHART_SCENE_TYPES].every((sceneType) => sceneType in SCENE_PLAN_RULES)).toBe(true);
  });
});
