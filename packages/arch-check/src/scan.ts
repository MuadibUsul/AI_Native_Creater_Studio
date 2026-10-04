import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { WorkspacePackage } from './rules.js';

const toPosix = (p: string): string => p.split('\\').join('/');

async function readPackage(dir: string, rootDir: string): Promise<WorkspacePackage | null> {
  let raw: string;
  try {
    raw = await readFile(join(dir, 'package.json'), 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const obj = parsed as Record<string, unknown>;
  const name = obj['name'];
  if (typeof name !== 'string' || name.length === 0) return null;

  const deps: Record<string, string> = {};
  const prodDeps = new Set<string>();
  for (const field of ['dependencies', 'devDependencies'] as const) {
    const candidate = obj[field];
    if (typeof candidate === 'object' && candidate !== null) {
      for (const [dep, version] of Object.entries(candidate as Record<string, unknown>)) {
        if (typeof version === 'string') {
          deps[dep] = version;
          if (field === 'dependencies') prodDeps.add(dep);
        }
      }
    }
  }

  return { name, dir: toPosix(relative(rootDir, dir)), deps, prodDeps };
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => join(dir, e.name));
  } catch {
    return [];
  }
}

/**
 * 扫描仓库中的 workspace 包：
 * - apps/<name>/package.json
 * - packages/<name>/package.json
 * - packages/<group>/<name>/package.json（如 packages/providers/llm）
 */
export async function scanWorkspace(rootDir: string): Promise<WorkspacePackage[]> {
  const results: WorkspacePackage[] = [];

  for (const base of ['apps', 'packages'] as const) {
    for (const dir of await listDirs(join(rootDir, base))) {
      const pkg = await readPackage(dir, rootDir);
      if (pkg) {
        results.push(pkg);
        continue;
      }
      // 二级包（packages/providers/* 等）
      for (const sub of await listDirs(dir)) {
        const subPkg = await readPackage(sub, rootDir);
        if (subPkg) results.push(subPkg);
      }
    }
  }

  return results.sort((a, b) => a.dir.localeCompare(b.dir));
}
