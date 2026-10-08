import { describe, expect, it } from 'vitest';
import { createDefaultRegistry, JobHandlerRegistry, noopHandler } from './handlers.js';

/**
 * Worker 处理器注册表（P03-01）：默认注册的处理器集合、重复注册拒绝、NOOP 无副作用。
 * （执行闭环 / 未知类型 → FAILED_FINAL 由 apps/api/src/jobs.integration.test.ts 的真实 DB 测试覆盖。）
 */

describe('JobHandlerRegistry', () => {
  it('默认注册基础处理器集合（含 CMS 回写与显式失败的 ASR）', () => {
    const registry = createDefaultRegistry();
    expect(registry.types().sort()).toEqual(['CMS_WRITEBACK', 'MAINTENANCE_NOTIFICATION_DISPATCH', 'MAINTENANCE_RETENTION_SWEEP', 'MEDIA_TRANSCRIPT', 'NOOP']);
    expect(registry.get('NOOP')).toBeDefined();
    expect(registry.get('NOT_REGISTERED')).toBeUndefined();
  });

  it('提供渲染执行器时注册 RENDER_FINAL（P07-04）；不提供则保持默认集合（任务明确落 UNKNOWN_JOB_TYPE）', () => {
    const executor = { kind: 'test', execute: async () => ({}) as never };
    const withRender = createDefaultRegistry({ renderExecutor: executor });
    expect(withRender.types()).toContain('RENDER_FINAL');
    expect(createDefaultRegistry().types()).not.toContain('RENDER_FINAL');
  });

  it('重复注册同一类型 → 拒绝（防止覆盖语义）', () => {
    const registry = new JobHandlerRegistry([noopHandler]);
    expect(() => registry.register(noopHandler)).toThrow(/重复注册/);
  });

  it('NOOP 处理器无副作用并回显输入', async () => {
    const result = await noopHandler.handle({ db: null as never } as never, { echo: 'hello' }, { jobId: 'job_1', workspaceId: 'ws_1', heartbeat: async () => undefined });
    expect(result).toEqual({ ok: true, echo: 'hello' });
  });
});
