'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';
import type { CreditPack, CreditReconcile, LedgerEntry } from '@ancs/contracts';
import { AncsApiError } from '@ancs/sdk';
import { useI18n } from '@/i18n/I18nProvider';
import type { Messages } from '@/i18n/messages';
import { useAncsClient } from '@/lib/client';
import { useBilling, useCreditPacks, useCreditStatement, useEntitlements } from '@/lib/queries';
import { StateBlock } from './StateBlock';
import ui from './Monochrome.module.css';

/**
 * Credits 与账单（P09-03 / §35、§73.3）：
 * - 余额 / 预扣 / 可用（预扣 = 预算预留，不改变余额）；
 * - 包目录（版本化；价格为数据——0 表示未定价，运营以新版本配置，P09-06 上线门前必须定价）；
 * - 购买：调用 SDK 生成渠道结账 URL（**网页跳转不入账**——入账只经渠道事件，可能延迟数秒）；
 * - 明细（只追加）：充值（事件入账）/ 赠送 / 订阅月授予 / 使用扣减 / 退款扣回（DEBIT + refund_of）；
 * - 对账：收款事件 ↔ 账本条目（不一致 = 明确展示，绝不自动"修正"）。
 */

type BillingText = Messages['workspaceAdmin']['billing'];
type NumberFormat = (value: number) => string;

const errorText = (error: unknown, unknownLabel: string): string =>
  error instanceof AncsApiError ? `${String(error.status)} ${error.code}` : error instanceof Error ? error.message : unknownLabel;

function entryLabel(entry: LedgerEntry, labels: BillingText['entryLabels']): string {
  switch (entry.entryType) {
    case 'CREDIT':
      if (entry.referenceType === 'billing_event') return labels.topUp;
      if (entry.referenceType === 'admin_grant') return labels.grant;
      if (entry.referenceType === 'monthly_grant') return labels.monthlyGrant;
      return labels.credit;
    case 'DEBIT':
      return entry.referenceType === 'refund_of' ? labels.refundClawback : labels.usage;
    case 'REFUND':
      return labels.refund;
    case 'ADJUSTMENT':
      return labels.adjustment;
    case 'HOLD':
      return labels.hold;
    case 'HOLD_RELEASE':
      return labels.holdRelease;
  }
}

/** 符号由 entryType 决定（amount 恒非负）：DEBIT 为 −；HOLD/HOLD_RELEASE 无余额效果。 */
function entryAmountText(entry: LedgerEntry, format: NumberFormat): string {
  if (entry.entryType === 'DEBIT') return `−${format(entry.amount)}`;
  if (entry.entryType === 'HOLD' || entry.entryType === 'HOLD_RELEASE') return format(entry.amount);
  return `+${format(entry.amount)}`;
}

/** 价格为数据：priceMinor=0 表示未定价（种子口径），不虚构货币金额；币种代码原样取自服务端。 */
const priceText = (pack: CreditPack, locale: string, unpriced: string): string =>
  pack.priceMinor > 0
    ? `${new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(pack.priceMinor / 100)} ${pack.currency}`
    : unpriced;

/** 字节用量格式化（1 位小数；null 上限 = 不限）。 */
function formatBytes(bytes: number, locale: string): string {
  const oneDecimal = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (bytes >= 1024 ** 3) return `${oneDecimal.format(bytes / 1024 ** 3)} GB`;
  return `${oneDecimal.format(bytes / 1024 ** 2)} MB`;
}

const limitText = (used: number, limit: number | null, format: NumberFormat, unlimited: (used: string) => string): string =>
  limit === null ? unlimited(format(used)) : `${format(used)} / ${format(limit)}`;

export function CreditsBilling({ workspaceId }: { workspaceId: string }): ReactElement {
  const { messages, locale } = useI18n();
  const t = messages.workspaceAdmin.billing;
  const describe = (error: unknown): string => errorText(error, t.unknownError);
  const numberFormat = new Intl.NumberFormat(locale);
  const formatNumber: NumberFormat = (value) => numberFormat.format(value);
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
      setNotice(t.checkoutReady);
      setCheckoutUrl(result.checkoutUrl);
    },
    onError: (error: unknown) => {
      setNotice(t.buyFailed(describe(error)));
      setCheckoutUrl(null);
    },
  });

  const runReconcile = useMutation({
    mutationFn: () => client.workspaces.reconcileCredits(workspaceId),
    onSuccess: async (result) => {
      setReconcile(result);
      await queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'credits'] });
    },
    onError: (error: unknown) => setNotice(t.reconcileFailed(describe(error))),
  });

  if (statement.isPending) {
    return <StateBlock variant="loading" title={t.loading} />;
  }
  if (statement.isError) {
    return (
      <StateBlock
        variant="error"
        title={t.loadFailed}
        description={t.loadFailedHint}
        diagnostics={describe(statement.error)}
        action={{ label: messages.common.retry, onClick: () => void statement.refetch() }}
      />
    );
  }

  const data = statement.data;
  const entries = data.entries.slice(0, 20);

  return (
    <section data-testid="credits-billing" className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">{t.title}</h1>

      <div className={`${ui['panel']} p-4`}>
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <p className={`text-sm ${ui['secondaryText']}`}>
            {t.plan}<span className={`font-medium ${ui['primaryText']}`}>{billing.data?.state.planKey ?? t.defaultPlan}</span>
            <span className={`ml-2 text-xs ${ui['secondaryText']}`}>{t.subscription(billing.data?.state.state ?? '—')}</span>
          </p>
          <p className={`text-xs ${ui['secondaryText']}`}>{t.ledgerRule}</p>
        </div>
        <dl className="mt-3 flex flex-wrap gap-6 text-sm">
          <div>
            <dt className={`text-xs ${ui['secondaryText']}`}>{t.balance}</dt>
            <dd data-testid="credits-balance" className={`text-lg font-semibold ${ui['primaryText']}`}>
              {formatNumber(data.balanceCredits)}
            </dd>
          </div>
          <div>
            <dt className={`text-xs ${ui['secondaryText']}`}>{t.held}</dt>
            <dd data-testid="credits-held" className={`text-lg font-semibold ${ui['primaryText']}`}>
              {formatNumber(data.heldCredits)}
            </dd>
          </div>
          <div>
            <dt className={`text-xs ${ui['secondaryText']}`}>{t.available}</dt>
            <dd data-testid="credits-available" className={`text-lg font-semibold ${ui['primaryText']}`}>
              {formatNumber(data.availableCredits)}
            </dd>
          </div>
        </dl>
        {entitlement.data !== undefined ? (
          <p data-testid="plan-usage" className={`mt-3 text-xs ${ui['secondaryText']}`}>
            {t.planUsage(
              limitText(entitlement.data.usage.storageBytesUsed, entitlement.data.entitlements.storageBytes, (bytes) => formatBytes(bytes, locale), t.unlimited),
              limitText(entitlement.data.usage.seatsUsed, entitlement.data.entitlements.seats, formatNumber, t.unlimited),
            )}
          </p>
        ) : null}
      </div>

      <div className={`${ui['panel']} p-4`}>
        <h2 className={`text-sm font-semibold ${ui['primaryText']}`}>{t.buyTitle}</h2>
        <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(packs.data ?? []).map((pack) => {
            const purchasable = pack.status === 'ACTIVE' && pack.priceMinor > 0;
            return (
              <li key={`${pack.code}@${String(pack.version)}`} data-testid={`credit-pack-${pack.code}`} className={`flex flex-col gap-2 p-3 ${ui['inset']}`}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className={`text-sm font-medium ${ui['primaryText']}`}>{pack.name}</span>
                  <span className={`text-xs ${ui['mutedText']}`}>v{pack.version}</span>
                </div>
                <p className={`text-xs ${ui['secondaryText']}`}>{t.packCredits(formatNumber(pack.credits))}</p>
                <p className={`text-xs ${pack.priceMinor > 0 ? ui['secondaryText'] : ui['emphasis']}`}>{priceText(pack, locale, t.unpriced)}</p>
                <button
                  type="button"
                  disabled={!purchasable || buy.isPending}
                  title={purchasable ? undefined : t.unpricedHint}
                  onClick={() => buy.mutate(pack.code)}
                  className={`mt-1 ${ui['primaryButton']}`}
                >
                  {t.buy}
                </button>
              </li>
            );
          })}
        </ul>
        {notice !== null ? (
          <p data-testid="credits-notice" role="status" className={`mt-3 text-sm ${ui['notice']}`}>
            {notice}
          </p>
        ) : null}
        {checkoutUrl !== null ? (
          <a data-testid="credits-checkout-link" href={checkoutUrl} target="_blank" rel="noreferrer" className={`mt-2 inline-block text-sm ${ui['link']}`}>
            {t.checkoutLink}
          </a>
        ) : null}
      </div>

      <div className={`${ui['panel']} p-4`}>
        <div className="flex items-center justify-between">
          <h2 className={`text-sm font-semibold ${ui['primaryText']}`}>{t.ledgerTitle}</h2>
          <button
            type="button"
            onClick={() => runReconcile.mutate()}
            disabled={runReconcile.isPending}
            className={ui['button']}
          >
            {t.reconcile}
          </button>
        </div>
        {entries.length === 0 ? (
          <p className={`mt-3 text-sm ${ui['secondaryText']}`}>{t.noEntries}</p>
        ) : (
          <ul className="mt-3 flex flex-col">
            {entries.map((entry) => (
              <li key={entry.id} data-testid={`credit-entry-${entry.id}`} className={`flex items-center justify-between gap-3 border-b py-2 text-sm last:border-b-0 ${ui['divider']}`}>
                <div className="flex flex-col">
                  <span className={ui['primaryText']}>{entryLabel(entry, t.entryLabels)}</span>
                  <span className={`text-xs ${ui['mutedText']}`}>{new Date(entry.createdAt).toLocaleString(locale)}</span>
                </div>
                <span className={`font-mono ${ui['primaryText']}`}>{entryAmountText(entry, formatNumber)}</span>
              </li>
            ))}
          </ul>
        )}
        {reconcile !== null ? (
          <p data-testid="credits-reconcile" role="status" className={`mt-3 text-sm ${reconcile.consistent ? ui['secondaryText'] : ui['notice']}`}>
            {t.reconcileSummary(
              formatNumber(reconcile.purchaseEvents),
              formatNumber(reconcile.purchaseEntries),
              formatNumber(reconcile.refundEntries),
              formatNumber(reconcile.balanceCredits),
            )}{' '}
            {reconcile.consistent ? t.consistent : t.inconsistent}
          </p>
        ) : null}
      </div>
    </section>
  );
}
