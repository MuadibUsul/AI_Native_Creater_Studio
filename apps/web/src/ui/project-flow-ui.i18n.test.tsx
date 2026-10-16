import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { mediaTimeSchema, timelineViewportSchema, type EditPlan } from '@ancs/contracts';
import { I18nProvider } from '@/i18n/I18nProvider';
import { AiEditPanel } from './AiEditPanel';
import { LiteTimeline } from './LiteTimeline';
import { PropForm } from './PropForm';
import { ScenePreview } from './ScenePreview';
import { StateBlock, type StateBlockVariant } from './StateBlock';
import { TimelineBand } from './TimelineBand';

/** 作品流程共享组件的英文界面：文案随界面语言切换，界面文字不残留中文（服务端数据除外，此处全部用英文/ASCII 夹具）。 */

const renderEn = (ui: ReactElement) => render(<I18nProvider initialLocale="en">{ui}</I18nProvider>);
const noChinese = (text: string | null | undefined) => expect(text ?? '').not.toMatch(/[一-鿿]/);

const mt = (seconds: number) => mediaTimeSchema.parse({ ticks: String(Math.round(seconds * 1000)), timebase: { num: 1, den: 1000 } });
const viewport = timelineViewportSchema.parse({ start: mt(0), end: mt(10), widthPx: 1000 });

const scene = (overrides: Record<string, unknown> = {}) => ({
  id: 'scn_1', revision: 1, position: 0, startMs: 0, durationMs: 4000,
  semanticType: 'PRICE_SERIES', sceneType: 'LINE_CHART', narrationBlockIds: [], narration: '', visualIntent: '',
  componentId: null, componentVersion: null, props: { title: '', unit: '', series: [], sourceLabel: null },
  providerRequirement: null, sourceBindings: [], dataBindings: [], assetBindings: [],
  transition: { in: null, out: null }, locked: false, approved: false, needsReview: false, status: 'DRAFT',
  ...overrides,
});
const mediaScene = scene({
  id: 'scn_media', position: 1, startMs: 4000, sceneType: 'IMAGE_FULL', semanticType: 'IMAGE_EVIDENCE', locked: true,
  props: { assetId: 'ast_1', assetUrl: null, caption: null, sourceLabel: null, scale: 1, offsetX: 0, offsetY: 0, headline: null },
  assetBindings: [{ assetId: 'ast_1', role: 'visual' }],
});

const plan = (overrides: Partial<EditPlan> = {}): EditPlan => ({
  schemaVersion: '0.1', planVersion: 'edit-plan-v1', planId: 'edp_test_1', projectId: 'prj_1', baseProjectRevision: 7,
  prompt: 'Extend the opening by 800ms', rationale: ['Follow the request'],
  operations: [{ operation: { op: 'update_scene', sceneId: 'scn_1', changes: { durationMs: 3300 } }, summary: 'Update scn_1: durationMs', sceneId: 'scn_1', before: { durationMs: 2500 }, after: { durationMs: 3300 } }],
  impact: { scenesAdded: 0, scenesRemoved: 0, scenesModified: 1, durationDeltaMs: 800, costImpact: 'NONE', notes: [] },
  warnings: ['Skipped locked shot scn_locked'],
  generation: { method: 'LLM', providerId: 'mock.llm', modelVersion: null, promptVersion: 'ai-edit-v1', attempts: 1 },
  ...overrides,
}) as EditPlan;

describe('Project flow shared components (English UI)', () => {
  it('StateBlock badges follow the interface language', () => {
    const expected: Record<StateBlockVariant, string> = {
      loading: 'Loading', empty: 'Empty', error: 'Failed', forbidden: 'No access',
      unauthenticated: 'Signed out', conflict: 'Conflict', unavailable: 'Unavailable', info: 'Note',
    };
    for (const [variant, label] of Object.entries(expected) as [StateBlockVariant, string][]) {
      const { container, unmount } = renderEn(<StateBlock variant={variant} title={`State ${variant}`} />);
      expect(container.querySelector('.badge')?.textContent).toBe(label);
      noChinese(container.textContent);
      unmount();
    }
    // 默认（无 Provider）仍为中文角标，与改造前一致
    const { container } = render(<StateBlock variant="error" title="失败" />);
    expect(container.querySelector('.badge')?.textContent).toBe('失败');
  });

  it('AiEditPanel renders the empty form, plan and errors in English', async () => {
    const { container, unmount } = renderEn(
      <AiEditPanel plan={null} planPending={false} planError={{ kind: 'validation', message: 'Unknown shot', code: 'VALIDATION_FAILED' }} onPlan={vi.fn()} onApply={vi.fn()} onReject={vi.fn()} applyPending={false} applyError={null} />,
    );
    expect(screen.getByText('Describe what you want to change; generating a plan does not change your project.')).toBeTruthy();
    expect(screen.getByLabelText('AI Edit request').getAttribute('placeholder')).toBe('e.g. Shorten the narration, keep the point and the sources');
    expect(screen.getByRole('button', { name: 'Generate plan' })).toBeTruthy();
    expect(screen.getByTestId('ai-edit-plan-error').textContent).toBe('Unknown shot (VALIDATION_FAILED)');
    noChinese(container.textContent);
    unmount();

    const view = renderEn(
      <AiEditPanel plan={plan()} planPending={false} planError={null} onPlan={vi.fn()} onApply={vi.fn()} onReject={vi.fn()} applyPending={false} applyError={{ kind: 'validation', message: 'bad', code: 'VALIDATION_FAILED' }} />,
    );
    expect(screen.getByText('Plan edp_test_1… · Project revision 7 · mock.llm')).toBeTruthy();
    expect(screen.getByText('Reason: Follow the request')).toBeTruthy();
    expect(screen.getByTestId('ai-edit-impact').textContent).toBe('ImpactAdded 0 · Removed 0 · Changed 1 · Duration +800ms');
    expect(screen.getByText('Locked content').parentElement?.textContent).toContain('See the notes above');
    expect(screen.getByText('Cost impact').parentElement?.textContent).toContain('None (no Provider calls while planning)');
    expect(screen.getByRole('button', { name: 'Apply (1 change)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reject plan' })).toBeTruthy();
    expect(screen.getByTestId('ai-edit-apply-error').textContent).toContain('Apply rejected: the plan contains invalid operations');
    await userEvent.click(screen.getByRole('button', { name: 'Change the request and regenerate the plan' }));
    expect(screen.getByRole('button', { name: 'Generate plan' })).toBeTruthy();
    noChinese(view.container.textContent);
  });

  it('LiteTimeline and its TimelineBand render controls, empty states and errors in English', () => {
    const graph = { projectRevision: 7, scenes: [scene(), mediaScene], captions: [], audioTracks: [] };
    const { container } = renderEn(
      <LiteTimeline
        graph={graph as never}
        onEdit={vi.fn()}
        error={{ kind: 'conflict', message: 'Shot was updated', code: 'VERSION_CONFLICT' }}
        band={{ viewport, playhead: null, selection: null }}
      />,
    );
    expect(screen.getByText(/^2 shots · Every change goes through the edit protocol/)).toBeTruthy();
    expect(screen.getByTestId('timeline-error').textContent).toBe('Edit conflict (the server state changed): refresh and try again.Shot was updated (VERSION_CONFLICT)');
    expect(screen.getByRole('button', { name: 'Move shot 2 down' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Move shot 1 up' })).toBeTruthy();
    expect(screen.getByLabelText('Split point 0')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Duplicate' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeTruthy();
    expect(screen.getByText('Locked')).toBeTruthy();
    expect(screen.getByLabelText('Transition 1').getAttribute('placeholder')).toBe('in/out, e.g. fade');
    expect(screen.getByLabelText('Scale 1')).toBeTruthy();
    expect(screen.getByLabelText('Horizontal offset 1')).toBeTruthy();
    expect(screen.getByLabelText('Replace asset 1').textContent).toBe('No assets available');
    expect(screen.getByText(/^No audio tracks yet/)).toBeTruthy();
    expect(screen.getByText(/^No captions yet/)).toBeTruthy();
    expect(screen.getByTestId('timeline-lane-video').textContent).toContain('Video');
    expect(screen.getByTestId('timeline-selection-label').textContent).toBe('No time range selected (drag the selection band, or Shift+drag to add)');
    noChinese(container.textContent);
  });

  it('TimelineBand frame stepping, selection and playhead labels render in English', () => {
    const { container } = renderEn(
      <TimelineBand
        viewport={viewport}
        playhead={mt(3)}
        selection={{ kind: 'RANGES', ranges: [{ start: mt(2), end: mt(4) }] }}
        frameRate={{ num: 30, den: 1 }}
      />,
    );
    expect(screen.getByText('Timeline band')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Previous frame' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next frame' })).toBeTruthy();
    expect(screen.getByTestId('timeline-selection-label').textContent).toBe('Time selection: 00:02.000–00:04.000');
    expect(screen.getByText('Playhead: 00:03.000')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Clear time selection' })).toBeTruthy();
    expect(screen.getByTestId('timeline-lanes-empty').textContent).toBe('No clip or track data yet.');
    noChinese(container.textContent);
  });

  it('PropForm labels, feedback and ScenePreview notices render in English', async () => {
    const onSubmit = vi.fn();
    const { container, unmount } = renderEn(
      <PropForm sceneType="LINE_CHART" componentVersion={null} initialProps={{ title: 'Rates', unit: '%', series: [], sourceLabel: null }} onSubmit={onSubmit} />,
    );
    expect(screen.getByText('Title')).toBeTruthy();
    expect(screen.getByText('Data series')).toBeTruthy();
    expect(screen.getByText('Structured data')).toBeTruthy();
    expect(screen.getByLabelText('Title (title)')).toBeTruthy();
    const series = screen.getByLabelText('Data series (series)');
    await userEvent.clear(series);
    await userEvent.type(series, '{{{{not json');
    await userEvent.click(screen.getByRole('button', { name: 'Save properties' }));
    expect(screen.getByTestId('propform-feedback').textContent).toBe('Field “series” is not valid JSON');
    expect(onSubmit).not.toHaveBeenCalled();
    noChinese(container.textContent);
    unmount();

    renderEn(<PropForm sceneType="NOT_A_COMPONENT" componentVersion={null} initialProps={{}} onSubmit={vi.fn()} />);
    expect(screen.getByTestId('propform-unregistered').textContent).toBe('Component not registered (NOT_A_COMPONENT); its properties cannot be edited.');

    renderEn(<ScenePreview sceneType="NOT_A_COMPONENT" componentVersion={null} props={{}} durationMs={3000} />);
    expect(screen.getByText('Component not registered: NOT_A_COMPONENT')).toBeTruthy();
    renderEn(<ScenePreview sceneType="BIG_NUMBER" componentVersion="1.0.0" props={{ value: 12345 }} durationMs={3000} />);
    expect(screen.getByText('Props failed BIG_NUMBER validation (fix them in the editor first)')).toBeTruthy();
    noChinese(document.body.textContent);
  });
});
