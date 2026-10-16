import { parseExtraOrigins, securityHeaders } from './src/lib/security-headers.mjs';

const production = process.env.NODE_ENV === 'production';
// 签名 URL 直达的存储/API 来源（媒体播放与直传上传）；开发默认放行本地 API 端口
const extraOrigins = process.env.ANCS_CSP_EXTRA_ORIGINS !== undefined
  ? parseExtraOrigins(process.env.ANCS_CSP_EXTRA_ORIGINS)
  : production ? [] : ['http://localhost:3001', 'http://127.0.0.1:3001'];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // V5-M4 Edge：Web 安全头（CSP、frame-ancestors、nosniff、Permissions-Policy；生产 HSTS）
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders({ production, extraOrigins }) }];
  },
  // The API remains a separate service. Browser traffic uses the Web origin so
  // session cookies and preflight behavior are consistent in local development.
  async rewrites() {
    const apiOrigin = (process.env.ANCS_API_INTERNAL_URL ?? 'http://localhost:3001').replace(/\/+$/, '');
    return [{ source: '/api/v1/:path*', destination: `${apiOrigin}/api/v1/:path*` }];
  },
  transpilePackages: ['@ancs/sdk', '@ancs/contracts', '@ancs/time', '@ancs/scene-components'],
};

export default nextConfig;
