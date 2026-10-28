'use client';

import Link from 'next/link';
import { BRAND_NAME, BrandTile } from '@/brand/brand';
import { useSession } from '@/lib/queries';
import { QuietIcon } from '@/ui/QuietIcon';
import { useI18n } from '@/i18n/I18nProvider';
import { DesignSystemControls, DesignSystemExampleActions, DesignSystemStatusAction } from './DesignSystemControls';
import styles from './public-entry.module.css';
import './workspace.css';

function Mark() {
  return <span className="logo"><span className="logomark" aria-hidden="true" style={{ background: 'none' }}><BrandTile size={32} /></span><span className="logotext">{BRAND_NAME}</span></span>;
}

function LandingCanvasPreview() {
  const t = useI18n().messages.entry.welcome;
  return <div data-testid="landing-canvas-preview" className={`viewer ${styles['canvasPreview']}`}>
    <span className={styles['previewEyebrow']}>{t.canvasEyebrow}</span>
    <div className={styles['canvasMessage']}><strong data-testid="landing-canvas-title">{t.canvasTitle}</strong><span>{t.canvasBody}</span></div>
    <span className={styles['previewFootnote']}>{t.canvasFootnote}</span>
  </div>;
}

export function WelcomePage() {
  const entryHref = useSession().data?.user ? '/' : '/sign-in';
  const t = useI18n().messages.entry.welcome;
  return <div className={`landing qf-landing ${styles['publicLanding']}`}>
    <header className="landing-nav"><Mark /><nav className="landing-links" aria-label={t.navAria}><Link href="/design-system">{t.designPrinciples}</Link><Link href={entryHref} title={t.extensionsTitle}>{t.extensions}</Link><Link href={entryHref} title={t.identityTitle}>{t.identity}</Link><Link href={entryHref} className="btn primary small"><QuietIcon name="arrow" />{t.enterStudio}</Link></nav></header>
    <main className="landing-hero" id="main"><div className="eyebrow">A STUDIO FOR YOUR THINKING.</div><h1>{t.heroLine1}<br /><span>{t.heroLine2}</span></h1><p>{t.heroBody1}<br />{t.heroBody2}</p>
      <div className="landing-buttons"><Link href={entryHref} className="btn primary large"><QuietIcon name="arrow" />{t.startFirst}</Link><Link href={entryHref} className="btn large" title={t.tryDirectorTitle}><QuietIcon name="play" />{t.tryDirector}</Link></div>
      <div className="row mt16 qf-landing-assurance"><QuietIcon name="shield" />{t.assurance}</div>
      <div className="landing-product" role="img" aria-label={t.productAria}><aside className="mini-side"><Mark /><div className={styles['miniNavigation']}><span>{t.miniNav.projects}</span><span>{t.miniNav.assets}</span><span>{t.miniNav.versions}</span></div></aside><section className="mini-content"><div className="row between qf-preview-head"><span>{t.previewHead}</span><span className="badge">{t.previewBadge}</span></div><LandingCanvasPreview /><div className="prompt-dock qf-preview-prompt"><QuietIcon name="spark" /><span className="small muted grow">{t.promptHint}</span></div></section><aside className="mini-inspector"><h3>{t.inspectorTitle}</h3><p className="mt24">{t.inspectorBody}</p><div className="mini-setting"><span>{t.inspectorSelection}</span><span>{t.inspectorSelectionValue}</span></div><div className="mini-setting"><span>{t.inspectorChange}</span><span>{t.inspectorChangeValue}</span></div><div className="mini-setting"><span>{t.inspectorResult}</span><span>{t.inspectorResultValue}</span></div><p>{t.inspectorNote}</p></aside></div>
    </main><footer className="landing-values"><span><QuietIcon name="file" />{t.valueSource}</span><span><QuietIcon name="shield" />{t.valueFacts}</span><span><QuietIcon name="spark" />{t.valueDecide}</span></footer><div className="sample-note qf-landing-disclaimer">{t.disclaimer}</div>
  </div>;
}

/** 色板：令牌、英文名、说明文案键（说明按界面语言读取）、前景令牌。 */
const colors = [
  ['bg-canvas', 'Canvas', 'canvas', 'fg-primary'],
  ['bg-subtle', 'Subtle', 'subtle', 'fg-primary'],
  ['bg-elevated', 'Elevated', 'elevated', 'fg-primary'],
  ['fg-primary', 'Ink', 'ink', 'bg-canvas'],
  ['action-primary-bg', 'Action', 'action', 'action-primary-fg'],
  ['selection-bg', 'Selection', 'selection', 'fg-primary'],
] as const;

export function DesignSystemPage() {
  const t = useI18n().messages.entry.designSystem;
  return <main className={`page qf-workspace-page ${styles['designSystem']}`}><div className="sectionhead"><div><div className="eyebrow mb16">{BRAND_NAME.toUpperCase()} / DESIGN SYSTEM 01</div><h1>{t.title}</h1><p>{t.intro}</p></div><Link href="/" className="btn small">{t.back}</Link></div>
    <div className="design-colors mt32">{colors.map(([token, name, captionKey, foreground]) => <div className="color-tile" key={name} style={{ background: `var(--ui-${token})`, color: `var(--ui-${foreground})` }}><strong>{name} · {t.colors[captionKey]}</strong><span>{`ui.${token.replaceAll('-', '.')}`}</span></div>)}</div>
    <div className="type-spec mt32">
      <section className="panel pad">
        <h3>{t.typeTitle}</h3>
        <div className="spec-line"><span className="qf-type-title">{t.typeTitleSample}</span><span className="sample-note">28 / 36</span></div>
        <div className="spec-line"><span className="qf-type-heading">{t.typeHeadingSample}</span><span className="sample-note">18 / 26</span></div>
        <div className="spec-line"><span className="qf-type-subheading">{t.typeSubheadingSample}</span><span className="sample-note">16 / 24</span></div>
        <div className="spec-line"><span className="qf-type-body">{t.typeBodySample}</span><span className="sample-note">16 / 24</span></div>
        <div className="spec-line"><span className="qf-type-metadata muted">{t.typeMetadataSample}</span><span className="sample-note">12 / 18</span></div>
        <div className="spec-line"><span className="qf-long-text" title={t.longFileSample}>{t.longFile(t.longFileSample)}</span><span className="sample-note">{t.longFileNote}</span></div>
        <div className="spec-line"><span className="qf-type-numeric">{t.numericSample}</span><span className="sample-note">{t.numericNote}</span></div>
        <div className="spec-line"><code className="qf-technical-id">prj_example_project_revision_2026</code><span className="sample-note">{t.technicalIdNote}</span></div>
      </section>
      <section className="panel pad"><h3>{t.emphasisTitle}</h3><DesignSystemExampleActions /><div className="row mt24 gap8 qf-design-actions"><span className="badge">{t.badgeSaved}</span><span className="badge">{t.badgePending}</span><span className="badge">{t.badgeMissingSource}</span></div><hr className="divider" /><h3>{t.radiusTitle}</h3><div className="rounded-demo">{[6, 10, 16, 24].map((radius) => <div key={radius} style={{ borderRadius: radius }}>{radius}</div>)}</div><p className="small muted mt16">{t.spacing}<br />{t.sizing}</p><DesignSystemControls /></section>
    </div>
    <section className="panel pad mt24"><h3>{t.statesTitle}</h3><div className="status-board"><div><span className="badge">{t.loadingBadge}</span><h4 className="mt16">{t.loadingTitle}</h4><p className="small muted mt8">{t.loadingBody}</p></div><div><span className="badge">{t.conflictBadge}</span><h4 className="mt16">{t.conflictTitle}</h4><p className="small muted mt8">{t.conflictBody}</p><DesignSystemStatusAction kind="conflict" /></div><div><span className="badge">{t.consentBadge}</span><h4 className="mt16">{t.consentTitle}</h4><p className="small muted mt8">{t.consentBody}</p><DesignSystemStatusAction kind="consent" /></div></div></section></main>;
}
