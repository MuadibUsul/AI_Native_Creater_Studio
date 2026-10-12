import type { ReactNode } from 'react';
import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';
import { userAppearancePreferenceSchema } from '@ancs/contracts';
import './globals.css';
import './quiet-frame.css';
import './ui-tokens.css';
import { Providers } from '@/app/providers';
import { StudioShell } from '@/ui/StudioShell';
import { APPEARANCE_COOKIE, initialAppearance, type AppearanceMode } from '@/lib/appearance';
import { LOCALE_COOKIE, negotiateLocale, parseLocale, type Locale } from '@/i18n/locale';

export const metadata: Metadata = {
  title: 'Creator Studio · ANCS',
  description: '支持素材剪辑、生成与混合制作的视频创作工作台',
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

/** 双语界面的首屏语言：本设备明确选择 → 浏览器语言。旧页面仍是中文，所以 <html lang> 只跟随明确选择，双语区域自行标注 lang。 */
async function serverLocale(): Promise<{ locale: Locale; explicit: boolean }> {
  const chosen = parseLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  return chosen === null ? { locale: negotiateLocale((await headers()).get('accept-language')), explicit: false } : { locale: chosen, explicit: true };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const mode = await serverAppearance();
  const { locale, explicit } = await serverLocale();
  return (
    <html lang={explicit ? locale : 'zh-CN'}>
      <body data-appearance-mode={mode} className={mode === 'dark' ? 'theme-dark' : undefined} suppressHydrationWarning>
        <script dangerouslySetInnerHTML={{ __html: appearanceBootScript }} />
        <a className="skiplink" href="#main">跳到主要内容</a>
        <Providers locale={locale}>
          <StudioShell>{children}</StudioShell>
        </Providers>
      </body>
    </html>
  );
}
