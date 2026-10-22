'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { queryKeys } from '@/lib/queries';
import { useI18n } from '@/i18n/I18nProvider';

/**
 * 首页的待接受邀请（D-04）：被邀请的人注册 / 登录后在这里一键加入工作区。
 * 只列有效（PENDING）的邀请；没有就什么都不显示。
 */
export function PendingInvitations({ onJoined }: { onJoined: (workspaceId: string) => void }) {
  const client = useAncsClient();
  const queryClient = useQueryClient();
  const { messages } = useI18n();
  const t = messages.account.invitations;
  const invitations = useQuery({ queryKey: ['invitations', 'mine'] as const, queryFn: () => client.invitations.mine() });
  const accept = useMutation({
    mutationFn: (invitationId: string) => client.invitations.accept(invitationId),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['invitations', 'mine'] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaces });
      onJoined(result.workspace.id);
    },
  });
  const pending = (invitations.data ?? []).filter((item) => item.status === 'PENDING');
  if (pending.length === 0) return null;
  return (
    <section className="panel pad mt16" aria-labelledby="pending-invitations-title" data-pending-invitations="" style={{ maxWidth: 640, margin: '16px auto 0', width: '100%' }}>
      <h2 id="pending-invitations-title" className="small">{t.title}</h2>
      <ul className="col mt8" style={{ gap: 8, listStyle: 'none', padding: 0, margin: 0 }}>
        {pending.map((invitation) => (
          <li key={invitation.id} className="row between gap8">
            <span>{t.item(invitation.workspaceName)}</span>
            <button type="button" className="btn primary small" disabled={accept.isPending} onClick={() => accept.mutate(invitation.id)}>
              {accept.isPending && accept.variables === invitation.id ? t.accepting : t.accept}
            </button>
          </li>
        ))}
      </ul>
      {accept.isError ? <p className="small mt8" role="alert">{t.failed}：{describeError(accept.error).message}</p> : null}
    </section>
  );
}
