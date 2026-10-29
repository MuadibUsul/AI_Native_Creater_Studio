# 内部部署 Runbook（P08-01 / 规范 §50）

> 目标：在**全新环境**上按本清单可重复地部署 Web / API / Worker / Render、数据库、队列与存储；
> **错误配置启动失败并说明原因**（fail-closed，禁止带病启动、禁止静默降级为 Mock）。
> 可执行演练：`pnpm run deploy:rehearsal`（在全新数据库上重复本清单的 0—7 步并输出 PASS/FAIL 清单，
> 含"错误配置必须失败"的反向校验）。

## 0. 前置条件

| 项 | 要求 |
|---|---|
| Node.js | 24.x（原生 TypeScript 类型剥离运行渲染 CLI；`node -v` 验证） |
| pnpm | 9.15（`corepack enable` 或独立安装） |
| PostgreSQL | 16（本地开发见 `infra/docker-compose.dev.yml`） |
| Redis | 7（仅 `ANCS_QUEUE_DRIVER=bullmq` 时需要；默认 DB 轮询不需要） |
| 浏览器 | 无本机 Chrome 时 Remotion 首次渲染会自动下载 Headless Shell（需出网） |
| 对象存储 | 单机用**本地驱动**（`ANCS_STORAGE_DRIVER=local`，目录挂载持久卷）；多机 / 正式上线用 **S3 兼容对象存储**（`ANCS_STORAGE_DRIVER=s3`：AWS S3、Cloudflare R2、阿里云 OSS、自建 SeaweedFS 等，见 §10.3） |
| KMS/密码管理 | 会话密钥与存储签名密钥经 Secrets 注入（见 §2）；`packages/providers/credential-vault-local` 为本地凭据密文实现 |

## 1. 安装与构建

```bash
pnpm install --frozen-lockfile
pnpm build            # TS → dist（API/Worker 以构建产物运行：apps/api/dist/index.js、apps/worker/dist/main.js）
```

构建产物形态说明：
- **API**：`node apps/api/dist/index.js`；
- **Worker**：`node apps/worker/dist/main.js`（可加 `--once` 做单轮自检）；
- **渲染执行器 / Motion 验证器 / 媒体探测**：Worker 以子进程调用仓库内 TS 脚本
  （`apps/render-worker/src/run-render.ts` 等，Node 24 直接运行；**必须在仓库根启动 Worker**
  或用下列环境变量显式指定命令）：
  - `ANCS_RENDER_EXECUTOR_CMD`（默认 `node --no-warnings <repo>/apps/render-worker/src/run-render.ts`）
  - `ANCS_MOTION_VALIDATOR_CMD`、`ANCS_MEDIA_PROBE_CMD`（同上模式）
  - `ANCS_DISABLE_RENDER=1`：显式关闭渲染任务（此时 `RENDER_FINAL` 落入"未知任务类型 → FAILED_FINAL"）

## 2. 环境变量（Secrets 经注入，禁止入库）

以 `.env.example` 为模板。**启动时一次性校验全部配置**：任何缺失/非法/未实现的驱动都会打印
`[api]/[worker] 启动失败：环境配置有 N 处问题` 清单（含变量名与原因）并以退出码 1 终止。

必填：

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | PostgreSQL 连接串（含密码；经 Secrets 注入） |
| `BETTER_AUTH_SECRET` | 会话/令牌签名密钥（≥16 字符；经 KMS/Secrets 注入） |

常用（有默认值）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `ANCS_DB_POOL_MAX` / `ANCS_DB_CONNECT_TIMEOUT_MS` / `ANCS_DB_STATEMENT_TIMEOUT_MS` | 5 / 无 / 无 | 连接池（缺省每进程 5 个连接、不设超时）。所有 API、Worker、实时网关副本的连接数之和要低于数据库 `max_connections` 并留余量；建议设连接超时（如 10000）让数据库不可达时快速失败，语句超时（如 60000）防止失控查询占住连接 |
| `PORT` | `3001` | API 端口 |
| `BETTER_AUTH_URL` | `http://localhost:$PORT` | 对外基址（签名/回调） |
| `ANCS_STORAGE_DRIVER` | `local` | `local`（单机磁盘）或 `s3`（S3 兼容对象存储，§10.3）；其他值启动失败，不静默降级。API、Worker、清理 CLI 必须一致 |
| `ANCS_S3_BUCKET` / `ANCS_S3_REGION` | — | `s3` 时必填：桶名、区域（R2 写 `auto`） |
| `ANCS_S3_ENDPOINT` / `ANCS_S3_PUBLIC_ENDPOINT` | AWS 缺省端点 | 非 AWS 服务的端点；浏览器访问的端点与服务端不同时（如内网地址）另设公开端点 |
| `ANCS_S3_FORCE_PATH_STYLE` | `0` | 路径风格寻址（自建 SeaweedFS 等通常需要 `1`） |
| `ANCS_S3_ACCESS_KEY_ID` / `ANCS_S3_SECRET_ACCESS_KEY` | 运行环境凭据链 | 成对配置；都不配时用云主机角色等。所需权限：桶的 `s3:ListBucket`，对象的 `s3:GetObject`、`s3:PutObject`、`s3:DeleteObject`、`s3:AbortMultipartUpload` |
| `ANCS_S3_KEY_PREFIX` | 无 | 桶内前缀（多个环境共用一个桶时区分，如 `prod/`） |
| `ANCS_STORAGE_LOCAL_DIR` | `.storage` | 本地存储根目录（挂持久卷；只存 storage_key） |
| `ANCS_STORAGE_PUBLIC_BASE_URL` | `BETTER_AUTH_URL` | 签名 URL 的对外基址 |
| `ANCS_LLM_DRIVER` / `ANCS_TTS_DRIVER` | `mock` | **仅 mock**（真实驱动随凭据接入；未知名 → 启动失败） |
| `ANCS_QUEUE_DRIVER` | `db` | `db` 轮询（权威状态即队列）或 `bullmq`（需 `REDIS_URL`） |
| `REDIS_URL` | — | `ANCS_QUEUE_DRIVER=bullmq` 时必填 |
| `ANCS_NATIVE_CLIENTS` | — | 原生客户端注册（JSON 数组） |
| `ANCS_OPS_ENVIRONMENT` | 未配置则运营面关闭 | 开发可显式设 `DEVELOPMENT`；生产进程必须显式设 `PRODUCTION`；`TEST` principal 不可登录生产运营面 |
| `ANCS_OPS_IDLE_SECONDS` / `ANCS_OPS_ABSOLUTE_SECONDS` / `ANCS_OPS_REAUTH_SECONDS` | `900` / `28800` / `300` | 独立运营会话空闲、绝对和敏感操作重验时限（秒） |
| `ANCS_WEBHOOK_SECRETS` | — | Provider 回调验签密钥（JSON） |
| `REMOTION_BROWSER_EXECUTABLE` | 自动检测 | 指定 Chrome/Headless Shell 可执行文件（新版 Chrome 已移除旧 Headless 模式，需指向 `chrome-headless-shell`） |
| `ANCS_PLATFORM_PROVIDER_KEYS` | — | 平台托管 Provider 凭据（`供应商:密钥,…`）。旧名 `PLATFORM_PROVIDER_KEYS` 从未生效，配置即启动失败并提示改名 |
| `ANCS_VOICE_SESSION_SECRET` | 未配置则创建语音会话 501 | 语音会话短期凭证签名密钥（≥32；与其他密钥独立） |
| `ANCS_ASR_DRIVER` | 有 `ANCS_ASR_EXECUTABLE` 则 `process`，否则不装配 | Worker ASR：`deepgram`（需 `DEEPGRAM_API_KEY`，缺失启动失败）或 `process` |
| `ANCS_LEGACY_PIPELINE` | 生产 `off`，其余 `mock` | 旧 V4 流水线（脚本 / 分镜的叙事生成、旧配音、声音克隆、素材搜索、Mock 分发）。它只有测试替身：`off` 不装配，相关端点 501，`/api/v1/capabilities` 报告 `legacyPipeline: off`，Web 隐藏旧入口、旧页面引导到共看片室；V6 共看片室、文章、自主制作不依赖它 |
| `ANCS_ALLOW_MOCK_PROVIDERS` | 不允许 | **生产进程**装配任何 Mock/脚本化驱动必须显式设 `1`，否则启动失败；装配清单经 `/api/v1/capabilities` 的 `providers` 报告。生产缺省已不装配 Mock（旧流水线 off），正常部署不需要它 |
| `ANCS_WORKER_TICK_MS` / `ANCS_WORKER_LEASE_SECONDS` / `ANCS_WORKER_HEARTBEAT_MS` | `1000` / `60` / 租约的 1/3 | 带上下界校验（非法值启动失败）；心跳必须短于租约 |
| `ANCS_WORKER_SLOTS`（Worker） | `1` | 任务槽：同一个 Worker 同时执行几个任务（1–32）。长素材分章时，每一章占一个槽、大部分时间在等模型，调大它就能让一个 Worker 同时剪几章；建议设为分章资源池（缺省 3）+ 1，父运行轮询也要一个槽。渲染、转码等耗 CPU 的任务同样占槽，按机器核数取值。必须少于 `ANCS_DB_POOL_MAX`（缺省 5），否则启动失败 |
| `ANCS_REFERENCE_FETCH_CMD`（Worker） | 未配置 | V6-6 学风格：平台页面链接的下载命令，必须含 `{url}` 与 `{output}`；未配置时只支持上传与直接视频链接 |
| `ANCS_REFERENCE_MAX_MB`（Worker） | `1024` | V6-6 学风格：单条参考视频下载上限（MB） |
| `ANCS_NARRATION_DRIVER`（Worker） | 未配置 | V6-5 讲述配音：`flite`（本地英文）、`fish`（Fish Audio，需 `FISH_AUDIO_API_KEY` 与 `ANCS_NARRATION_VOICES_JSON`，可选 `ANCS_FISH_AUDIO_MODEL`）、`gemini`（Gemini TTS，需 `GEMINI_API_KEY`，可选 `ANCS_GEMINI_TTS_MODEL`、`ANCS_NARRATION_VOICES_JSON`）或 `process`（需 `ANCS_NARRATION_EXECUTABLE` 与 `ANCS_NARRATION_VOICES_JSON`，可选 `ANCS_NARRATION_ARGS_JSON`） |
| `ANCS_AGENT_DRIVER` / `ANCS_VISUAL_ANALYSIS_DRIVER`（Worker） | 未配置 | AI 导演 / 素材画面理解：`anthropic`（需 `ANTHROPIC_API_KEY`）或 `gemini`（需 `GEMINI_API_KEY`；模型 `ANCS_AGENT_MODEL` 缺省 `gemini-flash-latest`、`ANCS_VISION_MODEL` 缺省 `gemini-flash-lite-latest`）；画面理解另可 `process`。缺密钥启动失败 |
| `ANCS_AIGC_PRODUCER_CODE`（Worker） | 未配置（生产启动时警告） | AI 生成合成内容标识的服务提供者编码，写进成片 `AIGC` 元数据的 ContentProducer / ContentPropagator（§5.6）。面向中国境内公众提供服务时必须配置 |
| `ANCS_VEO_OFFER_JSON`（Worker） | 未配置 | V6-8 生成镜头接 Google Veo：VIDEO_SHOT 报价依据（必须带 `durationOptions`，价格按 Google 价格页填写），需 `GEMINI_API_KEY`；装配清单出现 `video_generation=veo` |
| `ANCS_RUNWAY_OFFER_JSON`（Worker） | 未配置 | V6-8 选区重绘接 Runway gen4_aleph：VIDEO_REGION 报价依据（价格按 Runway 价格页换算填写），需 `RUNWAYML_API_SECRET`；可选 `ANCS_RUNWAY_BASE_URL`；装配清单出现 `region_generation=runway` |
| `ANCS_SEEDANCE_OFFER_JSON`（Worker） | 未配置 | V6-8 生成镜头接火山方舟 Seedance：VIDEO_SHOT 报价依据（必须带整数秒 `durationOptions`，价格按方舟价格页换算填写），需 `ARK_API_KEY`；可选 `ANCS_SEEDANCE_GENERATE_AUDIO`、`ANCS_SEEDANCE_RESOLUTION`、`ANCS_ARK_BASE_URL`；装配清单出现 `video_generation=seedance` |
| `ANCS_AVATAR_DRIVER`（Worker） | 未配置 | V6-7 数字人：`heygen`（需 `HEYGEN_API_KEY` 与 `FISH_AUDIO_API_KEY`；可选 `ANCS_AVATAR_OFFER_JSON` 报价依据） |
| `ANCS_GENERATION_DRIVER`（Worker） | 未配置 | V6-8 视频生成：`process`（需 `ANCS_GENERATION_EXECUTABLE` 与 `ANCS_GENERATION_OFFERS_JSON`；可选 `ANCS_GENERATION_ARGS_JSON`、`ANCS_GENERATION_PASS_ENV`、`ANCS_GENERATION_TIMEOUT_SECONDS`） |
| `ANCS_ALLOWED_ORIGINS` | `BETTER_AUTH_URL` 的 origin（非生产另加 `http://localhost:3000`、`http://127.0.0.1:3000`） | API 的 CORS 白名单与带 Cookie 写请求的 Origin 校验（逗号分隔完整 origin；Web 经同源代理访问 API 时填 Web 的 origin） |
| `ANCS_TRUST_PROXY_HOPS` | `0` | 前置可信代理跳数；为 0 时不信任 `X-Forwarded-For`。部署在负载均衡/反向代理后必须如实设置，否则所有用户共享代理 IP 的限流桶 |
| `ANCS_RATE_LIMIT` | `enforce` | 按端点类别 × 客户端 IP 限流；生产不得为 `off` |
| `ANCS_RATE_LIMIT_REDIS_URL` | 未配置（每个 API 进程各自限流） | 多台 API 时配置：额度存在 Redis 里共用（Lua 原子令牌桶，用 Redis 服务器时间）；启动时连不上即失败；运行中 Redis 出错退回本进程限流并告警（每分钟最多一条） |
| `ANCS_CSP_EXTRA_ORIGINS`（Web **构建期**） | 非生产为本地 API 端口 | Web CSP 额外放行的媒体/上传来源（签名 URL 直达的存储或 API origin）；Next 在构建时固化安全头，修改后需重新构建 Web |

生产（`NODE_ENV=production`）额外必填：`ANCS_CREDENTIAL_KEYS`（API 与 Worker 同一值）、`ANCS_STORAGE_SECRET`（API、Worker、清理 CLI 同一值；不得从会话密钥派生）、`ANCS_OPS_ENVIRONMENT=PRODUCTION`（API）。
空白值（`VAR=`）视为未配置。Worker 的渲染/探测/Motion 验证/FFmpeg 子进程只继承平台必需环境变量（`PATH`、`HOME`、临时目录、语言）与 `REMOTION_*`、`ANCS_FFMPEG_PATH`、`ANCS_FFPROBE_PATH`，不继承连接串与密钥。

密钥轮换：轮换 `BETTER_AUTH_SECRET` 会失效既有会话与本地存储签名 URL（TTL 15 分钟内的下载链接立即失效）；
轮换存储签名密钥（未显式配置时由 `BETTER_AUTH_SECRET` 派生）同理会失效在途签名链接。轮换窗口与步骤见 P08-03。

## 3. 数据库

```bash
# 预检
psql "$DATABASE_URL" -c 'select 1'
# 迁移（drizzle-kit 生成的版本化迁移；幂等，可重复执行；先取咨询锁，多个实例同时执行只有一个在跑）
pnpm db:migrate          # = node apps/api/dist/cli/migrate.js；退出码非 0 时新版本不应启动
# 核对（表数量应 ≥ 30；当前 54）
psql "$DATABASE_URL" -c "select count(*) from information_schema.tables where table_schema='public'"
```

## 4. 存储卷

- 本地驱动：`ANCS_STORAGE_LOCAL_DIR` 指向**持久卷**（容器部署挂卷）；目录自动创建；
- S3 驱动：不需要共享卷，配置见 §10.3；
- 校验：写入/读取/校验和（`scripts/deploy-rehearsal.mjs` 步骤 5 自动执行）；
- 数据库只存 `storage_key`（绝不存对象 URL）；签名 URL TTL 15 分钟（上传/下载）。

## 5. 启动与健康检查

```bash
# API
node apps/api/dist/index.js            # 期望日志：数据库（脱敏连接串）；GET /api/v1/health → 200
# Worker（仓库根启动；渲染/验证器路径缺失会在启动时失败并说明原因）
node apps/worker/dist/main.js          # 常驻循环；或 --once 单轮自检
```

健康检查（无需认证）：
- 存活 `GET /api/v1/health` → `{ "status": "ok", "service": "ancs-api", ... }`：只说明进程活着，编排器据此决定是否重启；
- 就绪 `GET /api/v1/ready` → 200 `{ "status": "ready", "draining": false, "checks": { "database": "ok" } }`；数据库查不通、超时（2 s）或正在退出时 503
  `status: "not_ready"`（不含错误细节）。负载均衡 / 编排器用它决定是否转发流量。

优雅退出：API 收到 `SIGTERM` / `SIGINT` 后先标记排空（`/ready` 变 503），等 `ANCS_SHUTDOWN_DRAIN_SECONDS`（缺省 0，
放在负载均衡后建议 5）让实例被摘除，再停止接新连接、等进行中的请求处理完、释放连接池，退出码 0；超过
`ANCS_SHUTDOWN_TIMEOUT_SECONDS`（缺省 25）强制退出（退出码 1）。编排器的停止宽限期应大于两者之和（compose 样例为 40 s）。

### 5.1 Realtime Gateway（V6-2 实时语音，可选）

```bash
node apps/realtime/dist/main.js        # 缺省端口 3002；GET /health → { ok, asr: "deepgram" | "NOT_CONFIGURED" }
```

- 环境：`DATABASE_URL`、与 API **同一把** `ANCS_VOICE_SESSION_SECRET`（网关用它校验浏览器带来的语音会话短期凭证）、`ANCS_ALLOWED_ORIGINS`（Web 的 origin）；
  流式识别 `ANCS_REALTIME_ASR_DRIVER=deepgram` + `DEEPGRAM_API_KEY`（可选 `ANCS_DEEPGRAM_LIVE_MODEL_ZH` / `_EN`）。没配识别时网关照常启动，连接时明确回"未配置"。
- 反向代理：把 Web 同源的 `/realtime/v1/voice`（WebSocket 升级）转到网关；或在构建 Web 时设 `NEXT_PUBLIC_ANCS_REALTIME_URL=wss://…/realtime/v1/voice` 并把该 origin 加进 `ANCS_CSP_EXTRA_ORIGINS`。
- 网关不读写工程、不调用 AI：一句话说完交还浏览器，浏览器把它当作一轮对话发给 API（权限、幂等、预算不变）。

### 5.2 特效渲染（V6-3）

- Worker 在仓库根启动时自动装配特效渲染：spawn `apps/render-worker/src/run-effect.ts`（Remotion 无头浏览器 → ProRes 4444 → 无损转 PNG/QuickTime 透明图层），可用 `ANCS_EFFECT_RENDER_CMD` 覆盖命令；需要 `REMOTION_BROWSER_EXECUTABLE`（或本机 Chrome）与 FFmpeg。`ANCS_DISABLE_RENDER=1` 时不装配，特效工具明确报不可用。
- 子进程只继承白名单环境变量（平台启动项 + `REMOTION_*`、`ANCS_FFMPEG_PATH`、`ANCS_FFPROBE_PATH`），硬超时 3 分钟；特效代码在页面里运行时浏览器网络/存储/DOM 能力被遮蔽。
- AI 当场写特效代码缺省关闭；按评测结果设 `ANCS_EFFECT_CODEGEN=enabled` 开启（代码先过 Custom Motion 四道门禁）。
- 程序化特效受项目制作规则约束（素材工程缺省关闭），用户在共看片室顶栏开启：`PATCH /api/v1/workspaces/:id/projects/:projectId/production-policy`，写工作区事件 `project.production_policy.updated`。

### 5.3 从参考视频学风格（V6-6）

- Worker 自动装配蒸馏工作流 `REFERENCE_DISTILL`（获取 → 测量 → 撰写 → 保存）：测量全部用本地 FFmpeg（场景切换、黑场、`signalstats` 色彩、`ebur128` 响度、`silencedetect`、单声道 PCM 节拍检测），每条最多分析前 15 分钟，最多 5 条。
- 链接：直接的视频文件链接由 Worker 下载（拒绝内网/保留地址，逐跳检查重定向，限制大小 `ANCS_REFERENCE_MAX_MB`，缺省 1024）；平台页面链接需要 `ANCS_REFERENCE_FETCH_CMD`（如 `yt-dlp … -o {output} {url}`），命令只继承代理/证书相关的环境变量，硬超时 10 分钟，下载后再按同一上限检查大小。没配置时页面链接明确失败并提示下载后上传。
- 参考视频存为工作区素材库里的草稿资产（`DRAFT_RENDER_30D`，许可证"未知"并记录来源链接与最终链接）；风格包 id 由工作流 id 派生（重放不会重复保存）。
- 配置了 AI 导演（`ANCS_AGENT_DRIVER`）时由模型看测量结果与抽帧撰写说明（数值仍只来自测量，模型的画面观察标为推断）；否则用规则版说明。接口：`POST /api/v1/workspaces/:id/strategy-distills`（202，`project:write`，按"昂贵端点"限流）、`GET …/strategy-distills/:runId`、`PATCH …/strategy-packs/:packId`（内置预设 409）。
- 命令行（不用数据库）：`node scripts/distill-reference.mjs [--json out.json] <文件或链接>…`，与工作流同一套测量与撰写代码。

### 5.4 讲述配音（V6-5）

- Worker 按 `ANCS_NARRATION_DRIVER` 装配语音合成：`flite`（FFmpeg 内置 libflite，本地英文语音，无需密钥）或 `process`（部署方的合成程序，见 `.env.example`）。不配置时讲述工具明确报不可用，装配清单（启动日志"外部能力驱动"）里没有 `narration`。
- 合成逐句进行、拼成一条 24 kHz 单声道 WAV（句间 0.25 s），每句的起止位置精确，字幕按句生成并绑定讲述片段；产物经真实探测后存为 `VOICE_AUDIO`（来源 GENERATED，保留类 `KEEP_PAID_GENERATED`）。同一段讲述（引擎、声音、语速、句子相同）复用已有音频。
- 合成语音受项目制作规则约束（`allowGeneratedSpeech`）：素材作品默认关闭，用户在共看片室顶栏"配音：关/开"显式切换（写工作区事件）；从文章开始的作品按新建时的选择。
- 合成失败不自动重试，如实交还 AI；`process` 子进程每句硬超时 2 分钟、输出上限 64 MB。

### 5.5 付费生成：数字人与视频生成（V6-7 / V6-8）

- 流程：AI 只报价（`quote_generation`）→ 用户在共看片室报价卡上确认（API 校验确认金额 = 报价上限）→ 在**工作区生成预算**里原子预留（没设预算 → 拒绝）→ `PAID_GENERATION` 工作流生成一次（不重试）→ 产物写入对象存储并探测（保留类 `KEEP_PAID_GENERATED`）→ 放进试改 → 按供应商报告的费用结算（没报告按报价上限并标明；明确未扣费的失败释放预留）。
- **待对账**：调用供应商之后的任何中断（超时、进程崩溃、Worker 丢租约）都把生成标为 `NEEDS_RECONCILIATION`，绝不再次调用，预留保持。运维按 `generation_requests.provider_job_id` 与供应商核对后手工处理（AdminAction 接入前的临时做法；见 V6-7 记录的 TODO）。
- 装配：`ANCS_AVATAR_DRIVER=heygen`（数字人）与 `ANCS_GENERATION_DRIVER=process`（生成镜头、选区重绘）可以并存；装配清单出现 `avatar_generation` / `paid_generation`。没有配置时 AI 如实回复"这个部署还没有接入这类生成的供应商"。
- 网络：放行 `api.fish.audio`、`api.heygen.com`、`upload.heygen.com` 与 HeyGen 视频下载域名；Gemini / Veo 放行 `generativelanguage.googleapis.com`（Veo 成片的下载链接会跳转到 Google 存储域名，Worker 跟随跳转时不带密钥）；在需要经代理出网的环境里给 Worker 加 `NODE_USE_ENV_PROXY=1`。
- Veo 只能生成 4/6/8 秒：报价与预留按不短于所需的最短一档，成片统一到项目画布与帧率后放进试改（只用需要的长度）。
- 网络层失败分两类：请求确定没发出去（DNS、拒绝连接、出网代理拒绝建立隧道）→ 不扣费、释放预留；连接中途断开或超时 → 结果不明、待对账。诊断：`node scripts/provider-network-check.mjs`（不产生生成费用）。
- Seedance（火山方舟）放行 `ark.cn-beijing.volces.com` 与成片所在的对象存储域名（`*.tos-cn-beijing.volces.com`）；成片链接是临时签名链接，Worker 下载时不带密钥。Veo 与 Seedance 共用同一套"提交一次 → 轮询 → 下载 → 统一画布"的实现（`apps/worker/src/hosted-video-shot.ts`），计费结局一致。
- 密钥只在 Worker 进程内存里使用，不进日志与错误信息；进程驱动的子进程只拿到白名单环境变量 + `ANCS_GENERATION_PASS_ENV` 列出的变量。
- 身份档案的授权记录（`identity_consent_records`）只增不改，由数据库触发器保证；删除身份档案或工作区时随级联清理。

### 5.6 AI 生成合成内容标识（《人工智能生成合成内容标识办法》+ GB 45438-2025）

- 判定：导出时冻结的成片里只要用到来源为 AI 生成的媒体（付费生成的镜头与数字人、合成讲述、AI 写的特效 / 图解图层，资产 `origin=GENERATED`），
  这次导出就加标识；只有用户自己素材的成片不加（不误标）。
- 显式标识：成片开头左上角的固定文案（白字半透明黑底，显示 3 秒，字号为画面短边的 6.5%，满足"≥2 秒、字高 ≥ 短边 5%"）。
  文案随导出语言：界面为中文时"AI生成"，英文时"AI-generated"；API 调用不传 `labelLanguage` 时用英文（产品面向全球市场，所有者 2026-10-22 决定，见 `docs/OWNER_ACTION_ITEMS.md` D-01）。
  两种文案共用一款中文字体（镜像含 `fonts-noto-cjk`；找不到中文字体时导出失败，不画成方块）。
- 隐式标识：MP4 元数据 `AIGC` 字段，按附录 E 键序写 `Label`（1）、`ContentProducer`、`ProduceID`（这次导出的运行编号）、`ReservedCode1`、
  `ContentPropagator`、`PropagateID`、`ReservedCode2`；技术检查（QA）从存储读回成片确认元数据真的写进去了，没有就不交付。
- 导出面板如实告诉用户加了哪句标识（中英）。
- 不面向中国大陆公众时（当前决定），`ANCS_AIGC_PRODUCER_CODE` 可不配：元数据里的服务提供者编码为空串，Worker 生产启动时会打印一行提示，可忽略。
  将来若面向中国境内公众：配置该编码（按 TC260 实践指南由统一社会信用代码等组成），并确认算法备案、生成式人工智能服务备案与 ICP 备案。
- 用户要求导出无显式标识版本的流程（用户协议约定标识义务 + 日志留存 ≥6 个月）尚未提供，需要时请提出。
- 如实说明：`ReservedCode1/2`（可选的防篡改校验字段）目前留空；未写 XMP；C2PA 内容凭证需要签名证书，未接入。

## 6. 队列

- 默认 `ANCS_QUEUE_DRIVER=db`：队列消息只作"及时性"信号，**权威状态在数据库**；Outbox 保证崩溃后重放；
- `bullmq`：配置 `REDIS_URL`；Worker 声明/心跳/回收语义不变。

## 7. 验证（部署完成的判定）

```bash
pnpm run deploy:rehearsal   # 全新库演练（0—7 步 + 反向校验），期望 10/10 PASS
pnpm run provider:verify    # Provider 能力核验（无凭据时退出码 2 并列出缺失变量——非部署失败）
```

反向校验（演练自动执行，也可手工复核）：
- 缺 `DATABASE_URL` + 缺/短 `BETTER_AUTH_SECRET` → 启动失败并**一次列出两项**；
- 未知 `ANCS_STORAGE_DRIVER`（如 `gcs`）→ 启动失败并提示"只能是 local 或 s3"；`s3` 缺桶 / 区域 → 启动失败并逐项列出；
- `ANCS_QUEUE_DRIVER=bullmq` 缺 `REDIS_URL` → Worker 启动失败并指出 REDIS_URL。

## 8. 已知边界与待办（诚实记录）

1. **云存储适配器（S3/R2）未实现**：V1 为本地驱动；云直传/预签名在真实凭据阶段接入（启动拒绝 `s3` 避免假配置）。
2. **KMS 未接真实云端**：本地凭据密文（AES-256-GCM）已就绪；生产 KMS/KMS 轮换流程随 P08-03。
3. **OS 级沙箱（gVisor/容器网络策略）与 Custom Motion 像素渲染**：属部署层待办（决策 0008）；
   V1 Worker 以进程隔离 + 硬超时运行渲染/验证 CLI。
4. `apps/web` 部署为 Next 15 应用（`pnpm --filter @ancs/web build` 产物 `apps/web/.next`），
   托管方式随目标环境（Node 服务器/容器）选择；本 Runbook 的演练覆盖 API/Worker/DB/存储，
   Web 与反向代理（TLS/域名）属环境特化配置。

## 9. 商业上线门（P09-06 / §47）

对外收款与公开注册是**独立放行**（fail-closed），与内部预上线部署（`ANCS_SAAS_MODE=internal`，默认）分离：

```bash
pnpm run launch:gate                 # 信息模式（CI 执行）：台账可解析 + 输出机器条件现状
node scripts/launch-gate-check.mjs --live   # 放行判定：任一人工条件未完成或机器条件不满足 → exit 1
```

- **机器条件**（`ANCS_SAAS_MODE=live` 时 API 启动强制，见 `crossCheckApiEnv`）：
  `ANCS_DEFAULT_PLAN=FREE`、`ANCS_PAYMENTS_DRIVER=stripe`、`ANCS_STORAGE_DRIVER≠local`、
  `BETTER_AUTH_URL=https://…`、`ANCS_OPS_ENVIRONMENT=PRODUCTION`（且 `NODE_ENV=production`）。
- **人工条件台账**：`docs/ops/launch-gate.md`（LG-01…LG-14：Provider 条款/白标许可/协议/Consent/
  Content·Abuse·Privacy·ToS·DPA/主体税务/正式支付开通/Remotion 授权/政策上线/保留口径）——
  现状**全部 BLOCKED**（需人工：法务/商务/财务）；`APPROVED` 必须附可核对证据。
- **放行顺序**：台账逐条举证 → `--live` 判定通过 → 以 live 配置部署（启动再校验一次）；
  当前无公开注册端点（账号经内部 CLI 创建），与门禁一致。

## 10. 容器部署（V6）

镜像与编排在仓库里：`Dockerfile`（目标 `runtime`：API / Web / Realtime / 迁移；目标 `worker`：再加 FFmpeg、Chromium、中日韩字体）、
`infra/docker-compose.prod.yml`（单机编排样例）、`infra/production.env.example`（变量样例；真实文件 `infra/production.env` 已忽略，不入库）。

```bash
docker build --target runtime -t ancs:runtime \
  --build-arg ANCS_API_INTERNAL_URL=http://api:3001 \
  --build-arg ANCS_CSP_EXTRA_ORIGINS= \
  --build-arg NEXT_PUBLIC_ANCS_REALTIME_URL= .     # 空 = 浏览器走 Web 同源的 /realtime/v1/voice；用 S3 时 CSP 来源见 §10.3
docker build --target worker -t ancs:worker .
cp infra/production.env.example infra/production.env  # 填写；三把密钥互不相同
docker compose -f infra/docker-compose.prod.yml --env-file infra/production.env up -d
```

- 启动顺序：`db` 健康 → `migrate` 成功退出 → `api`（就绪探针）/ `worker` / `realtime` → `web`（等 API 就绪）。迁移失败时其余服务不会启动。
- 对外只发布 Web（3000）与实时语音网关（3002，缺省只绑 127.0.0.1）；前面放 TLS 反向代理：`/` → web:3000，`/realtime/v1/voice`（WebSocket）→ realtime:3002。
  API 不直接对外，浏览器经 Web 的 `/api/v1/*` 转发（`ANCS_API_INTERNAL_URL` 在构建 Web 时写入转发规则）。
- 本地存储驱动要求 API 与 Worker 挂同一个卷（样例里的 `storage`），这时编排是**单机**的；多机扩容改用 S3 驱动（§10.3），共享卷就不再需要。
- 构建期需要访问 npm 源；需要企业根证书时用 `--secret id=extra_ca,src=<pem>` 传入（只在安装依赖时可见，不写进镜像）。
- 生产缺省不装配任何 Mock：旧 V4 流水线 off（`ANCS_LEGACY_PIPELINE`），不需要也不应设置 `ANCS_ALLOW_MOCK_PROVIDERS`。
  旧的脚本 / 分镜页面只显示说明并引导到共看片室；已有作品仍可查看、出片和发布。

### 10.1 首个账号

公开注册上线前，用 `user:create` 建账号（在 api 容器里跑；密码只经环境变量，不进命令行参数与输出）：

```bash
ANCS_NEW_USER_PASSWORD='…' docker compose -f infra/docker-compose.prod.yml --env-file infra/production.env \
  run --rm --no-deps -e ANCS_NEW_USER_EMAIL=owner@example.com -e ANCS_NEW_USER_PASSWORD api node apps/api/dist/cli/create-user.js
```

### 10.2 演练记录（2026-10-21，本容器，`scripts/compose-browser-check.mjs`）

- 镜像：`ancs:runtime`（压缩后约 0.5 GB）、`ancs:worker`（约 0.9 GB，FFmpeg 5.1 含 flite、Chromium、Node 24）；构建上下文不含密钥，企业根证书只经 BuildKit secret 进入安装步骤；
- 全新数据库上 `migrate` 应用 98 个迁移后退出 0，其余服务随后启动；API、Web 健康检查通过，经 Web 转发的 `/api/v1/ready` 为 ready；
- 真实浏览器：`user:create` 建号 → 登录 → 建工作区 → 新建视频 → 上传素材 → 容器里的 Worker 探测 / 代理 / 索引用时约 3 s → 画布素材画框预览经签名地址加载；
- 生产不装配 Mock（同日复演）：`production.env` 不设 `ANCS_ALLOW_MOCK_PROVIDERS`，API 照常启动（日志"旧 V4 流水线 = off"）；经 Web 转发的 `/api/v1/capabilities` 报告 `legacyPipeline: off`、非真实驱动 0 个；旧新建页只显示说明并引导到共看片室（截图 `04-legacy-off.png`）；
- `docker stop api`：排空期间 `/api/v1/ready` 503（`draining: true`）、退出码 0、日志"已优雅退出"；重新启动后就绪，作品与素材都在；
- 本环境的限制：Docker Hub 拉取 `postgres:16-alpine` 被限流（429），演练用 `ANCS_POSTGRES_IMAGE=mirror.gcr.io/library/postgres:16-alpine`；构建用 `DEBIAN_MIRROR=https://deb.debian.org`（这里只能走 HTTPS 出网）。

### 10.3 S3 兼容对象存储（多机部署）

`ANCS_STORAGE_DRIVER=s3` 时浏览器经预签名 URL **直传直下**桶里的对象，字节不经 API；Worker 物化素材、写回代理与成片也直接读写桶，
API 与 Worker 可以各自横向扩容、不再共享磁盘。驱动在 `packages/providers/storage-s3`。

1. **开桶**（AWS S3、Cloudflare R2、阿里云 OSS 或自建 SeaweedFS）；不要开公开读，所有访问都用短时签名 URL。
2. **访问密钥**：桶的 `s3:ListBucket`（没有它时 S3 对不存在的对象回 403 而不是 404，系统无法判断对象是否存在），对象的
   `s3:GetObject`、`s3:PutObject`、`s3:DeleteObject`、`s3:AbortMultipartUpload`。API 启动时 HeadBucket 自检，桶名、区域或密钥错误直接启动失败。
3. **CORS**（浏览器直传直下必需）：允许来源 = 你的 Web 域名；方法 `GET`、`PUT`、`HEAD`；请求头 `content-type`、`range`；
   暴露 `ETag`、`Content-Length`、`Content-Range`、`Accept-Ranges`。
4. **Web 的 CSP**：构建 Web 镜像时把浏览器看到的存储 origin 加进 `--build-arg ANCS_CSP_EXTRA_ORIGINS=…`
   （AWS 虚拟主机风格是 `https://<桶>.s3.<区域>.amazonaws.com`；路径风格或自定义端点就是 `ANCS_S3_PUBLIC_ENDPOINT` / `ANCS_S3_ENDPOINT` 的 origin）。
   不加的话浏览器会拒绝上传与播放（CSP `connect-src` / `media-src`）。
5. **生命周期规则**：建议"未完成的分段上传 1 天后清除"。上传分片（`upload-parts/…`）在合成后由系统删除，保留清理任务会处理过期上传意图。
6. API、Worker、清理 CLI 配同一组 `ANCS_S3_*`；`s3` 模式不需要 `ANCS_STORAGE_SECRET` 与 `storage` 卷。

如实说明：
- 上传时的启发式扫描（EICAR、可执行文件头等）只作用于经 API 端点写入的字节；S3 直传不经过 API，完成上传时仍做内容嗅探（类型白名单）与 SHA-256 校验。
  需要真正的杀毒或内容审核时，在上传完成后接入审核端口（生产清单第 1 节第 8 项）。
- 预签名上传把 Content-Type 与**精确字节数**签进签名，与上传意图声明的不符即被存储服务拒绝；URL 有效期 15 分钟，上限 1 小时。
- 分片合成：每片 ≥5 MiB 时在存储服务内拼接（UploadPartCopy），更小的分片流式读出再写入；合成后的原件类型是 `application/octet-stream`（播放用的是代理文件）。

演练记录（2026-10-21，本容器，SeaweedFS 4.48 校验 SigV4 签名）：
- `packages/providers/storage-s3` 集成测试 8/8：服务端读写 / 探测 / 前缀读取 / SHA-256；预签名直传在长度或类型不符、路径被改时被拒；预签名下载支持 Range；
  20 MiB 文件流式写回与物化；小分片流式拼接与 ≥5 MiB 分片服务端拼接逐字节一致；复制；HeadBucket 自检（桶不存在 404、密钥错误 403）；前缀隔离。
- 共看片室全流程跑在 S3 上（`ANCS_STUDIO_S3_ENDPOINT=… node scripts/studio-browser-check.mjs`）15/15：浏览器分片直传 → Worker（FFmpeg）探测 / 代理 / 索引 →
  AI 第一版试改播放 → 采用 → 局部试改 → 导出并下载成片（1920×1080，9 s）；桶内 30 个对象。证据 `docs/verification/artifacts/storage-s3/`。
  过程中发现并修正：Web 的 CSP 只放行本源时浏览器直传被拦——Dockerfile 新增 `ANCS_CSP_EXTRA_ORIGINS` 构建参数（第 4 步）。
- 本地起测试用 S3：`docker run -d --name ancs-s3 -p 58333:8333 -v <含 s3.json 的目录>:/etc/seaweed-cfg:ro chrislusf/seaweedfs:4.48 server -s3 -s3.config=/etc/seaweed-cfg/s3.json -dir=/data`
  （`s3.json` 的身份与密钥见 `.github/workflows/ci.yml` 同名步骤；集成测试默认连 `http://127.0.0.1:58333`，可用 `ANCS_TEST_S3_ENDPOINT` 改）。
- 真实云账号（AWS / R2 / OSS）上的验证需要你的桶与密钥（生产清单第 1 节第 2 项的 👤 部分）。

### 10.4 注册与账号邮件（D-04）

- **注册方式** `ANCS_SIGNUP_MODE`：`closed`（缺省，只能用 `user:create` 建号）| `invite`（只有收到邀请的邮箱能注册；**所有者决定首轮内测用它**）| `open`（任何人）。
  `invite` / `open` 必须配好发信，否则 API 启动失败。登录页按 `/api/v1/capabilities` 的 `accounts` 显示"创建账号""忘记密码？"。
- **发信**：`ANCS_EMAIL_DRIVER=smtp` + `ANCS_SMTP_URL`（smtp(s)://用户名:密码@主机:端口，Secret）+ `ANCS_EMAIL_FROM`。AWS SES、Postmark、Resend、SendGrid、Mailgun 都给 SMTP 入口。
  发件域名在服务商处完成 SPF、DKIM（最好再加 DMARC），否则邮件易进垃圾箱。API 启动时做一次 SMTP 登录自检，失败只告警（不让整站起不来），恢复前注册和找回密码收不到邮件。
  `log` 驱动只在开发用（把邮件打到控制台），生产启动即失败。邮件链接指向 `ANCS_PUBLIC_WEB_URL`（缺省 `BETTER_AUTH_URL`），生产必须是 https。
- **流程**：注册 → 验证邮件（24 小时有效，点开即登录）→ 进创作台；未验证前登录会再收到一封验证邮件。找回密码 → 重设链接（1 小时、一次性）→ 设新密码后其他设备全部退出。
  运营建的账号视为已验证。答复不透露邮箱是否已注册（已注册的邮箱再注册，只给邮箱主人发"你已经有账号了"）。同一收件人同类邮件最多连发 3 封，之后约每 5 分钟 1 封。
- **发内测邀请**（在 api 容器里跑；配了发信会同时寄出邀请邮件，邀请 30 天有效，重复 add 只顺延）：

```bash
docker compose -f infra/docker-compose.prod.yml --env-file infra/production.env run --rm --no-deps api \
  node apps/api/dist/cli/signup-invite.js add someone@example.com --by owner --note "wave 1" --locale en
# 列出 / 撤销
docker compose -f infra/docker-compose.prod.yml --env-file infra/production.env run --rm --no-deps api node apps/api/dist/cli/signup-invite.js list
docker compose -f infra/docker-compose.prod.yml --env-file infra/production.env run --rm --no-deps api node apps/api/dist/cli/signup-invite.js revoke someone@example.com
```

- 工作区邀请（团队成员）同样会寄邮件；被邀请的邮箱在 invite 模式下也能注册，注册后在首页"你有新的邀请"里接受。
- 验证：`scripts/account-browser-check.mjs`（真实 SMTP 驱动 → 本机收信服务 → 浏览器打开邮件里的链接；证据 `docs/verification/artifacts/accounts/`）。真实服务商投递待你开通账号后实测。

### 10.5 每个工作区每月的 AI 费用上限

- `ANCS_AI_MONTHLY_CAP_USD`（美元，最多两位小数；`unlimited` = 不设上限）。**生产必须配置**，API 与 Worker 读同一个值（都从 `production.env` 读），缺了启动失败。示例值 `20`。
- 计入：UTC 自然月内开始的 AI 导演轮次（对话、审片讨论与执行、交给 AI 剪完）、"从参考视频学风格"和上传后画面理解的模型费用；付费生成（配音、数字人、生成镜头）不在这里，它们走工作区生成预算。
- 画面理解达到上限时暂停（素材面板显示"AI 额度已用完"），额度恢复后成员点"再理解一次画面"；额度仍用完时服务端直接拒绝（402），不会排一个注定停下的任务。
- 达到上限：进行中的一轮在下一次模型调用前停下，已完成的修改保留为提案；新的一轮返回 402 `AI_MONTHLY_CAP_REACHED`；共看片室在输入框上方说明额度与恢复日期（UTC 下个月 1 日）。学风格改用规则撰写。实际花费最多超出上限一次模型调用。
- 套餐权益 `aiSpendMicrosPerMonth`（微美元）非空时以套餐为准（可以高于这里的缺省；`0` = 该套餐不能用 AI）；默认套餐种子都不设，金额待定价（D-03）。
- **模型单价**：上限按美元计算，内置单价只有 Claude。DeepSeek（`deepseek-v4-pro`，这一步带新图片时 `deepseek-flash`）、Elorian（`elorian-1-agent`）、Gemini 等要在 Worker 的 `ANCS_MODEL_PRICES_JSON` 里按供应商价格页填写（美元 / 百万 token，`cacheRead` / `cacheWrite` 可选、缺省按输入价）。
  设了上限而模型没有单价时，Worker 启动日志会列出缺单价的模型，这些模型**不会被调用**：AI 导演在对话里说明缺哪个模型的单价，画面理解显示"未配置"，学风格改用规则撰写；渲染、转写等其他任务照常。确实不想设上限就写 `ANCS_AI_MONTHLY_CAP_USD=unlimited`。
- 改金额或单价：改 `production.env` 后重启 API 与 Worker；本月已花的照常计算（已记录的费用不会按新单价重算）。
- 验证：`scripts/ai-spend-browser-check.mjs`（证据 `docs/verification/artifacts/ai-spend/`）。

### 10.6 定时维护：通知派发与保留清理（I-10）

两个维护命令以前只能手动跑：`event-dispatch`（把 Outbox 事件变成站内通知）与 `retention-sweep`（回收站到期硬删、保留期到期清理、过期上传意图、幂等键）。
不跑它们，回收站和过期文件不会被删除（违背保留期承诺，存储费用只增不减），通知也只在有人开着页面时才推进。

- **Compose（单机样例）**：`scheduler` 服务（`node apps/api/dist/cli/scheduler.js`）随编排启动，不需要另配 cron：
  - 通知派发：每 `ANCS_SCHEDULE_DISPATCH_SECONDS` 秒（缺省 60，范围 10–3600），启动时先跑一次；
  - 保留清理：每天 `ANCS_SCHEDULE_RETENTION_UTC`（缺省 `03:30`，UTC，HH:MM）；
  - 每次起一个子进程跑原命令（配置校验与逻辑都沿用命令本身，读同一个 `production.env`）；同一命令不重叠，上一轮没完就跳过这一轮；失败只记日志，下一次照常；
  - 本地存储驱动时挂与 API 同一个卷（清理要删文件）；`docker stop` 时停止排程、等正在跑的一轮结束后退出 0；
  - 日志是一行一个 JSON（`{"scheduler":{...}}`），失败与跳过写到 stderr，便于告警。
- **其他平台**：不跑 `scheduler` 服务，直接用平台调度器按同样的时间表跑原命令（同一镜像、同一套环境变量）。两个命令都可重入，偶尔重叠也安全。

  crontab（每分钟派发、每天 03:30 UTC 清理；主机时区为 UTC 时）：

  ```cron
  * * * * *  docker compose -f /srv/ancs/infra/docker-compose.prod.yml --env-file /srv/ancs/infra/production.env run --rm --no-deps api node apps/api/dist/cli/event-dispatch.js
  30 3 * * * docker compose -f /srv/ancs/infra/docker-compose.prod.yml --env-file /srv/ancs/infra/production.env run --rm --no-deps api node apps/api/dist/cli/retention-sweep.js
  ```

  Kubernetes CronJob（保留清理；通知派发同样写法，`schedule: "* * * * *"`、命令换成 `event-dispatch.js`）：

  ```yaml
  apiVersion: batch/v1
  kind: CronJob
  metadata: { name: ancs-retention-sweep }
  spec:
    schedule: "30 3 * * *"
    timeZone: "Etc/UTC"
    concurrencyPolicy: Forbid
    jobTemplate:
      spec:
        backoffLimit: 0
        template:
          spec:
            restartPolicy: Never
            containers:
              - name: retention-sweep
                image: registry.example.com/ancs:runtime
                command: ["node", "apps/api/dist/cli/retention-sweep.js"]
                envFrom: [{ secretRef: { name: ancs-production-env } }]
  ```

- 可选：`ANCS_TRASH_RETENTION_DAYS`（缺省 30）、`ANCS_IDEMPOTENCY_TTL_HOURS`（缺省 24）。
- 演练记录（2026-10-25，本容器，真实 PostgreSQL，`node apps/api/dist/cli/scheduler.js`，派发间隔 10 秒、清理时刻设为下一分钟）：
  - 数据库停着时启动：派发两次失败（各记一条 `failed`），数据库恢复后不用重启调度器，下一轮起成功；积压的 1235 条未投递事件按每轮 100 条消化到 35 条；
  - 清理在设定的那一分钟 `05:26:00` 准时开始，2.9 秒完成（删除 219 个过期幂等键），随即排到次日同一时刻；缺 `BETTER_AUTH_SECRET` 时清理命令拒绝启动，调度器记 `failed`，不吞掉错误；
  - SIGTERM：记 `stopping` / `stopped`，退出码 0；
  - `docker compose config` 解析通过（含 `scheduler` 服务）；镜像内运行未在本次演练（镜像未重建），代码与上面直接运行的是同一份构建产物。

### 10.7 运营后台的首个运营者（I-13）

运营后台（`/admin`）不认工作区角色，只认**运营身份**：某个环境下的运营者 + 角色 + 范围，外加该环境已发布、与代码一致的权限策略。以前只有测试夹具能建这些；现在用 `ops:grant`。

```bash
# 1) 先建账号（已有账号跳过）
ANCS_NEW_USER_PASSWORD='…' docker compose -f infra/docker-compose.prod.yml --env-file infra/production.env \
  run --rm --no-deps -e ANCS_NEW_USER_EMAIL=ops@example.com -e ANCS_NEW_USER_PASSWORD api node apps/api/dist/cli/create-user.js
# 2) 开通运营后台（与 API 同一个 ANCS_OPS_ENVIRONMENT；production.env 里生产为 PRODUCTION）
docker compose -f infra/docker-compose.prod.yml --env-file infra/production.env \
  run --rm --no-deps -e ANCS_OPS_GRANT_EMAIL=ops@example.com api node apps/api/dist/cli/ops-grant.js
#    可选：-e ANCS_OPS_GRANT_ROLES=PRODUCTION_OPERATOR,AUDITOR   -e ANCS_OPS_GRANT_WORKSPACES=ws_…,ws_…
```

3) 这个账号登录后打开 `/admin` → "已获运营授权，首次配置验证器" → 输入密码 → 把 otpauth URI 导入验证器 App、保存恢复码 → 输入 6 位码确认 → 重新登录（这次要输入验证码）→ 进入运营后台。命令本身不跳过 MFA、不打印任何密钥。

- **角色**（缺省 `PRODUCTION_OPERATOR`）：没有"全能管理员"。每个操作只对列出的角色开放，例如 `PRODUCTION_OPERATOR` 看概览、指标、供应商状态与工作区的作品 / 任务 / 存储；`AUDITOR` 看指标（审计日志查询还在等安全投影，暂时拒绝）；`PLATFORM_OWNER` 只看概览。完整矩阵见 `packages/auth/src/ops-permissions.ts`。机器身份 `SERVICE_ACCOUNT` 不能登录后台，命令不接受。
- **范围**：每个角色都带平台范围（平台级操作）；按工作区生效的操作只对 `ANCS_OPS_GRANT_WORKSPACES` 列出的工作区开放（最小权限，没有"所有工作区"）。
- **可重复执行**：已有的身份、角色、范围不重复写；有改动时数据库提升会话版本，已登录的运营会话需重新登录。被停用的运营身份不会被这条命令重新启用。
- **权限策略**：该环境还没有生效的策略就发布代码里的当前版本；生效的是旧版本就退役旧的、发布当前的。已发布的版本不可改写、不可删除、退役后不可复活（数据库触发器保证）。
- **审计**：每次执行写一条 `audit_log`（`ops.principal.bootstrap`，记运营身份、角色、范围与策略结果，不记邮箱）。
- **生产环境的现状**：`PRODUCTION` 下登录成功后，后台显示运营会话与"生产运营诊断暂未开放"——这是既有的有意限制，等逐动作授权的安全投影完成后才开放生产数据查询；`STAGING` / 非生产环境显示工作区诊断。
- 验证：`scripts/ops-grant-browser-check.mjs`（TEST 环境：未授权被拦 → 真实命令授权、重复执行不重复写 → 绑定验证器 → 二次验证登录 → 后台显示环境与角色；中英、深浅，证据 `docs/verification/artifacts/ops-grant/`，截图里的密钥与恢复码已模糊）；`packages/auth/src/ops-bootstrap.integration.test.ts`（真实 PostgreSQL，全部在回滚的事务里，不留不可删的策略行）。
