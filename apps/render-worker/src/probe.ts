import { parseMedia } from '@remotion/media-parser';
import { nodeReader } from '@remotion/media-parser/node';
import { mediaProbeResultSchema, type MediaProbeResult } from '@ancs/contracts';

/**
 * 媒体探测（P07-05）：QA 的**独立复核**手段——重新解析产物字节，取分辨率/fps/时长/音轨。
 * 实现放在 render-worker（media-parser 的唯一归属）；worker 以进程隔离 CLI 调用（见 run-probe.ts）。
 */

export async function probeMediaFile(filePath: string): Promise<MediaProbeResult> {
  const media = await parseMedia({
    src: filePath,
    reader: nodeReader,
    // 内部开发用途；商业上线前的 Remotion 授权核验见计划 P09-06（REQ-47-01）
    acknowledgeRemotionLicense: true,
    fields: { dimensions: true, durationInSeconds: true, fps: true, audioCodec: true, videoCodec: true, tracks: true },
  });
  return mediaProbeResultSchema.parse({
    width: media.dimensions?.width ?? null,
    height: media.dimensions?.height ?? null,
    fps: media.fps ?? null,
    durationMs: media.durationInSeconds === null ? null : Math.round(media.durationInSeconds * 1000),
    hasAudio: media.audioCodec !== null && media.tracks.some((track) => track.type === 'audio'),
    audioCodec: media.audioCodec,
    videoCodec: media.videoCodec,
  });
}
