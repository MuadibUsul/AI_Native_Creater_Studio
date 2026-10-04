# AGENTS.md — 代理协作规则

本仓库按 `ANCS_Plan261004.md` 推进（需求权威为 `creator_video_os_spec_v0.2.md`）。任何模型接手前必须按顺序执行：

## 启动步骤（计划 §13.5）

1. 阅读规范 §0、§2、§75—79、§92—97。
2. 阅读计划的约束优先级（§1.3）、范围裁决（§2 / `docs/decisions/`）、技术基线（§3）、公共契约（§4）与当前阶段。
3. 检查仓库真实状态与最新交接记录（`docs/handoffs/`）。
4. 选择编号最小、依赖已完成的未验证任务。
5. 检查该任务相关代码与测试，不重复初始化已有工程。

## 实现规则

- 顺序（规范 §76 / 计划 §7）：contracts → migration → domain/service → API → SDK → UI → tests → docs。不涉及的层明确写"不适用"；禁止先在 UI 内实现权威规则再抽取。
- 完成定义：只有 `VERIFIED` 计入完成；Mock 验证通过 ≠ 真实 Provider 验证通过；接口存在 ≠ 功能交付。
- 证据与交接：每项任务在 `docs/verification/<taskId>.md` 记录证据（命令与结果），在 `docs/handoffs/<taskId>.md` 按计划 §13.4 模板交接；同步更新 `docs/requirements/traceability.md` 状态列与 `v1-acceptance-ledger.md`。
- TODO 必须写清 why / dependency / intended interface。
- 未实现测试套件必须使用显式 `[PLANNED]` 占位（`scripts/planned-suite.mjs`），不得伪造断言、扩大阈值或静默跳过。
- 依赖方向由 `pnpm arch:check` 强制（R1—R6，见 `packages/arch-check`）；新增依赖边前先确认计划 §3.4。

## 禁止事项（规范 §75，摘要）

- 不得把 Secret 写入仓库、日志或错误返回；客户端不得持有 Provider Key。
- 不得把 Provider output URL 当永久文件；付费生成不得无限自动重试。
- 数据图表不得使用虚构数值；不得让 Custom Motion 代码在无隔离进程执行。
- 不得以浏览器自动化冒充可靠发布能力；不得为 Demo 牺牲 Scene Graph/隐私/可恢复性/多端一致性。
- 完整规则见规范 §75 与 README 的 ARCHITECTURE RULES（附录 B）。
