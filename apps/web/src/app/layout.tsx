import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import './globals.css';
import { Providers } from '@/app/providers';

export const metadata: Metadata = {
  title: 'ANCS Creator Studio',
  description: 'Article → Professional Long Video（V1）',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen bg-[#05070c] text-slate-100">
        <Providers>
          <div className="mx-auto max-w-6xl px-6 py-8">{children}</div>
        </Providers>
      </body>
    </html>
  );
}
