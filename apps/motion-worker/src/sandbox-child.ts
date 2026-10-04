import { createContext, createElement, useContext, type ReactElement } from 'react';
import * as nodeVm from 'node:vm';
import { renderToStaticMarkup } from 'react-dom/server';
import { analyzeMotionCode } from './analysis.ts';

/**
 * 沙箱子进程（P07-01）：从 stdin 读取提交，隔离评估 + 渲染 smoke，stdout 输出 JSON 回执。
 *
 * 隔离面（进程内）：
 * - 代码在 `node:vm` **新上下文**评估：上下文仅注入白名单全局（MOTION_SANDBOX_GLOBALS）；
 * - **无 fetch/require/process/fs**（本文件顶部即删除危险全局的可见性——子进程自己的全局不进 vm 上下文，
 *   vm 内代码无法触及宿主 require）；
 * - 渲染 smoke 使用宿主注入的确定性 remotion 语义（帧由提交 fixture 固定）；
 * - 静态分析在子进程**再次**执行（双保险；宿主侧已做过一次）。
 */

interface SandboxFixture {
  props: Record<string, unknown>;
  frame: number;
  fps: number;
  durationInFrames: number;
  width: number;
  height: number;
}

interface SandboxSubmission {
  submissionId: string;
  code: string;
  fixture: SandboxFixture;
}

interface MotionRegistration {
  component?: (props: Record<string, unknown>) => ReactElement;
  name?: string;
}

const emit = (verdict: Record<string, unknown> & { submissionId: string }): void => {
  process.stdout.write(`${JSON.stringify(verdict)}\n`);
};

const fail = (submissionId: string, stage: string, message: string): void => {
  emit({ submissionId, verdict: 'REJECTED', stage, message });
};

/* ---------- 确定性 remotion 语义（smoke 用；P07-04 真实渲染走 remotion-core） ---------- */

const VideoConfigContext = createContext<{ fps: number; durationInFrames: number; width: number; height: number }>({
  fps: 30,
  durationInFrames: 90,
  width: 1920,
  height: 1080,
});
const FrameContext = createContext<number>(0);

const useCurrentFrame = (): number => useContext(FrameContext);
const useVideoConfig = (): { fps: number; durationInFrames: number; width: number; height: number } => useContext(VideoConfigContext);

const interpolate = (
  input: number,
  inputRange: readonly number[],
  outputRange: readonly number[],
  options?: { extrapolateLeft?: string; extrapolateRight?: string },
): number => {
  if (inputRange.length < 2 || outputRange.length < 2) return outputRange[0] ?? 0;
  if (input <= (inputRange[0] ?? 0)) {
    if (options?.extrapolateLeft === 'clamp') return outputRange[0] ?? 0;
  }
  const last = inputRange.length - 1;
  if (input >= (inputRange[last] ?? 0)) {
    if (options?.extrapolateRight === 'clamp') return outputRange[last] ?? 0;
  }
  for (let index = 1; index < inputRange.length; index += 1) {
    const upper = inputRange[index];
    const lower = inputRange[index - 1];
    if (upper === undefined || lower === undefined) continue;
    if (input <= upper) {
      const t = (input - lower) / (upper - lower || 1);
      const outLower = outputRange[index - 1] ?? 0;
      const outUpper = outputRange[index] ?? 0;
      return outLower + t * (outUpper - outLower);
    }
  }
  return outputRange[last] ?? 0;
};

const spring = (_options?: Record<string, unknown> & { frame?: number; fps?: number }): number => 1;

const AbsoluteFill = ({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }): ReactElement =>
  createElement('div', { style: { position: 'absolute', inset: 0, display: 'flex', ...style } }, children);

/* ---------- 沙箱评估 ---------- */

const evaluateMotion = (code: string, fixture: SandboxFixture): MotionRegistration => {
  const registrations: MotionRegistration[] = [];
  const registerMotion = (registration: MotionRegistration): void => {
    if (registration === null || typeof registration !== 'object') throw new Error('registerMotion 参数必须是对象');
    registrations.push(registration);
  };

  const sandboxGlobals: Record<string, unknown> = {
    registerMotion,
    React: { createElement, createContext, useContext, Fragment: 'Fragment' },
    // 沙箱内 useState 为只读语义（smoke 只渲染单帧；setState 在真实渲染中由 React 驱动）
    useState: <T,>(initial: T): [T, (next: T | ((previous: T) => T)) => void] => [initial, () => undefined],
    useMemo: <T,>(factory: () => T): T => factory(),
    useRef: <T,>(initial: T): { current: T } => ({ current: initial }),
    useEffect: () => undefined,
    useCurrentFrame,
    useVideoConfig,
    interpolate,
    spring,
    AbsoluteFill,
    fixtureProps: fixture.props,
    Math,
    JSON,
    Date,
    Number,
    String,
    Boolean,
    Array,
    Object,
    isFinite,
    isNaN,
    parseFloat,
    parseInt,
  };

  // 上下文不含宿主任意全局（createContext 只暴露以上白名单；codeGeneration=false 禁止 vm 内再生成代码）
  const context = nodeVm.createContext(sandboxGlobals, { codeGeneration: { strings: false, wasm: false } });
  nodeVm.runInContext(code, context, { timeout: 2000, filename: 'custom-motion.js' });

  const registration = registrations.at(-1);
  if (registration === undefined || typeof registration.component !== 'function') {
    throw new Error('Motion 代码未调用 registerMotion({ component })（契约：必须注册组件）');
  }
  return registration;
};

/* ---------- 渲染 smoke ---------- */

const renderSmoke = (registration: MotionRegistration, fixture: SandboxFixture): { markup: string; renderMs: number } => {
  const started = Date.now();
  const component = registration.component;
  if (component === undefined) throw new Error('component 缺失');
  // 通过 React 渲染（组件内 hooks 需要 dispatcher；直接调用会脱离渲染上下文）
  const element = createElement(component as never, { ...fixture.props } as never);
  const markup = renderToStaticMarkup(
    createElement(
      VideoConfigContext.Provider,
      { value: { fps: fixture.fps, durationInFrames: fixture.durationInFrames, width: fixture.width, height: fixture.height } },
      createElement(FrameContext.Provider, { value: fixture.frame }, element),
    ),
  );
  return { markup, renderMs: Date.now() - started };
};

/* ---------- 入口 ---------- */

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

const main = async (): Promise<void> => {
  const raw = await readStdin();

  let submission: SandboxSubmission;
  try {
    submission = JSON.parse(raw) as SandboxSubmission;
  } catch {
    emit({ submissionId: 'unknown', verdict: 'CRASHED', stage: 'EXECUTION', message: '提交载荷不是合法 JSON' });
    return;
  }
  const { submissionId } = submission;

  try {
    // 双保险：子进程侧静态分析（宿主侧已做；防"绕过宿主"的调用路径）
    const analysis = analyzeMotionCode(submission.code);
    if (!analysis.ok) {
      emit({ submissionId, verdict: 'REJECTED', stage: 'STATIC_ANALYSIS', issues: analysis.issues });
      return;
    }

    let registration: MotionRegistration;
    try {
      registration = evaluateMotion(submission.code, submission.fixture);
    } catch (error) {
      fail(submissionId, 'EVALUATION', error instanceof Error ? error.message : String(error));
      return;
    }

    try {
      const { markup, renderMs } = renderSmoke(registration, submission.fixture);
      emit({ submissionId, verdict: 'APPROVED', stage: 'RENDER_SMOKE', markupLength: markup.length, renderMs });
    } catch (error) {
      fail(submissionId, 'RENDER_SMOKE', error instanceof Error ? `${error.message}` : String(error));
    }
  } catch (error) {
    // 兜底：任何未预期异常都按 CRASHED 上报（宿主会展示 stderr 摘要）
    emit({ submissionId, verdict: 'CRASHED', stage: 'EXECUTION', message: error instanceof Error ? error.message : String(error) });
  }
};

await main();
