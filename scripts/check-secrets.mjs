#!/usr/bin/env node
/**
 * 仓库 Secret 扫描（REQ-43-06：禁止 Secret 写入仓库）。
 *
 * - 扫描 git 追踪的文件（非 git 环境回退为目录遍历）；
 * - 只匹配"真实值的形状"（云厂商 Key、私钥、JWT、长随机串赋值），不匹配文档中的词；
 * - .env.example 等空占位不会命中（值为空字符串）。
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.next', 'out']);
const SKIP_EXT = new Set(['.docx', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.mp3', '.wav', '.zip']);
const MAX_BYTES = 1024 * 1024;

const PATTERNS = [
  { name: 'AWS Access Key ID', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'PEM 私钥', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'OpenAI 风格 Key', re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: 'Google API Key', re: /\bAIza[0-9A-Za-z_-]{30,}/ },
  { name: 'Slack Token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'JWT', re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  {
    name: '疑似凭据赋值',
    re: /(SECRET|TOKEN|PASSWORD|API_?KEY|ACCESS_KEY|PRIVATE_KEY)[A-Z0-9_]*\s*[:=]\s*["']?([A-Za-z0-9+/_.-]{16,})/i,
  },
];

function listFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
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
    for (const p of PATTERNS) {
      if (p.re.test(line)) hits.push(`${rel}:${i + 1} 命中「${p.name}」`);
    }
  }
}

if (hits.length > 0) {
  console.error('[secrets:check] 发现疑似 Secret，禁止提交：');
  for (const h of hits) console.error(`  ${h}`);
  console.error('  处理：移除并轮换该凭据；真实值只允许存在于未追踪的 .env 或密钥管理服务。');
  process.exit(1);
}
console.log('[secrets:check] 未发现疑似 Secret。');
