'use client';

import { useMutation } from '@tanstack/react-query';
import { useRef, useState, type ReactElement } from 'react';
import type { OpsSession, SupportView } from '@ancs/contracts';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { useAdminProjects, useAdminStorage, useAdminSupportGrants } from '@/lib/queries';
import { StateBlock } from '@/ui/StateBlock';
import styles from '@/app/admin/ops.module.css';

type Scope = { workspaceId: string; ticketId?: string; request: number };

const stamp = (value: string): string => new Date(value).toLocaleString('zh-CN');
const bytes = (value: number): string => {
  if (!Number.isFinite(value)) return '未提供';
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1024 ** 3).toFixed(2)} GiB`;
};

function QueryProblem({ error, retry }: { error: unknown; retry: () => void }): ReactElement {
  const status = (error as { status?: number } | null)?.status;
  const title = status === 401 ? '运营会话已过期' : status === 403 || status === 404 ? '当前范围无权查看' : '查询失败';
  return <StateBlock variant="error" title={title} description={describeError(error).message} action={{ label: '重试查询', onClick: retry }} />;
}

function OperatorDiagnostics({ session }: { session: OpsSession }): ReactElement {
  const [draft, setDraft] = useState('');
  const [scope, setScope] = useState<Scope | null>(null);
  const projects = useAdminProjects(scope?.workspaceId ?? '', session.id, scope?.request ?? 0);
  const storage = useAdminStorage(scope?.workspaceId ?? '', session.id, scope?.request ?? 0);

  return <section className={styles['panel']} aria-labelledby="ops-workspace-heading">
    <div className={styles['sectionHeading']}>
      <div><p className={styles['kicker']}>WORKSPACE DIAGNOSTICS</p><h2 id="ops-workspace-heading">工作区诊断</h2></div>
      <span className={styles['role']}>PRODUCTION_OPERATOR</span>
    </div>
    <p className={styles['description']}>只展示项目标识、状态、时间和存储总量；不读取作品标题或素材内容。</p>
    <form className={styles['form']} onSubmit={(event) => {
      event.preventDefault();
      const workspaceId = draft.trim();
      if (workspaceId) setScope({ workspaceId, request: (scope?.request ?? 0) + 1 });
    }}>
      <label className={styles['label']} htmlFor="ops-workspace-id">工作区 ID
        <input id="ops-workspace-id" className="field" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="ws_..." autoComplete="off" spellCheck={false} required />
      </label>
      <button className="btn primary" type="submit">查询工作区</button>
    </form>
    {!scope ? <p className={styles['hint']}>输入获授权的工作区 ID，提交后才会查询。</p> : <>
      <p className={styles['scope']} role="status">当前范围 <code>{scope.workspaceId}</code></p>
      {(projects.isPending || storage.isPending) ? <p className={styles['hint']} role="status">正在加载项目与存储摘要…</p> : null}
      {projects.isError ? <QueryProblem error={projects.error} retry={() => void projects.refetch()} /> : null}
      {storage.isError ? <QueryProblem error={storage.error} retry={() => void storage.refetch()} /> : null}
      {projects.data && storage.data ? <>
        <div className={styles['storage']} data-testid="admin-storage">
          <span>存储用量 <strong>{bytes(storage.data.bytesUsed)}</strong></span>
          <span>资产数 <strong>{storage.data.assetCount}</strong></span>
        </div>
        <div className={styles['tableWrap']}>
          <table className={styles['table']} data-testid="admin-projects">
            <caption>项目状态 · {scope.workspaceId}</caption>
            <thead><tr><th scope="col">项目 ID</th><th scope="col">状态</th><th scope="col">创建时间</th><th scope="col">更新时间</th></tr></thead>
            <tbody>{projects.data.map((project) => <tr key={project.id}>
              <td><code>{project.id}</code></td><td>{project.status}</td><td>{stamp(project.createdAt)}</td><td>{stamp(project.updatedAt)}</td>
            </tr>)}</tbody>
          </table>
        </div>
        {projects.data.length === 0 ? <p className={styles['hint']}>当前工作区没有可见项目。</p> : null}
      </> : null}
    </>}
  </section>;
}

function SupportDiagnostics({ session }: { session: OpsSession }): ReactElement {
  const client = useAncsClient();
  const [workspaceDraft, setWorkspaceDraft] = useState('');
  const [ticketDraft, setTicketDraft] = useState('');
  const [scope, setScope] = useState<Scope | null>(null);
  const [summary, setSummary] = useState<SupportView | null>(null);
  const scopeRevision = useRef(0);
  const grants = useAdminSupportGrants(scope?.workspaceId ?? '', scope?.ticketId ?? '', session.id, scope?.request ?? 0);
  const openSummary = useMutation({
    mutationFn: ({ workspaceId, ticketId }: { workspaceId: string; ticketId: string; request: number }) => client.admin.supportView(workspaceId, ticketId),
    onSuccess: (view, variables) => { if (variables.request === scopeRevision.current) setSummary(view); },
  });
  const active = grants.data?.some((grant) => grant.status === 'ACTIVE' && new Date(grant.expiresAt).getTime() > Date.now()) ?? false;

  return <section className={styles['panel']} aria-labelledby="ops-support-heading">
    <div className={styles['sectionHeading']}>
      <div><p className={styles['kicker']}>SUPPORT ACCESS</p><h2 id="ops-support-heading">工单支持</h2></div>
      <span className={styles['role']}>SUPPORT_L2</span>
    </div>
    <p className={styles['description']}>只显示当前运营主体在指定工作区和工单下的授权元数据。支持摘要须单独主动打开，每次访问都会留痕并对客户可见。</p>
    <p className={styles['principal']}>当前主体 <code>{session.principalId}</code></p>
    <form className={styles['form']} onSubmit={(event) => {
      event.preventDefault();
      const workspaceId = workspaceDraft.trim();
      const ticketId = ticketDraft.trim();
      if (workspaceId && ticketId) {
        scopeRevision.current += 1;
        setSummary(null);
        openSummary.reset();
        setScope({ workspaceId, ticketId, request: scopeRevision.current });
      }
    }}>
      <label className={styles['label']} htmlFor="ops-support-workspace">工作区 ID
        <input id="ops-support-workspace" className="field" value={workspaceDraft} onChange={(event) => setWorkspaceDraft(event.target.value)} placeholder="ws_..." autoComplete="off" spellCheck={false} required />
      </label>
      <label className={styles['label']} htmlFor="ops-support-ticket">工单 ID
        <input id="ops-support-ticket" className="field" value={ticketDraft} onChange={(event) => setTicketDraft(event.target.value)} placeholder="ticket-..." autoComplete="off" spellCheck={false} required />
      </label>
      <button className="btn primary" type="submit">查询授权</button>
    </form>
    {!scope ? <p className={styles['hint']}>输入工作区和工单 ID，提交后才会查询。</p> : <>
      <p className={styles['scope']} role="status">当前范围 <code>{scope.workspaceId}</code> · 工单 <code>{scope.ticketId}</code></p>
      {grants.isPending ? <p className={styles['hint']} role="status">正在加载当前工单授权…</p> : null}
      {grants.isError ? <QueryProblem error={grants.error} retry={() => void grants.refetch()} /> : null}
      {grants.data ? <>
        <div className={styles['tableWrap']}>
          <table className={styles['table']} data-testid="support-grants">
            <caption>当前主体的支持授权 · {scope.ticketId}</caption>
            <thead><tr><th scope="col">授权 ID</th><th scope="col">状态</th><th scope="col">范围</th><th scope="col">创建时间</th><th scope="col">到期时间</th></tr></thead>
            <tbody>{grants.data.map((grant) => <tr key={grant.id}>
              <td><code>{grant.id}</code></td><td>{grant.status}</td><td>{grant.scope}</td><td>{stamp(grant.createdAt)}</td><td>{stamp(grant.expiresAt)}</td>
            </tr>)}</tbody>
          </table>
        </div>
        {grants.data.length === 0 ? <p className={styles['hint']}>当前范围没有可见授权。</p> : null}
        <div className={styles['accessAction']}>
          <p>打开支持摘要会产生访问审计并通知工作区成员；仅展示脱敏统计。</p>
          <button className="btn" type="button" disabled={!active || openSummary.isPending} onClick={() => {
            setSummary(null);
            openSummary.mutate({ workspaceId: scope.workspaceId, ticketId: scope.ticketId ?? '', request: scope.request });
          }}>确认并打开支持摘要</button>
          {!active ? <p className={styles['hint']}>当前工单没有有效授权，无法打开支持摘要。</p> : null}
        </div>
      </> : null}
      {openSummary.isPending ? <p className={styles['hint']} role="status">正在核验授权并记录访问…</p> : null}
      {openSummary.isError ? <StateBlock variant="error" title="支持摘要访问被拒或失败" description={describeError(openSummary.error).message} action={{ label: '再次打开并留痕', onClick: () => {
        if (scope) openSummary.mutate({ workspaceId: scope.workspaceId, ticketId: scope.ticketId ?? '', request: scope.request });
      } }} /> : null}
      {summary && !grants.isError ? <div className={styles['summary']} data-testid="support-view">
        <h3>脱敏支持摘要</h3>
        <p>工作区 <code>{scope.workspaceId}</code> · 工单 <code>{scope.ticketId}</code> · 查看时间 {stamp(summary.viewedAt)}</p>
        <dl><div><dt>成员</dt><dd>{summary.counts.members}</dd></div><div><dt>项目</dt><dd>{summary.counts.projects}</dd></div><div><dt>资产</dt><dd>{summary.counts.assets}</dd></div><div><dt>存储</dt><dd>{bytes(summary.counts.storageBytesUsed)}</dd></div></dl>
        <p>本次访问已留痕并对工作区成员可见。</p>
      </div> : null}
    </>}
  </section>;
}

export function SecurityOps({ session }: { session: OpsSession }): ReactElement {
  const operator = session.roles.includes('PRODUCTION_OPERATOR');
  const support = session.roles.includes('SUPPORT_L2');
  return <div className={styles['sections']} data-testid="security-ops">
    {operator ? <OperatorDiagnostics session={session} /> : null}
    {support ? <SupportDiagnostics session={session} /> : null}
    {!operator && !support ? <StateBlock variant="info" title="当前角色暂无可用诊断" description="此入口只开放已完成限定范围授权的只读操作。写入与审批功能尚未开放。" /> : null}
  </div>;
}
