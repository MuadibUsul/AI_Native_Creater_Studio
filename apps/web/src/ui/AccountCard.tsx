'use client';

import { useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { useI18n } from '@/i18n/I18nProvider';
import styles from '@/components/quiet-frame/legacy.module.css';

/** 账号自助页（注册 / 验证 / 找回 / 重设）的共同外框：与登录页同一张居中卡片。 */
export function AccountCard({ eyebrow, title, intro, children }: { eyebrow: string; title: string; intro?: string | undefined; children: ReactNode }) {
  return (
    <main id="main" className={`page ${styles['surface']}`}>
      <section className="panel pad" style={{ maxWidth: 480, margin: 'min(8vh, 64px) auto 0' }}>
        <div className="eyebrow mb16">{eyebrow}</div>
        <h1>{title}</h1>
        {intro === undefined ? null : <p className="small muted mt8">{intro}</p>}
        {children}
      </section>
    </main>
  );
}

/** 服务端错误信封里的业务原因（如 SIGNUP_INVITE_REQUIRED）；不是服务端错误时为 null */
export function errorReason(error: unknown): string | null {
  const reason = describeError(error).details['reason'];
  return typeof reason === 'string' ? reason : null;
}

/** "请查收邮件"：注册后 / 重发验证；可再发一次（答复不透露邮箱是否存在）。 */
export function CheckInbox({ email }: { email: string }) {
  const client = useAncsClient();
  const { locale, messages } = useI18n();
  const t = messages.account.checkInbox;
  const [resent, setResent] = useState(false);
  const resend = useMutation({
    mutationFn: () => client.auth.resendVerification({ email, locale }),
    onSuccess: () => setResent(true),
  });
  return (
    <div className="col mt24" role="status" data-check-inbox="">
      <h2>{t.title}</h2>
      <p>{t.body(email)}</p>
      <div className="row gap8 mt16">
        <button type="button" className="btn" disabled={resend.isPending} onClick={() => resend.mutate()}>{resend.isPending ? t.resending : t.resend}</button>
        <a className="btn ghost" href="/sign-in">{t.back}</a>
      </div>
      {resent ? <p className="small muted mt8">{t.resent}</p> : null}
      {resend.isError ? <p className="small mt8" role="alert">{describeError(resend.error).message}</p> : null}
    </div>
  );
}
