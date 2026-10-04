import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * 测试分层（计划 §11.1 / 规范 §51）：
 * - unit：无外部依赖的快速测试（含 Fastify inject 路由测试）
 * - integration：需要真实 PostgreSQL 的测试（连接串见 packages/db；本地用 infra/docker-compose.dev.yml）
 * - render：Remotion 真实渲染（服务端 bundle + MP4/PNG 产物校验），耗时长
 * 所有项目禁用"无测试即通过"，防止空跑假成功。
 *
 * alias：测试直接解析内部包源码（不依赖构建顺序；构建产物正确性由 build/CI 保证）。
 */
const srcAlias = (relPath: string): string => fileURLToPath(new URL(relPath, import.meta.url));

const workspaceAliases: Record<string, string> = {
  '@ancs/contracts': srcAlias('./packages/contracts/src/index.ts'),
  '@ancs/sdk': srcAlias('./packages/sdk/src/index.ts'),
  '@ancs/db': srcAlias('./packages/db/src/index.ts'),
  '@ancs/auth': srcAlias('./packages/auth/src/index.ts'),
  '@ancs/domain': srcAlias('./packages/domain/src/index.ts'),
  '@ancs/extensions': srcAlias('./packages/extensions/src/index.ts'),
  '@ancs/providers-storage-local': srcAlias('./packages/providers/storage-local/src/index.ts'),
  '@ancs/providers-queue-bullmq': srcAlias('./packages/providers/queue-bullmq/src/index.ts'),
};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['packages/**/*.test.ts', 'apps/api/src/**/*.test.ts', 'apps/worker/src/**/*.test.ts'],
          exclude: [
            '**/node_modules/**',
            'packages/db/**',
            'packages/testing/**',
            'packages/auth/**',
            'packages/domain/**',
            'apps/api/src/**/*.integration.test.ts',
            'apps/worker/src/**/*.integration.test.ts',
            'packages/providers/**/*.integration.test.ts',
            '**/*.security.test.ts',
          ],
          alias: workspaceAliases,
          passWithNoTests: false,
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: [
            'packages/db/**/*.test.ts',
            'packages/auth/**/*.integration.test.ts',
            'packages/domain/**/*.integration.test.ts',
            'apps/api/src/**/*.integration.test.ts',
            'apps/worker/src/**/*.integration.test.ts',
            'packages/providers/**/*.integration.test.ts',
          ],
          exclude: ['**/node_modules/**'],
          alias: workspaceAliases,
          testTimeout: 30000,
          // 这些套件共享同一个测试数据库（含清理与迁移），必须按文件串行，避免互相清表/并发迁移
          fileParallelism: false,
          passWithNoTests: false,
        },
      },
      {
        test: {
          name: 'security',
          environment: 'node',
          include: ['apps/api/src/*.security.test.ts', 'packages/auth/src/*.security.test.ts'],
          exclude: ['**/node_modules/**'],
          alias: workspaceAliases,
          testTimeout: 30000,
          // 与 integration 相同：共享测试数据库，按文件串行
          fileParallelism: false,
          passWithNoTests: false,
        },
      },
      {
        test: {
          name: 'golden',
          environment: 'node',
          include: ['packages/testing/src/**/*.test.ts'],
          exclude: ['**/node_modules/**'],
          alias: workspaceAliases,
          passWithNoTests: false,
        },
      },
      {
        test: {
          name: 'render',
          environment: 'node',
          include: ['apps/render-worker/src/**/*.test.ts'],
          exclude: ['**/node_modules/**'],
          testTimeout: 600000,
          hookTimeout: 600000,
          passWithNoTests: false,
        },
      },
    ],
  },
});
