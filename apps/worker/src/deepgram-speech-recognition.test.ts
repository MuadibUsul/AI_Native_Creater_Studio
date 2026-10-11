import { describe, expect, it, vi } from 'vitest';
import { createDeepgramSpeechRecognitionAdapter, mapDeepgramResponse } from './deepgram-speech-recognition.js';

/**
 * Deepgram 适配器：**映射是离线可验的纯函数**；真实调用另行 opt-in（见 scripts/provider-verify 与 verification 文档）。
 * 这里用 Deepgram 预录响应的真实形状（words/utterances/confidence）验证映射，不产生任何费用。
 */
const response = {
  results: {
    channels: [{
      detected_language: 'zh',
      alternatives: [{
        transcript: '去掉前面废话 保留原音',
        confidence: 0.98,
        words: [
          { word: '去掉', punctuated_word: '去掉', start: 0.32, end: 0.71, confidence: 0.99, speaker: 0 },
          { word: '前面', punctuated_word: '前面', start: 0.71, end: 1.12, confidence: 0.98, speaker: 0 },
          { word: '废话', punctuated_word: '废话', start: 1.12, end: 1.60, confidence: 0.97, speaker: 0 },
          { word: '保留', punctuated_word: '保留', start: 2.40, end: 2.85, confidence: 0.99, speaker: 1 },
          { word: '原音', punctuated_word: '原音', start: 2.85, end: 3.30, confidence: 0.96, speaker: 1 },
        ],
      }],
    }],
    utterances: [
      { start: 0.32, end: 1.60, transcript: '去掉前面废话', confidence: 0.98, speaker: 0 },
      { start: 2.40, end: 3.30, transcript: '保留原音', confidence: 0.97, speaker: 1 },
    ],
  },
};

describe('Deepgram 响应映射（离线）', () => {
  it('逐词时间戳落到毫秒有理时基，ordinal 连续', () => {
    const transcript = mapDeepgramResponse({ payload: response, model: 'nova-2', fallbackLanguage: 'zh-CN', diarize: true });
    expect(transcript.provider).toBe('deepgram');
    expect(transcript.words).toHaveLength(5);
    expect(transcript.words[0]).toMatchObject({ ordinal: 0, text: '去掉', sourceStartPts: '320', sourceEndPts: '710', timeBase: { numerator: 1, denominator: 1000 }, speakerId: 'spk_0' });
    expect(transcript.words.map((word) => word.ordinal)).toEqual([0, 1, 2, 3, 4]);
    expect(transcript.words[4]!.sourceStartPts).toBe('2850');
  });

  it('分段由 utterances 生成，词序号范围按时间落入的词界定（不凭空编号）', () => {
    const transcript = mapDeepgramResponse({ payload: response, model: 'nova-2', fallbackLanguage: 'zh-CN', diarize: true });
    expect(transcript.segments).toHaveLength(2);
    expect(transcript.segments[0]).toMatchObject({ ordinal: 0, text: '去掉前面废话', wordStartOrdinal: 0, wordEndOrdinal: 2, evidence: 'ASR_INFERENCE', reviewState: 'UNREVIEWED' });
    expect(transcript.segments[1]).toMatchObject({ wordStartOrdinal: 3, wordEndOrdinal: 4, speakerId: 'spk_1' });
  });

  it('说话人来自分离结果，身份状态如实标 INFERRED（不假装已确认）', () => {
    const transcript = mapDeepgramResponse({ payload: response, model: 'nova-2', fallbackLanguage: 'zh-CN', diarize: true });
    expect(transcript.speakers).toEqual([
      { id: 'spk_0', displayName: null, identityState: 'INFERRED', confidencePermille: null },
      { id: 'spk_1', displayName: null, identityState: 'INFERRED', confidencePermille: null },
    ]);
  });

  it('语言取服务端检测结果；关闭分离时不带说话人', () => {
    expect(mapDeepgramResponse({ payload: response, model: 'nova-2', fallbackLanguage: 'zh-CN', diarize: true }).language).toBe('zh');
    const noDiarize = mapDeepgramResponse({ payload: response, model: 'nova-2', fallbackLanguage: 'zh-CN', diarize: false });
    expect(noDiarize.words.every((word) => word.speakerId === null)).toBe(true);
    expect(noDiarize.speakers).toEqual([]);
  });

  it('空转写 → 空 words/segments（不假装识别到内容）；缺字段的词条被略过', () => {
    const empty = mapDeepgramResponse({ payload: { results: { channels: [{ alternatives: [{}] }] } }, model: 'nova-2', fallbackLanguage: 'zh-CN', diarize: true });
    expect(empty.words).toEqual([]);
    expect(empty.segments).toEqual([]);
    const partial = mapDeepgramResponse({
      payload: { results: { channels: [{ alternatives: [{ words: [{ word: '好', start: 0.1 }] }] }] } },
      model: 'nova-2', fallbackLanguage: 'zh-CN', diarize: true,
    });
    expect(partial.words).toEqual([]); // 缺 end → 略过，不猜
  });

  it('适配器把密钥放在请求头、且错误信息**不含密钥**', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } }));
    const adapter = createDeepgramSpeechRecognitionAdapter({ apiKey: 'test-key-abc', fetchImpl: fetchImpl as unknown as typeof fetch, baseUrl: 'https://example.invalid' });
    const transcript = await adapter.transcribe({ sourcePath: new URL('./deepgram-speech-recognition.test.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1') });
    expect(transcript.provider).toBe('deepgram');
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(String(url)).toContain('/v1/listen?');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Token test-key-abc');

    const failing = createDeepgramSpeechRecognitionAdapter({
      apiKey: 'test-key-abc',
      fetchImpl: (async () => new Response('bad request', { status: 400 })) as unknown as typeof fetch,
      baseUrl: 'https://example.invalid',
    });
    const error = await failing.transcribe({ sourcePath: new URL('./deepgram-speech-recognition.test.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1') }).then(() => null, (caught: unknown) => caught as Error);
    expect(error?.message).toContain('DEEPGRAM_HTTP_400');
    expect(error?.message).not.toContain('test-key-abc'); // 密钥绝不进错误返回
  });
});
