# AGENTS.md — 代理协作规则

本仓库当前按 `docs/V04/ANCS_AI_Native_v0.4.md` 和 `docs/V04/ANCS_v0.4_Task_Backlog.md` 的 N 系列任务推进，接手流程见 `docs/V04/ANCS_v0.4_Codex_Start.md`。`docs/V04/ANCS_v0.4_Traceability.md` 是需求来源矩阵；实际完成状态以 `docs/requirements/ai-native-v04-traceability.md`、`docs/requirements/ai-native-v04-acceptance-ledger.md` 和逐项证据为准。`creator_video_os_spec_v0.2.md`、`ANCS_Plan261004.md` 与旧 P 系列证据保留为历史。冲突优先级：用户后续明确要求 → v0.4 显式增量 → v0.4 保留内容 → 不冲突的旧规范（见 v0.4 §1.4 和 `docs/decisions/0009-v04-authority-and-scope.md`）。

任何模型接手前必须按顺序执行：

## 启动步骤（计划 §13.5）

1. 阅读 v0.4 总规范 §1、§2、§5、§7、§9—§15、§21—§23、§27—§29，及启动指令、任务清单和追踪矩阵；按任务需要继续读旧规范的安全与架构条款。
2. 阅读生效裁决（`docs/decisions/`），对照当前 N 任务的依赖、验收门与实际证据。旧计划中的 Article-only、整数毫秒权威时间、全局 Audio-First、专业功能永久排除和旧 UI 边界已被 v0.4 覆盖。
3. 检查仓库真实状态与最新交接记录（`docs/handoffs/`）。
4. 选择依赖已完成、验收门允许的 N 任务；N13 安全、N15 运营和 N16 设计按横切依赖提前推进。旧 P15/P16 不自动成为下一项。
5. 检查该任务相关代码与测试，不重复初始化已有工程。

## 实现规则

- 顺序（v0.4 §22）：contracts → migration → domain/service → API → SDK → UI → tests → docs。不涉及的层明确写"不适用"；禁止先在 UI 内实现权威规则再抽取。
- 完成定义：只有 `VERIFIED` 计入完成；Mock 验证通过 ≠ 真实 Provider 验证通过；接口存在 ≠ 功能交付。
- 证据与交接：每项 N 任务在 `docs/verification/<taskId>.md` 记录证据（命令与结果），在 `docs/handoffs/<taskId>.md` 交接；同步更新两个 `docs/requirements/ai-native-v04-*` 活账本。旧 P 账本保持历史语义，不用新状态覆写。
- TODO 必须写清 why / dependency / intended interface。
- 未实现测试套件必须使用显式 `[PLANNED]` 占位（`scripts/planned-suite.mjs`），不得伪造断言、扩大阈值或静默跳过。
- 依赖方向由 `pnpm arch:check` 强制（见 `packages/arch-check`）；新增依赖边前先核对现有规则和 v0.4 架构。

## 禁止事项（规范 §75，摘要）

- 不得把 Secret 写入仓库、日志或错误返回；客户端不得持有 Provider Key。
- 不得把 Provider output URL 当永久文件；付费生成不得无限自动重试。
- 数据图表不得使用虚构数值；不得让 Custom Motion 代码在无隔离进程执行。
- 不得以浏览器自动化冒充可靠发布能力；不得为 Demo 牺牲统一 ProjectDocument、原素材、隐私、可恢复性或多端一致性。
- `FOOTAGE_EDIT`、`GENERATIVE`、`HYBRID` 共用一套作品状态与编辑操作；纯素材项目的禁生成约束在服务端生效。旧安全底线见 v0.2 §75；当前架构规则见 v0.4 §12—§15 与 README。
