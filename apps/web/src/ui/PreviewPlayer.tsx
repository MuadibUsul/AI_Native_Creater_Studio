'use client';

import { useMemo } from 'react';
import { Player } from '@remotion/player';
import type { SceneGraph } from '@ancs/contracts';
import { timelineOf, VideoComposition, type CompositionSceneInput } from '@ancs/remotion-core';
import { useI18n } from '@/i18n/I18nProvider';

/**
 * 预览播放器（P05-04）：Remotion Player 消费 Scene Graph；
 * 时序与素材注入经 @ancs/remotion-core（与成片渲染**同一映射**，§5.2 无漂移口径）。
 *
 * 纪律：
 * - 预览是**本地渲染**：不触发任何 Provider 生成/计费调用（"编辑不会隐式触发昂贵视频调用"）；
 * - 素材 URL 解析失败/缺失 → 组件自身的明确占位（Draft 占位策略），不静默空白；
 * - Player 尺寸按画幅等比缩放（容器宽）。
 */

export interface PreviewPlayerProps {
  graph: Pick<SceneGraph, 'format' | 'scenes' | 'timeline'>;
  /** assetId → 可渲染 URL（Signed URL）；未解析的资产走占位 */
  resolveAssetUrl?: (assetId: string) => string | null;
  /** 容器宽度（默认 720） */
  width?: number;
}

export function PreviewPlayer({ graph, resolveAssetUrl, width = 720 }: PreviewPlayerProps) {
  const timing = useMemo(() => timelineOf(graph), [graph]);
  const { messages } = useI18n();
  const height = Math.round((width * graph.format.height) / graph.format.width);

  return (
    <div data-testid="preview-player" style={{ width, maxWidth: '100%' }}>
      <Player
        component={VideoComposition}
        durationInFrames={timing.durationInFrames}
        fps={timing.fps}
        compositionWidth={graph.format.width}
        compositionHeight={graph.format.height}
        style={{ width: '100%', height }}
        controls
        inputProps={{
          graph: {
            format: graph.format,
            timeline: graph.timeline,
            scenes: graph.scenes as unknown as readonly CompositionSceneInput[],
          },
          ...(resolveAssetUrl !== undefined ? { resolveAssetUrl } : {}),
        }}
      />
      <p className="mt-1 text-xs text-slate-500">
        {messages.projectFlow.previewPlayer.timing(timing.durationInFrames, timing.fps, timing.durationMs)}
      </p>
    </div>
  );
}
