#!/usr/bin/env node
/**
 * 真实 Provider smoke test（单独开启；计划 §11.1）。
 *
 * 约定：
 * - `pnpm verify` 默认不产生真实 Provider 费用，不包含本脚本；
 * - 真实 smoke 需要显式开启，并要求凭据与非零批准预算：
 *     ANCS_REAL_PROVIDER_SMOKE=1
 *     PLATFORM_PROVIDER_KEYS=<JSON>
 * - 在 P06-01（真实 Provider 能力核验）之前，本脚本只会明确失败——不得伪造"真实生成成功"。
 */
const enabled = process.env.ANCS_REAL_PROVIDER_SMOKE === '1';
const hasKeys = Boolean(process.env.PLATFORM_PROVIDER_KEYS);

if (!enabled || !hasKeys) {
  console.error('[provider-smoke] 未开启：真实 Provider smoke 默认关闭。');
  console.error('  开启条件：ANCS_REAL_PROVIDER_SMOKE=1，且配置 PLATFORM_PROVIDER_KEYS 与非零批准预算。');
  console.error('  依据：ANCS_Plan261004.md §11.1（verify 默认不产生真实 Provider 费用）。');
  process.exit(1);
}

console.error('[provider-smoke] NOT_IMPLEMENTED：真实 smoke 用例计划在 P06-01 阶段实现。');
console.error('  在此之前，本脚本拒绝以任何形式返回"成功"。');
process.exit(1);
