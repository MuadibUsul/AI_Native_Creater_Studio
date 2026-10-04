/**
 * 架构依赖方向检查（规范 §49、计划 §3.4、REQ-49-02）。
 *
 * 规则（新增或放宽规则必须附裁决记录，不得静默修改）：
 *  R1 apps/* 不得依赖其他 apps/*
 *  R2 packages/* 不得依赖 apps/*
 *  R3 packages/domain 不得依赖 next / react / react-dom / @remotion/* 及 packages/providers/*
 *  R4 packages/providers/* 的 workspace 依赖仅允许 @ancs/contracts、@ancs/domain
 *  R5 apps/web|desktop|mobile 的 workspace 依赖仅允许 @ancs/sdk、@ancs/contracts、@ancs/ui
 *  R6 workspace 依赖必须指向真实存在的 workspace 包（无悬挂引用）
 */

export interface WorkspacePackage {
  /** package.json 中的 name */
  name: string;
  /** 仓库根相对路径（POSIX 风格），如 "packages/domain"、"apps/web" */
  dir: string;
  /** dependencies + devDependencies 合并（工作区依赖以 workspace: 前缀标记） */
  deps: Readonly<Record<string, string>>;
}

export interface Violation {
  rule: string;
  pkg: string;
  dep: string;
  message: string;
}

export const WEB_APP_DIRS: readonly string[] = ['apps/web', 'apps/desktop', 'apps/mobile'];

export const WEB_APP_ALLOWED_WORKSPACE_DEPS: ReadonlySet<string> = new Set([
  '@ancs/sdk',
  '@ancs/contracts',
  '@ancs/ui',
]);

export const PROVIDER_ALLOWED_WORKSPACE_DEPS: ReadonlySet<string> = new Set([
  '@ancs/contracts',
  '@ancs/domain',
]);

const DOMAIN_FORBIDDEN_DEPS: readonly RegExp[] = [/^next$/, /^react$/, /^react-dom$/, /^@remotion\//];

export const isWorkspaceDep = (version: string): boolean => version.startsWith('workspace:');

export function checkRules(pkgs: readonly WorkspacePackage[]): Violation[] {
  const byName = new Map<string, WorkspacePackage>(pkgs.map((p) => [p.name, p]));
  const violations: Violation[] = [];

  for (const pkg of pkgs) {
    const workspaceDeps = Object.entries(pkg.deps)
      .filter(([, version]) => isWorkspaceDep(version))
      .map(([dep]) => dep);

    // R6：悬挂的 workspace 依赖
    for (const dep of workspaceDeps) {
      if (!byName.has(dep)) {
        violations.push({
          rule: 'R6',
          pkg: pkg.name,
          dep,
          message: `workspace 依赖 "${dep}" 在仓库中不存在`,
        });
      }
    }

    // R1 / R2：app 与 package 的隔离
    for (const dep of workspaceDeps) {
      const target = byName.get(dep);
      if (!target) continue;
      if (pkg.dir.startsWith('apps/') && target.dir.startsWith('apps/')) {
        violations.push({ rule: 'R1', pkg: pkg.name, dep, message: 'apps/* 不得依赖其他 apps/*' });
      }
      if (pkg.dir.startsWith('packages/') && target.dir.startsWith('apps/')) {
        violations.push({ rule: 'R2', pkg: pkg.name, dep, message: 'packages/* 不得依赖 apps/*' });
      }
    }

    // R3：domain 的框架与 Provider 隔离
    if (pkg.dir === 'packages/domain') {
      for (const dep of Object.keys(pkg.deps)) {
        if (DOMAIN_FORBIDDEN_DEPS.some((re) => re.test(dep))) {
          violations.push({
            rule: 'R3',
            pkg: pkg.name,
            dep,
            message: 'domain 不得依赖 Next.js / React / Remotion',
          });
          continue;
        }
        const target = byName.get(dep);
        if (target?.dir.startsWith('packages/providers/')) {
          violations.push({ rule: 'R3', pkg: pkg.name, dep, message: 'domain 不得依赖 providers/*' });
        }
      }
    }

    // R4：providers 的 workspace 依赖白名单
    if (pkg.dir.startsWith('packages/providers/')) {
      for (const dep of workspaceDeps) {
        if (!PROVIDER_ALLOWED_WORKSPACE_DEPS.has(dep)) {
          violations.push({
            rule: 'R4',
            pkg: pkg.name,
            dep,
            message: `providers/* 的 workspace 依赖仅允许 ${[...PROVIDER_ALLOWED_WORKSPACE_DEPS].join(' / ')}`,
          });
        }
      }
    }

    // R5：Web/桌面/手机客户端的 workspace 依赖白名单
    if (WEB_APP_DIRS.includes(pkg.dir)) {
      for (const dep of workspaceDeps) {
        if (!WEB_APP_ALLOWED_WORKSPACE_DEPS.has(dep)) {
          violations.push({
            rule: 'R5',
            pkg: pkg.name,
            dep,
            message: `web/desktop/mobile 的 workspace 依赖仅允许 ${[...WEB_APP_ALLOWED_WORKSPACE_DEPS].join(' / ')}`,
          });
        }
      }
    }
  }

  return violations;
}
