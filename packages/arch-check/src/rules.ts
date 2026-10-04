/**
 * 架构依赖方向检查（规范 §49、计划 §3.4、REQ-49-02）。
 *
 * 规则（新增或放宽规则必须附裁决记录，不得静默修改）：
 *  R1 apps/* 不得依赖其他 apps/*（全部依赖）
 *  R2 packages/* 不得依赖 apps/*（全部依赖）
 *  R3 平台中立包（packages/domain、packages/contracts、packages/extensions）不得依赖
 *     next / react / react-dom / @remotion/*（全部依赖）；packages/domain 额外不得依赖 packages/providers/*
 *  R4 packages/providers/* 的【生产】workspace 依赖仅允许 @ancs/contracts、@ancs/domain
 *  R5 apps/web|desktop|mobile 的【生产】workspace 依赖仅允许 @ancs/sdk、@ancs/contracts、@ancs/ui、@ancs/scene-components（裁决 0005）
 *  R6 workspace 依赖必须指向真实存在的 workspace 包（全部依赖）
 *  R7 apps/api|worker 的【生产】workspace 依赖仅允许 domain/contracts/db 与 packages/providers/*（计划 §3.4）
 *  R8 apps/render-worker|motion-worker 的【生产】workspace 依赖仅允许 contracts/scene-schema/scene-components/remotion-core
 *
 * 说明：白名单类规则只约束"生产依赖方向"；devDependencies 允许测试用途的额外引用
 * （例如 apps/api 在集成测试中以 devDependency 使用 @ancs/sdk 扮演客户端）。
 * 层间隔离规则（R1—R3、R6）对全部依赖生效。
 */

export interface WorkspacePackage {
  /** package.json 中的 name */
  name: string;
  /** 仓库根相对路径（POSIX 风格），如 "packages/domain"、"apps/web" */
  dir: string;
  /** dependencies + devDependencies 合并（工作区依赖以 workspace: 前缀标记） */
  deps: Readonly<Record<string, string>>;
  /** 仅 dependencies（生产依赖）中的包名 */
  prodDeps: ReadonlySet<string>;
}

export interface Violation {
  rule: string;
  pkg: string;
  dep: string;
  message: string;
}

export const WEB_APP_DIRS: readonly string[] = ['apps/web', 'apps/desktop', 'apps/mobile'];

/**
 * 裁决 0005（P05-03）：Web 客户端可依赖 @ancs/scene-components（组件协议/注册表/渲染的单一来源，
 * 只依赖 react/zod/contracts；预览与编辑共用，规范 §11.1/§12）。
 */
export const WEB_APP_ALLOWED_WORKSPACE_DEPS: ReadonlySet<string> = new Set([
  '@ancs/sdk',
  '@ancs/contracts',
  '@ancs/ui',
  '@ancs/scene-components',
]);

export const PROVIDER_ALLOWED_WORKSPACE_DEPS: ReadonlySet<string> = new Set([
  '@ancs/contracts',
  '@ancs/domain',
]);

/**
 * apps/api、apps/worker（计划 §3.4：api/worker → domain/contracts/db/providers；
 * @ancs/auth 由裁决 0003 加入；@ancs/extensions 由裁决 0004 加入——规范 §92.3 要求
 * V1 定义 registry，API 是内置注册表的装配点）。
 */
export const SERVER_APP_DIRS: readonly string[] = ['apps/api', 'apps/worker'];
export const SERVER_APP_ALLOWED_PROD_DEPS: ReadonlySet<string> = new Set([
  '@ancs/contracts',
  '@ancs/domain',
  '@ancs/db',
  '@ancs/auth',
  '@ancs/extensions',
]);
export const SERVER_APP_ALLOWED_PROD_DEP_PREFIXES: readonly string[] = ['packages/providers/'];

/** apps/render-worker、apps/motion-worker（规范 §3.3/§3.4：只消费验证过的组件与固定输入） */
export const RENDER_WORKER_DIRS: readonly string[] = ['apps/render-worker', 'apps/motion-worker'];
export const RENDER_WORKER_ALLOWED_PROD_DEPS: ReadonlySet<string> = new Set([
  '@ancs/contracts',
  '@ancs/scene-schema',
  '@ancs/scene-components',
  '@ancs/remotion-core',
]);

const DOMAIN_FORBIDDEN_DEPS: readonly RegExp[] = [/^next$/, /^react$/, /^react-dom$/, /^@remotion\//];

/** 平台中立包：禁止依赖 Web/渲染框架（契约不依赖 Web 是 §92.1 / REQ-92-01 的 MUST） */
export const PLATFORM_NEUTRAL_PACKAGE_DIRS: readonly string[] = [
  'packages/domain',
  'packages/contracts',
  'packages/extensions',
];

export const isWorkspaceDep = (version: string): boolean => version.startsWith('workspace:');

export function checkRules(pkgs: readonly WorkspacePackage[]): Violation[] {
  const byName = new Map<string, WorkspacePackage>(pkgs.map((p) => [p.name, p]));
  const violations: Violation[] = [];

  for (const pkg of pkgs) {
    const allWorkspaceDeps = Object.entries(pkg.deps)
      .filter(([, version]) => isWorkspaceDep(version))
      .map(([dep]) => dep);
    const prodWorkspaceDeps = allWorkspaceDeps.filter((dep) => pkg.prodDeps.has(dep));

    // R6：悬挂的 workspace 依赖（全部依赖）
    for (const dep of allWorkspaceDeps) {
      if (!byName.has(dep)) {
        violations.push({
          rule: 'R6',
          pkg: pkg.name,
          dep,
          message: `workspace 依赖 "${dep}" 在仓库中不存在`,
        });
      }
    }

    // R1 / R2：app 与 package 的隔离（全部依赖）
    for (const dep of allWorkspaceDeps) {
      const target = byName.get(dep);
      if (!target) continue;
      if (pkg.dir.startsWith('apps/') && target.dir.startsWith('apps/')) {
        violations.push({ rule: 'R1', pkg: pkg.name, dep, message: 'apps/* 不得依赖其他 apps/*' });
      }
      if (pkg.dir.startsWith('packages/') && target.dir.startsWith('apps/')) {
        violations.push({ rule: 'R2', pkg: pkg.name, dep, message: 'packages/* 不得依赖 apps/*' });
      }
    }

    // R3：平台中立包的框架隔离（全部依赖）；domain 额外禁止 providers/*
    if (PLATFORM_NEUTRAL_PACKAGE_DIRS.includes(pkg.dir)) {
      for (const dep of Object.keys(pkg.deps)) {
        if (DOMAIN_FORBIDDEN_DEPS.some((re) => re.test(dep))) {
          violations.push({
            rule: 'R3',
            pkg: pkg.name,
            dep,
            message: `${pkg.dir} 不得依赖 Next.js / React / Remotion（平台中立契约与规则层）`,
          });
          continue;
        }
        if (pkg.dir === 'packages/domain') {
          const target = byName.get(dep);
          if (target?.dir.startsWith('packages/providers/')) {
            violations.push({ rule: 'R3', pkg: pkg.name, dep, message: 'domain 不得依赖 providers/*' });
          }
        }
      }
    }

    // R4：providers 的生产依赖白名单
    if (pkg.dir.startsWith('packages/providers/')) {
      for (const dep of prodWorkspaceDeps) {
        if (!PROVIDER_ALLOWED_WORKSPACE_DEPS.has(dep)) {
          violations.push({
            rule: 'R4',
            pkg: pkg.name,
            dep,
            message: `providers/* 的生产 workspace 依赖仅允许 ${[...PROVIDER_ALLOWED_WORKSPACE_DEPS].join(' / ')}`,
          });
        }
      }
    }

    // R5：Web/桌面/手机客户端的生产依赖白名单
    if (WEB_APP_DIRS.includes(pkg.dir)) {
      for (const dep of prodWorkspaceDeps) {
        if (!WEB_APP_ALLOWED_WORKSPACE_DEPS.has(dep)) {
          violations.push({
            rule: 'R5',
            pkg: pkg.name,
            dep,
            message: `web/desktop/mobile 的生产 workspace 依赖仅允许 ${[...WEB_APP_ALLOWED_WORKSPACE_DEPS].join(' / ')}`,
          });
        }
      }
    }

    // R7：api/worker 的生产依赖白名单（计划 §3.4）
    if (SERVER_APP_DIRS.includes(pkg.dir)) {
      for (const dep of prodWorkspaceDeps) {
        const target = byName.get(dep);
        const inProviders = SERVER_APP_ALLOWED_PROD_DEP_PREFIXES.some((prefix) =>
          target?.dir.startsWith(prefix),
        );
        if (!SERVER_APP_ALLOWED_PROD_DEPS.has(dep) && !inProviders) {
          violations.push({
            rule: 'R7',
            pkg: pkg.name,
            dep,
            message:
              `api/worker 的生产 workspace 依赖仅允许 ${[...SERVER_APP_ALLOWED_PROD_DEPS].join(' / ')} 与 packages/providers/*` +
              '（计划 §3.4；新增边需先有裁决记录）',
          });
        }
      }
    }

    // R8：render-worker/motion-worker 的生产依赖白名单
    if (RENDER_WORKER_DIRS.includes(pkg.dir)) {
      for (const dep of prodWorkspaceDeps) {
        if (!RENDER_WORKER_ALLOWED_PROD_DEPS.has(dep)) {
          violations.push({
            rule: 'R8',
            pkg: pkg.name,
            dep,
            message: `render-worker/motion-worker 的生产 workspace 依赖仅允许 ${[...RENDER_WORKER_ALLOWED_PROD_DEPS].join(' / ')}`,
          });
        }
      }
    }
  }

  return violations;
}
