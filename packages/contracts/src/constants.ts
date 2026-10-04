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
