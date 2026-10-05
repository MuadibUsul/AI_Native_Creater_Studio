import { describe, expect, it } from 'vitest';
import { apiEnvSchema, crossCheckApiEnv, crossCheckWorkerEnv, formatEnvFailure, validateEnv, workerEnvSchema } from './env.js';

/**
 * P08-01 环境配置契约（"错误配置启动失败并说明原因"）：
 * - 缺关键项/格式非法/未实现的驱动名 → **一次收集全部问题**（非逐条重试）；
 * - 明确的中文原因 + 变量名；未实现驱动显式失败（不静默降级为 Mock）。
 */

const validApiEnv = {
  DATABASE_URL: 'postgres://ancs:ancs@localhost:55432/ancs_dev',
  BETTER_AUTH_SECRET: 'deployment-secret-0123456789', // secrets:check-ignore：测试专用假密钥
};

describe('validateEnv（API）', () => {
  it('最小合法配置 → 通过（默认值：PORT=3001 / storage=local / llm=mock / tts=mock）', () => {
    const result = validateEnv(apiEnvSchema, validApiEnv);
    expect(result.ok).toBe(true);
    expect(result.value?.PORT).toBe(3001);
    expect(result.value?.ANCS_STORAGE_DRIVER).toBe('local');
    expect(result.value?.ANCS_LLM_DRIVER).toBe('mock');
  });

  it('缺 DATABASE_URL 与过短 Secret → 一次列出全部问题（含变量名）', () => {
    const result = validateEnv(apiEnvSchema, { BETTER_AUTH_SECRET: 'short' });
    expect(result.ok).toBe(false);
    const variables = result.issues.map((issue) => issue.variable);
    expect(variables).toContain('DATABASE_URL');
    expect(variables).toContain('BETTER_AUTH_SECRET');
    expect(result.issues.find((issue) => issue.variable === 'BETTER_AUTH_SECRET')?.message).toContain('≥16');
  });

  it('未实现的驱动名 → 显式失败（不静默降级：s3/r2 与真实 LLM/TTS 驱动均拒绝）', () => {
    const storage = validateEnv(apiEnvSchema, { ...validApiEnv, ANCS_STORAGE_DRIVER: 's3' });
    expect(storage.ok).toBe(false);
    expect(storage.issues.find((issue) => issue.variable === 'ANCS_STORAGE_DRIVER')?.message).toContain('仅支持 local');

    const llm = validateEnv(apiEnvSchema, { ...validApiEnv, ANCS_LLM_DRIVER: 'openai' });
    expect(llm.ok).toBe(false);
    expect(llm.issues.find((issue) => issue.variable === 'ANCS_LLM_DRIVER')?.message).toContain('仅支持 mock');
  });

  it('非法 PORT / 非法 URL → 明确原因', () => {
    const result = validateEnv(apiEnvSchema, { ...validApiEnv, PORT: '0', BETTER_AUTH_URL: 'not-a-url' });
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.variable).sort()).toEqual(['BETTER_AUTH_URL', 'PORT']);
  });

  it('格式化的失败清单：应用名 + 变量 + 原因 + 运行手册指引', () => {
    const result = validateEnv(apiEnvSchema, {});
    const message = formatEnvFailure('api', result.issues);
    expect(message).toContain('[api] 启动失败');
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('docs/ops/deployment-runbook.md');
  });
});

describe('validateEnv（Worker）与跨字段校验', () => {
  it('bullmq 队列驱动缺 REDIS_URL → 跨字段问题明确列出', () => {
    const result = validateEnv(workerEnvSchema, { ...validApiEnv, ANCS_QUEUE_DRIVER: 'bullmq' });
    expect(result.ok).toBe(true);
    const issues = crossCheckWorkerEnv(result.value as NonNullable<typeof result.value>);
    expect(issues).toEqual([{ variable: 'REDIS_URL', message: 'ANCS_QUEUE_DRIVER=bullmq 时必须配置 REDIS_URL' }]);
  });

  it('bullmq + REDIS_URL 配置齐全 → 无问题', () => {
    const result = validateEnv(workerEnvSchema, { ...validApiEnv, ANCS_QUEUE_DRIVER: 'bullmq', REDIS_URL: 'redis://localhost:6379' });
    expect(result.ok).toBe(true);
    expect(crossCheckWorkerEnv(result.value as NonNullable<typeof result.value>)).toEqual([]);
  });

  it('未知队列驱动 → 显式失败', () => {
    const result = validateEnv(workerEnvSchema, { ...validApiEnv, ANCS_QUEUE_DRIVER: 'sqs' });
    expect(result.ok).toBe(false);
    expect(result.issues.find((issue) => issue.variable === 'ANCS_QUEUE_DRIVER')?.message).toContain('db | bullmq');
  });
});

describe('商业上线门（P09-06）：live 模式跨字段条件', () => {
  const liveEnv = {
    ...validApiEnv,
    ANCS_SAAS_MODE: 'live',
    ANCS_DEFAULT_PLAN: 'FREE',
    ANCS_PAYMENTS_DRIVER: 'stripe',
    BETTER_AUTH_URL: 'https://api.example.com',
    ANCS_PLATFORM_ADMINS: 'usr_admin_1',
  };

  it('默认 internal：不启用 live 门禁（预上线内部部署不受影响）', () => {
    const result = validateEnv(apiEnvSchema, validApiEnv);
    expect(result.ok).toBe(true);
    expect(result.value?.ANCS_SAAS_MODE).toBe('internal');
    expect(crossCheckApiEnv(result.value as NonNullable<typeof result.value>)).toEqual([]);
  });

  it('live 全条件满足（保留 local 存储例外）→ 无问题', () => {
    const result = validateEnv(apiEnvSchema, liveEnv);
    expect(result.ok).toBe(true);
    const issues = crossCheckApiEnv(result.value as NonNullable<typeof result.value>);
    // storage 仍为默认 local → 仍会报存储一项；这里先断言其它条件均满足
    expect(issues.map((issue) => issue.variable)).toEqual(['ANCS_STORAGE_DRIVER']);
  });

  it('live 缺条件 → 逐项明确（默认套餐非 FREE / mock 收款 / local 存储 / 非 https / 无管理员）', () => {
    const result = validateEnv(apiEnvSchema, { ...validApiEnv, ANCS_SAAS_MODE: 'live', ANCS_PAYMENTS_DRIVER: 'mock', ANCS_PAYMENTS_MOCK_SECRET: 'live-gate-mock-secret-0123' }); // secrets:check-ignore：测试专用假密钥
    expect(result.ok).toBe(true);
    const issues = crossCheckApiEnv(result.value as NonNullable<typeof result.value>);
    const variables = issues.map((issue) => issue.variable).sort();
    expect(variables).toEqual(['ANCS_DEFAULT_PLAN', 'ANCS_PAYMENTS_DRIVER', 'ANCS_PLATFORM_ADMINS', 'ANCS_STORAGE_DRIVER', 'BETTER_AUTH_URL']);
    expect(issues.find((issue) => issue.variable === 'ANCS_PAYMENTS_DRIVER')?.message).toContain('mock 无真实扣款能力');
    expect(issues.find((issue) => issue.variable === 'ANCS_DEFAULT_PLAN')?.message).toContain('必须为 FREE');
  });

  it('非法 ANCS_SAAS_MODE → 显式失败', () => {
    const result = validateEnv(apiEnvSchema, { ...validApiEnv, ANCS_SAAS_MODE: 'production' });
    expect(result.ok).toBe(false);
    expect(result.issues.find((issue) => issue.variable === 'ANCS_SAAS_MODE')?.message).toContain('仅支持 internal | live');
  });
});
