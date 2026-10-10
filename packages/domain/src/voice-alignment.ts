import {
  ApiFailure,
  ERROR_CODES,
  VOICE_ERROR_REASONS,
  alignVoiceAudioRange,
  alignmentDriftMs,
  negotiateVoiceCapabilities,
  voiceTranscriptAlignmentSchema,
  type MediaRange,
  type MediaTime,
  type VoiceCapabilities,
  type VoiceClockSample,
  type VoiceNegotiationInput,
  type VoiceNegotiationResult,
  type VoicePlaybackAnchor,
  type VoiceTranscriptAlignment,
} from '@ancs/contracts';

/**
 * N05-02：语音能力协商与转写时间对齐的**服务层**。
 *
 * - 协商 fail-closed：请求了声明不支持的能力 → 501（不把未知能力当支持）；
 * - 对齐精度**如实标注**：有可验证音频位置 + 时钟 + 播放锚点才给 AUDIO_RANGE/WORD_EXACT；
 *   否则退到发话快照（UTTERANCE_SNAPSHOT）或 UNAVAILABLE——**绝不把猜测标成逐词精确**；
 * - 不触发任何 Provider、不写工程；本增量协议与纯函数可确定性验证（真实传输待凭据）。
 */

export function negotiateVoiceSessionCapabilities(
  declared: readonly VoiceCapabilities[],
  request: VoiceNegotiationInput = {},
): VoiceNegotiationResult {
  let result: VoiceNegotiationResult;
  try {
    result = negotiateVoiceCapabilities(declared, request);
  } catch (error) {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'no voice adapter for requested transport', 501, {
      reason: VOICE_ERROR_REASONS.UNSUPPORTED_CAPABILITY,
      cause: error instanceof Error ? error.message : 'unknown',
    });
  }
  if (result.unsupported.length > 0) {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'requested voice capabilities are not supported', 501, {
      reason: VOICE_ERROR_REASONS.UNSUPPORTED_CAPABILITY,
      unsupported: result.unsupported,
      transport: result.capabilities.transport,
    });
  }
  return result;
}

export interface AlignVoiceUtteranceInput {
  utteranceId: string;
  transcriptRevision: number;
  audioRange?: MediaRange | null;
  wordTimingAvailable: boolean;
  clockSamples: readonly VoiceClockSample[];
  playbackAnchors: readonly VoicePlaybackAnchor[];
  utteranceSequenceTime?: MediaTime | null;
}

export function alignVoiceUtterance(input: AlignVoiceUtteranceInput): VoiceTranscriptAlignment {
  const audioRange = input.audioRange ?? null;
  const snapshot = input.utteranceSequenceTime ?? null;
  const derived = audioRange === null
    ? null
    : alignVoiceAudioRange({
      audioRange,
      clockSamples: input.clockSamples,
      playbackAnchors: input.playbackAnchors,
      wordTiming: input.wordTimingAvailable,
    });
  if (derived !== null) {
    return voiceTranscriptAlignmentSchema.parse({
      utteranceId: input.utteranceId,
      transcriptRevision: input.transcriptRevision,
      audioRange,
      sequenceRange: derived.sequenceRange,
      sequencePoint: null,
      accuracy: derived.accuracy,
      driftMs: snapshot === null ? null : alignmentDriftMs(derived.sequenceRange.start, snapshot),
      evidenceRefs: [`clock_samples:${String(input.clockSamples.length)}`, `playback_anchors:${String(input.playbackAnchors.length)}`],
    });
  }
  if (snapshot !== null) {
    return voiceTranscriptAlignmentSchema.parse({
      utteranceId: input.utteranceId,
      transcriptRevision: input.transcriptRevision,
      audioRange,
      sequenceRange: null,
      sequencePoint: snapshot,
      accuracy: 'UTTERANCE_SNAPSHOT',
      driftMs: null,
      evidenceRefs: ['utterance_snapshot'],
    });
  }
  return voiceTranscriptAlignmentSchema.parse({
    utteranceId: input.utteranceId,
    transcriptRevision: input.transcriptRevision,
    audioRange,
    sequenceRange: null,
    sequencePoint: null,
    accuracy: 'UNAVAILABLE',
    driftMs: null,
    evidenceRefs: [],
  });
}
