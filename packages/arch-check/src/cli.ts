import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { checkProjectionWriters, checkRules, checkSourcePurity, type SourceFile } from './rules.js';
import { scanWorkspace } from './scan.js';

const root = resolve(process.argv[2] ?? process.cwd());

const pkgs = await scanWorkspace(root);
const violations = checkRules(pkgs);

/** 收集目录下的非测试 TypeScript 源码（跳过 node_modules / dist）。 */
async function collectSources(dirs: readonly string[], extensions: readonly string[]): Promise<SourceFile[]> {
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
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.next') continue;
        await walk(full);
      } else if (extensions.some((ext) => entry.name.endsWith(ext)) && !/\.test\.tsx?$/.test(entry.name)) {
        files.push({ path: relative(root, full).split('\\').join('/'), content: await readFile(full, 'utf8') });
      }
    }
  };
  for (const dir of dirs) await walk(join(root, dir));
  return files;
}

/** R10：纯核心包（packages/kernel、packages/time）的非测试 TypeScript 源码 */
const pureCoreSources = (): Promise<SourceFile[]> => collectSources(['packages/kernel/src', 'packages/time/src'], ['.ts']);

const sources = await pureCoreSources();
violations.push(...checkSourcePurity(sources));

/** R11：全部应用与包的非测试源码 */
const allSources = await collectSources(['apps', 'packages'], ['.ts', '.tsx']);
violations.push(...checkProjectionWriters(allSources));

const list = pkgs.length > 0 ? pkgs.map((p) => p.dir).join(', ') : '（尚未创建 workspace 包）';
console.log(`[arch-check] 根目录：${root}`);
console.log(`[arch-check] 扫描到 ${pkgs.length} 个 workspace 包：${list}`);
console.log(`[arch-check] 纯核心源码（R10）：${String(sources.length)} 个文件；投影写入检查（R11）：${String(allSources.length)} 个文件`);

if (violations.length > 0) {
  for (const v of violations) {
    console.error(`[arch-check] ${v.rule} 违规：${v.pkg} → ${v.dep}（${v.message}）`);
  }
  console.error(`[arch-check] 共 ${violations.length} 条违规。`);
  process.exit(1);
}

console.log('[arch-check] 依赖方向与纯核心检查通过（R1—R11）。');
