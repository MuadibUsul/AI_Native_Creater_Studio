#!/usr/bin/env node
/**
 * 性能基线编排（P08-04 / 规范 §70）：建全新库 → 迁移 → 启动构建产物 API → 运行测量主体
 * （apps/api/scripts/perf-measure.mjs：SDK 真实 HTTP 测量）→ 结果落 .artifacts/perf/<ts>.json → 清理。
 *
 * 用法：node scripts/perf-baseline.mjs [--projects 10] [--scenes 4] [--iterations 30]
 * 退出码：0 = 完成并记录（未达标/未测项在报告中如实标注）；2 = 预检失败。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

function findRepoRoot(startDir) {
  let current = resolve(startDir);
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('无法定位仓库根');
}

const repoRoot = findRepoRoot(process.cwd());
const arg = (flag, fallback) => {
  const index = process.argv.indexOf(flag);
  return index < 0 ? fallback : Number(process.argv[index + 1] ?? fallback);
};
const projects = arg('--projects', 10);
const scenes = arg('--scenes', 4);
const iterations = arg('--iterations', 30);

const baseUrl = process.env['ANCS_TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? 'postgres://ancs:ancs@localhost:55432/ancs_dev';
const withDbName = (url, name) => {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
};
const token = Date.now().toString(36);
const dbName = `ancs_perf_${token}`;
const storageDir = join(tmpdir(), `ancs-perf-${token}`, 'storage');
const adminUrl = withDbName(baseUrl, 'postgres');
const databaseUrl = withDbName(baseUrl, dbName);

const runInDb = (code, extraEnv = {}) =>
  spawnSync(process.execPath, ['--no-warnings', '-e', code], { cwd: join(repoRoot, 'packages', 'db'), env: { ...process.env, ...extraEnv }, encoding: 'utf8', timeout: 120_000 });
const sql = (statement) => runInDb(`import('pg').then(async ({ default: pg }) => { const c = new pg.Client({ connectionString: process.env.ADMIN_URL }); await c.connect(); await c.query(process.env.SQL_TEXT); await c.end(); }).catch((e) => { console.error(e.message); process.exit(1); });`, { ADMIN_URL: adminUrl, SQL_TEXT: statement });

console.log(`\n===== 性能基线（新库 ${dbName}；项目 ${String(projects)} × 场景 ${String(scenes)}；每项 ${String(iterations)} 次）=====\n`);

const preflight = runInDb(`import('pg').then(async ({ default: pg }) => { const c = new pg.Client({ connectionString: process.env.ADMIN_URL }); await c.connect(); await c.end(); })`, { ADMIN_URL: adminUrl });
if (preflight.status !== 0) {
  console.error('预检失败：PostgreSQL 不可达。');
  process.exit(2);
}

let api;
try {
  if (sql(`CREATE DATABASE "${dbName}"`).status !== 0) throw new Error('建库失败');
  const migrate = runInDb(
    `import('@ancs/db').then(async ({ createDb, runMigrations }) => { const h = createDb(process.env.DATABASE_URL); await runMigrations(h); await h.close(); });`,
    { DATABASE_URL: databaseUrl },
  );
  if (migrate.status !== 0) throw new Error(`迁移失败：${(migrate.stderr || '').trim().slice(-200)}`);

  const port = 33000 + Math.floor(Math.random() * 1000);
  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    BETTER_AUTH_SECRET: 'perf-baseline-secret-0123456789', // secrets:check-ignore：基线专用假密钥（临时库）
    BETTER_AUTH_URL: `http://127.0.0.1:${String(port)}`,
    PORT: String(port),
    ANCS_STORAGE_LOCAL_DIR: storageDir,
  };
  api = spawn(process.execPath, ['apps/api/dist/index.js'], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await delay(500);
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/api/v1/health`);
      if (response.status === 200) {
        ready = true;
        break;
      }
    } catch {
      // 未就绪
    }
  }
  if (!ready) throw new Error('API 未就绪');

  const measured = spawnSync(process.execPath, ['scripts/perf-measure.mjs'], {
    cwd: join(repoRoot, 'apps', 'api'),
    env: {
      ...process.env,
      // SDK baseUrl = 主机根（SDK 内部拼接 /api/v1）
      PERF_BASE_URL: `http://127.0.0.1:${String(port)}`,
      PERF_PROJECTS: String(projects),
      PERF_SCENES: String(scenes),
      PERF_ITERATIONS: String(iterations),
      DATABASE_URL: databaseUrl,
      BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
    },
    encoding: 'utf8',
    timeout: 900_000,
  });
  if (measured.status !== 0) throw new Error(`测量失败：${(measured.stderr || measured.stdout).trim().slice(-500)}`);
  const report = JSON.parse(measured.stdout.trim().split('\n').at(-1) ?? '{}');
  report.environment.database = databaseUrl.replace(/:\/\/[^@/]+@/, '://***@');

  const outDir = join(repoRoot, '.artifacts', 'perf');
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${token}.json`);
  writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);

  console.log('测量结果：');
  for (const row of report.results) {
    console.log(` ${row.endpoint}：p50 ${String(row.p50Ms)}ms · p95 ${String(row.p95Ms)}ms · max ${String(row.maxMs)}ms`);
  }
  console.log('\n§70 目标核对：');
  for (const [target, ok] of Object.entries(report.targets)) {
    console.log(`  ${ok === null ? 'N/A ' : ok ? 'PASS' : 'FAIL'}  ${target}`);
  }
  console.log(`\n结果已记录：${outFile}`);
} catch (error) {
  console.error(`\n基线运行失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (api !== undefined && api.exitCode === null) api.kill('SIGKILL');
  rmSync(dirname(storageDir), { recursive: true, force: true });
  sql(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
}
