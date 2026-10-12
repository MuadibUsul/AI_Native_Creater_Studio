import { Composition } from 'remotion';
import { EffectLayer, type EffectLayerProps } from './EffectLayer';

/** 特效图层的 Remotion 根：尺寸、帧率与时长由渲染请求决定。 */
export const EffectRoot: React.FC = () => (
  <Composition
    id="EffectLayer"
    component={EffectLayer as unknown as React.FC<Record<string, unknown>>}
    width={1280}
    height={720}
    fps={30}
    durationInFrames={60}
    defaultProps={{ code: '', params: {}, seed: 'seed' } satisfies EffectLayerProps}
    calculateMetadata={({ props }) => {
      const layout = (props as { layout?: { width: number; height: number; fps: number; durationInFrames: number } }).layout;
      return layout === undefined ? {} : { width: layout.width, height: layout.height, fps: layout.fps, durationInFrames: layout.durationInFrames };
    }}
  />
);
