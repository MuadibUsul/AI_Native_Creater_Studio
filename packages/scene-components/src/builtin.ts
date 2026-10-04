import { aiVideoComponent } from './components/ai-video.js';
import { bigNumberComponent } from './components/big-number.js';
import {
  barChartComponent,
  dualLineChartComponent,
  kpiGridComponent,
  lineChartComponent,
  spreadAreaChartComponent,
} from './components/charts.js';
import { causalFlowComponent, causalLoopComponent, mapStaticComponent } from './components/diagrams.js';
import {
  hostFullComponent,
  hostSideComponent,
  imageFullComponent,
  realBrollComponent,
} from './components/media.js';
import {
  chapterTitleComponent,
  documentHighlightComponent,
  newsHeadlineComponent,
  quoteCardComponent,
  sourceCardComponent,
  summaryComponent,
  timelineComponent,
} from './components/panels.js';
import { registerComponent } from './registry.js';
import type { ComponentDefinition } from './protocol.js';

/**
 * 内置标准组件注册（P05-02：V1 标准 20 类，DEC-04 全覆盖）。
 * 幂等：重复调用不会重复注册。
 */

let registered = false;

export function registerBuiltInComponents(): void {
  if (registered) return;
  for (const component of [
    // 扩展场景类型（DEC-04：AI_VIDEO 属 P06 交付，不计入 20 类标准清单）
    aiVideoComponent,
    // Host
    hostFullComponent,
    hostSideComponent,
    // Numbers / KPI
    bigNumberComponent,
    kpiGridComponent,
    // Charts
    lineChartComponent,
    dualLineChartComponent,
    barChartComponent,
    spreadAreaChartComponent,
    // Time / Diagrams
    timelineComponent,
    causalFlowComponent,
    causalLoopComponent,
    mapStaticComponent,
    // Evidence
    newsHeadlineComponent,
    sourceCardComponent,
    quoteCardComponent,
    documentHighlightComponent,
    // Media
    imageFullComponent,
    realBrollComponent,
    // Structure
    chapterTitleComponent,
    summaryComponent,
  ]) {
    // 注册表为类型擦除视图（见 registry.ts 注释）：props 类型由各组件 schema 在渲染边界保证
    registerComponent(component as unknown as ComponentDefinition<unknown>);
  }
  registered = true;
}

/** 仅测试使用：允许在清空注册表后重新装配内置组件。 */
export function resetBuiltInFlagForTesting(): void {
  registered = false;
}
