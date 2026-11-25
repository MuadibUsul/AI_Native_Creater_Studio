'use client';

import Link from 'next/link';
import { BRAND_NAME, BrandTile } from '@/brand/brand';
import { useI18n } from '@/i18n/I18nProvider';
import { desktopWindowsDownloadUrl } from '@/lib/desktop-bridge';
import { QuietIcon } from '@/ui/QuietIcon';
import '@/components/quiet-frame/workspace.css';

export default function DownloadDesktopPage() {
  const { messages, locale, setLocale } = useI18n();
  const t = messages.entry.download;
  const winUrl = desktopWindowsDownloadUrl();

  return (
    <main className="page qf-workspace-page" id="main" style={{ maxWidth: 960, margin: '0 auto', padding: '48px 24px' }}>
      <header className="row between" style={{ marginBottom: 40 }}>
        <Link href="/welcome" className="logo" style={{ textDecoration: 'none' }}>
          <span className="logomark" aria-hidden="true" style={{ background: 'none' }}><BrandTile size={32} /></span>
          <span className="logotext">{BRAND_NAME}</span>
        </Link>
        <div className="row gap8">
          <button type="button" className="btn small ghost" onClick={() => setLocale(locale === 'zh-CN' ? 'en' : 'zh-CN')}>
            <QuietIcon name="globe" />{messages.common.switchLanguage}
          </button>
          <Link href="/" className="btn small">{t.backHome}</Link>
        </div>
      </header>

      <section className="panel pad" style={{ padding: 32 }}>
        <div className="eyebrow mb16">{t.eyebrow}</div>
        <h1 style={{ fontSize: 32, lineHeight: 1.2, marginBottom: 12 }}>{t.title}</h1>
        <p className="muted" style={{ fontSize: 16, lineHeight: 1.6, maxWidth: 680 }}>{t.subtitle}</p>

        <div className="row gap8 mt24" style={{ flexWrap: 'wrap' }}>
          {winUrl !== null ? (
            <a href={winUrl} className="btn primary large" download>
              <QuietIcon name="download" />{t.winButton}
            </a>
          ) : (
            <button type="button" className="btn primary large" disabled aria-disabled="true">
              <QuietIcon name="download" />{t.winButton}
            </button>
          )}
          <Link href="/sign-in" className="btn large">
            <QuietIcon name="arrow" />{t.openWeb}
          </Link>
        </div>

        <p className="small muted mt16">{t.winMeta}</p>
        <p className="small muted mt8">{t.macMeta}</p>
        {winUrl === null ? (
          <p className="small mt16" role="status" style={{ padding: 12, borderRadius: 10, border: '1px solid var(--ui-border-subtle)' }}>
            {t.pendingNote}
          </p>
        ) : null}
      </section>

      <section className="mt32">
        <h2 style={{ fontSize: 20, marginBottom: 16 }}>{t.featuresTitle}</h2>
        <div className="status-board">
          {t.features.map((item) => (
            <div key={item.title} className="panel pad">
              <h3 style={{ fontSize: 16, marginBottom: 8 }}>{item.title}</h3>
              <p className="small muted">{item.body}</p>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
