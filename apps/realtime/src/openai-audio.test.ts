import { describe, expect, it } from 'vitest';
import type { StreamingAsrResult } from '@ancs/contracts';
import { TRANSCRIPTION_PROMPTS, createOpenAiSpeechSynthesizer, createOpenAiTranscriptionRecognizer, estimateWordTimes, pcmToWav, speechTokens } from './openai-audio.js';

/**
 * OpenAI 兼容语音接口（Issue #9）× 本地替身 fetch（不是真实 Provider 验证；真实验证见 docs/V06/milestones/V6-2.md）：
 * - 网关自己断句：开口立即通知；说话中定时出临时转写；静音后整句转写为最终结果；
 * - 没有供应商词时间时按发声帧 + 临时转写的时刻估算（"这里"的时刻落在正确区间）；
 * - 合成边收边回调（奇数字节拼齐）；中止即停；错误分类且不含密钥；网关不自动重试。
 */

const KEY = 'sk-test-openai-compatible-0123456789'; // secrets:check-ignore：测试专用假密钥（非真实凭据）

/** 16 kHz PCM16：静音与"说话"（正弦）交替 */
function speech(parts: [kind: 'silence' | 'voice', seconds: number][]): Uint8Array {
  const total = parts.reduce((sum, [, seconds]) => sum + Math.round(seconds * 16_000), 0);
  const samples = new Int16Array(total);
  let offset = 0;
  for (const [kind, seconds] of parts) {
    const count = Math.round(seconds * 16_000);
    for (let index = 0; index < count; index += 1) samples[offset + index] = kind === 'voice' ? Math.round(Math.sin((index / 16_000) * 2 * Math.PI * 220) * 6000) : 0;
    offset += count;
  }
  return new Uint8Array(samples.buffer);
}

describe('OpenAI 兼容语音接口', () => {
  it('分词与 WAV 头', () => {
    expect(speechTokens('把这里剪短一点，make it shorter!')).toEqual(['把', '这', '里', '剪', '短', '一', '点', 'make', 'it', 'shorter']);
    const wav = pcmToWav(new Int16Array([1, -1, 2]));
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe('RIFF');
    expect(new DataView(wav.buffer).getUint32(24, true)).toBe(16_000);
    expect(wav.length).toBe(44 + 6);
  });

  it('估算词时间：只摊在发声段上；临时转写收紧"已认出 / 还没认出"的词', () => {
    // 发声 1.0–2.0 s（中间 1.4–1.6 停顿不分配）；"把这里剪短"五个字
    const plain = estimateWordTimes({ text: '把这里剪短', voiced: [[1.0, 1.4], [1.6, 2.0]], marks: [] });
    expect(plain.map((word) => word.text)).toEqual(['把', '这', '里', '剪', '短']);
    expect(plain[0]!.start).toBeCloseTo(1.0, 2);
    expect(plain[4]!.end).toBeCloseTo(2.0, 2);
    // 发声共 0.8 s、每字 0.16 s：前段 0.4 s 只容得下 2.5 个字，第三个字跨过停顿（停顿不计时长）结束在 1.68
    expect(plain[2]!.end).toBeCloseTo(1.68, 2);
    expect(plain[3]!.start).toBeCloseTo(1.68, 2);
    // 1.3 s 时的临时转写已认出"把这里"：这三个字结束不晚于 1.3；"剪"开始不早于 1.3 − 滞后
    const tightened = estimateWordTimes({ text: '把这里剪短', voiced: [[1.0, 1.4], [1.6, 2.0]], marks: [{ at: 1.3, text: '把这里' }] });
    expect(tightened[2]!.end).toBeLessThanOrEqual(1.3);
    expect(tightened[3]!.start).toBeGreaterThanOrEqual(1.6);
    expect(estimateWordTimes({ text: '', voiced: [[0, 1]], marks: [] })).toEqual([]);
  });

  it('识别：开口通知 → 临时转写（可修订）→ 静音后最终结果与说完；请求带密钥头与模型、语言；结果按估算给词时间', async () => {
    const requests: { url: string; authorization: string | null; form: Record<string, string>; audioBytes: number }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const form = init?.body as FormData;
      const file = form.get('file') as Blob;
      const fields = Object.fromEntries([...form.entries()].filter(([, value]) => typeof value === 'string')) as Record<string, string>;
      requests.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization'), form: fields, audioBytes: file.size });
      // 越长的音频认出越多字（模拟边说边认）
      const seconds = (file.size - 44) / 32_000;
      const text = seconds < 1.0 ? '把这' : seconds < 1.6 ? '把这里剪' : '把这里剪短一点。';
      return new Response(JSON.stringify({ text }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const recognizer = createOpenAiTranscriptionRecognizer({ apiKey: KEY, baseUrl: 'https://gateway.test/v1/', fetch: fetchImpl, interimMs: 500 });
    expect(recognizer).toMatchObject({ providerId: 'openai', implementation: 'REAL', model: 'gpt-4o-transcribe' });
    const results: StreamingAsrResult[] = [];
    const speechStarts: number[] = [];
    let ended: number | null | undefined;
    let closed = false;
    const session = await recognizer.open({ locale: 'zh-CN', sampleRate: 16_000 }, {
      onResult: (result) => results.push(result),
      onSpeechStart: (at) => speechStarts.push(at),
      onUtteranceEnd: (last) => { ended = last; },
      onError: (error) => { throw new Error(`unexpected ${error.code}`); },
      onClose: () => { closed = true; },
    });
    // 0.5 s 静音 → 2 s 说话 → 1 s 静音；分成奇数字节的小块送入（检验跨块拼接）
    const audio = speech([['silence', 0.5], ['voice', 2.0], ['silence', 1.0]]);
    for (let offset = 0; offset < audio.length; offset += 3001) {
      session.sendAudio(audio.subarray(offset, Math.min(audio.length, offset + 3001)));
      await new Promise((done) => setTimeout(done, 0));
    }
    await expect.poll(() => ended !== undefined, { timeout: 3000 }).toBe(true);
    expect(speechStarts).toHaveLength(1);
    expect(speechStarts[0]!).toBeGreaterThanOrEqual(0.48);
    expect(speechStarts[0]!).toBeLessThanOrEqual(0.6);
    const interim = results.filter((result) => !result.isFinal);
    const final = results.filter((result) => result.isFinal);
    expect(interim.length).toBeGreaterThanOrEqual(2);
    expect(final).toHaveLength(1);
    expect(final[0]).toMatchObject({ text: '把这里剪短一点。', isFinal: true, speechFinal: true });
    const zhe = final[0]!.words.find((word) => word.text === '这')!;
    expect(zhe.start).toBeGreaterThanOrEqual(0.4);
    expect(zhe.end).toBeLessThanOrEqual(1.6);
    expect(requests.every((request) => request.url === 'https://gateway.test/v1/audio/transcriptions' && request.authorization === `Bearer ${KEY}`)).toBe(true);
    expect(requests[0]!.form).toMatchObject({ model: 'gpt-4o-transcribe', language: 'zh', response_format: 'json', prompt: TRANSCRIPTION_PROMPTS['zh-CN'] });
    expect(TRANSCRIPTION_PROMPTS['zh-CN']).toContain('简体中文'); // 不给提示时实测会输出繁体
    session.finish();
    await expect.poll(() => closed).toBe(true);
  });

  it('whisper-1 用供应商词时间；401 不可重试且错误不含密钥；429 可重试；网关不自动重试', async () => {
    let calls = 0;
    const words = createOpenAiTranscriptionRecognizer({
      apiKey: KEY, model: 'whisper-1', interimMs: 0,
      fetch: async (_input, init) => {
        calls += 1;
        const form = init?.body as FormData;
        expect(form.get('response_format')).toBe('verbose_json');
        expect(form.getAll('timestamp_granularities[]')).toEqual(['word']);
        return new Response(JSON.stringify({ text: 'make this shorter', words: [{ word: 'make', start: 0.3, end: 0.5 }, { word: 'this', start: 0.6, end: 0.8 }, { word: 'shorter', start: 0.9, end: 1.3 }] }), { status: 200 });
      },
    });
    const finals: StreamingAsrResult[] = [];
    const session = await words.open({ locale: 'en', sampleRate: 16_000 }, { onResult: (result) => finals.push(result), onUtteranceEnd: () => undefined, onError: () => undefined, onClose: () => undefined });
    session.sendAudio(speech([['silence', 0.2], ['voice', 1.0], ['silence', 1.0]]));
    await expect.poll(() => finals.length, { timeout: 3000 }).toBe(1);
    expect(calls).toBe(1); // interimMs = 0：只在说完时转写一次
    // 供应商词时间相对这一段的 WAV 开头（开口前留 300 ms）→ 加上这一段的起点
    expect(finals[0]!.words[1]!.text).toBe('this');
    expect(finals[0]!.words[1]!.start).toBeCloseTo(finals[0]!.start + 0.6, 3);

    for (const [status, code, retryable] of [[401, 'ASR_AUTH_FAILED', false], [429, 'ASR_FAILED', true]] as const) {
      let attempts = 0;
      const failing = createOpenAiTranscriptionRecognizer({ apiKey: KEY, interimMs: 0, fetch: async () => { attempts += 1; return new Response(JSON.stringify({ error: { message: 'nope' } }), { status }); } });
      const errors: { code: string; message: string; retryable: boolean }[] = [];
      const failingSession = await failing.open({ locale: 'en', sampleRate: 16_000 }, { onResult: () => undefined, onUtteranceEnd: () => undefined, onError: (error) => errors.push(error), onClose: () => undefined });
      failingSession.sendAudio(speech([['voice', 0.6], ['silence', 1.0]]));
      await expect.poll(() => errors.length, { timeout: 3000 }).toBe(1);
      expect(errors[0]).toMatchObject({ code, retryable });
      expect(errors[0]!.message).toContain(`HTTP ${String(status)}`);
      expect(errors[0]!.message).not.toContain(KEY);
      await new Promise((done) => setTimeout(done, 50));
      expect(attempts).toBe(1);
    }
  });

  it('合成：边收边回调（奇数字节拼齐）；中止即停；错误不含密钥', async () => {
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6, 7, 8]), new Uint8Array([9, 10])];
    let body: Record<string, unknown> = {};
    const synthesizer = createOpenAiSpeechSynthesizer({
      apiKey: KEY, baseUrl: 'https://gateway.test/v1', voices: [{ id: 'onyx', name: 'Onyx' }],
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } }), { status: 200 });
      },
    });
    expect(synthesizer).toMatchObject({ providerId: 'openai', implementation: 'REAL', model: 'gpt-4o-mini-tts', sampleRate: 24_000, voices: [{ id: 'onyx', name: 'Onyx' }] });
    const received: number[] = [];
    const usage = await synthesizer.synthesize({ text: '好了。', voiceId: 'onyx', locale: 'zh-CN', signal: new AbortController().signal }, (chunk) => {
      expect(chunk.length % 2).toBe(0);
      received.push(...chunk);
    });
    expect(usage).toEqual({ characters: 3 });
    expect(received).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(body).toEqual({ model: 'gpt-4o-mini-tts', voice: 'onyx', input: '好了。', response_format: 'pcm' });

    // 中止：第一块之后用户开口
    const controller = new AbortController();
    const slow = createOpenAiSpeechSynthesizer({
      apiKey: KEY,
      fetch: async () => new Response(new ReadableStream({
        async pull(stream) { await new Promise((done) => setTimeout(done, 20)); stream.enqueue(new Uint8Array(480)); },
      }), { status: 200 }),
    });
    let got = 0;
    await expect(slow.synthesize({ text: '很长的回应', voiceId: 'coral', locale: 'zh-CN', signal: controller.signal }, () => { got += 1; if (got === 2) controller.abort(); })).rejects.toMatchObject({ code: 'ABORTED' });
    expect(got).toBe(2);

    const denied = createOpenAiSpeechSynthesizer({ apiKey: KEY, fetch: async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 }) });
    const failure = await denied.synthesize({ text: 'x', voiceId: 'coral', locale: 'en', signal: new AbortController().signal }, () => undefined).then(() => null, (error: unknown) => error as { code: string; message: string; retryable: boolean });
    expect(failure).toMatchObject({ code: 'AUTH_FAILED', retryable: false });
    expect(failure?.message).not.toContain(KEY);
  });
});
