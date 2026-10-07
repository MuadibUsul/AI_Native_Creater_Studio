'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ExportPackage, QaReport, RenderProfile } from '@ancs/contracts';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { queryKeys, useNarrative, useRenderApproval, useRenderQaReport, useRenders, useWorkspace } from '@/lib/queries';
import { QuietIcon } from '@/ui/QuietIcon';
import styles from './delivery.module.css';

const profiles: { value: RenderProfile; label: string }[] = [
  { value: 'DRAFT_720', label: '草稿 · 720p' }, { value: 'STUDIO_1080', label: '标准高清 · 1080p' },
  { value: 'PREMIUM_4K', label: '高精度 · 4K' }, { value: 'SHORT_1080x1920', label: '竖版短视频 · 1080p' },
];
const statusLabel = { QUEUED: '等待渲染', RENDERING: '渲染中', QA: '质量检查中', READY: '等待人工批准', FAILED: '渲染失败', CANCELLED: '已取消' } as const;

function QaPanel({ report, title }: { report: QaReport; title: string }) {
  return <section className="panel pad" data-testid="qa-report"><div className="row between"><h3>{title}</h3><span className={`badge ${report.verdict === 'PASS' ? 'green' : 'red'}`}>{report.verdict === 'PASS' ? '检查通过' : '检查未通过'}</span></div>
    <div className="check-list">{report.checks.map((check) => <div key={check.id} className="check-item" data-testid={`qa-check-${check.id}`}><QuietIcon name={check.status === 'PASS' ? 'check' : 'info'} /><div><strong>{check.category} · {check.id}</strong><p>{check.message ?? (check.status === 'SKIP' ? '此项未执行，结果未知。' : check.status === 'PASS' ? '通过' : '未通过')}{check.status === 'FAIL' && check.severity === 'BLOCKER' ? ' · 阻止交付' : ''}</p></div></div>)}</div>
    <p className="small muted mt16">阻止项 {report.summary.blockersFailed} · 警告 {report.summary.warningsFailed} · 跳过 {report.summary.skipped} · {new Date(report.createdAt).toLocaleString()}</p>
  </section>;
}

export function DeliveryRender({ workspaceId, projectId }: { workspaceId: string; projectId: string }) {
  const client = useAncsClient();
  const cache = useQueryClient();
  const renders = useRenders(workspaceId, projectId);
  const narrative = useNarrative(workspaceId, projectId);
  const workspace = useWorkspace(workspaceId);
  const canCreate = workspace.data?.role === 'OWNER' || workspace.data?.role === 'ADMIN' || workspace.data?.role === 'EDITOR';
  const masterNarration = useQuery({
    queryKey: ['projects', projectId, 'master-narration', workspaceId, narrative.data?.id, narrative.data?.revision],
    enabled: narrative.data != null,
    queryFn: () => client.narrative.masterNarration(workspaceId, projectId, narrative.data?.id ?? ''),
    refetchInterval: 5000,
  });
  const narrationReady = narrative.data != null && masterNarration.data != null
    && masterNarration.data.narrativePlanRevision === narrative.data.revision
    && masterNarration.data.assetId !== null && masterNarration.data.assetVersionId !== null;
  const [selectedId, setSelectedId] = useState('');
  const [profile, setProfile] = useState<RenderProfile>('STUDIO_1080');
  const [precheck, setPrecheck] = useState<QaReport | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [reviewNote, setReviewNote] = useState('');
  const [exportBundle, setExportBundle] = useState<ExportPackage | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const current = renders.data?.find((render) => render.id === selectedId) ?? renders.data?.[0];
  const qa = useRenderQaReport(workspaceId, current?.id ?? null);
  const approval = useRenderApproval(workspaceId, current?.id ?? null);
  const media = useQuery({
    queryKey: ['render-media', workspaceId, current?.id], enabled: !!current && current.outputAssetIds.length > 0,
    queryFn: async () => {
      for (const assetId of current?.outputAssetIds ?? []) {
        const detail = await client.assets.get(workspaceId, assetId);
        const version = detail.versions.find((entry) => entry.id === detail.currentVersionId);
        if (version?.mimeType.startsWith('video/')) return client.assets.downloadUrl(workspaceId, assetId);
      }
      return null;
    }, staleTime: 0,
  });
  const invalidate = async () => cache.invalidateQueries({ queryKey: queryKeys.renders(workspaceId, projectId) });
  const runPrecheck = useMutation({ mutationFn: () => client.projects.renderPrecheck(projectId), onMutate: () => setPrecheck(null), onSuccess: setPrecheck, onError: (error) => setNotice(`预检失败：${describeError(error).message}`) });
  const runQa = useMutation({ mutationFn: () => client.renders.qa(workspaceId, current?.id ?? ''), onSuccess: async () => { setNotice('已重新入队质量检查。'); await invalidate(); }, onError: (error) => setNotice(`质量检查无法启动：${describeError(error).message}`) });
  const decide = useMutation({ mutationFn: (decision: 'APPROVED' | 'REJECTED') => client.renders.decideApproval(workspaceId, current?.id ?? '', { decision, ...(reviewNote.trim() ? { note: reviewNote.trim() } : {}) }), onSuccess: async (record) => { setReviewed(false); setExportBundle(null); setNotice(record.decision === 'APPROVED' ? '此成片快照已批准；可准备交付。' : '已退回修改。'); await cache.invalidateQueries({ queryKey: queryKeys.renderApproval(workspaceId, current?.id ?? 'none') }); }, onError: (error) => setNotice(`审批失败：${describeError(error).message}`) });
  const exportRender = useMutation({ mutationFn: (renderId: string) => client.renders.exportPackage(workspaceId, renderId), onSuccess: (bundle) => { setExportBundle(bundle); setNotice(null); }, onError: (error) => setNotice(`导出被阻止：${describeError(error).message}`) });
  const approved = approval.data?.decision === 'APPROVED';
  const canApprove = qa.data?.verdict === 'PASS' && approval.isSuccess;
  const previewUrl = media.data && Date.parse(media.data.expiresAt) > Date.now() + 5000 ? media.data.url : null;
  const activeExportBundle = exportBundle?.renderId === current?.id ? exportBundle : null;

  return <div className="page" data-testid="quiet-render">
    <header className="sectionhead mobile-stack"><div><h1>最后一遍，由你把关。</h1><p>检查画面、声音与来源。批准的是这一版成片。</p></div><span className={`badge ${approved ? 'green' : current?.status === 'FAILED' ? 'red' : 'amber'}`}><QuietIcon name={approved ? 'check' : 'clock'} />{approved ? '此版本已批准' : current ? statusLabel[current.status] : '尚无成片'}</span></header>
    {notice && <p role="status" className="notice amber mb24">{notice}</p>}
    <section className="panel pad mt24" data-testid="master-narration-status">
      <div className="row between"><div><h3>先准备好旁白</h3><p className="small muted mt8">成片需要与当前脚本一致的真实音频和时间对齐。</p></div><span className={`badge ${narrationReady ? 'green' : 'amber'}`}>{narrationReady ? '旁白已就绪' : '等待旁白'}</span></div>
      {narrative.isPending ? <p className="small muted mt16">正在读取脚本…</p> : narrative.isError ? <p role="alert" className="notice amber mt16">脚本读取失败：{describeError(narrative.error).message} <button type="button" className="textbtn small" onClick={() => void narrative.refetch()}>重试读取脚本</button></p> : !narrative.data ? <p className="small muted mt16">尚无脚本，请先生成脚本草稿。</p> : masterNarration.isPending ? <p className="small muted mt16">正在读取旁白状态…</p> : masterNarration.isError ? <p role="alert" className="notice amber mt16">旁白状态读取失败：{describeError(masterNarration.error).message}</p> : masterNarration.data ? <>
        <p className="small muted mt16">脚本版本 {masterNarration.data.narrativePlanRevision} · {(masterNarration.data.totalDurationMs / 1000).toFixed(1)} 秒 · {masterNarration.data.segments.length} 段旁白 · {masterNarration.data.alignmentMethod === 'PROVIDER_TIMESTAMPS' ? '供应商时间戳对齐' : '音频对齐器'}</p>
        {masterNarration.data.narrativePlanRevision !== narrative.data.revision ? <p role="status" className="notice amber mt16">脚本已有新修改，现有旁白对应旧版本；重新准备旁白后才能创建新渲染。</p> : !narrationReady ? <p role="status" className="notice amber mt16">旁白音频或版本尚未就绪，暂不能创建新渲染。</p> : null}
        {masterNarration.data.warnings.map((warning) => <p className="small muted mt8" key={warning}>{warning}</p>)}
      </> : <p role="status" className="notice amber mt16">当前脚本尚无旁白，暂不能创建新渲染。</p>}
      <div className="row mt16" style={{ flexWrap: 'wrap' }}><Link className="btn small" href={`/w/${workspaceId}/p/${projectId}/script`}>查看脚本</Link><Link className="btn small" href={`/w/${workspaceId}/identity`}>配置创作者声音</Link>{narrative.data && <button type="button" className="btn small" disabled={masterNarration.isFetching} onClick={() => void masterNarration.refetch()}>{masterNarration.isFetching ? '正在刷新旁白…' : '刷新旁白状态'}</button>}</div>
      {!narrationReady && <p className="small muted mt16">旁白生成尚未接入费用确认与任务状态，当前页面不会直接提交生成。已在后台完成的旁白可通过刷新读取。</p>}
      {workspace.isError ? <p role="alert" className="small muted mt16">无法确认操作权限：{describeError(workspace.error).message} <button type="button" className="textbtn small" onClick={() => void workspace.refetch()}>重试读取权限</button></p> : workspace.data && !canCreate ? <p className="small muted mt16">当前角色只能查看，无法创建新渲染。</p> : null}
    </section>
    <div className="review-layout mt32"><section>
      <div className={styles['renderPlayer']}>{previewUrl && current?.status === 'READY' ? <video controls preload="metadata" src={previewUrl} aria-label="当前成片预览" onError={() => setNotice('成片预览加载失败，请刷新预览链接。')} /> : <div className={styles['renderEmpty']}><QuietIcon name={current?.status === 'FAILED' ? 'info' : 'film'} /><strong>{current ? statusLabel[current.status] : '尚未创建成片'}</strong><span>{current?.status === 'READY' ? '成片已就绪，预览链接暂不可用。可先查看 QA 报告。' : current?.status === 'FAILED' ? '查看错误并修复后，重新创建渲染。' : '画面只显示真实渲染产物；不使用演示视频。'}</span></div>}</div>
      {current?.status === 'READY' && current.outputAssetIds.length > 0 && <div className="row mt8"><button type="button" className="textbtn small" disabled={media.isFetching} onClick={() => void media.refetch()}>{media.isFetching ? '正在获取预览链接…' : '刷新预览链接'}</button>{media.isError && <span role="alert" className="small muted">预览链接获取失败：{describeError(media.error).message}</span>}</div>}
      <section className="panel pad mt24"><div className="row between"><h3>交付版本</h3>{current && <span className="badge blue">{current.id.slice(0, 10)}</span>}</div><div className="row between mt16" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}><div><strong className="small">{profiles.find((item) => item.value === current?.profile)?.label ?? '尚未选择'}</strong><p className="small muted mt8">{current ? `${current.input.format.width} × ${current.input.format.height} · ${current.input.format.fps} fps · 快照 ${current.input.projectVersionId.slice(0, 10)}` : '渲染使用不可变项目版本快照'}</p></div><label className="small">渲染规格 <select className="field select" aria-label="渲染规格" value={profile} onChange={(event) => setProfile(event.target.value as RenderProfile)}>{profiles.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label></div>
        <div className="row mt24" style={{ flexWrap: 'wrap' }}><button type="button" className="btn" disabled={runPrecheck.isPending} onClick={() => runPrecheck.mutate()}>{runPrecheck.isPending ? '正在预检…' : '渲染前预检'}</button><button type="button" className="btn primary" disabled aria-describedby="render-cost-blocker">创建新渲染</button>{current?.status === 'QA' && <button type="button" className="btn" disabled={runQa.isPending} onClick={() => runQa.mutate()}>重新触发 QA</button>}</div>
        <p id="render-cost-blocker" role="status" className="notice amber mt16">暂不能创建新渲染：当前预检仅检查内容就绪情况，尚未提供所选规格的费用报价、预算及服务可用性确认。即使内容检查通过，也需完成这些确认后才能提交。</p>
        {precheck?.verdict === 'FAIL' && <p role="alert" className="small muted mt16">预检存在阻止项。请先修复，重新预检后再创建渲染。</p>}
        <p className="small muted mt16">渲染与 QA 由服务端 Worker 执行；这里显示真实阶段，不估算百分比。</p></section>
      <div className="row between mt24"><span className="small muted">这一版需要修改？</span><Link className="btn small" href={`/w/${workspaceId}/p/${projectId}/editor`}><QuietIcon name="undo" />返回分镜修改</Link></div>
      <section className="panel pad mt24"><div className="row between"><h3>渲染队列</h3>{renders.isFetching && <span className="small muted">正在更新…</span>}</div>{renders.isPending && <p className="small muted mt16">正在加载渲染…</p>}{renders.isError && <p className="small muted mt16">渲染队列加载失败：{describeError(renders.error).message}</p>}{renders.data?.length === 0 && <p className="small muted mt16">还没有渲染。建议先运行预检。</p>}<div className={styles['renderQueue']}>{renders.data?.slice(0, 8).map((render) => <button key={render.id} type="button" data-testid={`render-${render.id}`} className={`${styles['queueItem']} ${current?.id === render.id ? styles['queueSelected'] : ''}`} onClick={() => { setSelectedId(render.id); setReviewed(false); setExportBundle(null); }}><span className={`badge ${render.status === 'READY' ? 'green' : render.status === 'FAILED' ? 'red' : 'amber'}`}>{statusLabel[render.status]}</span><span>{profiles.find((item) => item.value === render.profile)?.label}</span><span className="small muted">{new Date(render.createdAt).toLocaleString()}</span></button>)}</div></section>
    </section><aside className="col"><section className="panel pad"><div className="row between"><h3>交付检查</h3>{qa.data && <span className={`badge ${qa.data.verdict === 'PASS' ? 'green' : 'red'}`}>{qa.data.verdict}</span>}</div>{qa.isPending && current && <p className="small muted mt16">正在加载 QA 报告…</p>}{qa.isError && <p role="alert" className="small muted mt16">QA 报告加载失败：{describeError(qa.error).message} <button type="button" className="textbtn small" onClick={() => void qa.refetch()}>重试</button></p>}{qa.data ? <div className="check-list">{qa.data.checks.map((check) => <div key={check.id} className="check-item"><QuietIcon name={check.status === 'PASS' ? 'check' : 'info'} /><div><strong>{check.category} · {check.id}</strong><p>{check.message ?? check.status}</p></div></div>)}</div> : <p className="small muted mt16">尚无服务端 QA 报告。检查通过后才会进入人工批准。</p>}{current?.status === 'FAILED' && <div className="notice amber mt16"><QuietIcon name="info" /><span>渲染失败：{String(current.error?.['reason'] ?? '请查看任务日志')}</span></div>}</section>
      {current?.status === 'READY' && <section className="panel pad" data-testid="approval-panel"><h3>批准这一版</h3><p className="small muted mt8">批准绑定本次 Render 与 manifest {current.manifestHash?.slice(0, 12) ?? '未知'}；后续编辑需重新渲染和批准。</p>{approved ? <><p className="badge green mt16"><QuietIcon name="check" />已批准 · {approval.data?.createdAt ? new Date(approval.data.createdAt).toLocaleString() : '时间未知'}</p><div className="mt24"><button type="button" className="btn primary full" disabled={exportRender.isPending} onClick={() => exportRender.mutate(current.id)}>{exportRender.isPending ? '正在准备…' : '获取受控下载链接'}</button></div><Link className="textbtn mt16" href={`/w/${workspaceId}/p/${projectId}/publish`}>前往交付 <QuietIcon name="arrow" /></Link></> : <>{approval.data?.decision === 'REJECTED' && <p className="notice amber mt16">最近一次审批为驳回：{approval.data.note ?? '未填写备注'}</p>}<label className="checkboxrow mt16"><input type="checkbox" disabled={!canApprove} checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} /><span>我已核对这个真实渲染版本与 QA 结果。</span></label><label className="label mt16">审批备注（可选）<input className="field" value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} /></label><div className="mt24"><button type="button" className="btn primary full" disabled={!reviewed || !canApprove || decide.isPending} onClick={() => decide.mutate('APPROVED')}><QuietIcon name="check" />批准这一版</button></div><button type="button" className="textbtn small mt8" disabled={decide.isPending} onClick={() => decide.mutate('REJECTED')} style={{ width: '100%', justifyContent: 'center' }}>需要修改，退回此版本</button></>}{activeExportBundle && <div data-testid="export-package" className="notice green mt24"><div><strong>已批准快照 {activeExportBundle.projectVersionId.slice(0, 12)}</strong>{activeExportBundle.projectEditedSinceApproval && <p>批准后已有新编辑；这些文件仍属于批准时的快照。</p>}<ul className="mt8">{activeExportBundle.entries.map((entry) => <li key={entry.kind}>{Date.parse(entry.download.expiresAt) > Date.now() + 5000 ? <a href={entry.download.url} target="_blank" rel="noopener noreferrer" onClick={(event) => { if (Date.parse(entry.download.expiresAt) <= Date.now() + 5000) { event.preventDefault(); setNotice('下载链接已过期，请重新获取。'); } }}>下载 {entry.kind}</a> : <span>{entry.kind} 下载链接已过期，请重新获取。</span>}</li>)}</ul></div></div>}</section>}
      {current?.status === 'READY' && !approved && !canApprove && <p role="status" className="small muted">批准暂不可用：{qa.isPending || approval.isPending ? '正在读取 QA 与审批状态。' : qa.isError ? 'QA 报告读取失败，请重试。' : approval.isError ? '审批状态读取失败，请重试。' : '需要一份通过的服务端 QA 报告。'}</p>}
      {approval.isError && current?.status === 'READY' && <p role="alert" className="small muted">审批状态加载失败：{describeError(approval.error).message} <button type="button" className="textbtn small" onClick={() => void approval.refetch()}>重试</button></p>}
    </aside></div>
    {precheck && <div className="mt24"><QaPanel report={precheck} title="渲染前预检" /></div>}
    {qa.data && <div className="mt24"><QaPanel report={qa.data} title="完整 QA 报告" /></div>}
  </div>;
}
