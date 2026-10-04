import { Composition } from 'remotion';
import { bigNumberComponent } from '@ancs/scene-components';
import { timelineOf } from '@ancs/remotion-core';
import { BigNumberScene, bigNumberSceneDefaultProps } from './scenes/BigNumberScene';
import { RegistryScene, type RegistrySceneProps } from './scenes/RegistryScene';
import { ComponentGallery, GALLERY_DEFAULT_PROPS } from './scenes/ComponentGallery';
import { FinalComposition, type FinalCompositionProps } from './FinalComposition';
import { FINAL_COMPOSITION_FIXTURE_SPEC } from './final-fixture';

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
  // P07-04：Final 合成——时长/画幅/fps 全部从 spec 派生（calculateMetadata），与预览共用 timelineOf
  const finalDefaults: FinalCompositionProps = { spec: FINAL_COMPOSITION_FIXTURE_SPEC };
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
      {/* P07-04 Final 合成：服务端渲染入口（renderMedia 用 inputProps.spec 覆盖全部默认） */}
      <Composition
        id="FinalComposition"
        component={FinalComposition}
        durationInFrames={1}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={finalDefaults}
        calculateMetadata={({ props }) => {
          const timing = timelineOf({
            format: {
              fps: props.spec.graph.format.fps,
              width: props.spec.graph.format.width,
              height: props.spec.graph.format.height,
              aspectRatio: props.spec.graph.format.aspectRatio,
            },
            timeline: props.spec.graph.timeline,
            scenes: props.spec.graph.scenes,
          });
          return {
            durationInFrames: timing.durationInFrames,
            fps: props.spec.format.fps,
            width: props.spec.format.width,
            height: props.spec.format.height,
          };
        }}
      />
    </>
  );
}
