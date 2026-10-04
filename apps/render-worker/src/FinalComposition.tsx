import type { ReactElement } from 'react';
import { AbsoluteFill, Audio, useCurrentFrame, useVideoConfig } from 'remotion';
import { wrapCaption, type CaptionStyle, type GainKeyframe, type RenderExecutionSpec } from '@ancs/contracts';
import { registerBuiltInComponents } from '@ancs/scene-components';
import { VideoComposition } from '@ancs/remotion-core';

/**
 * Final 合成 Composition（P07-04 / §39、§58、§59）。
 *
 * - 画面：与预览**同一映射**（remotion-core 的 VideoComposition + 组件注册表）；
 * - 音频：Master Narration（Alignment 权威音轨；旁白唯一来源）+ BGM 轨道按 P06-06 混音计划的
 *   增益包络（ducking/淡入淡出）逐帧计算音量；
 * - 字幕烧录：按 Alignment cue 与 CaptionStyle 断行绘制（越界仅告警，不静默裁切）；
 * - 素材：同源相对 URL（`/assets/<fileName>`），由执行器把冻结对象复制进 bundle 静态目录——
 *   组件不访问网络/凭据（§59）。
 */

registerBuiltInComponents();

// 注意：必须是 type alias（interface 无隐式索引签名，无法满足 Remotion 的 Props extends Record<string, unknown>）
export type FinalCompositionProps = {
  spec: RenderExecutionSpec;
};

/** 增益包络：按毫秒在关键帧序列上线性插值（首帧前取首段 fromGain，末帧后取末段 toGain）。 */
export function gainAtMs(keyframes: readonly GainKeyframe[], ms: number): number {
  if (keyframes.length === 0) return 1;
  const first = keyframes[0] as GainKeyframe;
  if (ms <= first.startMs) return first.fromGain;
  for (const keyframe of keyframes) {
    if (ms >= keyframe.startMs && ms <= keyframe.endMs) {
      const span = Math.max(1, keyframe.endMs - keyframe.startMs);
      const progress = Math.min(1, Math.max(0, (ms - keyframe.startMs) / span));
      return keyframe.fromGain + (keyframe.toGain - keyframe.fromGain) * progress;
    }
  }
  const last = keyframes[keyframes.length - 1] as GainKeyframe;
  return last.toGain;
}

/** 命中当前时刻的字幕 cue（无 → null）。 */
export function captionAtMs(cues: readonly { startMs: number; durationMs: number; text: string }[], ms: number): string | null {
  const cue = cues.find((candidate) => ms >= candidate.startMs && ms < candidate.startMs + candidate.durationMs);
  return cue?.text ?? null;
}

function CaptionOverlay({ cues, style }: { cues: readonly { startMs: number; durationMs: number; text: string }[]; style: CaptionStyle }): ReactElement | null {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const ms = (frame / fps) * 1000;
  const text = captionAtMs(cues, ms);
  if (text === null) return null;
  const wrapped = wrapCaption(text, style);
  const justify = style.position === 'TOP' ? 'flex-start' : style.position === 'CENTER' ? 'center' : 'flex-end';
  const marginTop = style.position === 'TOP' ? style.safeArea.topPx : undefined;
  const marginBottom = style.position === 'BOTTOM' ? style.safeArea.bottomPx : undefined;
  return (
    <AbsoluteFill
      style={{
        justifyContent: justify,
        alignItems: 'center',
        paddingLeft: style.safeArea.leftPx,
        paddingRight: style.safeArea.rightPx,
        ...(marginTop !== undefined ? { paddingTop: marginTop } : {}),
        ...(marginBottom !== undefined ? { paddingBottom: marginBottom } : {}),
        pointerEvents: 'none',
      }}
    >
      <div
        data-role="caption-block"
        style={{
          maxWidth: width - style.safeArea.leftPx - style.safeArea.rightPx,
          fontFamily: 'Inter, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif',
          fontSize: style.fontSizePx,
          lineHeight: 1.35,
          color: '#FFFFFF',
          textAlign: 'center',
          ...(style.background === 'BLOCK'
            ? { backgroundColor: 'rgba(5, 8, 14, 0.72)', borderRadius: 10, padding: '10px 22px' }
            : { textShadow: '0 2px 8px rgba(0,0,0,0.85)' }),
          whiteSpace: 'pre-line',
        }}
      >
        {wrapped.lines.join('\n')}
      </div>
    </AbsoluteFill>
  );
}

export function FinalComposition({ spec }: FinalCompositionProps): ReactElement {
  const { fps } = useVideoConfig();
  const assetFileNameByAssetId = new Map(spec.assets.map((asset) => [asset.assetId, asset.fileName]));
  const resolveAssetUrl = (assetId: string): string | null => {
    const fileName = assetFileNameByAssetId.get(assetId);
    return fileName === undefined ? null : `/assets/${fileName}`;
  };

  return (
    <AbsoluteFill style={{ backgroundColor: '#05070C' }}>
      <VideoComposition
        graph={{ format: spec.graph.format, timeline: spec.graph.timeline, scenes: spec.graph.scenes }}
        theme={spec.theme ?? undefined}
        resolveAssetUrl={resolveAssetUrl}
      />
      {/* 旁白（Alignment 权威音轨；唯一"人声"） */}
      {spec.narration !== null ? <Audio src={`/assets/${spec.narration.fileName}`} /> : null}
      {/* BGM/音效：增益包络来自混音计划（ducking 在旁白区间压低） */}
      {spec.musicTracks.map((track) => (
        <Audio key={track.trackId} src={`/assets/${track.fileName}`} volume={(volumeFrame) => gainAtMs(track.keyframes, (volumeFrame / fps) * 1000)} />
      ))}
      {spec.captions.burnIn ? <CaptionOverlay cues={spec.captions.cues} style={spec.captions.style} /> : null}
    </AbsoluteFill>
  );
}
