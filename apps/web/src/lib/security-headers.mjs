/**
 * Web 安全头（V5-M4 Edge；代码审查 0010 遗留"Web CSP 头"）。由 next.config.mjs 的 headers() 使用。
 *
 * - 禁止被嵌入（frame-ancestors 'none' + X-Frame-Options）、禁止插件、限制 base/form 目标；
 * - 资源默认只来自本源；签名 URL 直达的存储/API 来源经 ANCS_CSP_EXTRA_ORIGINS 显式放行（媒体、上传）；
 * - 脚本暂需 'unsafe-inline'（外观引导脚本与 Next 内联数据脚本）；改为 nonce 需中间件逐请求生成，属后续工作；
 *   开发模式另需 'unsafe-eval' 与 ws:（热更新）；
 * - 麦克风只允许本源（语音会话），摄像头/定位/支付关闭。
 *
 * @param {{ production: boolean; extraOrigins: readonly string[] }} options
 * @returns {{ key: string; value: string }[]}
 */
export function securityHeaders(options) {
  const extra = options.extraOrigins.join(' ');
  const withExtra = (base) => (extra === '' ? base : `${base} ${extra}`);
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${options.production ? '' : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline'",
    withExtra("img-src 'self' data: blob:"),
    withExtra("media-src 'self' data: blob:"),
    "font-src 'self' data:",
    withExtra(`connect-src 'self'${options.production ? '' : ' ws: wss:'}`),
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  const headers = [
    { key: 'Content-Security-Policy', value: directives.join('; ') },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: 'microphone=(self), camera=(), geolocation=(), payment=()' },
  ];
  if (options.production) headers.push({ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' });
  return headers;
}

/**
 * 解析额外放行来源（逗号分隔的完整 origin）；非法项直接抛错——错误配置在构建/启动时暴露。
 * @param {string | undefined} raw
 * @returns {string[]}
 */
export function parseExtraOrigins(raw) {
  if (raw === undefined || raw.trim() === '') return [];
  return raw.split(',').map((item) => item.trim()).filter((item) => item !== '').map((item) => {
    const url = new URL(item);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== item.replace(/\/+$/, '')) {
      throw new Error(`ANCS_CSP_EXTRA_ORIGINS 项必须是完整 origin：${item}`);
    }
    return url.origin;
  });
}
