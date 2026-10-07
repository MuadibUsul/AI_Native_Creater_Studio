# Quiet Frame 设计与现有功能映射

建立日期：2026-10-07。基线为 `main @ 2fa881db7a9d024a03b5077f197f7cedbbeea194` 的路由与 SDK 实盘。下表是**设计 → 目标实现**的施工映射，不把现有功能或原型演示状态误写成视觉重构已完成。状态仅表示当前工作树中已有页面/接线；`IMPLEMENTED · QA PENDING` 不代表视觉或业务验收通过。真实缺口继续标为 `TODO`。反向映射也按当前代码更新，最终仍需逐项回归。

记号：`W = /w/[workspaceId]`，`P = W/p/[projectId]`。带 `*` 的目标路径是盘点时拟新增、现已在工作树出现的路由；尚未通过逐页验收，现有 deep link 仍须保留。原型入口均指只读参考目录下的 `index.html`，截图均指其 `screens/` 目录。组件名称中的“拟”表示施工建议，不代表仓库已有文件。

| ID / 设计页面或状态 | 原型入口 → 参考图 | 目标路由或弹层 | 当前承接组件 → 拟实现位置 | 真实数据与 SDK/API | 验收用例 | 状态 |
|---|---|---|---|---|---|---|
| QF-01 创作台 | `#home` → `01-workspace.png` | `/`（当前登录后工作区入口） | `DashboardPage` → 工作区外壳、内容输入、项目卡 | 会话、工作区、栏目、项目；`useSession`、`useWorkspaces`、`client.projects.list/create`、`client.channels.list/create` | 零/一/多项目始终可新建；工作区切换不串数据；项目卡恢复真实阶段；未登录/加载/失败 | IMPLEMENTED · QA PENDING |
| QF-02 新建作品 | `#new` → `02-new-project.png` | `W/new` *；原 `/` 创建入口保留 | `DashboardPage` 创建入口、`NewProjectPage` 分步导入 | 当前输入、栏目、项目、来源/解析、目标时长；`projects.create`、`content.create`、`evidence.extract`、`narrative.generate`；可用文件类型/时长以 contract 为准 | URL、粘贴及实际支持的文件；失败保留输入；重复提交幂等；不支持格式明确说明；不假装生成 | IMPLEMENTED · QA PENDING |
| QF-03 脚本与来源 | `#script` → `03-script.png` | `P/script`（现有） | `ScriptPage` → 文稿、大纲、来源检查器 | narrative block、来源与事实引用、锁定、revision；`useNarrative`、`narrative.updateBlock`、`content/evidence` 相关接口 | 可读文稿、来源定位、锁定与 AI 差异；保存失败/冲突保留草稿；来源关联不等于事实核验 | IMPLEMENTED · QA PENDING |
| QF-04 导演工作台 | `#editor` → `04-director.png` | `P/storyboard`（主视图）；`P/editor` 与 `P/editor/[sceneId]`（保留旧链接） | `StoryboardPage`、`SceneEditorPage`、`PreviewPlayer`、`ScenePreview`、`LiteTimeline` → 三栏工作台 | Scene Graph、narrative、场景、素材临时 URL、revision/锁定；空图先调用 `narrative.directorPlan` 只读预览，再由用户确认 `applyDirectorPlan`；未知费用/阻断任务不能应用；`useSceneGraph`、`projects.edit`、`narrative.aiEditPlan`、`assets.downloadUrl` | 1600×1000 同屏可见分镜/画布/旁白/检查器；选中和 deep link 恢复；真实播放器；候选/费用/锁定/冲突；本地替身测试不等于 Provider 实测 | IMPLEMENTED · QA PENDING |
| QF-05 素材库 | `#assets` → `05-assets.png` | `P/assets`（当前项目范围）；工作区总库 `W/assets` * 已出现；聚合语义待验 | `DeliveryAssets` → 工作区/项目范围的分类、搜索、详情抽屉；项目素材页按需展开独立 `FinanceWorkspace` | 项目素材、来源许可、上传/签名 URL、外部结果；`useAssets`、`assets.upload/downloadUrl`、`stock.search`、`billing.externalResults/rebindExternalResult`；Finance 来源/模板/产物经 `finance.*`，不自动绑定分镜 | 上传、失败重试、授权/来源、跨租户、过期 URL；Finance 未展开不请求数据，故障不遮蔽素材；无事实输入不生成事实图表 | IMPLEMENTED · QA PENDING |
| QF-06 创作者身份 | `#identity` → `06-identity.png` | `W/identity` * | `WorkspaceIdentity` → 身份、声音、品牌视图 | 身份、声音样本、授权声明/撤销、品牌；既有训练可查询，退休与平台解绑需二次确认；`creatorIdentities.*`、`voiceClone.*`、`channels`；缺报价时付费训练提交/重试和 Provider 删除保持关闭 | 样本/授权/撤销生命周期；试听只用浏览器系统语音；Provider 删除依赖服务端连接归属及 clone version 原子校验；无假成功 | PARTIAL · BACKEND GATE TODO |
| QF-07 成片与审核 | `#render` → `07-review.png` | `P/render`（现有） | `DeliveryRender` → 预览、QA 清单、规格和当前主操作 | render、job、QA 报告、批准/manifest、导出；`narrative.masterNarration` 只读检查已接；`renders.create` SDK 可用，但 Web 因缺报价/预算/服务确认而禁用提交；其余 `renders.list/qa/qaReport/decideApproval/approval/exportPackage` 已接 | QUEUED/RENDERING/QA/READY/FAILED/CANCELLED；QA blocker 阻止批准；批准绑定快照；未批准/失效不导出；新建渲染须先完成费用确认 | PARTIAL · SAFETY BLOCKED |
| QF-08 交付与发布 | `#publish` → `08-publishing.png` | `P/publish` *；原 `P/render` 导出入口保留 | `DeliveryPublish` → 交付、发布与受控导出视图 | 批准版本、平台能力/授权、发布记录、P4 包、Web 限时交接记录；Web 接入 `publications.list/reconcile`、`exportPackages.create/list`、`handoffs.list/create/cancel`；SDK 的发布请求/详情能力保留 | P1–P4 能力分级；未授权/未批准不可发布；DRAFT 不显示 PUBLISHED；不确定结果只查询对账；手动交接有到期/撤销，领取端在 P15 | IMPLEMENTED · QA PENDING |
| QF-09 作品表现 | `#analytics` → `09-analytics.png` | `P/analytics`（现有） | `DeliveryAnalytics` → 表现与建议；Finance 制作已移至 `P/assets` | publication、performance、场景归因、建议；`publications.listAnalytics/collectAnalytics`、`analytics.listScenes/generateLearnings/actOnLearning`；本页不请求 Finance 数据 | 未知值显示未知；无真实数据不画示例曲线；建议不静默修改作品；Finance 故障不遮蔽表现 | IMPLEMENTED · QA PENDING |
| QF-10 扩展工具 | `#extensions` → `10-extensions.png` | `W/extensions` * | `WorkspaceExtensions` → 按当前能力展示扩展入口；财经图表说明指向项目内建能力，制作入口在 `P/assets` | Shorts、财经图表、播客、多语言等能力状态；真实 Pack 安装/启用来自工作区 API；`finance.*` 在项目素材页，`podcast.*` 与 `multilingual.*` 仍按能力和权益开放 | 启用前展示权限/范围/费用/撤销；缺能力呈不可用；不能把原型“加入演示”当安装成功 | IMPLEMENTED · QA PENDING |
| QF-11 服务与设置 | `#settings` → `11-settings.png` | `W/settings` *；现有 `W/billing`、`W/team` 保留 | `WorkspaceSettings`；旧 `CreditsBilling`、`TeamManagement` 路由保留 | 工作区、成员/席位、用量预算、Provider 凭据掩码、隐私；`workspaces.*`、`billing.*`、成员/邀请 SDK；Provider 配置表单已接线，权限与密钥掩码待真实 API 复核 | 权限与预算约束保留；Secret 不进浏览器/日志；账单与额度分开；旧账单/团队链接可达 | IMPLEMENTED · QA PENDING |
| QF-12 产品首页 | `#welcome` → `12-landing.png` | `/welcome` *（公开入口策略待定，`/` 工作区职责保留） | `WelcomePage` → 产品首页 | 真实产品能力文案；登录/进入工作区复用现有会话；无生产示例指标 | 视觉对齐；CTA 到真实登录/工作区；不展示虚构客户、速度或市场成绩 | IMPLEMENTED · QA PENDING |
| QF-13 设计系统 | `#system` → `13-design-system.png` | `/design-system` *（开放范围待定） | `DesignSystemPage` 与设计 token/组件展示 | 语义变量及真实 UI 组件；版本冲突与声音授权的只读说明弹层不写业务数据，授权入口指向当前工作区真实身份页 | 颜色、排版、按钮、状态、圆角、冲突示例；展示与实际组件共用 token；双主题、Esc 关闭与焦点返回；无工作区时引导创作台 | IMPLEMENTED · QA PENDING |
| QF-14 AI 差异确认抽屉 | `#editor` + 抽屉 → `14-ai-diff.png` | `P/storyboard`、`P/editor/[sceneId]`、脚本页的上下文抽屉 | `AiEditPanel` → 同一编辑协议的差异抽屉 | 真实 edit plan、before/after、影响、锁定、费用、base/expected revision；`narrative.aiEditPlan`、`projects.edit` | 关闭/拒绝无副作用；显示请求分镜与计划实际目标；确认后原子提交；过期 revision 保留草稿；锁定不可偷改 | IMPLEMENTED · QA PENDING |
| QF-15 手机创作台 | `#home` 390×844 → `15-mobile-workspace.png` | `/` 的响应式状态 | `DashboardPage` → 手机外壳/导航 | 与 QF-01 同一真实数据和 SDK | 390×844/DPR2 主按钮可用、菜单可开关、无横向溢出；项目/工作区上下文不丢 | IMPLEMENTED · QA PENDING |
| QF-16 手机导演工作台 | `#editor` 390×844 → `16-mobile-director.png` | `P/storyboard` 与场景 deep link 的响应式状态 | `StoryboardPage`、`SceneEditorPage` → 横向场景/按需属性面板 | 与 QF-04 同一 Scene Graph、两阶段 Director 候选确认和编辑协议 | 不缩小桌面三栏硬塞手机；当前场景、播放位置、草稿可恢复；主操作可触达 | IMPLEMENTED · QA PENDING |
| QF-17 手机成片审核 | `#render` 390×844 → `17-mobile-review.png` | `P/render` 的响应式状态 | `DeliveryRender` → 手机预览/QA/批准 | 与 QF-07 同一 render、QA、approval；新建渲染沿用费用确认安全阻断 | QA 与批准限制完整；弹层不截断；未知进度不伪装百分比 | PARTIAL · SAFETY BLOCKED |
| QF-18 深色创作台 | `#home` + dark → `18-dark-workspace.png` | `/` 的深色状态 | `DashboardPage` + 主题 token | 与 QF-01 同一真实数据；主题仅客户端偏好 | 以原型 `.theme-dark` 和原图为准；同状态同环境截图；文本/控件对比与焦点 | IMPLEMENTED · QA PENDING |

## 设计中可操作、但没有独立原图的状态

这部分仍在范围内。视觉基准须运行原型、固定视口/主题/数据后重新截图；实现页面中的数据与权限由真实 SDK/API 决定。

| 原型状态 | 目标位置 | 必须保留的业务或交互 | 状态 |
|---|---|---|---|
| 命令搜索、工作区切换、任务通知、帮助 | 工作区外壳弹层 | `StudioShell` 已接搜索、切换、通知查询与帮助；Esc/焦点、跨租户缓存及真实任务状态仍需浏览器验收 | IMPLEMENTED · QA PENDING |
| 来源、版本历史、素材详情抽屉 | `P/script`、`P/storyboard`、`P/assets`；`P/history` 旧页保留 | 来源与素材详情已有局部视图；why：原型中的历史抽屉尚未与完整服务端事件列表同态；dependency：历史 SDK/分页与焦点交互核对；intended interface：只读打开服务端历史及 undo/redo，旧独立页继续可达 | PARTIAL · HISTORY DRAWER TODO |
| Director 空图候选预览与确认 | `P/storyboard` 空图 | 已接 `narrative.directorPlan` 只读预览场景、素材需求、Provider 任务、费用与告警；只有用户确认且费用已知、无阻断项时调用 `applyDirectorPlan`；可放弃计划。组件替身测试覆盖预览前零写入、确认、未知费用与 409；真实 Provider/预算仍待验 | IMPLEMENTED · QA PENDING |
| 审核退回、规格、成本、导出、发布能力、手机交接 | `P/render`、`P/publish` | QA/审批/导出/P4 包/Web 限时交接已有入口；why：新渲染缺服务端报价/预算确认，移动领取在 P15；dependency：费用确认接口与真实平台/跨端环境；intended interface：预检→报价→用户确认→创建渲染，Web 只创建/撤销交接 | PARTIAL · SAFETY BLOCKED |
| 声音授权、样本、品牌、Provider 与设置子页 | `W/identity`、`W/settings` | 身份与设置表单已有接口，授权/现有任务查询及退休/解绑已接；浏览器系统语音仅试听示例。why：付费训练与 Provider 删除缺报价、连接归属和原子版本校验；dependency：后端安全契约；intended interface：服务端确认后才显示受控写操作 | PARTIAL · BACKEND GATE TODO |
| 版本冲突、锁定、失败与局部加载 | 脚本、导演及其它受影响视图 | base revision、锁定与局部恢复已在组件接线；需真实浏览器 403/409、断网及草稿保留回归 | IMPLEMENTED · QA PENDING |
| 其余页面的手机/深色及中间断点 | 各主页面 | why：原包仅有 QF-15～18 的有限状态；dependency：其余页面响应式与主题实现收敛；intended interface：共用 Web 路由/SDK，在 320/768/1280/1920 等断点无溢出与截断 | TODO |

## 现有功能 → 新设计：反向核对

本表覆盖审查时 Web 路由与其直接使用的 SDK，也单列已有 SDK 但尚无 Web 入口的能力。列出的测试文件是**待保留的回归入口**，并非本次已运行或通过。重构进行中，具体代码与新增测试需在最终验收时重新实盘核对。

| 现有功能与代码入口 | 新设计中的去向 / 是否保留 | 真实接线和权限、异常要求 | 回归测试入口或待补用例 | 状态 |
|---|---|---|---|---|
| 登录、会话和未认证边界：`/sign-in`、`app/page.tsx`、`lib/client.tsx` | 登录页为**参考未覆盖的适配页面**；创作台 QF-01 继续以真实会话进入 | 保留 Cookie/会话与 SDK 请求；401 显示登录动作，403 不泄露项目；刷新/前进后退不闪出前一用户数据 | `app/dashboard.test.tsx`；补登录失效/深链接回归 | IMPLEMENTED · QA PENDING |
| 工作区创建与切换、栏目及项目创建：`DashboardPage` | QF-01 创作台、QF-02 新建作品；保留 `/` 当前工作区入口 | `workspaces.create/list`、`channels.list/create`、`projects.list/create`；新建入口在零/一/多项目均可见；工作区切换清空旧租户查询缓存和敏感显示 | `app/dashboard.test.tsx`；补一/多项目新建、跨工作区切换 | IMPLEMENTED · QA PENDING |
| 项目级导航与旧 deep link：`P/layout.tsx` | QF-03/04/05/07/08/09 作品级导航；旧 `P/storyboard`、`P/editor/[sceneId]`、`P/history` 保留 | 路由参数必须与 workspace/project 权限同查；不存在或跨租户统一 404；刷新、回退恢复项目/场景上下文 | `app/storyboard-editor.test.tsx`、`app/assets-history-render.test.tsx`；补 deep link | IMPLEMENTED · QA PENDING |
| URL 内容摄取、证据抽取、叙事生成：`ScriptPage` | QF-02 导入入口、QF-03 脚本阅读 | `content.create` → `evidence.extract` → `narrative.generate`；错误保留原输入；支持文件类型和时长按真实 contract；权限/预算/Provider 不可用不得伪成功 | `app/script.test.tsx`；补解析失败、格式限制、重复提交 | IMPLEMENTED · QA PENDING |
| 脚本读取、段落编辑/锁定、来源与引用：`ScriptPage`、`useNarrative` | QF-03 中央文稿、左大纲、右来源；来源抽屉 | `narrative.updateBlock` 和来源/引用 SDK；锁定内容明确只读；403、来源缺失和版本冲突保留本地草稿并提示恢复 | `app/script.test.tsx`；补锁定/解锁/冲突/来源区别 | IMPLEMENTED · QA PENDING |
| Scene Graph 分镜、播放器、场景素材：`StoryboardPage`、`PreviewPlayer`、`ScenePreview` | QF-04 三栏导演工作台及 QF-16 手机布局 | `useSceneGraph`、`useNarrative`、受控素材下载 URL；预览真实场景，缺资源给恢复状态；只读/锁定/加载失败不触发生成 | `app/storyboard-editor.test.tsx`、`ui/PreviewPlayer.test.tsx`、`ui/ScenePreview.test.tsx` | IMPLEMENTED · QA PENDING |
| Director 候选读取与确认：SDK `narrative.directorPlan/applyDirectorPlan` | QF-04 空图引导；沿用同一 Scene Graph | `StoryboardPage` 先只读 `directorPlan` 展示场景/素材/任务/费用/告警，再确认带幂等键调用 `applyDirectorPlan`；计划版本过期、费用未知、阻断任务时不写入。真实预算与 Provider 能力仍由服务端权威校验 | `app/storyboard-editor.test.tsx` 覆盖替身 SDK 的预览前零写入、确认、未知费用和 409；未做第三方 Provider 实测 | IMPLEMENTED · QA PENDING |
| 单场景编辑：`P/editor/[sceneId]`、`PropForm` | QF-04 检查器/属性面板；旧场景 URL 继续定位 | 保留 `projects.edit` 的 base revision、expected revisions、幂等键、锁定校验与原子提交；409 不静默覆盖，未提交草稿可比较/重试 | `app/storyboard-editor.test.tsx`；补旧链接、锁定、stale revision | IMPLEMENTED · QA PENDING |
| AI 修改先计划、展示差异、确认提交：`AiEditPanel`、`StoryboardPage` | QF-14 差异抽屉，脚本/导演入口就近显示 | `narrative.aiEditPlan` 与 `projects.edit`/Director apply；拒绝/关闭零副作用；锁定影响、费用影响及失败状态真实呈现；普通编辑不隐式调用付费模型 | `ui/AiEditPanel.test.tsx`、`app/storyboard-editor.test.tsx`；补拒绝/过期计划 | IMPLEMENTED · QA PENDING |
| 轻时间线与场景排序：`LiteTimeline`、`StoryboardPage` | QF-04 底部按需展开时间线 | 重排/时长仍写回同一 Scene Graph，保持 revision/锁定校验；移动场景后预览、选中项与撤销历史一致 | `ui/LiteTimeline.test.tsx`、`app/storyboard-editor.test.tsx` | IMPLEMENTED · QA PENDING |
| 编辑历史、快照、撤销/重做：`P/history` | QF-04 常用历史抽屉；`P/history` 独立页保留 | 服务端事件和不可变快照为准；`projects.undo/redo` 追加补偿记录；只读角色、冲突与分页错误可恢复 | `app/assets-history-render.test.tsx`；补抽屉/旧页一致性 | IMPLEMENTED · QA PENDING |
| 素材上传、验证、签名下载与回绑：`P/assets` | QF-05 素材库/详情；按真实作用域显示 | `assets.upload/downloadUrl`、`billing.externalResults/rebindExternalResult`；不得把临时 URL 当永久素材；许可不足、上传失败、跨租户/过期 URL 有局部处理 | `app/assets-history-render.test.tsx`；补上传失败/URL 过期/回绑 | IMPLEMENTED · QA PENDING |
| 渲染预检、队列、规格和 QA：`DeliveryRender`（旧 `RenderReview` 保留） | QF-07 成片与审核，QF-17 手机审核 | `projects.renderPrecheck`、`narrative.masterNarration`、`renders.list/qa/qaReport` 已接；新建渲染因缺规格费用报价/预算/服务可用性确认显式禁用，不能把预检 PASS 当成本确认；无可信百分比只显示阶段 | `components/quiet-frame/delivery-render.test.tsx`、`ui/render-review.test.tsx`；TODO：why 缺安全报价闸门，dependency 为受服务端约束的报价与预算接口，intended interface 为报价→确认→`renders.create` | PARTIAL · SAFETY BLOCKED |
| 人工批准/驳回与受控导出：`RenderReview` | QF-07 批准，QF-08 交付；原 render 导出 deep link 保留 | `renders.decideApproval/approval/exportPackage`；批准绑定 manifest；编辑后旧批准失效；下载 URL 有效期及授权必须由服务端核查 | `ui/render-review.test.tsx`；补 manifest 不匹配、驳回、到期 | IMPLEMENTED · QA PENDING |
| 发布、对账、P4 包和手机交接：SDK `publications.*`、`exportPackages.*`、`handoffs.*` 与 `DeliveryPublish` | QF-08 `P/publish`；保留能力闸门并待集成验收 | 按后端核验 P1–P4 能力显示；无 OAuth 不显示已连接；Web 对 `QUEUED/PUBLISHING/FAILED` 记录调用 `publications.reconcile` 查询，不重发；Web 可创建/列出/撤销绑定已批准视频的 24 小时交接；领取端 P15，权限与过期由后端核验 | `components/quiet-frame/delivery-publish.test.tsx` 覆盖替身 SDK 的对账、P4 包及交接；真实平台/跨端领取与 Web 集成仍待验 | IMPLEMENTED · QA PENDING |
| 表现采集、场景归因和学习建议：`AnalyticsWorkspace` | QF-09 作品表现 | `publications.listAnalytics/collectAnalytics`、`analytics.listScenes/generateLearnings/actOnLearning`；未知仍未知，相关不当因果；接受建议不静默改项目 | `ui/AnalyticsWorkspace.test.tsx`；补无数据/拒绝/采集失败 | IMPLEMENTED · QA PENDING |
| Finance 来源、许可、模板和产物：独立 `FinanceWorkspace` | QF-05 项目素材 `P/assets` 的按需展开入口；QF-10 仅说明项目内建能力，QF-09 不再承载 Finance | `finance.*` 读取/创建来源、许可证、版本化模板和冻结产物；单位/币种/时区/调整口径等缺失时失败关闭；展开前不发 Finance 请求，Finance 故障不遮蔽素材或表现；产物不会自动绑定分镜 | `ui/FinanceWorkspace.test.tsx`、`components/quiet-frame/delivery-assets.test.tsx`、`delivery-analytics.test.tsx` 为替身 SDK/组件测试；真实数据、权限与 Scene Graph 绑定仍待验 | IMPLEMENTED · QA PENDING |
| Credits、权益、购买与对账：`W/billing`、`CreditsBilling` | QF-11 设置/用量与预算；旧 `/billing` 保留 | `workspaces.buyCredits/reconcileCredits`、账单/权益查询；购买须真实授权/支付环境，视觉测试不触发真实付款；不足/预留/失败分开显示 | `ui/credits-billing.test.tsx`；补只读/购买失败/余额未知 | IMPLEMENTED · QA PENDING |
| 成员、邀请、角色和隐私级别：`W/team`、`TeamManagement` | QF-11 设置/工作区与成员；旧 `/team` 保留 | `workspaces.members/invitations/setPrivacyTier`；OWNER/ADMIN 管理，其他角色只读；席位不足/跨租户/邀请失败提示原因 | `ui/team-management.test.tsx`；补角色/席位/权限变化 | IMPLEMENTED · QA PENDING |
| 创作者身份与 Voice Clone：SDK `creatorIdentities.*`、`voiceClone.*` 与 `WorkspaceIdentity` | QF-06 `W/identity`；接线待集成验收 | Web 已接授权声明/撤销、样本和现有任务查询，退休/解绑二次确认；正式训练提交/重试与 Provider 删除 fail-closed。why：缺费用确认及供应商连接归属/clone version 原子校验；dependency：后端安全契约；intended interface：报价确认后提交训练，删除时带 expected clone/version 并由服务端核对 Provider 目标 | `components/quiet-frame/workspace-identity.test.tsx` 覆盖替身 SDK；真实 Provider 生命周期与并发/删除尚未实测 | PARTIAL · BACKEND GATE TODO |
| 扩展能力：SDK Finance、Podcast、多语言及其它已实现能力 | QF-10 `W/extensions`；能力不足标未接入 | 每项按当前 contract/权限/报价核对后开放，现有主流程不被扩展卡片替代；原型“安装”只是本地演示 | 补能力可用/不可用与费用确认用例 | IMPLEMENTED · QA PENDING |
| 平台安全运营后台：`/admin`、`SecurityOps` | **参考未覆盖的适配页面**；继续独立于普通导航 | 保留管理员认证、支持授权、审计和跨租户保护；普通用户不可见/不可访问 | `app/admin.test.tsx`、`ui/security-ops.test.tsx` | IMPLEMENTED · QA PENDING |
| CMS 摄取和 READY 回写：SDK `cms.*`、服务端机器接口 | 维持机器接口；QF 页面不伪造 CMS 操作入口 | 租户隔离、签名、幂等 deliveryId、Render READY 不受回写失败影响；若以后做设置 UI，需单独设计与授权 | `docs/verification/P13-07.md` 所列 API/Worker 测试；本次只核查无回归 | PRESERVED · QA PENDING |

**逆向映射结论：** 原 ZIP 没有登录、管理员后台、独立历史页、团队/账单完整明细及 CMS 机器接口的对应原图。这些现有能力需保留可访问入口并适配同一设计系统，验收时标注“参考未覆盖的适配页面/接口”。QF-15～17 是响应式 Web 参考，不能据此宣布 P15/P16 原生端已开始。

## 参考冲突与边界

- 深色变量：`handoff/tokens.css` 与可运行原型 `.theme-dark` 数值不同，详见 `REFERENCE_INVENTORY.md`；QF-18 的视觉值以原型 CSS 和原图核验，差异须登记。
- 原型全部业务数据与成功反馈均为演示内容；不能复制为生产默认，也不能将原型旧 QA 报告算作当前 Web 回归。
- 用户给出的 1:1 任务还要求在同一浏览器环境逐页重拍原型和应用、保存参考/实际/叠加/diff，并记录真实业务测试。此表仅是施工映射，不是验收结果。
