'use client';

import { Suspense, useState } from 'react';
import { useQueryParam } from '@/lib/query-param';
import { useMutation } from '@tanstack/react-query';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { useCapabilities } from '@/lib/queries';
import { StateBlock } from '@/ui/StateBlock';
import { BRAND_NAME, BrandTile } from '@/brand/brand';
import { errorReason } from '@/ui/AccountCard';
import { deviceAppearance, saveDeviceAppearance } from '@/lib/appearance';
import styles from '@/components/quiet-frame/legacy.module.css';
import { useI18n } from '@/i18n/I18nProvider';

/** 登录（P05-03）：Web 会话 Cookie（SDK auth.signIn）。D-04 起带"忘记密码""创建账号"入口（按部署能力显示）。 */
export default function SignInPage() {
  return <Suspense fallback={null}><SignIn /></Suspense>;
}

function SignIn() {
  const client = useAncsClient();
  const { locale, messages } = useI18n();
  const t = messages.entry.signIn;
  const links = messages.account.signInLinks;
  const accounts = useCapabilities().data?.accounts;
  const [email, setEmail] = useState(useQueryParam('email') ?? '');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [totpChallenge, setTotpChallenge] = useState(false);

  const signIn = useMutation({
    mutationFn: () => client.auth.signIn({ email, password, locale }),
    onSuccess: (result) => {
      if ('twoFactorRequired' in result) {
        setPassword('');
        setTotpChallenge(true);
        return;
      }
      saveDeviceAppearance(result.user.id, deviceAppearance(result.user.id));
      window.location.href = '/';
    },
  });

  const verifyTotp = useMutation({
    mutationFn: () => client.auth.verifyTotp({ code: totpCode }),
    onSuccess: (result) => {
      if ('user' in result) {
        saveDeviceAppearance(result.user.id, deviceAppearance(result.user.id));
        window.location.href = '/';
      }
    },
  });

  return (
    <main id="main" className={`page ${styles['surface']}`}>
      <section className="panel pad" style={{ maxWidth: 480, margin: 'min(8vh, 64px) auto 0' }}>
      <div className="row gap8 mb24"><BrandTile size={32} /><span className="logotext">{BRAND_NAME}</span></div>
      <div className="eyebrow mb16">ACCOUNT / SIGN IN</div>
      <h1>{t.title}</h1>
      <p className="small muted mt8">{totpChallenge ? t.totpIntro : t.intro}</p>
      {totpChallenge ? <form className="col mt24" onSubmit={(event) => { event.preventDefault(); verifyTotp.mutate(); }}>
        <label className="label" htmlFor="sign-in-totp">{t.totpLabel}
          <input id="sign-in-totp" type="text" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required autoComplete="one-time-code" value={totpCode} onChange={(event) => setTotpCode(event.target.value.replace(/\D/g, ''))} className="field mt8" />
        </label>
        <button type="submit" disabled={verifyTotp.isPending} className="btn primary full">{verifyTotp.isPending ? t.verifying : t.verify}</button>
        <button type="button" className="btn full" onClick={() => { setTotpChallenge(false); setTotpCode(''); }}>{t.restart}</button>
      </form> : <form
        className="col mt24"
        onSubmit={(event) => {
          event.preventDefault();
          signIn.mutate();
        }}
      >
        <label className="label" htmlFor="sign-in-email">
          {t.email}
          <input
            id="sign-in-email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="field mt8"
          />
        </label>
        <label className="label" htmlFor="sign-in-password">
          {t.password}
          <input
            id="sign-in-password"
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="field mt8"
          />
        </label>
        <button type="submit" disabled={signIn.isPending} className="btn primary full">
          {signIn.isPending ? t.signingIn : t.submit}
        </button>
      </form>}
      {verifyTotp.isError ? <div className="mt24"><StateBlock variant="error" title={t.verifyFailed} description={describeError(verifyTotp.error).message} /></div> : null}
      {!totpChallenge && accounts?.passwordReset === true ? <p className="small mt16"><a href={`/forgot-password${email.trim() === '' ? '' : `?email=${encodeURIComponent(email.trim())}`}`}>{links.forgot}</a></p> : null}
      {signIn.isError && errorReason(signIn.error) === 'EMAIL_NOT_VERIFIED' ? (
        <div className="mt24" data-email-unverified=""><StateBlock variant="info" title={links.unverifiedTitle} description={links.unverifiedBody} /></div>
      ) : signIn.isError ? (
        <div className="mt24"><StateBlock
          variant={describeError(signIn.error).kind === 'unauthenticated' ? 'unauthenticated' : 'error'}
          title={t.signInFailed}
          description={describeError(signIn.error).message}
          diagnostics={describeError(signIn.error).code ?? undefined}
          action={{ label: messages.common.retry, onClick: () => signIn.mutate() }}
        /></div>
      ) : null}
      {accounts !== undefined && accounts.signup !== 'closed' ? <p className="small muted mt24">{links.noAccount} <a href="/sign-up">{links.signUp}</a></p> : null}
      </section>
    </main>
  );
}
