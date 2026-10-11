/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The API remains a separate service. Browser traffic uses the Web origin so
  // session cookies and preflight behavior are consistent in local development.
  async rewrites() {
    const apiOrigin = (process.env.ANCS_API_INTERNAL_URL ?? 'http://localhost:3001').replace(/\/+$/, '');
    return [{ source: '/api/v1/:path*', destination: `${apiOrigin}/api/v1/:path*` }];
  },
  transpilePackages: ['@ancs/sdk', '@ancs/contracts', '@ancs/time', '@ancs/scene-components'],
};

export default nextConfig;
