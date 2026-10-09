'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { ExportPackage, QaCheck, QaReport, RenderProfile, RenderRecord } from '@ancs/contracts';
import { useAncsClient } from '@/lib/client';
import { queryKeys, useRenderApproval, useRenders, useRenderQaReport } from '@/lib/queries';
import { StateBlock } from './StateBlock';
import ui from './Monochrome.module.css';

/**
 * 成片渲染与审核界面（P07-05 / §86、§87）：
 * - 渲染前预检（项目当前状态；同引擎对冻结快照的检查在 QA 报告里）；
 * - 创建渲染（四档 profile）→ 渲染队列状态（QUEUED→RENDERING→QA→READY/FAILED）；
 * - QA 报告：逐项检查（BLOCKER/WARNING/ SKIP）、失败详情；QA 状态可手动触发（自动入队窗口的恢复入口）；
 * - **人工批准与受控导出（P07-06 / §87）**：READY 时批准/驳回（绑定 manifestHash 快照）；批准后展示受控下载入口
 *   （MP4/SRT/VTT/Manifest 签名 URL）；未批准不提供导出（服务端 409 双重守卫）。
 */

const PROFILES: { value: RenderProfile; label: string }[] = [
  { value: 'DRAFT_720', label: 'DRAFT_720（1280×720）' },
  { value: 'STUDIO_1080', label: 'STUDIO_1080（1920×1080）' },
  { value: 'PREMIUM_4K', label: 'PREMIUM_4K（3840×2160）' },
  { value: 'SHORT_1080x1920', label: 'SHORT_1080x1920（竖屏）' },
];

const STATUS_LABEL: Record<RenderRecord['status'], string> = {
  QUEUED: '排队中',
  RENDERING: '渲染中',
  QA: '质量检查中',
  READY: '待人工批准',
  FAILED: '失败',
  CANCELLED: '已取消',
};

function CheckRow({ check }: { check: QaCheck }) {
  const badge = check.status === 'FAIL' ? (check.severity === 'BLOCKER' ? '失败（阻止）' : '警告') : check.status === 'SKIP' ? '跳过（记录）' : '通过';
  return (
    <li data-testid={`qa-check-${check.id}`} className={`flex flex-col gap-1 border-b py-2 text-sm last:border-b-0 ${ui['divider']}`}>
      <div className="flex items-center justify-between gap-3">
        <span className={`font-mono text-xs ${ui['secondaryText']}`}>{check.id}</span>
        <span className={`text-xs ${check.status === 'FAIL' ? ui['emphasis'] : ui['secondaryText']}`}>
          {badge} · {check.category}
        </span>
      </div>
      {check.message !== null ? <p className={`text-xs ${ui['secondaryText']}`}>{check.message}</p> : null}
    </li>
  );
}

function QaReportPanel({ report }: { report: QaReport }) {
  const failed = report.checks.filter((check) => check.status === 'FAIL');
  return (
    <div data-testid="qa-report" className={`${ui['panel']} p-3`}>
      <div className="flex items-center justify-between">
        <h4 className={`text-sm font-semibold ${ui['primaryText']}`}>QA 报告（{report.scope === 'FINAL_RENDER' ? '产物 QA' : '渲染前预检'}）</h4>
        <span className={`text-xs ${report.verdict === 'PASS' ? ui['secondaryText'] : ui['emphasis']}`}>
          {report.verdict === 'PASS' ? 'PASS' : 'FAIL'} · 阻止项失败 {report.summary.blockersFailed} · 警告 {report.summary.warningsFailed} · 跳过 {report.summary.skipped}
        </span>
      </div>
      <ul className="mt-2">
        {report.checks.map((check) => (
          <CheckRow key={`${check.id}-${check.status}-${String(check.severity)}`} check={check} />
        ))}
      </ul>
      {failed.length > 0 ? <p className={`mt-2 text-xs ${ui['emphasis']}`}>存在失败项：修复后重新渲染（或按提示调整样式/内容）。</p> : null}
    </div>
  );
}

export function RenderReview({ workspaceId, projectId }: { workspaceId: string; projectId: string }) {
  const client = useAncsClient();
  const queryClient = useQueryClient();
  const renders = useRenders(workspaceId, projectId);
  const [profile, setProfile] = useState<RenderProfile>('STUDIO_1080');
  const [precheck, setPrecheck] = useState<QaReport | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const latest = renders.data !== undefined && renders.data.length > 0 ? renders.data[0] : undefined;
  const qaReport = useRenderQaReport(workspaceId, latest?.id ?? null);
  const approval = useRenderApproval(workspaceId, latest?.id ?? null);
  const [reviewNote, setReviewNote] = useState('');
  const [exportPackage, setExportPackage] = useState<ExportPackage | null>(null);

  const runPrecheck = useMutation({
    mutationFn: () => client.projects.renderPrecheck(projectId),
    onSuccess: (report) => {
      setPrecheck(report);
      setNotice(null);
    },
    onError: () => setNotice('预检失败：请稍后重试。'),
  });

  const createRender = useMutation({
    mutationFn: () => client.renders.create(workspaceId, projectId, { profile }),
    onSuccess: async () => {
      setNotice(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.renders(workspaceId, projectId) });
    },
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : '创建失败';
      setNotice(`创建渲染失败：${message}（缺 Master Narration 时请先合成旁白）`);
    },
  });

  const decideApproval = useMutation({
    mutationFn: (decision: 'APPROVED' | 'REJECTED') =>
      client.renders.decideApproval(workspaceId, latest?.id ?? '', {
        decision,
        ...(reviewNote === '' ? {} : { note: reviewNote }),
      }),
    onSuccess: async () => {
      setNotice(null);
      setExportPackage(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.renderApproval(workspaceId, latest?.id ?? 'none') });
    },
    onError: (error: unknown) => setNotice(`审批失败：${error instanceof Error ? error.message : '仅 READY 渲染可审批'}`),
  });

  const runExport = useMutation({
    mutationFn: () => client.renders.exportPackage(workspaceId, latest?.id ?? ''),
    onSuccess: (bundle) => {
      setExportPackage(bundle);
      setNotice(null);
    },
    onError: (error: unknown) => setNotice(`导出被阻止：${error instanceof Error ? error.message : '未批准不能正式导出（§87）'}`),
  });

  const triggerQa = useMutation({
    mutationFn: () => client.renders.qa(workspaceId, latest?.id ?? ''),
    onSuccess: async () => {
      setNotice('已重新入队 QA（报告为 append-only，完成前显示上一份结论）。');
      await queryClient.invalidateQueries({ queryKey: queryKeys.renders(workspaceId, projectId) });
    },
    onError: () => setNotice('QA 触发失败（仅 QA 状态可触发）。'),
  });

  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Render 与审核</h1>

      <div className={`${ui['panel']} p-4`}>
        <div className="flex flex-wrap items-end gap-3">
          <label className={`flex flex-col gap-1 text-sm ${ui['secondaryText']}`}>
            渲染档位
            <select
              className={ui['field']}
              value={profile}
              onChange={(event) => setProfile(event.target.value as RenderProfile)}
            >
              {PROFILES.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className={ui['button']}
            onClick={() => runPrecheck.mutate()}
            disabled={runPrecheck.isPending}
          >
            渲染前预检
          </button>
          <button
            type="button"
            className={ui['primaryButton']}
            onClick={() => createRender.mutate()}
            disabled={createRender.isPending}
          >
            创建渲染
          </button>
        </div>
        {notice !== null ? <p role="status" className={`mt-2 text-xs ${ui['notice']}`}>{notice}</p> : null}
        <p className={`mt-2 text-xs ${ui['mutedText']}`}>渲染在 Worker 执行（服务端 Remotion）；完成后自动进入 QA（§86），通过后等待人工批准（§87，批准与导出属 P07-06）。</p>
      </div>

      {precheck !== null ? <QaReportPanel report={precheck} /> : null}

      <div className={`${ui['panel']} p-4`}>
        <h2 className={`text-sm font-semibold ${ui['secondaryText']}`}>渲染队列</h2>
        {renders.isPending ? <p className={`mt-2 text-sm ${ui['secondaryText']}`}>正在加载渲染…</p> : null}
        {renders.isError ? <p className={`mt-2 text-sm ${ui['notice']}`}>渲染列表加载失败。请检查网络后重试。</p> : null}
        {renders.data !== undefined && renders.data.length === 0 ? <p className={`mt-2 text-sm ${ui['secondaryText']}`}>还没有渲染。建议先「渲染前预检」，再创建渲染。</p> : null}
        {renders.data !== undefined && renders.data.length > 0 ? (
          <ul className="mt-2 flex flex-col gap-2">
            {renders.data.slice(0, 5).map((render) => (
              <li key={render.id} data-testid={`render-${render.id}`} className="flex flex-wrap items-center gap-3 text-sm">
                <span className={ui['status']}>{STATUS_LABEL[render.status]}</span>
                <span className={ui['secondaryText']}>{render.profile}</span>
                <span className={`text-xs ${ui['mutedText']}`}>
                  {render.input.format.width}×{render.input.format.height}@{render.input.format.fps} · {new Date(render.createdAt).toLocaleString()}
                </span>
                {render.manifestHash !== null ? <span className={`font-mono text-xs ${ui['mutedText']}`}>manifest {render.manifestHash.slice(0, 12)}…</span> : null}
                {render.status === 'QA' ? (
                  <button
                    type="button"
                    className={ui['button']}
                    onClick={() => triggerQa.mutate()}
                    disabled={triggerQa.isPending}
                  >
                    重新触发 QA
                  </button>
                ) : null}
                {render.status === 'READY' ? <span className={`text-xs ${ui['secondaryText']}`}>QA 通过</span> : null}
                {render.status === 'FAILED' ? <span className={`text-xs ${ui['emphasis']}`}>{String((render.error as Record<string, unknown> | null)?.['reason'] ?? '失败')}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {latest !== undefined && qaReport.data !== undefined && qaReport.data !== null ? <QaReportPanel report={qaReport.data} /> : null}
      {latest !== undefined && qaReport.data === null ? (
        <StateBlock variant="info" title="该渲染尚无 QA 报告" description="渲染进入 QA 后由 Worker 自动执行（或点「重新触发 QA」）。" />
      ) : null}

      {/* 人工批准与受控导出（P07-06 / §87） */}
      {latest !== undefined && latest.status === 'READY' ? (
        <div data-testid="approval-panel" className={`${ui['panel']} p-4`}>
          <h2 className={`text-sm font-semibold ${ui['primaryText']}`}>人工批准（§87）</h2>
          {approval.data === undefined || approval.data === null || approval.data.decision === 'REJECTED' ? (
            <div className="mt-2 flex flex-col gap-2">
              <p className={`text-xs ${ui['secondaryText']}`}>
                QA 已通过。批准将绑定本次 Render 的 manifest hash（{latest.manifestHash?.slice(0, 12) ?? '—'}…）；
                批准后如需修改内容，请重新编辑并渲染（新渲染需重新批准）。
              </p>
              <label className={`flex flex-col gap-1 text-xs ${ui['secondaryText']}`}>
                审批备注（可选）
                <input
                  aria-label="审批备注"
                  className={ui['field']}
                  value={reviewNote}
                  onChange={(event) => setReviewNote(event.target.value)}
                />
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  className={ui['primaryButton']}
                  onClick={() => decideApproval.mutate('APPROVED')}
                  disabled={decideApproval.isPending}
                >
                  批准
                </button>
                <button
                  type="button"
                  className={ui['dangerButton']}
                  onClick={() => decideApproval.mutate('REJECTED')}
                  disabled={decideApproval.isPending}
                >
                  驳回
                </button>
              </div>
              {approval.data?.decision === 'REJECTED' ? <p className={`text-xs ${ui['notice']}`}>最近一次审批为驳回{approval.data.note === null ? '' : `：${approval.data.note}`}。</p> : null}
            </div>
          ) : (
            <div className="mt-2 flex flex-col gap-2">
              <p className={`text-xs ${ui['primaryText']}`}>
                已批准 · {new Date(approval.data.createdAt).toLocaleString()} · manifest {approval.data.manifestHashAtApproval.slice(0, 12)}…
                {approval.data.note !== null ? <span className={ui['secondaryText']}>（{approval.data.note}）</span> : null}
              </p>
              <button
                type="button"
                className={`self-start ${ui['button']}`}
                onClick={() => runExport.mutate()}
                disabled={runExport.isPending}
              >
                导出受控下载入口
              </button>
              {exportPackage !== null ? (
                <div data-testid="export-package" className="mt-1 flex flex-col gap-1">
                  <p className={`text-xs ${ui['secondaryText']}`}>
                    导出内容与已批准 Manifest 一致（{exportPackage.manifestHash.slice(0, 12)}…；下载链接 15 分钟内有效）。
                  </p>
                  {exportPackage.projectEditedSinceApproval ? (
                    <p className={`text-xs ${ui['notice']}`}>批准后项目有新编辑：本次导出仍为已批准的快照版本；如需包含新编辑请重新渲染并批准。</p>
                  ) : null}
                  <ul className="flex flex-col gap-1 text-sm">
                    {exportPackage.entries.map((entry) => (
                      <li key={entry.kind}>
                        <a className={ui['link']} href={entry.download.url}>
                          {entry.kind}（{entry.mimeType}
                          {entry.sizeBytes !== null ? `，${String(Math.round(entry.sizeBytes / 1024))} KB` : ''}）
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}
