'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useQueryParam } from '@/lib/query-param';
import { useMutation } from '@tanstack/react-query';
import { useAncsClient } from '@/lib/client';
import { deviceAppearance, saveDeviceAppearance } from '@/lib/appearance';
import { useI18n } from '@/i18n/I18nProvider';
import { StateBlock } from '@/ui/StateBlock';
import { AccountCard, CheckInbox } from '@/ui/AccountCard';

/** 邮件里的验证链接落地页（D-04）：确认邮箱即登录并进入创作台；链接失效可重新要一封。 */
export default function VerifyEmailPage() {
  return <Suspense fallback={null}><VerifyEmail /></Suspense>;
}

function VerifyEmail() {
  const token = useQueryParam('token');
  const client = useAncsClient();
  const { locale, messages } = useI18n();
  const t = messages.account.verify;
  const [email, setEmail] = useState('');
  const [resentTo, setResentTo] = useState<string | null>(null);
  const started = useRef(false);
  const verify = useMutation({
    mutationFn: (value: string) => client.auth.verifyEmail({ token: value }),
    onSuccess: (result) => {
      if (result.user === null) return;
      saveDeviceAppearance(result.user.id, deviceAppearance(result.user.id));
      window.setTimeout(() => { window.location.href = '/'; }, 900);
    },
  });
  const resend = useMutation({
    mutationFn: () => client.auth.resendVerification({ email: email.trim(), locale }),
    onSuccess: () => setResentTo(email.trim().toLowerCase()),
  });
  // 只确认一次（开发模式下效果会执行两遍：第二遍会把"刚确认"误判成"早已确认"）
  useEffect(() => {
    if (token === null || started.current) return;
    started.current = true;
    verify.mutate(token);
  }, [token, verify]);

  if (resentTo !== null) return <AccountCard eyebrow={t.eyebrow} title={t.failedTitle}><CheckInbox email={resentTo} /></AccountCard>;
  if (token === null) return <AccountCard eyebrow={t.eyebrow} title={t.failedTitle} intro={t.missingToken}><a className="btn full mt24" href="/sign-in">{t.signIn}</a></AccountCard>;
  if (verify.isSuccess) {
    return verify.data.user !== null
      ? <AccountCard eyebrow={t.eyebrow} title={t.doneTitle}><div className="mt24" role="status" data-verified=""><StateBlock variant="loading" title={t.doneBody} /></div></AccountCard>
      : <AccountCard eyebrow={t.eyebrow} title={t.alreadyTitle} intro={t.alreadyBody}><a className="btn primary full mt24" href="/sign-in">{t.signIn}</a></AccountCard>;
  }
  if (verify.isError) {
    return (
      <AccountCard eyebrow={t.eyebrow} title={t.failedTitle} intro={t.failedBody}>
        <form className="col mt24" onSubmit={(event) => { event.preventDefault(); resend.mutate(); }}>
          <label className="label" htmlFor="verify-email">{t.email}
            <input id="verify-email" type="email" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} className="field mt8" />
          </label>
          <button type="submit" className="btn primary full" disabled={resend.isPending}>{t.resend}</button>
        </form>
        <a className="btn ghost full mt8" href="/sign-in">{t.signIn}</a>
      </AccountCard>
    );
  }
  return <AccountCard eyebrow={t.eyebrow} title={t.working}><div className="mt24"><StateBlock variant="loading" title={t.working} /></div></AccountCard>;
}
