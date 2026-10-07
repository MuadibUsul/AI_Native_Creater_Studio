# Quiet Frame 前端实施任务书

目标仓库：`MuadibUsul/AI_Native_Creater_Studio`  
审查基线：`2fa881db7a9d024a03b5077f197f7cedbbeea194`  
设计参考：`../index.html`、`../screens/`、`../DESIGN_REVIEW_AND_SPEC.zh-CN.md`。

## 0. 给执行代理的任务说明

在保持现有内容生产、编辑、权限、计费和交付规则的前提下，实现 Quiet Frame 视觉和任务流程。**不把演示 HTML 当作生产应用，不将其演示数据、假指标、固定报价或 localStorage 状态迁移为业务逻辑。**

接手时重新读取仓库内实际有效的协作规范、产品规范、最新 handoff 和当前分支；本文件中的基线只代表设计审查时点。记录与基线的差异。不要覆盖用户已有改动。建议在独立分支 `design/quiet-frame-v1` 推进；是否提交、推送、开 PR 以用户授权和仓库流程为准。

本次任务是 Web UI/UX 重设计，不代表用户已经解除 P15/P16 的阶段暂停。不开展原生桌面/手机封装或第三方 Marketplace。响应式网页适配在本次 UI 范围内。

## 1. 不可破坏的接口与约束

1. Scene Graph 继续为视频权威描述；时间线只是同一图的视图，不新建并行剪辑状态。
2. 客户端复用 `@ancs/sdk` 和现有 Query hooks；后端、领域和 Provider 适配器不为视觉方便而挪进 Next.js。
3. 项目写入继续携带 `baseProjectRevision`；场景写入保留 `expectedSceneRevisions`；重试使用正确幂等键。
4. 锁定检查、权限检查和预算检查必须由后端保留。禁用 UI 不是安全边界。
5. AI 修改先展示真实结构化差异，再由用户应用。未确认或拒绝不落库。使用冲突版本的计划不能偷偷重放。
6. 普通草稿修改不触发昂贵素材重生成。涉及费用先取得后端可核验报价/影响信息；界面不可自己编造余额、有效期或“永久免费”。
7. 声音克隆沿用授权、用途、生命周期、撤销和删除路径；一个前端勾选框不等于完整实名/授权核验。
8. 事实图表必须保留数据、来源、许可、单位、币种、时区、调整口径与模板版本等实际要求。缺失值保持缺失，不按0生成。
9. 渲染须经 QA；人工批准绑定不可变渲染快照/manifest。修改草稿不改变已批准文件，新的渲染须重新批准。
10. 下载继续使用受控签名 URL。外部供应商的临时输出地址不能直接变成长期交付文件。
11. 发布按钮按实际能力开放；草稿和素材包不伪装为已发布。结果未知优先 reconcile，不直接重复请求发布。
12. 历史记录、来源和账单不可由前端本地演示数据替代；API Key 不进源码、浏览器存储、URL、日志或截图。

## 2. 推荐组件分层

以下为建议目录，不是声称仓库已有这些文件：

```text
apps/web/src/
  ui/
    foundation/     Button, IconButton, TextField, Select, Tabs, Badge,
                    Dialog, Drawer, Toast, Skeleton, StatusMessage
    layout/         WorkspaceShell, ProjectShell, Sidebar, CommandMenu
  features/
    workspace/      CreatorDashboard, ProjectCard, ContentComposer
    import/         ImportSourceView, CreativeBriefPanel
    script/         ScriptDocument, ChapterOutline, SourceInspector
    studio/         DirectorWorkspace, SceneRail, SceneInspector,
                    NarrationBar, EditPlanDrawer, VersionDrawer
    delivery/       RenderReviewView, QualityChecklist, CostConfirmDialog,
                    DeliveryChannels, PublicationStatus
    assets/         AssetLibrary, AssetDetails, FinanceAuthoringView
    identity/       CreatorIdentityView, ConsentFlow
    analytics/      PerformanceView, LearningSuggestion
    settings/       ProviderSettings, UsageSettings
  app/              薄路由：读取参数、权限/加载边界、组合 feature
```

不要把 Query 结果再复制一份成为组件的“权威业务状态”。Zustand 可保留面板开关、选择项、未提交文本等 UI 状态。先完成少量稳健公共组件，避免为了“设计系统”搭建一个独立框架。

## 3. 路由与现有代码对照

| 现有入口/文件 | 新视图 | 实施方式 |
|---|---|---|
| `app/page.tsx` | 创作台 | 修复新建入口条件，加入内容输入和项目缩略图；复用工作区/项目 queries。 |
| `app/layout.tsx` + `globals.css` | 应用外壳与变量 | 移除对所有页面统一的窄容器约束；阅读页自设 max-width，编辑页占满空间。 |
| `.../p/[projectId]/layout.tsx` | 项目外壳 | 两级导航与下一步操作；保留原路由 deep link。 |
| `.../script/page.tsx` | 导入/脚本/来源 | 先可内部分阶段切换，不必先创建新公共路由；时长设置使用实际 contract。 |
| `.../storyboard/page.tsx` | 导演工作台 | 接入 SceneRail / Preview / Inspector / EditPlanDrawer，保留图状态与 mutation。 |
| `.../editor/[sceneId]/page.tsx` | 选中场景的同一工作台 | 旧链接进入对应 scene，属性修改仍走现有编辑协议。 |
| `.../editor/page.tsx` | 编辑工作台入口 | 恢复最后可访问/首个有效 scene，保持无 scene 状态。 |
| `.../assets/page.tsx` | 素材库 | 先维持现有项目范围；工作区全局聚合须核对 SDK/API 能力后开放。 |
| `.../history/page.tsx` | 版本抽屉/独立历史页 | 抽屉提升日常效率，独立历史 deep link 不删。 |
| `.../render/page.tsx` + `RenderReview.tsx` | 成片审核 | 预览+检查+批准；保持服务器状态和导出闸门。 |
| `AnalyticsWorkspace.tsx` | 表现复盘 / Finance 制作拆分 | 拆 feature 与 query 错误边界，不重写已有领域能力。 |
| `.../billing/page.tsx`、`.../team/page.tsx` | 设置内页 | 重新包外壳，不丢现有账单、角色、席位与邀请路径。 |
| 新设计：创作者身份、发布、扩展目录 | 提议新视图 | 先核验现有 SDK 和 contract 能力；本原型路由不代表生产路由存在。 |
| 新设计：产品首页 | 提议公开页 | 首阶段不擅自把 `/` 从工作区改成营销页；可先在独立设计预览路由验收。 |
| `sign-in` / `admin` | 登录 / 后台 | 本交付未画独立高保真页；正式迁移时应用同一 tokens。后台不能放进普通用户导航。 |

## 4. 分批实施与验收

### QF-01 现状核对与变更边界

确认当前 Git 分支、工作树、路由、测试状态、实际 API 和未核验服务，记录基线。若当前代码已发生改动，以最新实际代码重新定位，不机械覆盖。

验收：变更清单区分“仅样式”“页面结构”“状态/交互”“新增 API 需求”；没有伪造测试通过。

### QF-02 设计变量与基础控件

引入 tokens、语义文字、间距、圆角、状态颜色。先覆盖 Button、Field、Tabs、Badge、Dialog/Drawer 和 StatusMessage。控件支持 disabled/loading/invalid/read-only/focus。

验收：浅色为默认，深色不靠反相实现；关键文本对比、焦点与键盘访问核对；保留既有数据属性与可访问名称，必要变更同步更新测试。不得直接删断言以让测试通过。

### QF-03 工作区外壳与创作台

两级导航；项目卡片以现有真实元数据显示状态；缩略图无资源时使用明确占位。新建按钮在零、一、多项目状态下都存在。项目入口恢复到有效阶段，而不是无条件回到脚本。

验收：加载、未登录、无工作区、无项目、多项目、失败、权限变化完整；切换工作区不能暂时闪现前一工作区资料。

### QF-04 导入与作品方向

把 URL/粘贴/文件入口按后台能力接通；先展示内容/来源/解析结果。目标时长不再硬编码2分钟；合法值和上限来自 contract。导入失败保持原输入；不支持解析明确说明。

验收：URL成功/失败、支持文件/不支持文件、重复提交、预算/权限限制、Mock与真实结果标识；文件扫描与来源规范不绕过。

### QF-05 脚本与来源阅读

文稿为主，大纲与来源为辅；锁定已确认文本；就地编辑与明显保存状态。来源关联与核验状态分开。时长格式统一，人类可读。

验收：锁定、解除锁定、编辑成功/失败、冲突保持本地文本；没有默认收费生成副作用。

### QF-06 导演工作台

以 Scene Graph 接三栏视图。PreviewPlayer/ScenePreview 继续复用同源组件，不用高保真截图替换真实播放器。Inspector 使用受控属性组件和 schema validation；复杂对象不默认泄露为 JSON 编辑器。

验收：选择/滚动/定位分镜、空场景、缺资源占位、来源缺失、只读、锁定；三栏各自滚动；在1600×1000下预览、旁白和修改入口可同时看到；旧场景 deep link 有效。

### QF-07 AI 差异、轻时间线与冲突

差异抽屉展示真实 before/after、场景范围、锁定影响、时长变化和成本影响。确认后提交原编辑协议；关闭/拒绝不提交。时间线默认收起复杂操作，所有操作写回同一图。

验收：计划生成/拒绝/应用、过期revision、非法操作、锁定阻止、重试幂等；冲突不清空用户未提交内容；前端不能改写权威成本。

### QF-08 生成确认与成片审核

将规格、预检、成本、任务状态、QA、批准变成清楚的阶段。创建昂贵任务前取得后端实际信息；缺报价或能力时明示阻塞，不能用原型36点补位。

验收：QUEUED/RENDERING/QA/READY/FAILED/CANCELLED；进度未知不用假百分比；BLOCKER/WARNING/SKIP保留；审批绑定manifest；修改后不得使用旧批准导出新产物。

### QF-09 素材与创作者身份

素材列表显示来源许可；身份设置呈现声音/主持方式/外观；已有SDK能力先读后接。没有接入的能力不做“成功态演示”混入生产页面。

验收：素材失败/许可缺失/跨租户不可见/签名URL过期；声音同意拒绝/同意后生命周期/撤销。不得以生成素材冒充来源。

### QF-10 交付与发布

按后端经核验能力渲染平台操作。无OAuth/缺权限/能力待核验的卡片显示下一步。素材包手动发布与自动发布分开；手机交接复用已有到期和撤销规则。

验收：未批准不导出；无授权不发布；草稿不能显示Published；结果未知走reconcile；任务和按钮幂等。

### QF-11 Analytics 与 Finance 分离

表现页只负责作品表现与建议；Finance图形制作移入素材/扩展上下文。初始 queries 和错误边界拆开，保持账户权限/许可隔离。未知值不转换为0，接受建议不静默修改栏目。

验收：Finance查询失败不遮蔽可用表现；表现未知时不画假趋势；图表缺真实输入时fail-closed；历史产物模板版本不漂移。

### QF-12 响应式与无障碍

至少320/390/768/1280/1600宽度；浏览器200%缩放；键盘完整流程；焦点进入/退出抽屉；减少动态效果；正常文字与必要控件边界对比；按项目目标扩大触控热区。

验收：无整页横向溢出、不丢主操作、手机属性面板可展开、没有只能hover才能发现的必要操作；断网/保存失败不会丢草稿。

### QF-13 视觉回归、灰度与回滚

以可控 fixture 做视觉回归，另保留真实API契约/集成测试。不要截图动态真实用户资料、密钥、签名URL或私人来源。使用特性开关分批放量，旧视图保持可回滚，不改业务数据格式只为回滚视觉。

验收：lint/typecheck/build/相关现有测试真实运行并记录输出。更改状态/接口时补对应测试。只有运行并看到结果才写PASS，未经测试写NOT RUN/BLOCKED。

## 5. 编辑器性能纪律（工程目标，尚未实测）

同一视图只保留必要的活跃视频播放器；分镜清单优先使用缓存缩略图或轻量场景预览，不为每个缩略卡启动完整视频播放实例。长清单采用按需渲染，不能使当前播放和输入随清单滚动反复重建。

预览、图状态、素材下载URL与Finance/Analytics查询分设失效与失败边界；局部素材失败不能遮住整部作品。抽屉和复杂组件按需加载，但打开后保留当前选择和未提交文本。

输入反馈与保存状态明确分离；实际提交节奏遵循revision/幂等协议，不用防抖掩盖未保存。浏览预览、切换侧栏和调整纯视觉设置不得触发收费Provider调用。

大面积玻璃模糊、实时投影与无限装饰动效不得与播放器争夺帧预算。建立真实浏览器性能基线后再报告性能改善，不将本次静帧原型的轻量程度当作生产视频工作台性能。

## 6. 建议测试场景

关键用例不仅是截图：

- 已有项目时能继续创建；切换工作区时不能越权或串数据。
- URL/文档解析失败可恢复；来源缺失不能生成事实图表。
- 锁定文本与场景不能被 AI 偷改；拒绝计划无副作用。
- stale revision 不被覆盖；手工文本保留到比较完成。
- 同一昂贵任务双击/超时重试不会重复收费或重复生成。
- QA blocker不开放批准；审批快照与下载/发布产物一致。
- OAuth未核验不能展示已连接；DRAFT不显示PUBLISHED。
- 表现指标缺失仍是null；Finance故障与Analytics页面隔离。
- 模态层键盘循环、Esc、焦点返回；小屏不丢失主操作。

视觉基线固定视口、字体环境、数据与动画状态，不以某一PNG像素完全等于macOS Safari作为Windows验收唯一标准。

## 7. 本次已经验证与尚未验证

本交付只验证了单文件原型：28项检查、65组布局扫描。没有运行本仓库`pnpm verify`，没有接真实后端。原型与截图是设计输入，不是这些实施任务已经完成的证明。

工程完成后交付：真实变更文件清单、前后截图、接口复用说明、真实测试输出、尚未接通项、灰度开关和回滚说明。不要以“漂亮截图”代替端到端验收。
