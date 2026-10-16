'use client';

import type { ReactElement } from 'react';
import { ASPECT_RATIO_SIZES, DEFAULT_THEME_TOKENS, sceneRenderContextSchema, type AspectRatio } from '@ancs/contracts';
import { getComponent, SceneThemeProvider } from '@ancs/scene-components';
import { useI18n } from '@/i18n/I18nProvider';
import ui from './Monochrome.module.css';

/**
 * 场景缩略预览（P05-03；P05-04 将替换为 Remotion Player 时间轴预览）：
 * 用**与成片同一个组件注册表**渲染静态静帧（0.2 缩放），保证"预览与渲染同源"。
 * 未注册组件 → 明确说明（绝不拿别的组件冒充）。
 */

export interface ScenePreviewProps {
  sceneType: string;
  componentVersion: string | null;
  props: Record<string, unknown>;
  durationMs: number;
  aspectRatio?: AspectRatio;
  width?: number;
}

export function ScenePreview({ sceneType, componentVersion, props, durationMs, aspectRatio = '16:9', width = 384 }: ScenePreviewProps): ReactElement {
  const t = useI18n().messages.projectFlow.scenePreview;
  const definition = getComponent(sceneType, componentVersion ?? undefined);
  const scale = width / ASPECT_RATIO_SIZES[aspectRatio].width;
  if (definition === null) {
    return (
      <div data-state="unregistered" style={{ width, height: Math.round(ASPECT_RATIO_SIZES[aspectRatio].height * scale) }} className={`flex items-center justify-center text-xs ${ui['notice']}`}>
        {t.unregistered(sceneType)}
      </div>
    );
  }
  const parsed = definition.inputSchema.safeParse(props);
  if (!parsed.success) {
    return (
      <div data-state="invalid-props" style={{ width, height: Math.round(ASPECT_RATIO_SIZES[aspectRatio].height * scale) }} className={`flex items-center justify-center text-xs ${ui['notice']}`}>
        {t.invalidProps(sceneType)}
      </div>
    );
  }
  const context = sceneRenderContextSchema.parse({
    frame: 0,
    fps: 30,
    durationMs: Math.max(1, durationMs),
    ...ASPECT_RATIO_SIZES[aspectRatio],
    aspectRatio,
    theme: DEFAULT_THEME_TOKENS,
  });
  const Renderer = definition.renderer;
  return (
    <div
      data-state="rendered"
      data-scene-type={sceneType}
      style={{
        width,
        height: Math.round(ASPECT_RATIO_SIZES[aspectRatio].height * scale),
        overflow: 'hidden',
        borderRadius: 8,
        position: 'relative',
      }}
    >
      <div style={{ width: ASPECT_RATIO_SIZES[aspectRatio].width, height: ASPECT_RATIO_SIZES[aspectRatio].height, transform: `scale(${String(scale)})`, transformOrigin: 'top left' }}>
        <SceneThemeProvider>
          <Renderer props={parsed.data as never} context={context} />
        </SceneThemeProvider>
      </div>
    </div>
  );
}
