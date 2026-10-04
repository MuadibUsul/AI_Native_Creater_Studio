import { describe, expect, it } from 'vitest';
import { typecheckMotionCode } from './typecheck.ts';
import { validateMotion } from './validator.ts';
import { MOTION_DRAFT_CODE } from '@ancs/providers-mock-llm';

/**
 * P07-02 门禁验证（motion 项目）：
 * 四道门禁（静态分析 → 类型检查 → 沙箱评估 → 抽帧）的接受/拒绝矩阵 + 抽帧确定性。
 * Mock LLM 的四种草稿（valid/unsafe/type_error/unregistered）与阶段映射一一对应。
 */

const FIXTURE = {
  props: { headline: '利率周报', theme: { color: { accent: '#4F8CFF' } } },
  fps: 30,
  durationInFrames: 90,
  width: 1920,
  height: 1080,
};

const SAMPLE_FRAMES = [0, 44, 89];

describe('Motion 四道门禁（P07-02）', () => {
  it('合法 Motion → APPROVED（四阶段全过；抽帧 3 帧、帧间输出不同、逐帧哈希）', async () => {
    const report = await validateMotion({ code: MOTION_DRAFT_CODE.valid, name: 'MockMotion', fixture: FIXTURE, sampleFrames: SAMPLE_FRAMES });
    expect(report.verdict).toBe('APPROVED');
    expect(report.stages.map((stage) => stage.stage)).toEqual(['STATIC_ANALYSIS', 'TYPE_CHECK', 'SANDBOX_EVALUATION', 'FRAME_SAMPLES']);
    expect(report.stages.every((stage) => stage.ok)).toBe(true);
    expect(report.frames.map((frame) => frame.frame)).toEqual(SAMPLE_FRAMES);
    expect(report.frames.every((frame) => frame.markupLength > 0)).toBe(true);
    expect(new Set(report.frames.map((frame) => frame.sha256)).size).toBe(SAMPLE_FRAMES.length);
    expect(report.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.renderMs).not.toBeNull();
    expect(report.warnings).toEqual([]);
  });

  it('危险词法（网络）→ STATIC_ANALYSIS 拒绝（后续阶段不执行）', async () => {
    const report = await validateMotion({ code: MOTION_DRAFT_CODE.unsafe, name: 'MockMotion', fixture: FIXTURE, sampleFrames: SAMPLE_FRAMES });
    expect(report.verdict).toBe('REJECTED');
    expect(report.stages).toHaveLength(1);
    expect(report.stages[0]?.stage).toBe('STATIC_ANALYSIS');
    expect(report.stages[0]?.ok).toBe(false);
    expect(report.frames).toEqual([]);
  });

  it('类型错误（arity 不符）→ TYPE_CHECK 拒绝', async () => {
    const report = await validateMotion({ code: MOTION_DRAFT_CODE.type_error, name: 'MockMotion', fixture: FIXTURE, sampleFrames: SAMPLE_FRAMES });
    expect(report.verdict).toBe('REJECTED');
    const failed = report.stages.filter((stage) => !stage.ok).map((stage) => stage.stage);
    expect(failed).toEqual(['TYPE_CHECK']);
  });

  it('未注册组件 → SANDBOX_EVALUATION 拒绝（契约：必须 registerMotion）', async () => {
    const report = await validateMotion({ code: MOTION_DRAFT_CODE.unregistered, name: 'MockMotion', fixture: FIXTURE, sampleFrames: SAMPLE_FRAMES });
    expect(report.verdict).toBe('REJECTED');
    const evaluation = report.stages.find((stage) => stage.stage === 'SANDBOX_EVALUATION');
    expect(evaluation?.ok).toBe(false);
    expect(evaluation?.message ?? '').toContain('registerMotion');
  });

  it('渲染期异常 → FRAME_SAMPLES 拒绝（评估通过但渲染失败）', async () => {
    const code = 'registerMotion({ name: "MockMotion", component: function () { throw new Error("boom"); } });';
    const report = await validateMotion({ code, name: 'MockMotion', fixture: FIXTURE, sampleFrames: SAMPLE_FRAMES });
    expect(report.verdict).toBe('REJECTED');
    const stages = report.stages.map((stage) => `${stage.stage}:${String(stage.ok)}`);
    expect(stages).toEqual(['STATIC_ANALYSIS:true', 'TYPE_CHECK:true', 'SANDBOX_EVALUATION:true', 'FRAME_SAMPLES:false']);
  });

  it('抽帧确定性：同代码同 fixture → 逐帧哈希一致（可复算证据）', async () => {
    const first = await validateMotion({ code: MOTION_DRAFT_CODE.valid, name: 'MockMotion', fixture: FIXTURE, sampleFrames: SAMPLE_FRAMES });
    const second = await validateMotion({ code: MOTION_DRAFT_CODE.valid, name: 'MockMotion', fixture: FIXTURE, sampleFrames: SAMPLE_FRAMES });
    expect(second.sourceSha256).toBe(first.sourceSha256);
    expect(second.frames.map((frame) => frame.sha256)).toEqual(first.frames.map((frame) => frame.sha256));
  });
});

describe('Motion 类型检查（tsc 内存程序，不执行代码）', () => {
  it('合法代码 → 无诊断', () => {
    const result = typecheckMotionCode(MOTION_DRAFT_CODE.valid);
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  it('未定义标识符/arity 错误 → 有诊断（行号可定位）', () => {
    const result = typecheckMotionCode('registerMotion({ name: "X", component: function () { return useFramee(); } });');
    expect(result.ok).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0]?.line).toBeGreaterThan(0);
  });
});
