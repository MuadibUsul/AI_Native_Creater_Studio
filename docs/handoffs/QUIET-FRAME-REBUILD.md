# Quiet Frame Web 重构交接

（按 `ANCS_Plan261004.md` §13.4；更新 2026-10-08）

当前阶段：P14 已完成后的 Web 设计迁移与用户检查准备；P15/P16 暂停。

当前任务：将用户提供的 Quiet Frame 设计包迁移到现有 Next Web，并保留业务、安全约束与可复现证据。

任务状态：**实施完成度与视觉/功能验收分开记录；用户验收 PENDING**。本任务不是新增 P15/P16 阶段任务，不更改原有 REQ 的 VERIFIED 状态。18 个设计状态均有实现与同环境截图，但 1:1 像素验收未通过；新建 Render 和付费 Voice 能力仍有后端安全阻塞。不得称整体生产就绪。

本次已经完成：

1. 验证原 ZIP 哈希、33 文件、原型与 18 状态；只读提取参考，建立双向设计/功能映射和固定视觉采集工具。
2. 在现有 Web 路由迁移 Quiet Frame token、图标、外壳、响应式页面与交互；保留工作区/项目/场景深链接、编辑协议、锁定、QA、批准与导出门控。Director 候选先预览后确认、AI 差异先看后应用，原型演示成功数据不进入生产默认页。
3. 接线项目 Finance、Voice Clone 安全生命周期、Master Narration 状态、受控交接和发布对账；在缺少可信后端费用/任务协议时明确关闭新建 Render、付费声音提交/重试与 Provider 删除。
4. 独立测试数据库防护、Web 单元/集成/渲染检查、实际浏览器 smoke、视觉截图、响应式审计与本轮文档。开发库旧业务数据恢复按用户要求延后。

本次修改的文件：主要位于 `apps/web/src/components/quiet-frame/`、`apps/web/src/app/`、`apps/web/src/ui/`、`apps/web/next.config.mjs`、`packages/sdk/src/client.ts`、`packages/db/src/client.ts`、`scripts/quiet-frame-*.mjs`、`docs/quiet-frame-rebuild/`。原始 ZIP 与只读展开目录保留。

契约／数据库变化：**无产品迁移或公共业务契约变更**。SDK 仅增补现有 API 的传输方法/参数；测试数据库解析改为必须显式提供含 `test` 的 `ANCS_TEST_DATABASE_URL`，CI 测试库改为 `ancs_test`，防止误清理开发业务库。浏览器视觉 DTO 仅通过 Playwright 拦截注入。

执行的检查：`pnpm verify`（显式独立测试库）、`node scripts/quiet-frame-browser-smoke.mjs`（同一独立库）、`pnpm visual:qf` 的 18 状态对照、25 组响应式审计、实现文件的 Git 空白检查。完整命令结果见 `docs/verification/QUIET-FRAME-REBUILD.md`。

检查结果：最终源码 `pnpm verify` 退出 0（unit 347、Web 138、motion 19、integration 331、security 22、render 6、golden 15；`test:contract`/`test:e2e` 是 `[PLANNED]` 无断言），日志 `.artifacts/quiet-frame-rebuild/verify-final-261008-e.log`。最终源码的浏览器 smoke 退出 0，11 个次级路由通过，日志 `.artifacts/quiet-frame-rebuild/browser-smoke-final-261008-c.log`；公开首页经 3000 直连与 4000 网关均返回 HTTP 200。真实业务范围和未测写操作见功能报告。

验收证据：`docs/quiet-frame-rebuild/REFERENCE_INVENTORY.md`、`ROUTE_AND_FEATURE_MAP.md`、`VISUAL_PARITY_REPORT.md`、`FUNCTIONAL_REGRESSION_REPORT.md`、`INTERACTION_QA_MATRIX.md`、`ACCEPTED_DEVIATIONS.md`、`FINAL_HANDOFF.md`；命令日志与 PNG/diff/metadata 位于 Git 忽略的 `.artifacts/quiet-frame/`、`.artifacts/quiet-frame-rebuild/`，本机可复查。对照图与真业务证据层级分列，不互相冒充。

使用 Mock 的位置：浏览器 smoke 使用 Mock LLM、本地对象存储；Web/jsdom 测试使用 SDK 替身；私有页视觉快照使用 `SYNTHETIC_VISUAL_ONLY` 网络夹具且阻止写入。它们均未进入生产 API 默认数据源。

真实 Provider 验证情况：**NOT RUN**。无本轮真实 Provider 凭据、付费生成、平台发布或支付测试；Mock 和本地 Render 测试不能替代。

未解决项：当前已知产品功能缺口是 Master Narration 付费协议、Render 可信报价/预算确认、Voice Clone 付费训练和 Provider 删除的后端门控，详见功能报告 §4。视觉上演示成功数据与真实合法空态不具同状态可比性；逐行差异仍为 PENDING，不宣称 1:1 通过。

外部阻塞：真实 Provider/平台账号与凭据、用户对 Web 视觉和业务的人工检查。开发库历史业务记录未找到本机备份，恢复已被用户明确延后，不应在本任务中伪造记录。

下一项任务：**用户检查当前 Web**；根据用户反馈修复 Web 问题。用户明确要求检查通过后才推进 P15、P16，代理不得自行启动这两个阶段。开发库数据恢复另行处理。

下一项任务前置条件：用户完成 Web 检查并给出反馈或继续指令。真实生成/发布相关任务还需后端费用安全契约及 Provider 环境。

下一项任务建议读取内容：`creator_video_os_spec_v0.2.md` 指定章节、`ANCS_Plan261004.md` §1.3/2/3/4/13.4/13.5、`docs/quiet-frame-rebuild/FINAL_HANDOFF.md` 与六份映射/回归报告、`docs/verification/QUIET-FRAME-REBUILD.md`、`docs/verification/QUIET-FRAME-BASELINE.md`。遵守仓库 `AGENTS.md` 启动顺序。
