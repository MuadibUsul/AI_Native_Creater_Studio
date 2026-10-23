# darely.xyz 生产部署（2026-10-23）

状态：**已部署并完成真实浏览器登录验证**。部署提交 `c5c979e`（DeepSeek/Elorian provider 接入后的分支头）。

## 目标与环境

- 域名 `darely.xyz` / `www.darely.xyz` 指向 `104.207.82.85`，由服务器上共享的 Caddy 容器终止 TLS。
- 该域名此前服务 IBET 工程预览；本次按项目所有者要求转给 ANCS。IBET 的容器已停止，**数据卷保留**，未删除。
- 服务器为多项目共享 VPS（4 核 / 5.8 GiB / 4 GiB swap），ANCS 以独立 Compose 项目 `ancs` 运行，目录 `~/ancs`。
- 服务：`db`、`migrate`、`api`、`worker`、`realtime`、`web`；本地存储卷 `ancs_storage`，数据库卷 `ancs_pgdata`。
- 镜像 `ancs:runtime`（约 3.0 GB）与 `ancs:worker`（约 5.0 GB，含 FFmpeg、Chromium、中日韩字体）在本机构建后经 SSH 传输并 `docker load`，避免在内存紧张的生产机上升级构建。

## 配置（只列变量名，值只在服务器）

`~/ancs/production.env`（权限 600）包含：

- 数据库：`POSTGRES_USER`、`POSTGRES_PASSWORD`、`POSTGRES_DB`、`DATABASE_URL`
- 地址：`BETTER_AUTH_URL`、`ANCS_PUBLIC_WEB_URL`、`ANCS_STORAGE_PUBLIC_BASE_URL`、`ANCS_ALLOWED_ORIGINS` 均为 `https://darely.xyz`
- 密钥（四把互不相同）：`BETTER_AUTH_SECRET`、`ANCS_STORAGE_SECRET`、`ANCS_CREDENTIAL_KEYS`、`ANCS_VOICE_SESSION_SECRET`
- 生产约束：`NODE_ENV=production`、`ANCS_OPS_ENVIRONMENT=PRODUCTION`、`ANCS_TRUST_PROXY_HOPS=1`、`ANCS_RATE_LIMIT=enforce`
- 存储：`ANCS_STORAGE_DRIVER=local`、`ANCS_STORAGE_LOCAL_DIR=/data/storage`
- AI：`ANCS_AI_MONTHLY_CAP_USD=20`；`ANCS_AGENT_DRIVER=deepseek`（`deepseek-v4-pro`）；`ANCS_VISUAL_ANALYSIS_DRIVER=elorian`（`elorian-1-agent`）；`ANCS_ASR_DRIVER=deepgram`；`ANCS_REALTIME_ASR_DRIVER=deepgram`
- 账号：`ANCS_SIGNUP_MODE=closed`（尚未配置 SMTP，不能自助注册或找回密码）

Caddy 接入文件 `~/ancs/compose.caddy.yaml` 把 `web` 和 `realtime` 加入共享外部网络 `web`（别名 `ancs-web`、`ancs-realtime`），并设置单服务内存上限（web 512m、realtime 256m、api 640m、worker 1280m、db 512m）。

## Caddy 切换

- 部署前备份：`/opt/caddy/Caddyfile.before-ancs-20261023`
- `darely.xyz`：`/realtime/v1/voice*` 转发到 `ancs-realtime:3002`，其余转发到 `ancs-web:3000`
- `www.darely.xyz`：301 到根域名
- 候选配置先经 `caddy validate` 通过，再热重载；未改动其他站点块。

## 验证结果

| 检查 | 结果 |
|---|---|
| `https://darely.xyz/sign-in` | 200，标题 `Creator Studio · ANCS` |
| `https://darely.xyz/api/v1/ready` | 200 `{status:"ready", checks.database:"ok"}` |
| `https://www.darely.xyz/` | 301 → `https://darely.xyz/` |
| `GET /realtime/v1/voice`（HTTP/1.1 + Upgrade） | 401（到达网关；无会话凭证时预期） |
| 容器状态 | 五个服务均 Up，`api`/`web`/`db` healthy；重启次数 0，OOM 0 |
| Worker 驱动 | `asr=deepgram:REAL、agent_model=deepseek:REAL、visual_analysis=elorian:REAL` |
| 真实浏览器 | 登录 `owner@darely.xyz` 后跳转 `/`，工作台正常渲染；截图 `docs/verification/artifacts/vps-darely/01-signed-in.png` |

迁移任务在 API/Worker 前执行并成功退出；应用了当时的全部迁移（100 个）。

## 已知边界

- `ANCS_SIGNUP_MODE=closed`、未配 SMTP：只能用 CLI 建号；配好 SMTP 后可切 `invite`。
- Elorian 账户余额仍为 $0，真实画面理解会返回不可重试的 429；额度充值后才能验证。
- 单机本地存储：API 与 Worker 共用卷；多机扩容需切 S3（手册 §10.3）。
- 未配置定时数据库备份；正式对外前需补 `pg_dump` 与异地副本。
- 共享 VPS 内存紧张（可用约 1.7 GiB，swap 已用 2.9 GiB）；Worker 渲染高峰需观察 OOM 与 swap，必要时先停 worker 或扩容。
- 实时语音 TTS 未配置（`ANCS_REALTIME_TTS_DRIVER` 空），使用浏览器朗读；识别为 Deepgram。

## 回滚

1. `cd ~/ancs && docker compose --env-file production.env -f docker-compose.prod.yml -f compose.caddy.yaml down`（保留卷）。
2. `cp /opt/caddy/Caddyfile.before-ancs-20261023 /opt/caddy/Caddyfile && docker exec caddy-caddy-1 caddy reload --config /etc/caddy/Caddyfile`。
3. 如需恢复 IBET：`docker start ibet-preview-db-1 ibet-preview-worker-1 ibet-preview-web-1`（域名仍指回 ANCS 时需相应恢复其 Caddy 站点块）。
