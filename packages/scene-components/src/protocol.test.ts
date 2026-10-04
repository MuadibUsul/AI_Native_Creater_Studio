import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { COMPONENT_VALIDATION_REASONS, componentCatalogEntrySchema } from '@ancs/contracts';
import { defineComponent, durationStatus, resolveSceneProps, toCatalogEntry, validateComponentDefinition } from './protocol.js';

/**
 * P05-01 单元验收（规范 §11.1）：
 * - 每个组件可**独立校验**（协议自检矩阵：坏组件必须被明确拒绝并给原因）；
 * - props Schema 解析与默认值；fixture 可直接用于渲染与验收；
 * - 目录条目可序列化（编辑器/API 消费）。
 */

const propsSchema = z.object({ value: z.string().nullable().default(null), label: z.string().max(20).default('') });

const goodDefinition = defineComponent({
  type: 'TEST_SCENE',
  version: '1.2.3',
  title: '测试组件',
  description: '协议测试用组件',
  inputSchema: propsSchema,
  defaults: { value: null, label: '' },
  supportedAspectRatios: ['16:9', '9:16'],
  minDurationMs: 1000,
  maxDurationMs: 10_000,
  previewFixture: { props: { value: '42' }, durationMs: 3000, aspectRatio: '16:9', note: null },
  renderer: () => null as never,
});

describe('validateComponentDefinition（协议自检）', () => {
  it('合法组件通过', () => {
    const result = validateComponentDefinition(goodDefinition);
    expect(result).toEqual({ ok: true, reasons: [], messages: [] });
  });

  it('版本非法 / 时长边界错误 / 空画幅 → 拒绝并给原因', () => {
    expect(validateComponentDefinition({ ...goodDefinition, version: 'v1' }).reasons).toContain(
      COMPONENT_VALIDATION_REASONS.VERSION_INVALID,
    );
    expect(validateComponentDefinition({ ...goodDefinition, minDurationMs: 0 }).reasons).toContain(
      COMPONENT_VALIDATION_REASONS.MIN_DURATION_INVALID,
    );
    expect(validateComponentDefinition({ ...goodDefinition, maxDurationMs: 500 }).reasons).toContain(
      COMPONENT_VALIDATION_REASONS.MAX_DURATION_BELOW_MIN,
    );
    expect(validateComponentDefinition({ ...goodDefinition, supportedAspectRatios: [] }).reasons).toContain(
      COMPONENT_VALIDATION_REASONS.ASPECT_RATIOS_EMPTY,
    );
  });

  it('defaults 与 fixture.props 必须通过 inputSchema；fixture 时长/画幅必须在组件边界内', () => {
    expect(validateComponentDefinition({ ...goodDefinition, defaults: { label: 'x'.repeat(30) } as unknown as typeof goodDefinition.defaults }).reasons).toContain(
      COMPONENT_VALIDATION_REASONS.DEFAULTS_INVALID,
    );
    expect(
      validateComponentDefinition({ ...goodDefinition, previewFixture: { ...goodDefinition.previewFixture, props: { label: 42 } } }).reasons,
    ).toContain(COMPONENT_VALIDATION_REASONS.FIXTURE_PROPS_INVALID);
    expect(
      validateComponentDefinition({ ...goodDefinition, previewFixture: { ...goodDefinition.previewFixture, durationMs: 10_001 } }).reasons,
    ).toContain(COMPONENT_VALIDATION_REASONS.FIXTURE_DURATION_OUT_OF_RANGE);
    expect(
      validateComponentDefinition({ ...goodDefinition, previewFixture: { ...goodDefinition.previewFixture, aspectRatio: '1:1' } }).reasons,
    ).toContain(COMPONENT_VALIDATION_REASONS.FIXTURE_ASPECT_RATIO_UNSUPPORTED);
  });

  it('renderer 缺失 → 拒绝', () => {
    const broken = { ...goodDefinition, renderer: undefined } as unknown as typeof goodDefinition;
    expect(validateComponentDefinition(broken).reasons).toContain(COMPONENT_VALIDATION_REASONS.RENDERER_MISSING);
  });
});

describe('resolveSceneProps / durationStatus / toCatalogEntry', () => {
  it('props 解析填充默认值；非法输入给明确原因（不静默）', () => {
    expect(resolveSceneProps(goodDefinition, { value: '5.25%' })).toEqual({ ok: true, props: { value: '5.25%', label: '' } });
    expect(resolveSceneProps(goodDefinition, undefined)).toEqual({ ok: true, props: { value: null, label: '' } });
    const invalid = resolveSceneProps(goodDefinition, { value: 123 });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.messages[0]).toContain('value');
  });

  it('时长匹配状态（编辑器提示；渲染不擅自改时长）', () => {
    expect(durationStatus(goodDefinition, 500)).toBe('TOO_SHORT');
    expect(durationStatus(goodDefinition, 5000)).toBe('OK');
    expect(durationStatus(goodDefinition, 50_000)).toBe('TOO_LONG');
    expect(durationStatus({ ...goodDefinition, maxDurationMs: null }, 500_000)).toBe('OK');
  });

  it('目录条目可序列化且通过契约校验（编辑器/API 消费）', () => {
    const entry = toCatalogEntry(goodDefinition);
    expect(componentCatalogEntrySchema.safeParse(entry).success).toBe(true);
    expect(entry).toMatchObject({ type: 'TEST_SCENE', version: '1.2.3', minDurationMs: 1000, maxDurationMs: 10_000 });
    expect(entry.defaultProps).toEqual({ value: null, label: '' });
    expect(entry.fixture.durationMs).toBe(3000);
  });
});
