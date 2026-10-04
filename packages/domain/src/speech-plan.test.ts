import { describe, expect, it } from 'vitest';
import { SPEECH_WARNING_CODES, mergeSpeechProfileFields, type NarrationBlock } from '@ancs/contracts';
import { buildSpeechSegments, resolveSceneRole } from './speech-plan.js';

/**
 * P04-06 单元验收（规范 §94、§6.4）：
 * - 角色判定（Hook/引用/关键数字/结论/解释/正文）确定性；
 * - 语速/能量 = profile × 角色修正，**越界钳制并记录**（可解释降级，不静默）；
 * - 关键数字 → 停顿 + 强调；句子间隙 → 停顿（同位置合并）；发音词典命中 → 覆盖；
 * - 锁定旁白逐字进入合成文本；预计时长按有效语速折算。
 */

const block = (id: string, text: string, overrides: Partial<NarrationBlock> = {}): NarrationBlock => ({
  id,
  position: 0,
  text,
  chapterId: null,
  claimIds: [],
  estimatedDurationMs: Math.max(1000, [...text].length * 273),
  locked: false,
  status: 'DRAFT',
  ...overrides,
});

const profile = () => mergeSpeechProfileFields(undefined);

describe('resolveSceneRole（§94 默认规则）', () => {
  it('首段 Hook、末段结论、语义驱动的引用/数字/解释', () => {
    expect(resolveSceneRole(0, 5, 'BODY')).toBe('HOOK');
    expect(resolveSceneRole(4, 5, undefined)).toBe('CONCLUSION');
    expect(resolveSceneRole(2, 5, 'QUOTE')).toBe('QUOTE');
    expect(resolveSceneRole(2, 5, 'PERCENT_CHANGE')).toBe('NUMBER');
    expect(resolveSceneRole(2, 5, 'KPI_SET')).toBe('NUMBER');
    expect(resolveSceneRole(2, 5, 'CAUSE_EFFECT')).toBe('EXPLANATION');
    expect(resolveSceneRole(2, 5, 'CONCEPT')).toBe('EXPLANATION');
    expect(resolveSceneRole(2, 5, 'HOST_STATEMENT')).toBe('BODY');
    // 结构角色优先于内容角色：末段即使含数字也是结论
    expect(resolveSceneRole(4, 5, 'PERCENT_CHANGE', true)).toBe('CONCLUSION');
    // 中间段落含关键数字（无论语义类型）→ NUMBER
    expect(resolveSceneRole(2, 5, 'HOST_STATEMENT', true)).toBe('NUMBER');
  });
});

describe('buildSpeechSegments（确定性段落构建）', () => {
  it('角色修正作用于语速/能量；估计时长按有效语速折算', () => {
    const { segments } = buildSpeechSegments({
      blocks: [block('nbr_1', '开场一句话。'), block('nbr_2', '正文一句话。')],
      semanticByBlock: new Map([['nbr_1', 'HOST_STATEMENT'], ['nbr_2', 'HOST_STATEMENT']]),
      profile: profile(),
    });
    expect(segments[0]).toMatchObject({ sceneRole: 'HOOK', speed: 1.05, energy: 0.75 });
    expect(segments[1]?.sceneRole).toBe('CONCLUSION');
    expect(segments[0]?.expectedDurationMs).toBe(Math.round((segments[0]?.charCount ?? 0) * 273 / 1.05));
    expect(segments[1]).toMatchObject({ speed: 0.98, energy: 0.55 });
  });

  it('关键数字：前后停顿 + 强调区间；句子间隙停顿；同位置合并', () => {
    const text = '利率维持在 5.25% 不变。';
    const { segments } = buildSpeechSegments({
      blocks: [block('nbr_1', text)],
      semanticByBlock: new Map([['nbr_1', 'NUMBER']]),
      profile: profile(),
    });
    const segment = segments[0];
    expect(segment).toBeDefined();
    const numberIndex = text.indexOf('5.25%');
    expect(segment?.emphasisSpans).toEqual([{ startChar: numberIndex, endChar: numberIndex + 5, reason: 'KEY_NUMBER' }]);
    const pauses = segment?.pauses ?? [];
    expect(pauses).toContainEqual({ afterCharIndex: numberIndex, durationMs: 120, reason: 'NUMBER_PREPAUSE' });
    expect(pauses).toContainEqual({ afterCharIndex: numberIndex + 5, durationMs: 200, reason: 'NUMBER_POSTPAUSE' });
    // 句末停顿（「。」之后）
    expect(pauses.some((pause) => pause.reason === 'SENTENCE_GAP' && pause.afterCharIndex === text.length)).toBe(true);
    // 同一位置不重复
    const positions = pauses.map((pause) => pause.afterCharIndex);
    expect(new Set(positions).size).toBe(positions.length);
  });

  it('发音词典命中 → 按术语覆盖（未命中不产生）', () => {
    const custom = mergeSpeechProfileFields({
      pronunciationDictionary: [
        { term: '联邦基金利率', reading: 'lián bāng jī jīn lì lǜ' },
        { term: '不存在的词', reading: 'x' },
      ],
    });
    const { segments } = buildSpeechSegments({
      blocks: [block('nbr_1', '联邦基金利率维持在 5.25% 不变。')],
      semanticByBlock: new Map(),
      profile: custom,
    });
    expect(segments[0]?.pronunciationOverrides).toEqual([{ term: '联邦基金利率', reading: 'lián bāng jī jīn lì lǜ' }]);
  });

  it('越界钳制并记录（可解释降级）：语速与能量', () => {
    const fast = mergeSpeechProfileFields({ defaultSpeed: 2, energy: 0.95 });
    const { segments, warnings } = buildSpeechSegments({
      blocks: [block('nbr_1', '开场。')],
      semanticByBlock: new Map(),
      profile: fast,
    });
    const segment = segments[0];
    // HOOK：2 × 1.05 = 2.1 → 2；0.95 + 0.15 = 1.1 → 1
    expect(segment).toMatchObject({ speed: 2, energy: 1 });
    expect(segment?.degradations.map((entry) => entry.code)).toEqual([
      SPEECH_WARNING_CODES.SPEED_CLAMPED,
      SPEECH_WARNING_CODES.ENERGY_CLAMPED,
    ]);
    expect(warnings.map((warning) => warning.code)).toEqual([
      SPEECH_WARNING_CODES.SPEED_CLAMPED,
      SPEECH_WARNING_CODES.ENERGY_CLAMPED,
    ]);
    expect(segment?.degradations[0]?.message).toContain('钳制为 2.00');
  });

  it('角色修正可被风格覆盖（不是硬编码业务规则）', () => {
    const { segments } = buildSpeechSegments({
      blocks: [block('nbr_1', '开场。')],
      semanticByBlock: new Map(),
      profile: mergeSpeechProfileFields({ defaultSpeed: 2 }),
      styleOverrides: { HOOK: { speedMultiplier: 1, energyDelta: 0 } },
    });
    expect(segments[0]?.speed).toBe(2);
    expect(segments[0]?.degradations).toEqual([]);
  });

  it('锁定旁白逐字使用并标记 locked；场景关联（若提供）写入 sceneId', () => {
    const text = '这是作者锁定的段落。';
    const { segments } = buildSpeechSegments({
      blocks: [block('nbr_1', text, { locked: true })],
      semanticByBlock: new Map(),
      profile: profile(),
      sceneIdByBlock: new Map([['nbr_1', 'dsc_1']]),
    });
    expect(segments[0]).toMatchObject({ text, locked: true, sceneId: 'dsc_1', narrationBlockId: 'nbr_1' });
  });

  it('风格指令按角色取自 SpeechProfile（引用/结论/解释各有其文本）', () => {
    const custom = mergeSpeechProfileFields({ quoteStyle: '引用时降低音量', conclusionStyle: '结论稳定收束' });
    const { segments } = buildSpeechSegments({
      blocks: [block('nbr_1', '开场一句。'), block('nbr_2', '引用一句。'), block('nbr_3', '结论一句。')],
      semanticByBlock: new Map([['nbr_2', 'QUOTE']]),
      profile: custom,
    });
    expect(segments.find((segment) => segment.sceneRole === 'QUOTE')?.styleInstruction).toBe('引用时降低音量');
    expect(segments.find((segment) => segment.sceneRole === 'CONCLUSION')?.styleInstruction).toBe('结论稳定收束');
  });
});
