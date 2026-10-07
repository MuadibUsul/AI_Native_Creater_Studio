# Quiet Frame 交互与视觉 QA 矩阵

建立日期：2026-10-07；更新日期：2026-10-08。状态以本次运行证据为准。包内 `handoff/QA_REPORT.*` 仅证明原设计原型此前做过检查，不计入现有 Web 的通过数。**PARTIAL** 只覆盖该行注明的子场景；没有任何一行可据此宣称完整业务端到端或 1:1 视觉验收通过。

证据层级：**B** = 生产 Next + Chromium + 本地 Fastify/API + 独立 PostgreSQL 测试库的 `scripts/quiet-frame-browser-smoke.mjs`，叙事生成注入 Mock LLM、本地对象存储，不使用第三方 Provider；**W** = `pnpm test:web`，27 文件、138/138 通过，Web/jsdom 注入 SDK 替身，不证明真实 API 持久化；**V** = QF-01～18 原型与实际页的同环境视觉截图，私有页使用仅在 Playwright 生效的 `SYNTHETIC_VISUAL_ONLY` DTO 拦截，不证明真实业务写入或像素验收通过。第三方 CMS、Voice Clone、渲染、发布、支付均未实测。

## 环境与证据规则

- 原型：只读 `docs/design-reference/quiet-frame/a04a074c62f0/ANCS_Quiet_Frame/index.html`，本地静态服务 `127.0.0.1:4100`。视觉截图使用真实 Next 路由，但私有页的 API 读取由 `SYNTHETIC_VISUAL_ONLY` 网络夹具拦截；独立浏览器 smoke 才使用本地测试会话与测试库。Fixture 只通过测试运行环境/网络拦截启用，不作为生产默认，也不通过公开 URL 参数绕过鉴权。
- 视觉原始视口：桌面 1600×1000、DPR 1.5；手机 390×844、DPR 2。额外边界：390×844、768×1024、1280×800、1440×900、1920×1080；原型还在 320 宽有断点，需检查。记录浏览器版本、OS、DPR、缩放、字体、语言、时区、时间、滚动、主题和选中状态。
- 同一状态产生 `reference.png`、`actual.png`、`overlay.png`、`diff.png`、`metadata.json`。不修改 ZIP 原图、不裁失败区域、不放宽像素阈值；以零差异为目标，任何非零差异须审图并登记。无相同数据/状态时标 **NOT COMPARABLE**，不能用相似度宣称视觉通过。
- 业务检查区分 **原型/视觉 fixture**、**真实本地 API 与测试数据库**、**第三方服务**。付费生成、真实购买、真实发布、真实 Voice Clone 不用于视觉验收。HTTP 错误、console/pageerror、资源 404、hydration 警告和请求失败应留存本次日志。
- 视觉截图工具为 `scripts/quiet-frame-visual.mjs`（Playwright）与 `scripts/quiet-frame-diff.py`（Pillow），证据在 Git 忽略的 `.artifacts/quiet-frame/`。真实 API 浏览器流程用 `scripts/quiet-frame-browser-smoke.mjs`，证据在 `.artifacts/quiet-frame-rebuild/browser-smoke/`。视觉运行命令与结果见 `VISUAL_PARITY_REPORT.md`、`VISUAL_REGRESSION.md`。

## 页面与主要交互

| ID | 页面/状态与操作 | 真实应用验收点 | 权限、失败或冲突 | 参考 | 类型 | 当前 |
|---|---|---|---|---|---|---|
| IQ-01 | 创作台：0/1/多项目、新建入口、继续项目 | 真实项目列表和阶段；任何数量仍可新建；刷新/回退恢复上下文 | 401/403/空/查询失败，切换租户不闪旧项目 | QF-01/15/18 | API + 视觉 | **PARTIAL B/W/V**：B 覆盖空工作区→建作品与新建页刷新，W 覆盖项目列表；多项目、浏览器回退及跨租户路径未跑，截图数据不可比。 |
| IQ-02 | 工作区切换与项目卡入口 | 当前项目、预算、身份与权限随工作区改变；旧链接安全处理 | 跨租户项目统一不可枚举；受限角色只读 | QF-01 | API + 视觉 | **PARTIAL W/V**：工作区深链接保留与导航在 SDK 替身测试中通过；B 仅有单工作区，跨租户和旧链接未跑。 |
| IQ-03 | 新建：URL/粘贴/文件标签、表单 | 已支持输入接真实摄取；标题、时长、声音选择按 contract；重复点击仅一次逻辑请求 | 解析失败保留原输入；不支持格式/扫描失败/预算限制有原因 | QF-02 | API + 视觉 | **PARTIAL B/W/V**：真实 API 粘贴正文、持久化与刷新恢复通过；URL/文件、扫描和预算仅有 SDK 替身边界或未跑。 |
| IQ-04 | 脚本：大纲、正文、来源定位 | 真实 narrative 与引用；数字/引用回到来源，关联与核验分开 | 来源缺失/读取失败局部提示 | QF-03 | API + 视觉 | **PARTIAL B/W/V**：Mock LLM 生成后脚本深链刷新通过；来源/引用由 Web 替身测试覆盖，真实 Provider 与逐条事实核验未跑。 |
| IQ-05 | 脚本：编辑、锁定/解锁、保存 | 修改经服务端更新，锁定段落不可偷改，保存状态真实 | 只读/409/网络失败保留未提交文本 | QF-03 | API + 视觉 | **PARTIAL W/V**：锁定、409 与草稿保留经 SDK 替身测试；真实浏览器保存/冲突未跑。 |
| IQ-06 | 导演：场景选择、画布、旁白、检查器 | Scene Graph 和真实播放器同源；选择与播放位置合理保持；三栏独立滚动 | 场景空、素材缺失/URL 过期、只读/锁定 | QF-04/16 | API + 视觉 | **PARTIAL W/V**：同源预览、选中与只读路径有组件测试，原型/合成场景有截图；真实 DB 场景播放与滚动未跑。 |
| IQ-07 | 场景 deep link、属性编辑、排序/时间线 | 旧 `editor/[sceneId]` 有效；编辑与排序写回同一图；撤销/重做可追溯 | stale revision/锁定不能覆盖；草稿可恢复 | QF-04 | API + 视觉 | **PARTIAL W/V**：场景编辑、409、时间线协议由 SDK 替身测试覆盖；真实浏览器 `editor/[sceneId]`、撤销/重做未跑。 |
| IQ-08 | AI 修改：发起计划、差异、拒绝、确认 | 展示真实前后差异、范围、警告/费用；只有确认提交，拒绝零副作用 | 锁定、计划过期、权限、报价变化、失败保留上下文 | QF-14 | API + 视觉 | **PARTIAL W/V**：确认前零写入/冲突在替身测试通过；QF-14 只用一次脚本化计划响应，无真实 AI 计划/应用端到端。 |
| IQ-09 | 素材：分类、搜索、详情、上传/回绑 | 来源/许可、关联版本、真实上传和签名下载；选择替换生效 | 跨租户不可见、许可不足、上传/下载失败可恢复 | QF-05 | API + 视觉 | **PARTIAL B/W/V**：工作区与项目素材路由及真实空态通过；签名上传/回绑仅替身测试，真实文件/许可/下载未跑。 |
| IQ-10 | 创作者身份：声音/主持/品牌 | 身份状态、试听与品牌更新使用真实能力；未连接说明限制 | 克隆同意、样本、撤销、删除；无授权不可提交 | QF-06 | API + 视觉 | **PARTIAL B/W/V**：真实 API 下初始身份表单空态可达；创建/授权流程仅替身测试，真实克隆 Provider 未跑。 |
| IQ-11 | 成片：预检、规格、生成确认与 Job | 服务端报价/预算、队列和失败状态真实；无进度百分比时只显示阶段 | 报价缺失、预算不足、Provider 不可用、重复请求无重复收费 | QF-07/17 | API + 视觉 | **PARTIAL B/W/V**：无成片空态与预检阻断的替身测试通过；真实报价、Job、Render 和收费未跑。 |
| IQ-12 | QA：检查清单、blocker/warning、定位修复 | QA 报告来自服务端，blocker 阻止批准；重新渲染有明确路径 | QA 失败/报告缺失/取消等状态可区分 | QF-07/17 | API + 视觉 | **PARTIAL B/W/V**：真实无报告空态、替身 blocker/报告测试通过；真实 QA 报告与修复链路未跑。 |
| IQ-13 | 人工批准、退回、编辑后失效 | 批准绑定 render manifest；退回有备注，草稿变化不改已批准文件 | 未 READY/未 QA/权限不足不能批准；旧批准不导出新内容 | QF-07/17 | API + 视觉 | **PARTIAL W/V**：批准/退回闸门由 SDK 替身测试覆盖；B 无 READY Render，真实批准与失效未跑。 |
| IQ-14 | 交付包、平台能力、发布/对账、手机交接 | P1–P4 与后端核验一致；P4 由人完成最后一步；交接限时可撤销 | 未授权/未批准不开放；DRAFT≠PUBLISHED；UNKNOWN 先 reconcile | QF-08 | API + 视觉 | **PARTIAL B/W/V**：发布页真实空态及替身测试中的未批准闸门/过期链接通过；实际交付包、发布、对账、手机交接未跑。 |
| IQ-15 | 作品表现：指标、留存、学习建议 | 真实采样范围、冻结版本；未知显示“—”；接受建议不静默改栏目 | 平台无数据、低样本、采集失败；Finance 故障不遮蔽表现 | QF-09 | API + 视觉 | **PARTIAL B/W/V**：真实无平台数据空态、未知值/采样绘制单元测试通过；平台采集和建议采纳未跑。 |
| IQ-16 | 扩展：能力目录与启用前说明 | 支持状态、范围、费用、撤销来自真实能力；未接入显示不可用 | 无权限/无配额不弹假成功或付费任务 | QF-10 | API + 视觉 | **PARTIAL B/W/V**：扩展页真实 API 可达、安装状态的替身测试通过；实际启用/撤销和付费能力未跑。 |
| IQ-17 | 设置：服务模式、团队、预算、隐私、外观 | 旧团队/账单路径仍可达；凭据仅掩码；角色/席位约束 | 普通成员只读、额度未知/不足、服务故障可区分 | QF-11 | API + 视觉 | **PARTIAL B/W/V**：设置/团队/账单真实路由与空态可达；预算、掩码、角色、席位由替身测试覆盖，跨角色真实 API 操作未跑。 |
| IQ-18 | 产品首页和设计系统 | 公共入口/登录跳转真实；展示组件与产品使用同一 token | 不展示虚构客户、指标或未验收能力声明 | QF-12/13 | 公共页 + 视觉 | **PARTIAL W/V**：公开页/设计系统已实拍；QF-13 三个示例动作有真实 Chromium 点击证据（无工作区时两个入口去 `/`，取消只显示说明），有工作区路由分支经组件测试。B 未执行公共 CTA 全链路，1:1 视觉尚未通过。 |

## 弹层、键盘、主题与布局

| ID | 操作/状态 | 验收点 | 参考 | 当前 |
|---|---|---|---|---|
| IQ-19 | 主导航、次级导航、浏览器前进/后退、深链接 | URL 与页面/项目/场景一致；返回后选中项保持 | 原型 `#home/#script/#editor` 等 | **PARTIAL B/W**：脚本深链刷新及 11 个次级路由直接访问通过；浏览器前进/后退、场景深链未跑。 |
| IQ-20 | Cmd/Ctrl+K 搜索；搜索结果选择 | 搜索打开、过滤、跳转，焦点进入输入框 | 原型命令弹窗，无独立 PNG | **PARTIAL W**：快捷键、过滤、Esc 和焦点返回的组件测试通过；真实浏览器未跑。 |
| IQ-21 | Dialog/Drawer：主按钮、关闭、Esc、遮罩、Tab | 可打开/关闭，焦点被约束并在关闭后返回触发项；没有死按钮 | QF-14 及未截图弹层 | **PARTIAL W/V**：素材弹层焦点与 Esc 经组件测试；QF-10 扩展详情、QF-13 冲突/授权原生弹层在真实 Chromium 中已检查居中、Esc、关闭与焦点返回，AI 抽屉有隔离夹具截图。其余弹层的 Tab 约束、遮罩点击及真实业务路径未跑。 |
| IQ-22 | 文件选择、表单校验、提交中、取消 | 类型/大小与服务端一致；提交中防重复，失败保留字段 | QF-02/05 | **PARTIAL B/W**：真实浏览器粘贴提交通过；文件上限、失败保留与上传调用为替身测试，实际文件/取消未跑。 |
| IQ-23 | 场景选择、排序、面板开合、AI 差异确认 | 键盘/鼠标操作一致；切换面板不丢场景或草稿 | QF-04/14/16 | **PARTIAL W/V**：选择、排序、确认协议在组件测试与视觉夹具可见；真实浏览器键盘/鼠标持久化未跑。 |
| IQ-24 | 浅/深色切换 | 深色以原型 CSS 和 QF-18 原图为准；所有页面文本/控件可读 | QF-18，其他深色无原图 | **PARTIAL W/V**：主题按钮测试和 QF-18 深色截图已拍；其余页面深色可读性未逐页检查。 |
| IQ-25 | 390×844、768×1024、1280×800、1440×900、1600×1000、1920×1080、320 宽 | 不横向溢出、按钮/弹窗不截断；画布比例和主操作保持 | QF-15～17；其余需新拍原型 | **PARTIAL B/V**：既有视觉采集覆盖 1600×1000、390×844，B 覆盖 1440×900。新增合成夹具浏览器审计覆盖创作台、导演、成片、设置、展开 Finance 五页 × 320/390/768/1280/1920 宽，共 25/25：最终构建整页横向溢出 0、所识别主操作横向裁切 0、浏览器异常/夹具未命中 0。导演 768 的时间线可在局部水平滚动（282px 容器、679px 内容）。弹层裁切、各页真实数据和全部画布比例仍未逐项验收。 |
| IQ-26 | 长标题、长文件名、中文换行、空字段和大数值 | 不遮挡/误截断，不把未知数值当 0 | 原图未覆盖，适配状态 | **NOT RUN**：无专门边界数据和视觉证据。 |
| IQ-27 | reduced motion、hover/focus-visible/disabled | 系统偏好生效；键盘焦点可见；状态有文字，不只靠颜色 | 原型 CSS 与实际交互 | **PARTIAL W/V**：视觉采集启用 reduced motion；部分焦点/禁用组件测试通过；hover 与全页键盘可达未跑。 |
| IQ-28 | 加载、局部错误、离线、403、409、Provider 不可用 | 按影响范围显示原因和可执行恢复动作；不清空未提交草稿 | 设计说明 §5，原图不足 | **PARTIAL W**：401、失败重试、409 草稿保留等用 SDK 替身覆盖；浏览器离线、真实 403 与 Provider 故障未跑。 |

## 截图对照与运行记录

逐个 QF-01～18 运行视觉脚本时记录：操作步骤、原型 URL/应用路由、视口和 DPR、浏览器版本/OS、字体解析、主题、语言/时区/冻结时间、滚动与选中项、fixture 来源、文件 SHA、差异像素/比例与关键组件坐标。全页图之外另检查首屏及主要局部。任一截图数据不同、真实业务未接通或服务不可用，应在 `VISUAL_PARITY_REPORT.md` 分别标注 **NOT COMPARABLE**、**FUNCTION BLOCKED** 或 **NOT RUN**，不能填 PASS。

### 工具用法与已运行的基准检查

工具要求 Node ≥22、仓库开发依赖 Playwright 1.61.1、Python 3.10+ 与 Pillow 10.2.0（其他环境可执行 `python -m pip install Pillow==10.2.0`）。浏览器默认使用 Playwright 已安装的 Chromium；可用 `--browser-executable` 指向本机浏览器，脚本不会自动下载浏览器。若浏览器缓存缺失，需明确安装对应 Playwright Chromium 后再跑，不在脚本中隐式下载。原型服务目前是 `http://127.0.0.1:4100/index.html`。输出只落在 Git 忽略的 `.artifacts/quiet-frame/<case>/<run-id>/`，已有 run ID 不覆盖。默认固定 `zh-CN`、`Asia/Shanghai`、`2026-10-07T12:00:00+08:00`、缩放 1、reduced motion；元数据记录实际 Chromium 版本、字体、关键元素尺寸和浏览器异常。Pillow 比较使用 RGB 精确零容差，尺寸不等时把缺失面积计入差异，绝不裁切或遮罩。

`--mode compare` 在同一 Chromium 中分别拍 `reference.png` 和 `actual.png`，再生成 `overlay.png`、`diff.png` 与指标；同时留存两张首屏图。实际页面需要等待数据时传 `--ready-selector`；需要进入抽屉、深色主题或选择场景时可重复传 `--actual-action CSS_SELECTOR`，动作只作用于本地测试浏览器。应用数据和原型演示数据是否相同仍需人工核对，脚本不会仅凭低差异自动标 PASS。

```powershell
# 查看 18 个原始页面/状态 ID
pnpm visual:qf --list

# 原型同环境重拍；18 个 case 各自运行，选择唯一 run ID
pnpm visual:qf --case 01-workspace --mode reference --run-id baseline-local-261007

# 公开页对照的重跑示例；已拍结果见 VISUAL_PARITY_REPORT.md
pnpm visual:qf --case 12-landing --mode compare --actual-url http://127.0.0.1:4000/welcome --data-label public --ready-selector main

# 私有页只对隔离的测试工作区使用；storage state 必须位于 .artifacts/quiet-frame 内
# fixture-id 是测试数据集标识，不是将 Mock 数据装入生产 UI 的开关
pnpm visual:qf --case 04-director --mode compare --actual-url http://127.0.0.1:4000/w/TEST_WS/p/TEST_PROJECT/storyboard --data-label isolated-fixture --fixture-id qf-studio-v1 --storage-state .artifacts/quiet-frame/test-auth.json --ready-selector main

# 响应式审计仅拦截并使用 SYNTHETIC_VISUAL_ONLY 夹具，不访问真实 API/DB；run ID 必须唯一
pnpm visual:qf:responsive --run-id your-unique-run-id
# 可只复测一个页面与宽度，例如导演工作台 768px
pnpm visual:qf:responsive --run-id your-other-unique-run-id --scenario director --width 768
```

当前真实执行结果：

| 命令/检查 | 结果 | 证据与边界 |
|---|---|---|
| `pnpm visual:qf --list`、`node --check scripts/quiet-frame-visual.mjs`、Python AST 解析、针对脚本的 ESLint | 退出码 0 | 只验证工具语法和静态检查 |
| 18 个 `--mode reference --run-id baseline-local-261007` | 18/18 退出码 0；各自 1 张全页、1 张首屏、1 份元数据；18 份均无 pageerror/console error/HTTP≥400/requestfailed | `.artifacts/quiet-frame/<case>/baseline-local-261007/`；本行仅记录参考原型重拍，实际应用证据见下方对照行。 |
| `--case 12-landing --mode compare --actual-url http://127.0.0.1:4100/index.html#welcome --data-label harness-selftest` | 同一原型双拍：3,928,800 像素中差异 0；退出码 0 | `.artifacts/quiet-frame/12-landing/harness-zero-check/`；仅为截屏/差异算法自检，不是应用验收 |
| 原包 `screens/01-workspace.png` vs 本机 Chromium 重拍 QF-01 | 3,650,400 像素中差异 415,428（11.38%）；原图 2400×1521、本机图 2400×1520 | `.artifacts/quiet-frame/original-vs-local-home/`；已目视查看 diff，文字与图形边缘为主要差异，属于原始截图与本机环境不一致的证据，不能拿旧图与新应用直接判定实现问题 |
| 18 状态参考/实际视觉对照 | 18/18 有 `reference.png`、`actual.png`、首屏图、叠图、差异图与元数据；**1:1 验收未通过** | 最终 17 状态为 `.artifacts/quiet-frame/<case>/final-261008-d/`，QF-13 示例按钮复拍为 `final-261008-e/`；私有页使用 `SYNTHETIC_VISUAL_ONLY` 网络夹具，非真实 DB/Provider 证据。逐项可点击索引见 `VISUAL_PARITY_REPORT.md`。 |
| `pnpm verify`（最新源码） | 退出码 0；secrets、lint、typecheck、build、arch 与各已实现测试套件均 PASS；其中 Web 27 文件、138/138 项通过 | [最终验证日志](../../.artifacts/quiet-frame-rebuild/verify-final-261008-e.log)；`[PLANNED]` 套件不执行断言。Web 为 jsdom + SDK 替身，不证明真实 API 持久化。 |
| `ANCS_TEST_DATABASE_URL=…ancs_quiet_frame_test_261007 node scripts/quiet-frame-browser-smoke.mjs` | 最新源码构建的主链路与 11 个次级路由通过，退出码 0；0 `pageerror`、0 hydration 错误 | 生产 Next + Chromium + 本地 Fastify/API + 独立 PostgreSQL；Mock LLM 生成脚本、本地对象存储。[主链路截图](../../.artifacts/quiet-frame-rebuild/browser-smoke/qf-smoke-3614b8ed-d968-4e1b-9241-80118fb206f4.png)、同名 `-routes/` 的 11 张路由截图与[运行日志](../../.artifacts/quiet-frame-rebuild/browser-smoke-final-261008-c.log)。无真实 Provider/发布/支付。 |
| `pnpm visual:qf:responsive --run-id 261008-final-cli` | 退出码 0；5 页 × 5 宽 = 25/25 截图和 JSON；整页横向溢出 0、主操作横向裁切 0、浏览器异常/夹具未命中/外部请求 0 | `.artifacts/quiet-frame/responsive-audit/261008-final-cli/`，含 `report.json` 和 25 张全页 PNG；Chromium 149.0.7827.55、DPR 1、`zh-CN`、`Asia/Shanghai`、固定时间与 reduced motion。只用 `SYNTHETIC_VISUAL_ONLY` 网络夹具，未触及真实 DB/Provider。导演 768 时间线局部 `clientWidth=282`、`scrollWidth=679`、`overflow-x=auto` 且可滚动。 |
| `node --check scripts/quiet-frame-responsive-audit.mjs`、`pnpm exec eslint scripts/quiet-frame-responsive-audit.mjs`、`pnpm visual:qf:responsive --run-id 261008-tool-check --scenario director --width 768` | 均退出码 0；同一 run ID 再执行以 `EEXIST` 退出码 1，确认拒绝覆盖 | 可复用工具只接受本地 HTTP 应用 URL，API 请求由合成夹具拦截，非夹具外部请求会被阻断并记录。定向报告位于 `.artifacts/quiet-frame/responsive-audit/261008-tool-check/`。 |

初轮本机响应式审计曾在导演 768 观察到页面 `scrollWidth=918`（视口 768，超出 150px）。随后的临时定向复测误覆盖初轮 `report.json` 和该张 PNG，因此 `.artifacts/quiet-frame/responsive-audit-261007/` 不能作为完整 25 组证据；最终结论只引用独立且拒绝覆盖的 `261008-final-cli` run。该问题修复后，时间线保留局部滚动，整页宽度回到 768px。

本机参考与实际页面采集使用 Windows、Chromium 149.0.7827.55、桌面 1600×1000/DPR 1.5 与手机 390×844/DPR 2；中文标题实际解析为 Microsoft YaHei（设计系统页英文标题还用了 Segoe UI Semibold）。真实 API 浏览器 smoke 使用 1440×900、`zh-CN`、`Asia/Shanghai`。`--viewport WIDTHxHEIGHT` 和 `--dpr` 可覆盖以检查额外断点。深色 QF-18 与 AI 抽屉 QF-14 已按原型交互状态拍摄，源 ZIP 图片只读且未改。
