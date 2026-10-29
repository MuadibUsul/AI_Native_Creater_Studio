import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AutonomousRun, AutonomyPolicy } from '@ancs/contracts';
import { Providers } from '@/app/providers';
import { apiError, mockClient, renderWithClient } from '@/test-utils';
import { StudioAutonomyCard, StudioAutonomyDialog, budgetMicrosOf } from './StudioAutonomy';

/**
 * V6-9 交给 AI 剪完（组件层，脚本化 SDK）：设置 → 签署授权并开始；进度卡（等素材 / 正在剪 / 停下）；
 * 交付报告如实翻译服务端算好的事实（没采用的原因、没满足的约束、花费）；中英两种界面。
 * 真实浏览器 + 真实服务的端到端证据见 scripts/autonomous-browser-check.mjs。
 */

const unsigned: AutonomyPolicy = { approval: 'ASK_EACH', budgetMicros: null, perGenerationMicros: null, allowOwnLikeness: false, maxRetriesPerTask: 2, signature: null };
const signed: AutonomyPolicy = { ...unsigned, approval: 'AUTO_SAFE', budgetMicros: 3_000_000, signature: { userId: 'usr_1', signedAt: '2026-10-21T00:00:00.000Z', version: 2 } };

const run = (overrides: Partial<AutonomousRun> = {}): AutonomousRun => ({
  id: 'aut_1', projectId: 'prj_1', status: 'DIRECTING', mode: 'SINGLE', chapters: [], goal: '60 秒冰岛自驾，节奏轻快', targetDurationSeconds: 60, strategyPackId: null,
  approval: 'AUTO_SAFE', policyVersion: 2, budgetMicros: 3_000_000, modelCapMicros: 2_700_000, locale: 'zh-CN',
  turnId: 'agt_9', workflowRunId: 'wfr_9', proposalId: null, adoptedRevision: null,
  progress: { steps: 4, lastStep: '找到 12 个剪点候选', lastTool: 'find_edit_points' },
  report: null, error: null, createdAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-21T00:01:00.000Z', completedAt: null,
  ...overrides,
});

const report = (overrides: Partial<NonNullable<AutonomousRun['report']>> = {}): NonNullable<AutonomousRun['report']> => ({
  outcome: 'TRIAL', note: '开头用冰川航拍抓人，结尾留在湖面。', notAdoptedReason: 'REVIEW_GATE',
  timeline: { lengthSeconds: '48.0', clips: 9, captions: 14 },
  sources: { footage: [{ footageId: 'av_g', name: 'glacier.mp4', seconds: '30.5' }], generated: [{ kind: 'EFFECT', name: '光效', seconds: '2.0' }], originalShare: 0.96 },
  review: { warnings: 1, notes: 2, findings: [{ kind: 'PICTURE_GAP', severity: 'warning', at: ['12.000', '12.400'], message: 'No picture for 400 ms.' }, { kind: 'NEW_CHECK', severity: 'info', at: ['1.000', '2.000'], message: 'Raw tool text' }], notChecked: ['cuts inside spoken sentences (no transcript)', 'something new'] },
  pace: { cutsPerMinute: 11.2, wordsPerSecond: 2.5, target: null, deviations: [] },
  plan: { version: 1, logline: '从冰川到湖面的一天', scenes: 4, intents: 7 },
  unmet: [{ code: 'TARGET_DURATION', detail: '60/48.0' }],
  cost: { spentMicros: 420_000, budgetMicros: 3_000_000, unpricedCalls: 0 },
  chapters: [],
  ...overrides,
});

describe('V6-9 交给 AI 剪完', () => {
  it('费用上限：只接受 0.20—1000 美元、最多两位小数', () => {
    expect(budgetMicrosOf('2')).toBe(2_000_000);
    expect(budgetMicrosOf('0.25')).toBe(250_000);
    expect(budgetMicrosOf(' 12.5 ')).toBe(12_500_000);
    expect(budgetMicrosOf('0.1')).toBeNull();
    expect(budgetMicrosOf('1000.01')).toBeNull();
    expect(budgetMicrosOf('1.234')).toBeNull();
    expect(budgetMicrosOf('-1')).toBeNull();
    expect(budgetMicrosOf('')).toBeNull();
  });

  it('对话框：需求必填、上限要合法；签署授权（档位 + 上限）后开始运行（需求、目标时长、语言、风格），两步各带幂等键', async () => {
    const sign = vi.fn().mockResolvedValue(signed);
    const startRun = vi.fn().mockResolvedValue(run({ status: 'WAITING_FOR_FOOTAGE', turnId: null, progress: { steps: 0, lastStep: null, lastTool: null } }));
    const onStarted = vi.fn();
    renderWithClient(
      <StudioAutonomyDialog workspaceId="ws_1" projectId="prj_1" policy={unsigned} initialGoal="" strategy={{ packId: 'builtin:travel-beat', knobs: { pacing: 'default' } }} onClose={vi.fn()} onStarted={onStarted} />,
      mockClient({ autonomy: { sign, startRun, revoke: vi.fn() } }),
    );
    const dialog = screen.getByRole('dialog', { name: '交给 AI 剪完' });
    expect(within(dialog).getByRole('radio', { name: /先给我看/ }).getAttribute('aria-checked')).toBe('true');
    await userEvent.clear(within(dialog).getByLabelText('AI 费用上限（美元）'));
    await userEvent.type(within(dialog).getByLabelText('AI 费用上限（美元）'), '0.1');
    await userEvent.click(within(dialog).getByRole('button', { name: '交给 AI' }));
    expect(within(dialog).getByText('请写一句你想要的效果')).toBeTruthy();
    expect(within(dialog).getByText('请填写 $0.20 到 $1000 之间的金额')).toBeTruthy();
    expect(sign).not.toHaveBeenCalled();

    await userEvent.type(within(dialog).getByLabelText('你想要一条什么样的视频'), '60 秒冰岛自驾，节奏轻快');
    await userEvent.clear(within(dialog).getByLabelText('AI 费用上限（美元）'));
    await userEvent.type(within(dialog).getByLabelText('AI 费用上限（美元）'), '3');
    await userEvent.selectOptions(within(dialog).getByLabelText('目标时长'), '60');
    await userEvent.click(within(dialog).getByRole('radio', { name: /自检通过就直接用/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: '交给 AI' }));
    await waitFor(() => expect(onStarted).toHaveBeenCalled());
    expect(sign).toHaveBeenCalledWith('ws_1', 'prj_1', { approval: 'AUTO_SAFE', budgetMicros: 3_000_000 }, { idempotencyKey: expect.stringMatching(/^autonomy-sign-/) });
    expect(startRun).toHaveBeenCalledWith('ws_1', 'prj_1', {
      goal: '60 秒冰岛自驾，节奏轻快', targetDurationSeconds: 60, strategyPackId: 'builtin:travel-beat', strategyKnobs: { pacing: 'default' }, locale: 'zh-CN',
    }, { idempotencyKey: expect.stringMatching(/^autonomy-run-/) });
  });

  it('对话框：显示当前授权并可撤回；预算用完时说明要提高上限', async () => {
    const revoke = vi.fn().mockResolvedValue(unsigned);
    const startRun = vi.fn().mockRejectedValue(apiError(409, 'PRECONDITION_FAILED', 'budget', { reason: 'AUTONOMY_BUDGET_EXHAUSTED' }));
    renderWithClient(
      <StudioAutonomyDialog workspaceId="ws_1" projectId="prj_1" policy={signed} initialGoal="冰岛" strategy={null} onClose={vi.fn()} onStarted={vi.fn()} />,
      mockClient({ autonomy: { sign: vi.fn().mockResolvedValue(signed), startRun, revoke } }),
    );
    const dialog = screen.getByRole('dialog', { name: '交给 AI 剪完' });
    // 已签署的授权带入为默认值
    expect(within(dialog).getByRole('radio', { name: /自检通过就直接用/ }).getAttribute('aria-checked')).toBe('true');
    expect((within(dialog).getByLabelText('AI 费用上限（美元）') as HTMLInputElement).value).toBe('3.00');
    expect(within(dialog).getByText('当前授权：自检通过就直接用 · 上限 $3.00（第 2 版）')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: '交给 AI' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('这份授权的费用已经用完，请提高上限再开始。');
    await userEvent.click(within(dialog).getByRole('button', { name: '撤回授权' }));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith('ws_1', 'prj_1', { idempotencyKey: expect.stringMatching(/^autonomy-revoke-/) }));
    await waitFor(() => expect(within(dialog).queryByText(/当前授权/)).toBeNull());
  });

  it('进度卡：等素材 → 正在剪（步骤数与最近一步）；可以停下；没有编辑权限时不给停下', async () => {
    const onStop = vi.fn();
    const { rerender } = render(<Providers><StudioAutonomyCard run={run({ status: 'WAITING_FOR_FOOTAGE', turnId: null, progress: { steps: 0, lastStep: null, lastTool: null } })} canEdit stopping={false} error={null} onStop={onStop} /></Providers>);
    const card = screen.getByRole('article', { name: 'AI 自己剪' });
    expect(within(card).getByRole('status').textContent).toBe('等素材准备好');
    expect(within(card).getByText('放入素材，处理好就开始。')).toBeTruthy();
    expect(within(card).getByText('你的要求：60 秒冰岛自驾，节奏轻快')).toBeTruthy();
    await userEvent.click(within(card).getByRole('button', { name: '停下' }));
    expect(onStop).toHaveBeenCalledTimes(1);

    rerender(<Providers><StudioAutonomyCard run={run()} canEdit stopping error={null} onStop={onStop} /></Providers>);
    expect(screen.getByRole('status').textContent).toBe('正在剪');
    expect(screen.getByText('已做 4 步')).toBeTruthy();
    expect(screen.getByText('找到 12 个剪点候选')).toBeTruthy();
    expect((screen.getByRole('button', { name: '正在停下…' }) as HTMLButtonElement).disabled).toBe(true);

    rerender(<Providers><StudioAutonomyCard run={run()} canEdit={false} stopping={false} error={null} onStop={onStop} /></Providers>);
    expect(screen.queryByRole('button', { name: '停下' })).toBeNull();
  });

  it('交付报告：没采用的原因、来源与原片占比、自检、节奏、计划、没满足的约束、花费、AI 的说明', () => {
    render(<Providers><StudioAutonomyCard run={run({ status: 'NEEDS_REVIEW', proposalId: 'prp_9', report: report(), completedAt: '2026-10-21T00:03:00.000Z' })} canEdit stopping={false} error={null} onStop={vi.fn()} /></Providers>);
    const card = screen.getByRole('article', { name: 'AI 自己剪' });
    expect(within(card).getByRole('status').textContent).toBe('剪好了，等你看');
    expect(within(card).queryByRole('button', { name: '停下' })).toBeNull();
    expect(within(card).getByText('保留为试改：在对话里"就这样"采用，或"撤回"。自检发现了要你看一眼的问题，所以没有直接采用。')).toBeTruthy();
    const facts = within(card).getByRole('region', { name: '交付报告' });
    expect(within(facts).getByText('成片 48.0 秒 · 9 个片段 · 14 条字幕 · 画面里 96% 来自你的素材')).toBeTruthy();
    expect(within(facts).getByText('用到的素材：glacier.mp4 （30.5 秒）')).toBeTruthy();
    expect(within(facts).getByText('生成内容：特效 · 光效 （2.0 秒）')).toBeTruthy();
    expect(within(facts).getByText(/自检：1 个警告，2 条提示/)).toBeTruthy();
    // 自检发现按种类翻译；不认识的种类与没做的检查如实显示原文
    expect(within(facts).getByText('! 12.000–12.400 s · 画面有空档')).toBeTruthy();
    expect(within(facts).getByText('1.000–2.000 s · Raw tool text')).toBeTruthy();
    expect(within(facts).getByText('没有检查：句中剪断（没有转写）、something new')).toBeTruthy();
    expect(within(facts).getByText('节奏：每分钟 11.2 刀 · 每秒 2.5 字')).toBeTruthy();
    expect(within(facts).getByText('制作计划第 1 版：从冰川到湖面的一天（4 场）')).toBeTruthy();
    expect(within(facts).getByText('时长：目标 60 秒，实际 48.0 秒')).toBeTruthy();
    expect(within(facts).getByText('花费 $0.42 / 上限 $3.00')).toBeTruthy();
    expect(within(facts).getByText('AI 的说明：开头用冰川航拍抓人，结尾留在湖面。')).toBeTruthy();
  });

  it('失败与停下：按服务端原因说明；英文界面同一结构', () => {
    const { unmount } = render(<Providers><StudioAutonomyCard run={run({ status: 'FAILED', error: { reason: 'AUTONOMOUS_NO_FOOTAGE' }, completedAt: '2026-10-21T00:30:00.000Z' })} canEdit stopping={false} error={null} onStop={vi.fn()} /></Providers>);
    expect(screen.getByRole('alert').textContent).toBe('一直没有放入素材。');
    unmount();
    render(<Providers locale="en"><StudioAutonomyCard run={run({ status: 'DELIVERED', approval: 'AUTO_SAFE', adoptedRevision: 8, report: report({ outcome: 'ADOPTED', notAdoptedReason: null, unmet: [{ code: 'BUDGET_REACHED', detail: '2.7' }], cost: { spentMicros: 2_700_000, budgetMicros: 3_000_000, unpricedCalls: 1 } }), completedAt: '2026-10-21T00:03:00.000Z' })} canEdit stopping={false} error={null} onStop={vi.fn()} /></Providers>);
    const card = screen.getByRole('article', { name: 'AI editing on its own' });
    expect(within(card).getByRole('status').textContent).toBe('Done');
    expect(within(card).getByText('Adopted as the current version. You can undo it.')).toBeTruthy();
    expect(within(card).getByText('Footage used: glacier.mp4 (30.5 s)')).toBeTruthy();
    expect(within(card).getByText('Spending reached the cap, so AI stopped early')).toBeTruthy();
    expect(within(card).getByText('Spent $2.70 of $3.00 · 1 unpriced call')).toBeTruthy();
  });
});
