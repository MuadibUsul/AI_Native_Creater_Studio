import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';
import { sessionInfoSchema } from '@ancs/contracts';
import './globals.css';
import './quiet-frame.css';
import './ui-tokens.css';
import { Providers } from '@/app/providers';
import { StudioShell } from '@/ui/StudioShell';
import { APPEARANCE_COOKIE, initialAppearance, parseAppearanceCookie, type AppearanceMode } from '@/lib/appearance';

export const metadata: Metadata = {
  title: 'Creator Studio · ANCS',
  description: '支持素材剪辑、生成与混合制作的视频创作工作台',
};

// Runs before visible body content. No cookie or storage data is interpolated into this script.
const appearanceBootScript = "(()=>{try{const b=document.body;const m=b.dataset.appearanceMode;const d=m==='dark'||(m==='system'&&window.matchMedia?.('(prefers-color-scheme: dark)').matches);b.classList.toggle('theme-dark',!!d)}catch{}})();";

async function serverAppearance(): Promise<AppearanceMode> {
  const cookieValue = (await cookies()).get(APPEARANCE_COOKIE)?.value;
  if (!parseAppearanceCookie(cookieValue)) return 'system';
  try {
    const requestCookies = (await headers()).get('cookie');
    if (!requestCookies) return 'system';
    const apiOrigin = (process.env['ANCS_API_INTERNAL_URL'] ?? 'http://localhost:3001').replace(/\/+$/, '');
    const response = await fetch(`${apiOrigin}/api/v1/auth/session`, {
      headers: { cookie: requestCookies }, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return 'system';
    const session = sessionInfoSchema.safeParse(await response.json());
    return initialAppearance(cookieValue, session.success ? session.data.user.id : null);
  } catch {
    return 'system';
  }
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const mode = await serverAppearance();
  return (
    <html lang="zh-CN">
      <body data-appearance-mode={mode} className={mode === 'dark' ? 'theme-dark' : undefined} suppressHydrationWarning>
        <script dangerouslySetInnerHTML={{ __html: appearanceBootScript }} />
        <a className="skiplink" href="#main">跳到主要内容</a>
        <Providers>
          <StudioShell>{children}</StudioShell>
        </Providers>
      </body>
    </html>
  );
}
