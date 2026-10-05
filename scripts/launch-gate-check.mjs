#!/usr/bin/env node
/**
 * 商业上线门校验（P09-06 / 规范 §47；验收："所需外部条件完成后才能开启正式收款和公开注册"）。
 *
 * 两个部分：
 *  A) **机器条件**：以 ANCS_SAAS_MODE=live 口径运行 env 校验（含 crossCheckApiEnv）——
 *     默认 FREE 套餐 / 真实收款驱动 / 非 local 存储 / https 基址 / 管理员名单；
 *  B) **人工条件台账**：解析 docs/ops/launch-gate.md 的放行台账（LG-xx 行）状态。
 *
 * 用法：
 *   node scripts/launch-gate-check.mjs          # 信息模式（CI）：输出台账与机器条件；文档缺失/畸形 → exit 1
 *   node scripts/launch-gate-check.mjs --live   # 放行判定：任一 BLOCKED 或机器条件不满足 → exit 1
 *
 * 退出码：0 = 通过（或信息模式一切可解析）；1 = 判定失败；2 = 预检失败（文档缺失/畸形）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function findRepoRoot(startDir) {
  let current = resolve(startDir);
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

const root = findRepoRoot(process.cwd());
if (root === null) {
  console.error('launch-gate：找不到仓库根（pnpm-workspace.yaml）');
  process.exit(2);
}

const live = process.argv.includes('--live');

/* ---------- A) 机器条件（以 live 口径校验；不影响当前进程） ---------- */

const { apiEnvSchema, crossCheckApiEnv, validateEnv } = await import(pathToFileURL(join(root, 'packages/contracts/dist/index.js')).href);

const probeEnv = {
  DATABASE_URL: 'postgres://placeholder/placeholder',
  BETTER_AUTH_SECRET: 'launch-gate-probe-secret-placeholder', // secrets:check-ignore：探测用占位（非真实密钥）
  ANCS_SAAS_MODE: 'live',
  ...process.env,
};
const envResult = validateEnv(apiEnvSchema, probeEnv);
const machineIssues = envResult.ok && envResult.value !== null ? crossCheckApiEnv(envResult.value) : envResult.issues;

console.log('===== 商业上线门（P09-06）=====');
console.log(
  `运行模式：ANCS_SAAS_MODE=${process.env['ANCS_SAAS_MODE'] ?? 'internal（默认）'}${
    live ? '（本命令以 live 口径判定）' : ''
  }`,
);
console.log('\n[机器条件]（live 模式；API 启动时会做同一校验并 fail-closed）');
console.log(`  实测环境 ANCS_DEFAULT_PLAN=${process.env['ANCS_DEFAULT_PLAN'] ?? '（未配置）'}`);
console.log(`  实测环境 ANCS_PAYMENTS_DRIVER=${process.env['ANCS_PAYMENTS_DRIVER'] ?? '（未配置）'}`);
console.log(`  实测环境 ANCS_STORAGE_DRIVER=${process.env['ANCS_STORAGE_DRIVER'] ?? '（未配置）'}`);
if (machineIssues.length === 0) {
  console.log('  → 机器条件：全部满足');
} else {
  console.log(`  → 机器条件：${String(machineIssues.length)} 项不满足（live 放行被拒绝）：`);
  for (const issue of machineIssues) console.log(`     - ${issue.variable}：${issue.message}`);
}

/* ---------- B) 人工条件台账 ---------- */

const ledgerPath = join(root, 'docs/ops/launch-gate.md');
if (!existsSync(ledgerPath)) {
  console.error('\n[人工条件] 缺少台账文件 docs/ops/launch-gate.md');
  process.exit(2);
}
const ledgerText = readFileSync(ledgerPath, 'utf8');
const rows = [];
for (const line of ledgerText.split('\n')) {
  const match = /^\|\s*(LG-\d{2})\s*\|([^|]*)\|([^|]*)\|\s*(BLOCKED|APPROVED)\s*\|(.*)\|\s*$/.exec(line);
  if (match !== null) {
    rows.push({ id: match[1], item: match[2].trim(), evidence: match[3].trim(), status: match[4], note: match[5].trim() });
  }
}
if (rows.length === 0) {
  console.error('\n[人工条件] 台账解析失败（未找到 LG-xx 行——检查表格格式：ID|条目|证据要求|BLOCKED|APPROVED|备注）');
  process.exit(2);
}
const approved = rows.filter((row) => row.status === 'APPROVED');
const blocked = rows.filter((row) => row.status === 'BLOCKED');

console.log(`\n[人工条件] 放行台账（docs/ops/launch-gate.md）：APPROVED ${String(approved.length)} / ${String(rows.length)}`);
if (blocked.length > 0) {
  console.log('  未完成（外部条件；需人工：法务/商务/财务/工程）：');
  for (const row of blocked) console.log(`   - ${row.id} ${row.item}（${row.note.slice(0, 80)}）`);
}
for (const row of approved) console.log(`   ✓ ${row.id} ${row.item} —— 证据：${row.evidence}`);

/* ---------- 判定 ---------- */

if (live) {
  if (machineIssues.length > 0 || blocked.length > 0) {
    console.error(
      `\nlaunch-gate：**不得开启正式收款与公开注册**（机器条件不满足 ${String(machineIssues.length)} 项；人工条件未完成 ${String(blocked.length)} 项）。`,
    );
    console.error('  路径：完成外部条件 → 台账逐条填写证据并置 APPROVED → 以 ANCS_SAAS_MODE=live 部署。');
    process.exit(1);
  }
  console.log('\nlaunch-gate：放行判定通过（机器条件全部满足 + 台账全部 APPROVED）。');
  process.exit(0);
}

console.log('\nlaunch-gate：信息模式（未请求放行判定）。当前状态 = 预上线（internal）——正式收款/公开注册未开启。');
process.exit(0);
