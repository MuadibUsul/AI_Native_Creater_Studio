import { describe, expect, it } from 'vitest';
import {
  creditsSchema,
  durationMsSchema,
  errorEnvelopeSchema,
  EVENT_TYPES,
  eventEnvelopeSchema,
  isoDateOrDateTimeSchema,
  isoDateTimeSchema,
  moneySchema,
  pageRequestSchema,
  pageResponseSchema,
  revisionSchema,
  versionConflictDetailsSchema,
  videoMsSchema,
} from '../index.js';

describe('时间契约', () => {
  it('isoDateTime 接受 UTC 时间戳，拒绝日粒度与非法字符串', () => {
    expect(isoDateTimeSchema.safeParse('2026-10-04T00:00:00.000Z').success).toBe(true);
    expect(isoDateTimeSchema.safeParse('2024-07-15').success).toBe(false);
    expect(isoDateTimeSchema.safeParse('not-a-date').success).toBe(false);
  });

  it('isoDateOrDateTime 接受日期或完整时间戳', () => {
    expect(isoDateOrDateTimeSchema.safeParse('2024-07-15').success).toBe(true);
    expect(isoDateOrDateTimeSchema.safeParse('2024-07-15T00:00:00.000Z').success).toBe(true);
    expect(isoDateOrDateTimeSchema.safeParse('2024/07/15').success).toBe(false);
  });

  it('videoMs 为非负整数（拒绝负数与小数）；durationMs 必须为正', () => {
    expect(videoMsSchema.safeParse(0).success).toBe(true);
    expect(videoMsSchema.safeParse(91200).success).toBe(true);
    expect(videoMsSchema.safeParse(-1).success).toBe(false);
    expect(videoMsSchema.safeParse(1.5).success).toBe(false);
    expect(durationMsSchema.safeParse(0).success).toBe(false);
    expect(durationMsSchema.safeParse(8400).success).toBe(true);
  });
});

describe('revision 契约', () => {
  it('为正整数（初始 1，拒绝 0/负数/小数）', () => {
    expect(revisionSchema.safeParse(1).success).toBe(true);
    expect(revisionSchema.safeParse(42).success).toBe(true);
    expect(revisionSchema.safeParse(0).success).toBe(false);
    expect(revisionSchema.safeParse(-1).success).toBe(false);
    expect(revisionSchema.safeParse(1.5).success).toBe(false);
  });
});

describe('金额与 Credits 契约', () => {
  it('金额为定点十进制字符串 + ISO 4217 币种（拒绝浮点数值）', () => {
    expect(moneySchema.safeParse({ amount: '2.50', currency: 'USD' }).success).toBe(true);
    expect(moneySchema.safeParse({ amount: '-12.345', currency: 'CNY' }).success).toBe(true);
    expect(moneySchema.safeParse({ amount: 2.5, currency: 'USD' }).success).toBe(false);
    expect(moneySchema.safeParse({ amount: '2.5.1', currency: 'USD' }).success).toBe(false);
    expect(moneySchema.safeParse({ amount: '2.50', currency: 'USDT' }).success).toBe(false);
  });

  it('Credits 为整数', () => {
    expect(creditsSchema.safeParse(120).success).toBe(true);
    expect(creditsSchema.safeParse(-30).success).toBe(true);
    expect(creditsSchema.safeParse(1.2).success).toBe(false);
  });
});

describe('分页契约', () => {
  it('limit 默认 50，范围 1..100', () => {
    expect(pageRequestSchema.parse({})).toEqual({ limit: 50 });
    expect(pageRequestSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(pageRequestSchema.safeParse({ limit: 101 }).success).toBe(false);
  });

  it('响应工厂生成 items + nextCursor', () => {
    const schema = pageResponseSchema(revisionSchema);
    expect(schema.parse({ items: [1, 2], nextCursor: null })).toEqual({ items: [1, 2], nextCursor: null });
    expect(schema.safeParse({ items: [0], nextCursor: 'c' }).success).toBe(false);
  });
});

describe('错误信封契约', () => {
  it('接受规范 §33 形状并保留 details', () => {
    const envelope = {
      error: { code: 'VALIDATION_FAILED', message: 'Request validation failed', requestId: 'req_1', details: {} },
    };
    expect(errorEnvelopeSchema.parse(envelope)).toEqual(envelope);
  });

  it('VERSION_CONFLICT 的 details 结构可解析（§4.6 刷新信息）', () => {
    const details = { currentProjectRevision: 12, sceneRevisions: { scn_002: 5 } };
    expect(versionConflictDetailsSchema.parse(details)).toEqual(details);
    expect(versionConflictDetailsSchema.safeParse({ sceneRevisions: {} }).success).toBe(false);
  });

  it('拒绝缺少 requestId 的信封', () => {
    expect(
      errorEnvelopeSchema.safeParse({ error: { code: 'X', message: 'm', details: {} } }).success,
    ).toBe(false);
  });
});

describe('事件契约', () => {
  it('事件信封可解析（含 null revision 与 payload）', () => {
    const event = {
      eventId: 'evt_1',
      eventType: 'scene.updated',
      workspaceId: 'ws_1',
      resourceId: 'scn_002',
      resourceRevision: 5,
      occurredAt: '2026-10-04T00:00:00.000Z',
      payload: { fields: ['durationMs'] },
    };
    expect(eventEnvelopeSchema.parse(event)).toEqual(event);
    expect(eventEnvelopeSchema.safeParse({ ...event, resourceRevision: null }).success).toBe(true);
  });

  it('V1 已知事件类型覆盖 §29.6 列表', () => {
    expect(EVENT_TYPES).toHaveLength(8);
    expect(EVENT_TYPES).toContain('render.progress');
    expect(EVENT_TYPES).toContain('asset.ready');
  });
});
