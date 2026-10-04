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
};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['packages/**/*.test.ts', 'apps/api/src/**/*.test.ts'],
          exclude: ['**/node_modules/**', 'packages/db/**', 'packages/testing/**'],
          alias: workspaceAliases,
          passWithNoTests: false,
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['packages/db/**/*.test.ts'],
          exclude: ['**/node_modules/**'],
          alias: workspaceAliases,
          testTimeout: 30000,
          passWithNoTests: false,
        },
      },
      {
        test: {
          name: 'golden',
          environment: 'node',
          include: ['packages/testing/src/**/*.test.ts'],
          exclude: ['**/node_modules/**'],
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
