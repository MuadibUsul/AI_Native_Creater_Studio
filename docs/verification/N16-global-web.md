# v0.4 全局 Web 黑白界面迁移验证

**日期：** 2026-10-08  
**状态：** 当前已实现 Web 界面完成本轮迁移和 Windows Chrome 验收；各 N16 任务仍按自己的依赖与跨平台门单独计状态，D0/D1 未关闭。

## 交付范围

- 统一公开入口、Workspace、Studio、项目交付/分析、账单、团队与 Platform Ops 的白、近黑、中性灰语义层；移除遗留蓝绿强调、彩色状态/KPI 和后台 slate 模板。
- 新增共享 `Monochrome.module.css`，统一面板、字段、按钮、状态、错误、危险和触控尺寸；保留既有业务组件与 URL，不建立第二套项目状态。
- Welcome 去除虚构绿色曲线，Dashboard 去除假封面；无数据时明确显示空画布/无封面，不以装饰数据冒充业务数据。
- 主题只作用于 UI。视频、封面、缩略图、作品画布和用户品牌内容不使用 `grayscale`、`invert` 或 `brightness`。
- Studio 长项目名在原生 200% 时省略且不遮挡操作，项目标签可横向访问；场景轨道维持自身滚动语义。
- Ops 只呈现真实独立运营会话可用的只读诊断；workspace/ticket scope 由服务端强制，支持摘要读取写审计和客户可见事件。

## 实际验证

| 命令/证据 | 结果 |
|---|---|
| `pnpm test:web` | 30 文件、156/156 通过。 |
| 精确隔离库下 N15-03 定向 integration | 5 文件、23/23 通过。 |
| `node scripts/verification/n15-03-ops-ui.mjs` | 真实 PostgreSQL/Fastify/MFA/Next/Chrome 通过；双 workspace、双 ticket 拒绝、audit+Outbox、1440 浅色、1280 深色、390 窄屏和原生 200%。 |
| `node scripts/verification/n16-03-layout-audit.mjs` | `/welcome`、`/design-system`、`/sign-in` × 5 个视口，15/15 通过。 |
| `node scripts/verification/n16-03-browser-typography.mjs` | 字体请求、字阶、数字、长文件名、图标几何、内容滤镜边界通过。 |
| `node scripts/verification/n16-03-protected-zoom.mjs` | Chrome 原生 200%，工作区/Studio/Ops 拒绝态 3/3 通过；CSS 宽 712，无页面溢出；长项目名 `textOverflow=ellipsis`；13 个场景均可达。 |
| `node scripts/verification/n16-02-real-session.mjs` | 真实 Better Auth/API/DB/Next：主题同步、真实播放持续、项目选区与快照派生 hash/账本不变、5 个登录页面原生 200%，定向清理且其他租户保留。 |
| `node scripts/verification/n16-10-media-theme.mjs` | UI 明暗切换时 RGBA fixture 不变、8 层祖先 filter 为 none；用户视频同帧证据见 N16-10 单项记录。 |
| `pnpm verify` | 2026-10-08 17:44 exit 0：secrets、lint、typecheck、build、arch；Unit 364、Web 156、Motion 19、Integration 353、Security 24、Render 6、Golden 15，合计 **937/937 已实现断言通过**。contract/e2e 是显式 `[PLANNED]`、0 断言。 |

数据库命令均先移除 `DATABASE_URL`，再设置并断言 `ANCS_TEST_DATABASE_URL=postgres://ancs:ancs@localhost:55432/ancs_quiet_frame_test_261007`；没有连接或清理 `ancs_dev`。首次最终 `pnpm verify` 因 `n15-03-ops-ui.mjs` 的 ESLint 全局声明缺 `AbortSignal` 在 lint 阶段失败；只修正脚本声明后从头重跑，未改变产品逻辑或断言。

## 人工目检

- `.artifacts/n16-03-layout/welcome-720.png`
- `.artifacts/n16-03-layout/design-system-720.png`
- `.artifacts/global-ui-final/native-zoom-final/studio-native-200.png`
- `.artifacts/n15-03-ops-ui/operator-light-1440.png`
- `.artifacts/n15-03-ops-ui/operator-dark-1280.png`
- `.artifacts/n15-03-ops-ui/operator-narrow-390.png`

已检查层级、对齐、留白、裁切、重叠、状态文字、触控尺寸、表格密度和深浅一致性。截图存于 Git 忽略目录，是技术验收证据，不代表用户视觉批准或可编辑设计源。

## 未关闭边界

- macOS/Safari 实机排版与原型图标商业使用/分发权仍待用户输入，N16-03 保持 `IN_PROGRESS`。
- 权威 ProjectDocument hash 待 N01-02，N16-10 保持 `IN_PROGRESS`；当前只有现有 API 快照派生 hash 和媒体同帧证据。
- 尚未实现的 N16-04—12 业务能力、完整键盘/降低动效矩阵及 D0/D1 总门不会因本轮全局视觉迁移自动完成。
- 按用户要求，本轮现有 Web 完成后暂停，先供用户检查；不会继续推进旧 P15/P16。
