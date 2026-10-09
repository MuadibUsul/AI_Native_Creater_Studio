import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import type { OpsAuthDeps } from '@ancs/auth';
import { clearOpsCookieHeader, opsCookieHeader, readOpsCookie } from './plugins/admin.js';

const request = (cookie: string): FastifyRequest => ({ headers: { cookie } }) as FastifyRequest;
const deps = (environment: OpsAuthDeps['environment']): OpsAuthDeps => ({
  db: null as unknown as OpsAuthDeps['db'],
  environment,
  fingerprintKey: 'unused-test-key', // secrets:check-ignore：测试专用假密钥
  policy: { idleSeconds: 900, absoluteSeconds: 28800, reauthSeconds: 300 },
});

describe('N15-02 ops cookie 安全边界', () => {
  const token = 'A'.repeat(43);
  it('只接受单个固定格式的运营 cookie', () => {
    expect(readOpsCookie(request(`ordinary=x; ancs_ops_session=${token}`))).toBe(token);
    expect(readOpsCookie(request(`ancs_ops_session=${token}; ancs_ops_session=${token}`))).toBeNull();
    expect(readOpsCookie(request('ancs_ops_session=short'))).toBeNull();
    expect(readOpsCookie(request('ordinary=x'))).toBeNull();
  });

  it('运营 cookie HttpOnly/Strict，生产与预发必须 Secure，撤销精确清空', () => {
    const production = opsCookieHeader(token, deps('PRODUCTION'));
    expect(production).toContain('HttpOnly; SameSite=Strict');
    expect(production).toContain('Secure');
    expect(production).toContain('Path=/api/v1');
    expect(opsCookieHeader(token, deps('STAGING'))).toContain('Secure');
    expect(opsCookieHeader(token, deps('TEST'))).not.toContain('Secure');
    expect(clearOpsCookieHeader(deps('PRODUCTION'))).toContain('Max-Age=0; Secure');
  });
});
