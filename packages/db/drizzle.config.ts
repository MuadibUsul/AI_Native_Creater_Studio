import { defineConfig } from 'drizzle-kit';

/** drizzle-kit 配置（generate/migrate 使用；测试与运行时的迁移入口是 src/migrate.ts）。 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'postgres://ancs:ancs@localhost:55432/ancs_dev',
  },
});
