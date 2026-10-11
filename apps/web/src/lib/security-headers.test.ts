import { describe, expect, it } from 'vitest';
import { parseExtraOrigins, securityHeaders } from './security-headers.mjs';

/** V5-M4：Web 安全头（next.config.mjs headers() 的唯一来源）。 */
describe('securityHeaders', () => {
  const csp = (headers: { key: string; value: string }[]) => headers.find((header) => header.key === 'Content-Security-Policy')!.value;

  it('生产：禁止嵌入/插件、无 unsafe-eval、HSTS；额外来源只进入媒体/图片/连接', () => {
    const headers = securityHeaders({ production: true, extraOrigins: ['https://media.example.com'] });
    const policy = csp(headers);
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).not.toContain('unsafe-eval');
    expect(policy).toContain("media-src 'self' data: blob: https://media.example.com");
    expect(policy).toContain("connect-src 'self' https://media.example.com");
    expect(policy).not.toMatch(/script-src[^;]*media\.example\.com/);
    expect(headers.map((header) => header.key)).toEqual(expect.arrayContaining(['X-Frame-Options', 'X-Content-Type-Options', 'Permissions-Policy', 'Strict-Transport-Security']));
    expect(headers.find((header) => header.key === 'Permissions-Policy')!.value).toContain('microphone=(self)');
  });

  it('开发：允许热更新所需的 unsafe-eval 与 ws:，无 HSTS', () => {
    const headers = securityHeaders({ production: false, extraOrigins: [] });
    expect(csp(headers)).toContain("'unsafe-eval'");
    expect(csp(headers)).toContain('ws:');
    expect(headers.some((header) => header.key === 'Strict-Transport-Security')).toBe(false);
  });

  it('额外来源必须是完整 origin', () => {
    expect(parseExtraOrigins(' https://a.example.com , http://localhost:3001 ')).toEqual(['https://a.example.com', 'http://localhost:3001']);
    expect(parseExtraOrigins(undefined)).toEqual([]);
    expect(() => parseExtraOrigins('https://a.example.com/path')).toThrow('完整 origin');
    expect(() => parseExtraOrigins('javascript:alert(1)')).toThrow();
  });
});
