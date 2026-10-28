# 0021 V7：Agent 运行时分阶段迁往 DeepSeek Harness 的 Fork（Video-Native Harness），本轮只做 P0 基线审计

- 状态：生效（2026-10-28）。项目所有者指示"按这个重构方案来推进"，所指方案为所有者共享看板上的文档 `ancs/v7-video-native-harness-incremental-refactor-plan` 第 1 版。
- 前一裁决编号：`0020-autonomous-production-adoption.md`（方案原文建议的 0019 已被 `0019-stitch-canvas-design-language.md` 占用）
- 依据（原文归档，只读）：`docs/V07/ANCS_V7_Video_Native_Harness_Incremental_Refactor_Plan.md`
- P0 结果：`docs/V07/V7_BASELINE_AUDIT.md`、`docs/V07/V7_BASELINE_METRICS.json`

## 决定

1. **V7 只改变 Agent 运行时的归属与实现。** 方向：以 `deepseek-ai/deepseek-harness`（下称 DSH）的 Fork 作为 Agent 运行时母体，在 Fork 源码里新增视频专用模块（上下文编译、导演阶段、工具桥、会话事件、策略守卫、评测）。ANCS 继续拥有共看片室、API、Realtime、`ProjectDocument`、纯函数内核、`project_op_log` 与投影器、提案生命周期、媒体 Worker、Provider Gateway（媒体与计费）、RenderPlan / FFmpeg / Remotion、身份与权限。V6 产品定义、V5 架构裁决（0011—0017）与 0018—0020 继续有效；V7 与它们冲突时以它们为准，V7 不改写用户价值与生产流程。

2. **不变量是硬约束（方案 §2.3 SOT-01～10）**，后续每个阶段都要有自动化测试覆盖，摘要如下：
   - 工程组合修改只经 ANCS 操作日志；DSH 会话日志只记录 Agent 过程事实。
   - AI 只写草稿 / 提案，采用、部分采用、重基、撤回走 ANCS 既有受权限保护的接口。
   - 权威路径只用 `MediaTime` 有理时基，不用浮点秒定位。
   - 每次改动带工作区、工程、工程版本与命令 ID，冲突检查不得静默覆盖人的改动。
   - 引用必须在本工作区 / 工程内可访问。
   - 付费生成：报价 → 授权 → 预算预留 → 供应商调用 ID → 对账；结果未知时不自动重试、不重复扣费。
   - DSH 进程**不持有 ANCS 数据库与媒体存储凭据**，不直连 ANCS 数据库与媒体根目录；客户端与模型都拿不到 Provider 密钥。模型密钥放在哪一侧在 P1 决定（DSH 直连模型，或经 ANCS 代理以保住每次调用前的 AI 月度上限检查），见审计 R-03。
   - 停止播报、取消一轮、取消媒体任务、撤销编辑是四种不同操作。
   - 迁移窗口内旧工程、旧会话、旧接口、旧提案按旧路径可读。

3. **按 P0 → P8 逐阶段推进，每阶段 Go/No-Go。** 本轮只做 P0：两仓快照与环境、ANCS 基线测试与实测指标、调用链与逐文件迁移矩阵、DSH 扩展点与最小权限分析、风险清单与 P1 拆分。**P0 不重写 Agent Loop、不做迁移、不改界面。**

4. **本仓库的交付纪律照旧**，方案里的"每阶段一个 PR"在本仓库落为：
   - 在 `codex/v04-foundation` 上提交（`[skip ci]`，不开 PR，不触发 CI，遵循所有者的长期指示）；
   - 每阶段结果记在 `docs/V07/`：P0 即 `V7_BASELINE_AUDIT.md` 与 `V7_BASELINE_METRICS.json`，之后各阶段记在 `docs/V07/milestones/P<n>.md`。

   AGENTS.md 的规则全部继续适用：顺序 contracts → … → docs、Mock ≠ 真实、真实浏览器验证、中英双语、业务包不读 `process.env`。

5. **分阶段暂停。** V6-10（长素材分章并行）与 V6-11（补镜头）暂停：它们都建在 Agent 运行时之上，等 V7 的运行时归属在 P2 前后定下来再排。暂停前 V6-10 只做了设计阅读，没有写代码。

6. **需要所有者决定或授权的事项**（P0 审计给出依据，本裁决不替所有者决定）：
   - Fork 仓库的创建、归属与名称（方案建议 `ANCS-Video-Harness`）；本会话对它的写权限。
   - 是否允许在本开发容器里安装并运行 DSH 的依赖、构建与测试（会执行外部仓库代码；本轮被自动安全检查拦下，未运行）。
   - DSH 服务的生产运行时：Node ≥ 24.9 与 pnpm 11.28.5，ANCS 是 Node 22 与 pnpm 9，需要独立镜像。
   - DSH 侧使用哪家模型与密钥。所有真实模型调用仍需所有者先同意额度。
   - 方案锁定的 DSH 提交与上游主干已相差 637 个提交，需要决定继续锁在方案的提交还是改锁新版本。

## 影响

- 新增 `docs/V07/`（方案原文、P0 审计与指标）；AGENTS.md 增加一行 V7 指向。
- `scripts/eval-first-cut.mjs` 多记录提案操作数与类型、采用前后版本、RenderPlan `planHash`、成片 sha256 与渲染耗时，供 P2 / P6 的 legacy 与 DSH 对照使用。这是测量字段，不改变评测流程。
- 代码、迁移、接口、界面：P0 不涉及。

## 回滚

P0 只增加文档和测量字段。回滚即撤回本裁决与 AGENTS.md 那一行，恢复 V6-10 的排期；`eval-first-cut.mjs` 新增的字段可以保留，它不影响已有报告。
