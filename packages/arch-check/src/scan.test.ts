import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scanWorkspace } from './scan.js';

let root: string;

const write = async (dir: string, pkg: Record<string, unknown>): Promise<void> => {
  await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, dir, 'package.json'), JSON.stringify(pkg), 'utf8');
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ancs-arch-scan-'));
  await write('apps/web', {
    name: '@ancs/web',
    dependencies: { '@ancs/sdk': 'workspace:*' },
    devDependencies: { vite: '^6.0.0' },
  });
  await write('packages/domain', { name: '@ancs/domain' });
  await write('packages/providers/llm', { name: '@ancs/providers-llm' });
  // 非包目录：应被忽略
  await mkdir(join(root, 'packages/not-a-package'), { recursive: true });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('scanWorkspace', () => {
  it('扫描 apps/*、packages/* 与 packages/providers/*，忽略非包目录', async () => {
    const pkgs = await scanWorkspace(root);
    expect(pkgs.map((p) => p.dir)).toEqual(['apps/web', 'packages/domain', 'packages/providers/llm']);
  });

  it('合并 dependencies 与 devDependencies，保留版本字符串', async () => {
    const pkgs = await scanWorkspace(root);
    const web = pkgs.find((p) => p.name === '@ancs/web');
    expect(web?.deps).toEqual({ '@ancs/sdk': 'workspace:*', vite: '^6.0.0' });
  });
});
