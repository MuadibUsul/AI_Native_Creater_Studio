'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useWorkspaceSelection } from '@/ui/StudioShell';
import { QuietIcon } from '@/ui/QuietIcon';

export function DesignSystemControls() {
  const { toggleTheme, openHelp } = useWorkspaceSelection();
  return <div className="row mt24 gap8">
    <button type="button" className="btn small" onClick={toggleTheme}><QuietIcon name="sun" />切换深浅色</button>
    <button type="button" className="btn small" onClick={openHelp}>查看快捷键</button>
  </div>;
}

export function DesignSystemExampleActions() {
  const { workspaceId } = useWorkspaceSelection();
  const [showCancelNote, setShowCancelNote] = useState(false);
  const createHref = workspaceId ? `/w/${workspaceId}/new` : '/';

  return <>
    <div className="row mt24 gap8 qf-design-actions">
      <Link href={createHref} className="btn primary">开始创作 →</Link>
      <Link href={createHref} className="btn blue">生成草稿 ✧</Link>
      <button type="button" className="btn" onClick={() => setShowCancelNote(true)}>取消</button>
    </div>
    {showCancelNote ? <p role="status" className="small muted mt8">这是设计系统示例，当前没有待取消的操作。</p> : null}
  </>;
}

export function DesignSystemStatusAction({ kind }: { kind: 'conflict' | 'consent' }) {
  const { workspaceId } = useWorkspaceSelection();
  const [visible, setVisible] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const conflict = kind === 'conflict';
  const titleId = `qf-design-${kind}-title`;

  useEffect(() => {
    if (!visible || !dialog.current) return;
    const element = dialog.current;
    if (typeof element.showModal === 'function') element.showModal();
    else element.setAttribute('open', '');
    element.querySelector('button')?.focus();
    return () => {
      if (element.open && typeof element.close === 'function') element.close();
      else element.removeAttribute('open');
    };
  }, [visible]);

  const dismiss = () => {
    if (dialog.current?.open && typeof dialog.current.close === 'function') dialog.current.close();
    else dialog.current?.removeAttribute('open');
    setVisible(false);
    trigger.current?.focus();
  };

  return <>
    <button ref={trigger} type="button" className="textbtn small mt8" onClick={() => setVisible(true)}>
      {conflict ? '查看解决方式' : '查看授权流程'} <QuietIcon name="arrow" />
    </button>
    {visible ? <dialog ref={dialog} className="qf-pack-dialog" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); dismiss(); }} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); dismiss(); } }}>
      <div className="row between"><h2 id={titleId}>{conflict ? '作品已有更新。你的修改仍在。' : '这段声音，属于你吗？'}</h2><button type="button" className="btn ghost icononly" aria-label="关闭" onClick={dismiss}><QuietIcon name="close" /></button></div>
      {conflict ? <>
        <p className="mt16">设计示意：遇到版本冲突时应保留本地文本，比较最新版本，禁止静默覆盖。</p>
        <div className="diff-card"><header>演示差异 · 当前旁白</header><div className="diff-remove">本地：把三个变量放在同一张图上。</div><div className="diff-add">服务端：先呈现观点，再解释三个变量。</div></div>
        <p className="small muted">这里没有连接具体作品，不会保存、刷新或覆盖任何版本。</p>
      </> : <>
        <p className="mt16">声音身份必须建立在明确授权上。正式流程需要保存授权记录、用途、时间与撤销方式。仅使用本人声音，或持有可核验的明确授权。</p>
        <p className="notice mt16">这是流程说明。本页不接收声音样本，不提交授权，也不会启动克隆。</p>
        <p className="small muted mt16">样本要求应以已连接供应商的核验规范为准。</p>
        <Link className="btn primary mt24" href={workspaceId ? `/w/${workspaceId}/identity` : '/'}>{workspaceId ? '前往创作者身份' : '进入创作台'}</Link>
      </>}
      <div className="row mt24"><button type="button" className="btn" onClick={dismiss}>知道了</button></div>
    </dialog> : null}
  </>;
}
