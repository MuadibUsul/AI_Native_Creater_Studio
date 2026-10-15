import type { ReactNode } from 'react';
import type { Metadata, Viewport } from 'next';
import { cookies, headers } from 'next/headers';
import { userAppearancePreferenceSchema } from '@ancs/contracts';
import './globals.css';
import './quiet-frame.css';
import './ui-tokens.css';
import { Providers } from '@/app/providers';
import { StudioShell } from '@/ui/StudioShell';
import { APPEARANCE_COOKIE, initialAppearance, type AppearanceMode } from '@/lib/appearance';
import { LOCALE_COOKIE, negotiateLocale, parseLocale, type Locale } from '@/i18n/locale';
import { MESSAGES } from '@/i18n/messages';

const baseMetadata: Metadata = {
  title: 'Creator Studio · ANCS',
  // V6-4：手机网页审片可添加到主屏幕（manifest 由 app/manifest.ts 生成）
  appleWebApp: { capable: true, title: 'ANCS', statusBarStyle: 'black-translucent' },
  icons: { icon: '/icons/icon-192.png', apple: '/icons/apple-touch-icon.png' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#0A0A0A',
};

// Runs before visible body content. No cookie or storage data is interpolated into this script.
const appearanceBootScript = "(()=>{try{const b=document.body;const m=b.dataset.appearanceMode;const d=m==='dark'||(m==='system'&&window.matchMedia?.('(prefers-color-scheme: dark)').matches);b.classList.toggle('theme-dark',!!d)}catch{}})();";

async function serverAppearance(): Promise<AppearanceMode> {
  const cookieValue = (await cookies()).get(APPEARANCE_COOKIE)?.value;
  try {
    const requestCookies = (await headers()).get('cookie');
    if (!requestCookies) return 'system';
    const apiOrigin = (process.env['ANCS_API_INTERNAL_URL'] ?? 'http://localhost:3001').replace(/\/+$/, '');
    const response = await fetch(`${apiOrigin}/api/v1/users/me/appearance`, {
      headers: { cookie: requestCookies }, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return 'system';
    const preference = userAppearancePreferenceSchema.safeParse(await response.json());
    return initialAppearance(cookieValue, preference.success ? preference.data : null);
  } catch {
    return 'system';
  }
}

/** 首屏语言：本设备明确选择 → 浏览器语言（界面精修第四阶段起全部页面双语，<html lang> 随之一致）。 */
async function serverLocale(): Promise<Locale> {
  return parseLocale((await cookies()).get(LOCALE_COOKIE)?.value) ?? negotiateLocale((await headers()).get('accept-language'));
}

export async function generateMetadata(): Promise<Metadata> {
  return { ...baseMetadata, description: MESSAGES[await serverLocale()].common.appDescription };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const mode = await serverAppearance();
  const locale = await serverLocale();
  return (
    <html lang={locale}>
      <body data-appearance-mode={mode} className={mode === 'dark' ? 'theme-dark' : undefined} suppressHydrationWarning>
        <script dangerouslySetInnerHTML={{ __html: appearanceBootScript }} />
        <a className="skiplink" href="#main">{MESSAGES[locale].common.skipToMain}</a>
        <Providers locale={locale}>
          <StudioShell>{children}</StudioShell>
        </Providers>
      </body>
    </html>
  );
}
