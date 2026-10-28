'use client';

import { Suspense, useState } from 'react';
import { useQueryParam } from '@/lib/query-param';
import { useMutation } from '@tanstack/react-query';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { useI18n } from '@/i18n/I18nProvider';
import { StateBlock } from '@/ui/StateBlock';
import { AccountCard, errorReason } from '@/ui/AccountCard';

/** 重设密码（D-04）：邮件链接落地页；保存后其他设备的登录全部退出，用新密码登录。 */
export default function ResetPasswordPage() {
  return <Suspense fallback={null}><ResetPassword /></Suspense>;
}

function ResetPassword() {
  const token = useQueryParam('token');
  const client = useAncsClient();
  const { messages } = useI18n();
  const t = messages.account.reset;
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const reset = useMutation({ mutationFn: (value: string) => client.auth.resetPassword({ token: value, newPassword: password }) });

  if (token === null) return <AccountCard eyebrow={t.eyebrow} title={t.failedTitle} intro={t.missingToken}><a className="btn full mt24" href="/forgot-password">{t.requestAgain}</a></AccountCard>;
  if (reset.isSuccess) return <AccountCard eyebrow={t.eyebrow} title={t.doneTitle} intro={t.doneBody}><a className="btn primary full mt24" href="/sign-in" data-reset-done="">{t.signIn}</a></AccountCard>;
  if (reset.isError && errorReason(reset.error) === 'INVALID_TOKEN') {
    return <AccountCard eyebrow={t.eyebrow} title={t.failedTitle} intro={t.failedBody}><a className="btn primary full mt24" href="/forgot-password">{t.requestAgain}</a></AccountCard>;
  }
  return (
    <AccountCard eyebrow={t.eyebrow} title={t.title} intro={t.intro}>
      <form className="col mt24" onSubmit={(event) => {
        event.preventDefault();
        if (password !== confirm) { setMismatch(true); return; }
        setMismatch(false);
        reset.mutate(token);
      }}>
        <label className="label" htmlFor="reset-password">{t.password}
          <input id="reset-password" type="password" required minLength={8} maxLength={128} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} className="field mt8" />
        </label>
        <label className="label" htmlFor="reset-confirm">{t.confirm}
          <input id="reset-confirm" type="password" required minLength={8} maxLength={128} autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} className="field mt8" />
        </label>
        {mismatch ? <p className="small" role="alert">{t.mismatch}</p> : null}
        <button type="submit" className="btn primary full" disabled={reset.isPending}>{reset.isPending ? t.submitting : t.submit}</button>
      </form>
      {reset.isError ? <div className="mt24"><StateBlock variant="error" title={t.failedTitle} description={describeError(reset.error).message} /></div> : null}
    </AccountCard>
  );
}
