import ts from 'typescript';

/**
 * Motion 代码类型检查（P07-02 / 规范 §11.2-4："TypeScript 编译检查"）。
 *
 * 实现：TypeScript 编译器 API + **内存虚拟文件系统**（不落盘、不执行代码——只解析/检查）。
 * 代码按 JavaScript（allowJs + checkJs + strict）检查，沙箱注入的全局以环境声明（ambient d.ts）提供：
 * 调用形态错误（arity/类型不符/未定义引用）在**评估之前**被拒绝。
 *
 * 安全说明：tsc 只做语法/类型分析，**不运行**任何代码；无需隔离进程（纯 CPU 有界）。
 */

export const MOTION_TYPECHECK_VERSION = 'motion-typecheck-v1';

export interface MotionTypecheckDiagnostic {
  message: string;
  line: number;
  column: number;
}

export interface MotionTypecheckResult {
  ok: boolean;
  diagnostics: MotionTypecheckDiagnostic[];
}

/** 沙箱注入全局的环境声明（与 sandbox-child.ts 的实际注入保持一致；改动需同步）。 */
const AMBIENT_DECLARATIONS = `
declare function registerMotion(registration: {
  name?: string;
  component: (props: Record<string, unknown>) => unknown;
}): void;
declare const React: {
  createElement: (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => unknown;
  createContext: (defaultValue: unknown) => unknown;
  useContext: (context: unknown) => unknown;
  Fragment: unknown;
};
declare function useState<T>(initial: T): [T, (next: T | ((previous: T) => T)) => void];
declare function useMemo<T>(factory: () => T): T;
declare function useRef<T>(initial: T): { current: T };
declare function useEffect(effect: () => void | (() => void), deps?: unknown[]): void;
declare function useCurrentFrame(): number;
declare function useVideoConfig(): { fps: number; durationInFrames: number; width: number; height: number };
declare function interpolate(
  input: number,
  inputRange: readonly number[],
  outputRange: readonly number[],
  options?: { extrapolateLeft?: string; extrapolateRight?: string },
): number;
declare function spring(options?: Record<string, unknown>): number;
declare function AbsoluteFill(props: { children?: unknown; style?: Record<string, unknown> }): unknown;
declare const fixtureProps: Record<string, unknown>;
`;

/** 对代码做类型检查（返回结构化诊断；不抛异常）。 */
export function typecheckMotionCode(code: string): MotionTypecheckResult {
  const virtualFiles = new Map<string, string>([
    ['/motion/custom-motion.js', code],
    ['/motion/ambient.d.ts', AMBIENT_DECLARATIONS],
  ]);
  const options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: true,
    // 生成代码是**纯 JS**（无 JSDoc 注解）：不开启 noImplicitAny（参数隐式 any 是常态），
    // 但仍检查名称解析/arity/显式类型不符等真实错误（未定义标识符、调用形态错误）。
    strict: false,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    types: [],
    lib: ['lib.es2022.d.ts'],
  };

  const defaultHost = ts.createCompilerHost(options);
  const normalize = (fileName: string): string => fileName.replace(/\\/g, '/');
  const host: ts.CompilerHost = {
    ...defaultHost,
    fileExists: (fileName) => virtualFiles.has(normalize(fileName)) || defaultHost.fileExists(fileName),
    readFile: (fileName) => virtualFiles.get(normalize(fileName)) ?? defaultHost.readFile(fileName),
    getSourceFile: (fileName, languageVersion) => {
      const normalized = normalize(fileName);
      const virtual = virtualFiles.get(normalized);
      if (virtual !== undefined) return ts.createSourceFile(fileName, virtual, languageVersion, true);
      return defaultHost.getSourceFile(fileName, languageVersion);
    },
    getCurrentDirectory: () => '/motion',
    writeFile: () => undefined,
  };

  const program = ts.createProgram(['/motion/custom-motion.js', '/motion/ambient.d.ts'], options, host);
  const diagnostics = [
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
  ].map((diagnostic) => {
    const position = diagnostic.file !== undefined && diagnostic.start !== undefined ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start) : null;
    return {
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
      line: (position?.line ?? 0) + 1,
      column: (position?.character ?? 0) + 1,
    };
  });

  return { ok: diagnostics.length === 0, diagnostics };
}
