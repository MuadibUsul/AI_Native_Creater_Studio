import { DEFAULT_SANDBOX_LIMITS, type MotionSandboxLimits } from './sandbox.ts';
import { MOTION_TYPECHECK_VERSION } from './typecheck.ts';

/**
 * 验证流水线参数（P07-02）：与 P07-01 沙箱限制分离，集中声明供报告与测试引用。
 */

export const MOTION_ANALYZER_VERSION = 'motion-analysis-v1';

export const MOTION_VALIDATION_LIMITS: MotionSandboxLimits & { analyzerVersion: string } = {
  ...DEFAULT_SANDBOX_LIMITS,
  analyzerVersion: `${MOTION_ANALYZER_VERSION}+${MOTION_TYPECHECK_VERSION}`,
};
