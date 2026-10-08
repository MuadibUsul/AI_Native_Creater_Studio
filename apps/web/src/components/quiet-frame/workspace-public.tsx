'use client';

import Link from 'next/link';
import { useSession } from '@/lib/queries';
import { QuietIcon } from '@/ui/QuietIcon';
import { DesignSystemControls, DesignSystemExampleActions, DesignSystemStatusAction } from './DesignSystemControls';
import './workspace.css';

function Mark() {
  return <span className="logo"><span className="logomark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M9 4H4v5M15 4h5v5M4 15v5h5M20 15v5h-5" /><path d="m10 8 6 4-6 4Z" fill="currentColor" stroke="none" /></svg></span><span className="logotext">Creator Studio</span></span>;
}

function LandingChartPreview() {
  return <div className="viewer graph qf-landing-chart">
    <span className="safe-mark">设计示意 / 非真实业务数据</span>
    <header><div className="kicker">CHAPTER 02 · 从投入到产出</div><h2>增长，何时变成回报？</h2><p className="chart-sub">投入与产出趋势 · 指数化示意</p></header>
    <div className="chart-inner"><svg viewBox="0 0 640 150" preserveAspectRatio="none" role="img" aria-label="用于界面设计的静态趋势曲线，非真实业务数据">
      <defs><linearGradient id="landing-chart-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#90bcab" stopOpacity=".28" /><stop offset="100%" stopColor="#90bcab" stopOpacity="0" /></linearGradient></defs>
      <path d="M0 20H640M0 66H640M0 111H640" stroke="#bdd1c2" strokeOpacity=".14" strokeWidth="1" />
      <path d="M0 133 C60 125 85 130 125 115S200 104 240 86 300 101 341 68 410 68 463 38 540 44 565 19 610 9 640 0V150H0Z" fill="url(#landing-chart-area)" />
      <path d="M0 133 C60 125 85 130 125 115S200 104 240 86 300 101 341 68 410 68 463 38 540 44 565 19 610 9 640 0" stroke="#c8ded1" strokeWidth="3" fill="none" />
      <path d="M0 136 C110 135 147 126 204 127S310 120 360 112 448 94 493 96 560 65 640 53" stroke="#77959b" strokeWidth="2" strokeDasharray="5 6" fill="none" />
      <circle cx="463" cy="38" r="4" fill="#dcebe0" />
    </svg></div><div className="chart-bottom">示意曲线，不构成事实证据。真实项目需绑定原始数据与许可。</div>
  </div>;
}

export function WelcomePage() {
  const entryHref = useSession().data?.user ? '/' : '/sign-in';
  return <div className="landing qf-landing">
    <header className="landing-nav"><Mark /><nav className="landing-links" aria-label="欢迎页导航"><Link href="/design-system">设计理念</Link><Link href={entryHref} title="进入工作室后查看扩展目录">扩展能力</Link><Link href={entryHref} title="进入工作室后查看创作者身份">创作者身份</Link><Link href={entryHref} className="btn primary small"><QuietIcon name="arrow" />进入工作室</Link></nav></header>
    <main className="landing-hero" id="main"><div className="eyebrow">A STUDIO FOR YOUR THINKING.</div><h1>一篇好文章。<br /><span>一部好作品。</span></h1><p>把研究交给 AI，把表达留给你。<br />从脚本、分镜到成片，让观点有自己的画面。</p>
      <div className="landing-buttons"><Link href={entryHref} className="btn primary large"><QuietIcon name="arrow" />开始你的第一部作品</Link><Link href={entryHref} className="btn large" title="进入工作室后选择项目"><QuietIcon name="play" />体验导演工作台</Link></div>
      <div className="row mt16 qf-landing-assurance"><QuietIcon name="shield" />先看草稿，再确认生成 · 不自动发布</div>
      <div className="landing-product" aria-label="静态产品界面示意，不含真实项目数据"><aside className="mini-side"><Mark />{Array.from({ length: 6 }, (_, index) => <div className="mini-row" key={index} />)}</aside><section className="mini-content"><div className="row between qf-preview-head"><span>当算力成为新资产</span><span className="badge green">草稿预览</span></div><LandingChartPreview /><div className="prompt-dock qf-preview-prompt"><QuietIcon name="spark" /><span className="small muted grow">让这一段，更有说服力。</span><QuietIcon name="arrow" /></div></section><aside className="mini-inspector"><h3>画面设置</h3><div className="mini-preview mt24" aria-hidden="true"><span style={{ height: 14 }} /><span style={{ height: 23 }} /><span style={{ height: 34 }} /><span style={{ height: 41 }} /></div><p>趋势对比 / 确定性组件</p><div className="mini-setting"><span>标题</span><span>增长与回报</span></div><div className="mini-setting"><span>时长</span><span>设计示意</span></div><div className="mini-setting"><span>来源</span><span>待绑定</span></div><div className="mini-setting"><span>配色</span><span>品牌默认</span></div><p>AI 提出修改建议。<br />只有你确认，作品才改变。</p></aside></div>
    </main><footer className="landing-values"><span><QuietIcon name="file" />内容驱动，不从空时间线开始</span><span><QuietIcon name="shield" />事实与来源，始终在场</span><span><QuietIcon name="spark" />AI 创造，你来决定</span></footer><div className="sample-note qf-landing-disclaimer">产品视觉方案 · 曲线为设计示意，非真实业务数据 · 能力描述需通过实际验收后上线</div>
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
  return <main className="page qf-workspace-page"><div className="sectionhead"><div><div className="eyebrow mb16">ANCS / DESIGN SYSTEM 01</div><h1>Quiet Frame · 静框</h1><p>让界面退后，让作品上前。克制的材质，明确的操作。</p></div><Link href="/" className="btn small">返回创作台 →</Link></div>
    <div className="design-colors mt32">{colors.map(([token, name, caption, foreground]) => <div className="color-tile" key={name} style={{ background: `var(--ui-${token})`, color: `var(--ui-${foreground})` }}><strong>{name} · {caption}</strong><span>{`ui.${token.replaceAll('-', '.')}`}</span></div>)}</div>
    <div className="type-spec mt32"><section className="panel pad"><h3>清晰的文字层级</h3><div className="spec-line"><span className="qf-type-title">把观点，变成作品。</span><span className="sample-note">36 / 1.25</span></div><div className="spec-line"><span className="qf-type-heading">继续创作</span><span className="sample-note">23 / 1.4</span></div><div className="spec-line"><span className="qf-type-subheading">让表达，更进一步。</span><span className="sample-note">16 / 1.6</span></div><div className="spec-line"><span>正文保持完整，不为极简牺牲可读性。</span><span className="sample-note">14 / 1.8</span></div><div className="spec-line"><span className="small muted">状态、说明与辅助信息</span><span className="sample-note">12 / 1.6</span></div></section><section className="panel pad"><h3>只在该强调时强调</h3><DesignSystemExampleActions /><div className="row mt24 gap8 qf-design-actions"><span className="badge green">已保存</span><span className="badge amber">等待确认</span><span className="badge red">来源缺失</span></div><hr className="divider" /><h3>柔和，但不含糊</h3><div className="rounded-demo">{[6, 10, 16, 24].map((radius) => <div key={radius} style={{ borderRadius: radius }}>{radius}</div>)}</div><p className="small muted mt16">间距 4 / 8 / 12 / 16 / 24 / 32 / 48<br />按钮 40 px · 主要触控 44–48 px</p><DesignSystemControls /></section></div>
    <section className="panel pad mt24"><h3>状态，同样需要设计。</h3><div className="status-board"><div><span className="badge">加载中</span><h4 className="mt16">正在读取资料</h4><p className="small muted mt8">保留当前内容，不让布局跳动。</p></div><div><span className="badge amber">版本冲突</span><h4 className="mt16">作品已有更新</h4><p className="small muted mt8">先比较差异，再决定如何保留。</p><DesignSystemStatusAction kind="conflict" /></div><div><span className="badge blue">需要授权</span><h4 className="mt16">声音尚未获得授权</h4><p className="small muted mt8">完成授权前，不提交克隆任务。</p><DesignSystemStatusAction kind="consent" /></div></div></section></main>;
}
