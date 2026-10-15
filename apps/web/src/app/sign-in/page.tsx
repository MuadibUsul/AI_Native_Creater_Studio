'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { StateBlock } from '@/ui/StateBlock';
import { deviceAppearance, saveDeviceAppearance } from '@/lib/appearance';
import styles from '@/components/quiet-frame/legacy.module.css';
import { useI18n } from '@/i18n/I18nProvider';

/** 登录（P05-03）：Web 会话 Cookie（SDK auth.signIn）。 */
export default function SignInPage() {
  const client = useAncsClient();
  const { messages } = useI18n();
  const t = messages.entry.signIn;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [totpChallenge, setTotpChallenge] = useState(false);

  const signIn = useMutation({
    mutationFn: () => client.auth.signIn({ email, password }),
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
      {signIn.isError ? (
        <div className="mt24"><StateBlock
          variant={describeError(signIn.error).kind === 'unauthenticated' ? 'unauthenticated' : 'error'}
          title={t.signInFailed}
          description={describeError(signIn.error).message}
          diagnostics={describeError(signIn.error).code ?? undefined}
          action={{ label: messages.common.retry, onClick: () => signIn.mutate() }}
        /></div>
      ) : null}
      </section>
    </main>
  );
}
