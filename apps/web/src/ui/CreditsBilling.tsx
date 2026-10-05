'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';
import type { CreditPack, CreditReconcile, LedgerEntry } from '@ancs/contracts';
import { AncsApiError } from '@ancs/sdk';
import { useAncsClient } from '@/lib/client';
import { useBilling, useCreditPacks, useCreditStatement, useEntitlements } from '@/lib/queries';
import { StateBlock } from './StateBlock';

/**
 * Credits 与账单（P09-03 / §35、§73.3）：
 * - 余额 / 预扣 / 可用（预扣 = 预算预留，不改变余额）；
 * - 包目录（版本化；价格为数据——0 表示未定价，运营以新版本配置，P09-06 上线门前必须定价）；
 * - 购买：调用 SDK 生成渠道结账 URL（**网页跳转不入账**——入账只经渠道事件，可能延迟数秒）；
 * - 明细（只追加）：充值（事件入账）/ 赠送 / 订阅月授予 / 使用扣减 / 退款扣回（DEBIT + refund_of）；
 * - 对账：收款事件 ↔ 账本条目（不一致 = 明确展示，绝不自动"修正"）。
 */

const errorText = (error: unknown): string =>
  error instanceof AncsApiError ? `${String(error.status)} ${error.code}` : error instanceof Error ? error.message : '未知错误';

function entryLabel(entry: LedgerEntry): string {
  switch (entry.entryType) {
    case 'CREDIT':
      if (entry.referenceType === 'billing_event') return '充值（事件入账）';
      if (entry.referenceType === 'admin_grant') return '赠送';
      if (entry.referenceType === 'monthly_grant') return '订阅月授予';
      return '入账';
    case 'DEBIT':
      return entry.referenceType === 'refund_of' ? '退款扣回' : '使用扣减';
    case 'REFUND':
      return '退款返还';
    case 'ADJUSTMENT':
      return '调整';
    case 'HOLD':
      return '预算预留（不影响余额）';
    case 'HOLD_RELEASE':
      return '预留释放（不影响余额）';
  }
}

/** 符号由 entryType 决定（amount 恒非负）：DEBIT 为 −；HOLD/HOLD_RELEASE 无余额效果。 */
function entryAmountText(entry: LedgerEntry): string {
  if (entry.entryType === 'DEBIT') return `−${String(entry.amount)}`;
  if (entry.entryType === 'HOLD' || entry.entryType === 'HOLD_RELEASE') return String(entry.amount);
  return `+${String(entry.amount)}`;
}

/** 价格为数据：priceMinor=0 表示未定价（种子口径），不虚构货币金额。 */
const priceText = (pack: CreditPack): string => (pack.priceMinor > 0 ? `${(pack.priceMinor / 100).toFixed(2)} ${pack.currency}` : '未定价');

/** 字节用量格式化（1 位小数；null 上限 = 不限）。 */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

const limitText = (used: number, limit: number | null, format: (value: number) => string): string =>
  limit === null ? `${format(used)}（不限）` : `${format(used)} / ${format(limit)}`;

export function CreditsBilling({ workspaceId }: { workspaceId: string }): ReactElement {
  const client = useAncsClient();
  const queryClient = useQueryClient();
  const statement = useCreditStatement(workspaceId);
  const packs = useCreditPacks(workspaceId);
  const billing = useBilling(workspaceId);
  const entitlement = useEntitlements(workspaceId);
  const [notice, setNotice] = useState<string | null>(null);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [reconcile, setReconcile] = useState<CreditReconcile | null>(null);

  const buy = useMutation({
    mutationFn: (packCode: string) => client.workspaces.buyCredits(workspaceId, { packCode }),
    onSuccess: (result) => {
      setNotice('已生成渠道结账链接。支付完成后由渠道事件入账（入账只经事件，且有延迟）。');
      setCheckoutUrl(result.checkoutUrl);
    },
    onError: (error: unknown) => {
      setNotice(`发起购买失败：${errorText(error)}`);
      setCheckoutUrl(null);
    },
  });

  const runReconcile = useMutation({
    mutationFn: () => client.workspaces.reconcileCredits(workspaceId),
    onSuccess: async (result) => {
      setReconcile(result);
      await queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'credits'] });
    },
    onError: (error: unknown) => setNotice(`对账失败：${errorText(error)}`),
  });

  if (statement.isPending) {
    return <StateBlock variant="loading" title="正在加载 Credits 账单…" />;
  }
  if (statement.isError) {
    return (
      <StateBlock
        variant="error"
        title="Credits 账单加载失败"
        description="请检查会话与网络后重试。"
        diagnostics={errorText(statement.error)}
        action={{ label: '重试', onClick: () => void statement.refetch() }}
      />
    );
  }

  const data = statement.data;
  const entries = data.entries.slice(0, 20);

  return (
    <section data-testid="credits-billing" className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Credits 与账单</h1>

      <div className="rounded border border-slate-800 bg-slate-900/60 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <p className="text-sm text-slate-300">
            套餐：<span className="font-medium text-slate-100">{billing.data?.state.planKey ?? '默认套餐'}</span>
            <span className="ml-2 text-xs text-slate-400">订阅状态：{billing.data?.state.state ?? '—'}</span>
          </p>
          <p className="text-xs text-slate-400">入账口径：支付成功事件入账且「至多一次」；网页跳转不触发入账。</p>
        </div>
        <dl className="mt-3 flex flex-wrap gap-6 text-sm">
          <div>
            <dt className="text-xs text-slate-400">余额</dt>
            <dd data-testid="credits-balance" className="text-lg font-semibold text-slate-100">
              {data.balanceCredits}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-400">预扣（预算预留）</dt>
            <dd data-testid="credits-held" className="text-lg font-semibold text-amber-300">
              {data.heldCredits}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-400">可用</dt>
            <dd data-testid="credits-available" className="text-lg font-semibold text-emerald-300">
              {data.availableCredits}
            </dd>
          </div>
        </dl>
        {entitlement.data !== undefined ? (
          <p data-testid="plan-usage" className="mt-3 text-xs text-slate-400">
            用量（Plan 权益核算）：存储 {limitText(entitlement.data.usage.storageBytesUsed, entitlement.data.entitlements.storageBytes, formatBytes)} · 席位{' '}
            {limitText(entitlement.data.usage.seatsUsed, entitlement.data.entitlements.seats, String)}
          </p>
        ) : null}
      </div>

      <div className="rounded border border-slate-800 bg-slate-900/60 p-4">
        <h2 className="text-sm font-semibold text-slate-200">购买 Credits</h2>
        <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(packs.data ?? []).map((pack) => {
            const purchasable = pack.status === 'ACTIVE' && pack.priceMinor > 0;
            return (
              <li key={`${pack.code}@${String(pack.version)}`} data-testid={`credit-pack-${pack.code}`} className="flex flex-col gap-2 rounded border border-slate-800 bg-slate-950/60 p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-medium text-slate-100">{pack.name}</span>
                  <span className="text-xs text-slate-400">v{pack.version}</span>
                </div>
                <p className="text-xs text-slate-300">{pack.credits} Credits</p>
                <p className={`text-xs ${pack.priceMinor > 0 ? 'text-slate-300' : 'text-amber-300'}`}>{priceText(pack)}</p>
                <button
                  type="button"
                  disabled={!purchasable || buy.isPending}
                  title={purchasable ? undefined : '未定价（待运营配置价格版本；上线门 P09-06 前必须定价）'}
                  onClick={() => buy.mutate(pack.code)}
                  className="mt-1 rounded bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  购买
                </button>
              </li>
            );
          })}
        </ul>
        {notice !== null ? (
          <p data-testid="credits-notice" className="mt-3 text-sm text-slate-300">
            {notice}
          </p>
        ) : null}
        {checkoutUrl !== null ? (
          <a data-testid="credits-checkout-link" href={checkoutUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block text-sm text-sky-300 underline">
            前往渠道结账页完成支付（网页返回不代表入账——入账以渠道事件为准）
          </a>
        ) : null}
      </div>

      <div className="rounded border border-slate-800 bg-slate-900/60 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-200">账单明细（只追加）</h2>
          <button
            type="button"
            onClick={() => runReconcile.mutate()}
            disabled={runReconcile.isPending}
            className="rounded border border-slate-600 px-3 py-1 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-50"
          >
            对账（事件 ↔ 账本）
          </button>
        </div>
        {entries.length === 0 ? (
          <p className="mt-3 text-sm text-slate-400">暂无 Credits 流水（充值/赠送/使用后在此展示）。</p>
        ) : (
          <ul className="mt-3 flex flex-col">
            {entries.map((entry) => (
              <li key={entry.id} data-testid={`credit-entry-${entry.id}`} className="flex items-center justify-between gap-3 border-b border-slate-800 py-2 text-sm last:border-b-0">
                <div className="flex flex-col">
                  <span className="text-slate-200">{entryLabel(entry)}</span>
                  <span className="text-xs text-slate-500">{new Date(entry.createdAt).toLocaleString()}</span>
                </div>
                <span className={entry.entryType === 'DEBIT' ? 'font-mono text-rose-300' : 'font-mono text-emerald-300'}>{entryAmountText(entry)}</span>
              </li>
            ))}
          </ul>
        )}
        {reconcile !== null ? (
          <p data-testid="credits-reconcile" className={reconcile.consistent ? 'mt-3 text-sm text-emerald-300' : 'mt-3 text-sm text-rose-300'}>
            收款事件 {reconcile.purchaseEvents} · 账本入账条目 {reconcile.purchaseEntries} · 退款条目 {reconcile.refundEntries} · 余额 {reconcile.balanceCredits} ——{' '}
            {reconcile.consistent ? '一致' : '不一致（需人工排查，系统不会自动修正）'}
          </p>
        ) : null}
      </div>
    </section>
  );
}
