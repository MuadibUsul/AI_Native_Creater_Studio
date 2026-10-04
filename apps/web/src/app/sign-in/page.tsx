'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { StateBlock } from '@/ui/StateBlock';

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
    <main className="mx-auto flex max-w-md flex-col gap-6">
      <h1 className="text-2xl font-semibold">登录 Creator Studio</h1>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          signIn.mutate();
        }}
      >
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-slate-300">邮箱</span>
          <input
            aria-label="邮箱"
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="rounded border border-slate-700 bg-slate-950 px-3 py-2"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-slate-300">密码</span>
          <input
            aria-label="密码"
            type="password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="rounded border border-slate-700 bg-slate-950 px-3 py-2"
          />
        </label>
        <button type="submit" disabled={signIn.isPending} className="rounded bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50">
          {signIn.isPending ? '登录中…' : '登录'}
        </button>
      </form>
      {signIn.isError ? (
        <StateBlock
          variant={describeError(signIn.error).kind === 'unauthenticated' ? 'unauthenticated' : 'error'}
          title="登录失败"
          description={describeError(signIn.error).message}
          diagnostics={describeError(signIn.error).code ?? undefined}
          action={{ label: '重试', onClick: () => signIn.mutate() }}
        />
      ) : null}
    </main>
  );
}
