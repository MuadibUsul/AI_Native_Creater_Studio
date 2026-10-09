import { z } from 'zod';
import { sourceMediaProbeResultSchema, mediaRationalSchema } from './assets.js';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';

export const MEDIA_PROXY_PROFILE_KEYS = ['web-edit-video-720p-v1', 'web-edit-audio-48k-stereo-v1'] as const;
export const mediaProxyProfileKeySchema = z.enum(MEDIA_PROXY_PROFILE_KEYS);
export type MediaProxyProfileKey = z.infer<typeof mediaProxyProfileKeySchema>;

const ptsSchema = z.string().regex(/^-?\d+$/);
export const mediaProxyTimeAnchorSchema = z.object({
  position: z.enum(['START', 'MIDDLE', 'END']),
  sourcePts: ptsSchema,
  proxyPts: ptsSchema,
}).strict();

/** Exact affine PTS mapping. It uses stream time bases and origins; average fps is never an input. */
export const mediaProxyStreamTimeMapSchema = z.object({
  schemaVersion: z.literal('1.0'),
  kind: z.literal('PTS_AFFINE'),
  streamType: z.enum(['VIDEO', 'AUDIO']),
  sourceStreamIndex: z.number().int().nonnegative(),
  proxyStreamIndex: z.number().int().nonnegative(),
  sourceTimeBase: mediaRationalSchema,
  proxyTimeBase: mediaRationalSchema,
  sourceOriginPts: ptsSchema,
  proxyOriginPts: ptsSchema,
  sourceDurationTicks: ptsSchema.nullable(),
  proxyDurationTicks: ptsSchema.nullable(),
  anchors: z.array(mediaProxyTimeAnchorSchema).min(2).max(3),
}).strict();
export type MediaProxyStreamTimeMap = z.infer<typeof mediaProxyStreamTimeMapSchema>;

export const mediaProxyTranscodeResultSchema = z.object({
  schemaVersion: z.literal('1.0'),
  profileKey: mediaProxyProfileKeySchema,
  mimeType: z.enum(['video/mp4', 'audio/mp4']),
  fileExtension: z.enum(['mp4', 'm4a']),
  durationMs: z.number().int().nonnegative().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  audioSampleRate: z.number().int().positive().nullable(),
  audioChannels: z.number().int().positive().nullable(),
  timeMappings: z.array(mediaProxyStreamTimeMapSchema).min(1).max(2),
  sourceFacts: z.object({
    formatNames: z.array(z.string()),
    videoRotationDegrees: z.number().int().nullable(),
    videoColorRange: z.string().nullable(),
    videoColorSpace: z.string().nullable(),
    videoColorTransfer: z.string().nullable(),
    videoColorPrimaries: z.string().nullable(),
    audioChannelLayout: z.string().nullable(),
  }).strict(),
}).strict();
export type MediaProxyTranscodeResult = z.infer<typeof mediaProxyTranscodeResultSchema>;

export const mediaProxyJobInputSchema = z.object({
  derivativeId: opaqueIdSchema,
  sourceAssetId: opaqueIdSchema,
  sourceAssetVersionId: opaqueIdSchema,
  outputAssetId: opaqueIdSchema,
  outputAssetVersionId: opaqueIdSchema,
  sourceStorageKey: z.string().min(1).max(512),
  outputStorageKey: z.string().min(1).max(512),
  sourceChecksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
  profileKey: mediaProxyProfileKeySchema,
}).strict();
export type MediaProxyJobInput = z.infer<typeof mediaProxyJobInputSchema>;

export const MEDIA_PROXY_PLAYBACK_STATUSES = ['NOT_REQUIRED', 'PENDING', 'PROCESSING', 'READY', 'FAILED', 'MISSING'] as const;
export const mediaPlaybackResponseSchema = z.object({
  assetId: opaqueIdSchema,
  sourceVersionId: opaqueIdSchema,
  rendition: z.enum(['ORIGINAL', 'PROXY']).nullable(),
  renditionVersionId: opaqueIdSchema.nullable(),
  mimeType: z.string().nullable(),
  url: z.string().nullable(),
  expiresAt: isoDateTimeSchema.nullable(),
  proxyStatus: z.enum(MEDIA_PROXY_PLAYBACK_STATUSES),
  proxyProfileKey: mediaProxyProfileKeySchema.nullable(),
  timeMappings: z.array(mediaProxyStreamTimeMapSchema),
  message: z.string().nullable(),
}).strict();
export type MediaPlaybackResponse = z.infer<typeof mediaPlaybackResponseSchema>;

/** Worker I/O seam. The implementation runs ffmpeg/ffprobe out of process and writes outputPath. */
export interface SourceMediaTranscoder {
  readonly kind: string;
  transcode(input: {
    sourcePath: string;
    outputPath: string;
    profileKey: MediaProxyProfileKey;
    sourceProbe: z.infer<typeof sourceMediaProbeResultSchema>;
  }): Promise<MediaProxyTranscodeResult>;
}

function divideNearest(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError('denominator must be positive');
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n) return quotient;
  const magnitude = remainder < 0n ? -remainder : remainder;
  return magnitude * 2n >= denominator ? quotient + (numerator < 0n ? -1n : 1n) : quotient;
}

export function mapSourcePtsToProxyPts(mapping: MediaProxyStreamTimeMap, sourcePts: string): string {
  const parsed = mediaProxyStreamTimeMapSchema.parse(mapping);
  const offset = BigInt(ptsSchema.parse(sourcePts)) - BigInt(parsed.sourceOriginPts);
  const numerator = offset * BigInt(parsed.sourceTimeBase.numerator) * BigInt(parsed.proxyTimeBase.denominator);
  const denominator = BigInt(parsed.sourceTimeBase.denominator) * BigInt(parsed.proxyTimeBase.numerator);
  return String(BigInt(parsed.proxyOriginPts) + divideNearest(numerator, denominator));
}

export function mapProxyPtsToSourcePts(mapping: MediaProxyStreamTimeMap, proxyPts: string): string {
  const parsed = mediaProxyStreamTimeMapSchema.parse(mapping);
  const offset = BigInt(ptsSchema.parse(proxyPts)) - BigInt(parsed.proxyOriginPts);
  const numerator = offset * BigInt(parsed.proxyTimeBase.numerator) * BigInt(parsed.sourceTimeBase.denominator);
  const denominator = BigInt(parsed.proxyTimeBase.denominator) * BigInt(parsed.sourceTimeBase.numerator);
  return String(BigInt(parsed.sourceOriginPts) + divideNearest(numerator, denominator));
}
