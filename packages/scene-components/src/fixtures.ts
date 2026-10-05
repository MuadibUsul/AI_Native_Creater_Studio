import { STANDARD_SCENE_TYPES } from '@ancs/contracts';

/**
 * 组件验收 fixtures（P05-02）：每个标准组件覆盖五类输入——
 * **正常 / 长文本 / 空值 / 极值 / 边界时长**（验收要求"均有截图或渲染证据"）。
 *
 * - normal 直接复用组件自身的 `previewFixture`（协议字段，单一事实来源）；
 * - longText 放大文本类字段（验证字号自适应，不裁切）；
 * - empty 清空数据（验证**占位而非编造**，§10.3）；
 * - extreme 使用数值/规模极值（验证原样呈现，不做换算与平滑）；
 * - boundary 使用组件的最小允许时长（渲染证据取最短边界；测试同时断言最大边界合法）。
 *
 * 本模块只是**测试/画廊数据**：不是业务默认值，也不会写入任何 Scene。
 */

export type ComponentVariantName = 'normal' | 'longText' | 'empty' | 'extreme' | 'boundary';

export interface ComponentVariantFixture {
  props: Record<string, unknown>;
  durationMs: number;
  note: string;
}

export const COMPONENT_VARIANT_NAMES: readonly ComponentVariantName[] = ['normal', 'longText', 'empty', 'extreme', 'boundary'];

const LONG = '这是用于验证长文本排版的自适应测试内容，包含中英文混排 Mixed Content 与标点，重复出现以模拟超长段落的情况下仍应保持可读、不裁切、不吞掉关键信息。';
const long = (times: number): string => LONG.repeat(times);

const points = (values: [string, number][]): { t: string; v: number }[] => values.map(([t, v]) => ({ t, v }));

/** 每个标准组件的五类变体（props 为未校验输入，渲染前必过组件自身 inputSchema）。 */
export const COMPONENT_VARIANTS: Readonly<Record<string, Record<ComponentVariantName, ComponentVariantFixture>>> = {
  HOST_FULL: {
    normal: { props: { assetId: 'ast_host', assetUrl: null, lines: '利率为什么决定一切？', presenterName: '主播甲' }, durationMs: 6000, note: '正常' },
    longText: { props: { assetId: 'ast_host', assetUrl: null, lines: long(6), presenterName: '主播甲' }, durationMs: 6000, note: '长文本' },
    empty: { props: {}, durationMs: 6000, note: '空值：未绑定素材与口播' },
    extreme: { props: { assetId: 'ast_host', assetUrl: null, lines: '一', presenterName: '名'.repeat(60) }, durationMs: 6000, note: '极值：单字口播 + 最长姓名' },
    boundary: { props: { assetId: 'ast_host', assetUrl: null, lines: '短。', presenterName: null }, durationMs: 2000, note: '边界：最小时长' },
  },
  HOST_SIDE: {
    normal: { props: { side: 'LEFT', lines: '先看结论：利率路径取决于通胀。', presenterName: '主播甲' }, durationMs: 7000, note: '正常' },
    longText: { props: { side: 'RIGHT', lines: long(6), presenterName: '主播甲' }, durationMs: 7000, note: '长文本' },
    empty: { props: {}, durationMs: 7000, note: '空值' },
    extreme: { props: { side: 'RIGHT', lines: long(2) }, durationMs: 7000, note: '极值：最多字符' },
    boundary: { props: { side: 'LEFT', lines: '短。' }, durationMs: 2000, note: '边界：最小时长' },
  },
  BIG_NUMBER: {
    normal: { props: { value: '5.25%', label: '联邦基金利率', direction: 'FLAT', sourceLabel: '示例数据集' }, durationMs: 6000, note: '正常' },
    longText: { props: { value: '5.25%', label: '这是一个非常非常长的指标名称用于测试超长标签在字号自适应下仍然完整可读不会溢出画面边界的情况', direction: 'FLAT', sourceLabel: '示例数据集' }, durationMs: 6000, note: '长文本标签' },
    empty: { props: {}, durationMs: 6000, note: '空值：无数据 → 占位' },
    extreme: { props: { value: '-1,234,567,890.12万亿元', label: '极端量级', direction: 'DOWN', sourceLabel: '示例' }, durationMs: 6000, note: '极值：最大量级与负向' },
    boundary: { props: { value: '0', label: '边界' }, durationMs: 1500, note: '边界：最小时长' },
  },
  KPI_GRID: {
    normal: { props: { title: '三项关键指标', items: [ { label: '联邦基金利率', value: '5.25%', direction: 'FLAT' }, { label: '同比通胀', value: '2.8%', direction: 'DOWN' }, { label: '失业率', value: '4.2%', direction: 'UP' } ], sourceLabel: '示例数据集' }, durationMs: 9000, note: '正常' },
    longText: { props: { title: '超长标题用于验证网格上方标题的自适应排布能力与换行策略', items: [ { label: '指标一'.repeat(6), value: '5.25%', direction: null }, { label: '指标二', value: '2.8%', direction: null } ] }, durationMs: 9000, note: '长文本' },
    empty: { props: { items: [] }, durationMs: 9000, note: '空值：无指标 → 占位' },
    extreme: { props: { title: '极值', items: [ { label: '极大', value: '999,999,999.99%', direction: 'UP' }, { label: '极小', value: '-0.000001%', direction: 'DOWN' }, { label: '缺失', value: null, direction: null } ] }, durationMs: 9000, note: '极值：超大/超小/缺失' },
    boundary: { props: { items: [ { label: '单项', value: '1' , direction: null } ] }, durationMs: 3000, note: '边界：最小时长' },
  },
  LINE_CHART: {
    normal: { props: { title: '联邦基金利率路径', unit: '%', series: [{ name: '利率', points: points([['2023', 4.5], ['2024', 5.25], ['2025', 4.0]]) }], sourceLabel: '示例数据集' }, durationMs: 8000, note: '正常：3 点' },
    longText: { props: { title: '这是一个非常长的图表标题用于验证标题区排版在极限长度下依然可控不会挤压绘图区域的情况', unit: '%', series: [{ name: '利率', points: points([['2023', 4.5], ['2024', 5.25], ['2025', 4.0]]) }] }, durationMs: 8000, note: '长标题' },
    empty: { props: { series: [] }, durationMs: 8000, note: '空值：无序列 → 占位' },
    extreme: { props: { title: '密集与极值', unit: '%', series: [{ name: '利率', points: points(Array.from({ length: 24 }, (_, index) => [`M${String(index + 1)}`, -5000 + index * 800] as [string, number])) }] }, durationMs: 8000, note: '极值：24 点 + 大范围' },
    boundary: { props: { series: [{ name: '两', points: points([['A', 1], ['B', 2]]) }] }, durationMs: 3000, note: '边界：最小时长 + 2 点' },
  },
  DUAL_LINE_CHART: {
    normal: { props: { title: '利率与通胀', unit: '%', series: [{ name: '利率', points: points([['2023', 4.5], ['2024', 5.25], ['2025', 4.0]]) }, { name: '通胀', points: points([['2023', 4.1], ['2024', 2.8], ['2025', 2.4]]) }], sourceLabel: '示例数据集' }, durationMs: 8000, note: '正常：双序列' },
    longText: { props: { title: '两条非常长的序列名称用于验证图例排版的极限情况', unit: '%', series: [{ name: '利率与政策路径的长期观察序列', points: points([['2023', 4.5], ['2024', 5.25]]) }, { name: '核心通胀的长期观察序列', points: points([['2023', 4.1], ['2024', 2.8]]) }] }, durationMs: 8000, note: '长文本：图例' },
    empty: { props: { series: [] }, durationMs: 8000, note: '空值' },
    extreme: { props: { title: '极值', unit: '', series: [{ name: 'A', points: points([['x', -10000000], ['y', 10000000]]) }, { name: 'B', points: points([['x', 0], ['y', 0]]) }] }, durationMs: 8000, note: '极值：对称极值 + 全平单点' },
    boundary: { props: { series: [{ name: 'A', points: points([['a', 1], ['b', 2]]) }] }, durationMs: 3000, note: '边界：最小时长' },
  },
  BAR_CHART: {
    normal: { props: { title: '各机构预测降息幅度', unit: 'bp', series: [{ name: '预测', points: points([['A 银行', 50], ['B 银行', 75], ['C 银行', 25], ['D 银行', 100]]) }], sourceLabel: '示例数据集' }, durationMs: 8000, note: '正常：4 类' },
    longText: { props: { title: '超长标题'.repeat(8), unit: 'bp', series: [{ name: '预测', points: points([['一个非常长的类别名称用于测试横轴标签的极限', 50], ['另一个同样很长的类别名称', 75]]) }] }, durationMs: 8000, note: '长文本：类别标签' },
    empty: { props: { series: [] }, durationMs: 8000, note: '空值' },
    extreme: { props: { title: '极值', unit: 'bp', series: [{ name: '预测', points: points([['负值', -1250], ['巨大', 999999]]) }] }, durationMs: 8000, note: '极值：负值与巨大值' },
    boundary: { props: { series: [{ name: 'A', points: points([['x', 1]]) }] }, durationMs: 3000, note: '边界：最小时长 + 1 类' },
  },
  SPREAD_AREA_CHART: {
    normal: { props: { title: '10 年期利差', unit: '%', series: [{ name: '美国', points: points([['2023', 3.9], ['2024', 4.5], ['2025', 4.2]]) }, { name: '德国', points: points([['2023', 2.3], ['2024', 2.4], ['2025', 2.5]]) }], sourceLabel: '示例数据集' }, durationMs: 8000, note: '正常：利差面积' },
    longText: { props: { title: '长标题'.repeat(10), unit: '%', series: [{ name: 'A 序列', points: points([['2023', 3.9], ['2024', 4.5]]) }, { name: 'B 序列', points: points([['2023', 2.3], ['2024', 2.4]]) }] }, durationMs: 8000, note: '长标题' },
    empty: { props: { series: [] }, durationMs: 8000, note: '空值' },
    extreme: { props: { unit: '%', series: [{ name: 'A', points: points([['a', 10000], ['b', -10000]]) }, { name: 'B', points: points([['a', -10000], ['b', 10000]]) }] }, durationMs: 8000, note: '极值：反向交叉' },
    boundary: { props: { series: [{ name: 'A', points: points([['a', 1], ['b', 2]]) }, { name: 'B', points: points([['a', 1], ['b', 1]]) }] }, durationMs: 3000, note: '边界：最小时长' },
  },
  TIMELINE: {
    normal: { props: { title: '政策路径回顾', events: [ { date: '2023-07', description: '加息至 5.25%' }, { date: '2024-09', description: '首次降息 50bp' }, { date: '2025-06', description: '维持利率不变' } ], sourceLabel: '示例数据集' }, durationMs: 9000, note: '正常：3 事件' },
    longText: { props: { title: '长文本时间线', events: [ { date: '2023-07-26', description: long(2) }, { date: '2024-09-18', description: long(2) } ] }, durationMs: 9000, note: '长文本：事件描述' },
    empty: { props: { events: [] }, durationMs: 9000, note: '空值：无事件 → 占位' },
    extreme: { props: { title: '密集时间线', events: Array.from({ length: 8 }, (_, index) => ({ date: `202${String(index % 6)}-0${String((index % 9) + 1)}`, description: `事件 ${String(index + 1)}` })) }, durationMs: 9000, note: '极值：8 事件' },
    boundary: { props: { events: [{ date: '2026', description: '单事件' }] }, durationMs: 3000, note: '边界：最小时长' },
  },
  CAUSAL_FLOW: {
    normal: { props: { title: '通胀为什么会回落', steps: ['供给修复', '需求降温', '通胀回落'], sourceLabel: '示例分析' }, durationMs: 8000, note: '正常：3 步' },
    longText: { props: { steps: [long(1), long(1)] }, durationMs: 8000, note: '长文本：节点文本' },
    empty: { props: { steps: [] }, durationMs: 8000, note: '空值：无链 → 占位' },
    extreme: { props: { title: '长链', steps: Array.from({ length: 7 }, (_, index) => `节点${String(index + 1)}`) }, durationMs: 8000, note: '极值：7 节点换行' },
    boundary: { props: { steps: ['单步'] }, durationMs: 3000, note: '边界：最小时长' },
  },
  CAUSAL_LOOP: {
    normal: { props: { title: '通胀螺旋', nodes: ['工资上涨', '物价上升', '预期上修', '工资再涨'], loopLabel: '自我强化' }, durationMs: 8000, note: '正常：4 节点' },
    longText: { props: { title: '长文本闭环', nodes: [long(1), '短节点'.repeat(4), 'A', 'B'] }, durationMs: 8000, note: '长文本：节点截断保护' },
    empty: { props: { nodes: [] }, durationMs: 8000, note: '空值' },
    extreme: { props: { nodes: Array.from({ length: 8 }, (_, index) => `N${String(index + 1)}`), loopLabel: '密集' }, durationMs: 8000, note: '极值：8 节点' },
    boundary: { props: { nodes: ['单节点'] }, durationMs: 3000, note: '边界：最小时长' },
  },
  MAP_STATIC: {
    normal: { props: { title: '三大贸易伙伴', regions: [ { label: '美国', x: 0.18, y: 0.42 }, { label: '欧盟', x: 0.52, y: 0.3 }, { label: '东盟', x: 0.76, y: 0.66 } ], sourceLabel: '示例分析' }, durationMs: 8000, note: '正常：3 区域' },
    longText: { props: { title: '长文本地图', regions: [ { label: '一个非常长的区域名称用于测试标注的极限', x: 0.5, y: 0.5, note: long(1) } ] }, durationMs: 8000, note: '长文本：标注' },
    empty: { props: { regions: [] }, durationMs: 8000, note: '空值：无位置 → 占位' },
    extreme: { props: { regions: [ { label: '左上', x: 0, y: 0 }, { label: '右下', x: 1, y: 1 }, { label: '中', x: 0.5, y: 0.5 } ] }, durationMs: 8000, note: '极值：边界位置' },
    boundary: { props: { regions: [{ label: '单点', x: 0.01, y: 0.01 }] }, durationMs: 3000, note: '边界：最小时长' },
  },
  NEWS_HEADLINE: {
    normal: { props: { headline: '美联储维持联邦基金利率不变', outlet: '示例财经日报', publishedAt: '2026-10-01', sourceLabel: 'news.example/rates' }, durationMs: 6000, note: '正常' },
    longText: { props: { headline: long(2), outlet: '示例财经日报' }, durationMs: 6000, note: '长文本：标题' },
    empty: { props: { headline: '' }, durationMs: 6000, note: '空值：无标题 → 占位' },
    extreme: { props: { headline: '超'.repeat(120), outlet: '名'.repeat(80) }, durationMs: 6000, note: '极值：最大长度' },
    boundary: { props: { headline: '短标题' }, durationMs: 2500, note: '边界：最小时长' },
  },
  SOURCE_CARD: {
    normal: { props: { title: '美联储利率决议原文', url: 'news.example/rates/2026-10', publishedAt: '2026-10-01', excerpt: '联邦基金利率目标区间维持不变。' }, durationMs: 7000, note: '正常' },
    longText: { props: { title: long(2), url: 'news.example/'.concat('very-long-path/'.repeat(6)), excerpt: long(2) }, durationMs: 7000, note: '长文本' },
    empty: { props: {}, durationMs: 7000, note: '空值：无来源信息' },
    extreme: { props: { title: '标题'.repeat(30), url: 'https://'.concat('a'.repeat(250)) }, durationMs: 7000, note: '极值：超长 URL' },
    boundary: { props: { title: '来源' }, durationMs: 2500, note: '边界：最小时长' },
  },
  QUOTE_CARD: {
    normal: { props: { quote: '通胀压力已经明显缓解。', attribution: '示例分析师', sourceLabel: 'news.example/rates' }, durationMs: 6000, note: '正常' },
    longText: { props: { quote: long(3), attribution: '示例分析师' }, durationMs: 6000, note: '长文本：引文' },
    empty: { props: { quote: '' }, durationMs: 6000, note: '空值：无引文 → 占位' },
    extreme: { props: { quote: '引'.repeat(400), attribution: '名'.repeat(120) }, durationMs: 6000, note: '极值：最大长度' },
    boundary: { props: { quote: '短引文' }, durationMs: 2500, note: '边界：最小时长' },
  },
  DOCUMENT_HIGHLIGHT: {
    normal: { props: { documentTitle: '利率周报', highlightedText: '分析师预计 2025 年可能降息 2 个百分点。', sourceLabel: 'news.example/rates' }, durationMs: 7000, note: '正常' },
    longText: { props: { documentTitle: '长文档', highlightedText: long(3) }, durationMs: 7000, note: '长文本：高亮段' },
    empty: { props: { highlightedText: '' }, durationMs: 7000, note: '空值：无高亮 → 占位' },
    extreme: { props: { documentTitle: '标题'.repeat(20), highlightedText: '字'.repeat(400) }, durationMs: 7000, note: '极值：最大长度' },
    boundary: { props: { highlightedText: '短。' }, durationMs: 2500, note: '边界：最小时长' },
  },
  IMAGE_FULL: {
    normal: { props: { assetId: 'ast_image', assetUrl: null, headline: '利率与通胀的关系' }, durationMs: 6000, note: '占位路径（未绑定素材）' },
    longText: { props: { assetId: 'ast_image', assetUrl: null, headline: long(1) }, durationMs: 6000, note: '长文本：压字标题' },
    empty: { props: {}, durationMs: 6000, note: '空值：无素材 → 占位' },
    extreme: { props: { assetId: 'ast_image', assetUrl: null, caption: '注'.repeat(200) }, durationMs: 6000, note: '极值：最长标注' },
    boundary: { props: { assetId: 'ast_image', assetUrl: null }, durationMs: 2000, note: '边界：最小时长' },
  },
  REAL_BROLL: {
    normal: { props: { assetId: 'ast_broll', assetUrl: null, footageCredit: '示例素材库' }, durationMs: 6000, note: '占位路径（未导入素材）' },
    longText: { props: { assetId: 'ast_broll', assetUrl: null, footageCredit: '素'.repeat(160), caption: long(1) }, durationMs: 6000, note: '长文本：出处' },
    empty: { props: {}, durationMs: 6000, note: '空值：无素材 → 占位（不得 AI 冒充）' },
    extreme: { props: { assetId: 'ast_broll', assetUrl: null, caption: '标'.repeat(200) }, durationMs: 6000, note: '极值：最长标注' },
    boundary: { props: { assetId: 'ast_broll', assetUrl: null }, durationMs: 2000, note: '边界：最小时长' },
  },
  CHAPTER_TITLE: {
    normal: { props: { title: '开场与核心事实', subtitle: '利率为什么决定一切', index: 1 }, durationMs: 2500, note: '正常' },
    longText: { props: { title: '超长章节标题'.repeat(6), subtitle: long(1), index: 12 }, durationMs: 2500, note: '长文本' },
    empty: { props: { title: '' }, durationMs: 2500, note: '空值：未命名章节' },
    extreme: { props: { title: '标'.repeat(80), index: 99 }, durationMs: 2500, note: '极值：最长标题' },
    boundary: { props: { title: '章' }, durationMs: 1500, note: '边界：最小时长' },
  },
  SUMMARY: {
    normal: { props: { title: '三个观察变量', points: ['通胀路径决定降息节奏', '期限利差尚未倒挂修复', '就业数据是下一步关键'] }, durationMs: 9000, note: '正常：3 条' },
    longText: { props: { title: '长文本小结', points: [long(2), long(2)] }, durationMs: 9000, note: '长文本：要点' },
    empty: { props: { points: [] }, durationMs: 9000, note: '空值：无要点 → 占位' },
    extreme: { props: { title: '密集', points: Array.from({ length: 6 }, (_, index) => `要点 ${String(index + 1)}：${'内容'.repeat(20)}`) }, durationMs: 9000, note: '极值：6 条长要点' },
    boundary: { props: { points: ['单要点'] }, durationMs: 2500, note: '边界：最小时长' },
  },
};

/** 完整性：全部 V1 标准类型必须有五类变体（缺失即抛出，防止静默漏测）。 */
export function assertVariantCoverage(): void {
  for (const type of STANDARD_SCENE_TYPES) {
    const variants = COMPONENT_VARIANTS[type];
    if (variants === undefined) throw new Error(`组件 ${type} 缺少变体 fixtures`);
    for (const name of COMPONENT_VARIANT_NAMES) {
      if (variants[name] === undefined) throw new Error(`组件 ${type} 缺少 ${name} 变体`);
    }
  }
}

/* ---------- P10-04 扩展组件五类变体（正常/长文本/空值/极值/边界时长） ---------- */

const EXT_LONG = '这是一个用于验证超长文本在扩展组件中仍保持可读、不裁切、不吞信息的中英文混排测试内容 Mixed Content，重复出现以模拟极端段落长度。';
const extLong = (times: number): string => EXT_LONG.repeat(times);

Object.assign(COMPONENT_VARIANTS as Record<string, Record<ComponentVariantName, ComponentVariantFixture>>, {
  AREA_CHART: {
    normal: { props: { title: '累计订阅数', unit: '万', series: [{ name: '订阅数', points: [{ t: '2024', v: 12 }, { t: '2025', v: 31 }] }], sourceLabel: '示例数据集' }, durationMs: 8000, note: '正常' },
    longText: { props: { title: extLong(2).slice(0, 120), unit: '万', series: [{ name: extLong(1).slice(0, 80), points: [{ t: '2024', v: 12 }, { t: '2025', v: 31 }] }], sourceLabel: '示例数据集' }, durationMs: 8000, note: '长文本标题/系列名' },
    empty: { props: {}, durationMs: 8000, note: '空值：无数据 → 占位' },
    extreme: { props: { title: '极值', unit: '万', series: [{ name: '订阅数', points: [{ t: '2024', v: 0 }, { t: '2025', v: 999999999 }] }] }, durationMs: 8000, note: '极值：0 与 10 亿级' },
    boundary: { props: { series: [{ name: '订阅数', points: [{ t: '2024', v: 12 }] }] }, durationMs: 3000, note: '边界：最小时长' },
  },
  STACKED_BAR_CHART: {
    normal: { props: { title: '收入结构', unit: '万', series: [{ name: '订阅', points: [{ t: '2024', v: 60 }, { t: '2025', v: 95 }] }, { name: '广告', points: [{ t: '2024', v: 25 }, { t: '2025', v: 38 }] }], sourceLabel: '示例数据集' }, durationMs: 9000, note: '正常' },
    longText: { props: { title: extLong(2).slice(0, 120), unit: '万', series: [{ name: extLong(1).slice(0, 80), points: [{ t: '2024', v: 60 }] }, { name: extLong(1).slice(0, 80), points: [{ t: '2024', v: 25 }] }] }, durationMs: 9000, note: '长文本系列名' },
    empty: { props: {}, durationMs: 9000, note: '空值：无数据 → 占位' },
    extreme: { props: { title: '极值', unit: '万', series: [{ name: 'A', points: [{ t: '2024', v: 999999 }, { t: '2025', v: 0 }] }, { name: 'B', points: [{ t: '2024', v: 0 }, { t: '2025', v: 999999 }] }] }, durationMs: 9000, note: '极值：百万级与 0' },
    boundary: { props: { series: [{ name: 'A', points: [{ t: '2024', v: 60 }] }], title: '单列' }, durationMs: 3000, note: '边界：最小时长' },
  },
  NUMBER_COMPARE: {
    normal: { props: { title: '季度收入对比', items: [{ label: 'Q1', value: 120, unit: '万' }, { label: 'Q2', value: 158, unit: '万' }], layout: 'row', highlightIndex: 1, sourceLabel: '示例数据集' }, durationMs: 7000, note: '正常' },
    longText: { props: { title: extLong(2).slice(0, 120), items: [{ label: extLong(1).slice(0, 60), value: 120, unit: '万' }, { label: 'Q2', value: 158, unit: '万' }], layout: 'column' }, durationMs: 7000, note: '长文本标签 + column 布局' },
    empty: { props: {}, durationMs: 7000, note: '空值：无对比项 → 占位' },
    extreme: { props: { title: '极值', items: [{ label: '最大', value: 999999999, unit: '万' }, { label: '最小', value: 0, unit: '万' }, { label: '负值', value: -12345, unit: '万' }, { label: '极小', value: 0.01, unit: '万' }], layout: 'row' }, durationMs: 7000, note: '极值：四项（最大/0/负/小数）' },
    boundary: { props: { items: [{ label: 'A', value: 1 }, { label: 'B', value: 2 }] }, durationMs: 2500, note: '边界：最小时长' },
  },
  PERCENT_DELTA: {
    normal: { props: { label: '订阅收入', valuePercent: 32.5, comparison: '同比 2025', sourceLabel: '示例数据集' }, durationMs: 5000, note: '正常：+32.5%' },
    longText: { props: { label: extLong(1).slice(0, 80), valuePercent: 32.5, comparison: extLong(1).slice(0, 60) }, durationMs: 5000, note: '长文本标签/口径' },
    empty: { props: {}, durationMs: 5000, note: '空值：无指标 → 占位' },
    extreme: { props: { label: '极端变化', valuePercent: -999.9, comparison: '历史最大回撤' }, durationMs: 5000, note: '极值：-999.9%' },
    boundary: { props: { label: '持平', valuePercent: 0 }, durationMs: 2000, note: '边界：最小时长 + 持平语义' },
  },
  HOST_PIP: {
    normal: { props: { presenterName: '林主播', position: 'bottom-right', scale: 0.32, stageNote: '主画面（数据看板）' }, durationMs: 8000, note: '正常：右下 PiP 占位' },
    longText: { props: { presenterName: extLong(1).slice(0, 60), stageNote: extLong(2).slice(0, 120) }, durationMs: 8000, note: '长文本姓名/主画面说明' },
    empty: { props: {}, durationMs: 8000, note: '空值：未绑定素材 → 占位' },
    extreme: { props: { presenterName: '名'.repeat(60), position: 'top-left', scale: 0.45, stageNote: '满占比' }, durationMs: 8000, note: '极值：最大占比 + 最长姓名' },
    boundary: { props: { position: 'bottom-left', scale: 0.2 }, durationMs: 3000, note: '边界：最小时长 + 最小占比' },
  },
  HOST_OVERLAY: {
    normal: { props: { name: '林主播', title: '财经评论员', align: 'left' }, durationMs: 6000, note: '正常' },
    longText: { props: { name: extLong(1).slice(0, 60), title: extLong(1).slice(0, 80), align: 'left' }, durationMs: 6000, note: '长文本姓名/头衔' },
    empty: { props: {}, durationMs: 6000, note: '空值：无姓名 → 占位' },
    extreme: { props: { name: '名'.repeat(60), title: '职'.repeat(80), align: 'center' }, durationMs: 6000, note: '极值：最长文本 + center 对齐' },
    boundary: { props: { name: '甲' }, durationMs: 2000, note: '边界：最小时长 + 最短姓名' },
  },
  PROCESS_FLOW: {
    normal: { props: { title: '内容生产流程', steps: [{ label: '取材', detail: '导入' }, { label: '叙事' }, { label: '渲染' }], layout: 'horizontal' }, durationMs: 9000, note: '正常：3 步横向' },
    longText: { props: { title: extLong(2).slice(0, 120), steps: [{ label: extLong(1).slice(0, 40) }, { label: 'B', detail: extLong(1).slice(0, 80) }], layout: 'vertical' }, durationMs: 9000, note: '长文本 + vertical 布局' },
    empty: { props: {}, durationMs: 9000, note: '空值：无步骤 → 占位' },
    extreme: { props: { title: '极值', steps: [{ label: '1' }, { label: '2' }, { label: '3' }, { label: '4' }, { label: '5' }, { label: '6' }], layout: 'horizontal' }, durationMs: 9000, note: '极值：6 步（上限）' },
    boundary: { props: { steps: [{ label: 'A' }, { label: 'B' }], layout: 'vertical' }, durationMs: 3500, note: '边界：最小时长 + 2 步' },
  },
  MAP_ZOOM: {
    normal: { props: { title: '重点区域', region: '华东', zoomLevel: 3, markers: [{ label: '上海', x: 0.6, y: 0.45 }], sourceLabel: '示例标注' }, durationMs: 7000, note: '正常：区域 + 1 标注' },
    longText: { props: { title: extLong(2).slice(0, 120), region: '区域名'.repeat(8).slice(0, 60), zoomLevel: 2, markers: [{ label: extLong(1).slice(0, 40), x: 0.5, y: 0.5 }] }, durationMs: 7000, note: '长文本区域/标注名' },
    empty: { props: {}, durationMs: 7000, note: '空值：无区域 → 占位' },
    extreme: { props: { title: '极值', region: '边界', zoomLevel: 4, markers: [{ label: 'A', x: 0, y: 0 }, { label: 'B', x: 1, y: 1 }, { label: 'C', x: 0.5, y: 0.5 }, { label: 'D', x: 0.25, y: 0.75 }, { label: 'E', x: 0.75, y: 0.25 }, { label: 'F', x: 0.1, y: 0.9 }] }, durationMs: 7000, note: '极值：最大档位 + 6 标注（含四角）' },
    boundary: { props: { region: '单点', zoomLevel: 1 }, durationMs: 3000, note: '边界：最小时长 + 最小档位' },
  },
  MAP_FLOW: {
    normal: { props: { title: '资金流向', from: { label: '香港', x: 0.68, y: 0.62 }, to: { label: '新加坡', x: 0.42, y: 0.78 }, flowLabel: '净流入', sourceLabel: '示例标注' }, durationMs: 7000, note: '正常：两点流向' },
    longText: { props: { title: extLong(2).slice(0, 120), from: { label: extLong(1).slice(0, 40), x: 0.7, y: 0.3 }, to: { label: extLong(1).slice(0, 40), x: 0.3, y: 0.7 }, flowLabel: extLong(1).slice(0, 60) }, durationMs: 7000, note: '长文本端点/流向说明' },
    empty: { props: {}, durationMs: 7000, note: '空值：未命名端点 → 占位' },
    extreme: { props: { title: '极端坐标', from: { label: '左上', x: 0, y: 0 }, to: { label: '右下', x: 1, y: 1 }, flowLabel: '对角' }, durationMs: 7000, note: '极值：对角（0,0 → 1,1）' },
    boundary: { props: { from: { label: 'A', x: 0.5, y: 0.4 }, to: { label: 'B', x: 0.5, y: 0.6 } }, durationMs: 3000, note: '边界：最小时长' },
  },
  PERSON_PROFILE: {
    normal: { props: { name: '林述', subtitle: '宏观研究员', facts: [{ label: '机构', value: '示例研究院' }, { label: '领域', value: '利率与汇率' }], sourceLabel: '示例资料' }, durationMs: 8000, note: '正常' },
    longText: { props: { name: extLong(1).slice(0, 60), subtitle: extLong(1).slice(0, 80), facts: [{ label: extLong(1).slice(0, 40), value: extLong(1).slice(0, 80) }] }, durationMs: 8000, note: '长文本姓名/事实' },
    empty: { props: {}, durationMs: 8000, note: '空值：无名称 → 占位' },
    extreme: { props: { name: '名'.repeat(60), facts: [{ label: 'L1', value: 'V1' }, { label: 'L2', value: 'V2' }, { label: 'L3', value: 'V3' }, { label: 'L4', value: 'V4' }, { label: 'L5', value: 'V5' }] }, durationMs: 8000, note: '极值：最长姓名 + 5 条事实（上限）' },
    boundary: { props: { name: '甲' }, durationMs: 3000, note: '边界：最小时长 + 无事实模板' },
  },
  COMPANY_PROFILE: {
    normal: { props: { name: '示例科技', subtitle: '云计算服务商', ticker: 'EXMPL', facts: [{ label: '成立', value: '2015' }], sourceLabel: '示例资料' }, durationMs: 8000, note: '正常' },
    longText: { props: { name: extLong(1).slice(0, 60), subtitle: extLong(1).slice(0, 80), ticker: 'LONGTICKER1234567890', facts: [{ label: extLong(1).slice(0, 40), value: extLong(1).slice(0, 80) }] }, durationMs: 8000, note: '长文本 + 最长 ticker' },
    empty: { props: {}, durationMs: 8000, note: '空值：无名称 → 占位' },
    extreme: { props: { name: '公'.repeat(60), ticker: 'T'.repeat(20), facts: [{ label: 'L1', value: 'V1' }, { label: 'L2', value: 'V2' }, { label: 'L3', value: 'V3' }, { label: 'L4', value: 'V4' }, { label: 'L5', value: 'V5' }] }, durationMs: 8000, note: '极值：上限字段' },
    boundary: { props: { name: '甲' }, durationMs: 3000, note: '边界：最小时长' },
  },
  COUNTRY_PROFILE: {
    normal: { props: { name: '示例国', subtitle: '亚太经济体', regionCode: 'EX', facts: [{ label: '货币', value: 'EXD' }], sourceLabel: '示例资料' }, durationMs: 8000, note: '正常' },
    longText: { props: { name: extLong(1).slice(0, 60), subtitle: extLong(1).slice(0, 80), regionCode: 'EX-LONG-CODE', facts: [{ label: extLong(1).slice(0, 40), value: extLong(1).slice(0, 80) }] }, durationMs: 8000, note: '长文本 + 长区域码' },
    empty: { props: {}, durationMs: 8000, note: '空值：无名称 → 占位' },
    extreme: { props: { name: '国'.repeat(60), regionCode: 'CODE-1234567', facts: [{ label: 'L1', value: 'V1' }, { label: 'L2', value: 'V2' }, { label: 'L3', value: 'V3' }, { label: 'L4', value: 'V4' }, { label: 'L5', value: 'V5' }] }, durationMs: 8000, note: '极值：上限字段' },
    boundary: { props: { name: '甲' }, durationMs: 3000, note: '边界：最小时长' },
  },
  LOGO_WALL: {
    normal: { props: { title: '合作机构', logos: [{ name: '示例银行' }, { name: '示例基金' }, { name: '示例保险' }, { name: '示例证券' }], columns: 4, sourceLabel: '示例名单' }, durationMs: 6000, note: '正常：4 项 × 4 列' },
    longText: { props: { title: extLong(2).slice(0, 120), logos: [{ name: extLong(1).slice(0, 40) }, { name: extLong(1).slice(0, 40) }], columns: 2 }, durationMs: 6000, note: '长文本名称 + 2 列' },
    empty: { props: {}, durationMs: 6000, note: '空值：无名称 → 占位' },
    extreme: { props: { title: '极值', logos: Array.from({ length: 24 }, (_value, index) => ({ name: `机构${String(index + 1)}` })), columns: 6 }, durationMs: 6000, note: '极值：24 项（上限）× 6 列' },
    boundary: { props: { logos: [{ name: '甲' }, { name: '乙' }], columns: 2 }, durationMs: 2500, note: '边界：最小时长 + 2 项' },
  },
});

Object.assign(COMPONENT_VARIANTS as Record<string, Record<ComponentVariantName, ComponentVariantFixture>>, {
  COMPARE_SPLIT: {
    normal: { props: { title: '方案对比', left: { label: '方案 A', value: '成本优先', bullets: ['上线快'] }, right: { label: '方案 B', value: '质量优先', bullets: ['覆盖广'] }, sourceLabel: '示例资料' }, durationMs: 8000, note: '正常' },
    longText: { props: { title: extLong(2).slice(0, 120), left: { label: extLong(1).slice(0, 40), value: extLong(1).slice(0, 40), bullets: [extLong(1).slice(0, 80)] }, right: { label: extLong(1).slice(0, 40), value: '', bullets: [extLong(1).slice(0, 80)] } }, durationMs: 8000, note: '长文本两栏' },
    empty: { props: {}, durationMs: 8000, note: '空值：两栏为空 → 占位' },
    extreme: { props: { title: '极值', left: { label: '左'.repeat(40), value: 'V'.repeat(40), bullets: ['1', '2', '3', '4', '5', '6'] }, right: { label: '右'.repeat(40), value: 'W'.repeat(40), bullets: ['1', '2', '3', '4', '5', '6'] } }, durationMs: 8000, note: '极值：上限字段（40 字 + 6 条）' },
    boundary: { props: { left: { label: 'A' }, right: { label: 'B' } }, durationMs: 3000, note: '边界：最小时长 + 单标签空栏' },
  },
});
