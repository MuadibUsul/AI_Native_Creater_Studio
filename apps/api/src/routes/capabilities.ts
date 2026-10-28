import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { capabilitiesResponseSchema, type AccountCapabilities, type ProviderInventoryEntry } from '@ancs/contracts';
import type { ExtensionRegistry } from '@ancs/extensions';

export interface ExtensionsDeps {
  extensions: ExtensionRegistry;
  /** 装配的外部能力驱动与实现种类（V5-M3；不含任何凭据） */
  providers?: readonly ProviderInventoryEntry[];
  /** 旧 V4 流水线是否装配（缺省 mock） */
  legacyPipeline?: 'mock' | 'off';
  /** 账号自助：注册方式与能否找回密码（缺省 closed、不能找回） */
  accounts?: AccountCapabilities;
}

/**
 * 扩展能力端点（P01-06 / §92.3）：
 * - 公开端点（不含租户数据，无认证要求）；
 * - 未安装的能力明确表现为"不列出 + 查询时 available:false + 原因"；
 * - 需要强制守卫的输出类路由统一调用 registry.requireOutputFormat（CAPABILITY_UNAVAILABLE）。
 */
export function registerCapabilityRoutes(app: FastifyInstance, deps: ExtensionsDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    '/capabilities',
    {
      schema: {
        tags: ['capabilities'],
        summary: '扩展能力清单（未安装能力不列出；查询目标格式时明确返回不可用与原因）',
        querystring: z.object({ outputFormat: z.string().min(1).max(64).optional() }),
        response: { 200: capabilitiesResponseSchema },
      },
    },
    async (request) => {
      const snapshot = deps.extensions.snapshot();
      const requested = request.query.outputFormat;
      return {
        ...snapshot,
        outputFormatAvailability:
          requested === undefined ? null : deps.extensions.availability(requested),
        providers: [...(deps.providers ?? [])],
        legacyPipeline: deps.legacyPipeline ?? 'mock',
        accounts: deps.accounts ?? { signup: 'closed' as const, passwordReset: false },
      };
    },
  );
}
