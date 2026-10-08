import { describe, expect, it } from 'vitest';
import { apiEnvSchema, crossCheckApiEnv } from './env.js';
import { opsSessionSchema } from './ops-auth.js';
import { signInResponseSchema } from './auth.js';

const env = (overrides: Record<string, string> = {}) => apiEnvSchema.parse({
  DATABASE_URL: 'postgres://localhost/test', BETTER_AUTH_SECRET: 'test-secret-0123456789', ...overrides, // secrets:check-ignore：测试专用假密钥
});

describe('N15-02 运营认证契约', () => {
  it('MFA 登录挑战与普通登录响应均有明确形状', () => {
    expect(signInResponseSchema.parse({ twoFactorRequired: true, methods: ['totp'] })).toEqual({ twoFactorRequired: true, methods: ['totp'] });
    expect(signInResponseSchema.safeParse({ twoFactorRequired: true, methods: ['sms'] }).success).toBe(false);
    expect(signInResponseSchema.safeParse({ twoFactorRequired: true, methods: [] }).success).toBe(false);
  });

  it('运营 DTO 不回传 secret/token，角色与环境严格枚举', () => {
    const parsed = opsSessionSchema.parse({
      id: 'opses_1', principalId: 'oppr_1', environment: 'TEST', roles: ['SECURITY_ADMIN'],
      createdAt: '2026-10-08T00:00:00.000Z', idleExpiresAt: '2026-10-08T00:15:00.000Z',
      absoluteExpiresAt: '2026-10-08T08:00:00.000Z', reauthenticatedAt: '2026-10-08T00:00:00.000Z',
      securityNotice: null, secret: 'must-not-appear', token: 'must-not-appear',
    });
    expect('secret' in parsed).toBe(false);
    expect('token' in parsed).toBe(false);
    expect(opsSessionSchema.safeParse({ ...parsed, environment: 'LOCAL' }).success).toBe(false);
    expect(opsSessionSchema.safeParse({ ...parsed, roles: ['SUPER_ADMIN'] }).success).toBe(false);
  });

  it('生产与非生产运营环境配置不互认', () => {
    expect(crossCheckApiEnv(env({ NODE_ENV: 'production' })).some((issue) => issue.variable === 'ANCS_OPS_ENVIRONMENT')).toBe(true);
    expect(crossCheckApiEnv(env({ NODE_ENV: 'development', ANCS_OPS_ENVIRONMENT: 'PRODUCTION' })).some((issue) => issue.variable === 'ANCS_OPS_ENVIRONMENT')).toBe(true);
    expect(crossCheckApiEnv(env({ NODE_ENV: 'production', ANCS_OPS_ENVIRONMENT: 'PRODUCTION' })).some((issue) => issue.variable === 'ANCS_OPS_ENVIRONMENT')).toBe(false);
  });
});
