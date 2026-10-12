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
  '@ancs/time': srcAlias('./packages/time/src/index.ts'),
  '@ancs/kernel': srcAlias('./packages/kernel/src/index.ts'),
  '@ancs/contracts': srcAlias('./packages/contracts/src/index.ts'),
  '@ancs/sdk': srcAlias('./packages/sdk/src/index.ts'),
  '@ancs/db': srcAlias('./packages/db/src/index.ts'),
  '@ancs/auth': srcAlias('./packages/auth/src/index.ts'),
  '@ancs/domain': srcAlias('./packages/domain/src/index.ts'),
  '@ancs/extensions': srcAlias('./packages/extensions/src/index.ts'),
  '@ancs/providers-storage-local': srcAlias('./packages/providers/storage-local/src/index.ts'),
  '@ancs/providers-queue-bullmq': srcAlias('./packages/providers/queue-bullmq/src/index.ts'),
  '@ancs/providers-credential-vault-local': srcAlias('./packages/providers/credential-vault-local/src/index.ts'),
  '@ancs/providers-youtube': srcAlias('./packages/providers/youtube/src/index.ts'),
  '@ancs/providers-mock-provider': srcAlias('./packages/providers/mock-provider/src/index.ts'),
  '@ancs/providers-mock-llm': srcAlias('./packages/providers/mock-llm/src/index.ts'),
  '@ancs/providers-anthropic': srcAlias('./packages/providers/anthropic/src/index.ts'),
  '@ancs/providers-mock-tts': srcAlias('./packages/providers/mock-tts/src/index.ts'),
  '@ancs/providers-mock-payments': srcAlias('./packages/providers/mock-payments/src/index.ts'),
  '@ancs/providers-malware-heuristic': srcAlias('./packages/providers/malware-heuristic/src/index.ts'),
  '@ancs/providers-document-extract': srcAlias('./packages/providers/document-extract/src/index.ts'),
  '@ancs/scene-components': srcAlias('./packages/scene-components/src/index.ts'),
};

export default defineConfig({
  test: {
    projects: [
      {
        // AI 质量评测（与单测分开跑：`pnpm test:eval`；度量趋势与误采纳率，不进 verify 的强门）
        test: {
          name: 'eval',
          environment: 'node',
          include: ['packages/**/*.eval.ts', 'apps/**/*.eval.ts'],
          exclude: ['**/node_modules/**'],
          alias: workspaceAliases,
          passWithNoTests: false,
        },
      },
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['packages/**/*.test.ts', 'packages/**/*.test.tsx', 'apps/api/src/**/*.test.ts', 'apps/worker/src/**/*.test.ts'],
          exclude: [
            '**/node_modules/**',
            'packages/db/**',
            'packages/testing/**',
            'packages/auth/**',
            // domain 的集成测试需要数据库 → 排除；纯函数单测（如 content-extract.test.ts）保留在 unit
            'packages/domain/**/*.integration.test.ts',
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
        // Motion 沙箱（P07-01）：隔离子进程 spawn 测试（超时用例需要较长窗口）
        test: {
          name: 'motion',
          environment: 'node',
          include: ['apps/motion-worker/src/**/*.test.ts'],
          exclude: ['**/node_modules/**'],
          testTimeout: 30000,
          hookTimeout: 30000,
          passWithNoTests: false,
        },
      },
      {
        // Web 客户端（P05-03）：jsdom + Testing Library；Next 固定 tsconfig jsx=preserve，测试侧用 oxc 显式 automatic
        oxc: { jsx: 'automatic' },
        resolve: {
          alias: [{ find: /^@\//, replacement: `${srcAlias('./apps/web/src')}/` }],
        },
        test: {
          name: 'web',
          environment: 'jsdom',
          // 同时收 .test.ts：否则纯 TS 的浏览器侧测试会被**静默跳过**（看似通过实则没跑）
          include: ['apps/web/src/**/*.test.tsx', 'apps/web/src/**/*.test.ts'],
          exclude: ['**/node_modules/**'],
          alias: workspaceAliases,
          setupFiles: ['./apps/web/src/test-setup.ts'],
          testTimeout: 20000,
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
          alias: workspaceAliases,
          testTimeout: 600000,
          hookTimeout: 600000,
          passWithNoTests: false,
        },
      },
    ],
  },
});
