# V7 P0 基线审计（V7-001 / V7-002 / V7-003）

- 日期：2026-10-28
- 依据：裁决 `docs/decisions/0021-v7-video-native-harness.md`；方案原文 `docs/V07/ANCS_V7_Video_Native_Harness_Incremental_Refactor_Plan.md` §0、§8 P0
- 机器可读指标：`docs/V07/V7_BASELINE_METRICS.json`
- 结论：
  - **ANCS 侧可以进入 P1**：已实现的基线套件全部通过，2 项集成失败已分类为原有测试隔离缺陷，单独运行通过（§2）。
  - **DSH 侧 P1 需要所有者先定四件事**，见 §9。
  - **DSH 的安装、构建与测试本轮没有运行。** 它们会执行外部仓库代码，被本开发容器的自动安全检查拦下。下文 DSH 部分全部来自源码与锁文件的静态阅读，标为 `NOT_RUN`。

| 项目 | 结果 |
|---|---|
| ANCS 静态与构建检查（secrets、spec、lint、typecheck、build、arch、capabilities） | 7/7 通过 |
| 单元 / 网页 / motion / 安全 / 渲染 / 金样 / 评测 | 917 / 350 / 38 / 24 / 8 / 15 / 5 项，全部通过 |
| 集成 | 693 项：677 通过，2 失败，14 跳过。分类与复跑见 §2；**没有一项是产品缺陷** |
| `test:contract`、`test:e2e` | `[PLANNED]` 占位：不执行断言，**不计为通过** |
| V6 核心样例（脚本导演） | 2 个用例 × 2 次：都生成提案、被采用、导出。两次运行导出文件 sha256 完全相同 |
| 共看片室浏览器验收（脚本导演） | 15/15，135 s |
| DSH 安装、构建、测试 | `NOT_RUN`（§6.8） |
| 真实模型、语音、视觉、付费生成 | `NOT_VERIFIED`（本环境没有配置任何真实 Provider） |

## 1. 快照与环境

| 工程 | 方案锁定 | 本次实际 | 差距 |
|---|---|---|---|
| ANCS | `main` @ `8047b59a0d799f8e21bbc1df97961e95ff1167d8`（2026-10-16） | 开发分支 `codex/v04-foundation` @ `6867a69`。`main` 仍停在锁定提交；开工时工作区干净 | 分支领先 36 个提交：378 个文件，+19,234 / −407 行（明细见 §3.3） |
| DSH | `master` @ `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`（2026-10-23，`0.2.1-rc.3`） | `master` @ `f3803c96974ad4a94195fb97e5c637e9c2a3afe3`（2026-10-28，`0.2.2-alpha.2`）。锁定提交是它的祖先 | 5 天 637 个提交：2,118 个文件，+136,793 / −9,351 行。见下表 |

DSH 的变动集中在界面与实验包：`packages/client` 占 15%，`packages/experimental` 占 18%。方案要动的扩展点几乎没变：

| 目录 | 锁定 → 主干 |
|---|---|
| `packages/core` | 24 个文件，+129 / −52（含 `agent-loop/src/agent.ts`、`index.ts`） |
| `packages/sdk` | 3 个文件，+3 / −3 |
| `packages/bundle` | 7 个文件，+6 / −10 |
| `packages/session` | 28 个文件，+178 / −26 |
| `packages/llm` | 41 个文件，+735 / −73 |
| `packages/sandbox` / `jobs` / `credentials` / `mcp` | 各 3—10 个文件，改动都在两位数行以内 |

DSH 锁定点与主干的 `engines`、`packageManager` 相同：都要求 Node ≥ 24.9.0、pnpm 11.28.5。

| 环境 | 版本 |
|---|---|
| 机器 | Linux 6.18（云端开发容器），4 核，15 GB 内存 |
| ANCS 工具链 | Node 22.22.0、pnpm 9.15.0 |
| DSH 工具链（另装，不覆盖 ANCS） | Node 24.22.0（nodejs.org 官方包，已核对 SHASUMS256）、pnpm 11.28.5（npm），装在独立前缀 |
| 服务 | PostgreSQL 16.15、Redis 7.0.15、FFmpeg 6.1.1 |
| 浏览器 | 渲染用无头 Chromium 141.0.7390.37；Chrome for Testing（浏览器验收） |
| 外部服务 | 没有配置任何真实模型、语音或生成密钥。**真实 Provider 一律 `NOT_VERIFIED`** |

## 2. ANCS 基线测试矩阵（V7-001）

每一步单独运行：失败不阻断后续步骤，各自计时并保留日志。所用环境变量：

- `ANCS_TEST_DATABASE_URL`：本地测试库；
- `REMOTION_BROWSER_EXECUTABLE`：渲染用无头浏览器；
- `ANCS_BROWSER_EXECUTABLE`：浏览器验收用 Chrome。

`pnpm verify` 的步骤与这里相同，但它在第一次失败时停止。

| 步骤 | 结果 | 耗时 | 数量 |
|---|---|---|---|
| `secrets:check` | 通过 | 38.4 s | — |
| `spec:check` | 通过 | 1.0 s | — |
| `lint` | 通过 | 51.9 s | — |
| `typecheck` | 通过 | 254.9 s | — |
| `build` | 通过 | 318.6 s | — |
| `arch:check` | 通过 | 5.2 s | — |
| `capabilities:check` | 通过 | 1.8 s | — |
| `test:unit` | 通过 | 56.5 s | 127 个文件 / 917 项 |
| `test:web` | 通过 | 67.7 s | 56 / 350 |
| `test:motion` | 通过 | 16.4 s | 4 / 38 |
| `test:contract` | `[PLANNED]` | 1.2 s | 不执行断言 |
| `test:integration` | **2 项失败** | 995.2 s | 149 个文件；693 项：677 通过 / 2 失败 / 14 跳过 |
| `test:e2e` | `[PLANNED]` | 1.1 s | 不执行断言 |
| `test:security` | 通过 | 30.8 s | 5 / 24 |
| `test:render` | 通过 | 38.5 s | 3 / 8 |
| `test:golden` | 通过 | 5.8 s | 2 / 15 |
| `test:eval` | 通过 | 2.3 s | 1 / 5 |

**集成失败与报错的分类**（方案 P0 的 Go/No-Go 要求先分类，不能把"原来就失败"当作新改动通过）：

| 文件 | 全量运行 | 复跑 | 分类 |
|---|---|---|---|
| `apps/worker/src/render-execution.integration.test.ts` | 2 项失败：`beforeEach` 钩子 10 秒超时 | **单独运行 2/2 通过** | **原有缺陷：测试隔离。** 这个旧 V4 测试在 `beforeEach` 里删除共享测试库的**全部**工作区；仓库里有 68 个测试文件用同样写法。并行跑其它文件时，这次删除最可能是在等锁。不影响产品代码；P1 加一项"测试只清理自己建的数据" |
| `packages/providers/queue-bullmq/src/queue-e2e.integration.test.ts` | 钩子超时（默认连 `127.0.0.1:56379`） | 设 `ANCS_TEST_REDIS_URL` 后通过 | 环境：本机 Redis 在 6379 |
| `packages/providers/ratelimit-redis/src/redis-rate-limit.integration.test.ts` | 连不上 `127.0.0.1:56379` | 同上，两个文件共 6/6 通过 | 环境 |
| `packages/providers/storage-s3/src/s3-storage.integration.test.ts` | 8 项跳过：`127.0.0.1:58333` 没有 S3 服务 | 未复跑：本机没装 SeaweedFS | `ENV_MISSING`：按部署手册 §10.3 起 SeaweedFS 后可测 |

### 2.1 V6 核心样例（legacy 运行时，脚本导演）

**评测脚本**：`node scripts/eval-first-cut.mjs --model scripted --export`，评测集 `evals/first-cut/smoke.json`。FFmpeg 生成三段 6 秒测试素材，按"上传 → 理解 → AI 第一版 → 自动指标 → 采用 → 终渲染 → 下载"的顺序跑。连续运行两次：

| 用例 | 用时（整例 / AI 一轮） | 工具 | 提案 | 采用 | 渲染 | 导出 sha256（两次相同） |
|---|---|---|---|---|---|---|
| 三段素材 · 不选策略（16:9） | 32.4 s / 1.1 s；33.0 s / 1.1 s | `edit_timeline` → `review_draft` | 7 个操作（`insert_clip`、`set_sequence_duration`） | 版本 4 → 5 | 13.7 s / 13.8 s，2,739,543 字节 | `96a41678…c0c5b2` |
| 三段素材 · 节奏卡点（9:16，英文） | 21.0 s / 1.1 s；20.9 s / 2.1 s | 同上 | 9 个操作 | 4 → 5 | 9.2 s / 9.2 s，1,814,210 字节 | `b5b2ccce…c258a2` |

- **同样输入得到逐字节相同的成片。** 这是 P2 / P6 对照 legacy 与 DSH 时最可靠的对照键。
- **`planHash` 每次运行都不同。** 它覆盖素材版本 ID，而 ID 每次运行都是新的。跨运行比较要用成片哈希，或先把 ID 归一化后再比 RenderPlan。同一工程内撤销 / 重做后 `planHash` 不变，这一点由现有测试覆盖。
- **脚本导演只证明流程，不衡量剪辑质量。** 成本为"未定价"，因为替身没有价格表。

**共看片室浏览器验收**：`node scripts/studio-browser-check.mjs`，证据另存，不覆盖 V6-1c 的里程碑截图。15/15 通过，用时 135 s。

覆盖的步骤：新建 → 上传 3 段 → AI 第一版成为试改 → 采用（版本 4 → 5）→ 可选风格 → 指着时间说一句得到局部试改（复用 2/5 段）→ 在试改上微调 → 整组撤销 → 导出 1920×1080、9.00 s → 任务中心 → 中英切换 → 刷新后恢复 → 键盘 → 两指缩放 → 390 px 手机宽度。截图已人工查看。

### 2.2 方案验收矩阵 T01—T24 在 ANCS 侧的现有覆盖（legacy 运行时）

"有"表示下列用例已在本次基线里运行并通过；"部分"表示覆盖了一部分断言；"无"表示需要在对应阶段新写。真实 Provider 相关的一律 `NOT_VERIFIED`。

| ID | 现有覆盖 | 用例 / 证据 | 补齐阶段 |
|---|---|---|---|
| T01 | 部分 | 内核与 RenderPlan 全程用有理时基（`render-plan-conformance.integration.test.ts`）；"30 FPS 第 1247 帧加字幕"这个具体用例没有 | P2 |
| T02 | 有 | `apps/worker/src/render-plan/ffmpeg-graph.test.ts`、`render-plan-conformance.integration.test.ts`（30000/1001） | — |
| T03 | 无 | 需要真实识别 + 真实模型，`NOT_VERIFIED` | P3 |
| T04 | 未确认 | 没有找到"悬浮不等于选中"的专门用例 | P3 |
| T05 | 部分 | `scripts/studio-browser-check.mjs`"指着时间说一句 → 局部试改预览"（脚本导演） | P3 |
| T06 | 有 | `apps/realtime/src/gateway.integration.test.ts`：句子说完才交出，未闭合的先保留 | — |
| T07 | 有 | 同上：`stop-speaking` 只中止语音回应；`apps/web/src/voice/voice.test.tsx` | — |
| T08 | 部分 | `agent-runtime.integration.test.ts`"取消 → 轮次取消"；轮次与在途媒体任务之间的一致性没有专门用例 | P3 |
| T09 | 有 | `apps/api/src/proposal-rebase.integration.test.ts`；`agent-runtime.integration.test.ts`"用户在轮次期间改过工程" | — |
| T10 | 无 | 指向已删除片段的用例没有找到 | P2 |
| T11 | 有 | `agent-runtime.integration.test.ts`"跨工作区 / 跨工程 404"；`apps/api/src/assets.security.test.ts` | P2 补桥接侧 |
| T12 | 无 | 没有"字幕 / 转写里的指令不得触发工具"的用例 | P3 / P4 |
| T13 | 部分 | legacy："续跑：从日志继续，已完成的模型调用不重复付费"。桥接幂等在 P2 才存在 | P2 |
| T14 | 有 | `apps/worker/src/paid-generation.integration.test.ts`："结果不明 → 待对账（不重试、预留保持）""进程崩溃 = 结果不明" | P5 补 DSH 侧 |
| T15 | 部分 | 采用必须带 `expectedOperationsHash` 与 `selectionFingerprint`（`proposals.ts`）；"采用过期方案被拒"没有专门用例 | P2 |
| T16 | 有 | `scripts/studio-browser-check.mjs`"撤销这次修改（整组）"→ 继续微调 | — |
| T17 | 有 | `apps/motion-worker/src/sandbox-hardening.test.ts`（motion 套件） | — |
| T18 | 有 | `composition-final-render.integration.test.ts`（qa 核对 planHash）、`test:golden`、`test:render` | — |
| T19 | 有（legacy） | `workflow.integration.test.ts`"丢租约 → LEASE_LOST 并重试"；轮次从消息日志续跑 | P3 补 DSH |
| T20 | 部分 | `eval-first-cut`"不选策略"用例只用脚本导演跑，真实模型 `NOT_VERIFIED` | P6 |
| T21 | 部分 | 界面中英：web 套件与浏览器验收的"中英切换"；中英混合音视频需要真实识别，`NOT_VERIFIED` | P6 |
| T22 | 无 | 没有长视频或多 GB 素材的性能用例 | P6 |
| T23 | 部分 | `composition-migration.test.ts` 与 `.integration.test.ts` | P2 |
| T24 | 无 | 工具结果畸形是 DSH 侧的概念：legacy 只校验工具输入，以及模型输出被截断的情况 | P2 |

## 3. 方案事实核对

### 3.1 §0.2"重要工程事实"

| 方案断言 | 核对结果 |
|---|---|
| `agent-runtime.ts` 有 `runAgentTurnLoop`、`agentTurnWorkflow`、`compileTurnContext`、`finishTurn` | ✅ 都在。另有 `createAutonomousTurn`（V6-9）和 `startGenerationTurn` / `completeGenerationTurn`（付费生成结果成为一轮）。方案没有覆盖这两组 |
| `agent-tools.ts` 有 `AgentToolCatalog`、`simulateAgentDraft`、`defaultAgentToolCatalog` | ✅ |
| `contracts/agent.ts` 的工具效果为 READ / DRAFT_EDIT / GENERATE | ⚠️ 现在是四种：多了 `PLAN`（写导演蓝图，裁决 0020） |
| `project-document.ts` 模式 FOOTAGE_EDIT / GENERATIVE / HYBRID | ✅ |
| `project_op_log` 是组合写入权威，投影器与回放已实现 | ✅ 锁定点之后投影器没有改动 |
| 提案有创建、预览、rebase、采用、弃用、部分采用 | ✅ |
| 工作流与任务有租约、重试、取消、恢复 | ✅ 锁定点之后新增了 `WAIT_UNTIL`（等条件，不计尝试次数） |
| Realtime Gateway 有转写、共同注意力、语音播报、中断 | ✅ 需要补充：**网关本身不发起 AI 轮次**。它封存话语和指向，由网页把话语当作普通的一轮发给 API，并负责读回复做语音播报 |
| RenderPlan 与编辑内核 | ✅ `packages/kernel/src/render/compile.ts`；`planHash` 只覆盖渲染内容，不含 revision 与 ID |
| DSH 的 Loop、Tool Service、Session、LLM、Session Projection 都可替换 | ✅ 见 `docs/architecture.md`。所有能力都是 Cordis 插件，"没有可打补丁的特权内核" |
| DSH 工具管线有前后策略、执行与结构化输出 | ✅ 顺序：`tools/pre-execute` → 单调守卫 → `tools/execute` → `projectContent` → `tools/post-execute` → `finalizeContent` → `tools/result` |
| DSH 自述是未审计的开发者预览 | ✅ `SAFETY.md` 原话："has not undergone a security audit and must not be treated as secure or production-ready" |
| DSH `0.2.1-rc.3`、Node ≥ 24.9.0、pnpm 11.28.5、MIT | ✅ 锁定点上都对；主干已是 `0.2.2-alpha.2` |

### 3.2 §5.1 与 §3.1 的路径

- ANCS：方案列出的 18 个路径都存在。"注意力"实际在 `packages/contracts/src/attention.ts` 与 `packages/domain/src/realtime-attention.ts`。
- DSH：方案列出的 15 个路径（`packages/core/agent-loop`、`core/tools`、`core/session`、`core/system-prompt`、`llm`、`jobs`、`session/session-projection`、`bundle/base`、`sandbox`、`credentials`、`apps/web`、`apps/desktop` 与 4 份文档）在锁定点都存在。
- 新包路径 `packages/video/<name>` 与 `packages/bundle/ancs-video` 符合 DSH 工作区通配 `packages/*/*`。

### 3.3 方案锁定点之后 ANCS 新增、方案没有覆盖的部分

V7 迁移必须一并处理：

1. **自主制作（V6-9）。**
   - 工作流 `AUTONOMOUS_PRODUCTION` 在步骤里直接调用 `runAgentTurnLoop`。
   - 轮次用途 `AUTONOMOUS`：运行时拒绝 GENERATE 工具，单轮有模型花费上限。
   - 按审批档位由系统以 AI 身份采用。
2. **导演规划与剪辑工具：**
   - `plan_production` 与 `get_production_plan`（PLAN 效果）；
   - `find_edit_points`、`caption_speech`、`measure_pace`；
   - 系统提示升到 `director-v9`。
3. **AI 月度上限与价格表。** 每次模型调用前，在运行时里检查工作区本月 AI 花费、模型是否有单价、本轮花费上限（`agent-runtime.ts` 的循环内，`workspaceAiSpend` 与 `modelIsPriced`）。
4. **模型适配器。** `packages/providers/` 下有 `anthropic`、`gemini`、`deepseek`、`elorian`（视觉）与 `mock-llm`，都实现 ANCS 的 `AgentModelAdapter`。其中 DeepSeek 导演适配器已在 ANCS 里。
5. **轮次用途 `DISCUSS_NOTE`（批注讨论，只读）。** 由运行时在执行工具前拦截非 READ 工具。

## 4. ANCS 调用链（V7-002）

```text
入口（四个，最后都进同一个循环）
  ① API  POST /workspaces/:id/agent-sessions/:sessionId/turns   apps/api/src/routes/agent.ts（需要 project:write）
         文字与语音都走这里：语音由网页把 Realtime 封存的话语 + 指向作为一轮发来
  ② 批注讨论  reviews.ts → startAgentTurn(purpose DISCUSS_NOTE)
  ③ 自主制作  autonomous-production.ts 步骤 direct → createAutonomousTurn → runAgentTurnLoop
  ④ 付费生成结果  paid-generation.ts → startGenerationTurn / completeGenerationTurn（没有模型循环，结果直接成为一轮 + 提案）

startAgentTurn (agent-runtime.ts)
  → startWorkflow(AGENT_TURN)  →  Worker 认领 WORKFLOW_ADVANCE 任务（租约 / 心跳 / 退避）
  → agentTurnWorkflow 步骤  →  runAgentTurnLoop

runAgentTurnLoop：每一步都持久化到 Postgres，可以从任意一步恢复
  reconcileContinuedTrial：在上一版试改上继续时，草稿换到最新基线
  compileTurnContext：只在第一步编译。工程状态、指向、计划、策略、自主制作交代 → 第一条 user 消息
  循环：
    取消检查（工作流 CANCEL_REQUESTED）
    门禁：步数上限 → 工作区本月 AI 上限 → 有上限却无单价 → 本轮花费上限
    ports.model.respond(AGENT_SYSTEM_PROMPT director-v9, 22 个工具描述, 消息日志)
    事务：写 assistant 消息 + 用量 + 花费
    逐个 tool_use：
      用途门禁（DISCUSS_NOTE 只读；AUTONOMOUS 不许 GENERATE）
      zod 校验 → tool.run(AgentToolContext{ draft, pointer, ports… })
      DRAFT_EDIT 返回整份新草稿：simulateAgentDraft 用内核在内存里试算，非法即报错
    事务：写工具结果 + 草稿 + toolCalls
  finishTurn：草稿非空 → 建提案（基线过期时先在当前 revision 上重验）→ 轮次完成

采用（只经用户或授权档位）
  API proposals/:id/adopt → adoptProposal（proposals.ts）
  → 追加操作日志 → composition-projector 写组合表 → revision + 1

渲染
  内核 compile → RenderPlan（planHash）→ 低清预览（planHash 作缓存键）
  终渲染工作流 freeze → render → qa；qa 从存储读回产物，核对 planHash

循环外的模型调用
  apps/worker/src/model-visual-analysis.ts：素材画面描述。计入 AI 月度上限，属于媒体理解管线，V7 不迁移
```

**对 V7 有决定意义的三点：**

1. **只有一个循环函数。** 四个入口里有三个最终调用 `runAgentTurnLoop`（④ 不经模型）。在它外面加一层 `AgentRuntimePort`，就能覆盖文字、语音、批注讨论、自主制作，不必改各个入口。
2. **草稿状态在 ANCS。** 每一轮的草稿（`agent_turns.draft_operations` + `base_revision`）在每次工具调用后落库，DRAFT_EDIT 工具返回整份新草稿。DSH 侧的工具因此不能是无状态代理：桥接必须按 `turnId` 读写 ANCS 里的草稿，并按 `toolCallId` 幂等。
3. **花费门禁也在循环里。** 若改由 DSH 直接调模型，每次调用前的三道花费门禁会跟着离开 ANCS，必须显式迁移（风险 R-03）。

## 5. 逐文件迁移矩阵（修订方案 §5.1）

| ANCS 文件 | 现在的职责 | V7 去向 | 阶段 |
|---|---|---|---|
| `domain/src/agent-runtime.ts` | 循环、上下文、门禁、提案结算 | 抽出 `AgentRuntimePort`。`legacy` 实现就是现有循环，原样保留；`dsh` 实现：ANCS 建轮次 → 交给 DSH → DSH 经桥接调工具 → ANCS 按现有 `finishTurn` 结算 | P1 抽口，P2 接 DSH |
| `domain/src/agent-tools.ts` 及 `agent-edit-points.ts`、`agent-effects.ts`、`agent-narration.ts`、`agent-generation.ts`、`agent-article.ts`、`production-plan.ts` | 22 个工具（READ 13、DRAFT_EDIT 7、PLAN 1、GENERATE 1） | **原样留在 ANCS。** 桥接按名称调用同一个 `tool.run`；DSH 侧注册同名代理工具（`video.*` 别名在 P2 定） | P2 |
| `domain/src/agent-prompt.ts` | `director-v9` 系统提示 | 静态部分迁入 DSH Video Profile。版本号保留，作为评测对照 | P4 |
| `domain/src/ai-spend.ts` 与价格表 | 每次模型调用前的月度上限与单价门禁 | 两种方案二选一（R-03）：DSH 的 `agent/pre-step` 守卫经桥接询问 ANCS，或模型调用经 ANCS 代理 | P1 定方案，P2 实现 |
| `domain/src/autonomous-production.ts` | 自主制作工作流，直接调循环 | 改调 `AgentRuntimePort`；门禁、采用、报告不动 | P1（端口），P4（DSH） |
| `domain/src/reviews.ts`、`paid-generation.ts` | 批注讨论轮次；生成结果轮次 | 前者随端口；后者不经模型，**不迁移** | P1 / — |
| `contracts/src/agent.ts` | 工具描述、轮次、指向 | 只增不改：新增 `video-tool.v1` 调用与结果信封（单独文件），保留 `PLAN` 与现有枚举 | P1 |
| `db/src/schema/agent.ts` | 会话、轮次、消息、用量 | 扩展式迁移：轮次加 `runtime`（默认 `legacy`）与 DSH 会话引用；**有需要才建**方案建议的绑定表 | P2 |
| `apps/api/src/routes/agent.ts` | 轮次 API | 不变：认证、授权、错误码、幂等照旧 | — |
| `apps/worker/src/main.ts` | 装配模型、工具端口、工作流 | 按配置选运行时（入口校验后注入，业务包不读 `process.env`） | P1 |
| `apps/realtime/src/gateway.ts` | 话语封存、指向、语音播报 | 不变：它不发起轮次 | — |
| `domain/src/proposals.ts`、`composition-projector.ts`、`kernel/*`、`worker/src/render-plan/*` | 采用权威、写权威、内核、渲染 | **不变**（SOT-01/02/07） | — |
| `providers/{anthropic,gemini,deepseek,elorian,mock-llm}` | ANCS 模型适配器 | legacy 继续使用；DSH 用自己的 `ctx.llm` 适配器（`llm-deepseek-*`、`llm-pi-ai`）。两边的价格表需要对齐 | P2 |
| `scripts/lib/scripted-director.mjs` | 免费、可重复的测试替身导演 | DSH 侧用它自带的 `llm-mock-server`（Messages 兼容、可编排工具调用）做同等替身，让 P2 端到端仍然零费用 | P2 |

## 6. DSH 审计（V7-003，静态）

### 6.1 运行时模型
Cordis 插件树。

- 每项能力是一个插件，挂在 `ctx.<service>` 上（`ctx.tools`、`ctx.llm`、`ctx.sessions`、`ctx.agents`、`ctx.agentLoop`、`ctx.jobs`……）。
- 注册都是可撤销的副作用。
- 启动时按 profile 依次叠加 bundle 与补丁。`dsh --profile <名> --dump-config` 打印实际挂载的整棵树。
- 新行为挂在文档化的扩展点上；改 `agent-loop` 本身要同时更新 `docs/architecture.md`。

### 6.2 对外接口：SDK（stdio 上的 JSON-RPC）

| 方向 | 内容 |
|---|---|
| 客户端发起的请求 | `initialize`、`session/prompt`、`session/resume`、`session/wait`、`session/working-directory/get|set`、`shutdown` |
| 服务端通知 | `session.event`（完整会话日志事件）、`session.status`、`subagent.started|finished`、`user-question.cancelled` |
| 服务端发起的请求 | `user-question/ask`、`approval/request`（一次性允许 / 拒绝 / 取消） |

**SDK 不支持宿主自定义工具。** 所以视频工具必须写成 Fork 里的 DSH 插件（`ctx.tools.register`），在插件里回调 ANCS 桥接接口。这与方案 §2.2 一致。

另一种做法：DSH 自带 `mcp-client`，ANCS 可以把桥接做成 MCP 服务器，工具层就不用写 Fork 代码。但那样会失去类型化输出、`isConcurrencySafe`、`presentCall/Result`，以及按草稿语义的结果投影。**建议走 Fork 插件**，MCP 只作为备选传输。

### 6.3 工具契约对照

| | DSH `ToolDefinition` | ANCS `AgentToolDefinition` | 桥接要做的事 |
|---|---|---|---|
| 输入 | 参数 DSL 或原始 JSON Schema（原始 Schema 的工具自己负责校验） | zod；`descriptors()` 已能导出 JSON Schema | 用原始 JSON Schema 注册；ANCS 侧照旧用 zod 再校验一次 |
| 输出 | **必须**声明 `output.schema`，返回一个规范 JSON 值，再由 `render` 生成内容块 | `{ content: JSON 文本, isError, summary, draftOperations?, baseRevision?, images? }` | 定义 `video-tool.v1` 结果信封：`resultStatus`、`projectRevision`、草稿版本、`content`、`summary`、`images`、`traceId`、`cost?` |
| 取消与超时 | `exec.signal`、`timeoutMs`（协作式） | 无单工具取消；按轮次在步骤边界检查 | 桥接请求带上 signal 与截止时间；ANCS 侧按幂等键记录状态（NOT_STARTED / RUNNING / COMMITTED / FAILED / UNKNOWN） |
| 并发 | `isConcurrencySafe` 可选并行 | 串行；DRAFT_EDIT 改写整份草稿 | 只有 READ 工具声明可并行 |
| 状态 | 无（工具不拥有会话状态以外的东西） | 依赖本轮草稿 | 草稿只放在 ANCS（§4 第 2 点） |
| 图像 | `render` 返回内容块 | `look_at_*` 返回 base64 图像 | P1 要验证 DSH 内容块是否支持图像，以及尺寸上限 |

### 6.4 最小权限

- **`dsh-base`（web / headless / sdk / acp 共用的第一层）挂载了：**
  - Bash 与 PowerShell 工具；
  - 文件读、写、编辑与搜索；
  - 网页抓取与搜索；
  - 代码执行运行时（PTC）；
  - 子代理；
  - 从文件系统加载技能；
  - 插件管理器的工具；
  - 工作流；
  - 配置编辑器；
  - 本地凭据；
  - 远程访问与 API 网关。

  默认权限模式是 `workspace-write`。**ANCS 不能叠在 `dsh-base` 上。**
- **`dsh-sdk-minimal` 是自带完整插件树、不叠 base 的先例**，但它挂了持久 Shell，策略是 `danger-full-access`。
- **ANCS 视频 bundle 应参照 sdk-minimal 写成完整独立的树，并去掉：**
  - Shell、终端、子进程；
  - 文件写与编辑工具；
  - 工作目录工具；
  - 网页工具、PTC、子代理、插件管理器。

  只保留会话、模型、工具注册与执行器、压缩、会话投影，以及视频工具插件。
- **证明方式**是 `--dump-config` 输出与一份"禁止出现的插件"测试。需要运行 DSH，本轮 `NOT_RUN`。

### 6.5 持久化与恢复

- **会话日志**
  - 默认是 `$DSH_HOME/sessions` 下的 JSONL 文件，用本地原生文件锁保证单写者。
  - 会话格式已演进到 v4，每次升级都有逐级迁移包。
  - 想放到别处，需要实现 `SessionPersistence`（`create/open/stat/list/export`）。
- **与 ANCS 的差别**
  - ANCS 现在每一步写进 Postgres，并由工作流租约恢复。
  - 换成 DSH 后，容器重建或多实例部署时，要么挂持久卷并保证一个会话只有一个属主，要么写一个 Postgres 后端（风险 R-02）。
- **检查点**：`session-checkpoint-policy` 在每次模型请求、每次顶层工具执行之前刷盘。

### 6.6 模型

| 适配器 | 覆盖 |
|---|---|
| `llm-deepseek-api-key` / `llm-deepseek-account` | DeepSeek |
| `llm-pi-ai` | 经 pi-ai 目录接 Anthropic、OpenAI、Gemini 与自定义网关 |
| `token-meter` | 计量 |

ANCS 的价格表、月度上限和"无单价不调用"规则不在 DSH 里（R-03）。

### 6.7 工具链、原生代码、依赖与许可

- **工具链**：Node ≥ 24.9、pnpm 11.28.5。`strictDepBuilds` 规定：凡是带安装脚本的依赖都必须先列入白名单。
- **原生代码**：Linux 沙箱启动器（Landlock）在 `native/system`。本机有 Rust 与 C 工具链，但没有构建。
- **规模**：锁文件里有 1,742 个第三方包条目；工作区约 365 个 `package.json`；Cordis 以 vendored 方式内置在 `vendor/`。
- **许可**：MIT（"Copyright (c) 2026 DeepSeek"）。`THIRD_PARTY_NOTICES.md` 共 313 行，由脚本生成并有校验。Fork 必须保留两者。
- **贡献规则很重**，会抬高 Fork 内的开发成本，P1 要预留这部分工作量。要求包括：
  - 每个包都要有中英 README 与 i18n 配对；
  - 改动模型可见的行为要更新录制的会话快照，并同时更新 TypeScript 与 Python SDK 的期望输出；
  - 生成的目录类文档要和代码同步；
  - 不得新增 `as unknown`；
  - 跨边界 ID 要用品牌类型。

### 6.8 没有运行的项目

**状态：`NOT_RUN`。**

- **没有运行的项目**：`pnpm install --frozen-lockfile`、`build`、`typecheck`、`lint`、`test`，以及 `--dump-config`。
- **原因**：这些命令会执行外部仓库的代码，本开发容器的自动安全检查拒绝了安装。我没有尝试绕过。
- **已准备好的条件**：Node 24 与 pnpm 11 已装在独立前缀；运行命令时用最小环境（不带令牌与云凭据、单独的 HOME）。
- **补跑**：所有者允许在这里运行，或在 Fork 仓库自己的 CI / 独立机器上运行后，即可补跑。

## 7. 风险清单

| 编号 | 风险 | 影响 | 处理 | 决定所需证据 |
|---|---|---|---|---|
| R-01 | DSH 上游变化极快：5 天 637 个提交；会话格式已到 v4 | Fork 同步成本不可控 | 锁定一个版本；视频代码集中在 `packages/video/*` 与自有 bundle；按需同步（安全补丁、季度） | 每次同步的差异统计 + 全量测试通过率 |
| R-02 | 两套持久化：ANCS 用 Postgres + 工作流租约，DSH 用 JSONL + 本地文件锁 | 容器重建、多实例时丢会话或双写 | P2 先用持久卷 + 单属主；P3 评估 Postgres `SessionPersistence` | 停机恢复、并发打开的端到端测试 |
| R-03 | 模型调用离开 ANCS 后，月度上限、价格表、"无单价不调用"失效 | 超支；违反已交付的计费承诺 | P1 二选一：模型调用前由 DSH 守卫询问 ANCS，或模型调用经 ANCS 代理 | 设了上限时，未定价模型 0 次调用的测试 |
| R-04 | 草稿状态在 ANCS，DSH 工具调用会重试、超时 | 重复改写、草稿错乱 | 桥接按 `turnId + toolCallId + toolVersion` 幂等；同版本、同参数哈希时重放结果 | 断网重放 DRAFT_EDIT 不产生重复提案的测试（T13） |
| R-05 | `dsh-base` 权限过宽；sdk-minimal 带全权 Shell | 文件、凭据泄露 | 视频 bundle 写成完整独立的树，用 dump-config 与禁止插件清单做测试 | `--dump-config` + 对抗测试 |
| R-06 | 运行时分裂：DSH 需要 Node 24 / pnpm 11，ANCS 是 Node 22 / pnpm 9 | 镜像、部署、运维多一套 | DSH 独立镜像与进程；compose 新增服务；不共享 `node_modules` | 部署演练 |
| R-07 | 方案锁定点之后的 ANCS 新功能（自主制作、PLAN、批注讨论、生成轮次）在方案里没有对应 | 迁移遗漏，行为回退 | 本审计 §3.3 / §5 已列入；P2 合同测试覆盖四种轮次用途 | 四种用途各一条端到端测试 |
| R-08 | 工具目录与提示要逐字节稳定（ANCS 为提示缓存这样做），DSH 自己组装 schema | 缓存失效，成本上升 | P2 对比两边请求的前缀稳定性 | 连续两轮的请求前缀哈希 |
| R-09 | DSH 未经安全审计 | 被提示注入后越权 | 独立低权限容器；出网只允许 ANCS 桥接与模型 API；无数据库凭据 | 安全对抗测试（T11、T12、T17） |
| R-10 | Fork 贡献规则的工作量（§6.7） | P1/P2 比预估慢 | 先只做 `video-contracts`、`video-tools`、`ancs-video` bundle 三个包 | — |

## 8. Go / No-Go

| 方向 | 判断 | 依据 |
|---|---|---|
| ANCS 基线 | **Go**：已实现的套件全部通过，或已分类到原有测试隔离缺陷 / 环境；[PLANNED] 不计为通过 | §2 |
| P1 · ANCS 侧（不依赖 Fork） | **Go** | 不改行为、可单独回滚：抽 `AgentRuntimePort`（legacy 原样）、运行时开关、`video-tool.v1` 信封契约、桥接鉴权设计 |
| P1 · DSH 侧 | **No-Go，等所有者** | 没有 Fork 仓库，没有运行 DSH 代码的许可（§9） |

## 9. 需要所有者决定或提供的事项

1. **Fork 仓库**
   - 由谁创建、放在哪个账号下、叫什么名字（方案建议 `ANCS-Video-Harness`）；
   - 给本会话推送权限。

   未获得仓库地址与权限之前，不宣称 Fork 已创建（方案 §11.1）。
2. **是否允许运行 DSH 代码**
   - 方式一：在本开发容器里运行（安装、构建、测试，会执行外部代码）；
   - 方式二：只在 Fork 仓库的 CI 或独立机器上运行。
3. **锁定哪个 DSH 版本**
   - 继续用方案的 `22ddee37`（`0.2.1-rc.3`）；
   - 或改锁当前主干 `f3803c96`（`0.2.2-alpha.2`）。扩展点在两者之间几乎没变（§1）。
4. **生产运行时与模型**
   - DSH 服务用独立镜像（Node 24）；
   - DSH 侧先接哪家模型。真实模型调用仍需你先同意额度。

## 10. P1 任务拆分

**ANCS 侧（下一步就做）：**

- **V7-006a `AgentRuntimePort`**
  - 在 `packages/domain` 定义端口，`legacy` 实现就是现有的 `runAgentTurnLoop`；
  - `agentTurnWorkflow` 与自主制作的 `direct` 步骤改调端口；
  - 现有单元、集成与浏览器测试不变即通过。
- **V7-006b 运行时开关**
  - 合同里的 Worker 环境 schema 新增运行时选择：`legacy` / `dsh_shadow` / `dsh_active`，默认 `legacy`；
  - 后两个值在 DSH 实现落地前启动即失败，并说明原因；
  - 在入口校验后注入。
- **V7-005a `video-tool.v1` 契约**
  - 调用信封与结果信封（zod + 版本号），由现有 `AgentToolDescriptor` 派生，保留 `PLAN`；
  - 合同测试覆盖：拒绝未知版本、超长结果、跨工程引用。
- **V7-001b 基线可靠性**
  - 把 `render-execution.integration.test.ts` 改成只清理自己建的工作区；
  - 其余 67 个"`beforeEach` 删除全部工作区"的测试文件按触碰顺序逐步改；
  - 本地集成运行的 Redis / S3 地址写进开发说明。

  P2 / P6 的 legacy 与 DSH 对照依赖一次干净的全量运行。
- **V7-005b 桥接鉴权设计**
  - ANCS 开始一轮时，签发只对这一轮有效的短期令牌：绑定工作区、工程、会话、轮次、到期时间；
  - DSH 只拿这个令牌；未带令牌的请求一律拒绝；
  - 先写设计与测试计划，接口在 P2 与工具桥一起落地。

**DSH 侧（§9 解决后）：**

- **V7-004**
  - Fork 并添加 `upstream`；保留 LICENSE 与 THIRD_PARTY_NOTICES；
  - 新增 `packages/video/video-contracts`（与 ANCS `video-tool.v1` 对齐）；
  - 新增 `packages/bundle/ancs-video`（完整独立树，§6.4），及其 dump-config 与禁止插件测试；
  - 跑通 DSH 原有测试。
- **V7-007（P2 起）**
  - `packages/video/video-tools`：22 个代理工具，带 signal、超时与 READ 并行声明；
  - 用 `llm-mock-server` 做零费用的脚本导演。

## 11. 命令与结果

```text
# 服务（本地）
PostgreSQL 16 @ 55433（ancs_test）；Redis @ 6379；Next 生产服务 127.0.0.1:3000

# ANCS 基线：每步单独运行、单独计时（脚本逐项运行 verify.mjs 的同一组步骤，失败不中断）
ANCS_TEST_DATABASE_URL=… REMOTION_BROWSER_EXECUTABLE=… ANCS_BROWSER_EXECUTABLE=… \
  pnpm run secrets:check | spec:check | lint | typecheck | build | arch:check | capabilities:check \
           | test:unit | test:web | test:motion | test:contract | test:integration | test:e2e \
           | test:security | test:render | test:golden | test:eval
# 结果见 §2

# 集成失败复跑
npx vitest run --project integration apps/worker/src/render-execution.integration.test.ts   → 2/2
ANCS_TEST_REDIS_URL=redis://127.0.0.1:6379 npx vitest run --project integration \
  packages/providers/queue-bullmq/src/queue-e2e.integration.test.ts \
  packages/providers/ratelimit-redis/src/redis-rate-limit.integration.test.ts              → 6/6

# V6 核心样例（运行两次）与浏览器验收
node scripts/eval-first-cut.mjs --model scripted --export                                   → 2/2 用例 OK（两次）
ANCS_EVIDENCE_DIR=<临时目录> node scripts/studio-browser-check.mjs                           → 15/15

# 工具目录（构建产物）
node -e "defaultAgentToolCatalog().descriptors()"                                           → 22 个工具，director-v9

# DSH（静态）
git clone --depth 1 https://github.com/deepseek-ai/deepseek-harness
git fetch --depth 1 origin 22ddee3792402c3e70ec5f86a63c3e3e895a2f60
git worktree add --detach <dsh-locked> 22ddee37…
git diff --shortstat / --dirstat 22ddee37… origin/master                                   → §1
pnpm install --frozen-lockfile（Node 24.22.0、pnpm 11.28.5、最小环境）                       → 未运行：被自动安全检查拦下
```
