#!/usr/bin/env node
/**
 * Fixture 维护工具：为空的 content_hash 计算 SHA-256（sha256(utf8(excerpt))）。
 *
 * 规则：
 * - 只填充空字符串的 content_hash；已有值（含刻意损坏的负面用例）一律保留；
 * - 同时移除值为 null 的可选字段（保持与 Zod schema 的“可选”语义一致）；
 * - 修改摘录后重新运行本脚本，再运行 pnpm test:golden 校验。
 *
 * 用法：pnpm --filter @ancs/testing run fixtures:hash
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const goldenSources = join(pkgRoot, 'fixtures', 'golden', 'french-debt', 'sources.json');
const negativeCasesDir = join(pkgRoot, 'fixtures', 'negative', 'cases');

const stripNulls = (value) => {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      if (v === null) continue;
      out[key] = stripNulls(v);
    }
    return out;
  }
  return value;
};

const fillHashes = (sources) => {
  let filled = 0;
  for (const source of sources) {
    if (source.content_hash === '') {
      source.content_hash = createHash('sha256').update(source.excerpt, 'utf8').digest('hex');
      filled += 1;
    }
  }
  return filled;
};

const writeJson = (path, data) => {
  writeFileSync(path, `${JSON.stringify(stripNulls(data), null, 2)}\n`, 'utf8');
};

let total = 0;

const golden = JSON.parse(readFileSync(goldenSources, 'utf8'));
total += fillHashes(golden.sources);
writeJson(goldenSources, golden);
console.log(`[fixtures:hash] ${goldenSources}: 填充 ${String(total)} 条`);

let cases = 0;
for (const file of readdirSync(negativeCasesDir).filter((f) => f.endsWith('.json'))) {
  const path = join(negativeCasesDir, file);
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const filled = fillHashes(data.bundle.sources);
  cases += filled;
  writeJson(path, data);
}
console.log(`[fixtures:hash] negative cases: 填充 ${String(cases)} 条（保留既有哈希，含刻意损坏值）`);
