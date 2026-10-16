'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkspacePackView } from '@ancs/contracts';
import { useI18n } from '@/i18n/I18nProvider';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { StateBlock } from '@/ui/StateBlock';
import './workspace.css';

// 扩展卡片（标题、说明与提示见 messages.workspaceAdmin.extensions.cards[id]）；socialVisual 卡片同时承载短文 Pack
const designCards = [
  { id: 'shorts', packId: 'ancs.pack.shorts-analyzer', glyph: '▯' },
  { id: 'financeCharts', packId: null, glyph: '▥' },
  { id: 'podcast', packId: null, glyph: '♫' },
  { id: 'multilingual', packId: null, glyph: '◎' },
  { id: 'socialVisual', packId: 'ancs.pack.social-visual', glyph: '▧' },
  { id: 'delivery', packId: null, glyph: '↗' },
] as const;

export function WorkspaceExtensions({ workspaceId }: { workspaceId: string }) {
  const { messages } = useI18n();
  const t = messages.workspaceAdmin.extensions;
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
      if (!canManage) throw new Error(t.notManager);
      setActivePackId(pack.installation.packId);
      if (pack.enabled) await client.packs.disable(workspaceId, pack.installation.packId);
      else await client.packs.enable(workspaceId, pack.installation.packId);
      return !pack.enabled;
    },
    onSuccess: (enabled) => {
      setMessage(enabled ? t.enabledNotice : t.disabledNotice);
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
  const detailText = detailCard ? t.cards[detailCard.id] : null;
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
    <div className="sectionhead"><div><div className="eyebrow mb16">{t.eyebrow}</div><h1>{t.title}</h1><p>{t.lead}</p></div><span className="badge">{t.catalogBadge}</span></div>
    <div className="notice mt24">{t.catalogNotice}</div>
    {message ? <p role="status" className="notice green mt16">{message}</p> : null}
    {toggle.isError ? <p role="alert" className="notice amber mt16">{describeError(toggle.error).message}</p> : null}
    {packs.isPending ? <StateBlock variant="loading" title={t.loading} /> : packs.isError ? <StateBlock variant="error" title={t.loadFailed} description={describeError(packs.error).message} action={{ label: messages.common.retry, onClick: () => void packs.refetch() }} /> : <div className="pack-grid mt24">
      {designCards.map((card, index) => {
        const pack = findPack(card.packId);
        const text = t.cards[card.id];
        const status = pack?.installation.status === 'RETIRED' ? t.status.retired : pack?.enabled ? t.status.enabled : pack ? t.status.available : card.packId === null ? t.status.projectCapability : t.status.notInstalled;
        return <section className="pack-card qf-pack-card" key={card.id}>
          <div className="row between"><span className="pack-icon" aria-hidden="true">{card.glyph}</span><span className={'badge qf-pack-status' + (pack?.enabled ? ' green' : '')}>{status}</span></div>
          <h3>{text.title}</h3><p>{text.description}</p>
          {card.id === 'socialVisual' && extraTextPack ? <p className="small muted mt8">{t.textPackStatus(extraTextPack.enabled ? t.status.enabled : t.status.available, status)}</p> : null}
          <div className="row between"><span className="sample-note">{text.hint}</span><button type="button" className="btn small" aria-label={pack?.installation.status === 'INSTALLED' ? t.manageAria(text.title) : t.learnAria(text.title)} onClick={() => setDetailIndex(index)}>{pack?.installation.status === 'INSTALLED' ? t.manage : t.learn}</button></div>
          {card.id === 'socialVisual' && extraTextPack?.installation.status === 'INSTALLED' ? <button type="button" className="btn small mt16" disabled={!canManage || toggle.isPending} onClick={() => toggle.mutate(extraTextPack)}>{extraTextPack.enabled ? t.disableTextPack : t.enableTextPack}</button> : null}
        </section>;
      })}
    </div>}
    {detailCard && detailText ? <dialog ref={detailRef} className="qf-pack-dialog" aria-label={t.detailAria(detailText.title)} onClose={() => setDetailIndex(null)}>
      <div className="row between"><h2>{detailText.title}</h2><button type="button" className="btn small" onClick={() => setDetailIndex(null)}>{messages.common.close}</button></div>
      <p className="muted mt16">{detailText.description}</p>
      <p className="small mt16">{t.detailStatus(detailPack?.installation.status === 'RETIRED' ? t.detailStatusLabels.retired : detailPack?.enabled ? t.detailStatusLabels.enabled : detailPack ? t.detailStatusLabels.installed : detailCard.packId === null ? t.detailStatusLabels.projectCapability : t.detailStatusLabels.notInstalled)}</p>
      <p className="small muted mt8">{t.detailNote(detailText.hint)}</p>
      {detailPack?.installation.status === 'INSTALLED' ? <button type="button" className="btn primary mt24" disabled={!canManage || toggle.isPending} title={!canManage ? t.needsManage : undefined} onClick={() => toggle.mutate(detailPack)}>{activePackId === detailPack.installation.packId ? t.processing : detailPack.enabled ? t.disable : t.enable}</button> : <p className="notice mt24">{t.noAction}</p>}
      {detailCard.id === 'socialVisual' && extraTextPack?.installation.status === 'INSTALLED' ? <button type="button" className="btn mt24" disabled={!canManage || toggle.isPending} onClick={() => toggle.mutate(extraTextPack)}>{extraTextPack.enabled ? t.disableTextPack : t.enableTextPack}</button> : null}
    </dialog> : null}
    <p className="small muted mt24 qf-pack-note">{t.footnote}</p>
  </main>;
}
