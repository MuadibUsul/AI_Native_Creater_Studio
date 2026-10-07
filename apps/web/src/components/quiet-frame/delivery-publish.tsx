'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PLATFORM_CAPABILITY_MATRIX, type ExportPackage, type ExportPackageRecord, type HandoffRecord, type RenderRecord } from '@ancs/contracts';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { useRenders } from '@/lib/queries';
import { QuietIcon } from '@/ui/QuietIcon';
import styles from './delivery.module.css';

const preferred = [
  { id: 'YOUTUBE', name: 'YouTube', mark: 'Y', label: '直接发布', description: '当前未注册发布 Provider；账号连接与实测核验待接入。' },
  { id: 'BILIBILI', name: '哔哩哔哩', mark: 'B', label: '授权发布', description: '能力已声明，平台账号与真实授权尚未核验。' },
  { id: 'DOUYIN', name: '抖音', mark: '手动交付', description: '准备视频、文案与清单，由你在平台完成最后发布。' },
  { id: 'X', name: 'X', mark: 'X', label: '手动交付', description: '准备适配文案，保留人工最后确认。' },
];

function downloadInstructions(record: ExportPackageRecord): void {
  const { payload } = record;
  const lines = [
    `平台：${record.platformId}`, `作品：${payload.title}`,
    `项目版本：${payload.projectVersionId}`, `视频资产：${payload.videoAssetId}`,
    `封面：${payload.coverAssetId ?? payload.coverNote ?? '未提供'}`,
    `简介：${payload.description ?? ''}`, `AIGC 披露：${payload.disclosure ?? '未填写'}`,
    '', '手动交付步骤：', ...payload.checklist.map((step, index) => `${index + 1}. ${step}`),
  ];
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `ANCS-${record.platformId}-handoff.txt`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function DeliveryPublish({ workspaceId, projectId }: { workspaceId: string; projectId: string }) {
  const client = useAncsClient();
  const cache = useQueryClient();
  const renders = useRenders(workspaceId, projectId);
  const project = useQuery({ queryKey: ['project', projectId, 'publish'], queryFn: () => client.projects.get(projectId) });
  const publications = useQuery({ queryKey: ['publications', workspaceId, projectId], queryFn: () => client.publications.list(workspaceId, projectId) });
  const packages = useQuery({ queryKey: ['export-packages', workspaceId, projectId], queryFn: () => client.exportPackages.list(workspaceId, projectId) });
  const handoffs = useQuery({ queryKey: ['handoffs', workspaceId, projectId], queryFn: () => client.handoffs.list(workspaceId, projectId) });
  const approved = useQuery({
    queryKey: ['approved-renders', workspaceId, projectId, renders.data?.map((render) => `${render.id}:${render.status}`).join(',')],
    enabled: renders.data !== undefined,
    queryFn: async (): Promise<RenderRecord | null> => {
      for (const render of renders.data ?? []) {
        if (render.status !== 'READY') continue;
        const approval = await client.renders.approval(workspaceId, render.id);
        if (approval?.decision === 'APPROVED') return render;
      }
      return null;
    },
  });
  const video = useQuery({
    queryKey: ['approved-video', workspaceId, approved.data?.id], enabled: !!approved.data,
    queryFn: async () => {
      for (const assetId of approved.data?.outputAssetIds ?? []) {
        const detail = await client.assets.get(workspaceId, assetId);
        const version = detail.versions.find((entry) => entry.id === detail.currentVersionId);
        if (version?.mimeType.startsWith('video/')) return assetId;
      }
      return null;
    },
  });
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [disclosure, setDisclosure] = useState('');
  const [activePackage, setActivePackage] = useState<ExportPackageRecord | null>(null);
  const [renderBundle, setRenderBundle] = useState<ExportPackage | null>(null);
  const [activeHandoff, setActiveHandoff] = useState<HandoffRecord | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const handoffRequestKey = useRef<string | null>(null);
  const createPackage = useMutation({
    mutationFn: (platformId: 'DOUYIN' | 'X') => {
      if (!approved.data || !video.data || !project.data) throw new Error('需要已批准的成片视频与项目标题。');
      return client.exportPackages.create(workspaceId, projectId, {
        platformId, projectVersionId: approved.data.input.projectVersionId, outputAssetId: video.data,
        coverAssetId: null, title: title.trim() || project.data.title,
        description: description.trim() || null, tags: [], disclosure: disclosure.trim() || null,
      });
    },
    onSuccess: async (record) => { setActivePackage(record); setNotice('手动交付清单已创建；平台发布仍需由你完成。'); await cache.invalidateQueries({ queryKey: ['export-packages', workspaceId, projectId] }); },
    onError: (error) => setNotice(`准备素材包失败：${describeError(error).message}`),
  });
  const exportRender = useMutation({ mutationFn: (renderId: string) => client.renders.exportPackage(workspaceId, renderId), onSuccess: (bundle) => { setRenderBundle(bundle); setNotice(null); }, onError: (error) => setNotice(`下载入口暂不可用：${describeError(error).message}`) });
  const reconcile = useMutation({
    mutationFn: (publicationId: string) => client.publications.reconcile(workspaceId, projectId, publicationId),
    onSuccess: async () => { setNotice('已重新查询平台状态。'); await cache.invalidateQueries({ queryKey: ['publications', workspaceId, projectId] }); },
    onError: (error) => setNotice(`对账失败：${describeError(error).message}`),
  });
  const createHandoff = useMutation({
    mutationFn: () => {
      if (!approved.data || !video.data) throw new Error('需要已批准的成片视频。');
      handoffRequestKey.current ??= crypto.randomUUID();
      return client.handoffs.create(workspaceId, projectId, { artifactIds: [video.data], targetPlatform: null, ttlSeconds: 86_400 }, { idempotencyKey: handoffRequestKey.current });
    },
    onSuccess: async (record) => { handoffRequestKey.current = null; setActiveHandoff(record); setNotice('限时交接记录已创建；领取端仍需完成授权。'); await cache.invalidateQueries({ queryKey: ['handoffs', workspaceId, projectId] }); },
    onError: (error) => setNotice(`创建交接记录失败：${describeError(error).message}`),
  });
  const cancelHandoff = useMutation({
    mutationFn: (handoffId: string) => client.handoffs.cancel(workspaceId, projectId, handoffId),
    onSuccess: async (record) => { setActiveHandoff(record); setNotice('交接记录已撤销。'); await cache.invalidateQueries({ queryKey: ['handoffs', workspaceId, projectId] }); },
    onError: (error) => setNotice(`撤销交接记录失败：${describeError(error).message}`),
  });
  const activeBundle = renderBundle?.renderId === approved.data?.id ? renderBundle : null;
  const visibleHandoffs = activeHandoff ? [activeHandoff, ...(handoffs.data?.items ?? []).filter((item) => item.handoffId !== activeHandoff.handoffId)] : handoffs.data?.items ?? [];
  const otherPlatforms = PLATFORM_CAPABILITY_MATRIX.filter((entry) => !preferred.some((item) => item.id === entry.platformId));

  return <div className="page" data-testid="quiet-publish">
    <header className="sectionhead mobile-stack"><div><h1>作品准备好了。选择下一站。</h1><p>可用的交付方式按平台真实能力展示；手动交付由你完成最后发布。</p></div><span className="badge"><QuietIcon name="shield" />能力核验优先</span></header>
    {notice && <p role="status" className="notice amber mb24">{notice}</p>}
    {renders.isError && <p role="alert" className="notice amber mb24">成片列表加载失败：{describeError(renders.error).message} <button type="button" className="textbtn small" onClick={() => void renders.refetch()}>重试</button></p>}
    {approved.isError && <p role="alert" className="notice amber mb24">审批状态加载失败：{describeError(approved.error).message} <button type="button" className="textbtn small" onClick={() => void approved.refetch()}>重试</button></p>}
    {video.isError && <p role="alert" className="notice amber mb24">成片产物加载失败：{describeError(video.error).message} <button type="button" className="textbtn small" onClick={() => void video.refetch()}>重试</button></p>}
    {project.isError && <p role="alert" className="notice amber mb24">项目读取失败：{describeError(project.error).message} <button type="button" className="textbtn small" onClick={() => void project.refetch()}>重试</button></p>}
    {publications.isError && <p role="alert" className="notice amber mb24">发布记录加载失败：{describeError(publications.error).message} <button type="button" className="textbtn small" onClick={() => void publications.refetch()}>重试</button></p>}
    <div className="split wide mt32"><section><div className="row between mb24"><h3>发布与交付渠道</h3><a className="textbtn small" href="#capability-notes">了解发布能力分级 <QuietIcon name="info" /></a></div>
      {preferred.map((platform) => {
        const entry = PLATFORM_CAPABILITY_MATRIX.find((item) => item.platformId === platform.id);
        const manual = entry?.declaredCapabilities.includes('EXPORT_PACKAGE') === true;
        return <div className="platform-row" key={platform.id}><span className="platform-logo">{platform.mark}</span><div className="grow"><div className="row gap8"><h3>{platform.name}</h3><span className={`badge ${manual ? '' : 'blue'}`}>{platform.label}</span></div><p>{platform.description}</p></div><button type="button" className="btn small" disabled={!manual || !approved.data || !video.data || !project.data || createPackage.isPending} onClick={() => { if (platform.id === 'DOUYIN' || platform.id === 'X') createPackage.mutate(platform.id); }} title={!manual ? '真实账号与平台能力尚未核验' : !approved.data ? '请先批准一个成片版本' : !video.data ? '没有可用的视频产物' : undefined}><QuietIcon name={manual ? 'download' : 'link'} />{manual ? '准备素材包' : '待连接与核验'}</button></div>;
      })}
      <div className="notice mt24"><QuietIcon name="shield" /><div><strong>真实状态，不做假完成。</strong><br />“已送草稿”与“已发布”分别显示。账号未授权、能力未实测核验时，绝不显示为发布成功。</div></div>
      <section className="panel pad mt24" id="capability-notes"><h3>发布能力说明</h3><p className="small muted mt8">矩阵中的平台能力是公开文档口径。当前真实账号实测尚未完成；直发与草稿投递不会在此误报为可用。</p>{otherPlatforms.map((entry) => <p key={entry.platformId} className="small muted mt8">{entry.platformId} · {entry.tier} · {entry.verification}</p>)}</section>
      <section className="panel pad mt24"><div className="row between"><div><h3>从一部作品，延伸更多表达</h3><p className="small muted mt8">Shorts、播客和图文通过扩展生成独立版本。</p></div><Link className="btn small" href={`/w/${workspaceId}/extensions`}><QuietIcon name="box" />选择扩展</Link></div></section>
      <section className="panel pad mt24"><h3>发布记录</h3>{publications.isPending && <p className="small muted mt16">正在加载…</p>}{publications.isError && <p className="small muted mt16">发布记录加载失败：{describeError(publications.error).message}</p>}{publications.data?.items.length === 0 && <p className="small muted mt16">尚无发布记录。</p>}{publications.data?.items.map((record) => <div key={record.id} className={`${styles['recordRow']} mt16`}><span>{record.platformId} · {record.title}</span><span className={`badge ${record.state === 'PUBLISHED' ? 'green' : record.state === 'FAILED' ? 'red' : 'amber'}`}>{record.state === 'DRAFT' ? '平台草稿' : record.state === 'PUBLISHED' ? '已发布' : record.state === 'PUBLISHING' || record.state === 'QUEUED' ? '结果待核对' : record.state}</span>{record.state === 'QUEUED' || record.state === 'PUBLISHING' || record.state === 'FAILED' ? <button type="button" className="btn small" disabled={reconcile.isPending} onClick={() => reconcile.mutate(record.id)}>{reconcile.isPending ? '核对中…' : '查询平台状态'}</button> : null}{record.remoteUrl && <a className="textbtn small" href={record.remoteUrl} target="_blank" rel="noopener noreferrer">查看平台记录</a>}</div>)}</section>
    </section><aside className="col"><section className="panel pad"><div className={`publication-cover ${styles['packagePreview']}`} data-testid="package-preview"><div className="cover"><div className="cover-art art-0" aria-hidden="true" /><span className="cover-label">CREATOR STUDIO / EDITORIAL</span><span className={`cover-title ${styles['previewTitle']}`}>{project.data?.title ?? '当前作品'}</span><span className={styles['previewDisclosure']}>{approved.data ? '封面示意 · 非成片画面' : '示意 · 等待成片批准'}</span></div></div><h3 className="mt16">{project.data?.title ?? '当前作品'}</h3><div className="row mt8 gap8"><span className="badge">{approved.data ? `${approved.data.input.format.width} × ${approved.data.input.format.height}` : '规格未知'}</span><span className={`badge ${approved.data ? 'green' : 'amber'}`}>{approved.data ? '已批准' : '尚未批准'}</span></div>{approved.data && <p className="small muted mt8">Render {approved.data.id} · 项目版本 {approved.data.input.projectVersionId}</p>}<hr className="divider" />
      <label className="label">交付标题<input className="field" value={title || project.data?.title || ''} onChange={(event) => setTitle(event.target.value)} maxLength={300} /></label><label className="label mt16">简介<textarea className="field" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={5000} rows={3} /></label><label className="label mt16">AIGC 披露文案<textarea className="field" value={disclosure} onChange={(event) => setDisclosure(event.target.value)} rows={2} placeholder="按目标平台要求填写" /></label>
      <hr className="divider" /><h4 className="small">当前可下载产物</h4><p className="small muted mt8">从已批准 Render 获取短期签名链接。封面与字幕仅在实际产出后列出。</p><div className="mt24"><button type="button" className="btn full" disabled={!approved.data || exportRender.isPending} onClick={() => { if (approved.data) exportRender.mutate(approved.data.id); }}><QuietIcon name="download" />{exportRender.isPending ? '正在准备…' : '获取成片下载链接'}</button></div>{activeBundle && <div className="mt16" data-testid="publish-render-export">{activeBundle.projectEditedSinceApproval && <p className="notice amber">批准后有新编辑；此处下载仍为批准时的快照。</p>}{activeBundle.entries.map((item) => Date.parse(item.download.expiresAt) > Date.now() + 5000 ? <a key={item.kind} className="textbtn" href={item.download.url} target="_blank" rel="noopener noreferrer" onClick={(event) => { if (Date.parse(item.download.expiresAt) <= Date.now() + 5000) { event.preventDefault(); setNotice('下载链接已过期，请重新获取。'); } }}>下载 {item.kind} · {item.mimeType}</a> : <p key={item.kind} className="small muted">{item.kind} 下载链接已过期，请重新获取。</p>)}</div>}
    </section><section className="panel pad"><h3>手动交付清单</h3>{packages.isPending && <p className="small muted mt16">正在加载…</p>}{packages.isError && <p role="alert" className="small muted mt16">清单加载失败：{describeError(packages.error).message} <button type="button" className="textbtn small" onClick={() => void packages.refetch()}>重试</button></p>}{!activePackage && packages.data?.items.length === 0 && <p className="small muted mt16">批准成片后选择抖音或 X 准备清单。</p>}{(activePackage ?? packages.data?.items[0]) && <div className="mt16"><span className="badge blue">{(activePackage ?? packages.data?.items[0])?.platformId}</span><ol className={styles['checklist']}>{(activePackage ?? packages.data?.items[0])?.payload.checklist.map((step) => <li key={step}>{step}</li>)}</ol><p className="small muted">项目版本：{(activePackage ?? packages.data?.items[0])?.payload.projectVersionId} · 封面：{(activePackage ?? packages.data?.items[0])?.payload.coverNote ?? '已绑定'} · 最后一步由用户完成。</p><button type="button" className="btn small mt16" onClick={() => { const record = activePackage ?? packages.data?.items[0]; if (record) downloadInstructions(record); }}><QuietIcon name="download" />下载交付说明 TXT</button></div>}</section><section className="panel pad"><h3>限时跨端交接</h3><p className="small muted mt8">Web 可创建和撤销绑定已批准视频的限时记录；移动端领取界面将在 P15 提供。</p>{handoffs.isError && <p role="alert" className="small muted mt16">交接记录加载失败：{describeError(handoffs.error).message} <button type="button" className="textbtn small" onClick={() => void handoffs.refetch()}>重试</button></p>}<button type="button" className="btn small mt16" disabled={!approved.data || !video.data || createHandoff.isPending} onClick={() => createHandoff.mutate()}>{createHandoff.isPending ? '创建中…' : '创建 24 小时交接记录'}</button>{visibleHandoffs.length === 0 && !handoffs.isPending ? <p className="small muted mt16">暂无交接记录。</p> : null}{visibleHandoffs.map((record) => <div key={record.handoffId} className="mt16"><span className="small">{record.handoffId}</span><span className={`badge ${record.state === 'PENDING' && !record.isExpired ? 'amber' : ''}`}>{record.isExpired ? '已过期' : record.state === 'PENDING' ? '待领取' : record.state === 'REVOKED' ? '已撤销' : record.state === 'CLAIMED' ? '已领取' : '已完成'}</span><p className="small muted mt8">到期：{new Date(record.expiresAt).toLocaleString('zh-CN')}</p>{record.state === 'PENDING' && !record.isExpired ? <button type="button" className="btn small mt8" disabled={cancelHandoff.isPending} onClick={() => cancelHandoff.mutate(record.handoffId)}>撤销交接</button> : null}</div>)}</section><div className="notice"><QuietIcon name="phone" /><span>移动端领取尚未接入；现阶段可使用受控下载链接和手动交付清单。</span></div></aside></div>
  </div>;
}
