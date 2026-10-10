/**
 * Custom Motion 静态分析（P07-01 / REQ-11-03 / 规范 §11.2、§75 第 15 条）。
 *
 * 在**评估之前**拒绝危险代码（白名单之外的一切访问路径）：
 * - 任何 import / require / 动态 import（依赖只允许宿主注入的白名单全局，无用户可控依赖）；
 * - 网络（fetch/XMLHttpRequest/WebSocket/net/http/https/dns）；
 * - 文件/进程/环境（fs、child_process、worker_threads、process、Bun/Deno 全局）；
 * - 动态执行（eval、Function 构造器、GeneratorFunction/AsyncFunction 构造器、vm）；
 * - 全局对象逃逸（globalThis、global、self、window、top、parent、frames）；
 * - 原型污染入口（__proto__ 赋值、constructor[key] 访问模式、Object.defineProperty 于 Function.prototype）。
 *
 * 纪律：这是**第一道门**，不是唯一一道（隔离进程 + 超时强杀 + 渲染 smoke 是后续防线，§11.2
 * "不能只依赖静态代码检查"）。
 */

export interface MotionAnalysisIssue {
  rule: string;
  line: number;
  excerpt: string;
}

export interface MotionAnalysisResult {
  ok: boolean;
  issues: MotionAnalysisIssue[];
}

const FORBIDDEN_PATTERNS: { rule: string; re: RegExp }[] = [
  // 模块加载（白名单外依赖一律禁止；Custom Motion 代码必须自包含，宿主注入白名单全局）
  { rule: 'IMPORT_STATEMENT', re: /\bimport\s*[\s({'"*]/ },
  { rule: 'IMPORT_EQUALS', re: /\bimport\s+[A-Za-z_$][\w$]*\s*=/ },
  { rule: 'REQUIRE_CALL', re: /\brequire\s*\(/ },
  { rule: 'DYNAMIC_IMPORT', re: /\bimport\s*\(/ },
  // 网络（默认无网络；§11.2）
  { rule: 'FETCH_CALL', re: /\bfetch\s*\(/ },
  { rule: 'XHR', re: /\bXMLHttpRequest\b/ },
  { rule: 'WEBSOCKET', re: /\bWebSocket\b/ },
  { rule: 'NET_MODULE', re: /\b(net|http|https|dns|tls|dgram)\s*([.;]|\b)/ },
  // 文件/进程/环境（不得访问 Secret 与任意路径）
  { rule: 'FS_MODULE', re: /\bfs\b\s*([.;]|\b)/ },
  { rule: 'FS_PROMISES', re: /\bfs\/promises\b|\bnode:fs\b/ },
  { rule: 'CHILD_PROCESS', re: /\bchild_process\b|\bspawn\s*\(|\bexec\s*\(/ },
  { rule: 'WORKER_THREADS', re: /\bworker_threads\b|\bnew\s+Worker\s*\(/ },
  { rule: 'PROCESS_GLOBAL', re: /\bprocess\s*\./ },
  { rule: 'ENV_ACCESS', re: /\benv\s*[.[]/ },
  // 动态执行
  { rule: 'EVAL_CALL', re: /\beval\s*\(/ },
  { rule: 'FUNCTION_CONSTRUCTOR', re: /\bnew\s+Function\b/ },
  { rule: 'GENERATOR_CONSTRUCTOR', re: /\bGeneratorFunction\b|\bAsyncFunction\b/ },
  { rule: 'VM_MODULE', re: /\bvm\b\s*([.;]|\b)|\bnode:vm\b/ },
  // 全局逃逸
  { rule: 'GLOBAL_THIS', re: /\bglobalThis\b/ },
  { rule: 'GLOBAL_ALIAS', re: /\b(global|self|window|top|parent|frames)\s*\./ },
  { rule: 'ROOT_ESCAPE', re: /\broot\s*\./ },
  // 原型污染 / 宿主 realm 逃逸
  // 只标记"取属性"形式（`x.constructor` / `x["constructor"]`），不误伤合法 `class { constructor() {} }`。
  { rule: 'PROTO_ACCESS', re: /__proto__|\[\s*['"]constructor['"]\s*\]|[\w$)\]}\]]\s*\.\s*constructor\b/ },
  { rule: 'REFLECT_ESCAPE', re: /\bReflect\s*\.\s*(construct|getPrototypeOf|apply)\b/ },
  { rule: 'PROTO_SET', re: /\b(Object|Reflect)\s*\.\s*setPrototypeOf\b/ },
  { rule: 'DEFINE_PROPERTY_PROTO', re: /defineProperty\s*\(\s*(Object|Function)\.prototype/ },
];

/** 逐行扫描；返回全部命中（供报告展示"为什么被拒"）。 */
export function analyzeMotionCode(code: string): MotionAnalysisResult {
  const issues: MotionAnalysisIssue[] = [];
  const lines = code.split(String.fromCharCode(10));
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.re.test(line)) {
        issues.push({ rule: pattern.rule, line: index + 1, excerpt: line.trim().slice(0, 120) });
      }
    }
  }
  return { ok: issues.length === 0, issues };
}

/** 白名单全局（沙箱仅注入这些；Motion 代码不得引用其它任何标识符来源）。 */
export const MOTION_SANDBOX_GLOBALS = [
  'registerMotion',
  'React',
  'useState',
  'useMemo',
  'useRef',
  'useEffect',
  'useCurrentFrame',
  'useVideoConfig',
  'interpolate',
  'spring',
  'AbsoluteFill',
  'fixtureProps',
  'Math',
  'JSON',
  'Date',
  'Number',
  'String',
  'Boolean',
  'Array',
  'Object',
  'isFinite',
  'isNaN',
  'parseFloat',
  'parseInt',
] as const;
