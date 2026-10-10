# 历史计划提示（2026-10-08）

本文件记录 2026-10-04 的 v0.2 / 旧 P 系列工程计划，保留供旧任务、裁决和证据回查；**不再单独作为当前 N 系列执行入口**。当前需求权威为 `docs/V04/ANCS_AI_Native_v0.4.md`，任务与接手顺序见 `docs/V04/ANCS_v0.4_Task_Backlog.md`、`docs/V04/ANCS_v0.4_Codex_Start.md`，实际状态见 `docs/requirements/ai-native-v04-acceptance-ledger.md`。冲突按 v0.4 §1.4 和 `docs/decisions/0009-v04-authority-and-scope.md` 处理；下方旧“已生效”只表示其历史时点。

明确替换：文章／研究长视频不再是唯一入口；持久化权威时间由整数毫秒扩展为有理时基与源 PTS（旧毫秒数据须兼容）；全局 Audio-First、专业功能永久排除、旧界面限制以及只在最后生成实际镜头的假设不再指挥新实现。旧安全、隐私、版本、账本、恢复和多端原则继续有效。旧任务及验收证据不清零。

---

ANCS 工程推进细则 · 2026-10-04

目标文件：`ANCS_Plan261004.md`  
需求基线：`creator_video_os_spec_v0.2.md`  
交付方向：先达到内部生产可用，再推进对外 SaaS、Packs、桌面、手机及 Enterprise。  
细化范围：全部阶段。  
当前状态：已写入目标文件并生效（2026-10-04）。任务执行状态以 `docs/handoffs/` 交接记录为准。

---

## 1. 文档作用与执行原则

### 1.1 本计划解决什么问题

本计划把产品规范转为可分配、可实现、可验证、可交接的工程任务。

任何接手模型必须能够从本计划判断：

1. 当前应该做哪一项任务。
2. 该任务依赖什么。
3. 输入、输出和持久化对象是什么。
4. 哪些业务规则必须遵守。
5. 哪些异常路径必须处理。
6. 用什么证据证明完成。
7. 当前任务结束后交接什么。

原规范继续作为产品需求权威来源。本计划负责确定实现顺序、工程默认值和验收办法，不得静默删除原规范中的 MUST。

### 1.2 已确认的项目事实与用户选择

- 当前目录只有需求 Markdown 和对应 Word 文档，没有应用代码、工程配置或 Git 仓库。
- 全部阶段均需要拆解为可交接任务。
- 首个交付目标为内部生产使用。
- 技术选型采用本计划确定的默认方案。
- V1 主链路为：文章／研究 → 专业长视频。
- V1 默认输出为 16:9、1920×1080、30fps。
- 首个完整样例采用原规范 §80 的法国国债风险主题，目标时长 8～10 分钟。
- 首期界面以简体中文为默认语言，内容模型和语音流程支持语言字段；中英文分别提供测试样例。
- 按依赖和验收推进，不在缺少团队规模、预算和实际测量的情况下承诺日历工期。

### 1.3 约束优先级

发生冲突时依次遵守：

1. 用户后续明确确认的需求变更。
2. 原规范的 V1 硬约束和 §97 架构优先级。
3. 原规范明确的 MUST。
4. 本计划已经记录的工程裁决。
5. SHOULD、推荐方案和示例。

模型不得把“实现困难”“缺少凭据”或“时间不足”解释为自动取消需求。

### 1.4 完成状态

统一使用：

| 状态 | 含义 |
|---|---|
| `TODO` | 尚未开始 |
| `IN_PROGRESS` | 正在实现 |
| `BLOCKED` | 缺少明确前置条件，必须记录阻塞原因 |
| `IMPLEMENTED_UNVERIFIED` | 已有实现，但缺少规定的验证证据 |
| `VERIFIED` | 所有验收通过，证据齐全 |
| `DEFERRED` | 按本计划明确安排到后续阶段 |

只有 `VERIFIED` 可以计入阶段完成比例。

Mock 验证通过，不等于真实 Provider 验证通过。接口存在，不等于对应产品功能已交付。

---

## 2. 需求解释与范围裁决

以下裁决必须随工程一起保留，防止后续模型重复选型或错误扩张范围。

| 编号 | 规范中的问题 | 采用的裁决 |
|---|---|---|
| DEC-01 | §29 使用 `/api/v1`，§32 使用 `/v1` | 对外统一 `/api/v1`，不维护两套业务路由 |
| DEC-02 | §12 时间可选毫秒或 frame | 持久化权威时间统一为整数毫秒；渲染边界转换为 frame |
| DEC-03 | 部分表样例缺少租户字段 | 所有租户业务表、版本表和关联表均包含 `workspace_id`；全局目录和用户认证表除外 |
| DEC-04 | §10、§64、§65、§77 组件数量不同 | V1 固定交付本计划列出的 20 个标准场景类型；其余类型有明确后续任务 |
| DEC-05 | §64 列出 Veo 和 Runway，§77 要求至少一个真实 AI Video Provider | V1 以 Veo 为默认真实接入；Runway 后续完成。若账号能力阻塞 Veo，可记录裁决后交换先后顺序 |
| DEC-06 | Publishing 在 §96 有验收，但又被标记为 Post-MVP | V1 完成契约、能力分级类型和 Handoff 协议；真实发布体验在 Publishing Pack 阶段验收 |
| DEC-07 | BYOK 位于 SaaS 阶段，但声音章节要求提前支持 | Provider 凭据模型、统一路由、Managed/BYOK Voice 在 V1 实现；商业套餐和收费随后实现 |
| DEC-08 | §55 允许降级，§86 禁止正式产物含占位 | Draft 可占位；Final 不允许未解决占位。受控静态替代经确认后才算正式场景 |
| DEC-09 | Audio-First 与局部重建需要兼容 | 以稳定旁白段为合成与缓存单位，再拼接 Master Audio 和全局 Alignment |
| DEC-10 | 内部使用与收费 SaaS 门槛不同 | 分设内部生产门和商业上线门；V1 已包含权限、成本保护、备份和恢复基础 |
| DEC-11 | Custom Motion 在不同清单中深度不一 | V1 实现受约束的真实生成、隔离验证和渲染闭环，不以普通静态组件冒充 |
| DEC-12 | 后续功能出现在首批数据库建议表中 | 按实际阶段建表；先保留必要契约，不为全部未来功能提前建立空业务系统 |
| DEC-13 | 文章内容与视频状态都有 Source of Truth 概念 | Content Core 管内容事实；Scene Graph 管具体视频表达。更新内容核心不自动覆盖已批准视频 |
| DEC-14 | Provider 参数会变化 | 模型、价格、并发、地区、保留策略均进入版本化目录配置，不进入核心业务枚举 |

---

## 3. 技术基线与模块边界

### 3.1 固定技术方案

| 层级 | 默认方案 | 实施要求 |
|---|---|---|
| 工程组织 | TypeScript、pnpm workspace | 一个锁文件；严格类型检查；按实际任务创建包 |
| Web | Next.js、React、Tailwind | 负责页面、交互和客户端状态 |
| 服务端数据请求 | TanStack Query | 服务端状态由 API 返回，不复制到独立权威状态库 |
| 本地界面状态 | Zustand | 仅保存选择、面板、拖拽等临时状态 |
| API | Fastify 模块化服务 | REST、版本化接口、独立于 Next.js |
| 契约 | Zod、JSON Schema、OpenAPI | 单一契约来源，生成类型与接口文档 |
| 数据库 | PostgreSQL、Drizzle | 迁移文件入库；业务事务显式定义 |
| 调度 | Redis、BullMQ | PostgreSQL 保存权威任务状态；采用 Transactional Outbox |
| 认证 | Better Auth、Drizzle Adapter | Web 会话；原生端 OAuth Authorization Code + PKCE |
| 文件存储 | S3 接口 | 本地使用兼容测试服务；云端默认 AWS S3 |
| 云端基线 | AWS 东京区域 | 区域作为部署配置；部署前验证账号、网络和 Provider 地域条件 |
| 凭据保护 | AWS KMS envelope encryption | 本地可有明确标识的开发实现；生产不得使用开发密钥实现 |
| 视频渲染 | Remotion 独立容器 Worker、FFmpeg | 首期不用 Lambda，先验证专用 Worker |
| Custom Motion | 独立 Linux 沙箱 Worker、gVisor | 不在 API、普通 Worker 或用户浏览器执行未受信代码 |
| 自动化测试 | Vitest、Playwright | 领域、契约、集成、浏览器 E2E 分层 |
| 可观测性 | OpenTelemetry、结构化日志 | 日志脱敏，追踪请求、任务、Provider 调用 |
| 桌面 | Tauri、Vite、React | 复用 SDK 和可共享编辑组件 |
| 手机 | React Native、Expo | 以审核、轻编辑和 Handoff 为首期重点 |
| 支付 | Stripe Checkout/Billing | 先完成测试环境；正式收款属于商业上线门 |
| 基础设施 | Docker；商业部署阶段使用 Terraform | 开发环境与生产环境配置分离 |

Fastify 的类型和 Schema 支持、Drizzle 的迁移与事务能力可用于上述契约优先方案。[Fastify 文档](https://fastify.dev/docs/latest/Reference/Type-Providers/)、[Drizzle 事务](https://orm.drizzle.team/docs/transactions)、[Drizzle 迁移](https://orm.drizzle.team/docs/migrations)。

Better Auth 提供 Fastify 集成和 OAuth Provider 能力；原生登录采用 PKCE，并验证刷新令牌轮换行为。[Fastify 集成](https://better-auth.com/docs/integrations/fastify)、[OAuth Provider](https://better-auth.com/docs/plugins/oauth-provider)。

桌面采用独立 Vite 客户端，避免把 Next.js 服务端运行时打包进桌面；Tauri 官方 Next.js 集成要求静态输出。[Tauri 文档](https://v2.tauri.app/start/frontend/nextjs/)。

### 3.2 依赖版本规则

- 初始化时选择仍受支持的稳定版本。
- 在 P00 兼容性验证后锁定精确版本。
- Remotion 相关包使用一致版本。
- 不使用浮动镜像标签作为生产发布依据。
- 升级依赖必须单独运行契约、组件和渲染回归。
- 不因某个模型熟悉另一套框架而更换技术栈。

### 3.3 目录职责

```text
apps/
  web/                 Web 页面和交互
  api/                 HTTP、认证接入、请求授权、应用服务入口
  worker/              工作流、Provider、文件处理、回收任务
  render-worker/       标准视频合成
  motion-worker/       Custom Motion 隔离执行
  desktop/             后续桌面客户端
  mobile/              后续手机客户端

packages/
  contracts/           公共请求、响应、事件、扩展契约
  scene-schema/        Scene Graph、时间、媒体和场景校验
  domain/              领域规则、操作、状态迁移
  db/                  表结构、迁移、数据库访问
  auth/                认证集成及授权规则
  sdk/                 所有客户端共用 API SDK
  narrative/           内容到叙事
  director/            导演规划和编辑计划
  visual-grammar/      语义到视觉规则
  scene-components/    标准场景组件
  remotion-core/       Composition、时序、混音、字幕
  providers/           所有外部能力 Adapter
  storage/             对象存储访问
  usage/               用量、预算、费用、Credits
  extensions/          Pack 契约和注册
  ui/                  可共享基础界面
  testing/             fixtures、Mock Adapter、测试辅助

docs/
  decisions/           架构裁决
  handoffs/            模型交接
  verification/        验收证据
  runbooks/            部署、恢复、故障处理
```

### 3.4 强制依赖方向

- `web/desktop/mobile → sdk/contracts`。
- `api/worker → domain/contracts/db/providers`。
- `providers → contracts/domain`。
- `domain` 不依赖 Next.js、React 或具体 Provider SDK。
- Web 不直接访问数据库、对象存储管理凭据或 Provider Secret。
- UI 通过 SDK 调用业务 API。
- Provider SDK 只能在对应 Adapter 内使用。
- 普通渲染 Worker 只消费通过验证的组件和固定输入。
- 未受信 Custom Motion 代码只能进入隔离执行链路。

---

## 4. 公共契约与数据规则

### 4.1 统一表示

- API 与 JSON 使用 `camelCase`。
- 数据库使用 `snake_case`。
- ID 为不透明字符串，客户端不得解析其内部含义。
- 时间戳使用 UTC ISO 8601。
- 视频时间使用整数毫秒。
- Credits 使用整数最小单位。
- 货币金额使用定点十进制字符串和明确币种，禁止浮点累计。
- 每种可持久化文档都带 `schemaVersion`。
- 每个可编辑聚合都带服务器维护的 `revision`。

### 4.2 核心领域对象

| 领域 | 必须建模的对象与关系 |
|---|---|
| 租户 | User、Workspace、Membership、Role |
| 创作者 | CreatorIdentity、AvatarIdentity、VoiceIdentity、BrandIdentity、PresenterStyle |
| 栏目 | Channel、ChannelStyleVersion、SpeechProfile、PronunciationDictionaryVersion |
| 内容 | ContentDocument、ContentBlock、Claim、Source、SourceSnapshot、Citation、StructuredDataset |
| 叙事 | NarrativePlan、Chapter、NarrationBlock、ScriptVersion |
| 视频 | Project、Scene、SceneDataBinding、SceneAssetBinding、Caption、AudioTrack、Overlay |
| 历史 | EditEvent、ProjectVersion、SceneRevision、Approval、AuditLog |
| 资产 | Asset、AssetVersion、UploadIntent、LicenseMetadata、RetentionClass |
| 异步 | Workflow、Job、JobDependency、ProviderGeneration、ProviderAttempt、OutboxEvent、WebhookEvent |
| 渲染 | Render、RenderInputSnapshot、Manifest、QAReport |
| 商业 | UsageLedger、CreditLedger、CreditHold、BudgetReservation、Entitlement |
| 扩展 | PluginManifest、Capability、OutputPlan、Artifact、HandoffDescriptor |

ProviderConnection 保存加密凭据引用；身份对象保存 Provider 资产引用，两者不得混为一条业务数据。

### 4.3 数据库不变量

1. 所有业务记录归属 Workspace。
2. 关联双方必须属于同一 Workspace。
3. Scene 有独立记录和 revision，不能只存一个不可分辨的大 JSON。
4. 当前状态、编辑事件和 Outbox 在同一事务提交。
5. Asset 内容不可原地覆盖；替换内容创建新 AssetVersion。
6. ProjectVersion 和 Final Manifest 不可原地修改。
7. Provider 临时 URL 不能作为永久资产标识。
8. 引用中的资产、组件、声音、主题、脚本都必须能确定具体版本。
9. Project 删除先进入 Trash；默认 30 天后清理。
10. 清理 Worker 必须保护仍被有效项目或版本引用的共享资产。

### 4.4 ContentDocument 与未来 ContentCore

V1 的内容结构必须保存：

- 原始块及稳定 ID。
- Claim 的事实、分析、观点、不确定类型。
- Source 与 Citation。
- 表格、数值、单位、时间范围和实体。
- 已抽取的因果、时间线、地理关系。
- 无法结构化但仍有价值的原始内容引用。

后续 ContentCore 通过版本化转换生成，保留原始 ContentDocument，禁止有损覆盖。

### 4.5 Scene Graph 的最小结构

```text
SceneGraph
  schemaVersion
  projectId
  projectRevision
  channelSnapshot
  identitySnapshot
  format
  timeline
  scenes[]
  captions[]
  audioTracks[]
  overlays[]
  sourceReferences[]
```

每个 Scene 至少包含：

```text
id / revision / position
startMs / durationMs
semanticType / sceneType
narrationBlockIds / narration
visualIntent
componentId / componentVersion / props
sourceBindings / dataBindings
assetBindings
providerRequirement
transition
locked / approved / needsReview
status
```

`providerRequirement` 表达需要的能力，不直接保存某供应商请求字段。

### 4.6 编辑与并发协议

每个修改请求包含：

```text
baseProjectRevision
expectedSceneRevisions
operations
idempotencyKey
```

操作采用显式类型，不允许客户端提交任意数据库补丁。至少包括：

```text
update_project
update_script
insert_scene
update_scene
delete_scene
duplicate_scene
split_scene
reorder_scenes
replace_asset
update_caption
update_audio_track
set_scene_lock
restore_scene
restore_project_version
```

处理顺序固定：

1. 验证身份及 Workspace 权限。
2. 校验请求 Schema。
3. 检查幂等键与请求摘要。
4. 加载目标聚合和预期 revision。
5. 检查 Lock、资产引用及操作合法性。
6. 计算派生影响和失效范围。
7. 在事务中提交新状态、revision、EditEvent 和 Outbox。
8. 返回服务器权威结果。

并发规则：

- 同一 Scene revision 的竞争修改，只允许一个成功。
- 不同 Scene 的独立修改可在预期 Scene revision 未变化时合并。
- Reorder、整片重写、恢复等结构操作要求项目 revision 精确匹配。
- 冲突返回 `409 VERSION_CONFLICT` 和刷新所需信息。
- 同幂等键、同请求返回原结果；同键、不同请求返回 `IDEMPOTENCY_CONFLICT`。

### 4.7 Lock 与审批

- AI 不得修改锁定 Scene 的内容、资产、类型或时长。
- 修改锁定内容必须有明确解锁操作。
- 上游时长变化引起的绝对位置重算属于派生变化，必须展示影响。
- AI 无法满足锁定约束时返回 warning，不自动解锁。
- Scene 审核与 Final 审批分别存储。
- Final 审批绑定 `projectVersionId + renderId + manifestHash`。
- 新编辑产生的新版本需要重新审批。
- 历史已批准版本保留原审批记录，不被后来编辑篡改。

### 4.8 Undo、Redo 与 Restore

- 撤销通过新的补偿操作形成新 revision。
- Restore 从历史快照构建新的当前状态。
- 不回拨 revision，不删除原事件。
- 不撤销已经发生的 Provider 费用。
- 不因历史恢复重新提交已完成的外部生成。
- 新编辑会结束原来的 Redo 分支。
- 历史依赖的外部身份已退役时，可以使用缓存资产；无法重新生成时明确报告依赖缺口。

---

## 5. 时间、资产失效与生成可靠性

### 5.1 Audio-First 的实现规则

1. 脚本拆成有稳定 ID 的 NarrationBlock。
2. Speech Director 输出供应商无关的 SpeechPlan。
3. 按段合成音频并保存局部 Alignment。
4. 拼接 Master Narration。
5. 生成全局 Alignment。
6. 依据实际时间确定 Scene、字幕和动画 cue。
7. Avatar 使用对应旁白片段驱动口型。
8. 最终合成只使用这一套主时钟。

Provider 若不返回时间戳，进入 AlignmentProvider；首期不接受仅按字数估计的 Final 对齐。

ElevenLabs 的语音接口提供字符时间信息，但返回值可能缺失，Adapter 必须验证后再转换为内部 Alignment。[官方时间戳接口](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps)。

### 5.2 毫秒到 frame

- 按绝对起止边界统一转换 frame。
- Scene 帧数等于结束帧减开始帧。
- 禁止逐段独立四舍五入后累加。
- 字幕、动画、音频裁剪使用同一个转换模块。
- 10 分钟测试样例不得出现累计时长漂移。
- Transition 不得隐式改变旁白主时钟。

### 5.3 Timeline 操作语义

| 操作 | 权威变化 |
|---|---|
| Reorder / Move | 修改 Scene 顺序并重算位置 |
| Crop / Scale | 修改视觉布局，不重做 TTS |
| Media Trim | 修改素材内部裁剪范围 |
| Narration Trim | 按 Alignment 边界修改旁白区间及字幕，不任意切断词语 |
| Split | 拆分 Scene 与引用区间，尽量复用原音频和素材 |
| Duplicate | 创建新 Scene ID 和旁白出现位置，可复用相同内容资产 |
| Replace | 建立新资产引用，保留旧版本引用 |
| Volume / Ducking | 修改混音配置，不重做语音生成 |
| Subtitle Edit | 修改字幕结构；如改变实际旁白内容，另产生脚本编辑 |

### 5.4 失效规则

| 变化 | 必须失效 | 必须尽量复用 |
|---|---|---|
| 项目标题 | 展示元数据、相关导出描述 | 音频、Avatar、AI Video |
| 一段旁白 | 该段 TTS、Alignment、相关 Avatar、后续绝对位置 | 无关场景视觉素材 |
| 图表数值 | 相关图表、相关事实 QA | 不依赖该数值的音频和素材 |
| 字体或主题 | 标准组件画面及合成 | 外部生成素材、旁白 |
| 声音身份或生效 Speech 配置 | 受影响旁白段及相关 Avatar | 纯视觉资产 |
| Scene 顺序 | 全局位置、字幕全局位置、Final | 各段生成资产 |
| Provider 生成输入 | 对应生成资产 | 其他 Provider 产物 |

失效判断依据实际依赖指纹；revision 用于防止旧结果覆盖当前状态，不能机械地让每次 revision 变化使所有资产失效。

### 5.5 任务系统

数据库保存规范中的 Job 状态：

```text
WAITING_DEPENDENCY
QUEUED
RUNNING
PROVIDER_QUEUED
SUCCEEDED
FAILED_RETRYABLE
FAILED_FINAL
CANCEL_REQUESTED
CANCELLED
```

额外字段表达执行阶段、提交状态、重试次数、租约、心跳和是否需要对账。

强制规则：

- BullMQ 消息只携带任务 ID 和必要路由信息。
- Worker 从数据库读取权威输入。
- 数据库事务与 Outbox 保证已接受任务不丢失。
- Worker 崩溃后通过租约恢复。
- 依赖失败必须传播为明确结果，不能永久等待。
- Provider 并发许可覆盖实际在途任务。
- 回调、轮询和人工恢复都走同一状态迁移服务。
- 迟到结果登记资产，但不得覆盖不匹配的 Scene 输入版本。

### 5.6 幂等与付费提交

分别实现三种幂等：

1. API 请求幂等。
2. 内容生成去重。
3. 账本结算幂等。

生成指纹包含：

```text
workspace
credential scope
operation
effective input
source asset checksums
prompt/component/model/config versions
output profile
privacy policy
explicit candidate nonce
```

普通重试不得产生新 nonce；只有用户明确要求“再生成一个候选”时创建新候选。

Provider 接收请求后网络中断时：

- 有上游幂等能力：使用同一幂等标识查询或重试。
- 能查询：先确认远端是否已有任务。
- 无法确认：标记需要对账，暂停自动再次付费提交。
- 结果下载失败：只重试下载，不重新生成。

### 5.7 取消

- `CANCEL_REQUESTED` 不代表 Provider 已停止。
- 只有确认停止后才进入 `CANCELLED`。
- Provider 不支持取消时，UI 明确显示“已提交，可能继续产生费用”。
- 迟到结果仍需回收并准确记账。
- 完成与取消竞争通过数据库条件迁移解决。

---

## 6. 费用、安全和质量门禁

### 6.1 费用流程

```text
估算
→ 校验价格及能力配置
→ 原子预留预算／Credits
→ 创建任务
→ 提交 Provider
→ 回收结果
→ 记录实际成本
→ 幂等结算
→ 释放剩余预留
```

要求：

- 软件订阅权益与 AI Compute 分离。
- Provider 成本与用户 Credit 消费分别记账。
- 所有付费尝试均记 Provider 成本，包括失败尝试。
- Managed 用户费用不超过其批准的上限。
- 超过批准上限必须暂停后续付费提交。
- 默认不把内部失败重试额外成本静默转嫁给用户。
- BYOK 的外部费用如实记录，不承诺由平台退还。
- 退款和调整追加账本记录，不修改历史记录。
- 平台、Workspace、Project、Job 均有预算限制。
- 真实付费调用默认关闭，必须配置有效价格及非零批准预算后开启。

### 6.2 RBAC 默认权限

| 角色 | 权限 |
|---|---|
| OWNER | Workspace 全部业务权限、所有权、账单 |
| ADMIN | 成员、Provider、项目管理；不能转移所有权 |
| EDITOR | 内容编辑、素材、生成、渲染 |
| REVIEWER | 阅读、评论、审核和批准；不直接改脚本或 Scene |
| VIEWER | 只读预览 |
| PLATFORM_ADMIN | 独立运营权限，不复用 Workspace ADMIN |

内部单人用户可同时拥有编辑和批准权限；Enterprise 后续增加职责分离规则。

### 6.3 安全底线

- 每个读写、下载签名和事件订阅都检查 Workspace 权限。
- 外部 URL 抓取防私网、localhost、DNS rebinding、重定向绕过。
- 上传验证大小、真实 MIME、校验和。
- SaaS 上线前加入恶意文件扫描。
- 外部文章、文档、Prompt 和 Provider 输出都是不可信输入。
- 原始声音训练资料标记 `IDENTITY_SENSITIVE`。
- Secret 仅保留后端加密引用，日志和错误返回不得包含明文。
- `no training`、`retention`、`zero retention` 分开记录。
- PRIVATE 路由不得自动降级为不满足隐私要求的 Provider。
- 访问失效、权限撤销和删除操作必须产生审计事件。

### 6.4 Final 双重 QA

**渲染前检查：**

- 所有 required 资产 Ready。
- 无未解决 placeholder。
- 组件和资产版本存在。
- 图表绑定真实数据及来源。
- 声音授权和引用有效。
- 所有字幕与音频区间合法。
- Render 输入已经冻结。

**渲染后检查：**

- 视频可完整解码。
- 分辨率、fps、时长、音轨符合 Render Profile。
- Manifest 与实际文件一致。
- 字幕无越界。
- 无缺失资源。
- 关键文字位于安全区。
- 黑帧、空白帧和异常静音检测有明确阈值及合法例外。
- 响度默认目标为 -16 LUFS、容差 ±1 LU，True Peak 不高于 -1 dBTP；这些是本项目可配置的工程默认值。
- AI 视觉 QA 只提供提示，不替代确定性检查。

正式交付流程：

```text
FINAL_RENDERED
→ QA_PASSED
→ READY_FOR_REVIEW
→ HUMAN_APPROVED
→ EXPORT / PUBLISH
```

---

## 7. 任务执行与证据模板

以下全部任务继承统一流程：

```text
contracts
→ migration
→ domain/service
→ API
→ SDK
→ UI
→ tests
→ docs
```

不涉及的层明确写“不适用”，不得先在 UI 内实现权威规则。

每个任务完成时记录：

```text
taskId
requirementReferences
dependencies
status
implementationSummary
changedFiles
schemaAndMigrationChanges
commandsExecuted
testResults
mockOrRealProvider
evidenceLocations
remainingRisks
nextTask
```

每个任务还必须满足：

- 有正常路径和关键失败路径。
- 有升级兼容说明。
- 有必要的回滚或关闭方式。
- 测试证明行为，不只证明函数被调用。
- 没有“假成功”返回值。
- TODO 写清原因、依赖和预期接口。

---

## 8. P00—P08：内部生产版本

### P00：工程基线与验收基线

前置：无。  
来源：§0、48—51、75—80、附录 B/C。

| 任务 | 实施与产物 | 验收 |
|---|---|---|
| P00-01 需求追踪 | 为原规范的独立要求分配稳定 ID，记录优先级、阶段、任务和验收项；保存本计划裁决 | 每个 MUST 有任务和验收；后续功能没有误列为 V1 阻塞 |
| P00-02 工程初始化 | 初始化 Git、pnpm workspace、TypeScript、检查命令、CI、环境示例和架构规则 | 全新目录可安装、类型检查、测试、构建；仓库无 Secret |
| P00-03 兼容性验证 | 最小验证 Fastify/Zod/OpenAPI/SDK、Drizzle 事务、Remotion 预览与服务端渲染 | 生成一个标准 Scene 的预览及 MP4；记录精确依赖版本 |
| P00-04 Golden Fixtures | 建立法国国债主题内容、来源、数据、预期结构；另建明显标注的合成负面测试数据 | 正式样例数据可追溯；测试不依赖实时网页内容变化 |

退出条件：后续任务可以在固定工程和固定测试输入上开发。

### P01：契约、认证、租户与扩展接口

前置：P00。  
来源：§6、12、22、29—34、63、78、92—96。

| 任务 | 实施与产物 | 验收 |
|---|---|---|
| P01-01 公共契约 | 定义 ID、revision、错误、分页、金额、时间、SceneGraph、内容和事件 Schema | 正常 fixture 往返无损；非法值被拒；生成 OpenAPI |
| P01-02 认证 | 接入登录、会话、退出、刷新与原生 PKCE；首期账号由内部管理创建 | 过期、退出、刷新重放和错误回调被正确处理；客户端无长期明文凭据 |
| P01-03 Workspace/RBAC | 实现租户、成员和权限矩阵；建立服务端统一授权入口 | A 租户不能读写 B 的 Project、Asset、Job 或事件 |
| P01-04 Creator/Channel | 建立身份、主题、SpeechProfile 的版本与 Channel 默认值快照 | 修改 Channel 后旧项目不变；新项目继承新默认值 |
| P01-05 API/SDK 基线 | 统一 `/api/v1`、错误格式、客户端标头和 SDK；建立独立客户端示例 | 不启动 Web 也能用 SDK 完成授权后的项目读写 |
| P01-06 扩展契约 | 定义 OutputPlugin、PackManifest、Capability、DistributionProvider、HandoffDescriptor | 契约不依赖 Web；未安装能力明确返回不支持 |

退出条件：身份、租户与公共协议可独立运行。

### P02：项目、历史、资产与事件

前置：P01。  
来源：§21—28、33—34、40、58—61、84—85。

| 任务 | 实施与产物 | 验收 |
|---|---|---|
| P02-01 项目与 Scene | 实现规范化表、Graph 组装、Scene revision、关联完整性 | 数据库状态可生成合法 Graph；跨租户引用被拒 |
| P02-02 编辑事务 | 实现操作处理器、条件更新、幂等、EditEvent 和 Outbox | 并发更新无丢失；同键重放无重复事件 |
| P02-03 历史恢复 | 实现快照、Undo/Redo、整项目及单 Scene Restore | 恢复产生新 revision；旧版本和账本不被改写 |
| P02-04 文件资产 | 实现上传意图、直传、确认、探测、校验和、版本、授权元数据 | 重复确认幂等；伪造 MIME、越权对象和不完整上传不可 Ready |
| P02-05 保留与删除 | 实现 Trash、TTL、引用保护及可重入清理 Worker | 重跑清理不误删；恢复期内可恢复；共享资产受到保护 |
| P02-06 事件与通知 | 实现 SSE、事件游标、断线恢复、后端通知存储 | 断线重连能恢复状态；越权和过期游标按协议处理 |

退出条件：项目状态可持久化、可恢复、可同步，素材完全受平台管理。

### P03：任务、Provider 基础与成本保护

前置：P02。  
来源：§14—20、25、35—36、43—46、68—73。

| 任务 | 实施与产物 | 验收 |
|---|---|---|
| P03-01 Workflow | 建立任务依赖、状态机、BullMQ 调度和 Outbox 投递 | 事务提交后投递中断可恢复，不丢任务 |
| P03-02 恢复与取消 | 实现租约、心跳、退避、抖动、失败检查、人工重试和取消 | 各关键点杀 Worker 后可继续；重复消费不产生重复副作用 |
| P03-03 Provider Catalog | 建立能力、模型、价格、限额、地区、保留及核验时间的版本配置 | Router 按能力筛选；无有效配置时明确阻止真实调用 |
| P03-04 凭据与路由 | 实现 KMS、连接测试、轮换、撤销、Managed/BYOK 选择 | 密钥不进入前端及日志；跨租户连接不可使用 |
| P03-05 账本与预算 | 实现用量记录、预算预留、Credits Hold、结算、退款和熔断 | 并发抢预算不超额；回调重放只结算一次 |
| P03-06 外部结果回收 | 实现 Webhook 验证、轮询补偿、结果下载、校验、存储和过期预警 | 下载失败不重生成；Provider URL 失效后已完成资产仍可用 |
| P03-07 Mock Provider | 提供成功、慢任务、429、提交结果未知、重复回调、取消失败等脚本化行为 | CI 可确定性重现各类故障 |

退出条件：接入真实付费服务之前，任务可靠性和费用保护已经通过测试。

### P04：内容归一化、叙事与导演

前置：P01—P03。  
来源：§7—10、37、52—56、85、93—94。

| 任务 | 实施与产物 | 验收 |
|---|---|---|
| P04-01 输入归一化 | 实现 URL、粘贴文章、手写脚本、Sources 编辑；抽取 ContentDocument | URL 异常、安全限制、空正文和错误编码有明确结果 |
| P04-02 证据与数据 | 建立 Claim、Citation、SourceSnapshot、表格和单位模型 | 每个事实图表可追溯；缺数据不会自动生成虚构数列 |
| P04-03 Narrative | 接入真实 LLM Adapter；输出口语化叙事、章节、旁白段和估计时长 | Schema 不合法时有限修复；锁定文字和事实类型保留 |
| P04-04 Visual Grammar | 实现 §10 的基础及财经语义识别映射，优先确定性视觉 | 对固定语义输入得到允许类型；数据不足时受控降级 |
| P04-05 Director | 输出 Graph、资产计划、任务计划、成本、warning 和简短决策摘要 | 输出经 Schema、来源、Lock、预算规则验证后才能应用 |
| P04-06 Speech Director | 将旁白语义、身份、语气和时长目标转为供应商无关 SpeechPlan | 不支持的风格参数得到可解释降级；私有参数不泄漏到 Graph |

退出条件：真实文章能够形成可解释、可编辑、来源完整的 Scene Graph。

### P05：标准组件、预览与编辑器

前置：P04；组件基础可在 P01 后并行。  
来源：§5、11—12、37—38、54、57—59、65—66。

V1 固定 20 个标准场景类型：

```text
HOST_FULL
HOST_SIDE
BIG_NUMBER
KPI_GRID
LINE_CHART
DUAL_LINE_CHART
BAR_CHART
SPREAD_AREA_CHART
TIMELINE
CAUSAL_FLOW
CAUSAL_LOOP
MAP_STATIC
NEWS_HEADLINE
SOURCE_CARD
QUOTE_CARD
DOCUMENT_HIGHLIGHT
IMAGE_FULL
REAL_BROLL
CHAPTER_TITLE
SUMMARY
```

`AI_VIDEO` 作为外部视频资产场景在 P06 验收；`CUSTOM_MOTION` 在 P07 验收，不用于凑标准组件数量。

| 任务 | 实施与产物 | 验收 |
|---|---|---|
| P05-01 组件协议 | 建立 ComponentDefinition、主题 tokens、props Schema、版本和 fixture | 每个组件可独立校验与渲染；字体和颜色可由主题控制 |
| P05-02 标准组件 | 实现上述 20 类型；基础绘图可复用，类型行为独立验收 | 正常、长文本、空值、极值和边界时长均有截图或渲染证据 |
| P05-03 工作区 | 实现 Dashboard、Script、Storyboard、Scene Editor、Assets、History、Render 页面 | 空、加载、失败、无权限、冲突状态均可操作 |
| P05-04 Preview | Remotion Player 消费 Graph；Draft 支持明确标识的占位素材 | 修改标准场景可更新预览；编辑不会隐式触发昂贵视频调用 |
| P05-05 Lite Timeline | 实现 reorder、move、trim、split、duplicate、delete、replace、transition、crop/scale、音量及字幕修正 | 所有操作回写统一操作协议；刷新页面后状态一致 |
| P05-06 AI Edit | 实现自然语言计划、差异预览、成本影响、Apply、拒绝及 Undo | 计划未 Apply 不改数据库；一项非法操作导致整批不提交 |

退出条件：创作者可以预览、修改、撤销和恢复完整 Draft。

### P06：真实声音、Avatar 和 AI Video

前置：P03、P05。  
来源：§6、13—18、39—40、45—46、58—59、83、94—95。

| 任务 | 实施与产物 | 验收 |
|---|---|---|
| P06-01 能力验证 | 核验 HeyGen、ElevenLabs、Veo 的账号能力、音频输入、价格和保留策略；保存日期证据 | 账号实际能力与 Catalog 一致；不可用能力不显示为可用 |
| P06-02 Voice | 接入真实 TTS、声音列表、VoiceIdentity、Managed/BYOK 和分段缓存 | 两种凭据模式可生成；身份版本固定；敏感资料不出现在普通日志 |
| P06-03 主时钟 | 拼接 Master Audio、保存 Alignment、生成字幕和 narration cues | 中英文、数字、缩写、停顿和改一句话的局部重建通过 |
| P06-04 Avatar | 使用对应 Master 旁白片段驱动 Avatar，校验时长与口型资产 | 无重复旁白或独立第二时钟；能力不满足时阻止该路线 |
| P06-05 AI Video | 接入 Veo、AI_VIDEO Scene、明确生成动作及受控降级 | 双击只提交一次；输入只含 Scene 所需数据；结果回收后可播放 |
| P06-06 混音与字幕 | 实现 BGM、旁白、Scene 原声、ducking、淡入淡出、字幕样式和烧录开关 | 无重叠双人声；字幕不越界；音量调整不重做 TTS |
| P06-07 Native Fallback | 展示 Provider 任务引用，支持外部处理后上传回绑 | 回导文件成为 AssetVersion，保留来源、授权和编辑历史 |

退出条件：至少一个真实 Avatar、Voice、AI Video Provider 与统一时间模型完成闭环。

### P07：Custom Motion、Final 与审批

前置：P05—P06。  
来源：§11、28、39、80、86—87。

| 任务 | 实施与产物 | 验收 |
|---|---|---|
| P07-01 Motion 沙箱 | 建立无网络、只读输入、白名单依赖、无 Secret、CPU/RAM/超时限制的执行环境 | 网络、越权文件、动态依赖、无限循环等攻击 fixture 被拒 |
| P07-02 Motion 生成 | 生成独立组件，执行类型检查、静态检查、抽帧和渲染测试 | 失败不能进入项目；通过后保存代码、依赖、输入和产物版本 |
| P07-03 Render Snapshot | 冻结 Graph、脚本、身份、资产、组件、配置和预算快照 | 渲染中编辑当前项目不改变该次 Render 输入 |
| P07-04 Final 合成 | Remotion 服务端渲染、FFmpeg 最终处理，生成 MP4/SRT/VTT/Manifest | 1920×1080、30fps、音轨和时长正确；产物全部进入存储 |
| P07-05 QA | 实现渲染前预检、技术及内容 QA、人工审核界面 | 缺素材、错数据、占位、字幕越界和文本溢出被正确处理 |
| P07-06 审批导出 | 将批准绑定固定 Render，生成受控下载入口 | 未批准不能正式导出；批准后导出与 Manifest 一致 |

Remotion 的服务端渲染以固定 Composition 和 JSON 输入为基础。[官方 renderMedia 文档](https://www.remotion.dev/docs/renderer/render-media)。沙箱选型以独立运行时隔离为基础，不能只依赖静态代码检查。[gVisor 文档](https://gvisor.dev/docs/user_guide/quick_start/docker/)。

退出条件：完整真实项目可通过 QA 和人工批准，导出正式长视频。

### P08：内部生产部署与 V1 总验收

前置：P00—P07。  
来源：§44、67、70—72、77—78、附录 C、§96 V1 子集。

| 任务 | 实施与产物 | 验收 |
|---|---|---|
| P08-01 内部部署 | 部署 Web/API/Worker/Render、数据库、队列、存储和 KMS；隔离环境配置 | 新环境按 Runbook 可重复部署；错误配置启动失败并说明原因 |
| P08-02 最小运营 | 队列、失败任务、成本、Provider 状态、人工恢复和审计界面 | 普通用户不能访问；人工重试仍遵守预算、幂等和版本规则 |
| P08-03 监控恢复 | 建立日志、指标、告警、备份、PITR、恢复和密钥轮换流程 | 实际恢复到隔离环境，并能读取及重渲染固定版本 |
| P08-04 性能与故障 | 测普通 API、列表、预览更新、队列拥塞和存储故障 | 记录测试环境及结果；达到 §70 目标或列明阻塞问题 |
| P08-05 真实金样 | 完成法国国债主题 8～10 分钟成片及人工质量评审 | 真实 Provider、来源、图表、Custom Motion、字幕、声音及导出均有证据 |
| P08-06 V1 对账 | 对 §77/78、附录 C、§96 V1 条目逐项核对 | 无缺失 MUST，无 Mock 冒充真实成功，无未解释范围偏差 |

内部生产门通过后，才可以称为“V1 可内部生产使用”。

---

## 9. P09—P16：全部后续阶段

### P09：对外 SaaS 与商业运营

前置：P08。  
来源：§17、20、31、35—36、43、47、67、73。

| 任务 | 实施与产物 | 验收 |
|---|---|---|
| P09-01 套餐权益 | 建立版本化 Plan、Entitlement、席位、存储、Pack、BYOK 和渲染优先级 | 所有额度在 API 强制执行；修改套餐不篡改历史账单 |
| P09-02 订阅收款 | 接入 Stripe Checkout、订阅状态、取消及账单入口 | 测试环境覆盖成功、失败、续费、取消、重复和乱序事件 |
| P09-03 Credits 商业化 | 实现充值、赠送、扣减、退款、账单展示及对账 | 支付成功事件只能入账一次；网页跳转不能作为入账依据 |
| P09-04 团队与隐私 | 实现邀请、席位变更、角色管理、隐私模式和连接管理 | 撤销成员后访问立即受限；降级套餐有清晰超额处理 |
| P09-05 SaaS 安全运营 | 加入恶意文件扫描、滥用处理、完整 Admin 和支持工具 | 所有运营动作可审计；支持人员不能无痕访问私密内容 |
| P09-06 商业上线门 | 核验 Provider 集成条款、Remotion 授权、主体、正式支付及政策文档 | 所需外部条件完成后才能开启正式收款和公开注册 |

订阅状态通过服务端事件同步，商业上线不依赖用户返回成功页面。[Stripe 订阅文档](https://docs.stripe.com/billing/subscriptions/overview)。

### P10：输入、声音、素材和输出增强

前置：P08；不依赖正式收款。  
来源：§4、6、10、62、65、84—85、89、91、95。

| 任务 | 实施与产物 | 验收 |
|---|---|---|
| P10-01 文档输入 | 实现 Markdown、PDF、DOCX 和 Newsletter 内容导入，保留表格与出处 | 错误文件、扫描 PDF、缺页、嵌入对象有明确处理；不伪造提取成功 |
| P10-02 Voice Clone | 实现录音/上传、音质检测、Consent、Provider 验证、Instant/Professional 状态 | 未授权不提交；训练失败可恢复；退休、平台解绑、Provider 删除可区分 |
| P10-03 其他 Provider | 完成 Runway、ImageGenerationProvider、AssetSearchProvider 的真实接入 | 相同公共契约测试通过；搜索素材有许可状态，生成图不冒充证据 |
| P10-04 组件扩展 | 补齐 Host 变体、数值对比、面积/堆叠图、Process、Map Flow/Zoom、实体及布局变体 | §10 各类型有实现或明确 Pack 归属；不以不相关组件静默代替 |
| P10-05 输出增强 | 4K、封面、标题、Description、Chapters、Source List | 编码参数、授权署名、章节时间与正式版本一致 |
| P10-06 检索迁移 | 搜 Project/Scene/Source/Asset/Component；导出 Graph 和有权导出的原素材 Bundle | 搜索遵守租户和删除状态；Bundle 无 Secret，缺权素材明确列出 |

退出条件：所有增强功能各自独立验收，不要求一次发布全部入口。

### P11：Content Core 与官方 Pack 运行基础

前置：P08、P01-06。  
来源：§92—93、96。

| 任务 | 实施与产物 | 验收 |
|---|---|---|
| P11-01 ContentCore | 将 V1 内容结构无损转换为 Thesis、Claims、Facts、Relations、Evidence 等核心模型 | 旧项目迁移前后来源与关键事实一致，保留原文档 |
| P11-02 Atom/Recipe | 实现稳定 ContentAtom、ChannelRecipe、版本关系及 Channel Fit | Atom 可独立追溯来源；不适合某渠道时可返回 NOT_RECOMMENDED |
| P11-03 官方 Pack | 实现注册、启用、版本锁定、权益检查及受限 PluginContext | Pack 通过公开契约工作，不直接访问核心数据库或 Secret |
| P11-04 派生血缘 | Artifact 记录 Core/Atom/Recipe/Plugin/ProjectVersion 来源 | 更新 Core 仅提示派生内容过期，不覆盖已批准产物 |

退出条件：后续内容形态可以通过 Pack 扩展，不增加 Core 中的平台硬编码分支。

### P12：Shorts、Social、Text、多语言与 Podcast

前置：P11。  
来源：§3.2、4.2、64.6、92—93。

| 任务 | 实施与产物 | 验收 |
|---|---|---|
| P12-01 Shorts Pack | 从 Atom 选择主题、重写 Hook、生成 9:16 派生 Graph、重新布局和字幕 | 短片可独立理解；来源保留；竖屏安全区正确；原长视频不被修改 |
| P12-02 Social Visual | 生成 1:1、4:5、Carousel 和信息图 Artifact | 页序、图表、署名、长文本和平台尺寸符合 Recipe |
| P12-03 Text Pack | 生成 Thread、短文、Newsletter 和平台文案 | 引用和事实不丢失；平台长度限制由 Recipe 校验 |
| P12-04 多语言 | 翻译脚本、术语词典、重新 TTS/对齐/字幕及派生版本 | 不复用原语言时间戳；数字、实体和引用一致 |
| P12-05 Podcast | 从内容核心生成适合纯音频的叙事和混音 | 去除依赖“看屏幕”的表达；音频元数据、章节和授权完整 |

共同退出条件：每种 Pack 都有 analyze、generate、validate 的完整链路及独立测试。

### P13：Publishing、Handoff 与 CMS

前置：P11；发布视频还需对应产物已经批准。  
来源：§42、60、88、90、96。

| 任务 | 实施与产物 | 验收 |
|---|---|---|
| P13-01 发布核心 | 建立 Publication、OAuth 连接、能力分级、验证、调度、回调和状态查询 | 未批准版本不能发布；重复请求只形成一个逻辑发布 |
| P13-02 YouTube | 使用官方 API 建立参考实现，包括上传、元数据、状态和可用的排期能力 | 在获得授权的测试账号验证远端结果；超时恢复不重复创建 |
| P13-03 其他平台 | 分别核验 TikTok、抖音、Bilibili、LinkedIn、X；建立独立 Adapter 或明确 P4 | 不假设每个平台支持相同能力；UI 与真实 capability 一致 |
| P13-04 P3/P4 体验 | 实现 Send to Draft、Export Package、封面、文案、披露、平台清单 | Draft 不显示为 Published；P4 包完整并明确最后一步由用户完成 |
| P13-05 Handoff | 建立可撤销、限时、绑定账号与 Artifact 的 Handoff 记录 | Web 可创建、取消和查看交接状态；跨租户或过期访问失败 |
| P13-06 CMS 输入 | RSS、CMS Webhook、文章发布事件、机器创建项目及幂等 | 同一 CMS 事件重放不重复建项目；正文变化产生新来源版本 |
| P13-07 CMS 回写 | 视频就绪后发送签名回调，保存尝试、响应和重试记录 | 回写失败不影响成片；重复回调可安全处理；URL 遵守 SSRF 规则 |

发布幂等键固定包含：

```text
platform
account
projectVersion
outputAsset
```

结果未知时先查询和对账，不自动重发。核心产品禁止使用浏览器自动化模拟可靠发布能力。

### P14：Analytics Director 与 Finance Pack

前置：P11；Analytics 依赖 P13 中可提供数据的平台。  
来源：§41、62、65、81、92—93。

| 任务 | 实施与产物 | 验收 |
|---|---|---|
| P14-01 数据采集 | 获取发布表现、CTR、观看时长、留存，记录平台和采样口径 | 缺失数据保持未知，不写成零；撤销授权后停止采集 |
| P14-02 Scene 归因 | 将表现时间映射至发布时的固定 Graph；保存派生关系 | 时间归因正确；不把相关性标成因果结论 |
| P14-03 学习建议 | 生成可解释的节奏、场景类型和 Avatar 比例建议 | 用户可查看、关闭、接受和恢复；不会静默改变 Channel |
| P14-04 Finance Pack | 实现 Candle、Yield Curve、Policy Path、Supply Chain、Trade Route、Scenario Tree 等行业能力 | 单位、币种、时区、调整口径和来源可追溯；缺数据不能编造 |
| P14-05 数据与模板 | 接入许可允许的数据源，建设版本化行业模板 | 数据许可随资产保存；模板变更不改变历史项目 |

V1 已有的 Spread、基础图表和地图继续属于 Core，不迁移成强制付费依赖。

### P15：Windows/macOS 与 iOS/Android

前置：P08；Handoff 依赖 P13-05。  
来源：§29—30、61、63—64、78、42.3。

| 任务 | 实施与产物 | 验收 |
|---|---|---|
| P15-01 Desktop 壳 | Tauri、Vite、共享 React 编辑组件及 SDK，系统浏览器登录 | Windows/macOS 均连接同一后端；无复制的业务服务 |
| P15-02 Desktop 文件 | 文件拖拽、批量直传、下载、缓存、快捷键和通知 | 大文件不经 Web/API 中转；缓存按账号隔离、退出可清理 |
| P15-03 Desktop 发布 | 安装包、签名、更新及回滚说明 | 两个系统完成安装、升级、卸载及旧版客户端兼容测试 |
| P15-04 Mobile 工作区 | Expo/RN 实现项目、脚本、分镜、视频预览、AI 修改和轻编辑 | 使用同一 SDK；手机不复制完整 Timeline 或 Provider 逻辑 |
| P15-05 Mobile 任务 | 审批、Final 请求、状态、下载、推送与安全会话 | 后台恢复后状态一致；推送不包含敏感正文 |
| P15-06 Mobile Handoff | 接收交接、下载素材、保存、复制文案、打开目标平台 | 不能把打开平台视为发布成功；失败可重试，撤销立即生效 |
| P15-07 多端一致性 | Web、桌面、手机同时编辑与恢复 | 同字段冲突明确提示；不同 Scene 修改遵守统一并发协议 |
| P15-08 商店交付 | iOS/Android 构建、权限说明、签名、测试分发和提审材料 | 两平台真机验证；未获商店批准不得标记公开发行完成 |

手机首期使用服务端 Draft 视频预览；Remotion React Player 不直接当作 React Native 原生组件复用。

完整离线编辑和 Local RenderProvider 保持独立后续能力，不影响本阶段在线客户端交付。

### P16：Marketplace 与 Enterprise

前置：Marketplace 依赖 P11；Enterprise 依赖 P09。两条路线可独立推进。  
来源：§20、47、74、92、95。

| 任务 | 实施与产物 | 验收 |
|---|---|---|
| P16-01 插件包格式 | 定义插件 ID、版本、签名、兼容版本、能力和依赖清单 | 格式错误、签名错误、版本不兼容时拒绝安装 |
| P16-02 插件执行隔离 | 第三方插件通过受限 RPC 和 Capability Broker 访问内容、资产和 Provider | 无直接 DB/Secret；越权调用、网络和资源超限被拒 |
| P16-03 插件生命周期 | 安装、授权、升级、禁用、撤销、版本固定及回滚 | 撤销后新调用停止；历史 Artifact 仍可追溯 |
| P16-04 Marketplace 商业 | 商品、购买、权益、退款、分成账本和结算导出 | 重复事件不重复入账；分成规则版本化，不修改历史结算 |
| P16-05 Enterprise 身份 | SSO/SAML、SCIM、企业成员生命周期 | 停用成员后会话及权限失效；普通租户不可修改企业配置 |
| P16-06 Enterprise 治理 | 审批策略、职责分离、Audit Export、专用凭据 | 审批与操作人约束在 API 强制执行；审计不可静默更改 |
| P16-07 企业部署策略 | 客户存储、地区策略、专用 Compute、受限 Provider 路由 | 请求和任务确实按策略执行；不满足地域或隐私条件时失败关闭 |
| P16-08 隐私生命周期 | 身份退休、Provider 删除请求、历史引用及保留证明 | 平台解绑和 Provider 删除状态可分别追踪；失败可审计 |
| P16-09 容量演进 | 依据已测瓶颈增加 RenderProvider、专用分析存储或工作流实现 | 新实现通过原契约测试；核心业务与客户端不改接口 |

Marketplace 正式结算和 Enterprise 承诺需要有效外部账户、合同及部署配置。缺少这些输入时可以完成测试实现，但状态必须保持未完成正式上线验证。

---

## 10. API 增补清单

保留规范 §32 的资源接口，并统一到 `/api/v1`。补齐以下能力，避免模型只实现页面而遗漏公共 API。

| 能力 | 必须具备的接口行为 |
|---|---|
| 项目操作 | 批量结构化操作、冲突检查、Undo/Redo |
| Change Plan | 创建、查询、预览、应用、拒绝 |
| Identity | 查询、绑定、版本、退休、Provider 删除状态 |
| Voice Clone | 提交、状态、验证、试听、失败恢复 |
| 来源与数据 | 来源快照、结构化数据、Claim/Citation 绑定 |
| Render | 估算、冻结输入、开始、状态、取消、QA、批准、下载 |
| Provider | Catalog、连接、连接测试、能力状态 |
| Usage | 成本、Credits、预留、预算、使用明细 |
| 运营 | 失败任务、对账、人工恢复、审计 |
| Packs | 注册能力、启用、计划、生成、Artifact |
| Publishing | 连接、验证、发布、Draft、状态、取消、Export Package |
| Handoff | 创建、接收、撤销、完成状态 |
| CMS | 事件接收、机器创建、回写状态 |
| Analytics | 拉取任务、固定版本指标、建议及应用 |
| Enterprise | 身份同步、审批策略、审计导出和租户策略 |

长任务返回 `202 + jobId/workflowId`，不得等待视频生成结束再返回。

事件至少携带：

```text
eventId
eventType
workspaceId
resourceId
resourceRevision
occurredAt
payload
```

SSE 是通知通道；断线恢复后的权威状态仍通过 API 查询。

---

## 11. 测试体系与阶段门

### 11.1 统一命令入口

P00 必须建立以下命令；它们是计划要求，当前仓库尚不存在：

```text
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:contract
pnpm test:integration
pnpm test:e2e
pnpm test:security
pnpm test:render
pnpm test:golden
pnpm test:provider-smoke
pnpm build
pnpm verify
```

要求：

- `verify` 默认不产生真实 Provider 费用。
- 真实 smoke 单独开启，并要求凭据及预算配置。
- 测试失败不得通过删除断言或扩大阈值掩盖。
- 不相关改动无需重跑所有昂贵测试；阶段门执行完整规定集合。

### 11.2 必须覆盖的高风险测试

| 编号 | 场景 | 预期 |
|---|---|---|
| AC-01 | 跨租户访问 Project/Asset/Job/SSE | 全部拒绝 |
| AC-02 | 同一生成请求并发提交 20 次 | 一个逻辑生成，最多一次有效付费提交 |
| AC-03 | 同幂等键不同请求体 | 明确冲突 |
| AC-04 | 同 Scene 同 revision 并发编辑 | 一个成功，另一个冲突 |
| AC-05 | 旧 Provider 结果迟到 | 保存结果，不覆盖新内容 |
| AC-06 | DB 提交后、消息投递前崩溃 | Outbox 恢复任务 |
| AC-07 | Provider 已接收但客户端超时 | 对账，不盲目重付费 |
| AC-08 | 回调重复、乱序、伪造 | 合法事件只生效一次 |
| AC-09 | 回收下载失败 | 重试回收，不重新生成 |
| AC-10 | Provider 临时 URL 到期 | 已持久化项目仍正常播放 |
| AC-11 | 并发触及预算上限 | 原子预留，不超额 |
| AC-12 | 改标题或 Crop | 不触发 TTS、Avatar、AI Video 重生成 |
| AC-13 | 修改一句旁白 | 仅必要音频及依赖重建 |
| AC-14 | Lock 与 AI 改写冲突 | 明确提示，不静默修改 |
| AC-15 | 缺失图表数据 | 降级或要求补充，不编造 |
| AC-16 | Final 含占位或缺资产 | 渲染前拒绝 |
| AC-17 | QA 失败或版本未批准 | 不能正式导出或发布 |
| AC-18 | Custom Motion 越权/超时 | 沙箱拒绝并清理 |
| AC-19 | Restore 历史版本 | 新 revision，历史费用不变 |
| AC-20 | 删除/恢复/GC 重入 | 不误删共享资产 |
| AC-21 | 支付回调重复 | Credits 只入账一次 |
| AC-22 | 发布成功后网络超时 | 不产生重复远端视频 |
| AC-23 | 插件权限撤销 | 后续能力调用立即被拒 |
| AC-24 | 多端同时编辑 | 遵守同一服务器并发协议 |

### 11.3 画面与内容验收

Golden Fixture 每次与相关 Director、时序或组件修改关联运行：

- 图表数字、单位、来源准确。
- 中文长标题、人名、英文缩写不溢出。
- Avatar、图表和来源卡的切换合理。
- Master Audio 没有重复、漏句和明显拼接异常。
- 字幕与发言对应。
- 关键数值 cue 与动画匹配。
- AI Video 占比符合配置。
- Custom Motion 不泄漏资源或越权。
- 成片经人工完整观看，记录问题和结论。

自动测试通过不能替代完整长视频的人工质量评审。

### 11.4 发布门

| 门 | 条件 |
|---|---|
| G0 工程可开发 | P00 通过 |
| G1 数据可信 | P01—P03 通过 |
| G2 Draft 可编辑 | P04—P05 通过 |
| G3 真实生产链路 | P06—P07 通过 |
| G4 内部生产可用 | P08 与 V1 追踪矩阵全部通过 |
| G5 商业运营可用 | P09 的技术与外部条件全部通过 |
| G6 Pack 可用 | 每个 Pack 独立通过，不互相捆绑 |
| G7 原生客户端可用 | 对应系统真机、签名和分发验证完成 |
| G8 全规范覆盖 | 所有原规范条目均已实现或获得明确的范围变更决定 |

---

## 12. 需求覆盖索引

| 需求领域 | 规范章节 | 主要阶段 |
|---|---|---|
| 产品原则、输入输出、界面 | 0—5、64—66、75—82 | P00、P04—P08、P10 |
| 身份、声音、Speech | 6、13、94—95 | P01、P06、P10 |
| 内容、叙事、导演、视觉 | 7—12、37—40、52—59 | P04—P07、P10 |
| Provider 与异步 | 14—19、45—46、55、69、71、83、89 | P03、P06、P10 |
| 隐私、数据、存储和历史 | 20—28、40、43、72、84—85 | P01—P03、P08 |
| 多端 API 与认证 | 29—34、61、63、78 | P01—P03、P15 |
| 用量、费用和商业 | 25、35—36、47、67—68、73 | P03、P08—P09 |
| 测试、性能和质量 | 44、51、70、76—80、86—87 | 全阶段，P08 总验收 |
| 发布与 CMS | 42、60、88、90 | P01 契约、P13、P15 Handoff |
| 搜索与可迁移性 | 62、91 | P10 |
| 扩展、内容核心、Packs | 92—93、96 | P01 契约、P11—P14 |
| Analytics 与长期资产 | 41、81 | P14 |
| Enterprise | 20、74、95 | P16 |
| 全局架构优先级 | 97、附录 B | 全阶段 |
| 验收清单 | 附录 C、96 | P00 逐项建账，阶段门逐项关闭 |
| 外部能力参考 | 附录 A | P06、P09、P10、P13 接入时重新核验 |

---

## 13. 并行开发、迁移与模型交接

### 13.1 并行边界

允许并行：

- 公共契约冻结后，标准组件与后端基础。
- Provider Mock 与 Web 状态界面。
- 不同标准组件。
- 不同 Provider Adapter。
- P11 完成后的不同官方 Pack。
- Desktop 与 Mobile。
- Marketplace 与 Enterprise。

必须串行或协调：

- 公共 Schema 变更。
- 数据库迁移编号。
- revision 与操作语义。
- 费用账本。
- 共享状态机。
- 对同一 SceneGraph 的格式升级。

同一轮只指定一个公共契约负责人，避免多个模型同时修改同一协议。

### 13.2 数据迁移

- 新字段优先采用兼容性新增。
- 数据回填可中断、可重试并记录进度。
- 旧客户端至少在约定兼容窗口内继续工作。
- 删除字段必须先停止写入，再完成迁移，最后删除。
- 不在生产直接执行可能丢数据的 ORM 同步操作。
- SceneGraph 历史版本通过显式迁移器读取，不在读取时静默覆写。
- Provider、组件和 Prompt 升级不自动重生成历史项目。

### 13.3 部署与回滚

- 每次部署记录应用版本、迁移版本、组件版本和配置版本。
- Worker 升级先停止领取新任务，再处理或释放现有租约。
- 回滚应用之前检查数据库兼容性。
- 账本和已发生的外部生成通过补偿记录处理，不能数据库回滚抹除。
- 新 Provider、Pack 和昂贵能力均可通过服务端开关关闭。
- 关闭能力不能破坏已经保存的资产和历史版本。

### 13.4 每次交接必填内容

```text
当前阶段：
当前任务：
任务状态：

本次已经完成：
本次修改的文件：
契约／数据库变化：

执行的检查：
检查结果：
验收证据：

使用 Mock 的位置：
真实 Provider 验证情况：
未解决失败：
外部阻塞：

下一项任务：
下一项任务前置条件：
下一项任务建议读取内容：
```

不得只写“已完成基础框架”“核心功能已实现”或“后续补测试”。

### 13.5 下一模型启动步骤

1. 阅读原规范 §0、§2、§75—79、§92—97。
2. 阅读本计划的范围裁决、技术基线、公共契约和当前阶段。
3. 检查仓库真实状态及最新交接记录。
4. 选择编号最小、依赖已完成的未验证任务。
5. 检查该任务相关代码和测试，不重复初始化已有工程。
6. 按 contracts → migration → domain → API → SDK → UI → tests/docs 推进。
7. 完成验收证据后更新任务状态和交接记录。
8. 如果外部凭据阻塞，只阻塞真实验证，继续完成不依赖凭据的实现和测试。
9. 未通过阶段门时，不进入依赖该阶段的正式交付。

本项目的第一项执行任务为 **P00-01：建立需求追踪与裁决记录**。
