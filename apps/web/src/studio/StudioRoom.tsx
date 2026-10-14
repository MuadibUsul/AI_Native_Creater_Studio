'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AGENT_ERROR_REASONS, BUDGET_REJECTION_REASONS, GENERATION_ERROR_REASONS, PROPOSAL_ERROR_REASONS, mediaTimeSchema, stepFrames, type AgentPointer, type AgentTurn, type FrameRegion, type Generation, type MediaRange, type MediaTime, type Proposal, type SequencePreview } from '@ancs/contracts';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { applyAppearance, saveDeviceAppearance } from '@/lib/appearance';
import { useSession, useWorkspace } from '@/lib/queries';
import { useI18n } from '@/i18n/I18nProvider';
import type { Messages } from '@/i18n/messages';
import { QuietIcon } from '@/ui/QuietIcon';
import { StudioCanvas, type CanvasMode, type UploadProgress } from './StudioCanvas';
import { StudioConversation } from './StudioConversation';
import { StudioGenerationCards, visibleGenerations } from './StudioGenerationCards';
import { StudioExport } from './StudioExport';
import { StudioFootageDrawer } from './StudioFootageDrawer';
import { StudioDistillDrawer } from './StudioDistillDrawer';
import { StudioRuleGroup } from './StudioRuleGroup';
import { STRIP_ZOOM_LEVELS, StudioTimeStrip, nextStripZoom, type StripClip, type StripLane, type StudioSelection } from './StudioTimeStrip';
import { displaySeconds, formatClock, formatUsdMicros, frameTimeAtSeconds, framesPerSecond, pointerSecondsText } from './studio-time';
import { StudioShortcuts } from './StudioShortcuts';
import { StudioTasks, studioTaskRows, useStudioExports } from './StudioTasks';
import { StudioVoiceBar, VoiceToggle } from '@/voice/StudioVoiceBar';
import { useReplySpeech } from '@/voice/useReplySpeech';
import { useVoice } from '@/voice/useVoice';
import { studioKeys, useStrategyPacks, useStudioActions, useStudioPreview, useStudioState, useStudioTimeline, useStudioTurns, useTrialProposal, type StudioStrategyChoice } from './useStudio';
import styles from './studio.module.css';

/**
 * V6-1c 共看片室：作品画布 + 轻顶栏 + 底部（播放、时间带、对话）。
 * 用户在时间带上指出"哪里"，用一句话说"怎么改"；AI 的改动先成为试改（提案）并就地预览，
 * "就这样"才写入工程，之后还能整体撤销这次修改。所有规则在服务端，界面只经 SDK 读写。
 */

const ZERO: MediaTime = mediaTimeSchema.parse({ ticks: '0', timebase: { num: 1, den: 30 } });

/** 键盘处理读取的最新状态（每次渲染更新，监听只绑定一次） */
interface StudioKeyboardState {
  playhead: MediaTime;
  duration: MediaTime | null;
  canMark: boolean;
  overlayOpen: boolean;
  toggleMark: () => void;
  clearPointer: () => void;
}
const EDIT_ROLES = new Set(['OWNER', 'ADMIN', 'EDITOR']);

function uploadAssetType(file: File): 'SOURCE_IMAGE' | 'VOICE_AUDIO' | 'USER_UPLOAD' {
  return file.type.startsWith('image/') ? 'SOURCE_IMAGE' : file.type.startsWith('audio/') ? 'VOICE_AUDIO' : 'USER_UPLOAD';
}

function mutationErrorText(error: unknown, t: Messages['studio']): string {
  const described = describeError(error);
  if (described.kind === 'forbidden') return t.readOnly;
  const reason = described.details['reason'];
  if (reason === AGENT_ERROR_REASONS.TURN_IN_PROGRESS) return t.chat.errors.busy;
  if (reason === PROPOSAL_ERROR_REASONS.STALE_BASE || reason === PROPOSAL_ERROR_REASONS.HASH_MISMATCH) return t.chat.stale;
  return described.code === null ? t.chat.errors.generic : `${t.chat.errors.generic} (${described.code})`;
}

function generationErrorText(error: unknown, t: Messages['studio']): string {
  const described = describeError(error);
  if (described.kind === 'forbidden') return t.readOnly;
  const errors = t.generation.errors;
  switch (described.details['reason']) {
    case GENERATION_ERROR_REASONS.BUDGET_NOT_SET: return errors.budgetNotSet;
    case BUDGET_REJECTION_REASONS.BUDGET_EXCEEDED:
    case BUDGET_REJECTION_REASONS.PER_JOB_LIMIT: return errors.budgetExceeded;
    case GENERATION_ERROR_REASONS.QUOTE_EXPIRED: return errors.expired;
    case GENERATION_ERROR_REASONS.ESTIMATE_CHANGED:
    case GENERATION_ERROR_REASONS.QUOTE_NOT_PENDING: return errors.changed;
    case GENERATION_ERROR_REASONS.CONSENT_REQUIRED: return errors.consent;
    case AGENT_ERROR_REASONS.TURN_IN_PROGRESS: return errors.busy;
    default: return errors.generic;
  }
}

export function StudioRoom({ workspaceId, projectId }: { workspaceId: string; projectId: string }) {
  const { messages, locale, setLocale } = useI18n();
  const t = messages.studio;
  const client = useAncsClient();
  const queryClient = useQueryClient();
  const session = useSession();
  const workspace = useWorkspace(workspaceId);
  const canEdit = workspace.data === undefined ? true : EDIT_ROLES.has(workspace.data.role);

  const stateQuery = useStudioState(workspaceId, projectId);
  const state = stateQuery.data;
  const { timeline } = useStudioTimeline(projectId, state?.sequenceId, state?.project.revision);
  const turnsQuery = useStudioTurns(workspaceId, state?.session?.id ?? null);
  // 审片里对单条批注的讨论不进入共看片室的对话（一次执行的那一轮会进入：它产生的试改可以在这里继续微调）
  const turns = useMemo(() => (turnsQuery.data ?? []).filter((item) => item.purpose !== 'DISCUSS_NOTE'), [turnsQuery.data]);
  const latest = turns[0];
  // 试改 = 最近一轮带提案的完成轮次的提案（AI 正在继续改它时，仍显示这一版，直到新试改取代它）
  const trialTurn = turns.find((item) => item.status === 'COMPLETED' && item.proposalId !== null);
  const proposalQuery = useTrialProposal(workspaceId, projectId, trialTurn);
  const proposal = proposalQuery.data ?? null;
  const trial = proposal?.status === 'OPEN' ? proposal : null;
  const actions = useStudioActions(workspaceId, projectId);
  // 一轮结束（完成/失败/取消）→ 刷新工作台状态（本条视频的 AI 成本随之更新）
  const latestDone = latest !== undefined && latest.status !== 'RUNNING' ? latest.id : null;
  useEffect(() => {
    if (latestDone !== null) void queryClient.invalidateQueries({ queryKey: studioKeys.state(workspaceId, projectId) });
  }, [latestDone, queryClient, workspaceId, projectId]);

  const hasClips = (timeline?.clips.length ?? 0) > 0;
  const revision = state?.project.revision;
  const previewTarget = useMemo(() => (revision === undefined ? null
    : trial !== null ? { revision, proposalId: trial.proposalId }
      : hasClips ? { revision, proposalId: null } : null), [revision, trial, hasClips]);
  const preview = useStudioPreview(workspaceId, projectId, state?.sequenceId, previewTarget);
  const targetPreview = previewTarget === null ? null : preview.preview.data ?? null;

  // 正在显示的预览：目标预览就绪才切换（渲染新预览时继续显示上一个画面）
  const [shown, setShown] = useState<SequencePreview | null>(null);
  const reloadRef = useRef(false);
  useEffect(() => {
    if (previewTarget === null) { setShown(null); return; }
    if (targetPreview?.status !== 'READY' || targetPreview.playbackUrl === null) return;
    setShown((current) => {
      if (current?.id === targetPreview.id && !reloadRef.current) return current;
      reloadRef.current = false;
      return targetPreview;
    });
  }, [previewTarget, targetPreview]);

  // 时间带显示的就是正在看的那一版：试改时取试改预览的计划（片段 id 与采用后一致），否则取工程当前版本
  const trialView = trial !== null && targetPreview !== null && targetPreview.proposalId === trial.proposalId ? targetPreview : null;
  // 试改改了哪里：服务端 A/B 对照（真实片段与区间，只读）；只标内容 / 素材 / 时长有变化的片段，单纯被挤后的位移不算
  const compareQuery = useQuery({
    queryKey: ['studio', 'compare', workspaceId, projectId, trial?.proposalId ?? 'none'],
    queryFn: () => client.projects.compareProposal(workspaceId, projectId, trial?.proposalId ?? '', { againstProposalId: null, axes: ['CONTENT', 'ASSET', 'DURATION'] }),
    enabled: trialView !== null,
    staleTime: Infinity,
    retry: false,
  });
  const trialChanges = useMemo(() => (trialView === null ? [] : (compareQuery.data?.diffs ?? [])
    .filter((diff) => diff.objectKind === 'CLIP' && (diff.change === 'ADDED' || diff.change === 'CHANGED') && diff.afterSequenceRange !== null)
    .map((diff) => diff.afterSequenceRange as MediaRange)), [trialView, compareQuery.data]);
  // 特效图层（V6-3）：资产版本 → 特效名；时间带给特效轨与片段标名
  const effectNames = useMemo(() => new Map((state?.effects ?? []).map((effect) => [effect.footageId, effect.name])), [state?.effects]);
  // 讲述配音（V6-5）：资产版本 → 讲述稿开头；时间带给讲述轨与片段标名
  const narrationTexts = useMemo(() => new Map((state?.narration ?? []).map((item) => [item.footageId, item.text.length > 40 ? `${item.text.slice(0, 39)}…` : item.text])), [state?.narration]);
  const strip = useMemo(() => {
    if (timeline === null) return null;
    const lanes: StripLane[] = [
      ...(timeline.videoTrackId === null ? [] : [{ trackId: timeline.videoTrackId, kind: 'VIDEO' as const }]),
      ...(timeline.audioTrackId === null ? [] : [{ trackId: timeline.audioTrackId, kind: 'AUDIO' as const }]),
    ];
    const kindOf = new Map(lanes.map((lane) => [lane.trackId, lane.kind]));
    const clips: StripClip[] = trialView !== null
      ? trialView.clips.map((clip) => ({ id: clip.clipId, trackId: clip.trackId, kind: clip.kind, assetVersionId: clip.sourceVersionId, sequenceRange: clip.sequenceRange }))
      : timeline.clips.flatMap((clip) => {
        const kind = kindOf.get(clip.trackId) ?? timeline.trackKinds.get(clip.trackId);
        return kind === undefined ? [] : [{ id: clip.id, trackId: clip.trackId, kind, assetVersionId: clip.assetVersionId, sequenceRange: clip.sequenceRange }];
      });
    for (const clip of clips) {
      if (!kindOf.has(clip.trackId)) { kindOf.set(clip.trackId, clip.kind); lanes.push({ trackId: clip.trackId, kind: clip.kind }); }
    }
    for (const lane of lanes) {
      const laneClips = clips.filter((clip) => clip.trackId === lane.trackId);
      if (lane.kind === 'VIDEO' && laneClips.length > 0 && laneClips.every((clip) => clip.assetVersionId !== null && effectNames.has(clip.assetVersionId))) lane.effect = true;
      if (lane.kind === 'AUDIO' && laneClips.length > 0 && laneClips.every((clip) => clip.assetVersionId !== null && narrationTexts.has(clip.assetVersionId))) lane.narration = true;
    }
    // 自上而下：特效轨（叠在画面上）→ 画面 → 讲述 → 声音
    const rank = (lane: StripLane): number => (lane.effect === true ? 0 : lane.kind === 'VIDEO' ? 1 : lane.narration === true ? 2 : 3);
    lanes.sort((left, right) => rank(left) - rank(right));
    return { duration: trialView?.duration ?? timeline.duration, frameRate: timeline.frameRate, lanes, clips };
  }, [timeline, trialView, effectNames, narrationTexts]);

  // 播放
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const frameRate = timeline?.frameRate ?? { num: 30, den: 1 };
  const [playhead, setPlayhead] = useState<MediaTime>(ZERO);
  const [playing, setPlaying] = useState(false);
  const syncFromVideo = useCallback(() => {
    const video = videoRef.current;
    if (video !== null) setPlayhead(frameTimeAtSeconds(video.currentTime, frameRate));
  }, [frameRate]);
  useEffect(() => {
    if (!playing) return;
    let handle = requestAnimationFrame(function tick() { syncFromVideo(); handle = requestAnimationFrame(tick); });
    return () => cancelAnimationFrame(handle);
  }, [playing, syncFromVideo]);
  const seek = useCallback((time: MediaTime) => {
    setPlayhead(time);
    const video = videoRef.current;
    if (video !== null && Number.isFinite(video.duration)) video.currentTime = Math.min(displaySeconds(time), video.duration);
  }, []);
  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (video === null) return;
    if (video.paused) void video.play().catch(() => undefined);
    else video.pause();
  }, []);
  // 键盘（V6 界面精修第二阶段）：空格播放、方向键逐帧 / Shift 按秒、Home/End、M 框选、/ 跟 AI 说、Esc 清除、? 快捷键列表；
  // 按住 Ctrl / ⌘ 半秒显示快捷键（松开即收起）。正在输入、浮层打开或组合键时不接管。每次渲染把最新状态放进 ref，监听只绑一次。
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [zoom, setZoom] = useState<number>(STRIP_ZOOM_LEVELS[0]);
  const [shortcutsHeld, setShortcutsHeld] = useState(false);
  const keyboard = useRef<StudioKeyboardState>({ playhead: ZERO, duration: null, canMark: false, overlayOpen: false, toggleMark: () => undefined, clearPointer: () => undefined });
  useEffect(() => {
    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    const stopHold = () => {
      if (holdTimer !== null) clearTimeout(holdTimer);
      holdTimer = null;
      setShortcutsHeld(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Control' || event.key === 'Meta') {
        if (!event.repeat && holdTimer === null) holdTimer = setTimeout(() => setShortcutsHeld(true), 500);
        return;
      }
      stopHold();
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [role="slider"], [contenteditable="true"]')) return;
      const state = keyboard.current;
      if (event.key === 'Escape') {
        if (!state.overlayOpen) state.clearPointer();
        setShortcutsOpen(false);
        return;
      }
      if (event.key === '?') {
        event.preventDefault();
        setShortcutsOpen((open) => !open);
        return;
      }
      if (state.overlayOpen) return;
      const moveTo = (time: MediaTime) => {
        event.preventDefault();
        videoRef.current?.pause();
        seek(time);
      };
      switch (event.key) {
        case ' ':
          if (target?.closest('button, a')) return;
          event.preventDefault();
          togglePlay();
          return;
        case 'ArrowLeft':
        case 'ArrowRight': {
          const frames = event.shiftKey ? framesPerSecond(frameRate) : 1;
          moveTo(stepFrames({ time: state.playhead, frameRate, delta: event.key === 'ArrowLeft' ? -frames : frames, ...(state.duration === null ? {} : { bounds: { start: ZERO, end: state.duration } }) }));
          return;
        }
        case 'Home':
          moveTo(ZERO);
          return;
        case 'End':
          if (state.duration !== null) moveTo(stepFrames({ time: state.duration, frameRate, delta: 0, bounds: { start: ZERO, end: state.duration } }));
          return;
        case 'm':
        case 'M':
          if (!state.canMark) return;
          event.preventDefault();
          state.toggleMark();
          return;
        case '+':
        case '=':
          event.preventDefault();
          setZoom((current) => nextStripZoom(current, 1));
          return;
        case '-':
        case '_':
          event.preventDefault();
          setZoom((current) => nextStripZoom(current, -1));
          return;
        case '0':
          event.preventDefault();
          setZoom(STRIP_ZOOM_LEVELS[0]);
          return;
        case '/': {
          const input = document.querySelector<HTMLTextAreaElement>('[data-composer-input]');
          if (input === null || input.disabled) return;
          event.preventDefault();
          input.focus();
          return;
        }
        default:
      }
    };
    const onKeyUp = (event: KeyboardEvent) => { if (event.key === 'Control' || event.key === 'Meta') stopHold(); };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', stopHold);
    return () => {
      if (holdTimer !== null) clearTimeout(holdTimer);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', stopHold);
    };
  }, [togglePlay, seek, frameRate]);

  // 指：时间带选择 → 交给 AI 的 pointer
  const [selection, setSelection] = useState<StudioSelection>({ range: null, clipId: null });
  // 付费生成的片段（V6-7/V6-8）按类型标名（"数字人出镜"等）
  const generatedNames = useMemo(() => new Map((state?.generations ?? []).flatMap((item) => (item.footageId === null ? [] : [[item.footageId, t.generation.kinds[item.kind]] as const]))), [state?.generations, t]);
  const footageName = useCallback((clip: StripClip): string => (clip.assetVersionId === null ? undefined : effectNames.get(clip.assetVersionId) ?? narrationTexts.get(clip.assetVersionId) ?? generatedNames.get(clip.assetVersionId))
    ?? state?.footage.find((item) => item.footageId === clip.assetVersionId)?.name ?? clip.id.slice(-6), [state?.footage, effectNames, narrationTexts, generatedNames]);
  // 指画面（V6-3）：在画面上框出一块区域，和时间选择一起交给 AI；框的是哪一刻的画面也记下（没选时间时以它为"这里"的时间）
  const [framed, setFramed] = useState<{ region: FrameRegion; at: MediaTime } | null>(null);
  const frameRegion = framed?.region ?? null;
  const [drawing, setDrawing] = useState(false);
  const selectedClip = selection.clipId === null ? null : strip?.clips.find((clip) => clip.id === selection.clipId) ?? null;
  useEffect(() => {
    if (selection.clipId !== null && strip !== null && selectedClip === null) setSelection({ range: null, clipId: null });
  }, [selection.clipId, selectedClip, strip]);
  // 只框了画面、没选时间或片段：时间取框选时那一帧起的 1 秒
  const framedRange = framed === null || selection.range !== null || selectedClip !== null ? null
    : { start: framed.at, end: frameTimeAtSeconds(displaySeconds(framed.at) + 1, frameRate) };
  const pointer: AgentPointer = {
    timeRange: selection.range !== null ? { start: pointerSecondsText(selection.range.start), end: pointerSecondsText(selection.range.end) }
      : framedRange !== null ? { start: pointerSecondsText(framedRange.start), end: pointerSecondsText(framedRange.end) } : null,
    clipIds: selectedClip === null ? [] : [selectedClip.id],
    frameRegion,
  };
  const timeLabel = selection.range !== null
    ? t.pointer.range(formatClock(selection.range.start), formatClock(selection.range.end))
    : selectedClip !== null ? t.pointer.clip(footageName(selectedClip)) : framed !== null ? formatClock(framed.at) : null;
  const pointerLabel = frameRegion === null ? timeLabel : timeLabel === null ? t.pointer.region : t.pointer.regionWith(timeLabel);

  // 风格（可选）：默认不选；选择只在本页面内保留
  const strategies = useStrategyPacks(workspaceId);
  const [strategy, setStrategy] = useState<StudioStrategyChoice | null>(null);

  // 说
  const [notice, setNotice] = useState<'discarded' | 'undone' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [pendingGeneration, setPendingGeneration] = useState<string | null>(null);
  const voiceTurns = useRef(new Set<string>());
  const send = (message: string, override?: { pointer: AgentPointer; byVoice: boolean }) => {
    if (state === undefined) return;
    setNotice(null);
    setActionError(null);
    actions.send.mutate({ state, message, pointer: override?.pointer ?? pointer, locale, strategy }, {
      onSuccess: ({ turn }) => { if (override?.byVoice === true) voiceTurns.current.add(turn.id); },
      onError: (error) => setActionError(mutationErrorText(error, t)),
    });
  };

  // 说（V6-2）：语音一句话说完 → 带着按发话时刻绑定的指向，作为一轮对话发出；开口即打断 AI 的朗读
  const speech = useReplySpeech(locale);
  const [readAloud, setReadAloud] = useState(true);
  const voice = useVoice({
    workspaceId, projectId, locale,
    onUtterance: ({ text, attention }) => send(text, { pointer: attention.pointer, byVoice: true }),
    onSpeechStart: speech.stop,
  });
  const pointerKey = JSON.stringify(pointer);
  const playheadSeconds = displaySeconds(playhead);
  const { notePointer } = voice;
  useEffect(() => {
    if (voice.state === 'listening') notePointer(JSON.parse(pointerKey) as AgentPointer, shown === null ? null : playheadSeconds, pointerLabel);
  }, [voice.state, notePointer, pointerKey, playheadSeconds, pointerLabel, shown]);
  // 用语音发出的那一轮有了回应 → 朗读（只读一次）
  const spoken = useRef(new Set<string>());
  useEffect(() => {
    for (const turn of turns) {
      if (!voiceTurns.current.has(turn.id) || spoken.current.has(turn.id) || turn.status === 'RUNNING') continue;
      spoken.current.add(turn.id);
      if (readAloud && turn.reply !== null) speech.speak(turn.reply);
    }
  }, [turns, readAloud, speech]);
  const voiceAttentionLabel = (() => {
    const attention = voice.attention;
    if (attention === null) return null;
    if (attention.label !== null) return attention.label;
    const clip = attention.pointer.clipIds.length > 0 ? strip?.clips.find((item) => item.id === attention.pointer.clipIds[0]) : undefined;
    if (clip !== undefined) return t.pointer.clip(footageName(clip));
    const range = attention.pointer.timeRange;
    return range === null ? null : t.pointer.range(formatClock(frameTimeAtSeconds(Number(range.start), frameRate)), formatClock(frameTimeAtSeconds(Number(range.end), frameRate)));
  })();
  const stop = (turn: AgentTurn) => actions.cancel.mutate(turn, { onError: (error) => setActionError(mutationErrorText(error, t)) });
  const acceptGeneration = (generation: Generation) => {
    setGenerationError(null);
    setPendingGeneration(generation.id);
    actions.acceptGeneration.mutate(generation, {
      onError: (error) => setGenerationError(generationErrorText(error, t)),
      onSettled: () => setPendingGeneration(null),
    });
  };
  const declineGeneration = (generation: Generation) => {
    setGenerationError(null);
    setPendingGeneration(generation.id);
    actions.declineGeneration.mutate(generation, {
      onError: (error) => setGenerationError(generationErrorText(error, t)),
      onSettled: () => setPendingGeneration(null),
    });
  };
  const keep = (target: Proposal) => {
    setActionError(null);
    actions.adopt.mutate(target, { onError: (error) => setActionError(mutationErrorText(error, t)) });
  };
  const discard = (target: Proposal) => {
    setActionError(null);
    actions.discard.mutate(target, { onSuccess: () => setNotice('discarded'), onError: (error) => setActionError(mutationErrorText(error, t)) });
  };
  const undoChange = () => {
    setActionError(null);
    actions.undoChange.mutate(undefined, {
      onSuccess: () => {
        setNotice('undone');
        if (proposal !== null) void queryClient.invalidateQueries({ queryKey: studioKeys.proposal(workspaceId, proposal.proposalId) });
      },
      onError: (error) => setActionError(mutationErrorText(error, t)),
    });
  };
  const canUndoChange = proposal?.status === 'COMMITTED' && proposal.committedRevision !== null && proposal.committedRevision === revision && notice !== 'undone';

  // 素材上传
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [uploads, setUploads] = useState<UploadProgress[]>([]);
  const [footageOpen, setFootageOpen] = useState(false);
  const [distillOpen, setDistillOpen] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);
  const exportsQuery = useStudioExports(workspaceId, projectId);
  const upload = (files: File[]) => {
    for (const file of files) {
      const id = `${file.name}-${String(file.size)}-${String(file.lastModified)}-${globalThis.crypto.randomUUID()}`;
      setUploads((current) => [...current, { id, name: file.name, percent: 0, failed: false }]);
      const update = (patch: Partial<UploadProgress>) => setUploads((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
      void client.assets.uploadResumable(workspaceId, {
        assetType: uploadAssetType(file), filename: file.name, contentType: file.type || 'application/octet-stream', data: file, projectId,
      }, {
        concurrency: 3,
        onIntent: () => void queryClient.invalidateQueries({ queryKey: studioKeys.state(workspaceId, projectId) }),
        onProgress: ({ uploadedBytes, totalBytes }) => update({ percent: totalBytes === 0 ? 0 : Math.round((uploadedBytes / totalBytes) * 100) }),
      }).then(async () => {
        setUploads((current) => current.filter((item) => item.id !== id));
        await queryClient.invalidateQueries({ queryKey: studioKeys.state(workspaceId, projectId) });
      }, () => update({ failed: true }));
    }
  };

  const [exportOpen, setExportOpen] = useState(false);
  const toggleTheme = () => {
    const next = document.body.classList.contains('theme-dark') ? 'light' : 'dark';
    applyAppearance(next);
    const userId = session.data?.user?.id;
    if (userId) saveDeviceAppearance(userId, next);
  };

  keyboard.current = {
    playhead,
    duration: strip?.duration ?? null,
    canMark: shown !== null && canEdit,
    overlayOpen: exportOpen || footageOpen || distillOpen || tasksOpen,
    toggleMark: () => { if (!drawing) videoRef.current?.pause(); setDrawing(!drawing); },
    clearPointer: () => { setSelection({ range: null, clipId: null }); setFramed(null); setDrawing(false); },
  };

  if (stateQuery.isPending) {
    return <div className={styles['room']} lang={locale}><div /><div className={styles['stage']}><div className={styles['stageStatus']}><div role="status"><span className={styles['spinner']} aria-hidden="true" />{t.loading}</div></div></div></div>;
  }
  if (stateQuery.isError || state === undefined) {
    const error = describeError(stateQuery.error);
    const missingSequence = error.details['reason'] === 'STUDIO_SEQUENCE_MISSING';
    const signedOut = error.kind === 'unauthenticated';
    return (
      <div className="page narrow" lang={locale}>
        <div className="panel pad mt32" role="alert">
          <h2>{signedOut ? t.signInRequired : error.kind === 'notFound' ? t.notFound : missingSequence ? t.noSequence : t.loadFailed}</h2>
          {signedOut ? null : <p className="muted mt8">{error.kind === 'notFound' ? t.notFoundBody : missingSequence ? t.noSequenceBody : error.message}</p>}
          <div className="row mt24">
            {signedOut ? <Link className="btn primary" href="/sign-in">{t.signIn}</Link>
              : missingSequence ? <Link className="btn primary" href={`/w/${workspaceId}/p/${projectId}/storyboard`}>{t.openLegacy}</Link>
                : <button type="button" className="btn primary" onClick={() => void stateQuery.refetch()}>{messages.common.retry}</button>}
            <Link className="btn" href={`/?workspaceId=${encodeURIComponent(workspaceId)}`}>{t.back}</Link>
          </div>
        </div>
      </div>
    );
  }

  const readyFootage = state.footage.some((item) => item.status === 'READY');
  const busyFootage = state.footage.some((item) => item.status === 'UPLOADING' || item.status === 'PROCESSING') || uploads.some((item) => !item.failed);
  const article = state.project.article;
  const mode: CanvasMode = hasClips || trial !== null ? 'video' : readyFootage ? 'noCut' : busyFootage ? 'processing' : article !== null ? 'article' : 'empty';
  const running = latest?.status === 'RUNNING';
  const cost = state.cost;
  const taskRows = studioTaskRows({
    footage: state.footage,
    generations: state.generations,
    exports: exportsQuery.data ?? [],
    turn: latest,
    t,
    formatTime: (iso) => new Date(iso).toLocaleString(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }),
  });
  const activeTasks = taskRows.filter((row) => row.status === 'running').length;
  const failedTasks = taskRows.filter((row) => row.status === 'failed').length;

  return (
    <div className={styles['room']} lang={locale}>
      <header className={styles['topbar']}>
        <Link className="btn icononly ghost small" href={`/?workspaceId=${encodeURIComponent(workspaceId)}`} aria-label={t.back}><QuietIcon name="chevron" style={{ transform: 'rotate(180deg)' }} /></Link>
        <div className={styles['titleGroup']}>
          <h1 className={styles['title']} title={state.project.title}>{state.project.title}</h1>
          <span className={styles['meta']} title={t.revision(state.project.revision)} data-revision={state.project.revision}><QuietIcon name="check" className={styles['metaIcon']} />{t.saved}</span>
        </div>
        <span className={styles['spacer']} />
        <div className={styles['topActions']}>
          {cost.turns > 0 ? <span className={styles['meta']} title={t.aiCostHint}>{cost.costMicros === null ? t.aiCostUnpriced : t.aiCost(formatUsdMicros(cost.costMicros))}</span> : null}
          <StudioRuleGroup
            label={t.rulesLabel}
            rules={[
              {
                key: 'effects',
                pressed: state.project.allowEffects,
                disabled: !canEdit || actions.setEffectsAllowed.isPending,
                title: state.project.allowEffects ? t.effects.hintOn : t.effects.hintOff,
                icon: <QuietIcon name="spark" />,
                label: state.project.allowEffects ? t.effects.on : t.effects.off,
                onToggle: () => {
                  setActionError(null);
                  actions.setEffectsAllowed.mutate(!state.project.allowEffects, { onError: () => setActionError(t.effects.failed) });
                },
              },
              {
                key: 'narration',
                pressed: state.project.allowNarration,
                disabled: !canEdit || actions.setNarrationAllowed.isPending,
                title: state.project.allowNarration ? t.narration.hintOn : t.narration.hintOff,
                icon: <QuietIcon name="voice" />,
                label: state.project.allowNarration ? t.narration.on : t.narration.off,
                onToggle: () => {
                  setActionError(null);
                  actions.setNarrationAllowed.mutate(!state.project.allowNarration, { onError: () => setActionError(t.narration.failed) });
                },
              },
              {
                key: 'generation',
                pressed: state.project.allowGeneratedVideo,
                disabled: !canEdit || actions.setGenerationAllowed.isPending,
                title: state.project.allowGeneratedVideo ? t.generation.hintOn : t.generation.hintOff,
                icon: <QuietIcon name="film" />,
                label: state.project.allowGeneratedVideo ? t.generation.on : t.generation.off,
                onToggle: () => {
                  setActionError(null);
                  actions.setGenerationAllowed.mutate(!state.project.allowGeneratedVideo, { onError: () => setActionError(t.generation.failed) });
                },
              },
            ]}
          />
          <span className={styles['divider']} aria-hidden="true" />
          <Link className="btn small ghost" href={`/w/${workspaceId}/review/${projectId}`}><QuietIcon name="check" />{t.reviewButton}</Link>
          <button type="button" className="btn small ghost" aria-expanded={footageOpen} onClick={() => { setDistillOpen(false); setTasksOpen(false); setFootageOpen(!footageOpen); }}><QuietIcon name="layers" />{t.footageButton(state.footage.length)}</button>
          <button type="button" className="btn small ghost" aria-expanded={tasksOpen} aria-label={t.tasks.buttonAria(activeTasks, failedTasks)} onClick={() => { setDistillOpen(false); setFootageOpen(false); if (!tasksOpen) void exportsQuery.refetch(); setTasksOpen(!tasksOpen); }}><QuietIcon name="clock" />{t.tasks.button(activeTasks)}{failedTasks > 0 ? <span className={styles['tasksButtonDot']} aria-hidden="true" /> : null}</button>
          <span className={styles['divider']} aria-hidden="true" />
          <button type="button" className="btn small ghost" aria-label={messages.common.switchLanguageAria} onClick={() => setLocale(locale === 'zh-CN' ? 'en' : 'zh-CN')}><QuietIcon name="globe" />{messages.common.switchLanguage}</button>
          <button type="button" className="btn icononly ghost small" aria-label={messages.common.toggleTheme} onClick={toggleTheme}><QuietIcon name="sun" /></button>
        </div>
        <div className={styles['exportSlot']}>
          <button type="button" className="btn primary small" aria-expanded={exportOpen} onClick={() => setExportOpen(!exportOpen)}><QuietIcon name="download" />{t.exportButton}</button>
        </div>
      </header>

      <StudioCanvas
        aspectRatio={state.project.aspectRatio}
        mode={mode}
        videoRef={videoRef}
        shown={shown}
        target={targetPreview}
        targetFailed={targetPreview?.status === 'FAILED' || preview.request.isError}
        trial={trial !== null && shown?.proposalId === trial.proposalId}
        seconds={displaySeconds(playhead)}
        uploads={uploads}
        canEdit={canEdit}
        firstCutBusy={running || actions.send.isPending}
        onAddFootage={() => fileInput.current?.click()}
        onDropFiles={upload}
        onFirstCut={() => send(article !== null ? t.canvas.articleFirstCutPrompt : t.canvas.firstCutPrompt)}
        articleParagraphs={article?.paragraphs ?? 0}
        onRetryPreview={preview.retry}
        onVideoError={() => { reloadRef.current = true; preview.refresh(); }}
        onTimeUpdate={syncFromVideo}
        onLoaded={() => { const video = videoRef.current; if (video !== null) video.currentTime = Math.min(displaySeconds(playhead), video.duration || 0); }}
        onPlayState={setPlaying}
        region={frameRegion}
        drawing={drawing}
        onRegion={(region) => { setFramed({ region, at: playhead }); setDrawing(false); }}
      />

      <div className={styles['dock']}>
        <div className={styles['transport']}>
          <button type="button" className={`btn icononly small ${styles['play']}`} aria-label={playing ? t.transport.pause : t.transport.play} title={t.transport.playHint} aria-keyshortcuts="Space" disabled={shown === null} onClick={togglePlay}>
            <QuietIcon name={playing ? 'pause' : 'play'} />
          </button>
          <span className={styles['clock']} aria-label={t.transport.position}>{formatClock(playhead)} <span>/ {strip === null ? '--:--.-' : formatClock(strip.duration)}</span></span>
          {shown !== null && canEdit ? (
            <button type="button" className="btn small ghost" aria-pressed={drawing} title={t.canvas.markAreaHint} aria-keyshortcuts="M" onClick={() => { if (!drawing) videoRef.current?.pause(); setDrawing(!drawing); }}>
              <QuietIcon name="expand" />{drawing ? t.canvas.markAreaActive : t.canvas.markArea}
            </button>
          ) : null}
          <span className={styles['spacer']} />
          {shown !== null && shown.segments.reused > 0 ? <span className={styles['meta']}>{t.canvas.reused(shown.segments.reused, shown.segments.total)}</span> : null}
          {trialChanges.length > 0 ? <span className={styles['meta']}>{t.strip.changes(trialChanges.length)}</span> : null}
          {strip !== null ? (
            <div className={styles['zoom']} role="group" aria-label={t.strip.zoomLevel}>
              <button type="button" className="btn small ghost" aria-label={t.strip.zoomOut} aria-keyshortcuts="-" disabled={zoom <= STRIP_ZOOM_LEVELS[0]} onClick={() => setZoom(nextStripZoom(zoom, -1))}>−</button>
              <span className={styles['zoomLevel']} aria-live="polite">{`${String(zoom)}×`}</span>
              <button type="button" className="btn small ghost" aria-label={t.strip.zoomIn} aria-keyshortcuts="+" disabled={zoom >= STRIP_ZOOM_LEVELS[STRIP_ZOOM_LEVELS.length - 1]!} onClick={() => setZoom(nextStripZoom(zoom, 1))}>+</button>
              <button type="button" className="btn small ghost" aria-keyshortcuts="0" disabled={zoom === STRIP_ZOOM_LEVELS[0]} onClick={() => setZoom(STRIP_ZOOM_LEVELS[0])}>{t.strip.zoomFit}</button>
            </div>
          ) : null}
          <button type="button" className={`textbtn small ${styles['shortcutsButton']}`} aria-expanded={shortcutsOpen} aria-keyshortcuts="Shift+?" title={t.shortcuts.openHint} onClick={() => setShortcutsOpen(!shortcutsOpen)}>{t.shortcuts.open}</button>
        </div>
        {strip !== null ? (
          <StudioTimeStrip
            duration={strip.duration}
            frameRate={strip.frameRate}
            lanes={strip.lanes}
            clips={strip.clips}
            clipLabel={footageName}
            playhead={playhead}
            selection={selection}
            onSeek={seek}
            onSelectionChange={setSelection}
            zoom={zoom}
            onZoomChange={setZoom}
            changes={trialChanges}
          />
        ) : null}
        <StudioConversation
          turns={turns}
          proposal={proposal}
          canUndoChange={canUndoChange}
          notice={notice === null ? null : t.chat[notice]}
          error={actionError}
          pointerLabel={pointerLabel}
          canEdit={canEdit}
          sending={actions.send.isPending}
          cancelling={actions.cancel.isPending}
          adopting={actions.adopt.isPending}
          discarding={actions.discard.isPending}
          undoing={actions.undoChange.isPending}
          onClearPointer={() => { setSelection({ range: null, clipId: null }); setFramed(null); setDrawing(false); }}
          onSend={send}
          onStop={stop}
          onKeep={keep}
          onDiscard={discard}
          onUndoChange={undoChange}
          strategies={strategies.data ?? []}
          strategy={strategy}
          onStrategyChange={setStrategy}
          onLearnStrategy={() => { setFootageOpen(false); setTasksOpen(false); setDistillOpen(true); }}
          generationCards={(
            <StudioGenerationCards
              generations={visibleGenerations(state.generations)}
              budget={state.generationBudget}
              workspaceId={workspaceId}
              canEdit={canEdit}
              pendingId={pendingGeneration}
              error={generationError}
              onAccept={acceptGeneration}
              onDecline={declineGeneration}
            />
          )}
          voiceBar={(
            <StudioVoiceBar
              state={voice.state}
              error={voice.error}
              partial={voice.partial}
              held={voice.held}
              attention={voice.attention}
              attentionLabel={voiceAttentionLabel}
              scripted={voice.asr !== null && voice.asr.implementation !== 'REAL'}
              level={voice.level}
              readAloud={{ supported: speech.supported, enabled: readAloud, speaking: speech.speaking, onToggle: setReadAloud, onStop: speech.stop }}
            />
          )}
          voiceToggle={<VoiceToggle state={voice.state} disabled={!canEdit} onStart={() => void voice.start()} onStop={voice.stop} />}
        />
        {!canEdit ? <p className={styles['meta']}>{t.readOnly}</p> : null}
      </div>

      <input
        ref={fileInput}
        type="file"
        multiple
        accept="video/*,audio/*,image/*"
        className={styles['visuallyHidden']}
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => { upload(Array.from(event.target.files ?? [])); event.target.value = ''; }}
      />
      {distillOpen ? (
        <StudioDistillDrawer
          workspaceId={workspaceId}
          canEdit={canEdit}
          onClose={() => setDistillOpen(false)}
          onUse={(pack) => { setStrategy({ packId: pack.id, knobs: Object.fromEntries(pack.knobs.map((knob) => [knob.key, knob.defaultValue])) }); setDistillOpen(false); }}
        />
      ) : null}
      {tasksOpen ? <StudioTasks rows={taskRows} loadFailed={exportsQuery.isError} onClose={() => setTasksOpen(false)} /> : null}
      {footageOpen ? <StudioFootageDrawer footage={state.footage} uploads={uploads} canEdit={canEdit} identityHref={`/w/${workspaceId}/studio/identity`} onAdd={() => fileInput.current?.click()} onClose={() => setFootageOpen(false)} /> : null}
      <StudioShortcuts open={shortcutsOpen} held={shortcutsHeld} onClose={() => setShortcutsOpen(false)} />
      {exportOpen ? (
        <StudioExport
          workspaceId={workspaceId}
          projectId={projectId}
          sequenceId={state.sequenceId}
          aspectRatio={state.project.aspectRatio}
          revision={state.project.revision}
          hasContent={hasClips}
          canEdit={canEdit}
          onClose={() => setExportOpen(false)}
        />
      ) : null}
    </div>
  );
}
