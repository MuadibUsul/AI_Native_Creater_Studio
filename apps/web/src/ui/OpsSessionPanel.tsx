'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { OpsSession } from '@ancs/contracts';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';

/** Enrollment secrets live only in this tab until the operator leaves or restarts login. */
export function OpsEnrollmentPanel() {
  const client = useAncsClient();
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
    <h2>运营多因素验证</h2>
    <p className="small muted mt8">已授予运营身份的人员首次启用 TOTP 后，需重新登录完成二次验证。普通工作区角色不授予运营访问。</p>
    {!enroll.data ? <form className="col mt16" onSubmit={(event) => { event.preventDefault(); enroll.mutate(); }}>
      <label className="label" htmlFor="ops-enroll-password">当前密码
        <input id="ops-enroll-password" type="password" autoComplete="current-password" required className="field mt8" value={password} onChange={(event) => setPassword(event.target.value)} />
      </label>
      <button type="submit" className="btn primary" disabled={enroll.isPending}>配置验证器</button>
      {enroll.isError ? <p role="alert" className="small">配置失败：{describeError(enroll.error).message}。如已启用，请退出后重新登录。</p> : null}
    </form> : <div className="col mt16">
      <p className="small">把以下 URI 导入验证器，并将恢复码保存在安全位置。它们只在本次配置中显示。</p>
      <code className="small" style={{ overflowWrap: 'anywhere' }}>{enroll.data.totpUri}</code>
      <ul className="small" aria-label="一次性恢复码">{enroll.data.backupCodes.map((backupCode) => <li key={backupCode}><code>{backupCode}</code></li>)}</ul>
      {!confirmed ? <form className="col" onSubmit={(event) => { event.preventDefault(); verify.mutate(); }}>
        <label className="label" htmlFor="ops-enroll-code">6 位动态验证码
          <input id="ops-enroll-code" className="field mt8" type="text" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" required value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} />
        </label>
        <button type="submit" className="btn primary" disabled={verify.isPending}>确认启用</button>
        {verify.isError ? <p role="alert" className="small">验证码错误：{describeError(verify.error).message}</p> : null}
      </form> : <div className="col"><p role="status">TOTP 已启用。保存恢复码后，重新登录即可进入运营台。</p><button type="button" className="btn primary" onClick={() => void restart()}>保存后重新登录</button></div>}
    </div>}
  </section>;
}

export function OpsSessionPanel({ session }: { session: OpsSession }) {
  const client = useAncsClient();
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  const reauth = useMutation({
    mutationFn: () => client.ops.reauthenticate({ code }),
    onSuccess: (current) => { setCode(''); queryClient.setQueryData(['ops', 'session'], current); },
  });
  const revoke = useMutation({
    mutationFn: () => client.ops.revokeSession({ sessionId: session.id }),
    onSuccess: () => { queryClient.removeQueries({ queryKey: ['admin'] }); window.location.href = '/admin'; },
  });
  return <section className="panel pad" aria-label="运营会话">
    <div className="flex flex-wrap items-center gap-3" role="status" style={{ position: 'sticky', top: 0, zIndex: 10, background: 'var(--panel)', paddingBlock: 8 }}>
      <strong>运营环境：{session.environment}</strong>
      <span className="small muted">角色 {session.roles.join('、')} · 绝对到期 {new Date(session.absoluteExpiresAt).toLocaleString()}</span>
    </div>
    {session.securityNotice === 'NEW_DEVICE' ? <p role="alert" className="small mt8">检测到新设备登录；如非本人操作，请撤销会话并联系安全管理员。</p> : null}
    <form className="flex flex-wrap items-end gap-2 mt16" onSubmit={(event) => { event.preventDefault(); reauth.mutate(); }}>
      <label className="label" htmlFor="ops-reauth-code">敏感操作重新验证
        <input id="ops-reauth-code" className="field mt8" type="text" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" required value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} />
      </label>
      <button type="submit" className="btn" disabled={reauth.isPending}>验证</button>
      <button type="button" className="btn" disabled={revoke.isPending} onClick={() => revoke.mutate()}>撤销此设备</button>
    </form>
    {reauth.isSuccess ? <p role="status" className="small mt8">重新验证成功。</p> : null}
    {reauth.isError ? <p role="alert" className="small mt8">重新验证失败：{describeError(reauth.error).message}</p> : null}
    {revoke.isError ? <p role="alert" className="small mt8">撤销失败：{describeError(revoke.error).message}</p> : null}
  </section>;
}
