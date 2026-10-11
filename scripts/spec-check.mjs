#!/usr/bin/env node
/**
 * 规范与账本一致性检查（V5 §19.2；纳入 `pnpm verify`）。
 *
 * 事实源：docs/requirements/ai-native-v04-acceptance-ledger.md 的任务明细表
 * （`| 任务 | 标题 | 依赖 | v0.4 状态 | 证据 / 交接 |`）。
 *
 * 检查项（任一失败 → 非零退出，并逐条列出）：
 *  1. 每个 VERIFIED 任务的依赖必须全部 VERIFIED（或在 WAIVERS 中有裁决文件批准的显式降级）；
 *  2. 每个 VERIFIED 任务都有独立的 docs/verification/<id>.md 与 docs/handoffs/<id>.md；
 *  3. 账本顶部"工作流汇总表"中的 VERIFIED 数与明细表逐行统计一致；
 *  4. 明细表中的依赖 ID 都存在（不引用不存在的任务）。
 *
 * 不做：不解析叙述性段落（叙述以表格为准，见 V5 §19.1）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const ledgerPath = join(root, 'docs/requirements/ai-native-v04-acceptance-ledger.md');

/**
 * 依赖降级白名单：{ 任务: { 依赖: 裁决文件 } }。
 * 只有在 docs/decisions/ 中有明确裁决时才允许添加；裁决文件必须存在。
 */
const WAIVERS = {};

const ledger = readFileSync(ledgerPath, 'utf8');
const lines = ledger.split(/\r?\n/);

/** @type {Map<string, { title: string, deps: string[], status: string, line: number }>} */
const tasks = new Map();
const rowPattern = /^\|\s*(N\d\d-\d\d)\s*\|([^|]*)\|([^|]*)\|([^|]*)\|/;
lines.forEach((line, index) => {
  const match = rowPattern.exec(line);
  if (!match) return;
  const [, id, title, depsCell, statusCell] = match;
  const deps = depsCell
    .split(/[,，、]/)
    .map((dep) => dep.trim())
    .filter((dep) => /^N\d\d-\d\d$/.test(dep));
  // 状态取单元格开头的状态词（允许 **加粗** 与括号说明）
  const statusMatch = /^\**\s*(VERIFIED|IMPLEMENTED_UNVERIFIED|IN_PROGRESS|BLOCKED|DEFERRED|TODO)\b/.exec(statusCell.trim());
  tasks.set(id, { title: title.trim(), deps, status: statusMatch ? statusMatch[1] : 'UNKNOWN', line: index + 1 });
});

const problems = [];
const report = (message) => problems.push(message);

if (tasks.size === 0) report('账本明细表为空或格式无法解析');

for (const [id, task] of tasks) {
  if (task.status === 'UNKNOWN') report(`${id}（第 ${task.line} 行）：无法识别状态`);
  for (const dep of task.deps) {
    if (!tasks.has(dep)) report(`${id}（第 ${task.line} 行）：依赖 ${dep} 不存在于账本`);
  }
  if (task.status !== 'VERIFIED') continue;

  // 1) 依赖必须全部 VERIFIED
  for (const dep of task.deps) {
    const depTask = tasks.get(dep);
    if (depTask === undefined || depTask.status === 'VERIFIED') continue;
    const waiver = WAIVERS[id]?.[dep];
    if (waiver !== undefined) {
      if (!existsSync(join(root, waiver))) report(`${id}：依赖 ${dep} 的降级裁决文件不存在（${waiver}）`);
      continue;
    }
    report(`${id} 为 VERIFIED，但依赖 ${dep} 为 ${depTask.status}（需先完成依赖，或在 docs/decisions/ 裁决后加入 WAIVERS）`);
  }

  // 2) 独立证据与交接文件
  for (const folder of ['verification', 'handoffs']) {
    const file = join(root, 'docs', folder, `${id}.md`);
    if (!existsSync(file)) report(`${id} 为 VERIFIED，但缺少 docs/${folder}/${id}.md`);
  }
}

// 3) 汇总表与明细一致
const summaryPattern = /^\|\s*(N\d\d)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|/;
let summaryRows = 0;
for (const line of lines) {
  const match = summaryPattern.exec(line);
  if (!match) continue;
  summaryRows += 1;
  const [, stream, totalText, verifiedText] = match;
  const streamTasks = [...tasks.entries()].filter(([id]) => id.startsWith(`${stream}-`));
  const verified = streamTasks.filter(([, task]) => task.status === 'VERIFIED').length;
  if (Number(totalText) !== streamTasks.length) {
    report(`汇总表 ${stream}：任务数写 ${totalText}，明细为 ${String(streamTasks.length)}`);
  }
  if (Number(verifiedText) !== verified) {
    report(`汇总表 ${stream}：VERIFIED 写 ${verifiedText}，明细为 ${String(verified)}`);
  }
}
if (summaryRows === 0) report('未找到工作流汇总表（| Nxx | 任务数 | VERIFIED | 说明 |）');

const verifiedTotal = [...tasks.values()].filter((task) => task.status === 'VERIFIED').length;
const inProgress = [...tasks.values()].filter((task) => task.status === 'IN_PROGRESS').length;
console.log(`spec-check：${String(tasks.size)} 项任务，VERIFIED ${String(verifiedTotal)}，IN_PROGRESS ${String(inProgress)}`);

if (problems.length > 0) {
  console.error(`\nspec-check 失败（${String(problems.length)} 项）：`);
  for (const problem of problems) console.error(` - ${problem}`);
  process.exit(1);
}
console.log('spec-check 通过：依赖、证据文件与汇总统计一致。');
