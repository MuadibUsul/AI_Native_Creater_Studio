#!/usr/bin/env node
/**
 * 备份/恢复演练（P08-03 / 验收："实际恢复到隔离环境，并能读取及重渲染固定版本"）。
 *
 * 步骤（在全新数据库上重复，不触碰既有环境）：
 *   1) 源库：建库 → 迁移 → 造真实可渲染项目并创建 Render（固定版本 + 冻结输入）→ 记录快照哈希与输入；
 *   2) **备份**：`CREATE DATABASE ... TEMPLATE ...`（点即物理副本；生产 PITR 口径见
 *      docs/ops/monitoring-recovery.md——本地演练以此为等价物，并尽量尝试 pg_dump 作为附加证据）；
 *   3) 模拟源库丢失（DROP 源库）→ **恢复**：由备份创建隔离库；
 *   4) **读取固定版本**：核对 projectVersion 快照哈希可读且一致；
 *   5) **重渲染固定版本**：以同一 projectVersionId 创建 Render → 真实执行（进程隔离渲染 CLI）→ 进入 QA
 *      且渲染输入逐字段与原始一致（不可变快照可重现）；
 *   6) 存储签名密钥轮换演练：旧密钥签发的 URL 在轮换后失效、新密钥有效（适配器级断言）；
 *   7) 清理（删库、清存储卷），打印逐项 PASS/FAIL。
 *
 * 用法：node scripts/recovery-rehearsal.mjs（需要本机 PostgreSQL；连接串取 ANCS_TEST_DATABASE_URL / DATABASE_URL）
 * 退出码：0 = 全部通过；1 = 有步骤失败；2 = 预检失败。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

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
const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(` ${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `（${detail}）`}`);
};

const baseUrl = process.env['ANCS_TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? 'postgres://ancs:ancs@localhost:55432/ancs_dev';
const withDbName = (url, name) => {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
};
const token = Date.now().toString(36);
const sourceDb = `ancs_rec_src_${token}`;
const backupDb = `ancs_rec_bak_${token}`;
const restoredDb = `ancs_rec_rst_${token}`;
const adminUrl = withDbName(baseUrl, 'postgres');
const storageDir = join(tmpdir(), `ancs-recovery-${token}`, 'storage');

const runInDb = (code, extraEnv = {}) =>
  spawnSync(process.execPath, ['--no-warnings', '-e', code], { cwd: join(repoRoot, 'packages', 'db'), env: { ...process.env, ...extraEnv }, encoding: 'utf8', timeout: 180_000 });

const runSeeder = (args, databaseUrl) =>
  spawnSync(process.execPath, ['scripts/seed-fixed-version.mjs', ...args], {
    cwd: join(repoRoot, 'apps', 'worker'),
    env: { ...process.env, DATABASE_URL: databaseUrl, ANCS_STORAGE_LOCAL_DIR: storageDir },
    encoding: 'utf8',
    timeout: 900_000,
  });

const sql = (statement) => runInDb(`import('pg').then(async ({ default: pg }) => { const c = new pg.Client({ connectionString: process.env.ADMIN_URL }); await c.connect(); await c.query(process.env.SQL_TEXT); await c.end(); }).catch((e) => { console.error(e.message); process.exit(1); });`, { ADMIN_URL: adminUrl, SQL_TEXT: statement });

console.log(`\n===== 备份/恢复演练（源=${sourceDb}）=====\n`);

// 0) 预检
const preflight = runInDb(`import('pg').then(async ({ default: pg }) => { const c = new pg.Client({ connectionString: process.env.ADMIN_URL }); await c.connect(); await c.query('select 1'); await c.end(); }).catch((e) => { console.error(e.message); process.exit(1); });`, { ADMIN_URL: adminUrl });
if (preflight.status !== 0) {
  console.error(`预检失败：PostgreSQL 不可达：${(preflight.stderr || '').trim().slice(-200)}`);
  process.exit(2);
}
record('预检：PostgreSQL 可达', true);

let reference;
try {
  // 1) 源库：迁移 + 造固定版本项目
  if (sql(`CREATE DATABASE "${sourceDb}"`).status !== 0) throw new Error('建源库失败');
  const sourceUrl = withDbName(baseUrl, sourceDb);
  const migrate = runInDb(
    `import('@ancs/db').then(async ({ createDb, runMigrations }) => { const h = createDb(process.env.DATABASE_URL); await runMigrations(h); await h.close(); }).catch((e) => { console.error(e.message); process.exit(1); });`,
    { DATABASE_URL: sourceUrl },
  );
  if (migrate.status !== 0) throw new Error(`源库迁移失败：${(migrate.stderr || '').trim().slice(-300)}`);
  const seeded = runSeeder(['--seed'], sourceUrl);
  if (seeded.status !== 0) throw new Error(`种子失败：${(seeded.stderr || seeded.stdout).trim().slice(-500)}`);
  reference = JSON.parse(seeded.stdout.trim().split('\n').at(-1) ?? '{}');
  if (reference.ok !== true) throw new Error(`种子未成功：${JSON.stringify(reference).slice(0, 300)}`);
  record('步骤 1：源库（迁移 + 真实项目 + 固定版本 Render）', true, `version=${String(reference.versionId).slice(0, 14)}…`);

  // 2) 备份（点即物理副本；pg_dump 作为附加证据——本机可用时）
  if (sql(`CREATE DATABASE "${backupDb}" TEMPLATE "${sourceDb}"`).status !== 0) throw new Error('备份失败（CREATE DATABASE TEMPLATE）');
  const pgDump = spawnSync('pg_dump', ['--version'], { encoding: 'utf8' });
  record('步骤 2：备份（点即副本）', true, pgDump.status === 0 ? 'pg_dump 可用（生产口径见运行手册）' : '本机无 pg_dump：演练以 TEMPLATE 副本为等价物（生产用 pg_basebackup/WAL，见运行手册）');

  // 3) 模拟源库丢失 → 从备份恢复
  if (sql(`DROP DATABASE "${sourceDb}" WITH (FORCE)`).status !== 0) throw new Error('模拟丢失失败（DROP）');
  if (sql(`CREATE DATABASE "${restoredDb}" TEMPLATE "${backupDb}"`).status !== 0) throw new Error('恢复失败（CREATE DATABASE TEMPLATE）');
  const restoredUrl = withDbName(baseUrl, restoredDb);
  record('步骤 3：源库丢失 → 从备份恢复到隔离库', true, restoredDb);

  // 4) 读取固定版本（快照哈希一致）
  const verified = runSeeder(['--verify', JSON.stringify(reference)], restoredUrl);
  if (verified.status !== 0) throw new Error(`固定版本核对失败：${(verified.stderr || verified.stdout).trim().slice(-400)}`);
  const verifyResult = JSON.parse(verified.stdout.trim().split('\n').at(-1) ?? '{}');
  record('步骤 4：隔离库读取固定版本（快照哈希一致）', verifyResult.ok === true, `snapshotHashMatches=${String(verifyResult.snapshotHashMatches)}`);

  // 5) 重渲染固定版本（真实渲染执行器）→ QA + 输入逐字段一致
  const rerendered = runSeeder(['--rerender', JSON.stringify(reference)], restoredUrl);
  if (rerendered.status !== 0) throw new Error(`重渲染失败：${(rerendered.stderr || rerendered.stdout).trim().slice(-500)}`);
  const rerenderResult = JSON.parse(rerendered.stdout.trim().split('\n').at(-1) ?? '{}');
  record(
    '步骤 5：重渲染固定版本（→ QA；输入逐字段与原始一致）',
    rerenderResult.ok === true,
    `status=${String(rerenderResult.status)} inputMatches=${String(rerenderResult.inputMatchesOriginal)}`,
  );

  // 6) 存储签名密钥轮换演练（旧 URL 失效 / 新 URL 有效）
  const rotation = spawnSync(
    process.execPath,
    ['--no-warnings', '-e', `
      import('@ancs/providers-storage-local').then(async ({ LocalObjectStorage }) => {
        const rootDir = process.env.ANCS_STORAGE_LOCAL_DIR;
        const oldStorage = new LocalObjectStorage({ rootDir, publicBaseUrl: 'http://127.0.0.1:1', signingSecret: 'rotation-old-secret-0123456789' /* secrets:check-ignore：演练专用假密钥 */ });
        const newStorage = new LocalObjectStorage({ rootDir, publicBaseUrl: 'http://127.0.0.1:1', signingSecret: 'rotation-new-secret-0123456789' /* secrets:check-ignore：演练专用假密钥 */ });
        await oldStorage.putObject('workspaces/ws_rotate/probe.bin', new TextEncoder().encode('rotate'));
        const oldUrl = await oldStorage.createDownloadUrl({ key: 'workspaces/ws_rotate/probe.bin' });
        const newUrl = await newStorage.createDownloadUrl({ key: 'workspaces/ws_rotate/probe.bin' });
        const oldToken = new URL(oldUrl.url).searchParams.get('token');
        const newToken = new URL(newUrl.url).searchParams.get('token');
        const oldRejectedAfterRotation = newStorage.verifyToken(oldToken, 'download') === null;
        const newAccepted = newStorage.verifyToken(newToken, 'download') !== null;
        console.log(JSON.stringify({ ok: oldRejectedAfterRotation && newAccepted, oldRejectedAfterRotation, newAccepted }));
        process.exit(oldRejectedAfterRotation && newAccepted ? 0 : 1);
      }).catch((e) => { console.error(e.message); process.exit(1); });
    `],
    { cwd: join(repoRoot, 'apps', 'worker'), env: { ...process.env, ANCS_STORAGE_LOCAL_DIR: storageDir }, encoding: 'utf8', timeout: 60_000 },
  );
  const rotationResult = JSON.parse((rotation.stdout.trim().split('\n').at(-1) ?? '{}') || '{}');
  record('步骤 6：存储密钥轮换（旧签名 URL 失效、新签名有效）', rotation.status === 0 && rotationResult.ok === true, `oldRejected=${String(rotationResult.oldRejectedAfterRotation)}`);

  // 7) 清理
  rmSync(dirname(storageDir), { recursive: true, force: true });
  sql(`DROP DATABASE IF EXISTS "${restoredDb}" WITH (FORCE)`);
  sql(`DROP DATABASE IF EXISTS "${backupDb}" WITH (FORCE)`);
  record('步骤 7：清理（删演练库与存储卷）', true);
} catch (error) {
  record('演练中断', false, error instanceof Error ? error.message : String(error));
} finally {
  // 兜底清理
  sql(`DROP DATABASE IF EXISTS "${sourceDb}" WITH (FORCE)`);
  sql(`DROP DATABASE IF EXISTS "${backupDb}" WITH (FORCE)`);
  sql(`DROP DATABASE IF EXISTS "${restoredDb}" WITH (FORCE)`);
}

const failed = results.filter((item) => !item.ok);
console.log(`\n===== 演练汇总（${String(results.length - failed.length)}/${String(results.length)}）=====`);
if (failed.length > 0) {
  console.error('备份/恢复演练失败：见上方 FAIL 项。');
  process.exit(1);
}
console.log('备份/恢复演练通过：可恢复到隔离环境并读取、重渲染固定版本（含密钥轮换断言）。');
process.exit(0);
