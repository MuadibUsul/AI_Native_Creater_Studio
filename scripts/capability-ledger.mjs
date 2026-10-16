#!/usr/bin/env node
/**
 * 编辑能力覆盖账本生成器（V5 §10.1、M3；裁决 0014）。
 *
 *   pnpm capabilities:generate   重新生成 docs/requirements/generated/edit-capability-coverage.md
 *   pnpm capabilities:check      校验生成物与源一致 + 原生能力声明规则（纳入 pnpm verify）
 *
 * 事实来源（不手写统计）：
 * - `EDIT_OPERATION_V2_REGISTRY`（源操作 → 解析方式 NATIVE / COMPILED_ALIAS / PLANNED）；
 * - `EDIT_OPERATION_REGISTRY`（规范操作的可用性）；
 * - `KERNEL_TIMELINE_OPERATIONS`（由编辑内核执行的规范操作）；
 * - 仓库测试文件中对规范操作的引用（内核单测 / 集成测试）。
 *
 * 规则（"类型声明、别名或空 handler 不计为原生能力"，V5 §10.1）：
 * - NATIVE 必须：规范操作 ACTIVE、由编辑内核执行、至少一个内核单测与一个集成测试引用该操作；
 * - COMPILED_ALIAS 必须指向 ACTIVE 规范操作；PLANNED 必须有负责任务。
 * 金样测试列在 M4（RenderPlan IR 与一致性套件）前统一记为 PLANNED，不以此冒充通过。
 *
 * 依赖构建产物（packages/contracts|kernel/dist）；pnpm verify 中位于 build 之后。
 */
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const OUTPUT = join(root, 'docs', 'requirements', 'generated', 'edit-capability-coverage.md');
const mode = process.argv.includes('--check') ? 'check' : 'generate';

const contracts = await import(pathToFileURL(join(root, 'packages/contracts/dist/index.js')).href);
const kernel = await import(pathToFileURL(join(root, 'packages/kernel/dist/index.js')).href);
const { EDIT_OPERATION_V2_REGISTRY, EDIT_OPERATION_REGISTRY, SOURCE_EDIT_OPERATION_TYPES } = contracts;
const kernelOps = new Set(kernel.KERNEL_TIMELINE_OPERATIONS);

async function walk(dir, predicate, files = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.next') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, predicate, files);
    else if (predicate(entry.name)) files.push(full);
  }
  return files;
}

const readAll = async (files) => Promise.all(files.map(async (file) => ({ path: relative(root, file).split('\\').join('/'), content: await readFile(file, 'utf8') })));
const kernelTests = await readAll(await walk(join(root, 'packages/kernel/src'), (name) => name.endsWith('.test.ts')));
const integrationTests = await readAll([
  ...await walk(join(root, 'apps'), (name) => name.endsWith('.integration.test.ts')),
  ...await walk(join(root, 'packages'), (name) => name.endsWith('.integration.test.ts')),
]);
const referencing = (files, op) => files.filter((file) => file.content.includes(`'${op}'`)).map((file) => file.path).sort();

const rows = [];
const violations = [];
for (const operation of SOURCE_EDIT_OPERATION_TYPES) {
  const registration = EDIT_OPERATION_V2_REGISTRY[operation];
  const canonical = registration.canonicalOperation;
  const canonicalDefinition = canonical === null ? null : EDIT_OPERATION_REGISTRY[canonical];
  const executor = canonical === null ? '—' : kernelOps.has(canonical) ? 'KERNEL' : 'DOMAIN';
  const kernelEvidence = canonical === null ? [] : referencing(kernelTests, canonical);
  const integrationEvidence = canonical === null ? [] : referencing(integrationTests, canonical);
  rows.push({ operation, registration, canonical, executor, kernelEvidence, integrationEvidence });

  if (registration.resolution === 'NATIVE') {
    if (canonicalDefinition?.availability !== 'ACTIVE') violations.push(`${operation}: NATIVE 但规范操作 ${String(canonical)} 不是 ACTIVE`);
    if (executor !== 'KERNEL') violations.push(`${operation}: NATIVE 但规范操作 ${String(canonical)} 不由编辑内核执行`);
    if (kernelEvidence.length === 0) violations.push(`${operation}: NATIVE 但没有内核单测引用 '${String(canonical)}'`);
    if (integrationEvidence.length === 0) violations.push(`${operation}: NATIVE 但没有集成测试引用 '${String(canonical)}'`);
  } else if (registration.resolution === 'COMPILED_ALIAS') {
    if (canonicalDefinition?.availability !== 'ACTIVE') violations.push(`${operation}: 别名指向的规范操作 ${String(canonical)} 不是 ACTIVE`);
  } else if (registration.plannedTask === null) {
    violations.push(`${operation}: PLANNED 但没有负责任务`);
  }
}
// 反向一致性：内核执行的规范操作必须在规范注册表中为 ACTIVE（内核不得执行"计划中"的操作）
for (const op of kernelOps) {
  if (EDIT_OPERATION_REGISTRY[op]?.availability !== 'ACTIVE') violations.push(`内核操作 ${op} 在规范注册表中不是 ACTIVE`);
}

const count = (resolution) => rows.filter((row) => row.registration.resolution === resolution).length;
const cell = (value) => String(value).replaceAll('|', '\\|');
const lines = [
  '# 编辑能力覆盖账本（生成物）',
  '',
  '> **生成物，请勿手改。** 由 `pnpm capabilities:generate`（`scripts/capability-ledger.mjs`）从 `EDIT_OPERATION_V2_REGISTRY`、',
  '> `EDIT_OPERATION_REGISTRY`、`KERNEL_TIMELINE_OPERATIONS` 与测试引用生成；`pnpm capabilities:check`（在 `pnpm verify` 中）校验一致性与原生声明规则。',
  '> 原生（NATIVE）= 规范操作 ACTIVE + 编辑内核执行 + 至少一个内核单测与一个集成测试；别名与计划项不计为原生能力（V5 §10.1）。',
  '> 金样测试列在 RenderPlan IR 与一致性套件（V5-M4）前统一为 PLANNED。',
  '',
  `**汇总：** 源操作 ${String(rows.length)} 个 —— NATIVE ${String(count('NATIVE'))}、COMPILED_ALIAS ${String(count('COMPILED_ALIAS'))}、PLANNED ${String(count('PLANNED'))}；`
    + `编辑内核执行的规范操作 ${String(kernelOps.size)} 个。`,
  '',
  '| 源操作 | 解析 | 规范操作 | 执行方 | 内核单测 | 集成测试 | 金样 | 限制 | 负责任务 |',
  '|---|---|---|---|---|---|---|---|---|',
  ...rows.map((row) => `| \`${row.operation}\` | ${row.registration.resolution} | ${row.canonical === null ? '—' : `\`${row.canonical}\``} | ${row.executor} | `
    + `${String(row.kernelEvidence.length)} | ${String(row.integrationEvidence.length)} | PLANNED | `
    + `${row.registration.limitations.length === 0 ? '—' : cell(row.registration.limitations.join(', '))} | ${row.registration.plannedTask ?? '—'} |`),
  '',
];
const content = `${lines.join('\n')}`;

if (violations.length > 0) {
  console.error('[capabilities] 原生能力声明规则不满足：');
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exit(1);
}

if (mode === 'generate') {
  await mkdir(dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, content);
  console.log(`[capabilities] 已生成 ${relative(root, OUTPUT)}（NATIVE ${String(count('NATIVE'))} / ALIAS ${String(count('COMPILED_ALIAS'))} / PLANNED ${String(count('PLANNED'))}）`);
} else {
  const committed = await readFile(OUTPUT, 'utf8').catch(() => null);
  if (committed !== content) {
    console.error(`[capabilities] ${relative(root, OUTPUT)} 与注册表/测试不一致：请运行 pnpm capabilities:generate 并提交生成物。`);
    process.exit(1);
  }
  console.log(`[capabilities] 覆盖账本与源一致；原生声明规则通过（NATIVE ${String(count('NATIVE'))}）。`);
}
