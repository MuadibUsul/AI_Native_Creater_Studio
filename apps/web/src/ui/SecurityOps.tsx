'use client';

import { useMutation } from '@tanstack/react-query';
import { useRef, useState, type ReactElement } from 'react';
import type { OpsSession, SupportView } from '@ancs/contracts';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { useAdminProjects, useAdminStorage, useAdminSupportGrants } from '@/lib/queries';
import { StateBlock } from '@/ui/StateBlock';
import { useI18n } from '@/i18n/I18nProvider';
import type { Locale } from '@/i18n/locale';
import styles from '@/app/admin/ops.module.css';

type Scope = { workspaceId: string; ticketId?: string; request: number };

const stamp = (value: string, locale: Locale): string => new Date(value).toLocaleString(locale);
/** 存储量换算；单位符号不翻译，缺失值的说明由调用方按界面语言传入。 */
const bytes = (value: number, notProvided: string): string => {
  if (!Number.isFinite(value)) return notProvided;
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1024 ** 3).toFixed(2)} GiB`;
};

function QueryProblem({ error, retry }: { error: unknown; retry: () => void }): ReactElement {
  const t = useI18n().messages.entry.securityOps;
  const status = (error as { status?: number } | null)?.status;
  const title = status === 401 ? t.sessionExpired : status === 403 || status === 404 ? t.scopeForbidden : t.queryFailed;
  return <StateBlock variant="error" title={title} description={describeError(error).message} action={{ label: t.retryQuery, onClick: retry }} />;
}

function OperatorDiagnostics({ session }: { session: OpsSession }): ReactElement {
  const { messages, locale } = useI18n();
  const t = messages.entry.securityOps;
  const [draft, setDraft] = useState('');
  const [scope, setScope] = useState<Scope | null>(null);
  const projects = useAdminProjects(scope?.workspaceId ?? '', session.id, scope?.request ?? 0);
  const storage = useAdminStorage(scope?.workspaceId ?? '', session.id, scope?.request ?? 0);

  return <section className={styles['panel']} aria-labelledby="ops-workspace-heading">
    <div className={styles['sectionHeading']}>
      <div><p className={styles['kicker']}>WORKSPACE DIAGNOSTICS</p><h2 id="ops-workspace-heading">{t.workspaceHeading}</h2></div>
      <span className={styles['role']}>PRODUCTION_OPERATOR</span>
    </div>
    <p className={styles['description']}>{t.workspaceDescription}</p>
    <form className={styles['form']} onSubmit={(event) => {
      event.preventDefault();
      const workspaceId = draft.trim();
      if (workspaceId) setScope({ workspaceId, request: (scope?.request ?? 0) + 1 });
    }}>
      <label className={styles['label']} htmlFor="ops-workspace-id">{t.workspaceId}
        <input id="ops-workspace-id" className="field" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="ws_..." autoComplete="off" spellCheck={false} required />
      </label>
      <button className="btn primary" type="submit">{t.queryWorkspace}</button>
    </form>
    {!scope ? <p className={styles['hint']}>{t.workspaceHint}</p> : <>
      <p className={styles['scope']} role="status">{t.currentScope} <code>{scope.workspaceId}</code></p>
      {(projects.isPending || storage.isPending) ? <p className={styles['hint']} role="status">{t.loadingProjects}</p> : null}
      {projects.isError ? <QueryProblem error={projects.error} retry={() => void projects.refetch()} /> : null}
      {storage.isError ? <QueryProblem error={storage.error} retry={() => void storage.refetch()} /> : null}
      {projects.data && storage.data ? <>
        <div className={styles['storage']} data-testid="admin-storage">
          <span>{t.storageUsed} <strong>{bytes(storage.data.bytesUsed, t.notProvided)}</strong></span>
          <span>{t.assetCount} <strong>{storage.data.assetCount}</strong></span>
        </div>
        <div className={styles['tableWrap']}>
          <table className={styles['table']} data-testid="admin-projects">
            <caption>{t.projectsCaption(scope.workspaceId)}</caption>
            <thead><tr><th scope="col">{t.projectId}</th><th scope="col">{t.status}</th><th scope="col">{t.createdAt}</th><th scope="col">{t.updatedAt}</th></tr></thead>
            <tbody>{projects.data.map((project) => <tr key={project.id}>
              <td><code>{project.id}</code></td><td>{project.status}</td><td>{stamp(project.createdAt, locale)}</td><td>{stamp(project.updatedAt, locale)}</td>
            </tr>)}</tbody>
          </table>
        </div>
        {projects.data.length === 0 ? <p className={styles['hint']}>{t.noProjects}</p> : null}
      </> : null}
    </>}
  </section>;
}

function SupportDiagnostics({ session }: { session: OpsSession }): ReactElement {
  const client = useAncsClient();
  const { messages, locale } = useI18n();
  const t = messages.entry.securityOps;
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
      <div><p className={styles['kicker']}>SUPPORT ACCESS</p><h2 id="ops-support-heading">{t.supportHeading}</h2></div>
      <span className={styles['role']}>SUPPORT_L2</span>
    </div>
    <p className={styles['description']}>{t.supportDescription}</p>
    <p className={styles['principal']}>{t.currentPrincipal} <code>{session.principalId}</code></p>
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
      <label className={styles['label']} htmlFor="ops-support-workspace">{t.workspaceId}
        <input id="ops-support-workspace" className="field" value={workspaceDraft} onChange={(event) => setWorkspaceDraft(event.target.value)} placeholder="ws_..." autoComplete="off" spellCheck={false} required />
      </label>
      <label className={styles['label']} htmlFor="ops-support-ticket">{t.ticketId}
        <input id="ops-support-ticket" className="field" value={ticketDraft} onChange={(event) => setTicketDraft(event.target.value)} placeholder="ticket-..." autoComplete="off" spellCheck={false} required />
      </label>
      <button className="btn primary" type="submit">{t.queryGrants}</button>
    </form>
    {!scope ? <p className={styles['hint']}>{t.supportHint}</p> : <>
      <p className={styles['scope']} role="status">{t.currentScope} <code>{scope.workspaceId}</code> · {t.ticket} <code>{scope.ticketId}</code></p>
      {grants.isPending ? <p className={styles['hint']} role="status">{t.loadingGrants}</p> : null}
      {grants.isError ? <QueryProblem error={grants.error} retry={() => void grants.refetch()} /> : null}
      {grants.data ? <>
        <div className={styles['tableWrap']}>
          <table className={styles['table']} data-testid="support-grants">
            <caption>{t.grantsCaption(scope.ticketId ?? '')}</caption>
            <thead><tr><th scope="col">{t.grantId}</th><th scope="col">{t.status}</th><th scope="col">{t.scope}</th><th scope="col">{t.createdAt}</th><th scope="col">{t.expiresAt}</th></tr></thead>
            <tbody>{grants.data.map((grant) => <tr key={grant.id}>
              <td><code>{grant.id}</code></td><td>{grant.status}</td><td>{grant.scope}</td><td>{stamp(grant.createdAt, locale)}</td><td>{stamp(grant.expiresAt, locale)}</td>
            </tr>)}</tbody>
          </table>
        </div>
        {grants.data.length === 0 ? <p className={styles['hint']}>{t.noGrants}</p> : null}
        <div className={styles['accessAction']}>
          <p>{t.accessNotice}</p>
          <button className="btn" type="button" disabled={!active || openSummary.isPending} onClick={() => {
            setSummary(null);
            openSummary.mutate({ workspaceId: scope.workspaceId, ticketId: scope.ticketId ?? '', request: scope.request });
          }}>{t.openSummary}</button>
          {!active ? <p className={styles['hint']}>{t.noActiveGrant}</p> : null}
        </div>
      </> : null}
      {openSummary.isPending ? <p className={styles['hint']} role="status">{t.verifyingAccess}</p> : null}
      {openSummary.isError ? <StateBlock variant="error" title={t.summaryFailed} description={describeError(openSummary.error).message} action={{ label: t.reopenSummary, onClick: () => {
        if (scope) openSummary.mutate({ workspaceId: scope.workspaceId, ticketId: scope.ticketId ?? '', request: scope.request });
      } }} /> : null}
      {summary && !grants.isError ? <div className={styles['summary']} data-testid="support-view">
        <h3>{t.summaryTitle}</h3>
        <p>{t.workspace} <code>{scope.workspaceId}</code> · {t.ticket} <code>{scope.ticketId}</code> · {t.viewedAt(stamp(summary.viewedAt, locale))}</p>
        <dl><div><dt>{t.members}</dt><dd>{summary.counts.members}</dd></div><div><dt>{t.projects}</dt><dd>{summary.counts.projects}</dd></div><div><dt>{t.assets}</dt><dd>{summary.counts.assets}</dd></div><div><dt>{t.storage}</dt><dd>{bytes(summary.counts.storageBytesUsed, t.notProvided)}</dd></div></dl>
        <p>{t.accessLogged}</p>
      </div> : null}
    </>}
  </section>;
}

export function SecurityOps({ session }: { session: OpsSession }): ReactElement {
  const operator = session.roles.includes('PRODUCTION_OPERATOR');
  const support = session.roles.includes('SUPPORT_L2');
  const t = useI18n().messages.entry.securityOps;
  return <div className={styles['sections']} data-testid="security-ops">
    {operator ? <OperatorDiagnostics session={session} /> : null}
    {support ? <SupportDiagnostics session={session} /> : null}
    {!operator && !support ? <StateBlock variant="info" title={t.noDiagnostics} description={t.noDiagnosticsBody} /> : null}
  </div>;
}
