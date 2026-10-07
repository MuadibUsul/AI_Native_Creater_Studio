'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkspacePackView } from '@ancs/contracts';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { StateBlock } from '@/ui/StateBlock';
import './workspace.css';

const designCards = [
  { title: 'Shorts', description: '同一个观点，用短视频重新讲。独立开场与节奏，不只是横屏裁切。', hint: '短视频分析', packId: 'ancs.pack.shorts-analyzer', glyph: '▯' },
  { title: '财经图表', description: '数据、单位、时区与许可一起保留。把事实关系变成可读的画面。', hint: '项目内建图表能力', packId: null, glyph: '▥' },
  { title: '播客', description: '从已确认的内容延伸音频表达，保留叙事与来源关联。', hint: '独立音频派生', packId: null, glyph: '♫' },
  { title: '多语言', description: '为不同语言调整表达，同时保留原始内容与版本关系。', hint: '独立派生版本', packId: null, glyph: '◎' },
  { title: '图文与短文', description: '提炼一个观点，组织图片与文案，而不是堆叠缩略内容。', hint: '两种官方 Pack', packId: 'ancs.pack.social-visual', glyph: '▧' },
  { title: '发布与交付', description: '按实际授权决定直接发布、送至草稿，或交给你完成。', hint: '项目交付流程', packId: null, glyph: '↗' },
] as const;

export function WorkspaceExtensions({ workspaceId }: { workspaceId: string }) {
  const client = useAncsClient();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const [activePackId, setActivePackId] = useState<string | null>(null);
  const [detailIndex, setDetailIndex] = useState<number | null>(null);
  const detailRef = useRef<HTMLDialogElement>(null);
  const packs = useQuery({ queryKey: ['workspaces', workspaceId, 'packs'], queryFn: () => client.packs.list(workspaceId) });
  const workspace = useQuery({ queryKey: ['workspaces', workspaceId, 'details'], queryFn: () => client.workspaces.get(workspaceId) });
  const canManage = workspace.data?.role === 'OWNER' || workspace.data?.role === 'ADMIN';
  const toggle = useMutation({
    mutationFn: async (pack: WorkspacePackView) => {
      if (!canManage) throw new Error('只有工作区所有者或管理员能更改扩展状态');
      setActivePackId(pack.installation.packId);
      if (pack.enabled) await client.packs.disable(workspaceId, pack.installation.packId);
      else await client.packs.enable(workspaceId, pack.installation.packId);
      return !pack.enabled;
    },
    onSuccess: (enabled) => {
      setMessage(enabled ? '扩展已启用。项目仍需单独绑定版本。' : '扩展已停用。');
      void queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'packs'] });
      setActivePackId(null);
      setDetailIndex(null);
    },
    onError: () => setActivePackId(null),
  });
  const findPack = (id: string | null) => id === null ? undefined : packs.data?.find((pack) => pack.installation.packId === id);
  const extraTextPack = findPack('ancs.pack.text');
  const detailCard = detailIndex === null ? null : designCards[detailIndex];
  const detailPack = detailCard ? findPack(detailCard.packId) : undefined;
  useEffect(() => {
    const dialog = detailRef.current;
    if (detailCard && dialog && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    return () => {
      if (!dialog?.open) return;
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    };
  }, [detailCard]);

  return <main className="page qf-workspace-page">
    <div className="sectionhead"><div><div className="eyebrow mb16">MORE POSSIBILITIES. SAME FOCUS.</div><h1>需要时，再多一步。</h1><p>主流程只专注一部好作品。更多表达方式，按需启用。</p></div><span className="badge">官方扩展目录</span></div>
    <div className="notice mt24">此目录读取当前工作区真实 Pack 安装与启用状态。启用后，仍需在项目中绑定版本并满足套餐权益。</div>
    {message ? <p role="status" className="notice green mt16">{message}</p> : null}
    {toggle.isError ? <p role="alert" className="notice amber mt16">{describeError(toggle.error).message}</p> : null}
    {packs.isPending ? <StateBlock variant="loading" title="正在读取扩展目录" /> : packs.isError ? <StateBlock variant="error" title="扩展目录读取失败" description={describeError(packs.error).message} action={{ label: '重试', onClick: () => void packs.refetch() }} /> : <div className="pack-grid mt24">
      {designCards.map((card, index) => {
        const pack = findPack(card.packId);
        const status = pack?.installation.status === 'RETIRED' ? '已退役' : pack?.enabled ? '已启用' : pack ? '可启用' : card.packId === null ? '按项目能力开放' : '尚未安装';
        return <section className="pack-card qf-pack-card" key={card.title}>
          <div className="row between"><span className="pack-icon" aria-hidden="true">{card.glyph}</span><span className={'badge qf-pack-status' + (pack?.enabled ? ' green' : '')}>{status}</span></div>
          <h3>{card.title}</h3><p>{card.description}</p>
          {card.title === '图文与短文' && extraTextPack ? <p className="small muted mt8">短文 Pack：{extraTextPack.enabled ? '已启用' : '可启用'} · 社交图文 Pack：{status}</p> : null}
          <div className="row between"><span className="sample-note">{card.hint}</span><button type="button" className="btn small" aria-label={`${pack?.installation.status === 'INSTALLED' ? '了解并管理' : '了解'} ${card.title}`} onClick={() => setDetailIndex(index)}>{pack?.installation.status === 'INSTALLED' ? '了解并管理' : '了解能力'}</button></div>
          {card.title === '图文与短文' && extraTextPack?.installation.status === 'INSTALLED' ? <button type="button" className="btn small mt16" disabled={!canManage || toggle.isPending} onClick={() => toggle.mutate(extraTextPack)}>{extraTextPack.enabled ? '停用短文 Pack' : '启用短文 Pack'}</button> : null}
        </section>;
      })}
    </div>}
    {detailCard ? <dialog ref={detailRef} className="qf-pack-dialog" aria-label={`${detailCard.title}扩展详情`} onClose={() => setDetailIndex(null)}>
      <div className="row between"><h2>{detailCard.title}</h2><button type="button" className="btn small" onClick={() => setDetailIndex(null)}>关闭</button></div>
      <p className="muted mt16">{detailCard.description}</p>
      <p className="small mt16">当前状态：{detailPack?.installation.status === 'RETIRED' ? '已退役' : detailPack?.enabled ? '已启用' : detailPack ? '已安装，尚未启用' : detailCard.packId === null ? '随项目能力开放' : '当前工作区尚未安装'}</p>
      <p className="small muted mt8">{detailCard.hint}。启用扩展不会直接提交生成任务；项目仍需绑定版本并符合权限与套餐权益，实际费用以任务报价为准。</p>
      {detailPack?.installation.status === 'INSTALLED' ? <button type="button" className="btn primary mt24" disabled={!canManage || toggle.isPending} title={!canManage ? '需要工作区管理权限' : undefined} onClick={() => toggle.mutate(detailPack)}>{activePackId === detailPack.installation.packId ? '处理中…' : detailPack.enabled ? '停用' : '启用'}</button> : <p className="notice mt24">当前没有可执行的工作区启用操作。请先确认扩展安装或进入具体项目使用已有能力。</p>}
      {detailCard.title === '图文与短文' && extraTextPack?.installation.status === 'INSTALLED' ? <button type="button" className="btn mt24" disabled={!canManage || toggle.isPending} onClick={() => toggle.mutate(extraTextPack)}>{extraTextPack.enabled ? '停用短文 Pack' : '启用短文 Pack'}</button> : null}
    </dialog> : null}
    <p className="small muted mt24 qf-pack-note">图表与交付随项目现有能力开放；播客和多语言在没有可用 Pack 时不显示启用操作。扩展产物保持独立版本和来源关系，不覆盖原作品。</p>
  </main>;
}
