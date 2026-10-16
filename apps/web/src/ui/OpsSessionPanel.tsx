'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { OpsSession } from '@ancs/contracts';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { useI18n } from '@/i18n/I18nProvider';

/** Enrollment secrets live only in this tab until the operator leaves or restarts login. */
export function OpsEnrollmentPanel() {
  const client = useAncsClient();
  const t = useI18n().messages.entry.opsSession;
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const enroll = useMutation({ mutationFn: () => client.ops.enrollTotp({ password }) });
  const verify = useMutation({
    mutationFn: () => client.auth.verifyTotp({ code }),
    onSuccess: () => { setConfirmed(true); setPassword(''); setCode(''); },
  });
  const restart = async () => {
    await client.auth.signOut();
    window.location.href = '/sign-in';
  };

  return <section className="panel pad mt16" style={{ maxWidth: 640 }}>
    <h2>{t.enrollTitle}</h2>
    <p className="small muted mt8">{t.enrollIntro}</p>
    {!enroll.data ? <form className="col mt16" onSubmit={(event) => { event.preventDefault(); enroll.mutate(); }}>
      <label className="label" htmlFor="ops-enroll-password">{t.currentPassword}
        <input id="ops-enroll-password" type="password" autoComplete="current-password" required className="field mt8" value={password} onChange={(event) => setPassword(event.target.value)} />
      </label>
      <button type="submit" className="btn primary" disabled={enroll.isPending}>{t.enroll}</button>
      {enroll.isError ? <p role="alert" className="small">{t.enrollFailed(describeError(enroll.error).message)}</p> : null}
    </form> : <div className="col mt16">
      <p className="small">{t.enrollImport}</p>
      <code className="small" style={{ overflowWrap: 'anywhere' }}>{enroll.data.totpUri}</code>
      <ul className="small" aria-label={t.backupCodesAria}>{enroll.data.backupCodes.map((backupCode) => <li key={backupCode}><code>{backupCode}</code></li>)}</ul>
      {!confirmed ? <form className="col" onSubmit={(event) => { event.preventDefault(); verify.mutate(); }}>
        <label className="label" htmlFor="ops-enroll-code">{t.codeLabel}
          <input id="ops-enroll-code" className="field mt8" type="text" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" required value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} />
        </label>
        <button type="submit" className="btn primary" disabled={verify.isPending}>{t.confirmEnable}</button>
        {verify.isError ? <p role="alert" className="small">{t.codeFailed(describeError(verify.error).message)}</p> : null}
      </form> : <div className="col"><p role="status">{t.enabled}</p><button type="button" className="btn primary" onClick={() => void restart()}>{t.restart}</button></div>}
    </div>}
  </section>;
}

export function OpsSessionPanel({ session }: { session: OpsSession }) {
  const client = useAncsClient();
  const queryClient = useQueryClient();
  const { messages, locale } = useI18n();
  const t = messages.entry.opsSession;
  const [code, setCode] = useState('');
  const reauth = useMutation({
    mutationFn: () => client.ops.reauthenticate({ code }),
    onSuccess: (current) => { setCode(''); queryClient.setQueryData(['ops', 'session'], current); },
  });
  const revoke = useMutation({
    mutationFn: () => client.ops.revokeSession({ sessionId: session.id }),
    onSuccess: () => { queryClient.removeQueries({ queryKey: ['admin'] }); window.location.href = '/admin'; },
  });
  return <section className="panel pad" aria-label={t.sessionAria}>
    <div className="flex flex-wrap items-center gap-3" role="status" style={{ position: 'sticky', top: 0, zIndex: 10, background: 'var(--panel)', paddingBlock: 8 }}>
      <strong>{t.environment(session.environment)}</strong>
      <span className="small muted">{t.rolesExpiry(session.roles, new Date(session.absoluteExpiresAt).toLocaleString(locale))}</span>
    </div>
    {session.securityNotice === 'NEW_DEVICE' ? <p role="alert" className="small mt8">{t.newDevice}</p> : null}
    <form className="flex flex-wrap items-end gap-2 mt16" onSubmit={(event) => { event.preventDefault(); reauth.mutate(); }}>
      <label className="label" htmlFor="ops-reauth-code">{t.reauthLabel}
        <input id="ops-reauth-code" className="field mt8" type="text" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" required value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} />
      </label>
      <button type="submit" className="btn" disabled={reauth.isPending}>{t.verify}</button>
      <button type="button" className="btn" disabled={revoke.isPending} onClick={() => revoke.mutate()}>{t.revokeDevice}</button>
    </form>
    {reauth.isSuccess ? <p role="status" className="small mt8">{t.reauthSucceeded}</p> : null}
    {reauth.isError ? <p role="alert" className="small mt8">{t.reauthFailed(describeError(reauth.error).message)}</p> : null}
    {revoke.isError ? <p role="alert" className="small mt8">{t.revokeFailed(describeError(revoke.error).message)}</p> : null}
  </section>;
}
