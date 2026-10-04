import { describe, expect, it } from 'vitest';
import { checkRules, type WorkspacePackage } from './rules.js';

const pkg = (name: string, dir: string, deps: Record<string, string> = {}): WorkspacePackage => ({
  name,
  dir,
  deps,
});

describe('checkRules：架构依赖方向', () => {
  it('合法的最小工作区通过全部规则', () => {
    const pkgs = [
      pkg('@ancs/contracts', 'packages/contracts'),
      pkg('@ancs/domain', 'packages/domain', { '@ancs/contracts': 'workspace:*' }),
      pkg('@ancs/providers-llm', 'packages/providers/llm', { '@ancs/contracts': 'workspace:*', openai: '^4.0.0' }),
      pkg('@ancs/sdk', 'packages/sdk', { '@ancs/contracts': 'workspace:*' }),
      pkg('@ancs/web', 'apps/web', { '@ancs/sdk': 'workspace:*', '@ancs/contracts': 'workspace:*' }),
    ];
    expect(checkRules(pkgs)).toEqual([]);
  });

  it('R1：apps 不得依赖其他 apps', () => {
    const pkgs = [
      pkg('@ancs/web', 'apps/web', { '@ancs/mobile': 'workspace:*' }),
      pkg('@ancs/mobile', 'apps/mobile'),
    ];
    const violations = checkRules(pkgs);
    expect(violations.map((v) => v.rule)).toContain('R1');
  });

  it('R2：packages 不得依赖 apps', () => {
    const pkgs = [
      pkg('@ancs/web', 'apps/web'),
      pkg('@ancs/sdk', 'packages/sdk', { '@ancs/web': 'workspace:*' }),
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

  it('R4：providers/* 仅允许依赖 contracts/domain；外部 SDK 不受限', () => {
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

    const good = [
      pkg('@ancs/domain', 'packages/domain'),
      pkg('@ancs/providers-llm', 'packages/providers/llm', {
        '@ancs/domain': 'workspace:*',
        openai: '^4.0.0',
      }),
    ];
    expect(checkRules(good).filter((v) => v.rule === 'R4')).toEqual([]);
  });

  it('R5：web/desktop/mobile 仅允许 sdk/contracts/ui', () => {
    const pkgs = [
      pkg('@ancs/db', 'packages/db'),
      pkg('@ancs/web', 'apps/web', { '@ancs/db': 'workspace:*' }),
      pkg('@ancs/desktop', 'apps/desktop', { '@ancs/sdk': 'workspace:*' }),
      pkg('@ancs/mobile', 'apps/mobile', { '@ancs/ui': 'workspace:*' }),
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

  it('非 workspace 依赖不触发工作区规则', () => {
    const pkgs = [
      pkg('@ancs/domain', 'packages/domain', { zod: '^3.0.0', typescript: '^5.0.0' }),
      pkg('@ancs/web', 'apps/web', { next: '^15.0.0', react: '^19.0.0' }),
    ];
    expect(checkRules(pkgs)).toEqual([]);
  });
});
