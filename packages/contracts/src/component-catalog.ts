import { z } from 'zod';

/**
 * 内置组件目录快照（P10-06 / §62：工作区搜索的 COMPONENT 维度）。
 * **与 scene-components 注册表的一致性由漂移测试锁定**（packages/scene-components/src/registry.test.ts：
 * BUILTIN_COMPONENT_CATALOG 必须等于 componentCatalog() 投影——任何组件变更若未同步此表即 CI 失败）。
 * 原因：apps/api 的依赖白名单（R7）不含 scene-components（含 React），目录数据必须经 contracts 抵达服务端。
 */
export const BUILTIN_COMPONENT_CATALOG = [
  { type: 'AI_VIDEO', title: 'AI 视频场景', description: 'AI 生成的视频画面（资产驱动；未生成时明确占位并提示显式生成；含 AI 生成标注）' },
  { type: 'AREA_CHART', title: '面积图', description: '单/多序列面积趋势（数据来自绑定数据集；基线 0；空数据占位）' },
  { type: 'BAR_CHART', title: '柱状图', description: '类别对比（柱=真实数据点；空数据占位）' },
  { type: 'BIG_NUMBER', title: '大字报数', description: '单一关键数值全屏呈现（数值必须来自可追溯事实；空值显示占位，绝不编造）' },
  { type: 'CAUSAL_FLOW', title: '因果链', description: '单向因果/流程链（节点文本逐字来自 props；空链占位）' },
  { type: 'CAUSAL_LOOP', title: '因果闭环', description: '自我强化循环（FEEDBACK_LOOP 语义；节点文本逐字来自 props）' },
  { type: 'CHAPTER_TITLE', title: '章节标题', description: '章节转场结构场景（TRANSITION 语义；无旁白）' },
  { type: 'COMPANY_PROFILE', title: '公司档案', description: '公司事实卡（名称/代码/显式事实；不推算财务数据）' },
  { type: 'COMPARE_SPLIT', title: '对比分栏', description: '左右分栏对比（每栏 label/value/bullets 显式给出；空栏明确占位）' },
  { type: 'COUNTRY_PROFILE', title: '国家档案', description: '国家/地区事实卡（名称/代码/显式事实）' },
  { type: 'DOCUMENT_HIGHLIGHT', title: '文档高亮', description: '文档片段高亮（内容逐字来自来源文档）' },
  { type: 'DUAL_LINE_CHART', title: '双线对比', description: '两条序列同轴对比（legend；空数据占位）' },
  { type: 'HOST_FULL', title: '主持全屏', description: '真人主持全屏（Avatar 驱动；未绑定素材时明确占位）' },
  { type: 'HOST_OVERLAY', title: '主持下三分之一', description: '主持画面 + 下三分之一信息条（left/center 对齐为布局变体）' },
  { type: 'HOST_PIP', title: '主持小窗（PiP）', description: '主画面 + 主持小窗（四角位置与占比为布局变体；未绑定素材明确占位）' },
  { type: 'HOST_SIDE', title: '主持侧栏', description: '主持人在侧、内容在另一侧（未绑定素材时明确占位）' },
  { type: 'IMAGE_FULL', title: '全屏画面', description: '全屏图片（AI 生成或作者上传；未绑定素材时明确占位）' },
  { type: 'KPI_GRID', title: '指标网格', description: '多个关键指标的网格呈现（数值逐字来自事实；空值显示占位横线）' },
  { type: 'LINE_CHART', title: '折线图', description: '单序列时间趋势（数据来自绑定数据集；空数据占位）' },
  { type: 'LOGO_WALL', title: '品牌墙', description: '名称墙（文字缩合；2–6 列布局变体；不伪造商标图形）' },
  { type: 'MAP_FLOW', title: '地图流向', description: '两地流向示意（起止点显式给出；弧线为示意，标注"非真实地理投影"）' },
  { type: 'MAP_STATIC', title: '静态地图', description: '区域标注示意（GEOGRAPHY 语义；位置显式给出并标注"示意"）' },
  { type: 'MAP_ZOOM', title: '地图缩放', description: '区域缩放示意（位置与档位显式给出；标注"非真实地理投影"）' },
  { type: 'NEWS_HEADLINE', title: '新闻标题卡', description: '报道标题逐字呈现（含来源/时间；空标题占位）' },
  { type: 'NUMBER_COMPARE', title: '数值对比', description: '2–4 项数值对比卡（row/column 布局变体；数值显式给出，不推算）' },
  { type: 'PERCENT_DELTA', title: '百分比变化', description: '单一百分比变化（↑/↓/持平；比较口径可标注；显式数值）' },
  { type: 'PERSON_PROFILE', title: '人物档案', description: '人物事实卡（姓名/头衔/2–5 条显式事实；缩合头像为文字，不伪造真实肖像）' },
  { type: 'PROCESS_FLOW', title: '流程图', description: '领式步骤链（horizontal/vertical 布局变体；步骤显式给出，2–6 步）' },
  { type: 'QUOTE_CARD', title: '引文卡', description: '引文逐字呈现（QUOTE 语义；含出处；§10.3 降级载体）' },
  { type: 'REAL_BROLL', title: '真实素材', description: '真实拍摄/授权素材（未导入时明确占位；不得以 AI 冒充真实画面）' },
  { type: 'SOURCE_CARD', title: '来源卡', description: '来源可追溯卡（§10.3 降级载体；内容来自 Citation/Source，不编造）' },
  { type: 'SPREAD_AREA_CHART', title: '利差面积图', description: '两条序列之差以面积呈现（§10.1 财经 YIELD_SPREAD；空数据占位）' },
  { type: 'STACKED_BAR_CHART', title: '堆叠柱状图', description: '多序列堆叠柱（列数一致且无负值；含 0 基线；不满足条件时占位——不绘制错误图形）' },
  { type: 'SUMMARY', title: '总结卡', description: '结论要点列表（TEXTUAL_EXPLANATION 降级的渲染载体；空要点占位）' },
  { type: 'TIMELINE', title: '时间线', description: '事件时间线（日期逐字来自事实；空事件占位）' },
] as const;

export const componentCatalogEntrySummarySchema = z.object({
  type: z.string().min(1).max(60),
  title: z.string().min(1).max(120),
  description: z.string().min(1).max(400),
});

export type ComponentCatalogEntrySummary = z.infer<typeof componentCatalogEntrySummarySchema>;
