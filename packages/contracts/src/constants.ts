/**
 * 契约级常量（跨 API / SDK / Web / Worker 共享，禁止各自复制）。
 */

/** 对外统一 API 前缀（DEC-01：不维护两套业务路由）。 */
export const API_PREFIX = '/api/v1';

/** V1 默认输出格式（计划 §1.2：16:9 / 1920×1080 / 30fps）。 */
export const V1_DEFAULT_FORMAT = {
  width: 1920,
  height: 1080,
  fps: 30,
  aspectRatio: '16:9',
} as const;

/** V1 交付的 20 个标准场景类型（DEC-04）；A_VIDEO/CUSTOM_MOTION 属外部资产/生成场景，另有验收。 */
export const STANDARD_SCENE_TYPES = [
  'HOST_FULL',
  'HOST_SIDE',
  'BIG_NUMBER',
  'KPI_GRID',
  'LINE_CHART',
  'DUAL_LINE_CHART',
  'BAR_CHART',
  'SPREAD_AREA_CHART',
  'TIMELINE',
  'CAUSAL_FLOW',
  'CAUSAL_LOOP',
  'MAP_STATIC',
  'NEWS_HEADLINE',
  'SOURCE_CARD',
  'QUOTE_CARD',
  'DOCUMENT_HIGHLIGHT',
  'IMAGE_FULL',
  'REAL_BROLL',
  'CHAPTER_TITLE',
  'SUMMARY',
] as const;

/**
 * P10-04 扩展场景类型（§10.2 补全；不改动 DEC-04 的 V1 20 类基线）：
 * Host 变体 / 数值对比 / 面积·堆叠图 / 流程 / 地图缩放·流向 / 实体档案与布局变体。
 */
export const EXTENDED_SCENE_TYPES = [
  'HOST_PIP',
  'HOST_OVERLAY',
  'NUMBER_COMPARE',
  'PERCENT_DELTA',
  'AREA_CHART',
  'STACKED_BAR_CHART',
  'PROCESS_FLOW',
  'COMPARE_SPLIT',
  'MAP_ZOOM',
  'MAP_FLOW',
  'PERSON_PROFILE',
  'COMPANY_PROFILE',
  'COUNTRY_PROFILE',
  'LOGO_WALL',
] as const;

/** 全部内置组件类型（标准 20 类 + 扩展；注册表应为全集的超集）。 */
export const BUILTIN_SCENE_TYPES = [...STANDARD_SCENE_TYPES, ...EXTENDED_SCENE_TYPES] as const;
