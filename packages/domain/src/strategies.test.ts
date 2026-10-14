import { describe, expect, it } from 'vitest';
import { ApiFailure, STRATEGY_ERROR_REASONS } from '@ancs/contracts';
import { AGENT_SYSTEM_PROMPT } from './agent-prompt.js';
import { defaultAgentToolCatalog } from './agent-tools.js';
import { BUILT_IN_STRATEGY_PACKS, resolveStrategyKnobs, strategyGuidanceText } from './strategies.js';

/**
 * V6 §6.6 策略剪辑（可选）：策略包只是数据。
 * - 两个手写旅游预设可解析、双语齐全；旋钮只接受声明过的值，缺省取默认；
 * - 给 AI 的要点标明"可选参考、素材与要求优先"，带结构建议、剪辑 DNA、旋钮取值与风格评分项；
 * - 通用性守卫：系统提示与工具目录不提任何策略或类型（裁决 0018）。
 */
describe('策略包（可选风格）', () => {
  const [documentary, beat] = BUILT_IN_STRATEGY_PACKS;

  it('内置预设：两个旅游风格与一个知识解说风格（V6-5），中英文名称与说明齐全', () => {
    expect(BUILT_IN_STRATEGY_PACKS.map((pack) => pack.id)).toEqual(['builtin:travel-documentary', 'builtin:travel-beat', 'builtin:explainer']);
    for (const pack of BUILT_IN_STRATEGY_PACKS) {
      expect(pack.name['zh-CN'].length).toBeGreaterThan(0);
      expect(pack.summary.en.length).toBeGreaterThan(0);
      for (const knob of pack.knobs) expect(knob.options.map((option) => option.value)).toContain(knob.defaultValue);
    }
  });

  it('旋钮：缺省取默认值；未声明的键或值 422', () => {
    expect(resolveStrategyKnobs(documentary!, {})).toEqual({ pacing: 'default', sound: 'natural' });
    expect(resolveStrategyKnobs(beat!, { pacing: 'intense' })).toEqual({ pacing: 'intense', transitions: 'hard_cuts' });
    const bad = (() => { try { resolveStrategyKnobs(beat!, { pacing: 'warp' }); return null; } catch (error) { return error; } })();
    expect(bad).toBeInstanceOf(ApiFailure);
    expect((bad as ApiFailure).details['reason']).toBe(STRATEGY_ERROR_REASONS.INVALID_KNOB);
    expect(() => resolveStrategyKnobs(beat!, { color: 'warm' })).toThrow(ApiFailure);
  });

  it('给 AI 的要点：可选参考 + 结构建议 + DNA + 旋钮 + 评分项', () => {
    const text = strategyGuidanceText(beat!, resolveStrategyKnobs(beat!, { pacing: 'intense' }));
    expect(text).toContain('optional style reference, not a template');
    expect(text).toContain('Hook (0-3 s)');
    expect(text).toContain('shot length typically 0.5-2 s (median 1.1 s)');
    expect(text).toContain('about 80% of cuts on music beats');
    expect(text).toContain('- pacing = intense: Use shots of about 0.4-1 s');
    expect(text).toContain('Most cut points fall on music beats');
  });

  it('通用性守卫：系统提示与工具目录不提任何策略名或类型', () => {
    const toolText = JSON.stringify(defaultAgentToolCatalog().descriptors());
    for (const pack of BUILT_IN_STRATEGY_PACKS) {
      expect(AGENT_SYSTEM_PROMPT).not.toContain(pack.id);
      expect(AGENT_SYSTEM_PROMPT).not.toContain(pack.name.en);
      expect(toolText).not.toContain(pack.id);
    }
    expect(AGENT_SYSTEM_PROMPT.toLowerCase()).not.toContain('travel');
  });
});
