import { describe, expect, it } from 'vitest';
import { requestNeverSent } from './paid-generation.js';

/** 付费生成：判断网络错误是否确定发生在请求发出之前（决定"不扣费"还是"结果不明"）。 */
describe('requestNeverSent', () => {
  it('出网代理拒绝建立隧道（真实环境里 Node fetch 的错误形状）= 没发出去', () => {
    // 2026-10-14 在 Claude 云端对被网络白名单拦下的域名实测得到的错误链
    const proxyBlocked = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('Request was cancelled.'), { code: 0, cause: Object.assign(new Error('Proxy response (403) !== 200 when HTTP Tunneling'), { code: 'UND_ERR_ABORTED' }) }),
    });
    expect(requestNeverSent(proxyBlocked)).toBe(true);
  });

  it('DNS 失败、拒绝连接、网络不可达、证书错误 = 没发出去', () => {
    for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID']) {
      expect(requestNeverSent(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) }))).toBe(true);
    }
  });

  it('连接中途断开、超时、其他错误 = 可能已送达（不能当作没发出去）', () => {
    for (const code of ['ECONNRESET', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'EPIPE']) {
      expect(requestNeverSent(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) }))).toBe(false);
    }
    expect(requestNeverSent(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }))).toBe(false);
    expect(requestNeverSent(null)).toBe(false);
    expect(requestNeverSent('ENOTFOUND')).toBe(false);
  });
});
