'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';
import type { AdminWorkspaceSummary } from '@ancs/contracts';
import { AncsApiError } from '@ancs/sdk';
import { useAncsClient } from '@/lib/client';
import { useAdminAbuseFlags, useAdminOpsAuditLog, useAdminProviderStatus, useAdminStorage, useAdminSupportGrants, useAdminUsers, useAdminWorkspaces } from '@/lib/queries';

/**
 * SaaS 安全运营面板（P09-05 / §43.3、§67、§24.2）——嵌入 `/admin`：
 * - 完整 Admin：users/workspaces 检索、provider 状态、存储用量；
 * - 滥用处理：标记列表 + 解决、工作区限制（RESTRICTED 阻止新任务）；
 * - 支持工具（**不可无痕**）：时限授权 + 支持视图（元数据摘要）+ 撤销——文案明示"对成员可见"；
 * - 运营审计（audit_log）：最近动作与系统安全事件。
 */

const errorText = (error: unknown): string =>
  error instanceof AncsApiError ? `${String(error.status)} ${error.code}` : error instanceof Error ? error.message : '未知错误';

const formatBytes = (bytes: number): string => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`);

export function SecurityOps(): ReactElement {
  const client = useAncsClient();
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [flagWorkspaceId, setFlagWorkspaceId] = useState('');
  const [flagNote, setFlagNote] = useState('');
  const [grantWorkspaceId, setGrantWorkspaceId] = useState('');
  const [grantPurpose, setGrantPurpose] = useState('');
  const [supportViewText, setSupportViewText] = useState<string | null>(null);

  const users = useAdminUsers(search);
  const workspaces = useAdminWorkspaces(search);
  const flags = useAdminAbuseFlags();
  const storage = useAdminStorage();
  const providerStatus = useAdminProviderStatus();
  const auditLog = useAdminOpsAuditLog();
  const grants = useAdminSupportGrants(grantWorkspaceId || flagWorkspaceId);

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['admin'] });
  };

  const createFlag = useMutation({
    mutationFn: () => client.admin.createAbuseFlag(flagWorkspaceId, { category: 'OTHER', severity: 'MEDIUM', note: flagNote }),
    onSuccess: async () => {
      setNotice(`已创建滥用标记（${flagWorkspaceId}）——操作已写入运营审计。`);
      setFlagNote('');
      await invalidate();
    },
    onError: (error: unknown) => setNotice(`创建标记失败：${errorText(error)}`),
  });

  const resolveFlag = useMutation({
    mutationFn: (flagId: string) => client.admin.resolveAbuseFlag(flagId, { resolutionNote: '运营复核完成（见审计）' }),
    onSuccess: async () => {
      setNotice('标记已解决——操作已写入运营审计。');
      await invalidate();
    },
    onError: (error: unknown) => setNotice(`解决失败：${errorText(error)}`),
  });

  const setState = useMutation({
    mutationFn: (input: { workspaceId: string; abuseState: 'NORMAL' | 'RESTRICTED' }) =>
      client.admin.setAbuseState(input.workspaceId, { abuseState: input.abuseState, note: '运营面板操作（见审计）' }),
    onSuccess: async (_data, variables) => {
      setNotice(`工作区已设为 ${variables.abuseState}${variables.abuseState === 'RESTRICTED' ? '（新的成本性任务将被阻止；存量保留）' : '（新任务恢复）'}——操作已写入运营审计。`);
      await invalidate();
    },
    onError: (error: unknown) => setNotice(`设置限制失败：${errorText(error)}`),
  });

  const createGrant = useMutation({
    mutationFn: () => client.admin.createSupportGrant(grantWorkspaceId, { purpose: grantPurpose, ttlHours: 2 }),
    onSuccess: async () => {
      setNotice('已创建支持访问授权（2h）。**工作区成员可见**该授权（support.access_granted 事件）——每次访问同样留痕。');
      setGrantPurpose('');
      await invalidate();
    },
    onError: (error: unknown) => setNotice(`创建授权失败：${errorText(error)}`),
  });

  const revokeGrant = useMutation({
    mutationFn: (grantId: string) => client.admin.revokeSupportGrant(grantId),
    onSuccess: async () => {
      setNotice('授权已撤销——再访问支持视图将被拒绝（403）。');
      await invalidate();
    },
    onError: (error: unknown) => setNotice(`撤销失败：${errorText(error)}`),
  });

  const openSupportView = useMutation({
    mutationFn: (workspaceId: string) => client.admin.supportView(workspaceId),
    onSuccess: async (view) => {
      setSupportViewText(
        `${view.name}：成员 ${String(view.counts.members)} · 项目 ${String(view.counts.projects)} · 资产 ${String(view.counts.assets)} · 存储 ${formatBytes(view.counts.storageBytesUsed)} · 积分 ${String(view.counts.creditsBalance)}（仅元数据；本次访问已留痕并对成员可见）`,
      );
      await invalidate();
    },
    onError: (error: unknown) => {
      setSupportViewText(null);
      setNotice(`支持视图被拒绝：${errorText(error)}（需先创建时限授权）`);
    },
  });

  return (
    <section data-testid="security-ops" className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold">SaaS 安全运营（P09-05）</h2>
      <p className="text-xs text-slate-400">
        所有运营动作写入运营审计（audit_log）；支持访问需时限授权且**对工作区成员可见**（不留无痕通道）。
      </p>
      {notice !== null ? (
        <p data-testid="secops-notice" className="text-sm text-slate-300">
          {notice}
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* 检索 */}
        <div className="rounded border border-slate-800 bg-slate-900/60 p-3">
          <h3 className="text-sm font-semibold text-slate-200">用户 / Workspace 检索</h3>
          <input
            aria-label="检索"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="邮箱 / 名称关键词"
            className="mt-2 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm"
          />
          <ul data-testid="admin-users" className="mt-2 flex flex-col text-xs text-slate-300">
            {(users.data ?? []).slice(0, 5).map((item) => (
              <li key={item.id} className="border-b border-slate-800 py-1 last:border-b-0">
                {item.email} · 参与 {item.workspaceCount} 个 Workspace
              </li>
            ))}
          </ul>
          <ul data-testid="admin-workspaces" className="mt-2 flex flex-col text-xs text-slate-300">
            {(workspaces.data ?? []).slice(0, 5).map((item: AdminWorkspaceSummary) => (
              <li key={item.id} className="border-b border-slate-800 py-1 last:border-b-0">
                {item.name} · {item.planKey} · 成员 {item.membersUsed} · {formatBytes(item.storageBytesUsed)} · 积分 {item.creditsBalance}
                {item.abuseState === 'RESTRICTED' ? ' · 已限制' : ''}
                {item.openAbuseFlags > 0 ? ` · 未解决标记 ${String(item.openAbuseFlags)}` : ''}
              </li>
            ))}
          </ul>
        </div>

        {/* Provider 状态 / 存储 */}
        <div className="rounded border border-slate-800 bg-slate-900/60 p-3">
          <h3 className="text-sm font-semibold text-slate-200">Provider 状态（近 7 天）</h3>
          <ul data-testid="provider-status" className="mt-2 flex flex-col text-xs text-slate-300">
            {(providerStatus.data?.items ?? []).map((item) => (
              <li key={item.providerId} className="border-b border-slate-800 py-1 last:border-b-0">
                <span className="font-mono">{item.providerId}</span> · {Object.entries(item.byStatus).map(([status, total]) => `${status}:${String(total)}`).join(' ')}
                {item.lastErrorCategory !== null ? ` · 最近失败：${item.lastErrorCategory}` : ''}
              </li>
            ))}
          </ul>
          <h3 className="mt-3 text-sm font-semibold text-slate-200">存储（Top-N）</h3>
          <ul data-testid="admin-storage" className="mt-2 flex flex-col text-xs text-slate-300">
            {(storage.data?.items ?? []).map((item) => (
              <li key={item.workspaceId} className="border-b border-slate-800 py-1 last:border-b-0">
                {item.workspaceName} · {formatBytes(item.bytesUsed)} · {item.assetCount} 个资产
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* 滥用处理 */}
      <div className="rounded border border-slate-800 bg-slate-900/60 p-3">
        <h3 className="text-sm font-semibold text-slate-200">滥用标记与限制</h3>
        <div className="mt-2 flex flex-wrap items-end gap-2 text-sm">
          <input
            aria-label="标记 Workspace ID"
            value={flagWorkspaceId}
            onChange={(event) => setFlagWorkspaceId(event.target.value)}
            placeholder="ws_..."
            className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm"
          />
          <input
            aria-label="标记备注"
            value={flagNote}
            onChange={(event) => setFlagNote(event.target.value)}
            placeholder="调查备注"
            className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm"
          />
          <button
            type="button"
            disabled={flagWorkspaceId === '' || flagNote === '' || createFlag.isPending}
            onClick={() => createFlag.mutate()}
            className="rounded bg-sky-600 px-3 py-1.5 text-sm text-white hover:bg-sky-500 disabled:opacity-50"
          >
            创建标记
          </button>
          <button
            type="button"
            disabled={flagWorkspaceId === '' || setState.isPending}
            onClick={() => setState.mutate({ workspaceId: flagWorkspaceId, abuseState: 'RESTRICTED' })}
            className="rounded border border-rose-800 px-3 py-1.5 text-sm text-rose-300 hover:bg-rose-950 disabled:opacity-50"
          >
            限制（阻止新任务）
          </button>
          <button
            type="button"
            disabled={flagWorkspaceId === '' || setState.isPending}
            onClick={() => setState.mutate({ workspaceId: flagWorkspaceId, abuseState: 'NORMAL' })}
            className="rounded border border-slate-600 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50"
          >
            解除限制
          </button>
        </div>
        <ul data-testid="abuse-flags" className="mt-2 flex flex-col text-xs text-slate-300">
          {(flags.data ?? []).slice(0, 10).map((flag) => (
            <li key={flag.id} className="flex items-center justify-between gap-2 border-b border-slate-800 py-1 last:border-b-0">
              <span>
                [{flag.status}] {flag.category}/{flag.severity} · {flag.workspaceId} · {flag.note}
              </span>
              {flag.status === 'OPEN' ? (
                <button type="button" disabled={resolveFlag.isPending} onClick={() => resolveFlag.mutate(flag.id)} className="rounded border border-slate-600 px-2 py-0.5 text-slate-200 hover:bg-slate-800 disabled:opacity-50">
                  解决
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </div>

      {/* 支持工具 */}
      <div className="rounded border border-slate-800 bg-slate-900/60 p-3">
        <h3 className="text-sm font-semibold text-slate-200">支持访问（时限授权；不可无痕）</h3>
        <div className="mt-2 flex flex-wrap items-end gap-2 text-sm">
          <input
            aria-label="支持 Workspace ID"
            value={grantWorkspaceId}
            onChange={(event) => setGrantWorkspaceId(event.target.value)}
            placeholder="ws_..."
            className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm"
          />
          <input
            aria-label="支持目的"
            value={grantPurpose}
            onChange={(event) => setGrantPurpose(event.target.value)}
            placeholder="工单/目的（≥5 字符）"
            className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm"
          />
          <button
            type="button"
            disabled={grantWorkspaceId === '' || grantPurpose.length < 5 || createGrant.isPending}
            onClick={() => createGrant.mutate()}
            className="rounded bg-sky-600 px-3 py-1.5 text-sm text-white hover:bg-sky-500 disabled:opacity-50"
          >
            创建授权（2h）
          </button>
          <button
            type="button"
            disabled={grantWorkspaceId === '' || openSupportView.isPending}
            onClick={() => openSupportView.mutate(grantWorkspaceId)}
            className="rounded border border-slate-600 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50"
          >
            打开支持视图
          </button>
        </div>
        {supportViewText !== null ? (
          <p data-testid="support-view" className="mt-2 text-xs text-emerald-300">
            {supportViewText}
          </p>
        ) : null}
        <ul data-testid="support-grants" className="mt-2 flex flex-col text-xs text-slate-300">
          {(grants.data ?? []).slice(0, 5).map((grant) => (
            <li key={grant.id} className="flex items-center justify-between gap-2 border-b border-slate-800 py-1 last:border-b-0">
              <span>
                [{grant.status}] {grant.purpose} · 至 {new Date(grant.expiresAt).toLocaleString()}
              </span>
              {grant.status === 'ACTIVE' ? (
                <button type="button" disabled={revokeGrant.isPending} onClick={() => revokeGrant.mutate(grant.id)} className="rounded border border-slate-600 px-2 py-0.5 text-slate-200 hover:bg-slate-800 disabled:opacity-50">
                  撤销
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </div>

      {/* 运营审计 */}
      <div className="rounded border border-slate-800 bg-slate-900/60 p-3">
        <h3 className="text-sm font-semibold text-slate-200">运营审计（audit_log，只追加）</h3>
        <ul data-testid="ops-audit-log" className="mt-2 flex flex-col text-xs text-slate-300">
          {(auditLog.data ?? []).slice(0, 20).map((entry) => (
            <li key={entry.id} className="border-b border-slate-800 py-1 last:border-b-0">
              <span className="font-mono">{entry.action}</span> · {entry.actorKind}
              {entry.actorUserId !== null ? ` (${entry.actorUserId})` : ''} · {entry.targetType}
              {entry.workspaceId !== null ? ` · ${entry.workspaceId}` : ''} · {new Date(entry.occurredAt).toLocaleString()}
            </li>
          ))}
        </ul>
      </div>

    </section>
  );
}
