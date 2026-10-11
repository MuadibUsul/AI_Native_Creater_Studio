import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { checkRules, checkSourcePurity, type SourceFile } from './rules.js';
import { scanWorkspace } from './scan.js';

const root = resolve(process.argv[2] ?? process.cwd());

const pkgs = await scanWorkspace(root);
const violations = checkRules(pkgs);

/** R10：纯核心包（packages/kernel、packages/time）的非测试 TypeScript 源码 */
async function pureCoreSources(): Promise<SourceFile[]> {
  const files: SourceFile[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        files.push({ path: relative(root, full).split('\\').join('/'), content: await readFile(full, 'utf8') });
      }
    }
  };
  for (const dir of ['packages/kernel/src', 'packages/time/src']) await walk(join(root, dir));
  return files;
}

const sources = await pureCoreSources();
violations.push(...checkSourcePurity(sources));

const list = pkgs.length > 0 ? pkgs.map((p) => p.dir).join(', ') : '（尚未创建 workspace 包）';
console.log(`[arch-check] 根目录：${root}`);
console.log(`[arch-check] 扫描到 ${pkgs.length} 个 workspace 包：${list}`);
console.log(`[arch-check] 纯核心源码（R10）：${String(sources.length)} 个文件`);

if (violations.length > 0) {
  for (const v of violations) {
    console.error(`[arch-check] ${v.rule} 违规：${v.pkg} → ${v.dep}（${v.message}）`);
  }
  console.error(`[arch-check] 共 ${violations.length} 条违规。`);
  process.exit(1);
}

console.log('[arch-check] 依赖方向与纯核心检查通过（R1—R10）。');
