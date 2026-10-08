'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';
import type { PrivacyTier, WorkspaceRole } from '@ancs/contracts';
import { AncsApiError } from '@ancs/sdk';
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

const errorText = (error: unknown): string =>
  error instanceof AncsApiError ? `${String(error.status)} ${error.code}` : error instanceof Error ? error.message : '未知错误';

/** 超额维度的中文说明（降级套餐清晰超额处理） */
const OVER_COMMITTED_LABEL: Record<string, string> = {
  seats: '席位',
  storageBytes: '存储',
  maxChannels: '栏目',
  maxCreatorIdentities: '创作者身份',
  customMotionPerMonth: 'Custom Motion 月度预算',
  privacyMode: '隐私档位',
};

export function TeamManagement({ workspaceId }: { workspaceId: string }): ReactElement {
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
      setNotice(`已添加成员 ${inviteEmail}（角色 ${inviteRole}）。`);
      setInviteEmail('');
      await invalidateTeam();
    },
    onError: (error: unknown) => setNotice(`添加失败：${errorText(error)}（席位不足时请升级套餐）`),
  });

  const doInvite = useMutation({
    mutationFn: () => client.workspaces.invitations.create(workspaceId, { email: inviteEmail, role: inviteRole }),
    onSuccess: async () => {
      setNotice(`已创建邀请：${inviteEmail}（角色 ${inviteRole}；有效期以服务端为准）。对方登录后在我的邀请中接受。`);
      setInviteEmail('');
      await invalidateTeam();
    },
    onError: (error: unknown) => setNotice(`邀请失败：${errorText(error)}（席位居早期检查：成员 + 待接受邀请）`),
  });

  const doRevoke = useMutation({
    mutationFn: (invitationId: string) => client.workspaces.invitations.revoke(workspaceId, invitationId),
    onSuccess: async () => {
      setNotice('邀请已撤销（立即生效，不可再接受）。');
      await invalidateTeam();
    },
    onError: (error: unknown) => setNotice(`撤销失败：${errorText(error)}`),
  });

  const doRole = useMutation({
    mutationFn: (input: { userId: string; role: WorkspaceRole }) => client.workspaces.members.updateRole(workspaceId, input.userId, { role: input.role }),
    onSuccess: async () => {
      setNotice('角色已更新。');
      await invalidateTeam();
    },
    onError: (error: unknown) => setNotice(`角色变更失败：${errorText(error)}（OWNER 不变量由服务端强制）`),
  });

  const doRemove = useMutation({
    mutationFn: (userId: string) => client.workspaces.members.remove(workspaceId, userId),
    onSuccess: async () => {
      setNotice('成员已移除：其访问立即失效（下一次请求会返回未找到）。');
      await invalidateTeam();
    },
    onError: (error: unknown) => setNotice(`移除失败：${errorText(error)}（不得移除最后一名 OWNER）`),
  });

  const doPrivacy = useMutation({
    mutationFn: () => client.workspaces.setPrivacyTier(workspaceId, { privacyTier }),
    onSuccess: async () => {
      setNotice(`隐私档位已设为 ${privacyTier}。`);
      await invalidateTeam();
    },
    onError: (error: unknown) => setNotice(`设置隐私档位失败：${errorText(error)}（该档位需要套餐权益 privacyMode）`),
  });

  if (workspace.isPending || members.isPending) {
    return <StateBlock variant="loading" title="正在加载团队信息…" />;
  }
  if (workspace.isError || members.isError) {
    return (
      <StateBlock
        variant="error"
        title="团队信息加载失败"
        description="请检查会话与网络后重试。"
        diagnostics={errorText(workspace.error ?? members.error)}
        action={{ label: '重试', onClick: () => void workspace.refetch() }}
      />
    );
  }

  const currentTier = workspace.data.privacyTier;
  const ownerCount = members.data.filter((member) => member.role === 'OWNER').length;

  return (
    <section data-testid="team-management" className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">团队与隐私</h1>
      <p className={`text-sm ${ui['secondaryText']}`}>
        我的角色：<span className={ui['primaryText']}>{workspace.data.role}</span>
        {canManage ? '（可管理成员与邀请）' : '（只读——成员管理需 OWNER/ADMIN）'}
      </p>

      {overCommitted.length > 0 ? (
        <div data-testid="over-committed" className={`text-sm ${ui['notice']}`}>
          已超出当前套餐上限：{overCommitted.map((dimension) => OVER_COMMITTED_LABEL[dimension] ?? dimension).join('、')}。
          新增会被阻止；「现有成员与数据保留」（系统不会自动移除/删除）。请升级套餐或显式调整。
        </div>
      ) : null}

      {notice !== null ? (
        <p data-testid="team-notice" role="status" className={`text-sm ${ui['notice']}`}>
          {notice}
        </p>
      ) : null}

      <div className={`${ui['panel']} p-4`}>
        <h2 className={`text-sm font-semibold ${ui['primaryText']}`}>成员（{members.data.length}）</h2>
        <ul className="mt-3 flex flex-col">
          {members.data.map((member) => (
            <li key={member.userId} data-testid={`member-${member.userId}`} className={`flex flex-wrap items-center justify-between gap-3 border-b py-2 text-sm last:border-b-0 ${ui['divider']}`}>
              <div className="flex flex-col">
                <span className={ui['primaryText']}>
                  {member.name} <span className={`text-xs ${ui['secondaryText']}`}>{member.email}</span>
                </span>
                <span className={`text-xs ${ui['mutedText']}`}>加入于 {new Date(member.joinedAt).toLocaleString()}</span>
              </div>
              <div className="flex items-center gap-2">
                <select
                  aria-label={`角色-${member.email}`}
                  disabled={!canManage || doRole.isPending || (member.role === 'OWNER' && ownerCount === 1)}
                  title={member.role === 'OWNER' && ownerCount === 1 ? '工作区必须保留至少一名所有者' : undefined}
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
                  title={member.role === 'OWNER' && ownerCount === 1 ? '不能移除工作区最后一名所有者' : undefined}
                  onClick={() => doRemove.mutate(member.userId)}
                  className={ui['dangerButton']}
                >
                  移除
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className={`${ui['panel']} p-4`}>
        <h2 className={`text-sm font-semibold ${ui['primaryText']}`}>邀请</h2>
        <div className="mt-3 flex flex-wrap items-end gap-3 text-sm">
          <label className={`flex flex-col gap-1 ${ui['secondaryText']}`}>
            邮箱
            <input
              aria-label="邀请邮箱"
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.target.value)}
              className={ui['field']}
              placeholder="name@example.com"
            />
          </label>
          <label className={`flex flex-col gap-1 ${ui['secondaryText']}`}>
            角色
            <select
              aria-label="邀请角色"
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
            邀请
          </button>
          <button
            type="button"
            disabled={!canManage || inviteEmail === '' || doAdd.isPending}
            onClick={() => doAdd.mutate()}
            title="对方账号已存在时可直接添加为成员"
            className={ui['button']}
          >
            直接添加成员
          </button>
        </div>
        <p className={`mt-2 text-xs ${ui['mutedText']}`}>接受条件：登录邮箱 = 邀请邮箱；接受时按套餐席位权威复查（降级后可能被阻止）。</p>
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
                撤销
              </button>
            </li>
          ))}
          {(invitations.data ?? []).length === 0 ? <li className={`py-2 text-sm ${ui['secondaryText']}`}>暂无邀请。</li> : null}
        </ul>
      </div>

      <div className={`${ui['panel']} p-4`}>
        <h2 className={`text-sm font-semibold ${ui['primaryText']}`}>隐私档位（§20.4）</h2>
        <p className={`mt-1 text-xs ${ui['secondaryText']}`}>
          当前：<span data-testid="privacy-tier" className={ui['primaryText']}>{currentTier}</span>
          {!privacyAllowed ? '（当前套餐不含隐私模式权益——PRIVATE/ENTERPRISE 不可设置）' : ''}
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-3 text-sm">
          <label className={`flex flex-col gap-1 ${ui['secondaryText']}`}>
            档位
            <select
              aria-label="隐私档位"
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
            title={privacyTier !== 'STANDARD' && !privacyAllowed ? '需要套餐权益 privacyMode（升级后设置）' : undefined}
            onClick={() => doPrivacy.mutate()}
            className={ui['primaryButton']}
          >
            应用档位
          </button>
        </div>
        <p className={`mt-2 text-xs ${ui['mutedText']}`}>降级套餐不会静默改写档位（进入"超额"清单，由你显式调整）。</p>
      </div>
    </section>
  );
}
