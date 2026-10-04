import { Composition } from 'remotion';
import { BigNumberScene, bigNumberSceneDefaultProps } from './scenes/BigNumberScene';

/** V1 默认输出：16:9 / 1920×1080 / 30fps（计划 §1.2）。 */
export function RemotionRoot() {
  return (
    <Composition
      id="BigNumberScene"
      component={BigNumberScene}
      durationInFrames={90}
      fps={30}
      width={1920}
      height={1080}
      defaultProps={bigNumberSceneDefaultProps}
    />
  );
}
