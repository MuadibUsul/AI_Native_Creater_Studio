'use client';

import Link from 'next/link';
import { useSession } from '@/lib/queries';
import { QuietIcon } from '@/ui/QuietIcon';
import { DesignSystemControls, DesignSystemExampleActions, DesignSystemStatusAction } from './DesignSystemControls';
import styles from './public-entry.module.css';
import './workspace.css';

function Mark() {
  return <span className="logo"><span className="logomark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M9 4H4v5M15 4h5v5M4 15v5h5M20 15v5h-5" /><path d="m10 8 6 4-6 4Z" fill="currentColor" stroke="none" /></svg></span><span className="logotext">Creator Studio</span></span>;
}

function LandingCanvasPreview() {
  return <div data-testid="landing-canvas-preview" className={`viewer ${styles['canvasPreview']}`}>
    <span className={styles['previewEyebrow']}>作品画布</span>
    <div className={styles['canvasMessage']}><strong data-testid="landing-canvas-title">把作品放在眼前。</strong><span>导入素材后，在这里查看、选取并继续修改。</span></div>
    <span className={styles['previewFootnote']}>界面布局示意 · 未载入真实素材</span>
  </div>;
}

export function WelcomePage() {
  const entryHref = useSession().data?.user ? '/' : '/sign-in';
  return <div className={`landing qf-landing ${styles['publicLanding']}`}>
    <header className="landing-nav"><Mark /><nav className="landing-links" aria-label="欢迎页导航"><Link href="/design-system">设计理念</Link><Link href={entryHref} title="进入工作室后查看扩展目录">扩展能力</Link><Link href={entryHref} title="进入工作室后查看创作者身份">创作者身份</Link><Link href={entryHref} className="btn primary small"><QuietIcon name="arrow" />进入工作室</Link></nav></header>
    <main className="landing-hero" id="main"><div className="eyebrow">A STUDIO FOR YOUR THINKING.</div><h1>一个好想法。<br /><span>一部好作品。</span></h1><p>从素材、文章或想法开始。<br />与 AI 一起创作，由你决定如何成片。</p>
      <div className="landing-buttons"><Link href={entryHref} className="btn primary large"><QuietIcon name="arrow" />开始你的第一部作品</Link><Link href={entryHref} className="btn large" title="进入工作室后选择项目"><QuietIcon name="play" />体验导演工作台</Link></div>
      <div className="row mt16 qf-landing-assurance"><QuietIcon name="shield" />先看草稿，再确认生成 · 不自动发布</div>
      <div className="landing-product" role="img" aria-label="导演工作台布局示意，未载入真实素材或任务"><aside className="mini-side"><Mark /><div className={styles['miniNavigation']}><span>作品</span><span>素材</span><span>版本</span></div></aside><section className="mini-content"><div className="row between qf-preview-head"><span>导演工作台</span><span className="badge">界面示意</span></div><LandingCanvasPreview /><div className="prompt-dock qf-preview-prompt"><QuietIcon name="spark" /><span className="small muted grow">选中片段后，在附近提出修改。</span></div></section><aside className="mini-inspector"><h3>按需查看细节</h3><p className="mt24">当前画面和选区决定这里显示什么。</p><div className="mini-setting"><span>选区</span><span>待选择</span></div><div className="mini-setting"><span>修改</span><span>先预览</span></div><div className="mini-setting"><span>结果</span><span>由你确认</span></div><p>这是一张布局示意，不代表已有项目、素材或生成结果。</p></aside></div>
    </main><footer className="landing-values"><span><QuietIcon name="file" />从素材或想法开始</span><span><QuietIcon name="shield" />事实与来源，始终在场</span><span><QuietIcon name="spark" />AI 创造，你来决定</span></footer><div className="sample-note qf-landing-disclaimer">界面示意，不包含真实作品或生成结果。</div>
  </div>;
}

const colors = [
  ['bg-canvas', 'Canvas', '画布', 'fg-primary'],
  ['bg-subtle', 'Subtle', '次级表面', 'fg-primary'],
  ['bg-elevated', 'Elevated', '浮层', 'fg-primary'],
  ['fg-primary', 'Ink', '主文字', 'bg-canvas'],
  ['action-primary-bg', 'Action', '主要操作', 'action-primary-fg'],
  ['selection-bg', 'Selection', '选区', 'fg-primary'],
] as const;

export function DesignSystemPage() {
  return <main className={`page qf-workspace-page ${styles['designSystem']}`}><div className="sectionhead"><div><div className="eyebrow mb16">ANCS / DESIGN SYSTEM 01</div><h1>Quiet Frame · 静框</h1><p>让界面退后，让作品上前。克制的材质，明确的操作。</p></div><Link href="/" className="btn small">返回创作台 →</Link></div>
    <div className="design-colors mt32">{colors.map(([token, name, caption, foreground]) => <div className="color-tile" key={name} style={{ background: `var(--ui-${token})`, color: `var(--ui-${foreground})` }}><strong>{name} · {caption}</strong><span>{`ui.${token.replaceAll('-', '.')}`}</span></div>)}</div>
    <div className="type-spec mt32">
      <section className="panel pad">
        <h3>清晰的文字层级</h3>
        <div className="spec-line"><span className="qf-type-title">把观点，变成作品。</span><span className="sample-note">28 / 36</span></div>
        <div className="spec-line"><span className="qf-type-heading">继续创作</span><span className="sample-note">18 / 26</span></div>
        <div className="spec-line"><span className="qf-type-subheading">让表达，更进一步。</span><span className="sample-note">16 / 24</span></div>
        <div className="spec-line"><span className="qf-type-body">正文保持完整，不为极简牺牲可读性。</span><span className="sample-note">16 / 24</span></div>
        <div className="spec-line"><span className="qf-type-metadata muted">状态、说明与辅助信息</span><span className="sample-note">12 / 18</span></div>
        <div className="spec-line"><span className="qf-long-text" title="中文 English 2026年10月08日_最终审阅版_final-cut_1080p.mp4">长文件名：中文 English 2026年10月08日_最终审阅版_final-cut_1080p.mp4</span><span className="sample-note">完整可查看</span></div>
        <div className="spec-line"><span className="qf-type-numeric">排版样例：¥ −1,234.56 · 01:23:45 · v1.2.3</span><span className="sample-note">等宽数字</span></div>
        <div className="spec-line"><code className="qf-technical-id">prj_example_project_revision_2026</code><span className="sample-note">技术 ID</span></div>
      </section>
      <section className="panel pad"><h3>只在该强调时强调</h3><DesignSystemExampleActions /><div className="row mt24 gap8 qf-design-actions"><span className="badge">✓ 已保存</span><span className="badge">等待确认</span><span className="badge">! 来源缺失</span></div><hr className="divider" /><h3>柔和，但不含糊</h3><div className="rounded-demo">{[6, 10, 16, 24].map((radius) => <div key={radius} style={{ borderRadius: radius }}>{radius}</div>)}</div><p className="small muted mt16">间距 4 / 8 / 12 / 16 / 24 / 32 / 48<br />按钮 40 px · 主要触控 44–48 px</p><DesignSystemControls /></section>
    </div>
    <section className="panel pad mt24"><h3>状态，同样需要设计。</h3><div className="status-board"><div><span className="badge">加载中</span><h4 className="mt16">正在读取资料</h4><p className="small muted mt8">保留当前内容，不让布局跳动。</p></div><div><span className="badge">! 版本冲突</span><h4 className="mt16">作品已有更新</h4><p className="small muted mt8">先比较差异，再决定如何保留。</p><DesignSystemStatusAction kind="conflict" /></div><div><span className="badge">锁定 · 需要授权</span><h4 className="mt16">声音尚未获得授权</h4><p className="small muted mt8">完成授权前，不提交克隆任务。</p><DesignSystemStatusAction kind="consent" /></div></div></section></main>;
}
