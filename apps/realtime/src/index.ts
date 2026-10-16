export { createRealtimeGateway } from './gateway.js';
export type { RealtimeGateway, RealtimeGatewayOptions } from './gateway.js';
export { createDeepgramLiveRecognizer } from './deepgram-live.js';
export type { DeepgramLiveOptions } from './deepgram-live.js';
export { deepgramResult, deepgramUtteranceEnd, startFakeDeepgramLive } from './fake-deepgram-live.js';
export type { FakeDeepgramConnection, FakeDeepgramStep } from './fake-deepgram-live.js';
export { createOpenAiSpeechSynthesizer, createOpenAiTranscriptionRecognizer, pcmToWav } from './openai-audio.js';
export type { OpenAiRecognizerOptions } from './openai-audio.js';
