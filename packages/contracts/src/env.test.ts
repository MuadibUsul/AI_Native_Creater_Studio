import { describe, expect, it } from 'vitest';
import { apiEnvSchema, crossCheckApiEnv, crossCheckWorkerEnv, formatEnvFailure, originOf, resolveAllowedOrigins, validateEnv, workerEnvSchema } from './env.js';

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

  it('V6-5/V6-7/V6-8 Fish Audio、HeyGen 与视频生成：缺密钥/缺声音/缺报价依据 → 启动失败；报价依据只接受真实实现', () => {
    const fish = validateEnv(workerEnvSchema, { ...validApiEnv, ANCS_NARRATION_DRIVER: 'fish' });
    expect(crossCheckWorkerEnv(fish.value!).map((issue) => issue.variable)).toEqual(['FISH_AUDIO_API_KEY', 'ANCS_NARRATION_VOICES_JSON']);
    const voices = JSON.stringify([{ id: 'abc123', name: 'Mine', languages: ['zh', 'en'], description: 'cloned' }]);
    const fishReady = validateEnv(workerEnvSchema, { ...validApiEnv, ANCS_NARRATION_DRIVER: 'fish', FISH_AUDIO_API_KEY: 'f'.repeat(32), ANCS_NARRATION_VOICES_JSON: voices }); // secrets:check-ignore：测试假值
    expect(crossCheckWorkerEnv(fishReady.value!)).toEqual([]);
    const heygen = validateEnv(workerEnvSchema, { ...validApiEnv, ANCS_AVATAR_DRIVER: 'heygen' });
    expect(crossCheckWorkerEnv(heygen.value!).map((issue) => issue.variable)).toEqual(['HEYGEN_API_KEY', 'FISH_AUDIO_API_KEY']);
    const offer = { kind: 'AVATAR_CLIP', providerId: 'heygen', implementation: 'REAL', model: 'm', perSecondMicros: { min: 1, max: 2 }, maxSeconds: 20 };
    expect(validateEnv(workerEnvSchema, { ...validApiEnv, ANCS_AVATAR_OFFER_JSON: JSON.stringify(offer) }).ok).toBe(true);
    expect(validateEnv(workerEnvSchema, { ...validApiEnv, ANCS_AVATAR_OFFER_JSON: JSON.stringify({ ...offer, implementation: 'SCRIPTED' }) }).ok).toBe(false);
    expect(validateEnv(workerEnvSchema, { ...validApiEnv, ANCS_AVATAR_OFFER_JSON: JSON.stringify({ ...offer, kind: 'VIDEO_SHOT' }) }).ok).toBe(false);
    const video = validateEnv(workerEnvSchema, { ...validApiEnv, ANCS_GENERATION_DRIVER: 'process' });
    expect(crossCheckWorkerEnv(video.value!).map((issue) => issue.variable)).toEqual(['ANCS_GENERATION_EXECUTABLE', 'ANCS_GENERATION_OFFERS_JSON']);
    expect(validateEnv(workerEnvSchema, { ...validApiEnv, ANCS_GENERATION_OFFERS_JSON: JSON.stringify([{ ...offer, kind: 'VIDEO_SHOT', implementation: 'SCRIPTED' }]) }).ok).toBe(false);
    expect(validateEnv(workerEnvSchema, { ...validApiEnv, ANCS_GENERATION_PASS_ENV: 'VENDOR_KEY, OTHER_KEY' }).ok).toBe(true);
    expect(validateEnv(workerEnvSchema, { ...validApiEnv, ANCS_GENERATION_PASS_ENV: 'bad name' }).ok).toBe(false);
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

  it('V6 导演模型驱动显式选择：anthropic 缺密钥 → 启动失败；未知驱动拒绝；不配置则不装配（不回退 Mock）', () => {
    const missing = validateEnv(workerEnvSchema, { ...validApiEnv, ANCS_AGENT_DRIVER: 'anthropic' });
    expect(crossCheckWorkerEnv(missing.value!).map((issue) => issue.variable)).toEqual(['ANTHROPIC_API_KEY']);
    const keyed = validateEnv(workerEnvSchema, { ...validApiEnv, ANCS_AGENT_DRIVER: 'anthropic', ANTHROPIC_API_KEY: 'a'.repeat(40), ANCS_AGENT_MODEL: 'claude-opus-5-5' }); // secrets:check-ignore：测试假值
    expect(crossCheckWorkerEnv(keyed.value!)).toEqual([]);
    expect(validateEnv(workerEnvSchema, { ...validApiEnv, ANCS_AGENT_DRIVER: 'mock' }).ok).toBe(false);
    expect(validateEnv(workerEnvSchema, validApiEnv).value?.ANCS_AGENT_DRIVER).toBeUndefined();
    const vision = validateEnv(workerEnvSchema, { ...validApiEnv, ANCS_VISUAL_ANALYSIS_DRIVER: 'anthropic' });
    expect(crossCheckWorkerEnv(vision.value!).map((issue) => issue.variable)).toEqual(['ANTHROPIC_API_KEY']);
    const processVision = validateEnv(workerEnvSchema, { ...validApiEnv, ANCS_VISUAL_ANALYSIS_DRIVER: 'process' });
    expect(crossCheckWorkerEnv(processVision.value!).map((issue) => issue.variable)).toEqual(['ANCS_VISUAL_ANALYSIS_EXECUTABLE']);
  });

  it('Gemini：导演 / 视觉 / 讲述选 gemini 缺 GEMINI_API_KEY → 启动失败（逐项说明）；Veo 报价依据必须带时长档位且不超过单次上限', () => {
    const missing = validateEnv(workerEnvSchema, { ...validApiEnv, ANCS_AGENT_DRIVER: 'gemini', ANCS_VISUAL_ANALYSIS_DRIVER: 'gemini', ANCS_NARRATION_DRIVER: 'gemini' });
    const issues = crossCheckWorkerEnv(missing.value!);
    expect(issues.map((issue) => issue.variable)).toEqual(['GEMINI_API_KEY', 'GEMINI_API_KEY', 'GEMINI_API_KEY']);
    expect(issues.map((issue) => issue.message.split('=')[0])).toEqual(['ANCS_AGENT_DRIVER', 'ANCS_VISUAL_ANALYSIS_DRIVER', 'ANCS_NARRATION_DRIVER']);
    const keyed = validateEnv(workerEnvSchema, { ...validApiEnv, ANCS_AGENT_DRIVER: 'gemini', ANCS_VISUAL_ANALYSIS_DRIVER: 'gemini', ANCS_NARRATION_DRIVER: 'gemini', GEMINI_API_KEY: 'g'.repeat(39), ANCS_AGENT_MODEL: 'gemini-flash-latest' }); // secrets:check-ignore：测试假值
    expect(crossCheckWorkerEnv(keyed.value!)).toEqual([]);

    const veo = { kind: 'VIDEO_SHOT', providerId: 'veo', implementation: 'REAL', model: 'veo-3.1-fast-generate-preview', perSecondMicros: { min: 150_000, max: 150_000 }, maxSeconds: 8, durationOptions: [4, 6, 8] };
    const veoOnly = validateEnv(workerEnvSchema, { ...validApiEnv, ANCS_VEO_OFFER_JSON: JSON.stringify(veo) });
    expect(veoOnly.ok).toBe(true);
    expect(crossCheckWorkerEnv(veoOnly.value!).map((issue) => issue.variable)).toEqual(['GEMINI_API_KEY']);
    const { durationOptions: _options, ...withoutOptions } = veo;
    for (const bad of [withoutOptions, { ...veo, durationOptions: [4, 6, 10] }, { ...veo, kind: 'VIDEO_REGION' }, { ...veo, implementation: 'SCRIPTED' }]) {
      expect(validateEnv(workerEnvSchema, { ...validApiEnv, ANCS_VEO_OFFER_JSON: JSON.stringify(bad) }).ok).toBe(false);
    }
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

describe('V5-M4 Edge 配置', () => {
  it('允许来源：显式配置优先（逐项必须是完整 origin）；缺省为 BETTER_AUTH_URL 的 origin，非生产另加本地 Web 端口', () => {
    expect(validateEnv(apiEnvSchema, { ...validApiEnv, ANCS_ALLOWED_ORIGINS: 'https://app.example.com/path' }).issues.map((issue) => issue.variable)).toEqual(['ANCS_ALLOWED_ORIGINS']);
    const explicit = validateEnv(apiEnvSchema, { ...validApiEnv, ANCS_ALLOWED_ORIGINS: 'https://app.example.com, https://studio.example.com' }).value!;
    expect(resolveAllowedOrigins(explicit)).toEqual(['https://app.example.com', 'https://studio.example.com']);
    const production = validateEnv(apiEnvSchema, { ...validApiEnv, NODE_ENV: 'production', BETTER_AUTH_URL: 'https://api.example.com/base' }).value!;
    expect(resolveAllowedOrigins(production)).toEqual(['https://api.example.com']);
    const development = validateEnv(apiEnvSchema, validApiEnv).value!;
    expect(resolveAllowedOrigins(development)).toEqual(['http://localhost:3001', 'http://localhost:3000', 'http://127.0.0.1:3000']);
  });

  it('originOf：小写、省略默认端口、去掉路径；非 http(s) 为 null（平台中立，不依赖全局 URL）', () => {
    expect(originOf('HTTPS://App.Example.com:443/path?q=1')).toBe('https://app.example.com');
    expect(originOf('http://localhost:80')).toBe('http://localhost');
    expect(originOf('http://127.0.0.1:3000/')).toBe('http://127.0.0.1:3000');
    expect(originOf('http://[::1]:3000')).toBe('http://[::1]:3000');
    expect(originOf('javascript:alert(1)')).toBeNull();
    expect(originOf('ftp://example.com')).toBeNull();
    expect(originOf('https://exa mple.com')).toBeNull();
  });

  it('生产不得关闭限流；可信代理跳数有上界', () => {
    const off = validateEnv(apiEnvSchema, { ...validApiEnv, NODE_ENV: 'production', ANCS_RATE_LIMIT: 'off' }).value!;
    expect(crossCheckApiEnv(off).map((issue) => issue.variable)).toContain('ANCS_RATE_LIMIT');
    expect(validateEnv(apiEnvSchema, { ...validApiEnv, ANCS_TRUST_PROXY_HOPS: '9' }).ok).toBe(false);
    expect(validateEnv(apiEnvSchema, validApiEnv).value?.ANCS_TRUST_PROXY_HOPS).toBe(0);
  });
});

