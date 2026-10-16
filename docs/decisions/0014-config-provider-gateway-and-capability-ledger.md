# 0014 配置统一、Provider 实现种类与生产守卫、短期凭证校验、能力覆盖账本生成器

- 状态：生效（2026-10-11，V5-M3）
- 前一裁决编号：`0013-op-log-authority-and-projections.md`
- 来源：`docs/V05/ANCS_v0.5_Architecture.md` §4、§10.1、§11.3、§15、§20 M3；代码审查 `docs/reviews/v04-code-review-20261011.md` P1-4、R-4、R-5、§3.2—§3.4

## 决定

1. **配置只在进程入口读取与校验，然后注入。**
   - 业务包（domain、contracts、kernel、time、sdk、extensions、scene-components、remotion-core）不得读取 `process.env`：arch-check **R12**。
   - 部署策略（当前为未订阅工作区默认套餐）由入口 `configureDeploymentPolicy` 一次性注入，领域层读 `deploymentPolicy()`；非法值在启动期失败，不再在请求期抛 500。
   - `validateEnv` 把空白值视为未配置（`.env.example` 的空行、`VAR=`）。
   - 新增/收紧的配置：`ANCS_VOICE_SESSION_SECRET`（≥32，入 API schema 并由入口注入，不再由 server.ts 直读）；Worker 的租约/心跳/轮询间隔带上下界（心跳必须短于租约）；`retention:sweep` CLI 使用 `retentionCliEnvSchema`。
   - **生产额外必填**：`ANCS_STORAGE_SECRET`（API、Worker、清理 CLI 同一把；不得从会话密钥派生）、Worker 的 `ANCS_CREDENTIAL_KEYS`。
   - 存储签名密钥与公开基址只有一个实现：`localStorageOptionsFromEnv` / `deriveStorageSigningSecret`（`@ancs/providers-storage-local`）。Worker 不再在 `BETTER_AUTH_URL` 已配置时把签名 URL 固定为 `localhost:3001`。
   - `ANCS_PLATFORM_PROVIDER_KEYS` 为唯一名称；`.env.example` 曾写的 `PLATFORM_PROVIDER_KEYS` 从未被读取——现配置即启动失败并提示改名。
   - `DomainDeps` 移到 `packages/domain/src/deps.ts`（`channels.ts` 保留兼容再导出）。
2. **Worker 子进程环境白名单**：渲染执行器、Motion 验证器、媒体探测与 FFmpeg 子进程只继承平台必需项（`PATH`、`HOME`、临时目录、语言、Windows 启动项）与 `REMOTION_*`、`ANCS_FFMPEG_PATH`、`ANCS_FFPROBE_PATH`；不再继承数据库连接串、会话/存储/凭据密钥与 Provider Key（`apps/worker/src/child-env.ts`）。运维配置的分析器可执行文件（ASR/视觉/音频分析 `process` 驱动）仍继承环境，因为它们可能需要自己的凭据。
3. **Provider 实现种类显式化**（`@ancs/contracts` `provider-kind.ts`）：每个装配的外部能力驱动声明 `REAL | MOCK | SCRIPTED`。生产进程装配非 REAL 驱动必须显式 `ANCS_ALLOW_MOCK_PROVIDERS=1`，否则 API/Worker 启动失败并列出全部非真实驱动；装配清单经 `/api/v1/capabilities` 的 `providers` 字段报告（不含凭据）。现状：API 的 LLM、TTS、声音克隆、素材搜索、分发均为 MOCK，因此生产 API 目前必须显式许可才能启动——这是有意的。
4. **Deepgram 进入 Worker 正式路径**：`ANCS_ASR_DRIVER = process | deepgram`，`deepgram` 缺 `DEEPGRAM_API_KEY` 启动失败（不回退 Mock）。付费调用不自动重试：转写任务 `maxAttempts = 1`，失败后由用户显式重跑。词级时间沿用显式有理时基 `1/1000`（Deepgram 自身精度约 10 ms，M0 后已无"整毫秒假设"耦合）。
5. **语音会话短期凭证真正被校验**：`verifyVoiceSessionCredential` 由会话行重算签名并恒定时间比较，凭证只对签发它的会话与代际有效；伪造/缺失/会话不存在一律 401 `VOICE_CREDENTIAL_INVALID`（不区分原因），签名有效后撤销/关闭/过期为 409。新端点 `POST /api/v1/voice-sessions/:sessionId/stream-events` 只凭 `X-Voice-Session-Token` 接受流式事件（作用域取自会话本身）；凭证不能代替用户身份调用封存/关闭等端点。凭证头在日志中脱敏。
6. **编辑能力覆盖账本由生成器产出**：`scripts/capability-ledger.mjs` 从 `EDIT_OPERATION_V2_REGISTRY`、`EDIT_OPERATION_REGISTRY`、`KERNEL_TIMELINE_OPERATIONS` 与测试引用生成 `docs/requirements/generated/edit-capability-coverage.md`；`pnpm capabilities:check`（已入 `pnpm verify`）校验生成物与源一致，并强制"原生"声明规则：NATIVE = 规范操作 ACTIVE + 编辑内核执行 + 至少一个内核单测与一个集成测试；别名与计划项不计为原生；内核不得执行非 ACTIVE 操作。首次运行即发现 `set_clip_transform`、`move_track` 声明为 NATIVE 却没有内核单测，已补齐。

## 重新排期（刻意的决定）

- **工作流引擎**移至 M4，与其首个使用者 `FinalRender`（分段执行、失败段重跑、不重做已成功段）一并交付。现有可外部调用的流程（转写、分析、渲染）都深度绑定任务表与分析阶段图，在没有真实使用者的情况下先造通用引擎属于投机抽象；M4 以 FinalRender 驱动其设计与验证，再迁移转写等流程。
- **Provider Gateway 的路由、预算预留/对账与计量**随工作流引擎在 M4 交付（它们只能作为工作流步骤存在）。M3 已交付其中的"实现种类显式化 + 生产禁 Mock"与"付费调用不自动重试"。
- **`defineCapability` 单一源**（Agent 工具清单、GUI 命令表、OpenAPI/SDK 生成）移至 M5，与 Agent 运行时一起交付；当前仓库没有 Agent 工具清单可供生成或比对。M3 的生成器先把"覆盖统计不得手写"落实到编辑能力。

## 未纳入（明确的后续工作）

- 界面 Mock 标识（Web 读取 `/capabilities.providers`）属于 UI 任务，需按 UI 交付规约完成；产物级 `providerKind` 字段（生成结果、语音、发布记录逐条携带）未做。
- 首个 `VERIFIED_REAL`（ASR）需要真实 Deepgram Key 经 Worker 正式路径跑通一段真实源媒体（含 MP4 容器）；本环境无 Key，未执行，不得据启动测试或单元测试宣称已验证。
- 语音会话凭证端点的 SDK 方法：实时通道由 M5 的 Realtime Gateway 使用，当前 SDK（用户会话客户端）不适用。
