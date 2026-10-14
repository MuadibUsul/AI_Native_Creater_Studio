'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { WORKFLOW_TERMINAL_STATUSES, type AgentTurn, type Generation, type StudioState, type WorkflowRun } from '@ancs/contracts';
import { useAncsClient } from '@/lib/client';
import { useI18n } from '@/i18n/I18nProvider';
import type { Messages } from '@/i18n/messages';
import { QuietIcon } from '@/ui/QuietIcon';
import styles from './studio.module.css';
import { studioKeys } from './useStudio';

/**
 * 任务中心（界面精修第三阶段）：把这条视频的长任务放在一处——素材处理、付费生成、导出、AI 这一轮。
 * 全部来自服务端已授权的只读投影（工作室状态、导出运行列表、对话轮次），所以刷新页面后仍在；这里不发起、不重试任何任务。
 */

export type TaskStatus = 'running' | 'attention' | 'failed' | 'done';
export interface TaskRow { key: string; group: 'footage' | 'generation' | 'export' | 'ai'; title: string; status: TaskStatus; detail: string | null }

type Text = Messages['studio'];

const RUNNING_RUNS = new Set<WorkflowRun['status']>(['RUNNING', 'WAITING_HUMAN', 'CANCEL_REQUESTED']);

/** 纯函数：把服务端状态整理成任务行（可单测） */
export function studioTaskRows(input: { footage: StudioState['footage']; generations: Generation[]; exports: WorkflowRun[]; turn: AgentTurn | undefined; t: Text; formatTime: (iso: string) => string }): TaskRow[] {
  const { t } = input;
  const rows: TaskRow[] = [];
  for (const item of input.footage) {
    const understanding = Object.entries(item.understanding);
    if (item.status === 'UPLOADING' || item.status === 'PROCESSING') rows.push({ key: `f-${item.assetId}`, group: 'footage', title: item.name, status: 'running', detail: t.tasks.footageProcessing });
    else if (item.status === 'FAILED') rows.push({ key: `f-${item.assetId}`, group: 'footage', title: item.name, status: 'failed', detail: t.tasks.footageFailed });
    else if (understanding.some(([, value]) => value === 'WORKING')) rows.push({ key: `f-${item.assetId}`, group: 'footage', title: item.name, status: 'running', detail: t.tasks.understanding });
  }
  const readyFootage = input.footage.filter((item) => item.status === 'READY').length;
  if (readyFootage > 0) rows.push({ key: 'f-ready', group: 'footage', title: t.tasks.footageReady(readyFootage), status: 'done', detail: null });
  for (const item of input.generations) {
    const title = `${t.generation.kinds[item.kind]} · ${item.summary}`;
    if (item.status === 'RUNNING') rows.push({ key: `g-${item.id}`, group: 'generation', title, status: 'running', detail: t.generation.running });
    else if (item.status === 'QUOTED') rows.push({ key: `g-${item.id}`, group: 'generation', title, status: 'attention', detail: t.tasks.quoteWaiting });
    else if (item.status === 'NEEDS_RECONCILIATION') rows.push({ key: `g-${item.id}`, group: 'generation', title, status: 'attention', detail: t.generation.reconciliation });
    else if (item.status === 'FAILED') rows.push({ key: `g-${item.id}`, group: 'generation', title, status: 'failed', detail: t.tasks.generationFailed });
    else if (item.status === 'SUCCEEDED') rows.push({ key: `g-${item.id}`, group: 'generation', title, status: 'done', detail: null });
  }
  for (const run of input.exports.slice(0, 5)) {
    const title = t.tasks.exportAt(input.formatTime(run.createdAt));
    if (RUNNING_RUNS.has(run.status)) rows.push({ key: `e-${run.id}`, group: 'export', title, status: 'running', detail: t.tasks.exportRunning });
    else if (run.status === 'FAILED') rows.push({ key: `e-${run.id}`, group: 'export', title, status: 'failed', detail: t.tasks.exportFailed });
    else if (run.status === 'SUCCEEDED') rows.push({ key: `e-${run.id}`, group: 'export', title, status: 'done', detail: null });
  }
  if (input.turn?.status === 'RUNNING') rows.push({ key: `a-${input.turn.id}`, group: 'ai', title: input.turn.message, status: 'running', detail: t.tasks.aiRunning });
  else if (input.turn?.status === 'FAILED') rows.push({ key: `a-${input.turn.id}`, group: 'ai', title: input.turn.message, status: 'failed', detail: t.tasks.aiFailed });
  return rows;
}

/**
 * 纯函数：上一次看到时在进行中、这一次结束了的任务（可单测）。
 * 素材处理完后并入"已就绪"那一行，所以进行中的素材行消失也算完成；AI 这一轮就在对话里，不另提醒。
 */
export function finishedTasks(previous: readonly TaskRow[], rows: readonly TaskRow[]): TaskRow[] {
  const now = new Map(rows.map((row) => [row.key, row]));
  return previous.filter((row) => row.status === 'running' && row.group !== 'ai').flatMap((row) => {
    const next = now.get(row.key);
    if (next === undefined) return row.group === 'footage' ? [{ ...row, status: 'done' as const, detail: null }] : [];
    return next.status === 'done' || next.status === 'failed' ? [next] : [];
  });
}

/** 任务结束的就近提醒：只提醒这次打开页面后看着结束的任务（刷新前已结束的不算），8 秒后自动收起 */
export function useTaskNotice(rows: TaskRow[]): { finished: TaskRow[]; dismiss: () => void } {
  const previous = useRef<readonly TaskRow[]>(rows);
  const [finished, setFinished] = useState<TaskRow[]>([]);
  useEffect(() => {
    const ended = finishedTasks(previous.current, rows);
    previous.current = rows;
    if (ended.length > 0) setFinished(ended);
  }, [rows]);
  useEffect(() => {
    if (finished.length === 0) return;
    const timer = setTimeout(() => setFinished([]), 8_000);
    return () => clearTimeout(timer);
  }, [finished]);
  return { finished, dismiss: () => setFinished([]) };
}

/** 导出运行列表（只读）；有进行中的导出时每 5 秒刷新 */
export function useStudioExports(workspaceId: string, projectId: string) {
  const client = useAncsClient();
  return useQuery({
    queryKey: studioKeys.exports(workspaceId, projectId),
    queryFn: () => client.finalRenders.list(workspaceId, projectId),
    refetchInterval: (query) => ((query.state.data ?? []).some((run) => !WORKFLOW_TERMINAL_STATUSES.includes(run.status)) ? 5_000 : false),
  });
}

export function StudioTasks(props: { rows: TaskRow[]; loadFailed: boolean; onClose: () => void }) {
  const { messages } = useI18n();
  const t = messages.studio.tasks;
  const panel = useRef<HTMLElement | null>(null);
  // 只在打开时聚焦一次、关闭时把焦点还回去（列表每 5 秒刷新也不抢焦点）
  const onClose = useRef(props.onClose);
  onClose.current = props.onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>('button')?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose.current(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); previous?.focus?.(); };
  }, []);
  const groups = (['ai', 'generation', 'export', 'footage'] as const).map((group) => ({ group, rows: props.rows.filter((row) => row.group === group) })).filter((entry) => entry.rows.length > 0);
  return (
    <aside ref={panel} className={styles['drawer']} aria-label={t.title}>
      <div className={styles['drawerHead']}>
        <h2>{t.title}</h2>
        <button type="button" className="btn icononly ghost small" aria-label={messages.common.close} onClick={props.onClose}><QuietIcon name="close" /></button>
      </div>
      <div className={styles['drawerBody']}>
        <p className={styles['tasksNote']}>{t.note}</p>
        {props.loadFailed ? <p className={styles['alert']} role="alert">{t.exportsUnavailable}</p> : null}
        {groups.length === 0 ? <p className={styles['tasksNote']}>{t.empty}</p> : groups.map(({ group, rows }) => (
          <section key={group} className={styles['taskGroup']} aria-label={t.groups[group]}>
            <h3>{t.groups[group]}</h3>
            <ul>
              {rows.map((row) => (
                <li key={row.key} className={styles['taskRow']} data-status={row.status}>
                  <span className={styles['taskStatus']}>{t.status[row.status]}</span>
                  <span className={styles['taskTitle']}>{row.title}</span>
                  {row.detail !== null ? <span className={styles['taskDetail']}>{row.detail}</span> : null}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </aside>
  );
}
