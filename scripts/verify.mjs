#!/usr/bin/env node
/**
 * 统一验证入口（计划 §11.1）。
 *
 * - 顺序：secrets:check → lint → typecheck → build → arch:check → 全部测试套件；
 * - 不包含 test:provider-smoke（真实 Provider 费用，单独显式开启）；
 * - [PLANNED] 套件不执行断言、不代表通过；任一已实现步骤失败即退出非零。
 */
import { spawnSync } from 'node:child_process';

const steps = [
  'secrets:check',
  'lint',
  'typecheck',
  'build',
  'arch:check',
  'test:unit',
  'test:contract',
  'test:integration',
  'test:e2e',
  'test:security',
  'test:render',
  'test:golden',
];

const isWindows = process.platform === 'win32';
const results = [];
let failedStep = null;

for (const step of steps) {
  console.log(`\n===== verify: pnpm run ${step} =====`);
  const result = isWindows
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', `pnpm run ${step}`], { stdio: 'inherit' })
    : spawnSync('pnpm', ['run', step], { stdio: 'inherit' });
  const ok = result.status === 0;
  results.push([step, ok]);
  if (!ok) {
    failedStep = step;
    break;
  }
}

console.log('\n===== verify 汇总 =====');
for (const [step, ok] of results) {
  console.log(` ${ok ? 'PASS' : 'FAIL'}  ${step}`);
}
for (const step of steps.slice(results.length)) {
  console.log(` SKIP  ${step}（前序步骤失败，未执行）`);
}

if (failedStep) {
  console.error(`\nverify 失败：${failedStep}。已实现的套件必须全部通过；[PLANNED] 占位不代表通过。`);
  process.exit(1);
}

console.log('\nverify 通过（[PLANNED] 套件不执行断言；关闭进度见 docs/requirements/v1-acceptance-ledger.md）。');
