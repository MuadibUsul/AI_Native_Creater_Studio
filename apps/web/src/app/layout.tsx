import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import './globals.css';
import './quiet-frame.css';
import './ui-tokens.css';
import { Providers } from '@/app/providers';
import { StudioShell } from '@/ui/StudioShell';

export const metadata: Metadata = {
  title: 'Creator Studio · ANCS',
  description: '支持素材剪辑、生成与混合制作的视频创作工作台',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <a className="skiplink" href="#main">跳到主要内容</a>
        <Providers>
          <StudioShell>{children}</StudioShell>
        </Providers>
      </body>
    </html>
  );
}
