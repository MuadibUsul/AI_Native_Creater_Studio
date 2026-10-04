import { describe, expect, it } from 'vitest';
import { ApiFailure, CUSTOM_MOTION_ERROR_REASONS, MOTION_PROMPT_VERSION, motionSampleFrames } from '@ancs/contracts';
import { assertDependenciesAllowed, buildMotionDesignPrompts, buildMotionFixture, buildMotionGenerationInput, parseMotionDraft } from './custom-motion.js';

/**
 * P07-02 单测（纯投影，无 DB/沙箱）：
 * 提示词安全约束、结构化输出解析（唯一形态）、依赖白名单、fixture/抽帧采样与生成输入快照。
 */

/** 合法草稿代码样例（沙箱契约：纯 JS + registerMotion；与本文件断言无关的沙箱行为在 motion 套件） */
const VALID_CODE = 'registerMotion({ name: "MockMotion", component: function () { return React.createElement("div", null, String(fixtureProps.headline)); } });';

const SCENE = {
  id: 'scn_motion_1',
  revision: 3,
  sceneType: 'CUSTOM_MOTION',
  narration: '利率维持在 5.25% 不变。',
  visualIntent: 'NUMBER → CUSTOM_MOTION（高光数字动效）',
  durationMs: 6000,
  props: { headline: '5.25%' },
};

describe('buildMotionDesignPrompts（安全约束来自 §11.2）', () => {
  const prompts = buildMotionDesignPrompts({
    name: 'MotionAbc12345',
    sceneType: SCENE.sceneType,
    narration: SCENE.narration,
    visualIntent: SCENE.visualIntent,
    durationMs: SCENE.durationMs,
    aspectRatio: '16:9',
    themeTokens: null,
    props: SCENE.props,
    brief: '数字从 0 计数到 5.25%',
  });

  it('系统提示词包含代码契约与禁令（registerMotion/无 import/无网络/确定性）', () => {
    expect(prompts.systemPrompt).toContain(`promptVersion: ${MOTION_PROMPT_VERSION}`);
    expect(prompts.systemPrompt).toContain('registerMotion');
    expect(prompts.systemPrompt).toContain('无 import');
    expect(prompts.systemPrompt).toContain('fetch');
    expect(prompts.systemPrompt).toContain('useCurrentFrame');
    expect(prompts.systemPrompt).toContain('dependencies 必须为空数组');
  });

  it('用户提示词携带场景上下文（时长/画幅/旁白/fixture/brief）', () => {
    expect(prompts.userPrompt).toContain('6000ms');
    expect(prompts.userPrompt).toContain('16:9');
    expect(prompts.userPrompt).toContain('5.25%');
    expect(prompts.userPrompt).toContain('数字从 0 计数到 5.25%');
  });
});

describe('parseMotionDraft / assertDependenciesAllowed', () => {
  it('合法 JSON → 草稿', () => {
    const draft = parseMotionDraft(JSON.stringify({ name: 'MockMotion', description: 'd', code: VALID_CODE, dependencies: [] }));
    expect(draft.name).toBe('MockMotion');
    expect(draft.code).toContain('registerMotion');
  });

  it('非 JSON / 形态不符 → INVALID_LLM_OUTPUT（不落库的显式失败）', () => {
    for (const content of ['不是 JSON', JSON.stringify({ name: 'x' }), JSON.stringify({ name: 'lowercase', description: 'd', code: 'registerMotion({});', dependencies: [] })]) {
      const error = (() => {
        try {
          parseMotionDraft(content);
          return null;
        } catch (thrown) {
          return thrown as ApiFailure;
        }
      })();
      expect(error).toBeInstanceOf(ApiFailure);
      expect(error?.details['reason']).toBe(CUSTOM_MOTION_ERROR_REASONS.INVALID_LLM_OUTPUT);
    }
  });

  it('依赖白名单：空集通过；白名单外依赖 → 422', () => {
    expect(() => assertDependenciesAllowed([])).not.toThrow();
    const error = (() => {
      try {
        assertDependenciesAllowed(['axios', 'react']);
        return null;
      } catch (thrown) {
        return thrown as ApiFailure;
      }
    })();
    expect(error).toBeInstanceOf(ApiFailure);
    expect(error?.httpStatus).toBe(422);
    expect(error?.details['reason']).toBe(CUSTOM_MOTION_ERROR_REASONS.DEPENDENCY_NOT_ALLOWED);
  });
});

describe('fixture / 抽帧 / 生成输入快照', () => {
  it('fixture：时长 → 帧数（绝对边界换算）；props 原样透传', () => {
    const fixture = buildMotionFixture({ scene: SCENE, fps: 30, width: 1920, height: 1080, fixtureProps: { theme: null } });
    expect(fixture.durationInFrames).toBe(180);
    expect(fixture.props).toEqual({ theme: null });
    expect(motionSampleFrames(fixture.durationInFrames)).toEqual([0, 89, 179]);
  });

  it('抽帧采样：短时长去重（无重复帧、含首末帧）', () => {
    expect(motionSampleFrames(1)).toEqual([0]);
    expect(motionSampleFrames(2)).toEqual([0, 1]);
    expect(motionSampleFrames(3)).toEqual([0, 1, 2]);
    expect(motionSampleFrames(10)).toEqual([0, 4, 9]);
  });

  it('生成输入快照：LLM 所见上下文（含 promptVersion/llmModel/fixture）逐字段固化', () => {
    const fixture = buildMotionFixture({ scene: SCENE, fps: 30, width: 1920, height: 1080, fixtureProps: SCENE.props });
    const input = buildMotionGenerationInput({
      scene: SCENE,
      aspectRatio: '16:9',
      fixture,
      themeTokens: null,
      brief: null,
      llmModel: 'mock-llm-2026-10',
    });
    expect(input.sceneId).toBe('scn_motion_1');
    expect(input.sceneRevision).toBe(3);
    expect(input.promptVersion).toBe(MOTION_PROMPT_VERSION);
    expect(input.llmModel).toBe('mock-llm-2026-10');
    expect(input.fixture.durationInFrames).toBe(180);
    expect(input.durationMs).toBe(6000);
  });
});
