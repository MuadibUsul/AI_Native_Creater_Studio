import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { mockClient, renderWithClient } from '@/test-utils.js';

vi.mock('next/navigation', () => ({
  useParams: () => ({ workspaceId: 'ws_1' }),
  usePathname: () => '/w/ws_1/billing',
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: unknown; href: string }) => <a href={href}>{children as never}</a>,
}));

const { default: BillingPage } = await import('@/app/w/[workspaceId]/billing/page.js');

/**
 * Credits 与账单（P09-03）状态矩阵：
 * - 余额/预扣/可用 + 明细标签（充值（事件入账）/退款扣回 = DEBIT+refund_of）；
 * - 购买调用 SDK 并展示渠道结账链接（**网页跳转不入账**——按钮 disabled 的未定价包不得可购）；
 * - 对账结果展示（一致/不一致明确）。
 */

const pack = (overrides: Record<string, unknown> = {}) => ({
  id: 'cpk_1',
  code: 'starter',
  version: 1,
  name: 'Starter 包',
  credits: 500,
  priceMinor: 0,
  currency: 'USD',
  status: 'ACTIVE',
  createdAt: '2026-10-05T10:00:00.000Z',
  ...overrides,
});

const ledger = (overrides: Record<string, unknown> = {}) => ({
  id: 'led_1',
  workspaceId: 'ws_1',
  entryType: 'CREDIT',
  amount: 500,
  referenceType: 'billing_event',
  referenceId: 'evt_1',
  metadata: {},
  createdAt: '2026-10-05T10:00:00.000Z',
  ...overrides,
});

const statement = (overrides: Record<string, unknown> = {}) => ({
  workspaceId: 'ws_1',
  balanceCredits: 200,
  heldCredits: 0,
  availableCredits: 200,
  entries: [],
  ...overrides,
});

const billingState = {
  state: { workspaceId: 'ws_1', state: 'NONE', planKey: null, providerSubscriptionRef: null, currentPeriodEnd: null, lastEventAt: null, updatedAt: '2026-10-05T10:00:00.000Z' },
  plan: null,
  events: [],
};

const entitlement = {
  workspaceId: 'ws_1',
  plan: { id: 'pln_1', planKey: 'FREE', version: 1, name: 'Free / Trial', entitlements: {}, price: null, status: 'ACTIVE', createdAt: '2026-10-05T10:00:00.000Z' },
  entitlements: { seats: 1, storageBytes: 2 * 1024 ** 3, managedCreditsPerMonth: 0 },
  usage: { storageBytesUsed: 512 * 1024 ** 2, seatsUsed: 1, channelsUsed: 0, creatorIdentitiesUsed: 0, customMotionUsedThisMonth: 0 },
  source: 'DEFAULT_FREE',
};

describe('Credits 与账单（P09-03）', () => {
  it('余额/预扣/可用与明细标签：充值（事件入账）与退款扣回（DEBIT + refund_of）', async () => {
    const client = mockClient({
      workspaces: {
        creditStatement: vi.fn().mockResolvedValue(
          statement({
            heldCredits: 30,
            availableCredits: 170,
            entries: [
              ledger({ id: 'led_refund', entryType: 'DEBIT', amount: 300, referenceType: 'refund_of', referenceId: 'led_grant' }),
              ledger(),
              ledger({ id: 'led_grant', entryType: 'CREDIT', amount: 300, referenceType: 'admin_grant' }),
            ],
          }),
        ),
        creditPacks: vi.fn().mockResolvedValue([pack()]),
        billing: vi.fn().mockResolvedValue(billingState),
        entitlements: vi.fn().mockResolvedValue(entitlement),
      },
    });
    renderWithClient(<BillingPage />, client);

    expect((await screen.findByTestId('credits-balance')).textContent).toBe('200');
    expect(screen.getByTestId('credits-held').textContent).toBe('30');
    expect(screen.getByTestId('credits-available').textContent).toBe('170');
    // 用量展示（Plan 权益核算；上限数据驱动）
    expect((await screen.findByTestId('plan-usage')).textContent).toMatch(/存储 512\.0 MB \/ 2\.0 GB · 席位 1 \/ 1/);
    expect(screen.getByText('充值（事件入账）')).toBeTruthy();
    expect(screen.getByText('退款扣回')).toBeTruthy();
    expect(screen.getByText('赠送')).toBeTruthy();
    expect(screen.getByText('−300')).toBeTruthy();
  });

  it('未定价包不可购买；定价包购买后展示渠道结账链接（跳转不入账）', async () => {
    const buyCredits = vi.fn().mockResolvedValue({ checkoutUrl: 'https://payments.mock.local/checkout?pack=creator_2000', providerSubscriptionRef: null });
    const client = mockClient({
      workspaces: {
        creditStatement: vi.fn().mockResolvedValue(statement()),
        creditPacks: vi.fn().mockResolvedValue([pack(), pack({ id: 'cpk_2', code: 'creator_2000', name: 'Creator 2000', credits: 2000, priceMinor: 1900 })]),
        billing: vi.fn().mockResolvedValue(billingState),
        entitlements: vi.fn().mockResolvedValue(entitlement),
        buyCredits,
      },
    });
    renderWithClient(<BillingPage />, client);

    // 未定价（priceMinor=0，种子口径）→ 展示「未定价」且不可购买（不虚构价格）
    expect(await screen.findByText('未定价')).toBeTruthy();
    const starterBuy = screen.getByTestId('credit-pack-starter').querySelector('button');
    expect(starterBuy).toBeTruthy();
    expect((starterBuy as HTMLButtonElement).disabled).toBe(true);

    // 定价包：购买 → SDK 调用（packCode）→ 渠道结账链接（本页不自动跳转、不做任何入账）
    await userEvent.click(screen.getByTestId('credit-pack-creator_2000').querySelector('button') as HTMLButtonElement);
    await waitFor(() => expect(buyCredits).toHaveBeenCalledWith('ws_1', { packCode: 'creator_2000' }));
    const link = await screen.findByTestId('credits-checkout-link');
    expect(link.getAttribute('href')).toContain('pack=creator_2000');
    expect(screen.getByTestId('credits-notice').textContent).toMatch(/入账只经事件/);
  });

  it('对账按钮：展示事件↔账本计数与一致性结论', async () => {
    const reconcileCredits = vi.fn().mockResolvedValue({ workspaceId: 'ws_1', balanceCredits: 500, purchaseEvents: 1, purchaseEntries: 1, refundEntries: 0, consistent: true });
    const client = mockClient({
      workspaces: {
        creditStatement: vi.fn().mockResolvedValue(statement({ entries: [ledger()] })),
        creditPacks: vi.fn().mockResolvedValue([]),
        billing: vi.fn().mockResolvedValue(billingState),
        entitlements: vi.fn().mockResolvedValue(entitlement),
        reconcileCredits,
      },
    });
    renderWithClient(<BillingPage />, client);

    await userEvent.click(await screen.findByRole('button', { name: '对账（事件 ↔ 账本）' }));
    await waitFor(() => expect(reconcileCredits).toHaveBeenCalledWith('ws_1'));
    expect((await screen.findByTestId('credits-reconcile')).textContent).toMatch(/收款事件 1 · 账本入账条目 1 · 退款条目 0 · 余额 500 —— 一致/);
  });
});
