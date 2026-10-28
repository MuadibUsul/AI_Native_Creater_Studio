'use client';

import { SYSTEM_TEXT } from '@/i18n/pages/system';

/**
 * 根布局本身出错时的兜底页（替换整个 <html>，拿不到语言与外观设置）：中英两种语言并列，
 * 颜色跟随系统浅深色。只给重试，不展示错误详情。
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const zh = SYSTEM_TEXT['zh-CN'].error;
  const en = SYSTEM_TEXT.en.error;
  return <html lang="zh-CN">
    <body style={{ margin: 0, minHeight: '100vh', display: 'grid', placeItems: 'center', fontFamily: 'system-ui, -apple-system, "PingFang SC", "Noto Sans CJK SC", sans-serif' }}>
      <style>{':root{color-scheme:light dark}body{background:Canvas;color:CanvasText}button{font:inherit;padding:10px 18px;border-radius:999px;border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer}'}</style>
      <main role="alert" style={{ maxWidth: 520, padding: 24, textAlign: 'center', lineHeight: 1.7 }}>
        <h1 style={{ fontSize: 22, margin: 0 }}>{zh.title}</h1>
        <p>{zh.body}</p>
        <h2 lang="en" style={{ fontSize: 18, margin: '24px 0 0' }}>{en.title}</h2>
        <p lang="en">{en.body}</p>
        <button type="button" onClick={reset}>{zh.retry} · <span lang="en">{en.retry}</span></button>
        {error.digest !== undefined ? <p style={{ fontSize: 12, opacity: 0.7 }}>{zh.reference(error.digest)}</p> : null}
      </main>
    </body>
  </html>;
}
