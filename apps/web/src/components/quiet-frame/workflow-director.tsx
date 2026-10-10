'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ASPECT_RATIO_SIZES, legacyMillisecondsToMediaTime, type AspectRatio, type DirectorPlan, type EditPlan, type MediaTime, type Scene, type SceneGraph, type TemporalSelection } from '@ancs/contracts';
import { useAncsClient } from '@/lib/client';
import { describeError, isVersionConflict } from '@/lib/errors';
import { queryKeys, useNarrative, useSceneGraph, useWorkspace } from '@/lib/queries';
import { AiEditPanel } from '@/ui/AiEditPanel';
import { LiteTimeline, type TimelineEditRequest } from '@/ui/LiteTimeline';
import { PreviewPlayer } from '@/ui/PreviewPlayer';
import { PropForm } from '@/ui/PropForm';
import { ScenePreview } from '@/ui/ScenePreview';
import { StateBlock } from '@/ui/StateBlock';
import { QuietIcon } from '@/ui/QuietIcon';
import { useWorkflowDialog } from './workflow-dialog';
import './workflow.css';

const seconds = (ms: number) => String(Math.ceil(ms / 1000)).padStart(2, '0') + ' 秒';
const sceneTitle = (scene: Scene) => typeof scene.props['title'] === 'string' && scene.props['title'].trim() ? scene.props['title'] : scene.semanticType;

/** Measure the real available width so scene previews keep their aspect ratio on phones. */
function ResponsiveScene({ scene, aspectRatio, compact = false, resolveAssetUrl }: { scene: Scene; aspectRatio: AspectRatio; compact?: boolean; resolveAssetUrl?: (assetId: string) => string | null }) {
  const element = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(compact ? 170 : 640);
  useEffect(() => {
    const node = element.current;
    if (!node) return;
    const update = () => { if (node.clientWidth > 0) setWidth(Math.floor(node.clientWidth)); };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const previewProps = { ...scene.props };
  if (scene.sceneType === 'IMAGE_FULL' || scene.sceneType === 'REAL_BROLL' || scene.sceneType === 'HOST_FULL' || scene.sceneType === 'HOST_SIDE') {
    const binding = scene.assetBindings.find((item) => item.role === 'visual' || item.role === 'broll' || item.role === 'avatar');
    if (binding) {
      previewProps['assetId'] = binding.assetId;
      previewProps['assetUrl'] = resolveAssetUrl?.(binding.assetId) ?? null;
    }
  }
  return <div ref={element} className={compact ? 'qf-scene-thumb' : 'qf-scene-stage'}><ScenePreview sceneType={scene.sceneType} componentVersion={scene.componentVersion} props={previewProps} durationMs={scene.durationMs} aspectRatio={aspectRatio} width={width} /></div>;
}

function ResponsivePlayer({ graph, resolveAssetUrl }: { graph: SceneGraph; resolveAssetUrl: (assetId: string) => string | null }) {
  const element = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const node = element.current;
    if (!node) return;
    const update = () => { if (node.clientWidth > 0) setWidth(Math.floor(node.clientWidth)); };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return <div ref={element} className="qf-full-player"><PreviewPlayer graph={graph} resolveAssetUrl={resolveAssetUrl} width={width} /></div>;
}

/** One Director workspace backs both canonical Storyboard and legacy Scene Editor deep links. */
export function WorkflowDirector({ initialSceneId }: { initialSceneId?: string }) {
  const client = useAncsClient();
  const queryClient = useQueryClient();
  const { workspaceId, projectId } = useParams<{ workspaceId: string; projectId: string }>();
  const graph = useSceneGraph(workspaceId, projectId);
  const narrative = useNarrative(workspaceId, projectId);
  const workspace = useWorkspace(workspaceId);
  const canEdit = workspace.data?.role === 'OWNER' || workspace.data?.role === 'ADMIN' || workspace.data?.role === 'EDITOR';
  const [showTimeline, setShowTimeline] = useState(false);
  const projectAssets = useQuery({
    queryKey: queryKeys.assets(workspaceId, projectId),
    enabled: showTimeline && graph.data !== undefined,
    queryFn: () => client.assets.list(workspaceId, { projectId }),
  });
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(initialSceneId ?? null);
  const [tab, setTab] = useState<'visual' | 'speech' | 'source'>('visual');
  const [showPlayer, setShowPlayer] = useState(false);
  const [showInspector, setShowInspector] = useState(false);
  const [showAi, setShowAi] = useState(false);
  const [editPlan, setEditPlan] = useState<EditPlan | null>(null);
  const [directorPreview, setDirectorPreview] = useState<DirectorPlan | null>(null);
  const [mediaSelection, setMediaSelection] = useState<{ assetId: string; label: string; sourceStartPts: string; sourceEndPts: string; timeBase: { numerator: number; denominator: number } } | null>(null);
  const [editTarget, setEditTarget] = useState<{ sceneId: string; title: string } | null>(null);
  // N04-04-s1：横向时间带的播放头与时间选区（选择动作不改工程；持久化为 SelectionAnchor 属 N04-10）
  const [bandPlayhead, setBandPlayhead] = useState<MediaTime | null>(null);
  const [bandSelection, setBandSelection] = useState<TemporalSelection | null>(null);
  const aiTrigger = useRef<HTMLElement | null>(null);
  const closeAi = (force = false) => {
    if (!force && applyEditPlan.isPending) return;
    setShowAi(false);
  };
  useEffect(() => {
    if (initialSceneId !== undefined) return;
    try {
      const saved = sessionStorage.getItem('ancs-director-scene:' + workspaceId + ':' + projectId);
      if (saved) setSelectedSceneId(saved);
    } catch { /* Storage is optional; the first scene remains available. */ }
  }, [initialSceneId, workspaceId, projectId]);
  useEffect(() => {
    if (initialSceneId !== undefined || selectedSceneId === null) return;
    try { sessionStorage.setItem('ancs-director-scene:' + workspaceId + ':' + projectId, selectedSceneId); } catch { /* Selection still works in memory. */ }
  }, [initialSceneId, workspaceId, projectId, selectedSceneId]);
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(`ancs-media-selection:${workspaceId}:${projectId}`);
      if (!raw) return;
      const parsed = JSON.parse(raw) as typeof mediaSelection;
      if (parsed?.assetId && parsed.label && parsed.timeBase) {
        setMediaSelection(parsed);
        setTab('source');
        setShowInspector(true);
      }
    } catch { /* A malformed local selection cannot change the project. */ }
  }, [workspaceId, projectId]);

  const boundAssetIds = [...new Set((graph.data?.scenes ?? []).flatMap((scene) => scene.assetBindings.map((binding) => binding.assetId)))].sort();
  const assetVersionSignature = boundAssetIds.map((assetId) => assetId + ':' + (projectAssets.data?.find((asset) => asset.id === assetId)?.currentVersionId ?? '')).join('|');
  const assetUrls = useQuery({
    queryKey: [...queryKeys.assets(workspaceId, projectId), 'preview-urls', graph.data?.projectRevision, assetVersionSignature],
    enabled: graph.data !== undefined && boundAssetIds.length > 0,
    queryFn: async () => {
      const entries = await Promise.all(boundAssetIds.map(async (assetId) => {
        try {
          const response = await client.assets.downloadUrl(workspaceId, assetId);
          return [assetId, Date.parse(response.expiresAt) > Date.now() + 5000 ? { url: response.url, expiresAt: response.expiresAt } : null] as const;
        } catch {
          return [assetId, null] as const;
        }
      }));
      return new Map(entries);
    },
    refetchInterval: (query) => {
      const validUntil = [...(query.state.data?.values() ?? [])].flatMap((entry) => entry ? [Date.parse(entry.expiresAt)] : []);
      return validUntil.length === 0 ? 60_000 : Math.max(1000, Math.min(60_000, Math.min(...validUntil) - Date.now() - 10_000));
    },
  });
  const resolveAssetUrl = (assetId: string): string | null => {
    const signed = assetUrls.data?.get(assetId);
    return signed && Date.parse(signed.expiresAt) > Date.now() + 5000 ? signed.url : null;
  };
  const replaceableAssets = (projectAssets.data ?? []).filter((asset) => asset.status === 'READY' && asset.currentVersionId !== null).map((asset) => ({ id: asset.id, assetType: asset.assetType }));

  const timelineEdit = useMutation({
    mutationFn: async (request: TimelineEditRequest) => {
      if (!canEdit) throw new Error('当前角色只能查看分镜。');
      const current = graph.data;
      if (current === undefined) throw new Error('场景图尚未加载');
      return client.projects.edit(projectId, {
        baseProjectRevision: current.projectRevision,
        expectedSceneRevisions: request.expectedSceneRevisions,
        operations: request.operations,
        idempotencyKey: 'idem_web_timeline_' + current.projectRevision + '_' + Date.now(),
        intent: 'Lite Timeline：' + request.operations.map((operation) => operation.op).join(', '),
      });
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.graph(workspaceId, projectId) }),
  });
  const saveScene = useMutation({
    mutationFn: async (input: { sceneId: string; props: Record<string, unknown> }) => {
      if (!canEdit) throw new Error('当前角色只能查看分镜。');
      const current = graph.data;
      if (current === undefined) throw new Error('场景图尚未加载');
      const scene = current.scenes.find((candidate) => candidate.id === input.sceneId);
      if (scene === undefined) throw new Error('场景不存在（可能是并发删除）');
      return client.projects.edit(projectId, {
        baseProjectRevision: current.projectRevision,
        expectedSceneRevisions: { [scene.id]: scene.revision },
        operations: [{ op: 'update_scene', sceneId: scene.id, changes: { props: input.props } }],
        idempotencyKey: 'idem_web_scene_' + scene.id + '_r' + scene.revision + '_' + Date.now(),
        intent: '编辑器修改场景属性',
      });
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.graph(workspaceId, projectId) }),
  });
  const planEdit = useMutation({
    mutationFn: (input: { prompt: string; sceneId: string; title: string }) => {
      if (!canEdit) throw new Error('当前角色只能查看分镜。');
      const scopedPrompt = `请仅修改选中分镜「${input.title}」（sceneId: ${input.sceneId}）。用户意图：${input.prompt}`;
      if (scopedPrompt.length > 2000) throw new Error('修改意图连同分镜上下文不能超过 2000 字符。');
      return client.narrative.aiEditPlan(workspaceId, projectId, { prompt: scopedPrompt });
    },
    onSuccess: (plan) => { setEditPlan(plan); setShowAi(true); },
    onError: () => setShowAi(true),
  });
  const applyEditPlan = useMutation({
    mutationFn: async (plan: EditPlan) => {
      if (!canEdit) throw new Error('当前角色只能查看分镜。');
      const current = graph.data;
      if (current === undefined) throw new Error('场景图尚未加载');
      const expectedSceneRevisions: Record<string, number> = {};
      for (const entry of plan.operations) {
        if (entry.sceneId !== null) {
          const scene = current.scenes.find((candidate) => candidate.id === entry.sceneId);
          if (scene !== undefined) expectedSceneRevisions[scene.id] = scene.revision;
        }
      }
      return client.projects.edit(projectId, {
        baseProjectRevision: plan.baseProjectRevision,
        expectedSceneRevisions,
        operations: plan.operations.map((entry) => entry.operation),
        idempotencyKey: 'idem_web_aiedit_' + plan.planId,
        intent: 'AI Edit：' + plan.prompt.slice(0, 80),
      });
    },
    onSuccess: () => {
      setEditPlan(null);
      closeAi(true);
      void queryClient.invalidateQueries({ queryKey: queryKeys.graph(workspaceId, projectId) });
    },
  });
  const previewDirector = useMutation({
    mutationFn: async () => {
      if (!canEdit) throw new Error('当前角色只能查看分镜。');
      if (!narrative.data) throw new Error('缺少叙事计划：先在脚本页生成叙事');
      setDirectorPreview(null);
      return client.narrative.directorPlan(workspaceId, projectId, narrative.data.id);
    },
    onSuccess: setDirectorPreview,
  });
  const applyDirector = useMutation({
    mutationFn: async () => {
      if (!canEdit) throw new Error('当前角色只能查看分镜。');
      const plan = narrative.data;
      if (plan == null) throw new Error('缺少叙事计划：先在 Script 页生成叙事');
      if (!directorPreview || directorPreview.narrativePlanId !== plan.id || directorPreview.narrativePlanRevision !== plan.revision) throw new Error('Director 计划已过期，请重新预览。');
      if (directorPreview.blocked || directorPreview.estimatedCost.certainty !== 'KNOWN' || directorPreview.estimatedCost.total === null || directorPreview.providerJobs.some((job) => job.blocked)) throw new Error('计划含阻断项或费用未确定，不能应用。');
      return client.narrative.applyDirectorPlan(workspaceId, projectId, plan.id, {
        idempotencyKey: 'idem_web_director_' + plan.id + '_' + plan.revision,
      });
    },
    onSuccess: () => { setDirectorPreview(null); void queryClient.invalidateQueries({ queryKey: queryKeys.graph(workspaceId, projectId) }); },
  });
  const aiDialogRef = useWorkflowDialog(showAi, () => closeAi(), aiTrigger);

  if (graph.isPending) return <div className="page qf-workflow"><StateBlock variant="loading" title="正在加载分镜…" /></div>;
  if (graph.isError) {
    const described = describeError(graph.error);
    return <div className="page qf-workflow"><StateBlock variant={described.kind === 'forbidden' ? 'forbidden' : 'error'} title="加载分镜失败" description={described.message} diagnostics={described.code ?? undefined} action={{ label: '重试', onClick: () => void graph.refetch() }} /></div>;
  }
  const scenes = [...(graph.data?.scenes ?? [])].sort((a, b) => a.position - b.position);
  const mediaSelectionNotice = mediaSelection === null ? null : <div className="notice" role="status"><QuietIcon name="check" /><div className="grow"><strong>已选择真实片段：{mediaSelection.label}</strong><p className="small mt8">素材 {mediaSelection.assetId} · 源范围 {mediaSelection.sourceStartPts}–{mediaSelection.sourceEndPts}（{mediaSelection.timeBase.numerator}/{mediaSelection.timeBase.denominator}）已带入当前编辑上下文；项目尚未自动修改。</p></div><button type="button" className="textbtn small" onClick={() => { setMediaSelection(null); try { sessionStorage.removeItem(`ancs-media-selection:${workspaceId}:${projectId}`); } catch { /* Optional local state. */ } }}>取消选择</button></div>;
  if (scenes.length === 0) {
    const described = applyDirector.isError ? describeError(applyDirector.error) : previewDirector.isError ? describeError(previewDirector.error) : null;
    const preview = directorPreview && narrative.data && directorPreview.narrativePlanId === narrative.data.id && directorPreview.narrativePlanRevision === narrative.data.revision ? directorPreview : null;
    const canApply = preview !== null && !preview.blocked && preview.estimatedCost.certainty === 'KNOWN' && preview.estimatedCost.total !== null && preview.providerJobs.every((job) => !job.blocked);
    return <div className="page qf-workflow qf-director-empty">{mediaSelectionNotice}<StateBlock variant={described?.kind === 'conflict' ? 'conflict' : 'empty'} title="分镜还是空的" description="先预览 Director 的场景、素材、任务、费用和告警；确认后才应用。" diagnostics={described?.code ?? undefined} action={preview ? { label: applyDirector.isPending ? '应用中…' : '确认应用计划', onClick: () => applyDirector.mutate(), disabled: !canEdit || !canApply || applyDirector.isPending } : { label: previewDirector.isPending ? '规划中…' : '预览 Director 计划', onClick: () => previewDirector.mutate(), disabled: !canEdit || previewDirector.isPending || !narrative.data }} secondaryAction={preview ? { label: '放弃计划', onClick: () => setDirectorPreview(null), disabled: applyDirector.isPending } : null}>{workspace.isError ? <p role="alert" className="qf-error">无法确认工作区权限：{describeError(workspace.error).message}</p> : !canEdit && workspace.data ? <p className="small muted">当前角色只能查看分镜。</p> : null}{described !== null ? <p className="qf-error">{described.message}</p> : null}{!narrative.data ? <p className="small muted">先在脚本页生成叙事计划。</p> : null}{preview ? <section className="panel pad mt16" aria-label="Director 计划预览"><h3>计划预览 · {preview.scenes.length} 个场景</h3><p className="small muted mt8">{preview.decisionSummary}</p><p className="small mt16">预计片长：{seconds(preview.estimatedDurationMs)} · 素材需求：{preview.assetPlan.length} 项 · Provider 任务：{preview.providerJobs.reduce((sum, job) => sum + job.jobCount, 0)} 项</p><p className="small mt8">费用：{preview.estimatedCost.total ? `${preview.estimatedCost.total.amount} ${preview.estimatedCost.total.currency}` : '未知'}（{preview.estimatedCost.certainty}）</p>{preview.scenes.map((scene) => <p className="small mt8" key={scene.sceneId}>{scene.position + 1}. {scene.sceneType} · {seconds(scene.durationMs)} · {scene.visualIntent || scene.narration || '无描述'}</p>)}{preview.warnings.map((warning) => <p className="small mt8" key={warning.code + warning.message}>{warning.severity}：{warning.message}</p>)}{!canApply ? <p role="alert" className="notice amber mt16">{preview.blockedReasons.join('；') || preview.estimatedCost.note || '计划含阻断项或费用未确定，不能应用。'}</p> : null}</section> : null}</StateBlock></div>;
  }
  const path = '/w/' + workspaceId + '/p/' + projectId;
  const selected = scenes.find((scene) => scene.id === selectedSceneId) ?? (initialSceneId === undefined ? scenes[0] : undefined);
  if (selected === undefined) return <div className="page qf-workflow"><StateBlock variant="error" title="场景不存在" description="它可能已被删除（例如撤销了一次插入）。" action={{ label: '刷新场景图', onClick: () => void graph.refetch() }}><Link className="btn small" href={path + '/storyboard'}>返回当前分镜</Link></StateBlock></div>;
  const selectedIndex = scenes.findIndex((scene) => scene.id === selected.id);
  const submitEditPlan = (prompt: string, trigger?: HTMLElement | null) => {
    if (trigger) aiTrigger.current = trigger;
    const target = showAi && editTarget ? editTarget : { sceneId: selected.id, title: sceneTitle(selected) };
    setEditTarget(target);
    setEditPlan(null);
    planEdit.mutate({ prompt, ...target });
  };
  const affectedSceneIds = [...new Set((editPlan?.operations ?? []).flatMap((entry) => entry.sceneId === null ? [] : [entry.sceneId]))];
  const saveError = saveScene.isError ? describeError(saveScene.error) : null;
  const timelineError = timelineEdit.isError ? describeError(timelineEdit.error) : null;
  const rawAspectRatio = graph.data?.format.aspectRatio ?? '16:9';
  const aspectRatio: AspectRatio = Object.hasOwn(ASPECT_RATIO_SIZES, rawAspectRatio) ? rawAspectRatio as AspectRatio : '16:9';
  return <div className="qf-workflow qf-director-workspace">
    {workspace.isError ? <p role="alert" className="qf-error">无法确认工作区权限：{describeError(workspace.error).message}</p> : !canEdit && workspace.data ? <p className="notice">当前角色只能查看分镜。</p> : null}
    {mediaSelectionNotice}
    <div className="editor-workspace">
      <aside className="scene-rail" aria-label="分镜列表">
        <div className="row between"><strong className="small">分镜</strong><span className="small muted">{scenes.length}</span></div>
        {scenes.map((scene, index) => <button type="button" key={scene.id} className={'scene-card' + (selected.id === scene.id ? ' active' : '')} aria-pressed={selected.id === scene.id} onClick={() => { setSelectedSceneId(scene.id); setShowPlayer(false); setTab('visual'); }}>
          <ResponsiveScene scene={scene} aspectRatio={aspectRatio} compact resolveAssetUrl={resolveAssetUrl} />
          <div className="scene-desc"><span>{String(index + 1).padStart(2, '0')} · {sceneTitle(scene)}</span>{scene.locked ? <span aria-label="已锁定">🔒</span> : null}</div>
          <span className="qf-scene-duration">{seconds(scene.durationMs)}</span>
        </button>)}
        <button type="button" className="btn small full ghost mt16 qf-duplicate" disabled={!canEdit || timelineEdit.isPending} onClick={() => timelineEdit.mutate({ operations: [{ op: 'duplicate_scene', sceneId: selected.id, afterSceneId: null }], expectedSceneRevisions: {} })}>＋ 复制当前分镜</button>
      </aside>
      <section className="editor-center" aria-label="导演工作台">
        <div className="row between viewer-top"><span>{String(selectedIndex + 1).padStart(2, '0')} / {String(scenes.length).padStart(2, '0')} · {sceneTitle(selected)}</span><div className="row gap8"><span className="badge">{showPlayer ? '完整作品预览' : '当前分镜 · 草稿预览'}</span><button type="button" className="btn ghost small qf-mobile-inspector-button" aria-expanded={showInspector} onClick={() => setShowInspector((value) => !value)}>设置</button><button type="button" className="btn ghost icononly small" aria-label="切换预览" onClick={() => setShowPlayer((value) => !value)}>⛶</button></div></div>
        <div className="viewer qf-director-viewer" data-testid="preview-panel" style={{ aspectRatio: aspectRatio.replace(':', ' / '), ...(aspectRatio === '9:16' ? { width: 'min(100%, 40vh)' } : {}) }}>{showPlayer ? <ResponsivePlayer graph={graph.data} resolveAssetUrl={resolveAssetUrl} /> : <ResponsiveScene scene={selected} aspectRatio={aspectRatio} resolveAssetUrl={resolveAssetUrl} />}</div>
        <div className="player-bar"><button type="button" className="btn ghost icononly small" aria-label={showPlayer ? '返回当前分镜' : '播放完整预览'} onClick={() => setShowPlayer((value) => !value)}>{showPlayer ? '◼' : '▶'}</button><span>{seconds(selected.startMs)}</span><span className="scrubber" /><span>{seconds(graph.data?.timeline.durationMs ?? 0)}</span><span>♪</span></div>
        <div className="narration-line"><div className="row between small muted"><span>当前旁白 · {selected.locked ? '已锁定' : '可编辑'}</span><Link className="textbtn" href={path + '/script'}>编辑文本</Link></div><p>{selected.narration || '当前分镜没有旁白。'}</p></div>
        <form className="prompt-dock" onSubmit={(event) => { event.preventDefault(); if (!canEdit) return; const data = new FormData(event.currentTarget); const prompt = String(data.get('prompt') ?? '').trim(); if (prompt) submitEditPlan(prompt, event.currentTarget.querySelector('button')); }}><span aria-hidden="true">✧</span><input name="prompt" aria-label="修改当前分镜" placeholder="让这段更简洁，保留观点和来源…" disabled={!canEdit} /><button type="submit" disabled={!canEdit || planEdit.isPending} className="btn primary icononly small" aria-label="生成修改建议">→</button></form>
        <div className="suggestions">{['缩短当前旁白', '把重点放到画面中央', '增加一点停顿'].map((prompt) => <button key={prompt} type="button" disabled={!canEdit || planEdit.isPending} onClick={(event) => submitEditPlan(prompt, event.currentTarget)}>{prompt}</button>)}</div>
        <div className="timeline-head row between"><button type="button" className="btn ghost small" aria-expanded={showTimeline} onClick={() => setShowTimeline((value) => !value)}>{showTimeline ? '收起轻时间线' : '展开轻时间线'}</button><span className="sample-note">按分镜编辑 · 修改可能受预算与锁定限制</span></div>
        <div className="timeline-strip">{scenes.map((scene, index) => <button key={scene.id} type="button" className={'timeline-clip' + (scene.id === selected.id ? ' active' : '')} onClick={() => setSelectedSceneId(scene.id)}>{String(index + 1).padStart(2, '0')} · {sceneTitle(scene)}</button>)}</div>
        {showTimeline ? <div className="qf-timeline-detail"><div className="row between qf-timeline-assets"><span className="small muted">项目素材 · {replaceableAssets.length} 项可替换</span><button type="button" className="textbtn small" onClick={() => void projectAssets.refetch()}>刷新素材</button></div>{projectAssets.isPending ? <p className="small muted" role="status">正在加载可替换素材…</p> : projectAssets.isError ? <p className="qf-error" role="alert">项目素材读取失败：{describeError(projectAssets.error).message}</p> : null}<LiteTimeline graph={graph.data} assets={replaceableAssets} pending={!canEdit || timelineEdit.isPending} onEdit={(request) => timelineEdit.mutate(request)} error={timelineError === null ? null : { kind: timelineError.kind, message: timelineError.message, code: timelineError.code }} band={{ viewport: { start: legacyMillisecondsToMediaTime(0), end: legacyMillisecondsToMediaTime(Math.max(1, graph.data.timeline.durationMs)), widthPx: 640 }, playhead: bandPlayhead, selection: bandSelection, onPlayheadChange: setBandPlayhead, onSelectionChange: setBandSelection }} /></div> : null}
        {timelineError !== null && !showTimeline ? <p role="alert" className="qf-error">{timelineError.message}</p> : null}
      </section>
      <aside className={'inspector' + (showInspector ? ' qf-inspector-open' : '')} aria-label="当前场景设置">
        <div className="row between"><h3>画面设置</h3><Link className="btn ghost icononly small" href={path + '/editor/' + selected.id} aria-label="分镜详情">⋯</Link></div>
        <div className="segmented mt16" role="tablist" aria-label="场景设置">{([['visual', '画面'], ['speech', '声音'], ['source', '来源']] as const).map(([value, label]) => <button key={value} type="button" role="tab" aria-selected={tab === value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)}>{label}</button>)}</div>
        {tab === 'visual' ? <div className="qf-inspector-body">
          <label className="label">视觉组件</label><div className="qf-inspector-preview"><ResponsiveScene scene={selected} aspectRatio={aspectRatio} compact resolveAssetUrl={resolveAssetUrl} /></div>
          <div className="property-row"><span>{selected.sceneType}</span><span className="badge">确定性组件</span></div>
          <div className="qf-inspector-forms">{scenes.map((scene) => <div key={scene.id} hidden={scene.id !== selected.id}><PropForm sceneType={scene.sceneType} componentVersion={scene.componentVersion} initialProps={scene.props} disabled={!canEdit || saveScene.isPending || scene.locked} onSubmit={(props, validation) => { if (validation.ok) saveScene.mutate({ sceneId: scene.id, props }); }} /></div>)}</div>
          {saveScene.isSuccess ? <StateBlock variant="info" title="已保存" description={'场景 revision 已更新（项目 revision ' + saveScene.data.project.revision + '）。'} /> : null}
          {saveError !== null ? <StateBlock variant={isVersionConflict(saveError) ? 'conflict' : 'error'} title={isVersionConflict(saveError) ? '保存冲突：数据已被其他编辑更新' : '保存失败'} description={isVersionConflict(saveError) ? '请刷新场景图获取最新 revision，再重新提交你的修改。' : saveError.message} diagnostics={saveError.code ?? undefined} action={{ label: '刷新场景图', onClick: () => void graph.refetch() }} /> : null}
          <div className="settings-row row between"><span>停留时长</span><span>{seconds(selected.durationMs)}</span></div>
          <div className="settings-row row between"><span>来源绑定</span><span>{selected.sourceBindings.length} 处</span></div>
          {selected.dataBindings.length === 0 && selected.sceneType.includes('CHART') ? <div className="notice amber mt16">此图表没有绑定数据，不可作为事实图表导出。</div> : null}
          <div className="settings-row row between"><span>锁定当前分镜</span><button type="button" className="switch" role="switch" aria-label="锁定当前分镜" aria-checked={selected.locked} disabled={!canEdit || timelineEdit.isPending} onClick={() => timelineEdit.mutate({ operations: [{ op: 'set_scene_lock', sceneId: selected.id, locked: !selected.locked }], expectedSceneRevisions: { [selected.id]: selected.revision } })} /></div>
          <p className="muted mt8">锁定后，AI 只会提出建议，不直接改动。</p>
        </div> : null}
        {tab === 'speech' ? <div className="qf-inspector-body"><h4>当前旁白</h4><p className="mt16">{selected.narration || '此场景没有旁白。'}</p><hr className="divider" /><p className="small muted">字幕 {graph.data?.captions.filter((caption) => caption.sceneId === selected.id).length ?? 0} 条 · 音轨 {graph.data?.audioTracks.length ?? 0} 条</p><Link className="btn small full mt16" href={path + '/script'}>编辑脚本文本</Link><p className="small muted mt8">时序与音量在轻时间线中调整。</p></div> : null}
        {tab === 'source' ? <div className="qf-inspector-body"><h4>来源与数据</h4><p className="small muted mt8">关联不代表已完成事实核验。</p>{selected.sourceBindings.length === 0 ? <p className="small muted mt16">尚未绑定来源。</p> : selected.sourceBindings.map((binding) => <div className="sourceitem" key={binding.sourceId}><span className="source-index">↗</span><div><strong>{binding.sourceId}</strong><p>事实 {binding.claimIds.length} · 数据集 {binding.datasetIds.length}</p></div></div>)}<hr className="divider" /><p className="small muted">当前场景绑定数据 {selected.dataBindings.length} 项 · 素材 {selected.assetBindings.length} 项。</p><Link className="btn small full mt16" href={path + '/assets'}>查看项目素材</Link></div> : null}
      </aside>
    </div>
    {showAi ? <div className="qf-workflow-backdrop" onClick={() => closeAi()}><section ref={aiDialogRef} tabIndex={-1} className="qf-workflow-drawer qf-ai-drawer" role="dialog" aria-modal="true" aria-label="AI 修改差异" onClick={(event) => event.stopPropagation()}><div className="row between"><h2>先看修改，再做决定。</h2><button type="button" autoFocus disabled={applyEditPlan.isPending} className="btn small ghost qf-ai-close" aria-label="关闭" onClick={() => closeAi()}>×</button></div>{editTarget ? <div className="qf-ai-scope small"><strong>请求分镜：{editTarget.title}（{editTarget.sceneId}）</strong>{editPlan ? <span>计划实际目标：{affectedSceneIds.length > 0 ? affectedSceneIds.join('、') : '没有明确指向场景的操作'}</span> : null}</div> : null}{editTarget && editPlan?.operations.some((entry) => entry.sceneId !== editTarget.sceneId) ? <p role="alert" className="notice amber mt16">计划还涉及其他分镜或项目级操作，请核对目标后再应用。</p> : null}{canEdit ? <AiEditPanel initialPrompt={planEdit.variables?.prompt ?? ''} plan={editPlan} planPending={planEdit.isPending} planError={planEdit.isError ? (() => { const d = describeError(planEdit.error); return { kind: d.kind, message: d.message, code: d.code }; })() : null} onPlan={(prompt) => submitEditPlan(prompt)} onApply={(plan) => applyEditPlan.mutate(plan)} onReject={() => { if (!applyEditPlan.isPending) { setEditPlan(null); closeAi(); } }} applyPending={applyEditPlan.isPending} applyError={applyEditPlan.isError ? (() => { const d = describeError(applyEditPlan.error); return { kind: d.kind, message: d.message, code: d.code }; })() : null} /> : <p className="notice mt16">当前角色只能查看分镜，无法应用 AI 修改。</p>}</section></div> : null}
  </div>;
}
