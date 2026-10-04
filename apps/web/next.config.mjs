/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // 业务 API 独立于 Next.js（规范 §29.2）：Web 只作为客户端，经 @ancs/sdk 访问
  transpilePackages: ['@ancs/sdk', '@ancs/contracts', '@ancs/scene-components'],
};

export default nextConfig;
