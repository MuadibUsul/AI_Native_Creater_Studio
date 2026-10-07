'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { StateBlock } from '@/ui/StateBlock';
import styles from '@/components/quiet-frame/legacy.module.css';

/** 登录（P05-03）：Web 会话 Cookie（SDK auth.signIn）。 */
export default function SignInPage() {
  const client = useAncsClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const signIn = useMutation({
    mutationFn: () => client.auth.signIn({ email, password }),
    onSuccess: () => {
      window.location.href = '/';
    },
  });

  return (
    <main id="main" className={`page ${styles['surface']}`}>
      <section className="panel pad" style={{ maxWidth: 480, margin: 'min(8vh, 64px) auto 0' }}>
      <div className="eyebrow mb16">ACCOUNT / SIGN IN</div>
      <h1>登录 Creator Studio</h1>
      <p className="small muted mt8">登录后继续你的工作区与作品。</p>
      <form
        className="col mt24"
        onSubmit={(event) => {
          event.preventDefault();
          signIn.mutate();
        }}
      >
        <label className="label" htmlFor="sign-in-email">
          邮箱
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
          密码
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
          {signIn.isPending ? '登录中…' : '登录'}
        </button>
      </form>
      {signIn.isError ? (
        <div className="mt24"><StateBlock
          variant={describeError(signIn.error).kind === 'unauthenticated' ? 'unauthenticated' : 'error'}
          title="登录失败"
          description={describeError(signIn.error).message}
          diagnostics={describeError(signIn.error).code ?? undefined}
          action={{ label: '重试', onClick: () => signIn.mutate() }}
        /></div>
      ) : null}
      </section>
    </main>
  );
}
