import { Composition } from 'remotion';
import { bigNumberComponent } from '@ancs/scene-components';
import { BigNumberScene, bigNumberSceneDefaultProps } from './scenes/BigNumberScene';
import { RegistryScene, type RegistrySceneProps } from './scenes/RegistryScene';
import { ComponentGallery, GALLERY_DEFAULT_PROPS } from './scenes/ComponentGallery';

/** V1 默认输出：16:9 / 1920×1080 / 30fps（计划 §1.2）。 */
export function RemotionRoot() {
  // P05-01：注册表组件（ComponentDefinition）经统一挂载点渲染（fixture 即默认 props）
  const registryDefaults: RegistrySceneProps = {
    componentType: bigNumberComponent.type,
    componentVersion: bigNumberComponent.version,
    propsInput: bigNumberComponent.previewFixture.props,
    theme: null,
    aspectRatio: '16:9',
  };
  return (
    <>
      <Composition
        id="BigNumberScene"
        component={BigNumberScene}
        durationInFrames={90}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={bigNumberSceneDefaultProps}
      />
      <Composition
        id="RegistryBigNumberScene"
        component={RegistryScene}
        durationInFrames={90}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={registryDefaults}
      />
      {/* P05-02 渲染证据：20 组件画廊（props.variant 切换五类输入） */}
      <Composition
        id="ComponentGallery"
        component={ComponentGallery}
        durationInFrames={60}
        fps={30}
        width={1920}
        height={1000}
        defaultProps={GALLERY_DEFAULT_PROPS}
      />
    </>
  );
}
