export {
  defineComponent,
  durationStatus,
  resolveSceneProps,
  toCatalogEntry,
  validateComponentDefinition,
} from './protocol.js';
export type {
  ComponentDefinition,
  ComponentRenderInput,
  ComponentValidationResult,
  DurationStatus,
  ScenePropsResolution,
} from './protocol.js';
export { SceneThemeProvider, stageStyle, useSceneTheme } from './theme.js';
export type { SceneThemeProviderProps } from './theme.js';
export { aiVideoComponent, aiVideoPropsSchema, AiVideoScene } from './components/ai-video.js';
export type { AiVideoProps } from './components/ai-video.js';
export { bigNumberComponent, bigNumberPropsSchema, BigNumberScene } from './components/big-number.js';
export type { BigNumberProps } from './components/big-number.js';
export {
  barChartComponent,
  barChartPropsSchema,
  dualLineChartComponent,
  dualLineChartPropsSchema,
  kpiGridComponent,
  kpiGridPropsSchema,
  lineChartComponent,
  lineChartPropsSchema,
  spreadAreaChartComponent,
  spreadAreaChartPropsSchema,
} from './components/charts.js';
export {
  causalFlowComponent,
  causalFlowPropsSchema,
  causalLoopComponent,
  causalLoopPropsSchema,
  mapStaticComponent,
  mapStaticPropsSchema,
} from './components/diagrams.js';
export {
  hostFullComponent,
  hostFullPropsSchema,
  hostSideComponent,
  hostSidePropsSchema,
  imageFullComponent,
  imageFullPropsSchema,
  realBrollComponent,
  realBrollPropsSchema,
} from './components/media.js';
export {
  chapterTitleComponent,
  chapterTitlePropsSchema,
  documentHighlightComponent,
  documentHighlightPropsSchema,
  newsHeadlineComponent,
  newsHeadlinePropsSchema,
  quoteCardComponent,
  quoteCardPropsSchema,
  sourceCardComponent,
  sourceCardPropsSchema,
  summaryComponent,
  summaryPropsSchema,
  timelineComponent,
  timelinePropsSchema,
} from './components/panels.js';
export { BodyText, CardShell, fitFontSize, Headline, Kicker, Placeholder, SceneRoot, SourceLabel } from './primitives.js';
export { ChartFrame } from './charts.js';
export type { ChartPoint, ChartSeries, ChartFrameProps } from './charts.js';
export {
  componentCatalog,
  getComponent,
  listComponents,
  missingStandardComponents,
  registerComponent,
  resetRegistryForTesting,
} from './registry.js';
export { registerBuiltInComponents, resetBuiltInFlagForTesting } from './builtin.js';
export { assertVariantCoverage, COMPONENT_VARIANTS, COMPONENT_VARIANT_NAMES } from './fixtures.js';
export type { ComponentVariantFixture, ComponentVariantName } from './fixtures.js';

// 内置标准组件随包装配（P05-01：BIG_NUMBER；P05-02 扩容至 20 类）。
import { registerBuiltInComponents } from './builtin.js';

registerBuiltInComponents();
