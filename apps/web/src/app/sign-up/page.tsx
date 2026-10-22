'use client';

import { Suspense, useState } from 'react';
import { useQueryParam } from '@/lib/query-param';
import { useMutation } from '@tanstack/react-query';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { useCapabilities } from '@/lib/queries';
import { useI18n } from '@/i18n/I18nProvider';
import { StateBlock } from '@/ui/StateBlock';
import { AccountCard, CheckInbox, errorReason } from '@/ui/AccountCard';

/** 邮箱注册（D-04）：按部署的注册方式显示（closed 只给登录入口；invite 提示用受邀邮箱）；成功后去邮箱确认。 */
export default function SignUpPage() {
  return <Suspense fallback={null}><SignUpForm /></Suspense>;
}

function SignUpForm() {
  const client = useAncsClient();
  const { locale, messages } = useI18n();
  const t = messages.account.signUp;
  const mode = useCapabilities().data?.accounts.signup;
  const [name, setName] = useState('');
  const [email, setEmail] = useState(useQueryParam('email') ?? '');
  const [password, setPassword] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const signUp = useMutation({
    mutationFn: () => client.auth.signUp({ name: name.trim(), email: email.trim(), password, locale }),
    onSuccess: () => setSentTo(email.trim().toLowerCase()),
  });

  if (sentTo !== null) return <AccountCard eyebrow={t.eyebrow} title={t.title}><CheckInbox email={sentTo} /></AccountCard>;
  if (mode === 'closed') {
    return (
      <AccountCard eyebrow={t.eyebrow} title={t.closedTitle} intro={t.closedBody}>
        <a className="btn primary full mt24" href="/sign-in">{t.signIn}</a>
      </AccountCard>
    );
  }
  const reason = signUp.isError ? errorReason(signUp.error) : null;
  return (
    <AccountCard eyebrow={t.eyebrow} title={t.title} intro={t.intro}>
      {mode === 'invite' ? <p className="small mt8" data-invite-only="">{t.inviteOnly}</p> : null}
      <form className="col mt24" onSubmit={(event) => { event.preventDefault(); signUp.mutate(); }}>
        <label className="label" htmlFor="sign-up-name">{t.name}
          <input id="sign-up-name" type="text" required maxLength={80} autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} className="field mt8" />
        </label>
        <label className="label" htmlFor="sign-up-email">{t.email}
          <input id="sign-up-email" type="email" required autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} className="field mt8" />
        </label>
        <label className="label" htmlFor="sign-up-password">{t.password}
          <input id="sign-up-password" type="password" required minLength={8} maxLength={128} autoComplete="new-password" aria-describedby="sign-up-password-hint" value={password} onChange={(event) => setPassword(event.target.value)} className="field mt8" />
          <span id="sign-up-password-hint" className="small muted">{t.passwordHint}</span>
        </label>
        <button type="submit" disabled={signUp.isPending} className="btn primary full">{signUp.isPending ? t.submitting : t.submit}</button>
      </form>
      {signUp.isError ? (
        <div className="mt24"><StateBlock variant="error" title={t.failed} description={reason === 'SIGNUP_INVITE_REQUIRED' ? t.inviteRequired : describeError(signUp.error).message} /></div>
      ) : null}
      <p className="small muted mt24">{t.haveAccount} <a href="/sign-in">{t.signIn}</a></p>
    </AccountCard>
  );
}
