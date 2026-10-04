import { resolve } from 'node:path';
import { checkRules } from './rules.js';
import { scanWorkspace } from './scan.js';

const root = resolve(process.argv[2] ?? process.cwd());

const pkgs = await scanWorkspace(root);
const violations = checkRules(pkgs);

const list = pkgs.length > 0 ? pkgs.map((p) => p.dir).join(', ') : '（尚未创建 workspace 包）';
console.log(`[arch-check] 根目录：${root}`);
console.log(`[arch-check] 扫描到 ${pkgs.length} 个 workspace 包：${list}`);

if (violations.length > 0) {
  for (const v of violations) {
    console.error(`[arch-check] ${v.rule} 违规：${v.pkg} → ${v.dep}（${v.message}）`);
  }
  console.error(`[arch-check] 共 ${violations.length} 条违规。`);
  process.exit(1);
}

console.log('[arch-check] 依赖方向检查通过（R1—R6）。');
