import { describe, expect, it } from 'vitest';
import { DEFAULT_RATE_LIMITS, TokenBuckets, classifyRequest } from './plugins/edge.js';
import { buildServer } from './server.js';

/** V5-M4 Edge 安全层：安全头、CORS 白名单与预检、带 Cookie 写请求的 Origin 校验、按类别 × IP 限流。 */

const APP = 'https://app.example.com';
const EVIL = 'https://evil.example.net';

describe('classifyRequest / TokenBuckets', () => {
  it('端点类别：认证写、付费/重计算写、普通写、读；健康检查、预检与 Provider 回调豁免', () => {
    expect(classifyRequest('POST', '/api/v1/auth/sign-in/email')).toBe('auth');
    expect(classifyRequest('POST', '/api/v1/workspaces/w/projects/p/narratives?x=1')).toBe('expensive');
    expect(classifyRequest('POST', '/api/v1/workspaces/w/voice-clones')).toBe('expensive');
    expect(classifyRequest('POST', '/api/v1/workspaces/w/projects/p/sequences/s/final-renders')).toBe('expensive');
    expect(classifyRequest('POST', '/api/v1/workspaces/w/agent-sessions/s/turns')).toBe('expensive');
    expect(classifyRequest('POST', '/api/v1/workspaces/w/agent-turns/t/cancel')).toBe('write');
    expect(classifyRequest('POST', '/api/v1/workspaces/w/projects/p/edits')).toBe('write');
    expect(classifyRequest('GET', '/api/v1/workspaces/w/projects')).toBe('read');
    expect(classifyRequest('GET', '/api/v1/health')).toBeNull();
    expect(classifyRequest('OPTIONS', '/api/v1/anything')).toBeNull();
    expect(classifyRequest('POST', '/api/v1/webhooks/runway')).toBeNull();
  });

  it('令牌桶：容量内放行，耗尽后给出 Retry-After，按时间补充', () => {
    const buckets = new TokenBuckets();
    const rule = { capacity: 2, perMinute: 60 };
    expect(buckets.take('k', rule, 0)).toEqual({ allowed: true });
    expect(buckets.take('k', rule, 0)).toEqual({ allowed: true });
    expect(buckets.take('k', rule, 0)).toEqual({ allowed: false, retryAfterSeconds: 1 });
    expect(buckets.take('k', rule, 1_000)).toEqual({ allowed: true });
    expect(buckets.take('other', rule, 0)).toEqual({ allowed: true });
  });

  it('默认规则：认证最严，读最宽', () => {
    expect(DEFAULT_RATE_LIMITS.auth.perMinute).toBeLessThan(DEFAULT_RATE_LIMITS.expensive.perMinute);
    expect(DEFAULT_RATE_LIMITS.write.perMinute).toBeLessThan(DEFAULT_RATE_LIMITS.read.perMinute);
  });
});

describe('Edge 中间件（Fastify inject）', () => {
  const tightLimits = { auth: { capacity: 1, perMinute: 1 }, expensive: { capacity: 1, perMinute: 1 }, write: { capacity: 5, perMinute: 5 }, read: { capacity: 2, perMinute: 60 } };

  it('安全头始终存在（未配置 Edge 时也有）；生产开启 HSTS', async () => {
    const bare = await buildServer();
    const response = await bare.inject({ method: 'GET', url: '/api/v1/health' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['strict-transport-security']).toBeUndefined();
    await bare.close();
    const production = await buildServer({ edge: { allowedOrigins: [APP], hsts: true } });
    expect((await production.inject({ method: 'GET', url: '/api/v1/health' })).headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
    await production.close();
  });

  it('CORS：只对白名单来源回显并应答预检；其他来源无 CORS 头、预检 403', async () => {
    const app = await buildServer({ edge: { allowedOrigins: [APP], rateLimits: false } });
    const allowed = await app.inject({ method: 'GET', url: '/api/v1/health', headers: { origin: APP } });
    expect(allowed.headers['access-control-allow-origin']).toBe(APP);
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');
    expect(allowed.headers['vary']).toContain('Origin');
    const denied = await app.inject({ method: 'GET', url: '/api/v1/health', headers: { origin: EVIL } });
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();

    const preflight = await app.inject({
      method: 'OPTIONS', url: '/api/v1/workspaces',
      headers: { origin: APP, 'access-control-request-method': 'POST', 'access-control-request-headers': 'Content-Type, Idempotency-Key, X-Evil' },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-headers']).toBe('content-type, idempotency-key');
    expect(preflight.headers['access-control-allow-methods']).toContain('POST');
    const evilPreflight = await app.inject({ method: 'OPTIONS', url: '/api/v1/workspaces', headers: { origin: EVIL, 'access-control-request-method': 'POST' } });
    expect(evilPreflight.statusCode).toBe(403);
    expect(evilPreflight.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });

  it('CSRF 纵深防御：带 Cookie 的写请求来自非白名单 Origin → 403；白名单、同源或无 Origin 不拦', async () => {
    const app = await buildServer({ edge: { allowedOrigins: [APP], rateLimits: false } });
    const evil = await app.inject({ method: 'POST', url: '/api/v1/workspaces', headers: { origin: EVIL, cookie: 'session=abc' }, payload: {} });
    expect(evil.statusCode).toBe(403);
    expect((evil.json() as { error: { details: { reason: string } } }).error.details.reason).toBe('ORIGIN_NOT_ALLOWED');
    for (const headers of [
      { origin: APP, cookie: 'session=abc' },
      { origin: 'http://localhost:80', cookie: 'session=abc', host: 'localhost:80' },
      { cookie: 'session=abc' },
      { origin: EVIL },
    ]) {
      const response = await app.inject({ method: 'POST', url: '/api/v1/workspaces', headers, payload: {} });
      expect(response.statusCode).not.toBe(403);
    }
    await app.close();
  });

  it('限流：同一 IP 同一类别超限 → 429 + Retry-After；时间推进后恢复；类别之间独立', async () => {
    let now = 0;
    const app = await buildServer({ edge: { allowedOrigins: [APP], rateLimits: tightLimits, now: () => now } });
    expect((await app.inject({ method: 'GET', url: '/api/v1/capabilities' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/capabilities' })).statusCode).toBe(200);
    const limited = await app.inject({ method: 'GET', url: '/api/v1/capabilities' });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('1');
    expect((limited.json() as { error: { code: string; details: { limitClass: string } } }).error).toMatchObject({ code: 'RATE_LIMITED', details: { limitClass: 'read' } });
    // 写类别有独立的桶
    expect((await app.inject({ method: 'POST', url: '/api/v1/workspaces', payload: {} })).statusCode).not.toBe(429);
    now += 1_000;
    expect((await app.inject({ method: 'GET', url: '/api/v1/capabilities' })).statusCode).toBe(200);
    // 健康检查豁免
    for (let index = 0; index < 5; index += 1) expect((await app.inject({ method: 'GET', url: '/api/v1/health' })).statusCode).toBe(200);
    await app.close();
  });

  it('客户端 IP：不信任代理时伪造 X-Forwarded-For 不能绕过限流；配置可信跳数后按真实客户端分桶', async () => {
    const untrusted = await buildServer({ edge: { allowedOrigins: [APP], rateLimits: tightLimits, now: () => 0 } });
    for (const forwarded of ['1.1.1.1', '2.2.2.2']) await untrusted.inject({ method: 'GET', url: '/api/v1/capabilities', headers: { 'x-forwarded-for': forwarded } });
    expect((await untrusted.inject({ method: 'GET', url: '/api/v1/capabilities', headers: { 'x-forwarded-for': '3.3.3.3' } })).statusCode).toBe(429);
    await untrusted.close();

    const trusted = await buildServer({ edge: { allowedOrigins: [APP], rateLimits: tightLimits, now: () => 0, trustProxyHops: 1 } });
    for (const forwarded of ['1.1.1.1', '2.2.2.2', '3.3.3.3']) {
      expect((await trusted.inject({ method: 'GET', url: '/api/v1/capabilities', headers: { 'x-forwarded-for': forwarded } })).statusCode).toBe(200);
    }
    await trusted.close();
  });
});
