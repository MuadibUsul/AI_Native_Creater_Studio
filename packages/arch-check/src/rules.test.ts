import { describe, expect, it } from 'vitest';
import { checkRules, checkSourcePurity, type WorkspacePackage } from './rules.js';

/**
 * 构造测试包。
 * prodDeps 默认等于全部 deps（模拟"所有依赖都是生产依赖"）；
 * 需要区分 devDependencies 时显式传入 prodKeys。
 */
const pkg = (
  name: string,
  dir: string,
  deps: Record<string, string> = {},
  prodKeys: readonly string[] = Object.keys(deps),
): WorkspacePackage => ({ name, dir, deps, prodDeps: new Set(prodKeys) });

describe('checkRules：架构依赖方向', () => {
  it('合法的最小工作区通过全部规则', () => {
    const pkgs = [
      pkg('@ancs/contracts', 'packages/contracts'),
      pkg('@ancs/domain', 'packages/domain', { '@ancs/contracts': 'workspace:*' }),
      pkg('@ancs/providers-llm', 'packages/providers/llm', { '@ancs/contracts': 'workspace:*', openai: '^4.0.0' }),
      pkg('@ancs/db', 'packages/db'),
      pkg('@ancs/sdk', 'packages/sdk', { '@ancs/contracts': 'workspace:*' }),
      pkg('@ancs/web', 'apps/web', { '@ancs/sdk': 'workspace:*', '@ancs/contracts': 'workspace:*' }),
      pkg('@ancs/api', 'apps/api', { '@ancs/contracts': 'workspace:*' }),
      pkg('@ancs/render-worker', 'apps/render-worker'),
    ];
    expect(checkRules(pkgs)).toEqual([]);
  });

  it('R1：apps 不得依赖其他 apps', () => {
    const pkgs = [
      pkg('@ancs/web', 'apps/web', { '@ancs/mobile': 'workspace:*' }),
      pkg('@ancs/mobile', 'apps/mobile'),
    ];
    expect(checkRules(pkgs).map((v) => v.rule)).toContain('R1');
  });

  it('R2：packages 不得依赖 apps（含 devDependency）', () => {
    const pkgs = [
      pkg('@ancs/web', 'apps/web'),
      pkg('@ancs/sdk', 'packages/sdk', { '@ancs/web': 'workspace:*' }, []),
    ];
    expect(checkRules(pkgs).map((v) => v.rule)).toContain('R2');
  });

  it('R3：domain 不得依赖 next/react/react-dom/@remotion', () => {
    const pkgs = [
      pkg('@ancs/domain', 'packages/domain', {
        next: '^15.0.0',
        react: '^19.0.0',
        '@remotion/renderer': '^4.0.0',
      }),
    ];
    const deps = checkRules(pkgs)
      .filter((v) => v.rule === 'R3')
      .map((v) => v.dep);
    expect(deps).toEqual(expect.arrayContaining(['next', 'react', '@remotion/renderer']));
  });

  it('R3：domain 不得依赖 packages/providers/*', () => {
    const pkgs = [
      pkg('@ancs/providers-llm', 'packages/providers/llm'),
      pkg('@ancs/domain', 'packages/domain', { '@ancs/providers-llm': 'workspace:*' }),
    ];
    const rules = checkRules(pkgs).filter((v) => v.rule === 'R3');
    expect(rules).toHaveLength(1);
    expect(rules[0]?.dep).toBe('@ancs/providers-llm');
  });

  it('R3：平台中立包（contracts/extensions）不得依赖 Web/渲染框架（裁决 0004）', () => {
    const pkgs = [
      pkg('@ancs/contracts', 'packages/contracts', { react: '^19.0.0' }),
      pkg('@ancs/extensions', 'packages/extensions', { '@remotion/renderer': '^4.0.0' }),
      pkg('@ancs/domain2', 'packages/domain2', { next: '^15.0.0' }), // 非中立包不受此规则约束
    ];
    const rules = checkRules(pkgs).filter((v) => v.rule === 'R3');
    expect(rules.map((v) => v.pkg)).toEqual(['@ancs/contracts', '@ancs/extensions']);
    expect(rules.map((v) => v.dep)).toEqual(['react', '@remotion/renderer']);
  });

  it('R4：providers/* 生产依赖仅允许 contracts/domain；外部 SDK 与 devDependency 不受限', () => {
    const bad = [
      pkg('@ancs/db', 'packages/db'),
      pkg('@ancs/providers-llm', 'packages/providers/llm', {
        '@ancs/db': 'workspace:*',
        '@ancs/domain': 'workspace:*',
        openai: '^4.0.0',
      }),
    ];
    const rules = checkRules(bad).filter((v) => v.rule === 'R4');
    expect(rules).toHaveLength(1);
    expect(rules[0]?.dep).toBe('@ancs/db');

    const devOnly = [
      pkg('@ancs/db', 'packages/db'),
      pkg('@ancs/testing', 'packages/testing'),
      pkg(
        '@ancs/providers-llm',
        'packages/providers/llm',
        { '@ancs/domain': 'workspace:*', '@ancs/testing': 'workspace:*' },
        ['@ancs/domain'],
      ),
    ];
    expect(checkRules(devOnly).filter((v) => v.rule === 'R4')).toEqual([]);
  });

  it('R5：web/desktop/mobile 生产依赖仅允许 sdk/contracts/ui/scene-components/remotion-core（裁决 0005/0006）', () => {
    const pkgs = [
      pkg('@ancs/db', 'packages/db'),
      pkg('@ancs/web', 'apps/web', { '@ancs/db': 'workspace:*' }),
      pkg('@ancs/desktop', 'apps/desktop', { '@ancs/sdk': 'workspace:*' }),
      pkg('@ancs/mobile', 'apps/mobile', { '@ancs/ui': 'workspace:*' }),
      // 裁决 0005/0006：组件库与预览时序包（预览/编辑/成片单一来源）在生产依赖中被允许
      pkg('@ancs/web2', 'apps/web', { '@ancs/scene-components': 'workspace:*' }),
      pkg('@ancs/web3', 'apps/web', { '@ancs/remotion-core': 'workspace:*' }),
    ];
    const rules = checkRules(pkgs).filter((v) => v.rule === 'R5');
    expect(rules).toHaveLength(1);
    expect(rules[0]?.pkg).toBe('@ancs/web');
  });

  it('R6：悬挂的 workspace 依赖被拒绝', () => {
    const pkgs = [pkg('@ancs/sdk', 'packages/sdk', { '@ancs/contracts': 'workspace:*' })];
    const rules = checkRules(pkgs).filter((v) => v.rule === 'R6');
    expect(rules).toHaveLength(1);
    expect(rules[0]?.dep).toBe('@ancs/contracts');
  });

  it('R7：api/worker 生产依赖仅允许 domain/contracts/db 与 providers/*；devDependency 允许 sdk', () => {
    const bad = [
      pkg('@ancs/sdk', 'packages/sdk'),
      pkg('@ancs/api', 'apps/api', { '@ancs/sdk': 'workspace:*' }, ['@ancs/sdk']),
    ];
    const rules = checkRules(bad).filter((v) => v.rule === 'R7');
    expect(rules).toHaveLength(1);
    expect(rules[0]?.dep).toBe('@ancs/sdk');

    const good = [
      pkg('@ancs/contracts', 'packages/contracts'),
      pkg('@ancs/domain', 'packages/domain'),
      pkg('@ancs/db', 'packages/db'),
      pkg('@ancs/auth', 'packages/auth'),
      pkg('@ancs/providers-llm', 'packages/providers/llm'),
      pkg(
        '@ancs/api',
        'apps/api',
        { '@ancs/contracts': 'workspace:*', '@ancs/auth': 'workspace:*', '@ancs/sdk': 'workspace:*' },
        ['@ancs/contracts', '@ancs/auth'],
      ),
      pkg(
        '@ancs/worker',
        'apps/worker',
        { '@ancs/db': 'workspace:*', '@ancs/providers-llm': 'workspace:*' },
        ['@ancs/db', '@ancs/providers-llm'],
      ),
    ];
    expect(checkRules(good).filter((v) => v.rule === 'R7')).toEqual([]);
  });

  it('R8：render-worker/motion-worker 生产依赖仅允许 contracts/scene-schema/scene-components/remotion-core', () => {
    const bad = [
      pkg('@ancs/db', 'packages/db'),
      pkg('@ancs/render-worker', 'apps/render-worker', { '@ancs/db': 'workspace:*' }, ['@ancs/db']),
    ];
    expect(checkRules(bad).filter((v) => v.rule === 'R8')).toHaveLength(1);

    const good = [
      pkg('@ancs/contracts', 'packages/contracts'),
      pkg('@ancs/scene-components', 'packages/scene-components'),
      pkg(
        '@ancs/render-worker',
        'apps/render-worker',
        { '@ancs/contracts': 'workspace:*', '@ancs/scene-components': 'workspace:*' },
        ['@ancs/contracts', '@ancs/scene-components'],
      ),
    ];
    expect(checkRules(good).filter((v) => v.rule === 'R8')).toEqual([]);
  });

  it('非 workspace 依赖不触发工作区规则', () => {
    const pkgs = [
      pkg('@ancs/domain', 'packages/domain', { zod: '^3.0.0', typescript: '^5.0.0' }),
      pkg('@ancs/web', 'apps/web', { next: '^15.0.0', react: '^19.0.0' }),
      pkg('@ancs/render-worker', 'apps/render-worker', { remotion: '^4.0.0', react: '^19.0.0' }),
    ];
    expect(checkRules(pkgs)).toEqual([]);
  });

  it('R9：编辑内核只能依赖 contracts/time；时间库不得依赖任何 workspace 包（裁决 0012）', () => {
    const base = [
      pkg('@ancs/contracts', 'packages/contracts', { '@ancs/time': 'workspace:*' }),
      pkg('@ancs/time', 'packages/time', { zod: '4.6.5' }),
      pkg('@ancs/db', 'packages/db'),
    ];
    expect(checkRules([...base, pkg('@ancs/kernel', 'packages/kernel', { '@ancs/contracts': 'workspace:*', '@ancs/time': 'workspace:*' })])).toEqual([]);
    const badKernel = checkRules([...base, pkg('@ancs/kernel', 'packages/kernel', { '@ancs/db': 'workspace:*' }, [])]);
    expect(badKernel.map((v) => [v.rule, v.dep])).toEqual([['R9', '@ancs/db']]);
    const badTime = checkRules([
      pkg('@ancs/contracts', 'packages/contracts'),
      pkg('@ancs/time', 'packages/time', { '@ancs/contracts': 'workspace:*' }),
    ]);
    expect(badTime.map((v) => v.rule)).toEqual(['R9']);
  });
});

describe('checkSourcePurity：纯核心源码（R10）', () => {
  it('拒绝 I/O 导入与非确定性 API；注释中的提及不算', () => {
    const violations = checkSourcePurity([
      { path: 'packages/kernel/src/a.ts', content: "import { readFile } from 'node:fs';\nconst id = Math.random();\n// Date.now() 只在注释里" },
      { path: 'packages/kernel/src/b.ts', content: "import { db } from '@ancs/db';\nconst at = new Date();\nconst env = process.env['X'];" },
      { path: 'packages/time/src/c.ts', content: "export const ok = (a: bigint) => a + 1n;" },
    ]);
    expect(violations.map((v) => `${v.pkg}:${v.dep}`)).toEqual([
      'packages/kernel/src/a.ts:第 1 行',
      'packages/kernel/src/a.ts:第 2 行',
      'packages/kernel/src/b.ts:第 1 行',
      'packages/kernel/src/b.ts:第 2 行',
      'packages/kernel/src/b.ts:第 3 行',
    ]);
  });
});
