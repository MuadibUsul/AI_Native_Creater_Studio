# ANCS v0.5｜架构审查与 V5 架构方案

| 属性 | 说明 |
|---|---|
| 文档日期 | 2026-10-11 |
| 状态 | **PROPOSED**（待项目所有者确认；确认前 v0.4 仍是唯一生效规范） |
| 审查对象 | `docs/V04/` 全部文件：总规范 `ANCS_AI_Native_v0.4.md`（§1—§29）、`ANCS_v0.4_Task_Backlog.md`、`task_index.json`、`ANCS_v0.4_Traceability.md`、`ANCS_v0.4_Incremental_Changes.md`、`ANCS_v04_Mouse_Voice_Incremental_Design_20261010.md`、设计系统/运营后台分册 |
| 对照的代码事实 | 分支 `codex/v04-foundation`（HEAD `12620e9`），以及 `docs/reviews/v04-code-review-20261011.md` 的实测结论 |
| 本文性质 | **架构增量**：不缩减 v0.4 §1.1 的任何产品要求，不删除 N 系列任务；只改变"怎么组织系统、怎么交付"。不是功能已完成报告 |

> 一句话结论：v0.4 的**产品需求和领域约束**是对的，而且相当完整；问题在于它把"约束清单"当成了"架构"。系统缺一个**可在内存中运行的编辑内核**作为唯一权威，导致试改、rebase、预览、多端、清理、时间精度等问题在各处被重复、局部地解决。V5 的核心是：**ProjectDocument 内核化 + 操作日志权威 + 关系表降为投影 + 一个能力注册表 + 一个工作流引擎**，并把 452 KB 的单体规范拆成可机读、可校验的单一事实源。

---

## 目录

- [一、审查范围与方法](#s1)
- [二、v0.4 应保留的架构优点](#s2)
- [三、v0.4 架构问题（带证据）](#s3)
- [四、V5 架构原则](#s4)
- [五、V5 总体架构](#s5)
- [六、编辑内核与 ProjectDocument 存储模型](#s6)
- [七、时间模型收口](#s7)
- [八、交互、意图与实时通道](#s8)
- [九、提案（Proposal）在内核上的重定义](#s9)
- [十、统一能力注册表与 Agent 运行时](#s10)
- [十一、工作流引擎、任务与费用账本](#s11)
- [十二、媒体管线与 Worker 资源池](#s12)
- [十三、播放、RenderPlan IR 与一致性](#s13)
- [十四、数据、引用图与生命周期](#s14)
- [十五、安全架构](#s15)
- [十六、运营后台架构](#s16)
- [十七、多端、SDK 与同步协议](#s17)
- [十八、质量与验证架构](#s18)
- [十九、规范与交付治理](#s19)
- [二十、从 v0.4 迁移到 V5 的路线](#s20)
- [二十一、V5 架构决策记录（ADR）清单](#s21)
- [二十二、风险与待决策](#s22)

---

<a id="s1"></a>
## 一、审查范围与方法

1. **通读架构相关章节**：§1（权威与裁决）、§2（复用地图）、§7—§10（注意力、语音、Agent、提案）、§12—§15（作品状态、时间、编辑事务、生成、播放与渲染）、§17—§19（后端/API/迁移、成本可靠性、安全）、§21—§22（门与完成定义）、§26（待决策）、§28.19—28.20（运营数据模型与门），以及鼠标×语音增量设计 §6—§9。
2. **与实现对照**：每条问题尽量给出"规范条款 ↔ 代码事实"两侧证据，代码证据来自本分支（迁移已到 0086，`packages/domain` 约 100 个模块，`edits.ts` 3,158 行，`sdk/src/client.ts` 3,120 行，Web 约 6.3k 行 TSX）。
3. **判定口径**：只把"会导致需求无法达成、状态不一致、重复实现或无法验证"的问题列为架构问题；纯实现缺陷见代码审查报告，不在此重复。

---

<a id="s2"></a>
## 二、v0.4 应保留的架构优点

V5 **完整继承**以下设计，不作改动：

| # | v0.4 设计 | 位置 | 保留理由 |
|---|---|---|---|
| K1 | 唯一 ProjectDocument，时间轴/语义/预览均为投影 | §12.1 | 方向完全正确；V5 只是把它从"原则"落实为"可执行内核" |
| K2 | 有理时基 `MediaTime{ticks,timebase}`、源/序列时间分离、`timeMapping` | §12.3—12.4 | 专业剪辑的必要前提 |
| K3 | 统一编辑操作协议，GUI/语音/Agent 同一入口 | §13.1、§13.5、§9.5 | 消除"多套编辑逻辑" |
| K4 | 三态分离：acceptedRevision / proposalRevision / frozenVersionId | §10.1 | 清晰的创作收敛模型 |
| K5 | 补偿式 Undo，不改写历史 | §10.5、§10.6 | 审计与可恢复性 |
| K6 | SelectionAnchor ⊂ AttentionSnapshot，服务端重新校验归属 | §7.5 | 防越权、防陈旧引用 |
| K7 | 三条执行通道：本地反馈 / 实时会话 / 正式制作 | 增量设计 §6.2 | 正确的延迟分层 |
| K8 | 共享 RenderPlan + 按能力分区（FFmpeg / Remotion / 已批准资产） | §15.10—15.11 | 预览与终渲染一致性的正确抽象 |
| K9 | 费用 estimate → reserve → submit → reconcile → release，CostQuote | §18.1、§18.6 | 付费生成的必要护栏 |
| K10 | 外部内容一律不可信，高影响动作由后端检查 | §19.2 | Agent 系统的安全底线 |
| K11 | AdminAction（预检/审批/幂等/逐项结果/审计） | §28.5 | 运营写操作的统一入口 |
| K12 | "只有 VERIFIED 计入完成"、Mock ≠ 真实 | §22.1—22.2 | 交付诚实性 |

---

<a id="s3"></a>
## 三、v0.4 架构问题（带证据）

严重度：**A** = 结构性问题，不改会持续产生缺陷/重复工作；**B** = 会拖慢交付或制造不一致；**C** = 改进项。

### A1 缺少"可在内存中运行的编辑内核"，ProjectDocument 只是读时拼装

- **规范侧**：§12.1 要求唯一 ProjectDocument，§13.2 要求"在候选状态顺序模拟整批操作"，§10.5 要求无冲突补丁可 rebase，增量设计 §6.2 要求"简单位移、字幕大小通过共享确定性操作内核试改"。但 §17.3 只给出"增量数据库表"清单，**从未定义内核的形态**（纯函数？在哪运行？谁持有状态？）。
- **代码侧**：
  - ProjectDocument 由多张关系表（`scenes`、`sequence_tracks`、`sequence_clips`、`composition_*`）在读时拼装（`packages/domain/src/project-document.ts`），写路径直接操作这些表（`packages/domain/src/edits.ts`，3,158 行，直接依赖 Drizzle 表对象；领域层 84 个文件依赖 `@ancs/db`）。
  - "试改"的实现方式是**在真实数据库事务里执行正式编辑，再抛异常回滚**（`packages/domain/src/proposals.ts:555-608`）。这会持有行锁、阻塞同项目正式编辑，且无法在浏览器或 Worker 中复用。
  - rebase、A/B 比较、确认内容保护都各自"跑一次真实事务再回滚"。
- **后果**：§13.2 的"模拟"、§10.5 的"rebase"、增量设计的"本地 ghost 预览"、§17 的"多端复用契约"都没有共同基础；每个功能用 DB 事务各自模拟，性能和一致性都受限。**这是 v0.4 最大的架构缺口。**

### A2 权威写路径在迁移期是"按项目切换"的双轨

- **规范侧**：§12.5 "禁止同时让旧表和新文档被两个写入口独立修改"。
- **代码侧**：`project_composition_migrations.authorityMode` 按项目决定权威（`packages/domain/src/composition-migration.ts:245-257`），旧 Scene 写入口与 Composition 写入口长期并存，ProjectDocument 由 `projectDocumentFromSceneGraph` 等适配器拼装。
- **后果**：每个新操作都要考虑两种权威模式；清理任务的引用检查只覆盖了旧 Scene 绑定，漏掉 `sequence_clips`（代码审查 P0-2）就是这种双轨的直接产物。v0.4 没有给出**旧写入口的关闭期限**。

### A3 时间精度原则未落到"唯一时间库"

- **规范侧**：§12.3 定义了有理时基，§15.8 规定 `playheadMs` 只能是显示值。
- **代码侧**：`mediaTimeToLegacyMilliseconds` 对非整毫秒时间直接抛异常，却被用在提案试改、范围编辑规划和浏览器播放路径上（约 50 处引用、14 个文件）；`mediaTime → ms` 还有至少 4 份实现（`playback-source.ts:235`、`playback-engine.ts:311`、`media-clock.ts:198`、`common/media-time.ts:150`）。实测 29.97fps 一帧、48kHz 一个采样、1/15360 时基都会抛异常（代码审查 P0-1）。
- **后果**：规范要求的精度在 v0.4 架构里没有"唯一出口"，于是每个模块自带换算。

### A4 会话/意图/注意力概念重叠，缺少归属图

v0.4 先后引入了：`InteractionSession`（§17.2）、`VoiceSession`（N05-01）、`ConversationSession`（N07-10）、`IntentSession / IntentRevision`（增量设计 §8.3）、`AttentionSnapshot`（§7.4）、`SelectionAnchor`（§7.5）、`EventEnvelope`（增量设计 §8.4）、`ReviewSession`（§15.3）。它们的**生命周期归属、谁引用谁、哪个是事实源**分散在不同章节和增量文档中。

- 代码侧已出现症状：语音会话签发的短期凭证从未被任何端点校验（代码审查 P1-4），因为"实时通道"在架构上没有落点——API 是请求/响应式 Fastify，规范没有定义实时网关。

### A5 三套"能力注册表"

- `EditOperation` 注册表（§13.1，代码 `EDIT_OPERATION_REGISTRY`）
- Edit Operation v2 别名编译（§13.5，N01-11）
- Agent Tool Registry（§9.5，N07-09）
- 再加上 GUI 命令面板/快捷键（§4.5、N04-11）和 Provider 能力目录（§14.2）

§9.5 说"GUI、命令面板、快捷键共用同一能力注册事实"，但没有定义**哪一份是源、其余如何生成**。三份手写注册表必然漂移（字段：读写集、成本类别、权限、可逆信息、支持后端在每份里都要写一遍）。

### A6 长流程没有统一的编排模型

§14.7（区域重生成：提案→报价→授权→Job→资产→QA→replace_region→审阅）、§18.1（费用五步）、§15.1（冻结→合成→QA→交付）、§28.5（AdminAction 预检→审批→执行→逐项结果）、N02-11（分析 DAG 检查点）都是**多步、跨外部系统、需补偿**的流程。v0.4 只有 Jobs + Outbox + 租约（§18.3），每个流程都在领域代码里手写状态机。

- 代码侧：`jobs`、`render-execution`、`cms` 写回、`media-transcripts`、`custom-motion` 等各自实现重试/去重/状态推进；`FOR UPDATE` 散布在十余处。

### A7 Provider 接入缺少统一网关，Mock 与真实的边界只靠日志

- §14.2 要求能力目录与路由，§18 要求费用账本，§22 要求 Mock ≠ 真实。但架构上 Provider 调用散落在 API 入口装配（`apps/api/src/index.ts`）、Worker（`apps/worker/src/main.ts`）和各路由；生产环境下 Mock 只打 `console.warn`；Deepgram 真实适配器写好了却没进 Worker 装配（代码审查 R-4/R-5）。
- 缺少一个所有付费/外部调用必经的**Provider Gateway**（路由、限流、预算预留、计量、重试策略、Mock 标记、审计）。

### A8 引用关系没有一等建模，生命周期只能靠扫描猜

- §18.4 "回收基于引用关系"，§13.4 "派生资产记录输入 hash"。但规范没有定义**引用图**这一数据结构。
- 代码侧：资产是否被引用靠"Scene jsonb 包含"+"版本快照文本 `LIKE '%id%'`"+"派生边"三种查询拼凑（`packages/domain/src/retention.ts:282-318`），漏掉时间线片段导致清理整轮中断。

### A9 规范自身是单体、多源，且无机器校验

- 总规范 452 KB / 6,161 行，混合了需求、架构、219 项任务、追踪矩阵、旧条款处置、运营、设计；另有 `Task_Backlog`（205 KB）、`task_index.json`（319 KB）、`Traceability`、`Incremental_Changes`（与 §27 重复）、鼠标×语音增量设计（又一份增量）。
- §22.5—22.7 声称多份文件"由同一源生成"，但仓库中**没有生成脚本**（`scripts/` 下无 `task_index` 相关工具）。
- 实际症状：验收账本统计口径在同一会话内出现多个数字；N04-09 已 `VERIFIED` 而其依赖 N04-05 仍 `IN_PROGRESS`；N06-02 缺独立证据文件（代码审查 R-1—R-3）。
- 架构信息（模块边界、进程拓扑、数据流）没有任何图或独立文档，散落在 §2、§12—§17 的叙述中，接手者很难快速建立心智模型。

### A10 横向铺开超过纵向闭合

- 规范：219 项任务、17 个工作流，G0 只依赖 N00—N03 + N03-16，但运营（N15，40 项）、设计（N16）、专业能力（N11/N12）均被声明为"横切可并行"。
- 现实：55/219 VERIFIED（全部为 Mock 级），G0 仍未通过（被 N03-16 阻塞），后端约 8.3 万行而 Web 约 6.3k 行；大量 VERIFIED 后端能力没有用户可达入口。
- 架构层面的原因：没有"核心 vs 扩展"的硬边界，任何新能力都直接改核心模块（`edits.ts`、`contracts/index.ts`、`sdk/client.ts` 全是单体大文件）。

### B 级问题

| # | 问题 | 证据 |
|---|---|---|
| B1 | API 层缺统一的入口防护（限流、CORS、CSP、配额），被留作"部署决策" | `apps/api/src/server.ts` 无 rate-limit/cors；`apps/web/next.config.mjs` 无安全头；决策 0010 遗留 |
| B2 | 配置读取分散：领域层读 `process.env`，Worker/CLI 绕过已校验 schema，同一密钥派生逻辑复制 3 份 | `packages/domain/src/plans.ts:41`；`apps/worker/src/domain.ts:38-60`；`apps/api/src/cli/retention-sweep.ts:28-33` |
| B3 | SDK 手写，契约外自定义响应 schema，与 OpenAPI 无对账 | `packages/sdk/src/client.ts:4-11` |
| B4 | 租户隔离只在应用层（每条查询手写 `workspaceId` 条件），无纵深防御 | §12.2 "跨表引用也检查归属"仅为应用约定 |
| B5 | 幂等作用域按路由模板而非实际资源 | `apps/api/src/plugins/idempotency.ts:47`（代码审查 P1-2） |
| B6 | 任务状态模型只有 `TODO/IN_PROGRESS/IMPLEMENTED_UNVERIFIED/VERIFIED`，真实性级别写在文字说明里 | §22.1；验收账本头部"证据级别"段落 |
| B7 | 运营后台 24 模块 / 40 任务与核心并行，O0 范围（N15-01—08、10、12—18、21、24、33、37）对内部试用而言偏大 | §28.20 |

---

<a id="s4"></a>
## 四、V5 架构原则

1. **内核优先（Kernel First）**：作品状态的所有变更规则存在于一个**纯 TypeScript、无 I/O** 的编辑内核中；服务端、浏览器、Worker、测试都调用同一内核。数据库只负责持久化与查询，不承载编辑规则。
2. **操作日志为权威，关系表为投影**：确认版 = 快照 + 有序操作日志；关系表（片段、轨道、引用图、索引）是可重建的读投影。
3. **一个时间库，毫秒只在显示边界**：权威路径禁止出现毫秒整数和浮点秒。
4. **一份能力定义，多处生成**：操作、Agent 工具、GUI 命令、OpenAPI、SDK 方法、成本类别、权限都从同一份能力定义派生。
5. **所有外部副作用经工作流引擎**：付费调用、外部发布、长任务、AdminAction 统一为可恢复、可补偿、可审计的工作流。
6. **所有外部/付费调用经 Provider Gateway**：路由、配额、预算预留、计量、Mock 标识在一个地方执行。
7. **核心封闭，扩展开放**：效果、Provider、策略包、渲染后端、发布渠道、Pack 通过稳定 SPI 接入，不修改内核。
8. **引用是一等数据**：凡是"A 用到了 B"都写入引用图；生命周期、权限撤销、缓存失效都基于引用图，不扫描文本。
9. **纵深防御**：入口网关（限流/配额/安全头）+ 应用授权 + 数据库行级安全 + 密钥分层，任一层失守不直接导致越权。
10. **规范可机读、可校验**：任务、依赖、状态、证据、需求追踪是数据；Markdown 由数据生成；CI 校验一致性。
11. **纵向切片交付**：每个可交付能力 = 内核操作 + API + UI 入口 + 浏览器/真实媒体证据；没有 UI 入口的后端能力不计入产品完成度。

---

<a id="s5"></a>
## 五、V5 总体架构

### 5.1 逻辑分层

```text
┌──────────────────────────────────────────────────────────────────────┐
│ 客户端：Web Studio / Ops Console / Desktop / Mobile / 外部 API 调用方   │
│   ├─ Interaction Layer（点线面、时间带、语音采集、AttentionRecorder）   │
│   ├─ Edit Kernel（同一份代码：本地乐观预览 / ghost / 冲突提示）          │
│   └─ PlaybackEngine（消费 RenderPlan IR）                              │
└───────────────┬──────────────────────────────┬───────────────────────┘
                │ HTTPS（命令/查询）            │ WebSocket / WebRTC（实时）
┌───────────────▼──────────────┐  ┌────────────▼───────────────────────┐
│ Edge Gateway                  │  │ Realtime Gateway                    │
│ 认证·限流·配额·CORS·安全头·幂等│  │ 会话凭证校验·事件信封·水位·背压      │
└───────────────┬──────────────┘  └────────────┬───────────────────────┘
                │                               │
┌───────────────▼───────────────────────────────▼───────────────────────┐
│ Application Services（apps/api，无编辑规则）                           │
│  Command Handlers ─► Edit Kernel ─► Document Store（快照+操作日志）     │
│  Query Handlers  ─► Read Projections（片段/轨道/引用图/索引/运营读模型） │
│  Session & Intent Service ─► Agent Runtime ─► Capability Registry      │
│  Workflow Engine（Saga）─► Provider Gateway ─► 外部 Provider            │
│  AdminAction（运营写操作 = 工作流）                                     │
└───────────────┬───────────────────────────────────────────────────────┘
                │ Outbox / Workflow steps
┌───────────────▼───────────────────────────────────────────────────────┐
│ Workers（按资源类别分池）                                              │
│  io-pool：上传后处理、转存   cpu-pool：探测/代理/索引/FFmpeg 合成      │
│  gpu-pool：视觉分析/图形渲染  untrusted-pool：生成代码/文档解析（沙箱） │
│  provider-pool：经 Provider Gateway 的异步生成/ASR/LLM                 │
└───────────────┬───────────────────────────────────────────────────────┘
                │
   PostgreSQL（文档存储、投影、工作流、账本、审计；RLS）  对象存储（原件/派生/缓存）  Redis（可选：队列/限流计数）
```

### 5.2 包结构（在现有 monorepo 内演进，不新建微服务）

| 包 | 职责 | 依赖约束（arch-check 强制） |
|---|---|---|
| `packages/contracts` | Zod schema、错误码、能力定义的**数据形状** | 无运行时依赖（仅 zod） |
| `packages/time`（新，自 `contracts/common/media-time.ts` 提升） | 唯一有理时间库 | 无依赖 |
| `packages/kernel`（新） | ProjectDocument 模型、`validate/apply/invert/impact/rebase`、引用提取、RenderPlan 编译 | 只依赖 `contracts`、`time`；**禁止** `db`、`node:*`、`fetch`、`process` |
| `packages/capabilities`（新） | 能力定义（操作/工具/命令）的唯一源 + 生成器 | `contracts`、`kernel` |
| `packages/domain` | 应用服务：命令处理、授权、事务、投影更新、工作流步骤 | `kernel`、`db`、`contracts`；**禁止**读 `process.env` |
| `packages/workflow`（新，或在 domain 内的子模块） | Saga 引擎：步骤、重试、补偿、超时、人工门 | `db` |
| `packages/provider-gateway`（新） | 路由、预算预留、计量、限流、Mock 标识、审计 | `contracts`、`workflow` |
| `packages/providers/*` | 具体 Provider 适配器（实现 SPI） | 只依赖 `contracts` |
| `packages/playback-core`（新，自 Web 提取） | 解码/时钟/合成/缓存，消费 RenderPlan IR | `kernel`（只读 IR）、`time`；禁止服务端依赖 |
| `packages/sdk` | **由 OpenAPI + 能力定义生成**的客户端 | `contracts` |
| `packages/db` | 表定义、迁移、RLS 策略 | — |
| `apps/api` | Edge 中间件 + 路由装配 + 配置注入 | 所有业务经 `domain` |
| `apps/realtime`（新） | 实时网关进程 | `contracts`、`domain`（只调会话/意图服务） |
| `apps/worker`、`apps/render-worker`、`apps/motion-worker` | 资源池 Worker | `domain`、`workflow`、`provider-gateway` |

拆包判据沿用 v0.4 §17.6："只有明确依赖边界、独立资源配额或多端复用收益才物理拆包"。`kernel`、`time`、`playback-core` 满足"多端复用"；`provider-gateway`、`workflow` 满足"依赖边界"；`apps/realtime` 满足"资源/连接模型不同"。

### 5.3 进程与部署视图

| 进程 | 伸缩维度 | 关键约束 |
|---|---|---|
| `web`（Next.js） | 无状态 | 只做 UI/SSR；严格 CSP；不持有任何 Provider Key |
| `api`（Fastify） | 无状态，按请求 | 不执行耗时 > 2 s 的同步工作；超时即转工作流 |
| `realtime` | 按长连接数 | 粘性会话；只转发事件和调用意图服务；不直连 Provider Key（经 Gateway 签发短期凭证） |
| `worker-*` | 按资源池 | 每池独立并发、内存、超时上限；`untrusted-pool` 无出网、只读根文件系统、`sandboxEnv()` |
| PostgreSQL | 主从 | RLS 开启；文档日志表按项目分区（规模化后） |
| 对象存储 | — | 原件只读；派生按内容寻址 |

---

<a id="s6"></a>
## 六、编辑内核与 ProjectDocument 存储模型（解决 A1、A2、A8）

### 6.1 内核接口

```ts
// packages/kernel —— 纯函数，无 I/O，可在 Node / 浏览器 / Worker 中运行
interface EditKernel {
  validate(doc: ProjectDocument, ops: EditOperation[], ctx: KernelContext): ValidationReport;
  apply(doc: ProjectDocument, ops: EditOperation[], ctx: KernelContext): ApplyResult;
  //   ApplyResult = { doc, events: KernelEvent[], inverse: EditOperation[], impact: ImpactSet }
  impact(doc: ProjectDocument, ops: EditOperation[]): ImpactSet;          // 读写集 + 对象锁维度 + 间接影响
  rebase(base: ProjectDocument, head: OpLog, ops: EditOperation[]): RebaseResult; // 无竞争才成功
  references(doc: ProjectDocument): ReferenceEdge[];                      // 资产/对象/身份引用
  digest(doc: ProjectDocument, scope: DigestScope): ContentDigest;       // 确认内容保护三轴指纹
  compileRenderPlan(doc: ProjectDocument, profile: RenderProfile): RenderPlanIR;
}

interface KernelContext {
  policy: ProductionPolicy;          // FOOTAGE_EDIT 禁生成等硬约束在内核内执行
  locks: LockSet;
  assetFacts: AssetFactsView;        // 源时基、时长、流信息（只读快照，由调用方注入）
  capabilities: CapabilityView;      // 当前后端/能力可用性
}
```

关键性质：

- **确定性**：同一 `(doc, ops, ctx)` 必得同一结果；禁止读取墙钟、随机数（需要 ID 时由调用方注入 ID 生成器）。
- **全有或全无**：`apply` 失败时不产生部分结果，对应 §13.2 "默认整批成功或整批不改变确认作品"。
- **可逆**：每次 `apply` 返回 `inverse`，Undo/Redo 不再需要在补丁中保存"前后内容快照"的特殊格式（取代 `SceneContentSnapshot` 一类结构）。
- **策略内建**：`FOOTAGE_EDIT` 禁生成、`preserveOriginalSpeech`、对象锁、范围锁都在 `validate` 中执行——服务端、客户端得到同一领域错误（满足 §13.5 "错误输入应得到同一领域错误"）。

### 6.2 存储模型：快照 + 操作日志 + 投影

```text
project_documents         (project_id, accepted_revision, schema_version, ...)
project_doc_snapshots     (project_id, revision, document jsonb, digest)      -- 每 N 次或按体积
project_op_log            (project_id, revision, ops jsonb, inverse jsonb,
                           actor, intent_revision_id?, proposal_id?, idempotency_key, created_at)
                           -- 唯一键 (project_id, revision)，写入即乐观并发控制
proj_* 投影表               sequence_clips / sequence_tracks / captions / ... （只读投影，可重建）
reference_edges           (workspace_id, from_kind, from_id, to_kind, to_id, revision_from, revision_to?)
```

**写路径（单事务）**：

```text
加载最新快照 + 尾部日志（或热缓存）→ kernel.validate/apply
→ INSERT project_op_log(revision = base+1)  （唯一键冲突 = 并发冲突 → 409）
→ 更新投影表 + reference_edges + outbox + 决策笔记
→ COMMIT
```

- 并发控制从"条件更新若干行"简化为"一行唯一键"，消除 `FOR UPDATE` 散落。
- 投影表结构可以沿用现有 `sequence_clips` 等表（0086 之前的迁移不浪费），但**只能由投影器写**，领域代码不再直接改它们。
- 版本快照 = 某 revision 的文档；恢复 = 计算 `current → target` 的操作集（内核提供），作为新 revision 写入——补偿语义不变（K5）。

### 6.3 读路径

- 编辑/播放/Agent 上下文读**文档**（快照 + 尾部日志，服务端 LRU 热缓存按 `(projectId, revision)`）。
- 列表/检索/运营/引用查询读**投影**。
- 投影落后于日志时以 `revision` 水位标注（满足 §28.19 "读模型标注时效"）。

### 6.4 旧 Scene 模型的终局（解决 A2）

1. 旧 Scene Graph 只作为**导入格式**：`migrateLegacyProject()` 经内核把旧项目编译成文档首个快照。
2. 设定**旧写入口关闭里程碑**（V5-M2，见 §20）：此后所有写请求经内核；旧 Scene 路由降为只读兼容投影（`SemanticPlan` 视图）。
3. `SemanticPlan`（Scene/论点/章节）成为文档内的语义层，与 `Composition` 通过稳定 ID 关联，由内核统一校验"语义说保留而时间轴删除"一类不一致（§12.1）。

### 6.5 内核带来的连锁收益

| v0.4 需求 | v0.4 当前做法 | V5 做法 |
|---|---|---|
| 试改（N06-01/02） | 真实 DB 事务执行后回滚 | `kernel.apply` 内存执行，零锁、可缓存 |
| rebase（N06-03） | 读 edit_events 还原干预改动再判定 | `kernel.rebase(base, headLog, ops)` |
| A/B 比较（N06-08） | 事务内试改后回滚再对齐 | 两份内存文档 + `digest` 对齐 |
| 确认内容保护（N06-07） | 试改后读表计算指纹 | `kernel.digest`，同一函数用于捕获与校验 |
| 本地 ghost 预览（增量设计 §6.2） | 无共同基础 | 浏览器直接跑内核 |
| 资产引用保护 | jsonb 包含 + 快照文本 LIKE | `reference_edges` 精确查询 |
| 属性测试 | 需要数据库 | 纯函数，毫秒级跑上万例 |
| 多端/离线（N14） | 只能复用 HTTP | 同一内核 + 操作日志同步（§17） |

---

<a id="s7"></a>
## 七、时间模型收口（解决 A3）

1. **`packages/time` 唯一出口**，提供：
   - 精确运算：`add / sub / compare / rescale(timebase, rounding)`（BigInt）；
   - 显式舍入：`toFrameIndex(time, frameRate, rounding)`、`toSampleIndex(time, sampleRate, rounding)`；
   - **显示**：`formatTimecode(time, frameRate, dropFrame)`、`toApproxSeconds(time): number`（只用于 UI 和日志，返回值类型标注为 `DisplaySeconds` 品牌类型，不能传回内核）。
2. **删除** `mediaTimeToLegacyMilliseconds` 在权威路径中的全部用法；只在 `legacy-import` 适配器中保留"整毫秒 → MediaTime"单向转换。
3. **契约层禁止新增 `*Ms` 权威字段**：arch-check/lint 规则检测 `contracts` 中新出现的 `z.number()` 命名以 `Ms` 结尾且不在 `display` 命名空间内的字段。
4. **属性测试矩阵**：时基 ∈ {1/1000, 1001/30000, 1001/24000, 1001/60000, 1/48000, 1/44100, 1/15360, 1/90000} × 内核全部操作 × 往返（序列化/反序列化/rebase/invert）。
5. **外部 Provider 时间输入**（如 ASR 返回秒数）在适配器内转换为 `MediaTime`（以源流时基或 1/48000），而不是先四舍五入成毫秒。

---

<a id="s8"></a>
## 八、交互、意图与实时通道（解决 A4）

### 8.1 会话对象归一

| V5 对象 | 合并/取代 | 生命周期 | 事实源 |
|---|---|---|---|
| `CollabSession` | InteractionSession、VoiceSession、ConversationSession | 用户打开共看片室 → 显式结束/超时 | `collab_sessions` 表 |
| `Utterance` | 语音/文字输入单元（含转写修订） | 会话内 | 会话事件流 |
| `IntentRevision` | IntentSession/IntentRevision（保留增量设计 §8.3 字段） | DRAFT → SEALED/SUPERSEDED/CANCELLED | `intent_revisions` |
| `AttentionSnapshot` | 保留；内含 `SelectionAnchor` | 发话时刻捕获，不可变 | `attention_snapshots` |
| `SelectionAnchor` | 保留（K6） | 可 remap 的追加式修订 | `selection_anchors` |
| `Proposal` | 保留（见 §9） | 见 §9 | 文档存储的分支 |
| `ReviewSession` | 保留 | 审阅 → 批准/失效 | `review_sessions` |

归属关系（唯一方向）：

```text
CollabSession 1─* Utterance 1─* IntentRevision *─1 AttentionSnapshot 1─1 SelectionAnchor(revision)
IntentRevision 1─* Proposal（同谱系 generation 递增，旧代自动 SUPERSEDED）
Proposal *─1 acceptedRevision（base）    ReviewSession *─1 acceptedRevision / FrozenManifest
```

- 一个 `CollabSession` 只有一个事件流（`EventEnvelope`，沿用增量设计 §8.4 字段）；文字与语音进入同一流（满足增量设计 §6.1）。
- `IntentRevision` 是 Agent 的唯一输入单元；`Proposal` 是唯一输出单元。

### 8.2 Realtime Gateway（新进程）

- **职责**：WebSocket（或 WebRTC 数据通道/sideband）连接管理、短期会话凭证校验（`timingSafeEqual` + 过期 + generation + 撤销）、事件信封排序与确认水位、背压、断线续传（按 `lastAckedSeq` 补发）。
- **不做**：编辑规则、预算、Provider 长期 Key。所有业务动作转为对 `Session & Intent Service` 的调用。
- **语音媒体**：浏览器 ↔ 实时语音 Provider 走 WebRTC（Provider 短期凭证由 Provider Gateway 签发）；工具调用经 sideband 回到 ANCS（增量设计 §6.3 的路线，落点明确为本网关）。
- **SSE 降级**：不支持长连接的客户端用 SSE + HTTP POST，同一信封协议。

### 8.3 三通道到组件的映射

| 通道（K7） | 组件 | 延迟目标（待测） |
|---|---|---|
| 本地反馈 | Interaction Layer + 本地 Kernel（ghost 预览） | 1 帧内 |
| 实时会话 | Realtime Gateway + Session & Intent Service | 由 N05 测量定稿 |
| 正式制作 | Command Handler（内核）/ Workflow Engine | 同步编辑 < 2 s，其余异步 |

---

<a id="s9"></a>
## 九、提案（Proposal）在内核上的重定义

```text
Proposal = { baseRevision, ops[], intentRevisionId, selectionFingerprint,
             operationsHash, assetVersionRefs, generation, status, trialCacheKey }
```

- **试改**：`kernel.apply(doc@base, ops)` → 内存结果；可播放预览由 `compileRenderPlan` 得到 IR，交给 PlaybackEngine（简单变更）或工作流生成局部预渲染（复杂效果）。
- **试改缓存键**：`sha256(baseRevision, operationsHash, selectionFingerprint, intentRevisionId, assetVersionSignature, kernelVersion)`（沿用 N06-04 设计，增加 `kernelVersion`）。
- **采用**：服务端重新 `validate`（含预算、权限、锁、确认内容保护 `digest` 比对）→ 写入 `project_op_log` 一行（revision = head+1）。若 `head ≠ base`，先 `rebase`，有竞争则 409（保持 N06-03 语义：绝不强覆盖）。
- **部分采用**：依赖闭包由内核基于操作间引用计算（`createdClipId` 引用、`avGroupId` 配对），而不是领域代码手写。
- **晚到结果隔离**：工作流产物写入 `proposal_artifacts` 隔离台账（沿用 N06-06），只有"OPEN 且为当前代际"才绑定。
- **状态机**：沿用 §10.2，增加区分 `PLAN_READY`（只有操作计划）与 `READY_FOR_REVIEW`（有可播放结果）的硬约束：后者必须存在 RenderPlan IR 或预渲染资产引用。

---

<a id="s10"></a>
## 十、统一能力注册表与 Agent 运行时（解决 A5）

### 10.1 一份能力定义

```ts
// packages/capabilities —— 唯一手写源
defineCapability({
  id: 'clip.trim', version: 2,
  input: trimClipInputSchema, output: trimClipOutputSchema,
  kernel: { op: 'trim_clip' },                         // 内核操作（读写集/前置条件/逆操作在内核实现）
  sideEffect: 'PROPOSE_EDIT',                          // READ | PROPOSE_EDIT | REQUEST_GENERATION | COMMIT | PUBLISH
  permission: 'project:write',
  allowedModes: ['FOOTAGE_EDIT', 'GENERATIVE', 'HYBRID'],
  cost: { class: 'NONE' },                             // 或 { class: 'PROVIDER', estimator: ... }
  aliases: ['trim', 'set_clip_in_out'],                // 取代 v2 别名编译
  agentTool: { name: 'trim_clip', description: '…', exposeWhen: 'target.kind == CLIP' },
  uiCommand: { label: '修剪', shortcut: 'T', inspectorSection: 'clip.timing' },
  renderSupport: { baseline: 'NATIVE', webgpu: 'NATIVE', ffmpeg: 'NATIVE', remotion: 'NATIVE' },
  tests: { property: true, golden: ['trim-ntsc', 'trim-48k'] },
});
```

**生成物**（CI 检查生成物与源一致）：

| 生成物 | 用途 |
|---|---|
| 内核操作分发表 | 内核根据 `kernel.op` 分发 |
| Agent 工具清单（JSON Schema） | 按账号/素材/预算/策略**动态投影可用性**（§9.5） |
| GUI 命令表/快捷键/Inspector 段落 | 命令面板、Smart Timeline（N04-11） |
| OpenAPI 片段 + SDK 方法 | 外部 API 与客户端 |
| 能力覆盖账本 | 取代手工维护的 `v04-professional-capability-coverage.md` 中"原生/别名/PLANNED"统计 |
| 渲染后端支持矩阵 | §15.11 一致性测试的输入 |

规则：**类型声明、别名或空 handler 不计为原生能力**（§13.5）——生成器检查每个 `NATIVE` 声明都有对应内核实现与至少一条属性测试和一条金样测试，否则构建失败。

### 10.2 Agent 运行时

```text
IntentRevision(SEALED)
  → Context Compiler（服务端：Brief、模式、锚点、邻接片段、锁摘要、已确认决定、MediaIndex 证据，带预算）
  → Planner（LLM，经 Provider Gateway；只能输出能力调用）
  → Capability Router（权限/模式/预算/可用性过滤；越界逐条进 outOfScope）
  → Kernel.validate（候选）→ Proposal
  → Preview（IR 或工作流预渲染）→ Critic（只读可播放结果证据）
  → 回到用户 / 迭代（轮次、token、费用、无改善上限）
```

- Agent 永远只有 `PROPOSE_EDIT` 及以下权限；`COMMIT` 只接受**服务端验证过的用户确认事件**（来自 Session 事件流的显式动作或经确认的处置解析结果），`PUBLISH` 需独立授权（K10）。
- 五工具起步（§9.6）在 V5 中就是五条 `defineCapability` 加上 `agentTool` 字段。
- 意图处置解析（`proposal-disposition`）保留为确定性前置层；其评测集纳入 §18 的 AI 质量回归。

---

<a id="s11"></a>
## 十一、工作流引擎、任务与费用账本（解决 A6、A7）

### 11.1 工作流引擎（库，不引入外部平台）

基于现有 Postgres + Outbox + 租约机制，抽象出：

```text
workflow_runs   (id, type, version, workspace_id, subject_ref, status, input, context, created_by, ...)
workflow_steps  (run_id, step_key, attempt, status, lease_until, result, error_class, compensation_status)
```

- 步骤声明：`execute`、`compensate`、`retryPolicy`（错误分类：可重试/不可重试/需人工）、`timeout`、`idempotencyKey`、`humanGate`（等待授权/审批）。
- 任何调用外部系统或付费 Provider 的代码**只能**作为工作流步骤存在（lint 规则：`provider-gateway` 的调用方只能是 `workflow` 步骤）。
- 现有 `jobs` 表作为步骤执行载体保留；`render-execution`、`media-transcripts`、`cms` 写回、`custom-motion` 逐步迁移为工作流类型。

### 11.2 典型工作流（取代分散的手写状态机）

| 工作流 | 步骤（简） | 补偿 |
|---|---|---|
| `RegionRegeneration`（§14.7） | 报价 → **人工门：授权** → 预算预留 → 提交 Provider → 轮询/回调 → 资产落库+完整性检查 → 质量/保护区检查 → 写入提案 `replace_region` | 释放预留；Provider 取消（若支持）；资产标记孤儿 |
| `FinalRender`（§15.1） | 冻结校验 → 生成 Manifest → RenderPlan 分区 → 各后端执行 → 合成编码 → 技术 QA → 交付 | 标记失败段可重跑，不重做已成功段 |
| `MediaIngest`（N02-11） | 探测 → 代理 → 缩略/波形 → 转写 → 视觉/音频分析（DAG，检查点） | 局部失效重算 |
| `AdminAction`（§28.5） | 预检(dry-run) → **人工门：审批** → 执行（逐项） → 结果汇总 | 逐项回滚（若定义） |
| `Publish`（§19.4） | 授权校验 → 平台提交（幂等键=平台+账号+冻结版本+产物） → 状态确认 | 无（外部不可撤销时只记录） |

### 11.3 Provider Gateway

所有外部调用的唯一出口：

1. **路由**：按能力目录（§14.2）+ 硬约束（隐私、模式、身份、地区）+ 质量/延迟/成本选择 Provider；无合法路径则返回能力缺口，不降级违规。
2. **预算**：调用前对 `CostQuote` 做预留（estimate → reserve），调用后对账（reconcile → release/refund），未知用量标 `PENDING` 而非 0。
3. **计量与限流**：按 workspace、Provider 账户、模型分别限流；记录 token/秒数/张数。
4. **Mock 显式化**：每个适配器声明 `kind: REAL | MOCK | SCRIPTED`；生产环境（`NODE_ENV=production`）加载 `MOCK` 必须有 `ANCS_ALLOW_MOCK_PROVIDERS=1`，且所有产物带 `providerKind` 字段，UI 显示标识（解决代码审查 R-5）。
5. **重试纪律**：付费调用重试前先查询已提交任务（§18.2）；重试次数由工作流策略控制，Gateway 本身不自动重试付费请求。
6. **凭据**：平台 Key / BYOK 经凭据库解密，只在 Gateway 进程内存中使用；对客户端只签发 Provider 支持的短期凭证。

---

<a id="s12"></a>
## 十二、媒体管线与 Worker 资源池

| 池 | 任务 | 隔离 | 并发/资源 |
|---|---|---|---|
| `io` | 上传完成处理、分片合并、转存 | 普通 | 高并发、低 CPU |
| `cpu` | ffprobe/代理转码/缩略/波形/FFmpeg 合成 | 容器内 `-protocol_whitelist file,pipe`、像素/时长上限、cgroup | 按核数 |
| `gpu` | 视觉分析、图形层渲染（Remotion/WebGPU 无头） | 独立节点 | 按显存 |
| `untrusted` | 生成代码构建/验证、文档解析、未知格式解码 | 无出网、只读根、`sandboxEnv()`、seccomp、时限 | 低并发 |
| `provider` | 经 Gateway 的异步生成/ASR/LLM | 普通 | 受 Gateway 限流 |

- 交互优先级（试改预渲染）> 正式合成 > 背景索引；可抢占未开始的低优先级任务（§18.3）。
- 每个池独立部署单元，`infra/` 补齐各池 Dockerfile 与资源声明（当前只有 dev compose）。
- MediaIndex 的分析产物按 `(sourceAssetVersionId, analyzerVersion, params)` 内容寻址，写入引用图，便于删除权限同步（N02-14）。

---

<a id="s13"></a>
## 十三、播放、RenderPlan IR 与一致性（K8 的落地）

1. **RenderPlan 是内核的编译产物**（`kernel.compileRenderPlan`），是 v0.4 §15.10 "唯一可校验投影"的具体形态：带 `irVersion`、`graphHash`、逐层时间映射（全部 `MediaTime`）、效果实例及其后端支持声明。
2. **同一 IR 三个消费者**：浏览器 PlaybackEngine（baseline/WebCodecs/WebGPU）、服务端局部预渲染、终渲染分区器（FFmpeg/Remotion/已批准资产）。
3. **能力声明来自能力注册表**（§10.1 `renderSupport`），不支持即显式"局部预渲染 / 替代提案 / 阻止导出"，禁止静默省略（§15.11）。
4. **一致性测试套件**（conformance）：对每个声明 `NATIVE` 的效果 × 后端，用金样工程在 baseline 播放与终渲染两侧解码比对（时间、像素容差、音频偏移），作为 G0/G2/G3 门的自动化部分。
5. `playback-core` 作为独立包从 Web 提取，禁止依赖 React；Web、Desktop、Mobile WebView 共用。

---

<a id="s14"></a>
## 十四、数据、引用图与生命周期（解决 A8）

### 14.1 引用图

`reference_edges` 由投影器在每次 `op_log` 写入时根据 `kernel.references(doc)` 的增量维护，覆盖：

- 文档 → 源资产版本（片段、音频区、字幕语音锚点）
- 文档 → 派生资产（生成、修复、预渲染）
- 冻结 Manifest → 全部资产/组件/字体/策略版本
- 提案/试改缓存 → 资产（带 `bound` 标志）
- 身份（声音/数字人）→ 授权记录
- MediaIndex 产物 → 源资产版本

历史快照的引用通过 `revision_from / revision_to` 区间表达，"仍可恢复的历史"也受保护（沿用 v0.2 规范 §23.2/§40 的语义）。

### 14.2 生命周期规则（取代扫描式清理）

```text
可删除(asset) ⇔ 无活跃引用边
             ∧ 不在保留例外中
             ∧ 保留类策略到期（按 retention_class 下推到 SQL）
             ∧ 无未完成工作流引用
```

- 清理是工作流：逐条处理、单条失败不影响整轮、FK 冲突计为 `skipped`。
- 隐私删除请求是独立工作流（原件/派生/向量/Provider/备份分项记录，§28.12）。

### 14.3 多租户数据隔离

- 所有租户表带 `workspace_id`，并开启 **Postgres 行级安全（RLS）**：应用连接以 `SET LOCAL app.workspace_id` 设定上下文；平台运营读模型使用独立数据库角色和显式授权视图（§19.6）。
- 应用层授权（`requireWorkspace`）保留为第一道防线；RLS 是纵深防御，防止任何一处漏写 `workspaceId` 条件导致越权。

---

<a id="s15"></a>
## 十五、安全架构

| 层 | 控制 | 落点 |
|---|---|---|
| 边缘 | 限流（IP/用户/workspace/端点类别）、请求体与上传大小、CORS 白名单、`Origin` 校验（CSRF）、安全头（CSP、frame-ancestors、HSTS） | `apps/api` Edge 中间件、`apps/web` `headers()` |
| 会话 | Better Auth 会话；原生 Bearer；实时会话短期凭证（Realtime Gateway 校验） | `@ancs/auth`、`apps/realtime` |
| 应用授权 | `requireWorkspace` + 对象级归属校验 + 能力权限（来自能力注册表） | `domain` |
| 数据 | RLS；审计追加式表；签名 URL 短时效 | `db` |
| 密钥 | 分层：会话密钥、存储签名密钥、凭据信封密钥（KMS/环境）、Webhook 密钥、实时会话密钥**各自独立**；生产全部显式配置，缺失即启动失败；派生逻辑只存在一个函数 | `contracts/env` + 单一配置注入 |
| 外部内容 | 不可信输入分级（§19.2）；Agent 只能产生 `PROPOSE_EDIT`；提示注入对抗集 | Agent Runtime |
| 执行隔离 | `untrusted` 池；FFmpeg 协议白名单；生成代码只在沙箱构建 | Worker |
| 供应链 | 锁文件、依赖审查、全历史密钥扫描（gitleaks）进 CI | CI |

**配置原则**：所有进程（api/realtime/worker/cli）用同一个 `loadConfig(processKind)`，返回已校验的类型化配置并注入依赖；业务包禁止读取 `process.env`（arch-check 规则）。

---

<a id="s16"></a>
## 十六、运营后台架构

1. **读**：运营读模型 = 从业务表/工作流/账本派生的只读投影（带水位），使用独立数据库角色；默认脱敏。
2. **写**：所有运营写操作 = `AdminAction` 工作流（§11.2），不另开修改路径；CI 结构检查"运营路由中的写操作必须编译为 AdminAction"（§28.19 已有此要求，V5 落实为自动检查）。
3. **O0 收窄**（建议，需所有者确认）：内部试用所需的最小集合为 **运营认证与角色、AdminAction 框架、审计、任务/工作流诊断与恢复、Provider 健康与预算止损、资产保护视图**。其余 O0 列项（支持访问、用户中心细节等）在首个外部用户进入前完成即可。
4. 运营台与 Studio 共用 `packages/capabilities` 的权限定义和设计系统组件，不复制领域逻辑。

---

<a id="s17"></a>
## 十七、多端、SDK 与同步协议

1. **SDK 生成化**：OpenAPI（由 Zod 生成）+ 能力定义 → 生成 SDK；手写部分仅限认证、重试、上传等横切逻辑。CI 检查"每个路由都有 SDK 方法、每个响应 schema 都来自 contracts"。
2. **同步协议**：客户端持有 `(projectId, revision)` 的文档副本 + 本地内核；服务端推送新增 `op_log` 行（经 Realtime Gateway），客户端顺序应用；本地未提交的乐观变更在收到服务器结果后 `rebase` 或丢弃。离线编辑（N14-03 桌面）在此协议上自然扩展。
3. **端能力声明**：PlaybackEngine 能力、语音能力、输入方式由客户端上报，服务端据此投影可用能力（§9.5 "availability 动态投影"）。

---

<a id="s18"></a>
## 十八、质量与验证架构

| 层 | 内容 | 运行时机 |
|---|---|---|
| 内核属性测试 | 随机文档 × 随机操作：`apply∘invert = id`、rebase 交换律（无竞争时）、时基矩阵、策略约束不被绕过 | 每次提交 |
| 内核金样 | 固定工程 + 操作序列 → 期望文档摘要 | 每次提交 |
| 应用集成 | 真实 Postgres：并发采用、幂等、RLS 越权负例、工作流补偿 | 每次提交（CI 服务容器） |
| 渲染一致性 | §13 conformance 套件，真实 FFmpeg/Chromium | 每次提交（精简集）/ 每日（全集） |
| 浏览器 E2E | 收编现有 Playwright 脚本为 v0.4/V5 任务编号的 `test:e2e`：导入 → 选区 → 试改 → 采用 → 撤销 → 导出 | 每次提交（主链）/ 每日 |
| AI 质量评测 | 意图处置准确率/误采纳率、指代解析正确率、规划越界率、Critic 一致性；每次模型/提示词变更回归 | 变更时 + 每周 |
| 真实 Provider 冒烟 | 预算上限内的真实调用，产出 `VERIFIED_REAL` 证据 | 显式触发 |

**证据级别成为数据**：任务状态拆为 `code`、`deterministic`、`browser`、`realProvider`、`realMedia` 五个维度（§22.1 已列出这些维度，V5 将其落为 `task_index.json` 字段），`VERIFIED` 由规则从维度计算，而不是手写。

---

<a id="s19"></a>
## 十九、规范与交付治理（解决 A9、A10）

### 19.1 文档拆分

| 新文档 | 内容 | 体量目标 |
|---|---|---|
| `docs/V05/product-requirements.md` | v0.4 §1、§3—§11、§14、§16 的产品需求（原文继承） | 只增不删 |
| `docs/V05/ANCS_v0.5_Architecture.md`（本文） | 架构视图、原则、模块边界、关键协议 | ≤ 60 KB |
| `docs/V05/contracts/*.md` | 内核、时间、提案、会话、能力、工作流、RenderPlan 各一篇协议说明 | 每篇 ≤ 15 KB |
| `docs/V05/tasks.json` | **唯一任务事实源**：任务、依赖、需求 ID、门、证据维度、状态 | 机读 |
| 生成物 | 任务总账 Markdown、追踪矩阵、验收账本统计、阶段视图 | 由脚本生成，禁止手改 |
| `docs/decisions/` | ADR（§21） | — |

### 19.2 CI 校验（`scripts/spec-check.mjs`，纳入 `pnpm verify`）

1. `VERIFIED` 任务的依赖必须全部 `VERIFIED`（或有 ADR 批准的显式降级）。
2. 每个 `VERIFIED` 任务存在独立的 `docs/verification/<id>.md` 与 `docs/handoffs/<id>.md`。
3. 账本统计由 `tasks.json` 计算，Markdown 中的数字与之不一致即失败。
4. 能力注册表生成物与源一致；`NATIVE` 声明有对应测试。
5. 每个面向用户的 `VERIFIED` 任务在 `ui-coverage.md` 中有入口或"UI 不适用"说明。

### 19.3 交付节奏

- **纵向切片优先**：在 G0 通过前，新任务只从 G0 关键路径（及其安全/运营最小依赖）中选取；横切任务（N15/N16/N11/N12）只做被关键路径直接依赖的部分。
- **WIP 限制**：同时处于 `IN_PROGRESS` 的任务 ≤ 3；当前账本中有约 10 项 `IN_PROGRESS` 叙述，应先收口或回退为 `TODO`。
- **长期分支必须跑 CI**：`codex/v04-foundation` 一类分支加 push 触发，或改为 PR 合并。

---

<a id="s20"></a>
## 二十、从 v0.4 迁移到 V5 的路线

原则：**不重启、不推倒**；每个阶段都可独立发布并回滚；v0.4 的 N 任务编号与已有 VERIFIED 证据全部保留，V5 工作以"架构任务（V5-xx）"形式挂到现有 N 任务的依赖上。

| 阶段 | 目标 | 主要工作 | 退出标准 | 关联 N 任务 |
|---|---|---|---|---|
| **M0 止血**（约 1 周） | 修复已确认缺陷，建立治理脚本 | 代码审查第一批修复（时间换算、清理任务、Webhook 恒定时间比较、幂等作用域、试改错误分类）；`spec-check.mjs`；账本修正 | 全部回归测试通过；`spec-check` 进 verify 且为绿 | N01-01、N06-01/02、N13-05、N13-12 |
| **M1 时间库 + 内核骨架** | `packages/time`、`packages/kernel` 建立；N03 时间线原语迁入内核 | 时间库提升；把 `insert/delete/split/trim/move/slip/slide/roll/ripple/transform/caption` 的规则从 `edits.ts` 抽到内核纯函数；领域层改为"加载 → 内核 → 持久化" | 内核属性测试 ≥ 10k 例/操作通过；现有集成测试全绿；`edits.ts` 中时间线原语规则代码清零 | N01-06、N01-11、N03-01…07 |
| **M2 操作日志权威 + 旧写入口关闭** | 文档存储为权威，关系表为投影 | `project_op_log`/快照/投影器；`reference_edges`；旧 Scene 写入口降为只读；试改/rebase/比较/保护改用内核 | 并发采用与幂等集成测试通过；投影可从日志完整重建；旧写入口调用为 0 | N01-05、N01-08、N06-03/04/07/08 |
| **M3 能力注册表 + 工作流 + Gateway** | 一份能力定义；外部调用全经工作流与 Gateway | `defineCapability` + 生成器；Agent 工具清单生成；工作流引擎；Provider Gateway（含 Deepgram 接入、Mock 显式化） | 能力覆盖账本由生成器产出；生产禁 Mock 开关生效；首个 `VERIFIED_REAL`（ASR）进入正式路径 | N07-09、N08-01、N13-03、N13-10 |
| **M4 G0 闭合** | 小金样完成 §21.2 垂直闭环 | RenderPlan IR 由内核编译；baseline 播放 + 终渲染一致性套件；收编 E2E；Edge 安全层；O0 收窄版 | G0 + O0（收窄）门通过 | N03-08、N03-10、N03-16、N09-09、N15-37 |
| **M5 实时与 Agent（G1）** | Realtime Gateway、CollabSession、五工具 Agent | 会话对象归一；实时凭证校验；Agent 运行时；AI 质量评测入 CI | G1 门通过（真实语音证据） | N05-*、N07-04/09/10/11 |

M1 与 M3 中的能力注册表可以部分并行；M2 依赖 M1；M4 依赖 M2（RenderPlan 来自内核）。

---

<a id="s21"></a>
## 二十一、V5 架构决策记录（ADR）清单

确认本方案后，按以下清单在 `docs/decisions/` 落地 ADR（编号接续现有 0010）：

| ADR | 决策 | 取代/修订 |
|---|---|---|
| 0011 | 编辑内核为纯函数包 `packages/kernel`，禁止 I/O | 修订 v0.4 §13.2 的实现方式；补充 §17.6 |
| 0012 | 操作日志 + 快照为作品权威，关系表为投影 | 修订 v0.4 §17.3；落实 §12.1、§12.5 |
| 0013 | 旧 Scene 写入口关闭里程碑（M2） | 落实 §12.5 |
| 0014 | `packages/time` 唯一时间库；权威路径禁毫秒 | 落实 §12.3、§15.8 |
| 0015 | 会话对象归一为 CollabSession/Utterance/IntentRevision | 合并 §7.4、§8、§17.2、增量设计 §8.3 |
| 0016 | Realtime Gateway 独立进程 | 补充 §17.6、增量设计 §6.3 |
| 0017 | 能力注册表单一源 + 生成器 | 合并 §9.5、§13.1、§13.5、§4.5 |
| 0018 | 工作流引擎（基于 Postgres），外部副作用只能在工作流步骤中 | 补充 §18.3、§14.7、§28.5 |
| 0019 | Provider Gateway 与生产禁 Mock | 补充 §14.2、§18.1、§22 |
| 0020 | 引用图与基于引用的生命周期 | 落实 §18.4 |
| 0021 | Postgres RLS 纵深防御 | 补充 §19.1 |
| 0022 | 统一配置加载与密钥分层 | 补充决策 0010 |
| 0023 | 规范拆分与 `tasks.json` 唯一事实源、`spec-check` | 修订 §22.3—22.7 |
| 0024 | G0 前 WIP 与横切任务准入规则 | 修订 §21.3、§21.5—21.6 |

---

<a id="s22"></a>
## 二十二、风险与待决策

| 项 | 风险/取舍 | 建议默认 | 需谁决定 |
|---|---|---|---|
| 操作日志权威化（M2）工作量 | 涉及 0086 前大量表的写路径改造 | 投影表结构保持不变，只改写入方；按操作族分批迁移 | 工程负责人 |
| 内核在浏览器运行的包体积 | 内核 + schema 可能较大 | 按操作族分块加载；浏览器只需本地反馈所需子集 | 工程 |
| RLS 对性能与运维的影响 | 每次连接需设置上下文；运营跨租户读需独立角色 | 先在新表启用，逐步覆盖旧表 | 工程 + 运维 |
| Realtime Gateway 选型 | WebSocket 自建 vs 托管 | 先自建于现有 Node 栈，接口按信封协议设计便于替换 | 工程 |
| 工作流引擎自建 vs 引入外部（Temporal 等） | 外部平台功能强但运维成本高 | 基于现有 Postgres 自建轻量 Saga；规模化后再评估 | 工程负责人 |
| O0 收窄 | 与 v0.4 §28.20 的 O0 列表不同 | 见 §16.3 | **项目所有者** |
| G0 前横切任务冻结 | 运营/设计/专业能力推进放缓 | 只做关键路径依赖部分 | **项目所有者** |
| 文档拆分 | 历史链接失效 | 保留 v0.4 原文件为历史，新文件互链；生成物注明来源 | 项目所有者 |
| 供应商与预算 | `VERIFIED_REAL` 需要真实凭据和预算 | 每类能力 1 主 1 备 + 月度上限（同决策 0010） | **项目所有者** |

---

### 附：v0.4 → V5 对照速查

| 主题 | v0.4 | V5 |
|---|---|---|
| 作品权威 | 多张关系表 + 读时拼装 + 按项目切换旧/新权威 | 快照 + 操作日志；关系表为投影；旧写入口关闭 |
| 编辑规则所在 | `domain/edits.ts`（与 DB 耦合） | `packages/kernel`（纯函数，多端共用） |
| 试改 | DB 事务执行后回滚 | 内存 `kernel.apply` |
| 时间 | 有理时基 + 多处毫秒换算 | 唯一时间库，毫秒只用于显示 |
| 会话 | 6+ 种会话/上下文对象 | CollabSession / Utterance / IntentRevision / AttentionSnapshot |
| 实时 | 未定义落点 | Realtime Gateway |
| 能力定义 | 操作注册表 + 别名编译 + Agent 工具表 + 命令表 | 一份 `defineCapability`，其余生成 |
| 长流程 | 各模块手写状态机 | 工作流引擎（Saga） |
| 外部调用 | 分散装配，Mock 靠日志提示 | Provider Gateway，Mock 显式化，生产需显式允许 |
| 引用与清理 | 扫描/文本匹配 | 引用图 + 规则化生命周期 |
| 租户隔离 | 应用层 | 应用层 + RLS |
| SDK | 手写 3k 行 | 生成 |
| 规范 | 452 KB 单体 + 多份增量 + 手写账本 | 分篇文档 + `tasks.json` 唯一源 + CI 校验 |
| 交付节奏 | 多工作流并行铺开 | G0 关键路径优先，WIP ≤ 3，纵向切片 |
