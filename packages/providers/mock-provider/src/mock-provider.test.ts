import { describe, expect, it } from 'vitest';
import { ProviderRateLimitedError, ProviderSubmissionUnknownError } from '@ancs/contracts';
import { MockGenerationProvider } from './index.js';

/** 完整提交请求（契约要求 workspaceId/providerId/modelId/operation/parameters） */
const req = (jobId: string, inputHash: string) => ({
  workspaceId: 'ws_test',
  jobId,
  providerId: 'mock.provider',
  modelId: 'mock-model-1',
  operation: 'video.generate',
  inputHash,
  parameters: {},
});

/**
 * Mock Provider 脚本行为（P03-07）：让 CI 确定性重现各类故障。
 * （端到端故障编排见 apps/worker/src/mock-provider.integration.test.ts）
 */

describe('MockGenerationProvider 脚本行为', () => {
  it('success：先 QUEUED/RUNNING，pollsBeforeTerminal 次轮询后 SUCCEEDED 并给出结果描述', async () => {
    const provider = new MockGenerationProvider({ pollsBeforeTerminal: 2 });
    const { providerJobId } = await provider.submit({ secret: 'sk-mock', request: req('job_1', 'sha256:a') });

    const first = await provider.getStatus({ providerJobId });
    expect(first.state).toBe('RUNNING');
    const second = await provider.getStatus({ providerJobId });
    expect(second.state).toBe('SUCCEEDED');
    expect(second.results?.[0]).toMatchObject({ contentType: 'image/png', sizeBytes: 33 });
    expect(second.results?.[0]?.url).toContain(providerJobId);
    expect(second.results?.[0]?.expiresAt).not.toBeNull();
  });

  it('rate_limited：提交抛 ProviderRateLimitedError（上层进入退避重试，而非终结失败）', async () => {
    const provider = new MockGenerationProvider();
    provider.scriptNext('rate_limited');
    const failure = await provider
      .submit({ secret: 'sk-mock', request: req('job_rl', 'sha256:b') })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderRateLimitedError);
    expect((failure as ProviderRateLimitedError).retryAfterSeconds).toBe(1);
    expect(provider.submissions).toHaveLength(0); // 未产生 Provider 任务
  });

  it('submission_unknown：提交抛未知错误（上层标记对账，不得自动重复付费提交）', async () => {
    const provider = new MockGenerationProvider();
    provider.scriptNext('submission_unknown');
    const failure = await provider
      .submit({ secret: 'sk-mock', request: req('job_unk', 'sha256:c') })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderSubmissionUnknownError);
  });

  it('slow：更多轮询后才完成（无真实定时器，CI 确定性）', async () => {
    const provider = new MockGenerationProvider({ pollsBeforeTerminal: 2 });
    provider.scriptNext('slow');
    const { providerJobId } = await provider.submit({ secret: 'sk-mock', request: req('job_slow', 'sha256:d') });
    // pollsBeforeTerminal=2 → slow 需要 3 倍（6 次）轮询才完成：前 5 次 RUNNING，第 6 次 SUCCEEDED
    for (let i = 0; i < 5; i += 1) {
      expect((await provider.getStatus({ providerJobId })).state).toBe('RUNNING');
    }
    expect((await provider.getStatus({ providerJobId })).state).toBe('SUCCEEDED');
  });

  it('result_missing：任务侧完成但结果永不可得（UNKNOWN → 对账路径）', async () => {
    const provider = new MockGenerationProvider({ pollsBeforeTerminal: 1 });
    provider.scriptNext('result_missing');
    const { providerJobId } = await provider.submit({ secret: 'sk-mock', request: req('job_rm', 'sha256:e') });
    expect((await provider.getStatus({ providerJobId })).state).toBe('UNKNOWN');
  });

  it('cancel / cancel_fails：取消失败可重现（任务须保持 CANCEL_REQUESTED 供人工介入）', async () => {
    const provider = new MockGenerationProvider();
    const ok = await provider.submit({ secret: 'sk-mock', request: req('job_c1', 'sha256:f') });
    expect(await provider.cancel({ providerJobId: ok.providerJobId })).toEqual({ ok: true });
    expect((await provider.getStatus({ providerJobId: ok.providerJobId })).state).toBe('CANCELLED');

    provider.scriptNext('cancel_fails');
    const failing = await provider.submit({ secret: 'sk-mock', request: req('job_c2', 'sha256:g') });
    const cancelResult = await provider.cancel({ providerJobId: failing.providerJobId });
    expect(cancelResult).toMatchObject({ ok: false, reason: 'PROVIDER_CANCEL_REJECTED' });
    expect((await provider.getStatus({ providerJobId: failing.providerJobId })).state).not.toBe('CANCELLED');
    expect(provider.cancelAttempts).toEqual([ok.providerJobId, failing.providerJobId]);
  });

  it('duplicate_callback：可生成同 eventId 的回调副本（上层 replay 防护须幂等）', async () => {
    const provider = new MockGenerationProvider();
    const { providerJobId } = await provider.submit({ secret: 'sk-mock', request: req('job_dup', 'sha256:h') });
    await provider.getStatus({ providerJobId });
    await provider.getStatus({ providerJobId });
    const callback = provider.buildCallback(providerJobId);
    const duplicate = provider.duplicateOf(callback);
    expect(duplicate.eventId).toBe(callback.eventId);
    expect(duplicate.providerJobId).toBe(callback.providerJobId);
  });

  it('空凭据 fail-closed（避免把"空凭据也通过"带进真实链路）', async () => {
    const provider = new MockGenerationProvider();
    await expect(provider.submit({ secret: '   ', request: req('job_e', 'sha256:i') })).rejects.toThrow(/缺少凭据/);
  });
});
