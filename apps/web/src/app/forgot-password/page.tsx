'use client';

import { Suspense, useState } from 'react';
import { useQueryParam } from '@/lib/query-param';
import { useMutation } from '@tanstack/react-query';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { useCapabilities } from '@/lib/queries';
import { useI18n } from '@/i18n/I18nProvider';
import { StateBlock } from '@/ui/StateBlock';
import { AccountCard } from '@/ui/AccountCard';

/** 找回密码（D-04）：发重设链接；答复不透露邮箱是否注册。站点未配置发信时如实说明。 */
export default function ForgotPasswordPage() {
  return <Suspense fallback={null}><ForgotPassword /></Suspense>;
}

function ForgotPassword() {
  const client = useAncsClient();
  const { locale, messages } = useI18n();
  const t = messages.account.forgot;
  const available = useCapabilities().data?.accounts.passwordReset;
  const [email, setEmail] = useState(useQueryParam('email') ?? '');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const request = useMutation({
    mutationFn: () => client.auth.requestPasswordReset({ email: email.trim(), locale }),
    onSuccess: () => setSentTo(email.trim().toLowerCase()),
  });

  if (available === false) return <AccountCard eyebrow={t.eyebrow} title={t.title} intro={t.unavailable}><a className="btn full mt24" href="/sign-in">{t.back}</a></AccountCard>;
  if (sentTo !== null) {
    return (
      <AccountCard eyebrow={t.eyebrow} title={t.title}>
        <p className="mt24" role="status" data-reset-sent="">{t.sentBody(sentTo)}</p>
        <a className="btn full mt16" href="/sign-in">{t.back}</a>
      </AccountCard>
    );
  }
  return (
    <AccountCard eyebrow={t.eyebrow} title={t.title} intro={t.intro}>
      <form className="col mt24" onSubmit={(event) => { event.preventDefault(); request.mutate(); }}>
        <label className="label" htmlFor="forgot-email">{t.email}
          <input id="forgot-email" type="email" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} className="field mt8" />
        </label>
        <button type="submit" className="btn primary full" disabled={request.isPending}>{request.isPending ? t.submitting : t.submit}</button>
      </form>
      {request.isError ? <div className="mt24"><StateBlock variant="error" title={t.title} description={describeError(request.error).message} /></div> : null}
      <a className="btn ghost full mt8" href="/sign-in">{t.back}</a>
    </AccountCard>
  );
}
