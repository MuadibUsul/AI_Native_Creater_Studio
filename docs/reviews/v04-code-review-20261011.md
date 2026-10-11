# ANCS v0.4 代码与交付审查（2026-10-11）

> 范围：`codex/v04-foundation` 分支 HEAD `2a2e79d`。只读审查，**本文件不改任何代码**；所有结论附 `文件:行` 以便复核。
> 与 `docs/decisions/0010-review-response-20261010.md` 的关系：0010 已处理的项（意图识别、沙箱 env、凭据密钥强制、DNS rebinding、ZIP/PDF 上限、FFmpeg 协议白名单、仓库卫生）不再重复；0010 列为"剩余项"且**至今仍未处理**的，在 §5 汇总跟踪。本文其余条目均为本次新发现。

## 0. 基线（本机实测）

| 检查 | 结果 | 备注 |
|---|---|---|
| `pnpm install --frozen-lockfile` | 通过 | |
| `pnpm typecheck` | 通过 | |
| `pnpm lint` | 0 error / 1 warning | `apps/web/src/ui/VoiceCaptureControl.test.tsx:25` 无用的 `eslint-disable` |
| `pnpm test:unit` | 85 文件 / 601 用例全绿 | 耗时 61 s，其中 import 占 72%（见 §4.6） |
| `pnpm arch:check`（单独执行） | **失败** `MODULE_NOT_FOUND` | 依赖先 `build` 出 `dist/cli.js`；只在 `pnpm verify` 顺序里能跑（见 §4.7） |
| integration / security / render | 未跑 | 需 Postgres/Redis/FFmpeg |

严重度：**P0** = 会导致错误结果/安全问题且可在正常使用中触发；**P1** = 影响需求达成或在可预见场景下出错；**P2** = 工程质量/可维护性/性能；**P3** = 卫生。

---

## 1. 正确性缺陷（Bug）

### P0-1 有理时基 → "整数毫秒"转换在非毫秒对齐时间上直接抛异常

- 位置：`packages/contracts/src/common/media-time.ts:150-159`（`mediaTimeToLegacyMilliseconds`，非整毫秒即 `RangeError`）。
- 实测（临时 vitest 探针，已删除）：
  - `{ticks:'1001', timebase:1/30000}`（29.97fps 的一帧）→ **抛异常**
  - `{ticks:'1', timebase:1/48000}`（一个音频采样）→ **抛异常**
  - `{ticks:'512', timebase:1/15360}`（ffprobe 真实素材常见时基）→ **抛异常**
- 受影响的 v0.4 主路径：
  - `packages/domain/src/proposals.ts:594-597` 试改结果 `clipRanges` → 任一片段落在非整毫秒边界时，试改被 `catch` 成 **422 TRIAL_FAILED**，提案无法预览/采用（N06-01/02/04/05/07 全链路）。
  - `packages/domain/src/range-edit.ts:41-43` `msOf` → 范围编辑规划（N03-09）直接异常。
  - `apps/web/src/playback/media-element-backend.ts:62` `secondsOf` → 浏览器播放 seek 时抛错（N03-11/N03-16）。
- 为何测试没抓到：现有用例几乎全部使用 `timebase 1/1000`（见 `packages/contracts/src/edits.test.ts:139` 等）。v0.4 已明确"整数毫秒权威时间"被有理时基覆盖（AGENTS.md 启动步骤 2），但约 50 处 legacy 转换引用（14 个文件）仍在权威/准权威路径上。
- 建议：
  1. 展示/日志用途改用**不抛异常**的有理 → 浮点秒（或四舍五入毫秒并标注 `approximate: true`）；权威计算一律留在 `MediaTime`/BigInt。
  2. 试改结果契约 `proposalTrialSchema.clipRanges` 改为直接回传 `MediaRange`（ms 字段降为派生展示字段）。
  3. 新增属性测试：随机 `timebase ∈ {1/1000, 1001/30000, 1/48000, 1/15360, 1/90000}` 跑 split/trim/trial/range-edit 全路径。
  4. `mediaTimeToLegacyMilliseconds` 加 `@deprecated` 并在 lint 规则中禁止新调用（仅迁移层允许）。

### P0-2 资产清理（retention sweep）未检查 v0.4 时间线引用，可能让整轮清理中断且永久卡住

- 位置：`packages/domain/src/retention.ts:397-414`（`purgeAssetRow`）。
- 引用检查只覆盖：旧 Scene 绑定（`:282`）、版本快照文本匹配（`:294`）、派生边（`:311`）。**未检查** `sequence_clips.asset_version_id`（`packages/db/src/schema/composition.ts:62`，`onDelete: 'restrict'`）以及 relink 表的 `restrict` 外键（`packages/db/src/schema/assets.ts:118-121`）。
- 后果：删除 `assets` → 级联删 `asset_versions` → 撞上 `sequence_clips` 的 restrict 外键 → 异常从 `runRetentionSweep` 冒出、**整轮清理中止**。由于候选按 `deletedAt asc` 排序取前 `limit` 条，同一条资产每轮都排在最前，形成**队头阻塞**，后续所有到期资产（包括隐私删除请求，§4 步骤）永远得不到处理 —— 隐私删除是合规义务。
- 另：引用检查在事务**外**执行（`:398-401`），检查与删除之间存在 TOCTOU 窗口。
- 建议：
  1. 引用检查补齐 `sequence_clips`、`composition_*`（视觉对象/音频区域等引用资产的列）、relink 表；更稳妥的做法是**以外键为准**：在事务内 `delete`，捕获 FK 违约（`23503`）→ 计为 `skipped`，而非抛出。
  2. 引用检查移入同一事务（`FOR UPDATE` 之后）。
  3. 单条失败不得中断整轮：逐条 `try/catch` 并计数 `failed`。

### P1-1 TTL 到期资产扫描存在饥饿

- 位置：`packages/domain/src/retention.ts:519-534`。查询取"**所有未删除资产**中最旧的 `limit*4` 条"，再在内存里按 `retentionClass` 过滤。
- 一旦最旧的 `4×limit` 条都是永久类资产（正常情况：用户原素材通常最早上传），`DRAFT_RENDER_30D` 等缓存类资产**永远进不了候选窗口**，存储只增不减。
- 建议：把保留类过滤下推到 SQL（`where retention_class in (...TTL 类) and created_at < cutoff(class)`），并为 `(retention_class, created_at)` 建索引。

### P1-2 幂等作用域用路由模板而非实际路径，跨资源可错误回放

- 位置：`apps/api/src/plugins/idempotency.ts:47`：`scope = user:{id}:{method}:{routeOptions.url}`，`requestHash` 只哈希 body（`:48`）。
- 场景：同一用户用同一幂等键先 `DELETE /projects/A`、再 `DELETE /projects/B`（body 均为空，哈希相同）→ 第二个请求**直接回放 A 的 2xx 响应**，B 未被删除，但客户端以为成功。`POST /projects/:id/edits` 等同理（客户端重用键或 SDK 生成策略缺陷时触发）。
- 同文件其他问题：
  - `:88` 非字符串 payload（Buffer/Stream）直接 `return`，记录永久停在 `statusCode=null`，之后同键请求永远 409"仍在处理中"。
  - 进程在请求中途崩溃同样留下永久"处理中"行；没有处理中超时/租约。
- 建议：哈希改为 `method + 实际 URL（含 params/query）+ body`；为处理中行加 `lockedUntil`，过期可被接管；非字符串 payload 也要落终态（或显式删除记录）。

### P1-3 Webhook 验签不是恒定时间比较

- 位置：`packages/domain/src/results.ts:82-84`：`a.every((byte, i) => byte === b[i])` 在首个不同字节即短路，存在计时侧信道。同仓库其他地方（`packages/providers/storage-local/src/index.ts:110`、`mock-payments`）已正确使用 `crypto.timingSafeEqual`。
- 建议：改为 `timingSafeEqual`，并补一条"等长不同签名被拒"的单测。

### P1-4 语音会话"短期凭证"签发后从未被校验

- 位置：`packages/domain/src/voice-session.ts:70-80` 签发 HMAC token；全仓检索 `credentialFingerprint` / `EPHEMERAL_SESSION` 只出现在签发与存储处，**没有任何端点接受或验证该 token**（事件追加与封存仍走 Cookie/Bearer + `requireWorkspace`）。
- 影响：N05-01 验收里"短期凭证 / 过期撤销"在功能上是装饰性的；真接 WebRTC/sideband 时若直接把它当作"已有能力"会出现安全空洞。
- 另：`ANCS_VOICE_SESSION_SECRET` 不在 `apiEnvSchema` 里，而是 `apps/api/src/server.ts:221-228` 直接读 `process.env`，绕过了启动期 fail-closed 校验，`apps/api/src/index.ts` 也未注入。
- 建议：把签名密钥纳入 env schema 并由 `index.ts` 注入；新增 token 校验函数（`timingSafeEqual` + 过期 + generation + 撤销）并在流式通道入口强制；在台账中注明当前仅有"签发"。

### P1-5 试改（trial）把所有异常都翻译成 422，并把内部错误信息回给客户端

- 位置：`packages/domain/src/proposals.ts:606-613`（同模式还有 `:767`）。数据库断连、死锁、编程错误都会变成 `422 VALIDATION_FAILED`，客户端会把"服务端故障"误判为"提案不合法"；`cause: error.message.slice(0,200)` 可能泄漏 SQL/约束名等内部细节（与 `error-handler.ts` "5xx 不泄漏" 的约定冲突）。
- 建议：只把 `ApiFailure`（业务拒绝）映射为 422；其他异常原样抛出走 500 统一信封；`cause` 只放稳定的错误码。

### P1-6 试改在真实事务中执行，持锁时间长且与正式编辑互斥

- 位置：`packages/domain/src/proposals.ts:562-606`。`processEdits` 在事务内会对项目/片段做条件更新（行锁），试改期间同项目的正式编辑被阻塞；若将来 `processEdits` 内出现任何非数据库副作用（队列投递、存储写入），回滚无法撤销。
- 建议：为试改设置 `SET LOCAL statement_timeout / lock_timeout`；在 `processEdits` 增加 `dryRun` 标志，禁止事务外副作用；或改为在纯函数编辑内核上跑（见 §3.1）。

### P2-1 资产快照引用使用 `LIKE '%id%'` 全表文本扫描

- 位置：`packages/domain/src/retention.ts:305`。`_` 在 LIKE 中是通配符（资产 ID 形如 `ast_xxx`），只会误报（保守），但对 `project_versions.snapshot::text` 做全量扫描，随历史增长线性变慢，且每个候选资产各扫一次。
- 建议：快照写入时同时落一张 `project_version_asset_refs(version_id, asset_id)` 关系表并建索引；过渡期至少用 `jsonb_path_exists` 或转义 `_`/`%`。

### P2-2 计算最大事件序号时拉取全部事件行

- 位置：`packages/domain/src/proposals.ts:552-553`、`:615`：`select seq from edit_events where project_id=?` 后在 JS 里 `reduce` 求最大值。`packages/domain/src/versions.ts:155` 已有 `currentEventSeq()`（SQL `max()`），应复用。

---

## 2. 影响需求实现 / 交付口径的问题

### R-1 台账依赖违规：N04-09 已 `VERIFIED`，其依赖 N04-05 仍 `IN_PROGRESS`

- 脚本核对 `docs/requirements/ai-native-v04-acceptance-ledger.md` 全部 219 行（55 行 VERIFIED）：唯一违规为 **N04-09 → N04-05**。AGENTS.md 启动步骤 4 要求"选择依赖已完成的 N 任务"。
- 建议：N04-09 降为 `IN_PROGRESS`（或在裁决文档中明确批准"依赖降级"并写入该行），并把"依赖全部 VERIFIED"做成 CI 检查（见 §4.3）。

### R-2 N06-02 标记 VERIFIED 但没有独立证据与交接文件

- `docs/verification/N06-02.md`、`docs/handoffs/N06-02.md` 均不存在；台账行链接指向 N06-01 的文件。AGENTS.md 要求"每项 N 任务在 `docs/verification/<taskId>.md` 记录证据"。
- 建议：补独立文件（可引用 N06-01 的共享证据，但需逐条映射 N06-02 的验收项）。

### R-3 台账自相矛盾，统计口径漂移

- 同一文件头部长段落中，N06-04 / N06-07 先写 `IN_PROGRESS` 后又写"收口转 VERIFIED"；"当前：…共 55 项"与汇总表中的分组数需要人工相加才能核对。头部单段已超过 20 KB，`docs/handoffs/RUNNING_DELIVERY.md` 达 62 KB。
- 建议：状态以**表格行**为唯一事实源；头部只保留由脚本生成的统计（`scripts/ledger-stats.mjs`），叙述性进展移入各任务的 handoff；把 `VERIFIED_MOCK / VERIFIED_REAL` 作为表格独立列（0010 第 7 条已提出，至今未做）。

### R-4 "首个真实 Provider" Deepgram 适配器未接入运行路径

- `apps/worker/src/deepgram-speech-recognition.ts` 只从 `apps/worker/src/index.ts:11` 导出；`apps/worker/src/main.ts:71` 生产注册仍只有 `createProcessSpeechRecognitionAdapter`（外部可执行文件）。`workerEnvSchema` 没有 `DEEPGRAM_API_KEY`/`ANCS_ASR_DRIVER` 一类配置。
- 因此"真实 ASR 已跑通"目前只是**脚本层证据**，真实 Worker 无法使用它。
- 建议：新增 `ANCS_ASR_DRIVER = process | deepgram`（env schema 校验 + 密钥必填 fail-closed），在 `main.ts` 装配；为 Provider 调用加费用上限与"不自动无限重试"约束（AGENTS.md 禁止事项）。另：`secondsToMsTicks`（`:48-51`）把 Deepgram 秒数四舍五入为毫秒，转写词边界会与 P0-1 的整毫秒假设耦合，建议直接产出有理时基。

### R-5 生产环境仍会静默装配 Mock Provider

- `apps/api/src/index.ts` 中 LLM、TTS、声音克隆、素材搜索均为 Mock，仅 `console.warn`；`apps/api/src/server.ts` 默认装配 `createMockDistributionProvider()`（`publications` 路由）。`crossCheckApiEnv`（`packages/contracts/src/env.ts:118`）只在 `ANCS_SAAS_MODE=live` 时限制收款/存储，**`NODE_ENV=production` + `internal` 模式下 Mock 生成/发布不受限制**。与"Mock 验证通过 ≠ 真实 Provider 验证通过"及 §76-03"不得伪造真实生成成功"的口径冲突。
- 建议：`NODE_ENV=production` 时任何 Mock 驱动需显式 `ANCS_ALLOW_MOCK_PROVIDERS=1` 才能启动；API 响应/作业结果携带 `providerKind: MOCK` 标记，UI 显示徽标。

### R-6 E2E 与契约测试仍是旧 P 系列占位

- `package.json`：`test:contract` 指向 `P03-07`，`test:e2e` 指向 `P05-P08`，都是 `[PLANNED]`。v0.4 多个任务的证据写"真实浏览器 E2E 抓出缺陷"，但这些浏览器脚本不在 `pnpm verify` 中，无法回归。
- 建议：把已存在的 Playwright 脚本（`scripts/quiet-frame-*`、`scripts/playback-sync/*`）收编为 `test:e2e`（v0.4 N 任务编号），至少覆盖"导入 → 选区 → 提案试改 → 采用 → 撤销"一条主链。

### R-7 Web 端实现与后端严重不对称

- 后端非测试 TS 约 8.3 万行（`packages/domain` + `contracts` + `sdk` + `apps/api`），Web 仅约 6.3k 行 TSX。v0.4 的核心体验（鼠标点线面 × 时间带 × 语音、提案 A/B、局部循环）在 UI 侧多处标注 `s1` / `IN_PROGRESS`。按 AGENTS.md 完成定义"接口存在 ≠ 功能交付"，大量后端 VERIFIED 尚无用户可达入口。
- 建议：后续排期向"垂直切片"倾斜——每推进一个后端 N 任务，同步交付其 UI 入口与浏览器证据，而不是继续横向铺后端能力；在 `docs/design/ui-coverage.md` 中为每个 VERIFIED 后端任务标注"用户可达入口：有/无"。

---

## 3. 架构与编程原则

### 3.1 编辑内核未与持久化解耦（SRP / DIP）
- `packages/domain/src/edits.ts` 3,158 行，直接使用 Drizzle 表对象；领域层 84 个文件直接依赖 `@ancs/db`。试改（P1-6）、客户端乐观预览、属性测试都受制于此。
- 建议（0010 第 6 条，未做）：拆 `edit-kernel`（纯函数 `validate/apply/invert`，输入为内存 ProjectDocument）+ `edit-application`（事务、锁、outbox、repository 端口）。先从 N03 时间线原语开始迁移，内核可同时被 Web 端复用做乐观预览。

### 3.2 `DomainDeps` 定义在 `channels.ts`
- `packages/domain/src/channels.ts:45`，被 86 个文件 `import ... from './channels.js'`。核心依赖类型挂在某个业务模块上，形成隐式中心依赖。建议移到 `packages/domain/src/deps.ts`。

### 3.3 领域层读取进程环境变量
- `packages/domain/src/plans.ts:41` 在**每次请求**时读 `process.env.ANCS_DEFAULT_PLAN`，非法值在运行期抛 500；而 `apiEnvSchema` 已经校验过同一变量。建议由入口把已校验的配置注入 `DomainDeps`，领域层不触碰 `process.env`（可加 arch-check 规则）。
- 同类：`apps/worker/src/domain.ts:38-60`、`apps/worker/src/main.ts:60-64`、`apps/api/src/cli/retention-sweep.ts:17-50` 在已有 `workerEnvSchema` 的情况下继续读原始 `process.env`；`Number(process.env.X)` 遇到非法值得到 `NaN`（租约秒数为 NaN 会导致租约立即过期或永不过期）。`REDIS_URL` 缺失时 `BullMqJobQueue({ redisUrl: '' })`。

### 3.4 存储签名密钥派生逻辑重复三份（DRY）
- `apps/api/src/index.ts:66`、`apps/worker/src/domain.ts:38-42`、`apps/api/src/cli/retention-sweep.ts:28-33`。任何一处改动（例如换 HKDF，0010 已对凭据密钥这样做）都会导致 API 签发的 URL 被 Worker 判为无效。另外 worker 在密钥不足时**静默不装配存储**（`domain.ts:50`），而 API 侧会失败退出，行为不一致。
- 建议：抽到 `@ancs/providers-storage-local` 的 `deriveStorageSigningSecret(env)`，三处共用；生产要求显式 `ANCS_STORAGE_SECRET`（与凭据密钥同一策略）。

### 3.5 时间换算函数多处复制且精度不一
- `mediaTime → ms` 至少有 4 份实现：`packages/contracts/src/playback-source.ts:235`、`playback-engine.ts:311`、`media-clock.ts:198`（`Number(ticks)` 浮点，超大 ticks 失精度），以及 `common/media-time.ts:150`（BigInt、但非整毫秒抛异常，见 P0-1）。建议统一到 `common/media-time.ts`，提供 `toSecondsApprox()` 与 `toMillisecondsExact()` 两个语义明确的函数。

### 3.6 SDK 手写 3,120 行、契约外自定义 schema
- `packages/sdk/src/client.ts` 单文件，接口声明与实现重复两遍；文件开头在 import 之间定义了契约外的 `sceneGenerationResponseSchema`（`:4-11`，注释"避免为组合结构新增契约"）。这违背"contracts → … → SDK"顺序（v0.4 §22），API 与 SDK 的响应结构可能漂移。
- 建议：响应 schema 一律进 `@ancs/contracts`；按资源拆分 SDK 模块（projects/assets/proposals/…）；中期考虑从 OpenAPI（已由 Zod 生成）生成客户端骨架，并加一条"SDK 方法覆盖所有路由"的契约测试。

### 3.7 错误码映射过粗
- `apps/api/src/error-handler.ts:18`：所有非 `ApiFailure` 的 409 都映射成 `VERSION_CONFLICT`；`default` 分支把所有其他 4xx（如 413 payload too large、415）映射为 `VALIDATION_FAILED`。客户端按错误码做重试/刷新决策时会误判。建议补 413/415/422 显式映射，非版本冲突的 409 用通用 `CONFLICT`。

---

## 4. 工程效率与可维护性优化

1. **arch:check 不能独立运行**（`packages/arch-check/package.json` `check: node dist/cli.js`）：改为 `tsx src/cli.ts` 或 `pretest` 先 build，避免开发者本地只跑 `pnpm arch:check` 时误以为架构检查坏了。
2. **CI 只在 `main` push 与 PR 上触发**（`.github/workflows/ci.yml`）：当前所有工作在 `codex/v04-foundation` 上直接推送，不开 PR 就**没有 CI**。建议为该长期分支加 `push` 触发，或强制以 PR 合并。
3. **台账一致性脚本**：把 §2 R-1/R-2 用到的核对逻辑（依赖均 VERIFIED、证据/交接文件存在、统计数自动生成）做成 `scripts/ledger-check.mjs` 并纳入 `pnpm verify`。
4. **大文件拆分**：`edits.ts`（3.2k）、`contracts/src/index.ts`（2.6k）、`sdk/src/client.ts`（3.1k）、`proposals.ts`（1.1k）。按操作族/资源拆分可显著降低合并冲突与审查成本。
5. **Lint 小修**：删除 `apps/web/src/ui/VoiceCaptureControl.test.tsx:25` 的无用 `eslint-disable`；可开启 `reportUnusedDisableDirectives: 'error'` 防止回潮。
6. **单测导入开销占 72%**：vitest 提示 `isolate: false` 可节省约 20 s；对纯函数包（contracts）可单独开启，DB 相关保持隔离。
7. **启动装配集中化**：`apps/api/src/index.ts` 用大量 `if driver === 'mock' … else exit` 手写分支；建议做一个 `providerRegistry`（driver 名 → 工厂 + 必填配置 + 是否 Mock），统一负责校验、告警和生产禁 Mock（顺带解决 R-5）。

---

## 5. 0010 遗留项跟踪（仍未处理）

| 0010 条目 | 当前状态（本次复核） | 建议优先级 |
|---|---|---|
| API 限流 / 显式 CORS | 全仓无 `@fastify/rate-limit`、`@fastify/cors`（`apps/api/src/server.ts`） | P1（LLM/生成端点有直接费用风险） |
| Web CSP 头 | `apps/web/next.config.mjs` 仍无 `headers()` | P1 |
| 上传 MIME/扩展名白名单 | 未见变更 | P1 |
| 真实杀毒引擎 | 仍为 `HeuristicMalwareScanner` | 部署决策 |
| Dockerfile / OS 级媒体隔离 | `infra/` 仍只有 `docker-compose.dev.yml` | P1（上线前） |
| 全历史密钥扫描 | CI 无 gitleaks/trufflehog | P1 |
| LICENSE | 仍无 `LICENSE` 文件 | 需用户决策 |
| 台账 `VERIFIED_MOCK/REAL` 独立列 | 仅在头部文字说明 | P2（见 R-3） |
| 编辑内核抽象 | 未开始 | P2（见 §3.1） |

---

## 6. 建议的修正顺序

**第一批（正确性，1–2 天，可独立提交，每项附回归测试）**
1. P0-1 时间换算：去掉权威路径上的 `mediaTimeToLegacyMilliseconds`，加多时基属性测试。
2. P0-2 / P1-1 清理任务：FK 违约转 `skipped`、逐条容错、引用检查入事务、TTL 过滤下推 SQL。
3. P1-3 Webhook `timingSafeEqual`（一行修复 + 单测）。
4. P1-2 幂等作用域包含实际路径；处理中行加超时。
5. P1-5 试改错误分类与信息脱敏；P2-2 复用 `currentEventSeq`。

**第二批（需求口径与配置，2–3 天）**
6. R-1/R-2/R-3 台账修正 + `ledger-check` 脚本入 verify。
7. R-4 Deepgram 接入 Worker 装配 + env schema；R-5 生产禁 Mock 开关。
8. P1-4 语音会话密钥入 schema、实现 token 校验（或在台账中明确"仅签发"）。
9. §3.3/§3.4 配置统一走已校验 env，存储密钥派生收敛为一个函数。

**第三批（安全加固与架构，按迭代排期）**
10. §5 限流 / CORS / CSP / MIME 白名单 / gitleaks。
11. R-6 把现有 Playwright 脚本收编为 v0.4 `test:e2e`；CI 覆盖长期分支。
12. §3.1 编辑内核纯函数化（先 N03 原语），随后 SDK 拆分与契约收口（§3.6）。
13. R-7 后续 N 任务按"后端 + UI 入口 + 浏览器证据"垂直切片推进。
