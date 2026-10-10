# Quiet Frame 视觉对照报告

更新日期：2026-10-08。设计包的 18 个状态均已在同一 Chromium 环境重拍参考原型与实际 ANCS Web 页面，并保存实际截图、叠图、差异图和元数据。原图位于只读目录 `docs/design-reference/quiet-frame/a04a074c62f0/ANCS_Quiet_Frame/screens/`；本次证据位于 Git 忽略的 `.artifacts/quiet-frame/<case>/<run>/`。采集命令和隔离边界见 [VISUAL_REGRESSION.md](VISUAL_REGRESSION.md)。

**结论：18/18 状态已有最终一轮截图证据，但 1:1 视觉验收尚未通过。** 私有页面使用标记为 `SYNTHETIC_VISUAL_ONLY` 的隔离 DTO，证明实际 React 页面能按合法接口形状显示；它们不证明数据库、真实素材、Provider、Render、批准、发布或支付结果。像素差异采用精确 RGB、零容差、无裁剪或遮罩，只用于定位偏差，不能直接作为通过率。QF-10 卡片间距与 QF-13 状态动作已按原型修正并复拍。

本轮复拍覆盖 Director 候选与 AI 作用范围、身份、Render 安全阻断、发布对账、Finance 独立入口等近期变更。QF-07/08 的差异上升主要来自可信空态和真实操作说明比参考演示页更长；QF-14 因选中场景与计划目标确认新增信息。这些内容不应通过填入虚假的成功业务数据来压低差异率。设计系统与扩展详情原生弹层另有打开态和键盘证据，见下文。

## 采集环境与运行结果

- 参考：本机 4100 的只读原型；实际：本机 4000 的 production Next 服务。同一 Playwright Chromium 149.0.7827.55、`zh-CN`、上海时区、固定时刻 2026-10-07 12:00 +08:00、`reducedMotion=reduce`。桌面 1600×1000 / DPR 1.5；手机 390×844 / DPR 2。QF-18 两侧均启用深色主题。
- `compare` 一次采集参考与实际，输出 `reference.png`、`actual.png`、`reference-fold.png`、`actual-fold.png`、`overlay.png`、`diff.png`、`metadata.json`。17 个主状态使用 `.artifacts\quiet-frame\<case>\final-261008-d\`；新增示例按钮后 QF-13 单独用 `final-261008-e` 复拍。18 个目录均包含上述 7 个文件。每个目录的元数据含参考 SHA、夹具 SHA、请求、错误、视口、主题和几何尺寸。
- 18/18 实际页面的 `horizontalOverflowPx = 0`，`pageErrors = 0`，夹具 `blocked = 0`、`unmatchedApi = 0`。QF-13 公共页对未登录的 `/auth/session` 与 `/workspaces` 探测返回两次 401，属于预期未认证边界；其它页面没有 HTTP 错误。部分私有页记录 `ERR_ABORTED` 的页面请求，保留原始证据以便复核。另拍 768px 导演页、390px 设置页和 Finance 展开页，均无水平溢出。
- QF-14 的 AI 计划只有一次精确匹配的 `POST /api/v1/workspaces/ws_visual_fixture/projects/prj_visual_01/ai-edit/plan` 脚本化响应。夹具校验请求正文，其他写操作一律阻止；没有调用真实 Provider、数据库或正式写接口。页面也明确标注了该边界。
- QF-11 另拍了设计包未单列原图的设置子页：`.artifacts/quiet-frame/11-settings/settings-budget-261007/` 和 `settings-workspace-261007/`；390px 设置页见 `settings-mobile-261008-a`。项目素材中的 Finance 展开态见 `.artifacts/quiet-frame/05-assets/finance-desktop-261008-a/` 与 `finance-mobile-261008-a/`，这是设计包没有对应原图的 `ADAPTED / NOT COMPARABLE` 状态。这五次实际页采集均无横向溢出、页面错误、被阻止或未匹配请求，也无写请求；未触发预算保存、Finance 创建或成员管理。

## 18 状态对照

以下“差异”是全图精确像素比率，不代表功能质量；原型演示数据与应用合法空态不同的行标为 `NOT COMPARABLE`。`VISUAL REVIEW` 仅说明已人工检查布局，**不是 VERIFIED 或 PASS**。

| 状态 | 实际路由或视图 | 差异 | 判断与主要原因 |
|---|---|---:|---|
| QF-01 桌面创作台 | `/` | 6.24% | VISUAL REVIEW / NOT COMPARABLE。外壳、208px 侧栏、输入区及卡片几何接近；原型封面题字、短句、状态与真实 `Project` DTO 字段不同。 |
| QF-02 新建作品 | `/w/ws_visual_fixture/new` | 11.22% | VISUAL REVIEW / NOT COMPARABLE。分步导入布局接近；原型预填示例标题和文章预览，合法实际空态要求先输入内容，生成按钮不可冒充可用。 |
| QF-03 脚本与来源 | `/w/ws_visual_fixture/p/prj_visual_01/script` | 24.95% | VISUAL REVIEW / NOT COMPARABLE。三栏与真实来源绑定显示；合成段落更长、独立编辑/锁定控件和第四章节使页面高 1874px，参考 1601px。早期夹具缺 `nextCursor` 曾触发 SDK schema 错误，已补 `null` 并在最终统一采集再次复核。 |
| QF-04 桌面导演工作台 | `.../storyboard`，选中第 3 分镜 | 33.10% | VISUAL REVIEW / NOT COMPARABLE。导航、分镜栏 198px、检查器 277px 与参考几何重合；实际合法 `LINE_CHART` 与原型手绘曲线及缩略封面不同。 |
| QF-05 素材库 | `/w/ws_visual_fixture/assets` | 24.58% | VISUAL REVIEW / NOT COMPARABLE。复拍中已见按素材 ID 稳定变化的暖/绿/蓝封面，以及图表、波形、文档分类示意；合成素材文案/授权和原型演示信息不同，差异率不能当质量退步。 |
| QF-06 创作者身份 | `/w/ws_visual_fixture/identity` | 48.19% | VISUAL REVIEW / NOT COMPARABLE。真实可编辑身份、声音、品牌表单高 2118px，参考 1500px；夹具无已授权 Voice Clone，不能照原型展示可试听的成功身份。 |
| QF-07 成片与审核 | `.../render` | 64.69% | VISUAL REVIEW / NOT COMPARABLE。真实空 Render 与原型演示成片/QA 不同；新增 Master Narration 就绪与费用确认的安全阻断说明使实际页更长。无可信视频或批准不能伪造成功预览。 |
| QF-08 交付与发布 | `.../publish` | 43.73% | VISUAL REVIEW / NOT COMPARABLE。项目封面式包装预览明确是示意，实际无已批准成片与发布记录；发布能力、对账与 Web Handoff 的真实空态比参考演示状态更长，不能用作业务回填。 |
| QF-09 作品表现 | `.../analytics` | 35.22% | VISUAL REVIEW / NOT COMPARABLE。实际无平台真实指标，使用空态和未知值；参考的曲线、数字为演示内容，不可写入真实数据图。 |
| QF-10 扩展工具 | `/w/ws_visual_fixture/extensions` | 3.49% | VISUAL REVIEW / QA PENDING。移除重复卡片下边距后，第二行卡片与页脚恢复参考位置，旧构建差异 6.86%；实际仍按真实能力/安装状态展示，与原型演示标记略异；需交互与权限回归。 |
| QF-11 服务与设置 | `/w/ws_visual_fixture/settings` | 45.76% | VISUAL REVIEW / NOT COMPARABLE。实际完整 Provider/凭据配置表单高 2682px，参考目录式概览高 1679px；无 Secret 被夹具或截图注入。另拍 390px 设置页无横向溢出；预算及成员操作仍需交互检查。 |
| QF-12 产品首页 | `/welcome` | 1.27% | VISUAL REVIEW / QA PENDING。布局和文字层级高度接近；约 3px 全图高度差与动态文案/渲染细节仍待人工核对，CTA 功能单独验证。 |
| QF-13 设计系统 | `/design-system` | 2.53% | VISUAL REVIEW / QA PENDING。三个示例按钮改为真实 Link/Button 后，`final-261008-e` 初始页与前次差异完全相同（2.53%，几何未变）；未登录状态下两个入口点击后进入 `/`，取消显示“没有待取消的操作”。有工作区时 `/w/{id}/new` 分支由聚焦测试覆盖。主题/帮助与只读冲突/授权弹层另有点击证据；公共页仍出现预期两次 401。 |
| QF-14 AI 差异确认抽屉 | `.../storyboard`，第三分镜 + 脚本化计划 | 86.93% | VISUAL REVIEW / NOT COMPARABLE。白底 420px 抽屉、蓝色意图、红/绿前后对比及黑色应用按钮的结构接近；现显示真实请求分镜及计划目标，背景为 `LINE_CHART` 而原型用手绘示意，遮罩放大全图差异。计划只来自隔离夹具。 |
| QF-15 手机创作台 | `/`，390×844 | 12.72% | VISUAL REVIEW / NOT COMPARABLE。响应式单列、菜单/主 CTA/卡片布局接近，零横向溢出；卡片演示文案与合法项目数据不同。 |
| QF-16 手机导演工作台 | `.../storyboard`，第 3 分镜 | 42.37% | VISUAL REVIEW / NOT COMPARABLE。移动导航、场景画布、旁白和底部分镜带结构接近，零横向溢出；真实图表替代手绘图且标题/时长字段遵守 Scene Graph。 |
| QF-17 手机成片审核 | `.../render`，390×844 | 46.44% | VISUAL REVIEW / NOT COMPARABLE。真实空 Render 与安全阻断说明页高 3464px，原型演示已产出内容高 3264px；批准、预览与 QA 无数据不可伪造。零横向溢出。 |
| QF-18 深色创作台 | `/`，dark | 6.24% | VISUAL REVIEW / NOT COMPARABLE。深色主题实际生效，主要几何接近；项目卡演示封面和状态差异同 QF-01。深色值以原型运行 CSS 与截图为准。 |

## 本机截图索引

这些相对链接指向当前工作区中被 Git 忽略的 `.artifacts`，只在保留本轮本机证据的环境可打开；提交文档不会自动上传图片。每行的元数据记录了视口、夹具 SHA、网络异常与精确差异。18 行共 90 个链接已逐一确认指向现存文件。

| 状态 | 参考 | 实际 | 叠图 | 差异 | 元数据 |
|---|---|---|---|---|---|
| 01-workspace | [参考](../../.artifacts/quiet-frame/01-workspace/final-261008-d/reference.png) | [实际](../../.artifacts/quiet-frame/01-workspace/final-261008-d/actual.png) | [叠图](../../.artifacts/quiet-frame/01-workspace/final-261008-d/overlay.png) | [差异](../../.artifacts/quiet-frame/01-workspace/final-261008-d/diff.png) | [元数据](../../.artifacts/quiet-frame/01-workspace/final-261008-d/metadata.json) |
| 02-new-project | [参考](../../.artifacts/quiet-frame/02-new-project/final-261008-d/reference.png) | [实际](../../.artifacts/quiet-frame/02-new-project/final-261008-d/actual.png) | [叠图](../../.artifacts/quiet-frame/02-new-project/final-261008-d/overlay.png) | [差异](../../.artifacts/quiet-frame/02-new-project/final-261008-d/diff.png) | [元数据](../../.artifacts/quiet-frame/02-new-project/final-261008-d/metadata.json) |
| 03-script | [参考](../../.artifacts/quiet-frame/03-script/final-261008-d/reference.png) | [实际](../../.artifacts/quiet-frame/03-script/final-261008-d/actual.png) | [叠图](../../.artifacts/quiet-frame/03-script/final-261008-d/overlay.png) | [差异](../../.artifacts/quiet-frame/03-script/final-261008-d/diff.png) | [元数据](../../.artifacts/quiet-frame/03-script/final-261008-d/metadata.json) |
| 04-director | [参考](../../.artifacts/quiet-frame/04-director/final-261008-d/reference.png) | [实际](../../.artifacts/quiet-frame/04-director/final-261008-d/actual.png) | [叠图](../../.artifacts/quiet-frame/04-director/final-261008-d/overlay.png) | [差异](../../.artifacts/quiet-frame/04-director/final-261008-d/diff.png) | [元数据](../../.artifacts/quiet-frame/04-director/final-261008-d/metadata.json) |
| 05-assets | [参考](../../.artifacts/quiet-frame/05-assets/final-261008-d/reference.png) | [实际](../../.artifacts/quiet-frame/05-assets/final-261008-d/actual.png) | [叠图](../../.artifacts/quiet-frame/05-assets/final-261008-d/overlay.png) | [差异](../../.artifacts/quiet-frame/05-assets/final-261008-d/diff.png) | [元数据](../../.artifacts/quiet-frame/05-assets/final-261008-d/metadata.json) |
| 06-identity | [参考](../../.artifacts/quiet-frame/06-identity/final-261008-d/reference.png) | [实际](../../.artifacts/quiet-frame/06-identity/final-261008-d/actual.png) | [叠图](../../.artifacts/quiet-frame/06-identity/final-261008-d/overlay.png) | [差异](../../.artifacts/quiet-frame/06-identity/final-261008-d/diff.png) | [元数据](../../.artifacts/quiet-frame/06-identity/final-261008-d/metadata.json) |
| 07-review | [参考](../../.artifacts/quiet-frame/07-review/final-261008-d/reference.png) | [实际](../../.artifacts/quiet-frame/07-review/final-261008-d/actual.png) | [叠图](../../.artifacts/quiet-frame/07-review/final-261008-d/overlay.png) | [差异](../../.artifacts/quiet-frame/07-review/final-261008-d/diff.png) | [元数据](../../.artifacts/quiet-frame/07-review/final-261008-d/metadata.json) |
| 08-publishing | [参考](../../.artifacts/quiet-frame/08-publishing/final-261008-d/reference.png) | [实际](../../.artifacts/quiet-frame/08-publishing/final-261008-d/actual.png) | [叠图](../../.artifacts/quiet-frame/08-publishing/final-261008-d/overlay.png) | [差异](../../.artifacts/quiet-frame/08-publishing/final-261008-d/diff.png) | [元数据](../../.artifacts/quiet-frame/08-publishing/final-261008-d/metadata.json) |
| 09-analytics | [参考](../../.artifacts/quiet-frame/09-analytics/final-261008-d/reference.png) | [实际](../../.artifacts/quiet-frame/09-analytics/final-261008-d/actual.png) | [叠图](../../.artifacts/quiet-frame/09-analytics/final-261008-d/overlay.png) | [差异](../../.artifacts/quiet-frame/09-analytics/final-261008-d/diff.png) | [元数据](../../.artifacts/quiet-frame/09-analytics/final-261008-d/metadata.json) |
| 10-extensions | [参考](../../.artifacts/quiet-frame/10-extensions/final-261008-d/reference.png) | [实际](../../.artifacts/quiet-frame/10-extensions/final-261008-d/actual.png) | [叠图](../../.artifacts/quiet-frame/10-extensions/final-261008-d/overlay.png) | [差异](../../.artifacts/quiet-frame/10-extensions/final-261008-d/diff.png) | [元数据](../../.artifacts/quiet-frame/10-extensions/final-261008-d/metadata.json) |
| 11-settings | [参考](../../.artifacts/quiet-frame/11-settings/final-261008-d/reference.png) | [实际](../../.artifacts/quiet-frame/11-settings/final-261008-d/actual.png) | [叠图](../../.artifacts/quiet-frame/11-settings/final-261008-d/overlay.png) | [差异](../../.artifacts/quiet-frame/11-settings/final-261008-d/diff.png) | [元数据](../../.artifacts/quiet-frame/11-settings/final-261008-d/metadata.json) |
| 12-landing | [参考](../../.artifacts/quiet-frame/12-landing/final-261008-d/reference.png) | [实际](../../.artifacts/quiet-frame/12-landing/final-261008-d/actual.png) | [叠图](../../.artifacts/quiet-frame/12-landing/final-261008-d/overlay.png) | [差异](../../.artifacts/quiet-frame/12-landing/final-261008-d/diff.png) | [元数据](../../.artifacts/quiet-frame/12-landing/final-261008-d/metadata.json) |
| 13-design-system | [参考](../../.artifacts/quiet-frame/13-design-system/final-261008-e/reference.png) | [实际](../../.artifacts/quiet-frame/13-design-system/final-261008-e/actual.png) | [叠图](../../.artifacts/quiet-frame/13-design-system/final-261008-e/overlay.png) | [差异](../../.artifacts/quiet-frame/13-design-system/final-261008-e/diff.png) | [元数据](../../.artifacts/quiet-frame/13-design-system/final-261008-e/metadata.json) |
| 14-ai-diff | [参考](../../.artifacts/quiet-frame/14-ai-diff/final-261008-d/reference.png) | [实际](../../.artifacts/quiet-frame/14-ai-diff/final-261008-d/actual.png) | [叠图](../../.artifacts/quiet-frame/14-ai-diff/final-261008-d/overlay.png) | [差异](../../.artifacts/quiet-frame/14-ai-diff/final-261008-d/diff.png) | [元数据](../../.artifacts/quiet-frame/14-ai-diff/final-261008-d/metadata.json) |
| 15-mobile-workspace | [参考](../../.artifacts/quiet-frame/15-mobile-workspace/final-261008-d/reference.png) | [实际](../../.artifacts/quiet-frame/15-mobile-workspace/final-261008-d/actual.png) | [叠图](../../.artifacts/quiet-frame/15-mobile-workspace/final-261008-d/overlay.png) | [差异](../../.artifacts/quiet-frame/15-mobile-workspace/final-261008-d/diff.png) | [元数据](../../.artifacts/quiet-frame/15-mobile-workspace/final-261008-d/metadata.json) |
| 16-mobile-director | [参考](../../.artifacts/quiet-frame/16-mobile-director/final-261008-d/reference.png) | [实际](../../.artifacts/quiet-frame/16-mobile-director/final-261008-d/actual.png) | [叠图](../../.artifacts/quiet-frame/16-mobile-director/final-261008-d/overlay.png) | [差异](../../.artifacts/quiet-frame/16-mobile-director/final-261008-d/diff.png) | [元数据](../../.artifacts/quiet-frame/16-mobile-director/final-261008-d/metadata.json) |
| 17-mobile-review | [参考](../../.artifacts/quiet-frame/17-mobile-review/final-261008-d/reference.png) | [实际](../../.artifacts/quiet-frame/17-mobile-review/final-261008-d/actual.png) | [叠图](../../.artifacts/quiet-frame/17-mobile-review/final-261008-d/overlay.png) | [差异](../../.artifacts/quiet-frame/17-mobile-review/final-261008-d/diff.png) | [元数据](../../.artifacts/quiet-frame/17-mobile-review/final-261008-d/metadata.json) |
| 18-dark-workspace | [参考](../../.artifacts/quiet-frame/18-dark-workspace/final-261008-d/reference.png) | [实际](../../.artifacts/quiet-frame/18-dark-workspace/final-261008-d/actual.png) | [叠图](../../.artifacts/quiet-frame/18-dark-workspace/final-261008-d/overlay.png) | [差异](../../.artifacts/quiet-frame/18-dark-workspace/final-261008-d/diff.png) | [元数据](../../.artifacts/quiet-frame/18-dark-workspace/final-261008-d/metadata.json) |

## 弹层与适配视口证据

| 状态 | 实际截图与元数据 | 观察结果 |
|---|---|---|
| QF-13 版本冲突说明 | [实际](../../.artifacts/quiet-frame/13-design-system/design-conflict-261008-c/actual-fold.png) · [元数据](../../.artifacts/quiet-frame/13-design-system/design-conflict-261008-c/metadata.json) | 原生 modal 居中：1600px 视口下 x=540px、宽 520px；Esc 和关闭按钮可关闭，Esc 后焦点回到触发按钮。演示差异不保存或覆盖真实作品。 |
| QF-13 声音授权说明 | [实际](../../.artifacts/quiet-frame/13-design-system/design-consent-261008-c/actual-fold.png) · [元数据](../../.artifacts/quiet-frame/13-design-system/design-consent-261008-c/metadata.json) | 同宽居中；Esc 和关闭按钮可关闭，焦点返回。公共页无工作区时链接创作台，不接收样本或提交授权。两次未登录 API 401 与主状态一致。 |
| QF-13 示例按钮 | [取消说明截图](../../.artifacts/quiet-frame/13-design-system/final-261008-e/cancel-note.png) · [点击记录](../../.artifacts/quiet-frame/13-design-system/final-261008-e/interaction-check.json) | 最终构建的未登录公开页上，“开始创作”和“生成草稿”均为 `href="/"`，逐项点击后进入创作台；“取消”只显示没有待取消操作的说明。请求拦截记录非 GET 写入 0；有工作区时到 `/w/{id}/new` 由 Web 聚焦测试覆盖，未用真实账号或项目测试。 |
| QF-10 扩展详情 | [实际](../../.artifacts/quiet-frame/10-extensions/extensions-detail-261008-c/actual-fold.png) · [元数据](../../.artifacts/quiet-frame/10-extensions/extensions-detail-261008-c/metadata.json) | 520px 原生 modal 居中；Esc 与关闭按钮均可关闭。隔离夹具显示未安装状态，没有启用写请求。 |
| QF-11 设置 390px | [实际](../../.artifacts/quiet-frame/11-settings/settings-mobile-261008-a/actual.png) · [元数据](../../.artifacts/quiet-frame/11-settings/settings-mobile-261008-a/metadata.json) | 横向溢出 0；设置完整表单可纵向滚动。 |
| 项目素材 Finance 展开桌面 / 390px | [桌面](../../.artifacts/quiet-frame/05-assets/finance-desktop-261008-a/actual.png) · [手机](../../.artifacts/quiet-frame/05-assets/finance-mobile-261008-a/actual.png) · [桌面元数据](../../.artifacts/quiet-frame/05-assets/finance-desktop-261008-a/metadata.json) · [手机元数据](../../.artifacts/quiet-frame/05-assets/finance-mobile-261008-a/metadata.json) | `ADAPTED / NOT COMPARABLE`；两个视口横向溢出 0，三个表单在 390px 单列，未提交真实数据源、模板或图表任务。 |
| 导演工作台 768px | [实际](../../.artifacts/quiet-frame/16-mobile-director/director-768-261008-b/actual.png) · [元数据](../../.artifacts/quiet-frame/16-mobile-director/director-768-261008-b/metadata.json) | 横向溢出 0；底部时间轴仅在自身滚动区域内横向浏览。 |

上述弹层打开态均为实际 Web 截图；参考原型按钮会打开对应的演示弹层，已在 4100 Chromium 中逐项点击核对。弹层定位、Esc、关闭按钮与焦点结果另以 Playwright 浏览器交互复核，未触发写请求。公开 QF-13 两次 401 是预期未认证探测。

## 需要处理的偏差及不可比边界

1. **已复拍的视觉修正**：QF-05 分类素材缩略图按稳定素材 ID 显示暖/绿/蓝等示意；QF-10 移除重复卡片间距后差异从 6.86% 降至 3.49%；QF-13 补齐两个可点击状态动作后差异从 7.87% 降至 2.53%。QF-05 合成素材与原型信息仍不相同；QF-13 弹层属独立交互证据，不能由初始截图替代。
2. **原型演示数据与公共 DTO 的结构差异**：QF-01/15/18 的封面标题与底部项目标题在原型中分开配置，实际 `Project` 只有 `title`，封面只能复用它。示意状态、时长、封面短句不是合法服务端事实。保留当前生产文案语义，不为像素匹配植入虚假项目。
3. **画面资产差异**：QF-04/14/16 原型参考为手绘趋势图和示意插画，实际预览由已注册 `LINE_CHART` 与 `HOST_FULL` Scene Component 渲染。夹具中的数值明示为“设计示意 / 非真实业务数据”，不作为事实图表来源，不参与 Render/导出。原型第 3 分镜 32 秒超过当前折线图组件 30 秒上限，夹具采用 30 秒并保持整片 4:32。
4. **真实空态优先**：QF-06/07/08/09/17 参考图含声音、成片、批准、发布或分析的演示成功状态。当前隔离夹具没有真实授权样本、可信成片、批准快照或平台指标，因此这几页只能比较壳层和空态，不可比较成功态像素。要验证成功态，需要合法数据库/Provider/资产与独立业务证据；本轮未执行。
5. **设置页内容范围**：QF-11 真实实现包含 Provider 逐项配置和下方详细表单，原型是较短的服务概览；应按用户工作流继续做权限、掩码、空态与错误回归，不能通过隐藏真实设置内容来降低像素差。
6. **额外适配状态**：项目素材 `P/assets` 内的 Finance 展开桌面/390px、QF-11 设置 390px 与导演 768px 截图均无横向溢出，且没有页面异常或写请求。Finance 面板是按需入口，参考包没有对应展开原图，标 `ADAPTED / NOT COMPARABLE`；合成空表单不能代替真实数据源、许可或生成产物验证。

## 后续验收

- 若其它页面的 CSS 随后续构建发生变化，按受影响状态重拍并记录新的不可变 run ID；不覆盖本轮证据。
- 逐项执行 [INTERACTION_QA_MATRIX.md](INTERACTION_QA_MATRIX.md) 的导航、保存、权限、错误与移动交互。当前矩阵的 `NOT RUN` 不应因静态截图改为通过。
- 在真实业务数据与授权环境中分别验证 Render READY/批准/发布、素材来源与许可、Voice Clone 状态、表现数据。隔离夹具截图绝不等于第三方或后端实测。
- 用户要求 Web 完整验收后暂停，待用户亲自检查测试再推进 P15/P16；本报告不把响应式 Web 的 QF-15～17 记为原生端任务完成。
