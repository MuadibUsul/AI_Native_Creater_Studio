import { Composition } from 'remotion';
import { LANDSCAPES, type LandscapeId } from './landscapes';
import { LaunchTrailer, TRAILER_FRAMES, type LaunchTrailerProps } from './LaunchTrailer';

/**
 * 宣传片的 Remotion 根（与产品渲染入口分开打包）：
 * - PromoClip：四段原创风光素材（1280×720 / 6 秒），既上传进真实产品当用户素材，也给预告片当画面；
 * - LaunchTrailer：约 50 秒的发布预告片（1920×1080 / 30fps）。
 */
const PromoClip: React.FC<{ scene: LandscapeId }> = ({ scene }) => {
  const Scene = LANDSCAPES[scene];
  return <Scene />;
};

export const PromoRoot: React.FC = () => (
  <>
    <Composition id="PromoClip" component={PromoClip as unknown as React.FC<Record<string, unknown>>} width={1280} height={720} fps={30} durationInFrames={180} defaultProps={{ scene: 'aurora' }} />
    <Composition
      id="LaunchTrailer"
      component={LaunchTrailer as unknown as React.FC<Record<string, unknown>>}
      width={1920}
      height={1080}
      fps={30}
      durationInFrames={TRAILER_FRAMES}
      defaultProps={{ templates: {}, capture: null } satisfies LaunchTrailerProps}
    />
  </>
);
