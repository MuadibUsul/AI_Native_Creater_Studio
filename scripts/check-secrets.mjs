#!/usr/bin/env node
/**
 * 仓库 Secret 扫描（REQ-43-06：禁止 Secret 写入仓库）。
 *
 * 扫描范围：git 追踪的文件 + 未跟踪但未被忽略的文件（即"下一次提交会进入仓库的内容"）；
 *          非 git 环境回退为目录遍历。
 * 检测策略：
 *  1) 具体形态（高置信）：云厂商 Key、私钥、JWT、Slack Token 等；
 *  2) 赋值启发式：凭据类键名 + **带引号的**长字面量（代码内泄漏的典型形态），
 *     以及 .env 风格的大写键未加引号赋值。
 *     只匹配"字面量"，不匹配变量引用（如 `refreshToken: pair.refreshToken`），避免大量误报。
 * 显式豁免：行内出现 `secrets:check-ignore` 的行跳过（用于测试夹具中的假凭据；
 *          豁免必须可审计——保留原因注释，禁止"静默整文件豁免"）。
 * `--history`（V5-M4，CI 中运行）：扫描**全部提交历史**中新增的行（`git log --all -p`），
 *          同一套规则与豁免标记；已从工作树删除但仍留在历史中的凭据同样会被发现（需轮换）。
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.next', 'out', '.artifacts']);
const SKIP_EXT = new Set(['.docx', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.mp3', '.wav', '.zip']);
const MAX_BYTES = 1024 * 1024;
const IGNORE_MARKER = 'secrets:check-ignore';

const PATTERNS = [
  { name: 'AWS Access Key ID', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'PEM 私钥', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'OpenAI 风格 Key', re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: 'Google API Key', re: /\bAIza[0-9A-Za-z_-]{30,}/ },
  { name: 'Slack Token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'JWT', re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  {
    name: '疑似凭据字面量',
    re: /(SECRET|TOKEN|PASSWORD|API_?KEY|ACCESS_KEY|PRIVATE_KEY)[A-Z0-9_]*["']?\s*[:=]\s*["'][A-Za-z0-9+/_.-]{16,}["']/i,
  },
  {
    name: '疑似凭据环境变量',
    re: /^[A-Z][A-Z0-9_]{2,}(SECRET|TOKEN|PASSWORD|API_?KEY|ACCESS_KEY)[A-Z0-9_]*\s*=\s*[A-Za-z0-9+/_.-]{16,}\s*$/m,
  },
];

function listFiles() {
  try {
    // 追踪 + 未跟踪（未忽略）——与"下一次提交内容"一致
    const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: ROOT, encoding: 'utf8' });
    return out.split('\0').filter(Boolean);
  } catch {
    const files = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
        } else {
          files.push(relative(ROOT, join(dir, entry.name)));
        }
      }
    };
    walk(ROOT);
    return files;
  }
}

const hits = [];
const skippedByExtension = (path) => SKIP_EXT.has(path.slice(path.lastIndexOf('.')).toLowerCase());

if (process.argv.includes('--history')) {
  // 逐提交的新增行；-U0 只给改动行，--no-ext-diff/--no-textconv 防止外部工具改写内容
  let log;
  try {
    log = execFileSync('git', ['log', '--all', '-p', '--no-color', '--no-ext-diff', '--no-textconv', '-U0', '--format=commit %H'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024,
    });
  } catch (error) {
    console.error(`[secrets:check] 无法读取提交历史（浅克隆？CI 需 fetch-depth: 0）：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  let commit = '';
  let file = '';
  let commits = 0;
  for (const line of log.split('\n')) {
    if (line.startsWith('commit ')) { commit = line.slice(7, 19); commits += 1; continue; }
    if (line.startsWith('+++ ')) { file = line.startsWith('+++ b/') ? line.slice(6) : ''; continue; }
    if (!line.startsWith('+') || file === '' || skippedByExtension(file) || line.includes(IGNORE_MARKER)) continue;
    const added = line.slice(1);
    for (const p of PATTERNS) {
      if (p.re.test(added)) hits.push(`${commit} ${file} 命中「${p.name}」`);
    }
  }
  // 已审查的历史误报（提交 + 文件 + 原因；只作用于 --history）
  const allowlist = JSON.parse(readFileSync(join(ROOT, 'scripts', 'secrets-history-allowlist.json'), 'utf8')).entries;
  for (const entry of allowlist) {
    if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
      console.error(`[secrets:check --history] 豁免缺少原因：${entry.commit} ${entry.file}`);
      process.exit(1);
    }
  }
  const allowed = (hit) => allowlist.some((entry) => hit.startsWith(`${entry.commit} ${entry.file} `));
  const unique = [...new Set(hits)].filter((hit) => !allowed(hit));
  if (unique.length > 0) {
    console.error('[secrets:check --history] 提交历史中存在疑似 Secret（即使已从工作树删除，也必须视为泄露并轮换）：');
    for (const h of unique) console.error(`  ${h}`);
    process.exit(1);
  }
  console.log(`[secrets:check --history] 已扫描 ${String(commits)} 个提交的新增内容，未发现疑似 Secret。`);
  process.exit(0);
}

for (const rel of listFiles()) {
  const ext = rel.slice(rel.lastIndexOf('.'));
  if (SKIP_EXT.has(ext.toLowerCase())) continue;
  const abs = join(ROOT, rel);
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    continue;
  }
  if (!stat.isFile() || stat.size > MAX_BYTES) continue;
  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    continue;
  }
  const lines = text.split('\n');
  for (const [i, line] of lines.entries()) {
    if (line.includes(IGNORE_MARKER)) continue;
    for (const p of PATTERNS) {
      if (p.re.test(line)) hits.push(`${rel}:${i + 1} 命中「${p.name}」`);
    }
  }
}

if (hits.length > 0) {
  console.error('[secrets:check] 发现疑似 Secret，禁止提交：');
  for (const h of hits) console.error(`  ${h}`);
  console.error('  处理：移除并轮换该凭据；真实值只允许存在于未追踪的 .env 或密钥管理服务。');
  console.error(`  测试夹具中的假凭据：在该行加注释 ${IGNORE_MARKER} 并说明原因（可审计豁免）。`);
  process.exit(1);
}
console.log('[secrets:check] 未发现疑似 Secret。');
