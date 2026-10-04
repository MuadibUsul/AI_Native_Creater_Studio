import { bigNumberComponent } from './components/big-number.js';
import { registerComponent } from './registry.js';

/**
 * 内置标准组件注册（P05-01：参考组件 BIG_NUMBER；P05-02 扩容至 V1 标准 20 类）。
 * 幂等：重复调用不会重复注册。
 */

let registered = false;

export function registerBuiltInComponents(): void {
  if (registered) return;
  registerComponent(bigNumberComponent);
  registered = true;
}

/** 仅测试使用：允许在清空注册表后重新装配内置组件。 */
export function resetBuiltInFlagForTesting(): void {
  registered = false;
}
