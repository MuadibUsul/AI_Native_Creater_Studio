import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { sceneRenderContextSchema, type AspectRatio, type ThemeTokens } from '@ancs/contracts';
import { getComponent, registerBuiltInComponents, SceneThemeProvider } from '@ancs/scene-components';

/**
 * 注册表组件挂载点（P05-01）：按 ComponentDefinition 的 type/version 从注册表解析组件，
 * 校验 props（组件自身 inputSchema）后渲染；主题经 SceneThemeProvider 注入（§57）。
 *
 * Remotion Composition 要求 props 兼容 Record<string, unknown>，故此处用 type 承载输入，
 * 并在渲染前显式校验（失败即抛错——渲染链路不得静默渲染坏数据）。
 */

registerBuiltInComponents();

export type RegistrySceneProps = {
  componentType: string;
  componentVersion?: string | null;
  propsInput: Record<string, unknown>;
  theme?: Partial<ThemeTokens> | null;
  aspectRatio?: AspectRatio;
};

export function RegistryScene({ componentType, componentVersion, propsInput, theme, aspectRatio }: RegistrySceneProps) {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width, height } = useVideoConfig();
  const definition = getComponent(componentType, componentVersion ?? undefined);
  if (definition === null) {
    throw new Error(`未注册的组件：${componentType}@${componentVersion ?? 'latest'}`);
  }
  const parsed = definition.inputSchema.safeParse(propsInput);
  if (!parsed.success) {
    throw new Error(`组件 ${componentType} 的 props 未通过校验：${parsed.error.issues.map((issue) => issue.message).join('；')}`);
  }
  const context = sceneRenderContextSchema.parse({
    frame,
    fps,
    durationMs: Math.round((durationInFrames / fps) * 1000),
    width,
    height,
    aspectRatio: aspectRatio ?? '16:9',
  });
  const Renderer = definition.renderer;
  return (
    <AbsoluteFill>
      <SceneThemeProvider theme={theme ?? undefined}>
        <Renderer props={parsed.data as never} context={context} />
      </SceneThemeProvider>
    </AbsoluteFill>
  );
}
