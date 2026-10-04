#!/usr/bin/env node
/**
 * 真实 Provider smoke（单独开启；计划 §11.1 / P06-01）。
 *
 * 本脚本委托 `scripts/provider-verify.mjs`（P06-01 能力核验工具）：
 * - 未配置凭据 → 退出码 2 并列出缺失的环境变量（**"未配置" ≠ "通过"**，绝不伪造成功）；
 * - 需要 `ANCS_PROVIDER_VERIFY=1` 显式开启（真实调用会产生费用/配额消耗）；
 * - `pnpm verify` 不包含本脚本（默认零真实费用，§11.1）。
 *
 * 用法：ANCS_PROVIDER_VERIFY=1 ELEVENLABS_API_KEY=... node scripts/provider-smoke.mjs
 *      预览（不需要凭据）：node scripts/provider-verify.mjs --dry
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const result = spawnSync(process.execPath, [path.resolve(import.meta.dirname, 'provider-verify.mjs'), ...process.argv.slice(2)], {
  stdio: 'inherit',
});
if (result.status === 2) {
  console.error('[provider-smoke] 未执行真实调用（凭据缺失或未显式开启）——这是刻意的 fail-closed，不代表通过。');
}
process.exit(result.status ?? 1);
