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
    NODE_ENV: 'production',
    ANCS_OPS_ENVIRONMENT: 'PRODUCTION',
    // 生产必须显式配置凭据信封密钥（见 0010：不得与会话密钥共用一把）
    ANCS_CREDENTIAL_KEYS: `v1:${'A'.repeat(44)}`, // secrets:check-ignore：测试专用假密钥（非真实凭据）
    // 生产必须显式配置存储签名密钥（V5-M3：不得从会话密钥派生）
    ANCS_STORAGE_SECRET: 'S'.repeat(32), // secrets:check-ignore：测试专用假密钥（非真实凭据）
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

  it('live 缺条件 → 逐项明确（默认套餐非 FREE / mock 收款 / local 存储 / 非 https / 运营环境不匹配）', () => {
    const result = validateEnv(apiEnvSchema, { ...validApiEnv, ANCS_SAAS_MODE: 'live', ANCS_PAYMENTS_DRIVER: 'mock', ANCS_PAYMENTS_MOCK_SECRET: 'live-gate-mock-secret-0123' }); // secrets:check-ignore：测试专用假密钥
    expect(result.ok).toBe(true);
    const issues = crossCheckApiEnv(result.value as NonNullable<typeof result.value>);
    const variables = issues.map((issue) => issue.variable).sort();
    expect(variables).toEqual(['ANCS_DEFAULT_PLAN', 'ANCS_OPS_ENVIRONMENT', 'ANCS_PAYMENTS_DRIVER', 'ANCS_STORAGE_DRIVER', 'BETTER_AUTH_URL']);
    expect(issues.find((issue) => issue.variable === 'ANCS_PAYMENTS_DRIVER')?.message).toContain('mock 无真实扣款能力');
    expect(issues.find((issue) => issue.variable === 'ANCS_DEFAULT_PLAN')?.message).toContain('必须为 FREE');
  });

  it('生产环境缺 ANCS_CREDENTIAL_KEYS → 跨字段显式报错（不得从会话密钥派生）', () => {
    const result = validateEnv(apiEnvSchema, { ...validApiEnv, NODE_ENV: 'production', ANCS_OPS_ENVIRONMENT: 'PRODUCTION' });
    expect(result.ok).toBe(true);
    const issues = crossCheckApiEnv(result.value as NonNullable<typeof result.value>);
    expect(issues.map((issue) => issue.variable)).toContain('ANCS_CREDENTIAL_KEYS');
  });

  it('非法 ANCS_SAAS_MODE → 显式失败', () => {
    const result = validateEnv(apiEnvSchema, { ...validApiEnv, ANCS_SAAS_MODE: 'production' });
    expect(result.ok).toBe(false);
    expect(result.issues.find((issue) => issue.variable === 'ANCS_SAAS_MODE')?.message).toContain('仅支持 internal | live');
  });
});

describe('V5-M3 配置统一：生产密钥分层、旧变量名、Worker 数值', () => {
  const secret = 'S'.repeat(32); // secrets:check-ignore：测试专用假密钥（非真实凭据）

  it('生产 API/Worker 未显式配置存储签名密钥 → 启动失败；配置后通过', () => {
    const api = validateEnv(apiEnvSchema, { ...validApiEnv, NODE_ENV: 'production', ANCS_OPS_ENVIRONMENT: 'PRODUCTION', ANCS_CREDENTIAL_KEYS: `v1:${'A'.repeat(44)}` });
    expect(crossCheckApiEnv(api.value!).map((issue) => issue.variable)).toEqual(['ANCS_STORAGE_SECRET']);
    const worker = validateEnv(workerEnvSchema, { ...validApiEnv, NODE_ENV: 'production' });
    expect(crossCheckWorkerEnv(worker.value!).map((issue) => issue.variable).sort()).toEqual(['ANCS_CREDENTIAL_KEYS', 'ANCS_STORAGE_SECRET']);
    const fixed = validateEnv(workerEnvSchema, { ...validApiEnv, NODE_ENV: 'production', ANCS_STORAGE_SECRET: secret, ANCS_CREDENTIAL_KEYS: `v1:${'A'.repeat(44)}` });
    expect(crossCheckWorkerEnv(fixed.value!)).toEqual([]);
  });

  it('旧变量名 PLATFORM_PROVIDER_KEYS 从未生效 → 启动失败并提示改名（不静默忽略凭据配置）', () => {
    const result = validateEnv(apiEnvSchema, { ...validApiEnv, PLATFORM_PROVIDER_KEYS: 'openai:sk-test' });
    expect(crossCheckApiEnv(result.value!).find((issue) => issue.variable === 'PLATFORM_PROVIDER_KEYS')?.message).toContain('ANCS_PLATFORM_PROVIDER_KEYS');
    const renamed = validateEnv(apiEnvSchema, { ...validApiEnv, ANCS_PLATFORM_PROVIDER_KEYS: 'openai:sk-test' });
    expect(crossCheckApiEnv(renamed.value!)).toEqual([]);
  });

  it('Worker 数值配置按上下界校验（非法值启动失败，不再变成 NaN 租约）；心跳必须短于租约', () => {
    const bad = validateEnv(workerEnvSchema, { ...validApiEnv, ANCS_WORKER_LEASE_SECONDS: 'abc', ANCS_WORKER_TICK_MS: '10' });
    expect(bad.issues.map((issue) => issue.variable).sort()).toEqual(['ANCS_WORKER_LEASE_SECONDS', 'ANCS_WORKER_TICK_MS']);
    const defaults = validateEnv(workerEnvSchema, validApiEnv);
    expect(defaults.value).toMatchObject({ ANCS_WORKER_TICK_MS: 1000, ANCS_WORKER_LEASE_SECONDS: 60 });
    const slowHeartbeat = validateEnv(workerEnvSchema, { ...validApiEnv, ANCS_WORKER_LEASE_SECONDS: '10', ANCS_WORKER_HEARTBEAT_MS: '10000' });
    expect(crossCheckWorkerEnv(slowHeartbeat.value!).map((issue) => issue.variable)).toEqual(['ANCS_WORKER_HEARTBEAT_MS']);
  });

  it('ASR 驱动显式选择：deepgram 缺密钥 / process 缺可执行文件 → 启动失败', () => {
    const deepgram = validateEnv(workerEnvSchema, { ...validApiEnv, ANCS_ASR_DRIVER: 'deepgram' });
    expect(crossCheckWorkerEnv(deepgram.value!).map((issue) => issue.variable)).toEqual(['DEEPGRAM_API_KEY']);
    const keyed = validateEnv(workerEnvSchema, { ...validApiEnv, ANCS_ASR_DRIVER: 'deepgram', DEEPGRAM_API_KEY: 'k'.repeat(40) }); // secrets:check-ignore：测试假值
    expect(crossCheckWorkerEnv(keyed.value!)).toEqual([]);
    const process = validateEnv(workerEnvSchema, { ...validApiEnv, ANCS_ASR_DRIVER: 'process' });
    expect(crossCheckWorkerEnv(process.value!).map((issue) => issue.variable)).toEqual(['ANCS_ASR_EXECUTABLE']);
    expect(validateEnv(workerEnvSchema, { ...validApiEnv, ANCS_ASR_DRIVER: 'whisper' }).ok).toBe(false);
  });

  it('空白值视为未配置：可选项回到缺省，必填项报告未配置（复制 .env.example 的空行不会启动失败）', () => {
    const blankOptional = validateEnv(apiEnvSchema, { ...validApiEnv, ANCS_VOICE_SESSION_SECRET: '', ANCS_STORAGE_SECRET: '  ', ANCS_PLATFORM_PROVIDER_KEYS: '' });
    expect(blankOptional.ok).toBe(true);
    expect(blankOptional.value?.ANCS_VOICE_SESSION_SECRET).toBeUndefined();
    const blankRequired = validateEnv(apiEnvSchema, { ...validApiEnv, DATABASE_URL: '' });
    expect(blankRequired.issues.map((issue) => issue.variable)).toEqual(['DATABASE_URL']);
  });

  it('语音会话签名密钥纳入 API 配置校验（过短即失败）', () => {
    expect(validateEnv(apiEnvSchema, { ...validApiEnv, ANCS_VOICE_SESSION_SECRET: 'short' }).issues.map((issue) => issue.variable)).toEqual(['ANCS_VOICE_SESSION_SECRET']);
    expect(validateEnv(apiEnvSchema, { ...validApiEnv, ANCS_VOICE_SESSION_SECRET: secret }).ok).toBe(true);
  });
});

