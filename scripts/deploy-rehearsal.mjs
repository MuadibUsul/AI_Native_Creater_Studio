#!/usr/bin/env node
/**
 * 内部部署演练（P08-01 / 验收："新环境按 Runbook 可重复部署"）。
 *
 * 在**全新环境**上按 docs/ops/deployment-runbook.md 的步骤重复执行（生产形态 = 构建产物）：
 *   0) 构建（pnpm build：TS → dist；Rehearsal 与 Runbook 同步）；
 *   1) 预检：PostgreSQL 可达；
 *   2) 建库（全新数据库名）→ 迁移（runMigrations）→ 核对表数量；
 *   3) 启动 API（子进程，随机端口）→ /health 200 → 优雅停止；
 *   4) 启动 Worker（--once 单轮）→ 退出码 0（渲染执行器/验证器路径校验通过）；
 *   5) 存储卷：本地驱动写入/读取/校验和（真实落盘）；
 *   6) 反向校验：**错误配置启动失败并说明原因**（缺配置一次说全 / 未实现驱动拒绝静默降级）；
 *   7) 清理（删库、杀进程、清存储卷），打印逐项 PASS/FAIL 清单。
 *
 * 用法：node scripts/deploy-rehearsal.mjs
 *   （需要本机 PostgreSQL；连接串取 ANCS_TEST_DATABASE_URL / DATABASE_URL，默认本地 docker-compose.dev）
 * 退出码：0 = 全部通过；1 = 有步骤失败；2 = 预检失败（数据库不可达——环境问题，不算部署失败）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
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
  throw new Error('无法定位仓库根（pnpm-workspace.yaml）');
}

const repoRoot = findRepoRoot(process.cwd());
const dbPackageDir = join(repoRoot, 'packages', 'db');

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(` ${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `（${detail}）`}`);
};

const baseUrl = process.env['ANCS_TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? 'postgres://ancs:ancs@localhost:55432/ancs_dev';
const rehearsalDb = `ancs_deploy_rehearsal_${Date.now().toString(36)}`;
const withDbName = (url, name) => {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
};
const rehearsalUrl = withDbName(baseUrl, rehearsalDb);
const redactedAdmin = withDbName(baseUrl, 'postgres').replace(/:\/\/[^@/]+@/, '://***@');

/** 在 packages/db 上下文中运行（pg / @ancs/db 仅在该包内可解析）。 */
const runInDb = (code, extraEnv = {}) =>
  spawnSync(process.execPath, ['--no-warnings', '-e', code], {
    cwd: dbPackageDir,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    timeout: 180_000,
  });

console.log(`\n===== 内部部署演练（全新环境：${rehearsalDb}）=====\n`);

// 0) 预检：数据库可达
const preflight = runInDb(
  `import('pg').then(async ({ default: pg }) => { const c = new pg.Client({ connectionString: process.env.ADMIN_URL }); await c.connect(); await c.query('select 1'); await c.end(); }).catch((e) => { console.error(e.message); process.exit(1); });`,
  { ADMIN_URL: withDbName(baseUrl, 'postgres') },
);
if (preflight.status !== 0) {
  console.error(`预检失败：PostgreSQL 不可达（${redactedAdmin}）：${(preflight.stderr || '').trim().slice(-200)}`);
  console.error('提示：本地依赖见 infra/docker-compose.dev.yml；本演练不改变既有数据库。');
  process.exit(2);
}
record('预检：PostgreSQL 可达', true);

const children = [];
const stopAll = () => {
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
};

try {
  // 0) 构建（与 Runbook 同步：生产运行构建产物；ANCS_REHEARSAL_SKIP_BUILD=1 时跳过——CI 在 verify 后运行）
  if (process.env['ANCS_REHEARSAL_SKIP_BUILD'] === '1') {
    record('步骤 0：构建（跳过：ANCS_REHEARSAL_SKIP_BUILD=1，复用既有 dist）', true);
  } else {
  const isWindows = process.platform === 'win32';
  const build = isWindows
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'pnpm build'], { cwd: repoRoot, stdio: 'inherit', timeout: 600_000 })
    : spawnSync('pnpm', ['build'], { cwd: repoRoot, stdio: 'inherit', timeout: 600_000 });
  if (build.status !== 0) throw new Error('构建失败（pnpm build）');
  record('步骤 0：构建（pnpm build → dist）', true);
  }

  // 1) 建库
  const create = runInDb(
    `import('pg').then(async ({ default: pg }) => { const c = new pg.Client({ connectionString: process.env.ADMIN_URL }); await c.connect(); await c.query(process.env.CREATE_SQL); await c.end(); });`,
    { ADMIN_URL: withDbName(baseUrl, 'postgres'), CREATE_SQL: `CREATE DATABASE "${rehearsalDb}"` },
  );
  if (create.status !== 0) throw new Error(`建库失败：${(create.stderr || '').trim().slice(-300)}`);
  record('步骤 1：全新数据库创建', true, rehearsalDb);

  // 2) 迁移 + 表数量
  const migrate = runInDb(
    `import('@ancs/db').then(async ({ createDb, runMigrations }) => {
       const handle = createDb(process.env.DATABASE_URL);
       await runMigrations(handle);
       const tables = await handle.pool.query("select count(*)::int as count from information_schema.tables where table_schema = 'public'");
       console.log('TABLES=' + String(tables.rows[0].count));
       await handle.close();
     }).catch((e) => { console.error(e.message); process.exit(1); });`,
    { DATABASE_URL: rehearsalUrl },
  );
  if (migrate.status !== 0) throw new Error(`迁移失败：${(migrate.stderr || '').trim().slice(-300)}`);
  const tableCount = Number(/TABLES=(\d+)/.exec(migrate.stdout)?.[1] ?? '0');
  record('步骤 2：迁移到最新 schema', tableCount > 30, `${String(tableCount)} 张表`);

  // 3) 启动 API → /health
  const port = 32000 + Math.floor(Math.random() * 1000);
  const apiEnv = {
    ...process.env,
    DATABASE_URL: rehearsalUrl,
    BETTER_AUTH_SECRET: 'rehearsal-secret-0123456789', // secrets:check-ignore：演练专用假密钥（临时库，随演练删除）
    BETTER_AUTH_URL: `http://127.0.0.1:${String(port)}`,
    PORT: String(port),
    ANCS_STORAGE_LOCAL_DIR: join(tmpdir(), `ancs-rehearsal-${rehearsalDb}`, 'storage'),
    ANCS_WORKER_TICK_MS: '250',
  };
  const api = spawn(process.execPath, ['apps/api/dist/index.js'], { cwd: repoRoot, env: apiEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(api);
  let apiLog = '';
  api.stdout.on('data', (chunk) => (apiLog += chunk.toString('utf8')));
  api.stderr.on('data', (chunk) => (apiLog += chunk.toString('utf8')));
  let health = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await delay(500);
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/api/v1/health`);
      if (response.status === 200) {
        health = await response.json();
        break;
      }
    } catch {
      // 尚未就绪
    }
    if (api.exitCode !== null) break;
  }
  if (health === null) throw new Error(`API 未就绪（exit=${String(api.exitCode)}）：${apiLog.slice(-400)}`);
  record('步骤 3：API 启动 + /health 200', health.status === 'ok', `service=${String(health.service)} port=${String(port)}`);
  api.kill('SIGTERM');
  await delay(500);
  if (api.exitCode === null) api.kill('SIGKILL');

  // 4) Worker 单轮
  const worker = spawnSync(process.execPath, ['apps/worker/dist/main.js', '--once'], {
    cwd: repoRoot,
    env: { ...apiEnv, ANCS_WORKER_ONCE: '1' },
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (worker.status !== 0) {
    throw new Error(`Worker 启动失败（exit=${String(worker.status)}）：${(worker.stderr || worker.stdout).slice(-400)}`);
  }
  const workerReport = JSON.parse((worker.stdout.trim().split('\n').at(-1) ?? '{}').replace(/^[^{]*/, ''));
  record('步骤 4：Worker 单轮启动并退出', typeof workerReport.executed === 'number', `executed=${String(workerReport.executed)}`);

  // 5) 存储卷读写（真实落盘 + 校验和）
  const storageCheck = spawnSync(
    process.execPath,
    ['--no-warnings', '-e', `
      import('@ancs/providers-storage-local').then(async ({ LocalObjectStorage }) => {
        const storage = new LocalObjectStorage({ rootDir: process.env.ANCS_STORAGE_LOCAL_DIR, publicBaseUrl: 'http://127.0.0.1:1', signingSecret: 'rehearsal-storage-secret' /* secrets:check-ignore：演练专用假密钥 */ });
        const key = 'workspaces/ws_rehearsal/probe.bin';
        await storage.putObject(key, new TextEncoder().encode('rehearsal-probe'));
        const readBack = await storage.getObject(key);
        const sha = await storage.computeObjectSha256(key);
        const ok = readBack !== null && Buffer.from(readBack).toString('utf8') === 'rehearsal-probe' && sha === process.env.PROBE_SHA;
        console.log(JSON.stringify({ ok, sha }));
        process.exit(ok ? 0 : 1);
      }).catch((e) => { console.error(e.message); process.exit(1); });
    `],
    {
      cwd: join(repoRoot, 'apps', 'worker'),
      env: { ...apiEnv, PROBE_SHA: createHash('sha256').update('rehearsal-probe').digest('hex') },
      encoding: 'utf8',
      timeout: 60_000,
    },
  );
  record('步骤 5：本地存储卷写入/读取/校验和', storageCheck.status === 0, (storageCheck.stdout || storageCheck.stderr).trim().slice(-120));

  // 6) 反向校验：错误配置启动失败并说明原因
  const badEnv = { ...apiEnv };
  delete badEnv.DATABASE_URL;
  delete badEnv.BETTER_AUTH_SECRET;
  const badApi = spawnSync(process.execPath, ['apps/api/dist/index.js'], { cwd: repoRoot, env: badEnv, encoding: 'utf8', timeout: 60_000 });
  const badOutput = `${badApi.stdout}${badApi.stderr}`;
  record(
    '步骤 6a：缺配置启动失败并一次说全（exit=1 + 两项原因）',
    badApi.status === 1 && badOutput.includes('DATABASE_URL') && badOutput.includes('BETTER_AUTH_SECRET'),
    `exit=${String(badApi.status)}`,
  );

  const badDriver = spawnSync(process.execPath, ['apps/api/dist/index.js'], { cwd: repoRoot, env: { ...apiEnv, ANCS_STORAGE_DRIVER: 'gcs' }, encoding: 'utf8', timeout: 60_000 });
  const driverOutput = `${badDriver.stdout}${badDriver.stderr}`;
  record('步骤 6b：未实现驱动启动失败（拒绝静默降级）', badDriver.status === 1 && driverOutput.includes('只能是 local 或 s3'), `exit=${String(badDriver.status)}`);
  const halfS3 = spawnSync(process.execPath, ['apps/api/dist/index.js'], { cwd: repoRoot, env: { ...apiEnv, ANCS_STORAGE_DRIVER: 's3' }, encoding: 'utf8', timeout: 60_000 });
  const halfS3Output = `${halfS3.stdout}${halfS3.stderr}`;
  record('步骤 6c：s3 驱动缺桶 / 区域启动失败并逐项说明', halfS3.status === 1 && halfS3Output.includes('ANCS_S3_BUCKET') && halfS3Output.includes('ANCS_S3_REGION'), `exit=${String(halfS3.status)}`);

  // 7) 清理
  rmSync(apiEnv.ANCS_STORAGE_LOCAL_DIR, { recursive: true, force: true });
  rmSync(dirname(apiEnv.ANCS_STORAGE_LOCAL_DIR), { recursive: true, force: true });
  const drop = runInDb(
    `import('pg').then(async ({ default: pg }) => { const c = new pg.Client({ connectionString: process.env.ADMIN_URL }); await c.connect(); await c.query(process.env.DROP_SQL); await c.end(); });`,
    { ADMIN_URL: withDbName(baseUrl, 'postgres'), DROP_SQL: `DROP DATABASE "${rehearsalDb}" WITH (FORCE)` },
  );
  if (drop.status !== 0) throw new Error(`删库失败：${(drop.stderr || '').trim().slice(-300)}`);
  record('步骤 7：清理（删库 + 存储卷）', true);
} catch (error) {
  record('演练中断', false, error instanceof Error ? error.message : String(error));
} finally {
  stopAll();
}

const failed = results.filter((item) => !item.ok);
console.log(`\n===== 演练汇总（${String(results.length - failed.length)}/${String(results.length)}）=====`);
if (failed.length > 0) {
  console.error('部署演练失败：见上方 FAIL 项。');
  process.exit(1);
}
console.log('部署演练通过：该环境按 Runbook 可重复部署（含错误配置 fail-closed 反向校验）。');
process.exit(0);
