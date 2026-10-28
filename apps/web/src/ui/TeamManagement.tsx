'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';
import type { PrivacyTier, WorkspaceRole } from '@ancs/contracts';
import { AncsApiError } from '@ancs/sdk';
import { useI18n } from '@/i18n/I18nProvider';
import { useAncsClient } from '@/lib/client';
import { useEntitlements, useWorkspace, useWorkspaceInvitations, useWorkspaceMembers } from '@/lib/queries';
import { StateBlock } from './StateBlock';
import ui from './Monochrome.module.css';

/**
 * 团队与隐私（P09-04 / 规范 §22、§20.4）：
 * - 成员：角色变更、移除（**撤销后访问立即受限**——服务端每请求重读成员资格）；不得移除最后一名 OWNER；
 * - 邀请：邮箱 + 角色（PENDING 唯一；接受时邮箱匹配 + 权威席位检查）；撤销立即生效；
 * - 席位与用量：Plan 权益数据驱动；**降级后超额** = 明确提示（新增被阻止、存量保留、不自动移除）；
 * - 隐私档位：STANDARD / PRIVATE / ENTERPRISE（非 STANDARD 需套餐权益 privacyMode；降级不静默改写）。
 */

const ROLES: WorkspaceRole[] = ['OWNER', 'ADMIN', 'EDITOR', 'REVIEWER', 'VIEWER'];
const PRIVACY_TIERS: PrivacyTier[] = ['STANDARD', 'PRIVATE', 'ENTERPRISE'];

/** 错误诊断文本：服务端错误显示 status + code；其余显示原始 message，无法识别时用界面语言的"未知错误"。 */
const errorText = (error: unknown, unknownLabel: string): string =>
  error instanceof AncsApiError ? `${String(error.status)} ${error.code}` : error instanceof Error ? error.message : unknownLabel;

export function TeamManagement({ workspaceId }: { workspaceId: string }): ReactElement {
  const { messages, locale } = useI18n();
  const t = messages.workspaceAdmin.team;
  // 超额维度的说明（降级套餐清晰超额处理）；未登记的维度原样显示
  const overCommittedLabels: Record<string, string | undefined> = t.overCommittedLabels;
  const describe = (error: unknown): string => errorText(error, t.unknownError);
  const client = useAncsClient();
  const queryClient = useQueryClient();
  const workspace = useWorkspace(workspaceId);
  const members = useWorkspaceMembers(workspaceId);
  const invitations = useWorkspaceInvitations(workspaceId);
  const entitlement = useEntitlements(workspaceId);
  const [notice, setNotice] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<WorkspaceRole>('EDITOR');
  const [privacyTier, setPrivacyTier] = useState<PrivacyTier>('STANDARD');

  const canManage = workspace.data !== undefined && (workspace.data.role === 'OWNER' || workspace.data.role === 'ADMIN');
  const privacyAllowed = entitlement.data?.entitlements.privacyMode ?? false;
  const overCommitted = entitlement.data?.overCommitted ?? [];

  const invalidateTeam = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'members'] }),
      queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'invitations'] }),
      queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'entitlements'] }),
      queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'detail'] }),
    ]);
  };

  const doAdd = useMutation({
    mutationFn: () => client.workspaces.members.add(workspaceId, { email: inviteEmail, role: inviteRole }),
    onSuccess: async () => {
      setNotice(t.notices.added(inviteEmail, inviteRole));
      setInviteEmail('');
      await invalidateTeam();
    },
    onError: (error: unknown) => setNotice(t.notices.addFailed(describe(error))),
  });

  const doInvite = useMutation({
    mutationFn: () => client.workspaces.invitations.create(workspaceId, { email: inviteEmail, role: inviteRole, locale }),
    onSuccess: async () => {
      setNotice(t.notices.invited(inviteEmail, inviteRole));
      setInviteEmail('');
      await invalidateTeam();
    },
    onError: (error: unknown) => setNotice(t.notices.inviteFailed(describe(error))),
  });

  const doRevoke = useMutation({
    mutationFn: (invitationId: string) => client.workspaces.invitations.revoke(workspaceId, invitationId),
    onSuccess: async () => {
      setNotice(t.notices.revoked);
      await invalidateTeam();
    },
    onError: (error: unknown) => setNotice(t.notices.revokeFailed(describe(error))),
  });

  const doRole = useMutation({
    mutationFn: (input: { userId: string; role: WorkspaceRole }) => client.workspaces.members.updateRole(workspaceId, input.userId, { role: input.role }),
    onSuccess: async () => {
      setNotice(t.notices.roleUpdated);
      await invalidateTeam();
    },
    onError: (error: unknown) => setNotice(t.notices.roleFailed(describe(error))),
  });

  const doRemove = useMutation({
    mutationFn: (userId: string) => client.workspaces.members.remove(workspaceId, userId),
    onSuccess: async () => {
      setNotice(t.notices.removed);
      await invalidateTeam();
    },
    onError: (error: unknown) => setNotice(t.notices.removeFailed(describe(error))),
  });

  const doPrivacy = useMutation({
    mutationFn: () => client.workspaces.setPrivacyTier(workspaceId, { privacyTier }),
    onSuccess: async () => {
      setNotice(t.notices.privacySet(privacyTier));
      await invalidateTeam();
    },
    onError: (error: unknown) => setNotice(t.notices.privacyFailed(describe(error))),
  });

  if (workspace.isPending || members.isPending) {
    return <StateBlock variant="loading" title={t.loading} />;
  }
  if (workspace.isError || members.isError) {
    return (
      <StateBlock
        variant="error"
        title={t.loadFailed}
        description={t.loadFailedHint}
        diagnostics={describe(workspace.error ?? members.error)}
        action={{ label: messages.common.retry, onClick: () => void workspace.refetch() }}
      />
    );
  }

  const currentTier = workspace.data.privacyTier;
  const ownerCount = members.data.filter((member) => member.role === 'OWNER').length;

  return (
    <section data-testid="team-management" className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">{t.title}</h1>
      <p className={`text-sm ${ui['secondaryText']}`}>
        {t.myRole}<span className={ui['primaryText']}>{workspace.data.role}</span>
        {canManage ? t.canManage : t.readOnly}
      </p>

      {overCommitted.length > 0 ? (
        <div data-testid="over-committed" className={`text-sm ${ui['notice']}`}>
          {t.overCommitted(overCommitted.map((dimension) => overCommittedLabels[dimension] ?? dimension))} {t.overCommittedHint}
        </div>
      ) : null}

      {notice !== null ? (
        <p data-testid="team-notice" role="status" className={`text-sm ${ui['notice']}`}>
          {notice}
        </p>
      ) : null}

      <div className={`${ui['panel']} p-4`}>
        <h2 className={`text-sm font-semibold ${ui['primaryText']}`}>{t.members(String(members.data.length))}</h2>
        <ul className="mt-3 flex flex-col">
          {members.data.map((member) => (
            <li key={member.userId} data-testid={`member-${member.userId}`} className={`flex flex-wrap items-center justify-between gap-3 border-b py-2 text-sm last:border-b-0 ${ui['divider']}`}>
              <div className="flex flex-col">
                <span className={ui['primaryText']}>
                  {member.name} <span className={`text-xs ${ui['secondaryText']}`}>{member.email}</span>
                </span>
                <span className={`text-xs ${ui['mutedText']}`}>{t.joinedAt(new Date(member.joinedAt).toLocaleString(locale))}</span>
              </div>
              <div className="flex items-center gap-2">
                <select
                  aria-label={t.roleAria(member.email)}
                  disabled={!canManage || doRole.isPending || (member.role === 'OWNER' && ownerCount === 1)}
                  title={member.role === 'OWNER' && ownerCount === 1 ? t.lastOwnerRole : undefined}
                  value={member.role}
                  onChange={(event) => doRole.mutate({ userId: member.userId, role: event.target.value as WorkspaceRole })}
                  className={ui['field']}
                >
                  {ROLES.map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={!canManage || doRemove.isPending || (member.role === 'OWNER' && ownerCount === 1)}
                  title={member.role === 'OWNER' && ownerCount === 1 ? t.lastOwnerRemove : undefined}
                  onClick={() => doRemove.mutate(member.userId)}
                  className={ui['dangerButton']}
                >
                  {t.remove}
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className={`${ui['panel']} p-4`}>
        <h2 className={`text-sm font-semibold ${ui['primaryText']}`}>{t.invitations}</h2>
        <div className="mt-3 flex flex-wrap items-end gap-3 text-sm">
          <label className={`flex flex-col gap-1 ${ui['secondaryText']}`}>
            {t.email}
            <input
              aria-label={t.inviteEmailAria}
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.target.value)}
              className={ui['field']}
              placeholder="name@example.com"
            />
          </label>
          <label className={`flex flex-col gap-1 ${ui['secondaryText']}`}>
            {t.role}
            <select
              aria-label={t.inviteRoleAria}
              value={inviteRole}
              onChange={(event) => setInviteRole(event.target.value as WorkspaceRole)}
              className={ui['field']}
            >
              {ROLES.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={!canManage || inviteEmail === '' || doInvite.isPending}
            onClick={() => doInvite.mutate()}
            className={ui['primaryButton']}
          >
            {t.invite}
          </button>
          <button
            type="button"
            disabled={!canManage || inviteEmail === '' || doAdd.isPending}
            onClick={() => doAdd.mutate()}
            title={t.addDirectlyHint}
            className={ui['button']}
          >
            {t.addDirectly}
          </button>
        </div>
        <p className={`mt-2 text-xs ${ui['mutedText']}`}>{t.acceptRule}</p>
        <ul className="mt-3 flex flex-col">
          {(invitations.data ?? []).map((invitation) => (
            <li key={invitation.id} data-testid={`invitation-${invitation.id}`} className={`flex items-center justify-between gap-3 border-b py-2 text-sm last:border-b-0 ${ui['divider']}`}>
              <div className="flex flex-col">
                <span className={ui['primaryText']}>
                  {invitation.email} <span className={`text-xs ${ui['secondaryText']}`}>{invitation.role}</span>
                </span>
                <span className={`text-xs ${invitation.status === 'PENDING' ? ui['emphasis'] : ui['mutedText']}`}>{invitation.status}</span>
              </div>
              <button
                type="button"
                disabled={!canManage || invitation.status !== 'PENDING' || doRevoke.isPending}
                onClick={() => doRevoke.mutate(invitation.id)}
                className={ui['button']}
              >
                {t.revoke}
              </button>
            </li>
          ))}
          {(invitations.data ?? []).length === 0 ? <li className={`py-2 text-sm ${ui['secondaryText']}`}>{t.noInvitations}</li> : null}
        </ul>
      </div>

      <div className={`${ui['panel']} p-4`}>
        <h2 className={`text-sm font-semibold ${ui['primaryText']}`}>{t.privacyTitle}</h2>
        <p className={`mt-1 text-xs ${ui['secondaryText']}`}>
          {t.currentTier}<span data-testid="privacy-tier" className={ui['primaryText']}>{currentTier}</span>
          {!privacyAllowed ? t.privacyNotEntitled : ''}
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-3 text-sm">
          <label className={`flex flex-col gap-1 ${ui['secondaryText']}`}>
            {t.tier}
            <select
              aria-label={t.privacyTierAria}
              value={privacyTier}
              onChange={(event) => setPrivacyTier(event.target.value as PrivacyTier)}
              className={ui['field']}
            >
              {PRIVACY_TIERS.map((tier) => (
                <option key={tier} value={tier}>
                  {tier}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={!canManage || doPrivacy.isPending || (privacyTier !== 'STANDARD' && !privacyAllowed)}
            title={privacyTier !== 'STANDARD' && !privacyAllowed ? t.privacyNeedsEntitlement : undefined}
            onClick={() => doPrivacy.mutate()}
            className={ui['primaryButton']}
          >
            {t.applyTier}
          </button>
        </div>
        <p className={`mt-2 text-xs ${ui['mutedText']}`}>{t.downgradeNote}</p>
      </div>
    </section>
  );
}
