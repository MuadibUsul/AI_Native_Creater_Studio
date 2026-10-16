import { z } from 'zod';
import type { EnvIssue } from './env.js';

/**
 * Provider 种类显式化（V5 §11.3 第 4 条，M3）：
 * 每个装配进进程的外部能力驱动声明实现种类 `REAL | MOCK | SCRIPTED`。
 *
 * - MOCK：确定性假输出（无真实生成/扣款/发布能力）；SCRIPTED：按脚本回放的半真实驱动（测试/演示）；
 * - 生产进程（NODE_ENV=production）装配 MOCK/SCRIPTED 必须显式 `ANCS_ALLOW_MOCK_PROVIDERS=1`，否则启动失败；
 * - 装配清单经 `/capabilities` 对外报告，客户端据此显示 Mock 标识（"Mock 验证通过 ≠ 真实 Provider 验证通过"）。
 */
/** 与 `PROVIDER_KINDS`（能力类别：LLM/TTS/…）不同：这里是**实现种类**。 */
export const PROVIDER_IMPLEMENTATIONS = ['REAL', 'MOCK', 'SCRIPTED'] as const;
export const providerImplementationSchema = z.enum(PROVIDER_IMPLEMENTATIONS);
export type ProviderImplementation = z.infer<typeof providerImplementationSchema>;

export const providerInventoryEntrySchema = z.object({
  /** 能力名（llm、tts、voice_clone、stock_search、payments、distribution、asr…） */
  capability: z.string().min(1).max(64),
  /** 驱动名（mock、deepgram、process…） */
  driver: z.string().min(1).max(64),
  implementation: providerImplementationSchema,
}).strict();
export type ProviderInventoryEntry = z.infer<typeof providerInventoryEntrySchema>;

/** 生产装配守卫：返回全部问题（由入口以 fail-closed 方式一次性打印并退出）。 */
export function checkProviderInventory(
  env: { NODE_ENV?: string | undefined; ANCS_ALLOW_MOCK_PROVIDERS?: string | undefined },
  inventory: readonly ProviderInventoryEntry[],
): EnvIssue[] {
  if (env.NODE_ENV !== 'production' || env.ANCS_ALLOW_MOCK_PROVIDERS === '1') return [];
  const simulated = inventory.filter((entry) => entry.implementation !== 'REAL');
  if (simulated.length === 0) return [];
  return [{
    variable: 'ANCS_ALLOW_MOCK_PROVIDERS',
    message: `生产环境装配了非真实驱动（${simulated.map((entry) => `${entry.capability}=${entry.driver}:${entry.implementation}`).join('、')}）：`
      + '请配置真实驱动，或显式设置 ANCS_ALLOW_MOCK_PROVIDERS=1（产物与界面将标识 Mock）',
  }];
}
