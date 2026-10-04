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
export { bigNumberComponent, bigNumberPropsSchema, BigNumberScene } from './components/big-number.js';
export type { BigNumberProps } from './components/big-number.js';
export {
  componentCatalog,
  getComponent,
  listComponents,
  missingStandardComponents,
  registerComponent,
  resetRegistryForTesting,
} from './registry.js';
export { registerBuiltInComponents, resetBuiltInFlagForTesting } from './builtin.js';

// 内置标准组件随包装配（P05-01：BIG_NUMBER；P05-02 扩容至 20 类）。
import { registerBuiltInComponents } from './builtin.js';

registerBuiltInComponents();
