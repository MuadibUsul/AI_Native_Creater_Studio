import type { MetadataRoute } from 'next';
import { BRAND_NAME } from '@/brand/brand';

/**
 * V6-4：手机网页审片可以"添加到主屏幕"（PWA）。只提供安装信息，不做离线缓存——
 * 审片读写的都是服务端的当前状态，缓存旧页面只会让人看错版本。
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: BRAND_NAME,
    short_name: BRAND_NAME,
    description: 'The video editor that listens: talk to it, point at the picture, and it cuts.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#0A0A0A',
    theme_color: '#0A0A0A',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
