import { AbsoluteFill } from 'remotion';
import { DEFAULT_THEME_TOKENS, EXTENDED_SCENE_TYPES, STANDARD_SCENE_TYPES, sceneRenderContextSchema } from '@ancs/contracts';
import {
  COMPONENT_VARIANTS,
  getComponent,
  registerBuiltInComponents,
  SceneThemeProvider,
  type ComponentVariantName,
} from '@ancs/scene-components';

/**
 * 组件画廊（P05-02 渲染证据）：把全部 20 个标准组件按**同一变体**渲染为缩略格
 * （每个格子是 1920×1080 场景缩放 0.2 的忠实预览，含类型名与变体名）。
 *
 * 五种变体各出一张 PNG（正常/长文本/空值/极值/边界时长），作为"每组件 × 五类输入
 * 均有渲染证据"的成片级证据；单元层另有逐组件的标记断言（见 ComponentVariants.test.tsx）。
 */

registerBuiltInComponents();

export type ComponentGalleryProps = {
  variant: ComponentVariantName;
  /** 画廊分组：standard（V1 20 类基线）/ extended（P10-04 扩展 13 类） */
  group?: 'standard' | 'extended';
};

const CELL_WIDTH = 384;
const CELL_HEIGHT = 216;
const COLUMNS = 5;
const HEADER_HEIGHT = 72;

const VARIANT_LABEL: Record<ComponentVariantName, string> = {
  normal: '正常',
  longText: '长文本',
  empty: '空值',
  extreme: '极值',
  boundary: '边界时长',
};

export function ComponentGallery({ variant, group = 'standard' }: ComponentGalleryProps) {
  const types = group === 'standard' ? STANDARD_SCENE_TYPES : EXTENDED_SCENE_TYPES;
  const groupTitle = group === 'standard' ? '标准组件画廊（V1 20 类）' : '扩展组件画廊（P10-04 · 14 类）';
  return (
    <AbsoluteFill style={{ backgroundColor: '#05070C', color: '#E5ECF8', fontFamily: DEFAULT_THEME_TOKENS.font.body }}>
      <div
        style={{
          height: HEADER_HEIGHT,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 32px',
          fontSize: 32,
          fontWeight: 600,
        }}
      >
        <span>ANCS · {groupTitle}</span>
        <span style={{ color: DEFAULT_THEME_TOKENS.color.accent }}>变体：{VARIANT_LABEL[variant]}</span>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${String(COLUMNS)}, ${String(CELL_WIDTH)}px)`,
          gridTemplateRows: `repeat(${String(Math.ceil(types.length / COLUMNS))}, ${String(CELL_HEIGHT)}px)`,
          gap: 12,
          padding: '0 24px',
        }}
      >
        {types.map((type) => {
          const definition = getComponent(type);
          if (definition === null) {
            throw new Error(`画廊：组件未注册 ${type}`);
          }
          const fixture = COMPONENT_VARIANTS[type]?.[variant];
          if (fixture === undefined) {
            throw new Error(`画廊：缺少 ${type}/${variant} 变体`);
          }
          const props = definition.inputSchema.parse(fixture.props);
          const context = sceneRenderContextSchema.parse({
            frame: 15,
            fps: 30,
            durationMs: fixture.durationMs,
            width: 1920,
            height: 1080,
            aspectRatio: '16:9',
          });
          const Renderer = definition.renderer;
          return (
            <div key={type} style={{ position: 'relative', overflow: 'hidden', border: '1px solid #FFFFFF22', borderRadius: 8 }}>
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: 1920,
                  height: 1080,
                  transform: 'scale(0.2)',
                  transformOrigin: 'top left',
                }}
              >
                <SceneThemeProvider>
                  <Renderer props={props as never} context={context} />
                </SceneThemeProvider>
              </div>
              <div
                style={{
                  position: 'absolute',
                  bottom: 0,
                  left: 0,
                  right: 0,
                  padding: '4px 8px',
                  fontSize: 16,
                  backgroundColor: '#000000AA',
                  display: 'flex',
                  justifyContent: 'space-between',
                }}
              >
                <span>{type}</span>
                <span style={{ opacity: 0.7 }}>v{definition.version}</span>
              </div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
}

export const GALLERY_DEFAULT_PROPS: ComponentGalleryProps = { variant: 'normal', group: 'standard' };
export const EXTENDED_GALLERY_DEFAULT_PROPS: ComponentGalleryProps = { variant: 'normal', group: 'extended' };
