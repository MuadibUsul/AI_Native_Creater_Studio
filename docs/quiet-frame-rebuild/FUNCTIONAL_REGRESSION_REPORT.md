# Quiet Frame 功能回归记录

更新：2026-10-08。核对对象为当前工作树的 Web 接线及已留存运行证据。命令搜索重复 React key 修复后的 `pnpm verify` 已退出 0，最终日志为 `verify-final-261008-e.log`，其中 Web **27 文件、138 项通过**。最新源码浏览器 smoke 也已退出 0，日志为 `browser-smoke-final-261008-c.log`；精确范围见 §3。**完整业务验收尚未完成：Master Narration 合成与新建 Render 仍有后端安全阻塞，Voice Clone 仅开放当前可控的生命周期操作。**

## 1. 证据口径

- **代码接线**：页面确实调用现有 SDK/API，只说明入口与数据流存在。
- **W / Web 组件测试**：jsdom 注入 SDK 替身，检查交互、请求参数与错误分支；不证明 API 持久化、Provider 或实际费用。
- **B / 浏览器 smoke**：production Next + Chromium + 本地 Fastify/API + 独立 PostgreSQL 测试库；叙事使用 Mock LLM、文件使用本地对象存储。实际本地读写成立，第三方能力未实测。
- **V / 视觉截图**：私有页使用 `SYNTHETIC_VISUAL_ONLY` 隔离 DTO；只供布局/交互对照，不作为真实授权、资产、声音、成片或发布证据。18 状态已按 `final-261008-d` 复拍，QF-13 最新为 `final-261008-e`；1:1 视觉验收仍未通过，见 [VISUAL_PARITY_REPORT.md](VISUAL_PARITY_REPORT.md)。
- 本次文档更新仅核对源码和日志，没有重跑数据库测试或浏览器 smoke。最新全量结果已直接核对 e 日志，并由主流程确认退出码 0；浏览器证据仍按实际运行版本分别记录。

## 2. 当前已接线范围

记号：`W = /w/[workspaceId]`，`P = W/p/[projectId]`。细项见 [ROUTE_AND_FEATURE_MAP.md](ROUTE_AND_FEATURE_MAP.md)。表中“已接线”不等于整行验收通过。

| 页面/范围 | 当前实现 | 已有证据及未覆盖部分 |
|---|---|---|
| 会话、创作台、工作区与项目 | SDK 会话与工作区/项目读取、切换、新建入口；同源 `/api/v1` 代理保留 Cookie；导航保持工作区上下文 | W 覆盖导航/传输边界；B 覆盖登录、一个工作区及项目创建。真实跨租户、受限角色与多项目回退待检查 |
| `W/new` 新建作品 | URL、粘贴及 contract 支持的文件走摄取；创建幂等、来源快照、正文预览和确认后生成脚本 | B 覆盖粘贴、持久化、刷新恢复和 Mock LLM 生成；真实 URL/文件失败恢复、实际 Provider/费用未验证 |
| `P/script` 脚本与来源 | narrative、段落编辑/锁定、revision、来源/引用；冲突保留待保存文本；来源关联不等于事实核验 | W 覆盖编辑与冲突；B 覆盖脚本深链接刷新。真实浏览器并发保存/锁定待检查 |
| `P/storyboard` 与旧 editor 深链接 | Scene Graph、同源组件预览、场景选择、属性/锁定、复制、轻时间线、历史；READY 且有版本的项目素材可作为替换候选，绑定资产使用短期预览 URL | W 覆盖组件与编辑协议；B 未建立真实场景。素材替换、播放、排序与撤销的实际持久化待检查 |
| Director 与 AI 差异 | 空图先预览场景/素材需求/任务/费用/告警，再确认应用；未知费用/阻断项禁止应用。AI 请求含选中分镜，抽屉显示请求目标和计划实际影响，跨场景影响提示后经编辑协议确认 | W 覆盖预览前零写入、确认、409 和未知费用；V 的 AI 计划为脚本化响应。目标提示不是服务端硬隔离，实际计划/锁定/费用变化仍需核验 |
| `W/assets` / `P/assets` 素材 | 按作用域读取、分类搜索、文件签名上传、详情/许可/版本、受控下载；外部产物任务引用与上传后回绑入口已接 | W 覆盖请求与错误边界；B 仅覆盖真实空态。真实文件、许可、回绑及签名链接生命周期待检查 |
| 项目素材页 Finance | Finance 来源/模板/产物放在按需展开区域，复用 `FinanceWorkspace`；未展开不加载，产物不自动绑定分镜；错误不遮蔽素材 | W 覆盖故障隔离；真实来源许可、单位、版本模板与生成未实测 |
| `W/identity` 身份 | 身份/品牌/表达风格、授权声明确认/撤销；样本查询用 `VOICE_AUDIO`，仅 READY 且有 currentVersionId 的资产可送检；试听明确为浏览器系统语音 | W 覆盖创建、授权与样本选择；B 仅覆盖身份空态。真实样本质量检测、撤销授权及保存待检查 |
| Voice Clone 生命周期 | GET 刷新；SUBMITTED/TRAINING 且有 providerJobId 时可确认查询已有训练；非训练态按角色/状态提供退休、解绑。三项写操作均二次确认，写前重读 clone ID/status，取消不写入、失败不假报成功 | 本轮聚焦 W 通过，只读角色无写入口。付费 submit/retry 与 Provider 删除关闭；后端依赖见 §4。查询现有任务不创建训练 |
| `P/render` 旁白、成片、审核 | GET Master Narration，显示缺失/旧脚本版本/缺资产版本/失败与刷新；既有 Render 列表、签名视频、内容预检、QA 重入队/报告、批准/退回、批准快照导出 | W 覆盖旁白状态、缺费用确认阻断、QA blocker、批准目标与过期 URL；B 仅覆盖空态。**新建 Render 始终禁用；无合成 POST 或伪造费用** |
| `P/publish` 交付与发布 | 批准快照和真实视频资产用于抖音/X 的 P4 手动清单与 TXT；受控导出；发布记录及 QUEUED/PUBLISHING/FAILED 查询对账；批准视频的 24 小时交接记录创建/列表/撤销 | W 覆盖冻结版本、过期链接、查询不重发和交接撤销；新增 reconcile/handoff 的真实端到端未跑。B 仅空态；移动领取界面属 P15，无直发成功声明 |
| `P/analytics` 表现 | 发布采样、真实留存/场景归因、采集、建议生成/采纳、高级学习管理；不请求 Finance，未知指标不补 0 | W 覆盖未知值、缺样本断线、故障隔离；B 覆盖无平台数据空态。真实采集/建议效果待检查 |
| `W/extensions` 扩展 | 详情可查看能力/范围/费用/撤销；仅 OWNER/ADMIN 可启停已安装 Pack；项目需另绑版本，未安装或未配置项说明原因 | W、B/V 为部分证据；最终 B 覆盖路由可达，未点击详情或启停。目录不代表已完成市场安装、内容派生或付费生成 |
| 设置、团队、账单、管理与公开页 | Provider 模式/连接/测试、预算、名称/隐私、团队/账单旧入口；Secret 只提交后端，读接口显示掩码；首页 CTA、主题/帮助入口；设计系统示例按钮按工作区引导新建，取消只显示说明，状态弹层不写入作品/授权 | 最新 W 覆盖设置掩码及设计系统入口/说明/焦点返回；B 覆盖设置/团队/账单路由；QF-13 最新 V 有公开页按钮和只读弹层点击证据。实际权限、连接、预算、席位/购买未实测 |

## 3. 浏览器与测试证据

### 3.1 浏览器 smoke 的确切范围

**最新源码 smoke：PASS，退出码 0；仅覆盖以下实际流程。** 主流程在 e 全量验证后的构建运行 `node scripts/quiet-frame-browser-smoke.mjs`，日志为 `.artifacts/quiet-frame-rebuild/browser-smoke-final-261008-c.log`。该构建包含 QF-13 示例按钮最后接线与命令搜索重复 React key 修复，但 smoke 不访问 QF-13，也未操作命令搜索，不能单凭此流程证明这两项交互。显式独立测试库；环境为 production Next、Chromium、`zh-CN`、`Asia/Shanghai`、1440×900；Mock LLM 与本地对象存储，无真实付费 Provider 或平台发布。

实际流程：登录 → 创建工作区 → 新建作品 → 粘贴并保存正文 → 刷新后正文恢复 → Mock LLM 生成脚本 → 脚本深链接刷新 → 查询测试库确认唯一项目和唯一内容文档 → 检查 11 个次级路由。路由为工作区素材、项目素材、身份、扩展、设置、团队、账单、分析、历史、成片、发布；检查 HTTP 200、标题及脚本指定空态。该运行记录 0 `pageerror`、0 hydration 错误。

- 最新主链路截图：`.artifacts/quiet-frame-rebuild/browser-smoke/qf-smoke-3614b8ed-d968-4e1b-9241-80118fb206f4.png`。
- 最新 11 张路由截图：同名 `qf-smoke-3614b8ed-d968-4e1b-9241-80118fb206f4-routes/`；已核对主截图、11 张路由截图与日志均存在。
- 历史成功运行 `qf-smoke-9694a760-84ff-4b90-ae17-8bd7fa0a6ce9`、`qf-smoke-e44e5ed6-b8d2-43c5-8693-c7d852876e98`、b 日志对应的 `qf-smoke-7d2e3c28-ea26-472a-bfd1-891b8d6c8194` 及各自 `-routes/` 目录保留追溯；最新源码以 c 日志及 `3614b8ed…` 证据为准。
- 该运行覆盖同一主链路和路由空态，**没有触发新增 Voice Clone、Render、Finance 写操作，也没有点击 Director/AI 确认、发布对账/交接、扩展启停或命令搜索**。不能据此把新增操作或搜索交互记为浏览器端到端通过。
- 脚本未上传真实素材、合成旁白、训练克隆、生成 Render、产生 QA、批准、发布或支付；HTTP 200/空态不证明这些动作可用。

### 3.2 测试运行状态

| 层级 | 命令/环境 | 本次结果 | 限制 |
|---|---|---|---|
| 最新源码全量 | `pnpm verify`（显式独立测试库）；`.artifacts/quiet-frame-rebuild/verify-final-261008-e.log` | **PASS，退出码 0**；包含命令搜索 key 修复 | `contract`/`e2e` 是显式 `[PLANNED]`，不执行断言，不算功能通过 |
| 历史完整验证 | `.artifacts/quiet-frame-rebuild/verify-final-261008-d.log` | **PASS，退出码 0（搜索 key 修复前）** | 保留追溯；最终源码以 e 日志为准 |
| 全仓静态/构建 | e 运行内的 `secrets:check`、`lint`、`typecheck`、`build`、`arch:check` | **全部 PASS**；架构依赖方向 R1—R8 检查通过 | 静态与构建成功不证明 Provider 或完整业务链路 |
| Unit | `pnpm run test:unit`，e 运行 | **42 文件、347/347 项通过** | 含 SDK 等单元验证，替身响应不等于外部网络实测 |
| Web 全量 | `pnpm run test:web`，e 运行 | **27 文件、138/138 项通过** | 包含搜索 key 修复后的源码、设计系统示例入口/取消/状态弹层与焦点返回；jsdom + SDK 替身，不证明真实 API 持久化 |
| Motion | `pnpm run test:motion`，e 运行 | **2 文件、19/19 项通过** | 仅该套件覆盖范围 |
| Integration | `pnpm run test:integration`（独立测试库），e 运行 | **74 文件、331/331 项通过** | 本地 API/domain/持久化与受控适配器；第三方 Provider 未实测 |
| Security | `pnpm run test:security`，e 运行 | **4 文件、22/22 项通过** | 不能代替未实现付费/生命周期协议的安全验证 |
| Render | `pnpm run test:render`，e 运行 | **2 文件、6/6 项通过** | 渲染套件通过不代表 Web 已开放新建 Render |
| Golden | `pnpm run test:golden`，e 运行 | **2 文件、15/15 项通过** | 非 Quiet Frame 18 状态的最终视觉验收 |
| Contract / E2E | `pnpm run test:contract`、`pnpm run test:e2e` | **[PLANNED]，未执行断言** | contract 标注 P03-07；e2e 标注 P05-P08。verify 汇总中的进程 PASS 不能记为这两类测试已完成 |
| 身份聚焦 | `pnpm exec vitest run --project web apps/web/src/components/quiet-frame/workspace-identity.test.tsx` | 本轮已执行通过：样本选择、确认/取消、训练查询、退休/解绑、只读、状态变化、服务端拒绝 | SDK 替身，无 DB 或真实克隆服务 |
| 旁白/审核聚焦 | `delivery-render.test.tsx`、`ui/render-review.test.tsx` 的 Web vitest 运行 | 本轮已执行通过：旁白缺失/旧版本和缺费用确认阻断；既有审批/导出 | SDK 替身，无真实渲染/收费 |
| Web 聚焦静态检查 | `pnpm --filter @ancs/web typecheck`；identity/render 聚焦 ESLint | 子任务执行时退出码 0；最终全仓静态结果已由 e 运行确认 | 不证明运行时完整链路 |
| 历史浏览器 smoke | 日志 `browser-smoke-final-261008-b.log`；run ID `qf-smoke-7d2e3c28-ea26-472a-bfd1-891b8d6c8194` | **PASS，退出码 0（该构建）** | 早于 QF-13 最后接线与搜索 key 修复；保留追溯 |
| 最新源码浏览器 smoke | `node scripts/quiet-frame-browser-smoke.mjs`；日志 `.artifacts/quiet-frame-rebuild/browser-smoke-final-261008-c.log` | **PASS，退出码 0**；主链路及 11 路由全 PASS，0 pageerror/hydration；run ID `qf-smoke-3614b8ed-d968-4e1b-9241-80118fb206f4` | 范围见 §3.1；未执行新增 Voice Clone/Render/Finance、发布对账/交接等写操作，无完整生产闭环结论 |
| 视觉对照 | 逐页元数据与 [VISUAL_PARITY_REPORT.md](VISUAL_PARITY_REPORT.md) | 18 状态最新为 `final-261008-d`，QF-13 为 `final-261008-e`；768px 导演局部滚动已复拍、无整页溢出；人工验收待完成 | 合成 DTO 不证明业务成功，截图不覆盖命令搜索缺陷 |
| 第三方 Provider / 发布 / 支付 | 未执行 | **NOT RUN** | Mock、本地 API、视觉夹具不能代替第三方实测 |

上述最终统计已逐项核对 `verify-final-261008-e.log`，退出码 0 由执行主流程确认；d 仅作为修复前的完整历史运行。两个 `[PLANNED]` 套件不执行断言，继续另列。测试数据保护：`resolveTestDatabaseUrl()` 要求显式 `ANCS_TEST_DATABASE_URL` 与含 `test` 的独立库名；不得对开发库做集成清理。本文不记录口令，后续验证由主流程统一协调。

## 4. 后端安全阻塞与解除条件

| 编号 | 当前事实与 Web 处理 | 后端完成条件 / 所需证据 |
|---|---|---|
| QF-BE-01 Master Narration 付费合成 | `narration-audio.ts` 的 POST 经 `project:write` 后同步执行 `synthesizeMasterNarration`；缺 quote、Credits hold、带成本的 Job、Provider generation 记录与并发幂等。API 启动入口目前仅支持 `ANCS_TTS_DRIVER=mock`。Web 只 GET 状态，不调用合成 POST | 建立绑定脚本/声音版本的报价与能力检查、角色/授权校验、确认后幂等 Job、预算预占/结算、有限重试与失败恢复；真实音频/alignment 落资产链。补 contracts → domain → API → SDK 与隔离集成证据及真实适配器验证；Mock 合成不能称作上线 |
| QF-BE-02 新建 Render | `renderPrecheck` / `precheckRenderReadiness` 只返回 `QaReport`，没有所选 profile 的可信价格、预算和服务可用性确认。createRender 可建快照/入队，但内容 PASS 不等于费用授权。Web 始终禁用新建，保留既有审核/导出 | 返回绑定 profile、项目/旁白/素材版本的报价、预算/能力与有效期；确认时重新校验并原子绑定输入及成本，覆盖价格变化、额度不足和重复提交。同时证明旁白对应当前脚本/快照，不能仅靠按项目取得最近旁白 |
| QF-BE-03 Voice Clone 付费提交/重试 | 授权、样本与 clone 分字段保存；Web 无可确认的训练报价/费用闭环，submit/retry 关闭。状态查询只针对已有 providerJobId | 服务端绑定 Provider/连接、授权版本、样本质量及训练类型，完成报价/预算与幂等付费提交。失败重试重新核验授权和成本，禁止无限重试；真实克隆 Provider 待实测 |
| QF-BE-04 Provider 侧删除 | `deleteVoiceCloneAtProvider` 使用注入适配器，主要检查 providerVoiceId/providerDeletedAt，未原子绑定记录的 Provider、BYOK 连接归属与明确 clone 版本。Web 显示原因，不提供删除按钮 | 校验适配器与记录 Provider/连接/租户归属；明确 clone ID/version，避免删除目标漂移；补重复请求、远端成功而本地失败的恢复/对账及审计测试，再开放不可逆确认 |
| QF-BE-05 生命周期并发 | refresh/retire/unlink 经 `project:write`；Web 按状态显示、二次确认并重读 ID/status，训练中只查询。后端仍加载最新 clone，客户端预读不能消除之后的竞态 | 增加 expectedCloneId/version 或等价事务条件，核验状态转换与 Provider/连接归属；覆盖授权撤销与训练完成并发、退休/解绑后延迟 refresh 不得重新激活。当前 W 只证明客户端阻断及失败显示 |

代码依据：`apps/api/src/index.ts`、`apps/api/src/routes/narration-audio.ts`、`apps/api/src/routes/voice-clones.ts`，以及 `packages/domain/src/alignment.ts`、`render.ts`、`qa.ts`、`voice-clone.ts`。本轮没有为解除页面阻断而伪造费用、Job、资产、Provider 能力或批准结果。

## 5. 待用户检查与剩余验收

用户检查应基于最终稳定构建。§4 未解除前，旁白合成和新建 Render 保留 **BLOCKED**；不要将禁用按钮当作已完成生成的入口。

| 检查项 | 用户可检查的结果 | 仍需工程/环境证据 |
|---|---|---|
| 桌面与手机导航 | 上下文、刷新/回退、旧 editor 链接、场景恢复、菜单、深色主题、无横向溢出 | 额外断点、Tab/Escape/焦点返回，见 [INTERACTION_QA_MATRIX.md](INTERACTION_QA_MATRIX.md) |
| 脚本与导演 | 来源定位、锁定/保存/冲突、Director 预览、AI 请求与实际目标清楚、上传后可找到素材 | 双会话 409、跨角色/租户、替换/撤销持久化、真实 Provider 计划 |
| 身份与声音 | 授权、样本类型/质量、系统试听标识、退休与解绑的区别、取消无操作、关闭能力的原因 | 合法音频检测、服务端生命周期并发与真实 Provider；替身 READY 不是实际声音 |
| 成片与交付 | 旁白版本/缺失原因、内容与费用预检区别；合法既有 Render 的 QA、批准版本、过期下载/手动清单 | 后端补齐后的合成 → Render → QA → 批准 → 导出；真实发布/对账及移动领取尚无证据 |
| Finance、表现、扩展与设置 | Finance 在素材页且错误隔离、未知指标无假数字、扩展详情可开关、权限/预算/掩码清楚 | Finance/平台采集、已安装 Pack 启停、授权账户连接、预算/成员权限矩阵；截图不代替写入 |
| 视觉与最终交付 | 18 状态和受影响 QF-13/768px 已复拍；搜索 key 修复后的 e 全量验证通过，Web 138 项；最新源码 c smoke 限定范围通过 | 未覆盖业务交互、用户视觉/业务检查 |

P15/P16 等待 Web 检查后再推进；QF-15～17 是响应式 Web，不能记为原生移动端交付。最新源码全量验证已按 e 运行回填，浏览器 smoke 已按 c 运行回填；未执行项与安全阻塞继续保留。
