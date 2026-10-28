# 0021 V7：Agent 运行时分阶段迁往 DeepSeek Harness 的 Fork（Video-Native Harness），本轮只做 P0 基线审计

- 状态：**运行时迁移方向已被 `0022-v7-borrow-harness-mechanisms.md` 取代（2026-10-28）**：不建 Fork，Agent 运行时留在 ANCS，从 DSH 逐项借鉴机制；第 2 条的不变量与所有者关于真实花费的决定继续有效。以下为原文。
- 原状态：生效（2026-10-28）。项目所有者指示"按这个重构方案来推进"，所指方案为所有者共享看板上的文档 `ancs/v7-video-native-harness-incremental-refactor-plan` 第 1 版。进度：P0 已完成（`docs/V07/V7_BASELINE_AUDIT.md`）；所有者当天对四项待决事项作出决定（第 6 条）；P1 中不依赖 Fork 的部分进行中。
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

6. **所有者的四项决定（2026-10-28，保守方案）。** P0 审计列出待决事项后，所有者在共享看板文档 `ancs/video-harness-conservative-decisions` 中逐项决定：

   | 事项 | 决定 |
   |---|---|
   | Fork 仓库 | 在 ANCS 组织账号下建 `ANCS-Video-Harness`，由服务账号做 owner，不用个人账号。开发会话只拿分支推送权限；`main` 受保护，改动一律走 PR |
   | 运行 DSH 代码 | 只在 Fork 自己的 CI 里运行。开发机不安装、不构建、不运行，也不绕过安全检查。需要交互调试时开一次性容器，不碰开发机工作区 |
   | DSH 版本 | 锁定 `0.2.1-rc.3`（`22ddee37`），暂不升到 `0.2.2-alpha.2`。等 P1 的运行时切换点、工具桥契约、测试隔离完成后再单独评估 |
   | 运行时与模型 | DSH 镜像钉死 Node 24。先用最便宜的模型跑通端到端，额度最小；每一笔真实花费仍需所有者逐笔审批 |

   同时确认两条约束：
   - **每一轮的编辑草稿留在 ANCS**：DSH 只经工具桥读写它，不持有副本；
   - **DSH 只拿最小 bundle**：不挂 Shell、文件写入、联网工具、代码执行、插件安装。这里的"联网"指给模型用的网页工具；DSH 进程本身的出网只允许 ANCS 工具桥与所选模型的 API。

   据此，P1 中不依赖 Fork 的五项照常推进。Fork 由所有者（服务账号）创建；建好前本会话不宣称 Fork 已存在。P0 时为在开发机上运行 DSH 而另装的 Node 24 与 pnpm 11 已删除；DSH 源码只保留一份只读副本，供核对契约用。

## 影响

- 新增 `docs/V07/`（方案原文、P0 审计与指标）；AGENTS.md 增加一行 V7 指向。
- `scripts/eval-first-cut.mjs` 多记录提案操作数与类型、采用前后版本、RenderPlan `planHash`、成片 sha256 与渲染耗时，供 P2 / P6 的 legacy 与 DSH 对照使用。这是测量字段，不改变评测流程。
- 代码、迁移、接口、界面：P0 不涉及。P1 的改动与证据记在 `docs/V07/milestones/P1.md`。

## 回滚

P0 只增加文档和测量字段。回滚即撤回本裁决与 AGENTS.md 那一行，恢复 V6-10 的排期；`eval-first-cut.mjs` 新增的字段可以保留，它不影响已有报告。
