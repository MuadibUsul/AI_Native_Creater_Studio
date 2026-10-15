'use client';

import { useQuery } from '@tanstack/react-query';
import { describeError } from '@/lib/errors';
import { useAncsClient } from '@/lib/client';
import { StateBlock } from '@/ui/StateBlock';
import { SecurityOps } from '@/ui/SecurityOps';
import { OpsEnrollmentPanel, OpsSessionPanel } from '@/ui/OpsSessionPanel';
import { useI18n } from '@/i18n/I18nProvider';
import styles from './ops.module.css';

export default function AdminPage() {
  const client = useAncsClient();
  const t = useI18n().messages.entry.admin;
  const session = useQuery({
    queryKey: ['ops', 'session'],
    queryFn: () => client.ops.session(),
    retry: false,
    refetchInterval: 30_000,
  });

  return <section className={styles['page']}>
    <header className={styles['heading']}>
      <p className={styles['eyebrow']}>PLATFORM / OPERATIONS</p>
      <h1>{t.title}</h1>
      <p>{t.intro}</p>
    </header>

    {session.isPending ? <StateBlock variant="info" title={t.checking} description={t.checkingBody} /> : null}
    {session.isError ? <>
      <StateBlock
        variant={((session.error as { status?: number } | null)?.status === 404) ? 'info' : 'error'}
        title={((session.error as { status?: number } | null)?.status === 404) ? t.sessionRequired : t.checkFailed}
        description={((session.error as { status?: number } | null)?.status === 404)
          ? t.sessionRequiredBody
          : describeError(session.error).message}
        action={{ label: t.retryCheck, onClick: () => void session.refetch() }}
      />
      <a className="btn" href="/sign-in">{t.goSignIn}</a>
      <details className={styles['enrollment']}>
        <summary>{t.enrollSummary}</summary>
        <OpsEnrollmentPanel />
      </details>
    </> : null}

    {session.data && !session.isError ? <>
      <OpsSessionPanel session={session.data} />
      {session.data.environment === 'PRODUCTION' ? (
        <StateBlock variant="info" title={t.productionClosed} description={t.productionClosedBody} />
      ) : <SecurityOps key={session.data.id} session={session.data} />}
    </> : null}
  </section>;
}
