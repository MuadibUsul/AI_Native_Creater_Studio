import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/**/*.test.ts'],
    // 不允许"无测试即通过"：测试集合为空时视为失败（反假成功，计划 §7）
    passWithNoTests: false,
  },
});
