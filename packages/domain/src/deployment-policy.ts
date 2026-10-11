import type { PlanKey } from '@ancs/contracts';

/**
 * 部署策略（V5-M3）：由进程入口在启动时**一次性**从已校验的环境配置注入（API、Worker、CLI 各自调用），
 * 领域层只读取这里，**不读取 `process.env`**（arch-check R12）。
 *
 * - 非法值在启动期由 env schema 拒绝（fail-closed），不会在请求期变成 500；
 * - 未配置时为预上线内部默认值（`ENTERPRISE`）；SaaS 上线门要求 `FREE`（见 crossCheckApiEnv）。
 */
export interface DeploymentPolicy {
  /** 未订阅 workspace 的默认套餐（ANCS_DEFAULT_PLAN） */
  defaultPlan: PlanKey;
}

const DEFAULT_POLICY: DeploymentPolicy = { defaultPlan: 'ENTERPRISE' };

let current: DeploymentPolicy = DEFAULT_POLICY;

/** 进程入口调用：未给出的字段取默认值（每次调用都是完整配置，不累积）。 */
export function configureDeploymentPolicy(next: Partial<DeploymentPolicy>): void {
  current = { ...DEFAULT_POLICY, ...Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined)) };
}

export function deploymentPolicy(): DeploymentPolicy {
  return current;
}
