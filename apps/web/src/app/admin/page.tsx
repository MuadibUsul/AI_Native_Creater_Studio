'use client';

import { useQuery } from '@tanstack/react-query';
import { describeError } from '@/lib/errors';
import { useAncsClient } from '@/lib/client';
import { StateBlock } from '@/ui/StateBlock';
import { SecurityOps } from '@/ui/SecurityOps';
import { OpsEnrollmentPanel, OpsSessionPanel } from '@/ui/OpsSessionPanel';
import styles from './ops.module.css';

export default function AdminPage() {
  const client = useAncsClient();
  const session = useQuery({
    queryKey: ['ops', 'session'],
    queryFn: () => client.ops.session(),
    retry: false,
    refetchInterval: 30_000,
  });

  return <section className={styles['page']}>
    <header className={styles['heading']}>
      <p className={styles['eyebrow']}>PLATFORM / OPERATIONS</p>
      <h1>运营诊断</h1>
      <p>按当前运营身份与授权范围查看工作区状态。所有查询都由服务端重新核验。</p>
    </header>

    {session.isPending ? <StateBlock variant="info" title="正在检查运营会话" description="正在确认环境、角色与会话有效期。" /> : null}
    {session.isError ? <>
      <StateBlock
        variant={((session.error as { status?: number } | null)?.status === 404) ? 'info' : 'error'}
        title={((session.error as { status?: number } | null)?.status === 404) ? '需要独立运营会话' : '运营会话检查失败'}
        description={((session.error as { status?: number } | null)?.status === 404)
          ? '普通工作区身份不授予运营访问。已获授权的人员请完成多因素登录；会话过期后重新登录。'
          : describeError(session.error).message}
        action={{ label: '重试检查', onClick: () => void session.refetch() }}
      />
      <a className="btn" href="/sign-in">前往登录</a>
      <details className={styles['enrollment']}>
        <summary>已获运营授权，首次配置验证器</summary>
        <OpsEnrollmentPanel />
      </details>
    </> : null}

    {session.data && !session.isError ? <>
      <OpsSessionPanel session={session.data} />
      {session.data.environment === 'PRODUCTION' ? (
        <StateBlock variant="info" title="生产运营诊断暂未开放" description="生产旧运营查询保持关闭，等待逐动作授权与安全投影完成。" />
      ) : <SecurityOps key={session.data.id} session={session.data} />}
    </> : null}
  </section>;
}
