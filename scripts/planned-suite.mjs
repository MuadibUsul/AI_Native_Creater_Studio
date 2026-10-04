#!/usr/bin/env node
/**
 * 未实现测试套件的显式占位（反"假成功"约束，计划 §7 / §11.1）。
 *
 * 本脚本不执行任何断言，也不代表套件通过，只声明：
 *   - 该套件尚未实现；
 *   - 计划在哪个阶段实现；
 *   - 实现后必须替换为真实套件。
 *
 * 阶段门（G1—G4）以 docs/requirements/v1-acceptance-ledger.md 与 P08-06 对账为准，
 * 不依赖本占位脚本的退出码。
 */
const [suite, phase, ...reasonParts] = process.argv.slice(2);

if (!suite || !phase) {
  console.error('用法: node scripts/planned-suite.mjs <suite> <plan-phase> [说明]');
  process.exit(2);
}

console.log(`[PLANNED] ${suite} 尚未实现（计划阶段：${phase}）。`);
if (reasonParts.length > 0) {
  console.log(`  说明：${reasonParts.join(' ')}`);
}
console.log('  状态：不执行任何断言，不代表通过；实现后必须替换为真实套件（见 ANCS_Plan261004.md §11）。');
process.exit(0);
