import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { ASPECT_RATIOS, DEFAULT_THEME_TOKENS, type AspectRatio, type ThemeTokens } from '@ancs/contracts';
import { getComponent, SceneThemeProvider } from '@ancs/scene-components';
import { frameWithinScene, timelineOf, type TimelineInput } from './timeline.js';

/**
 * Scene Graph → 按帧渲染的视频合成（P05-04；预览与成片共用）。
 *
 * 纪律（§59）：
 * - 组件只消费帧/时长/画幅/主题与 props（画面是帧的纯函数）；**不访问网络/凭据/时钟**；
 * - 素材由 `resolveAssetUrl` 注入（预览层解析 Signed URL；缺失/失败 → 保持 undefined，
 *   由组件自身的**明确占位**呈现 —— Draft 占位策略）；
 * - 未注册组件 → 明确说明（不拿别的组件冒充）。
 */

/** 合成所需的最小场景字段（Scene Graph 的完整 DTO 结构兼容）。 */
export interface CompositionSceneInput {
  id: string;
  position: number;
  startMs: number;
  durationMs: number;
  sceneType: string;
  componentVersion: string | null;
  props: Record<string, unknown>;
  assetBindings: { assetId: string; role: string }[];
}

export interface VideoCompositionProps {
  graph: {
    format: TimelineInput['format'];
    timeline: { durationMs: number };
    scenes: readonly CompositionSceneInput[];
  };
  theme?: Partial<ThemeTokens> | undefined;
  /** 素材解析（assetId → 可渲染 URL）；返回 null/undefined 时组件走占位路径 */
  resolveAssetUrl?: ((assetId: string) => string | null) | undefined;
}

const EMPTY_FRAME_COLOR = '#05070C';

export function VideoComposition({ graph, theme, resolveAssetUrl }: VideoCompositionProps) {
  const frame = useCurrentFrame();
  const timing = timelineOf(graph);
  const current = timing.scenes.find((scene) => frame >= scene.startFrame && frame < scene.endFrame);
  if (current === undefined) {
    return <AbsoluteFill style={{ backgroundColor: EMPTY_FRAME_COLOR }} />;
  }
  const scene = graph.scenes.find((candidate) => candidate.id === current.sceneId);
  if (scene === undefined) {
    return <AbsoluteFill style={{ backgroundColor: EMPTY_FRAME_COLOR }} />;
  }

  const definition = getComponent(scene.sceneType, scene.componentVersion ?? undefined);
  if (definition === null) {
    return (
      <AbsoluteFill style={{ backgroundColor: EMPTY_FRAME_COLOR, alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ color: '#FFB020', fontFamily: 'monospace', fontSize: 28 }}>组件未注册：{scene.sceneType}</span>
      </AbsoluteFill>
    );
  }

  const props = { ...(scene.props as Record<string, unknown>) };
  // 素材注入：assetBindings 中的 visual/broll 类资产解析为预览 URL（失败 → 保持 null，组件显示占位）
  for (const binding of scene.assetBindings) {
    const resolved = resolveAssetUrl?.(binding.assetId) ?? null;
    if (resolved !== null) {
      if (binding.role === 'visual' || binding.role === 'broll' || binding.role === 'avatar') props['assetUrl'] = resolved;
    }
    props['assetId'] = binding.assetId;
  }

  const parsed = definition.inputSchema.safeParse(props);
  const Renderer = definition.renderer;
  // Scene 格式的 aspectRatio 是开放字符串（组件协议限定为 4 种画幅）；未知值按 16:9 处理并保持尺寸不变
  const aspectRatio: AspectRatio = (ASPECT_RATIOS as readonly string[]).includes(graph.format.aspectRatio)
    ? (graph.format.aspectRatio as AspectRatio)
    : '16:9';
  return (
    <AbsoluteFill>
      <SceneThemeProvider theme={theme ?? DEFAULT_THEME_TOKENS}>
        {parsed.success ? (
          <Renderer
            props={parsed.data as never}
            context={{
              frame: frameWithinScene(current, frame),
              fps: timing.fps,
              durationMs: current.endMs - current.startMs,
              width: graph.format.width,
              height: graph.format.height,
              aspectRatio,
              theme: theme !== undefined ? { ...DEFAULT_THEME_TOKENS, ...theme } : DEFAULT_THEME_TOKENS,
            }}
          />
        ) : (
          <PreviewPropsError sceneType={scene.sceneType} messages={parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)} />
        )}
      </SceneThemeProvider>
    </AbsoluteFill>
  );
}

function PreviewPropsError({ sceneType, messages }: { sceneType: string; messages: string[] }) {
  return (
    <AbsoluteFill style={{ backgroundColor: EMPTY_FRAME_COLOR, alignItems: 'center', justifyContent: 'center', padding: 64 }}>
      <span data-role="preview-props-error" style={{ color: '#FF7A7A', fontFamily: 'monospace', fontSize: 26, textAlign: 'center' }}>
        场景 props 未通过 {sceneType} 校验（{messages.join('；')}）
      </span>
    </AbsoluteFill>
  );
}
