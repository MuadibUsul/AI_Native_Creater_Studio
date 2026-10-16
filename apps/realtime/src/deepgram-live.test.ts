import { afterEach, describe, expect, it } from 'vitest';
import type { StreamingAsrResult } from '@ancs/contracts';
import { createDeepgramLiveRecognizer } from './deepgram-live.js';
import { deepgramResult, deepgramUtteranceEnd, startFakeDeepgramLive } from './fake-deepgram-live.js';

/**
 * Deepgram 流式适配器 × 本地假服务（按同一协议应答；不是真实 Provider 验证）：
 * 查询参数与鉴权头、interim / is_final / speech_final 与 UtteranceEnd 的映射、逐词时间、
 * 空闲 KeepAlive、收尾 CloseStream、握手失败按状态区分是否可重试、密钥不进错误信息。
 */

const KEY = 'dg-test-key-0123456789'; // secrets:check-ignore：测试专用假密钥（非真实凭据）
const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });

const silence = (seconds: number) => new Uint8Array(Math.round(seconds * 16_000) * 2);

describe('Deepgram 流式适配器', () => {
  it('中文：参数、鉴权、边说边出的结果与一句话结束；收尾发 CloseStream', async () => {
    const fake = await startFakeDeepgramLive({
      apiKey: KEY,
      script: () => [
        { atSeconds: 0.4, message: deepgramResult({ words: [['把', 0.1, 0.2], ['这里', 0.25, 0.4]], isFinal: false }) },
        { atSeconds: 0.9, message: deepgramResult({ words: [['把', 0.1, 0.2], ['这里', 0.25, 0.4], ['剪短', 0.5, 0.7], ['一点。', 0.7, 0.85]], isFinal: true, speechFinal: true }) },
        { atSeconds: 1.4, message: deepgramUtteranceEnd(0.85) },
      ],
    });
    closers.push(fake.close);
    const recognizer = createDeepgramLiveRecognizer({ apiKey: KEY, baseUrl: fake.url });
    const results: StreamingAsrResult[] = [];
    const ends: (number | null)[] = [];
    let closed = false;
    const session = await recognizer.open({ locale: 'zh-CN', sampleRate: 16_000 }, {
      onResult: (result) => results.push(result), onUtteranceEnd: (end) => ends.push(end), onError: () => undefined, onClose: () => { closed = true; },
    });
    expect(Object.fromEntries(fake.connections[0]!.query)).toMatchObject({
      model: 'nova-2', language: 'zh-CN', encoding: 'linear16', sample_rate: '16000', channels: '1', interim_results: 'true', endpointing: '400', utterance_end_ms: '1000', vad_events: 'true',
    });
    session.sendAudio(silence(0.5));
    session.sendAudio(silence(0.5));
    await expect.poll(() => results.length).toBe(2);
    expect(results[0]).toMatchObject({ isFinal: false, speechFinal: false, text: '把 这里' });
    expect(results[1]).toMatchObject({ isFinal: true, speechFinal: true, start: 0.1, words: [{ text: '把', start: 0.1, end: 0.2 }, { text: '这里', start: 0.25, end: 0.4 }, { text: '剪短', start: 0.5, end: 0.7 }, { text: '一点。', start: 0.7, end: 0.85 }] });
    session.finish();
    await expect.poll(() => closed).toBe(true);
    expect(ends).toEqual([0.85]);
    expect(fake.connections[0]).toMatchObject({ closeStream: true, audioBytes: 32_000 });
    expect(recognizer).toMatchObject({ providerId: 'deepgram', implementation: 'REAL' });
  });

  it('英文用 nova-3；空闲时发 KeepAlive', async () => {
    const fake = await startFakeDeepgramLive({ apiKey: KEY, script: () => [] });
    closers.push(fake.close);
    const session = await createDeepgramLiveRecognizer({ apiKey: KEY, baseUrl: fake.url, keepAliveMs: 40 })
      .open({ locale: 'en', sampleRate: 16_000 }, { onResult: () => undefined, onUtteranceEnd: () => undefined, onError: () => undefined, onClose: () => undefined });
    expect(fake.connections[0]!.query.get('model')).toBe('nova-3');
    expect(fake.connections[0]!.query.get('language')).toBe('en');
    await expect.poll(() => fake.connections[0]!.keepAlives, { timeout: 2000 }).toBeGreaterThan(0);
    session.close();
  });

  it('握手失败：密钥错误不可重试，限流可重试；错误信息不含密钥', async () => {
    const fake = await startFakeDeepgramLive({ apiKey: 'another-key-0123456789', script: () => [] }); // secrets:check-ignore：测试专用假密钥（非真实凭据）
    closers.push(fake.close);
    const events = { onResult: () => undefined, onUtteranceEnd: () => undefined, onError: () => undefined, onClose: () => undefined };
    const denied = await createDeepgramLiveRecognizer({ apiKey: KEY, baseUrl: fake.url }).open({ locale: 'zh-CN', sampleRate: 16_000 }, events).catch((error: unknown) => error);
    expect(denied).toMatchObject({ code: 'ASR_AUTH_FAILED', retryable: false });
    expect(JSON.stringify({ message: (denied as Error).message, ...(denied as object) })).not.toContain(KEY);

    const limited = await startFakeDeepgramLive({ apiKey: KEY, script: () => [], rejectWith: 429 });
    closers.push(limited.close);
    const throttled = await createDeepgramLiveRecognizer({ apiKey: KEY, baseUrl: limited.url }).open({ locale: 'en', sampleRate: 16_000 }, events).catch((error: unknown) => error);
    expect(throttled).toMatchObject({ code: 'ASR_RATE_LIMITED', retryable: true });
  });
});
