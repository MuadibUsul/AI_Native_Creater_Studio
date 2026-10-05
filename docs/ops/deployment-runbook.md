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
| 对象存储 | V1 使用**本地驱动**（`ANCS_STORAGE_DRIVER=local`，目录挂载持久卷）；S3/R2 适配器属后续阶段 |
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
| `PORT` | `3001` | API 端口 |
| `BETTER_AUTH_URL` | `http://localhost:$PORT` | 对外基址（签名/回调） |
| `ANCS_STORAGE_DRIVER` | `local` | **仅 local**（s3/r2 未实现 → 启动失败，不静默降级） |
| `ANCS_STORAGE_LOCAL_DIR` | `.storage` | 本地存储根目录（挂持久卷；只存 storage_key） |
| `ANCS_STORAGE_PUBLIC_BASE_URL` | `BETTER_AUTH_URL` | 签名 URL 的对外基址 |
| `ANCS_LLM_DRIVER` / `ANCS_TTS_DRIVER` | `mock` | **仅 mock**（真实驱动随凭据接入；未知名 → 启动失败） |
| `ANCS_QUEUE_DRIVER` | `db` | `db` 轮询（权威状态即队列）或 `bullmq`（需 `REDIS_URL`） |
| `REDIS_URL` | — | `ANCS_QUEUE_DRIVER=bullmq` 时必填 |
| `ANCS_NATIVE_CLIENTS` | — | 原生客户端注册（JSON 数组） |
| `ANCS_WEBHOOK_SECRETS` | — | Provider 回调验签密钥（JSON） |
| `REMOTION_BROWSER_EXECUTABLE` | 自动检测 | 指定 Chrome/Headless Shell 可执行文件 |

密钥轮换：轮换 `BETTER_AUTH_SECRET` 会失效既有会话与本地存储签名 URL（TTL 15 分钟内的下载链接立即失效）；
轮换存储签名密钥（未显式配置时由 `BETTER_AUTH_SECRET` 派生）同理会失效在途签名链接。轮换窗口与步骤见 P08-03。

## 3. 数据库

```bash
# 预检
psql "$DATABASE_URL" -c 'select 1'
# 迁移（drizzle-kit 生成的版本化迁移；幂等，可重复执行）
node -e "import('@ancs/db').then(async ({createDb,runMigrations})=>{const h=createDb(process.env.DATABASE_URL);await runMigrations(h);console.log('migrated');await h.close();})"
# 核对（表数量应 ≥ 30；当前 54）
psql "$DATABASE_URL" -c "select count(*) from information_schema.tables where table_schema='public'"
```

## 4. 存储卷

- 本地驱动：`ANCS_STORAGE_LOCAL_DIR` 指向**持久卷**（容器部署挂卷）；目录自动创建；
- 校验：写入/读取/校验和（`scripts/deploy-rehearsal.mjs` 步骤 5 自动执行）；
- 数据库只存 `storage_key`（绝不存对象 URL）；签名 URL TTL 15 分钟（上传/下载）。

## 5. 启动与健康检查

```bash
# API
node apps/api/dist/index.js            # 期望日志：数据库（脱敏连接串）；GET /api/v1/health → 200
# Worker（仓库根启动；渲染/验证器路径缺失会在启动时失败并说明原因）
node apps/worker/dist/main.js          # 常驻循环；或 --once 单轮自检
```

健康检查：`GET /api/v1/health`（无需认证）→ `{ "status": "ok", "service": "ancs-api", ... }`。

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
- `ANCS_STORAGE_DRIVER=s3` → 启动失败并提示"仅支持 local"；
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
  `BETTER_AUTH_URL=https://…`、`ANCS_PLATFORM_ADMINS` 非空。
- **人工条件台账**：`docs/ops/launch-gate.md`（LG-01…LG-14：Provider 条款/白标许可/协议/Consent/
  Content·Abuse·Privacy·ToS·DPA/主体税务/正式支付开通/Remotion 授权/政策上线/保留口径）——
  现状**全部 BLOCKED**（需人工：法务/商务/财务）；`APPROVED` 必须附可核对证据。
- **放行顺序**：台账逐条举证 → `--live` 判定通过 → 以 live 配置部署（启动再校验一次）；
  当前无公开注册端点（账号经内部 CLI 创建），与门禁一致。
