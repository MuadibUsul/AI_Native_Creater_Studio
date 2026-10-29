# darely.xyz 生产部署（2026-10-29）

状态：**已部署并验证**。本次为手动部署（按项目所有者要求，不走 Veynod 部署门）。线上从 `520a60d` 更新到 `021dece`。

## 目标与环境

- 域名 `darely.xyz` / `www.darely.xyz` → `104.207.82.85`（与 `veynod.com` 同一台共享 VPS），Caddy 终止 TLS。
- 目录 `~/ancs`（用户 `deploy`），Compose 项目 `ancs`；服务 `db`、`migrate`、`api`、`worker`、`realtime`、`web`。
- 资源：5.8 GiB 内存（部署时可用约 2.2 GiB，swap 已用约 3.3 GiB）、磁盘 62 GB 可用。
- SSH：`deploy@104.207.82.85`，密钥 `tline_vps_actions2`（WSL 内）。

## 构建与传输

- 本机构建（Docker Desktop）：
  - `docker build --target runtime -t ancs:runtime --build-arg ANCS_API_INTERNAL_URL=http://api:3001 --build-arg NEXT_PUBLIC_ANCS_REALTIME_URL= --build-arg ANCS_CSP_EXTRA_ORIGINS= .`
  - `docker build --target worker -t ancs:worker .`
  - 产物：`ancs:runtime` 3.06 GB（`c92338e46163`）、`ancs:worker` 5.09 GB（`73a225e6c354`）；worker 内含 FFmpeg 5.1.9（含 flite 滤镜）、Chromium、30 个 CJK 字体。
- 打包：`docker save ancs:runtime ancs:worker | gzip -1` → 908,725,280 字节，sha256 `7e1312871eb9a8e9f2b9f156fedd74edd47fe9b8c21fc88a0761dfdcdc225f11`。
- 传输：首轮 `scp` 在 764 MB 时被服务器断开（连接异常）；用 `rsync --partial --append-verify` 续传（增量 144 MB），两端 sha256 一致。
- 服务器加载：`docker load -i images/ancs-images-021dece.tar.gz` → `ancs:runtime` 3.06 GB、`ancs:worker` 5.09 GB。

## 备份与回滚点

- 数据库备份：`~/ancs/backups/ancs-pre-20261029-1902.sql.gz`（121 KB；`gzip -t` 通过；含 148 条 `CREATE TABLE`）。
- 回滚镜像：`ancs:runtime-rollback-20261029-1902`（3.11 GB）、`ancs:worker-rollback-20261029-1902`（5.14 GB）。

## 部署

```
cd ~/ancs
docker compose --env-file production.env -f docker-compose.prod.yml -f compose.caddy.yaml up -d
```

- 迁移：`[migrate] postgres://***@db:5432/ancs：已是最新（共 103 个迁移；等锁 5 ms，用时 304 ms）`。
- 容器：`ancs-api-1`、`ancs-web-1`、`ancs-db-1` healthy；`ancs-worker-1`、`ancs-realtime-1` Up。

## 验证

| 检查 | 结果 |
|---|---|
| `GET https://darely.xyz/api/v1/ready` | 200 `{status:"ready", checks.database:"ok"}` |
| `GET https://darely.xyz/sign-in` | 200 |
| `GET https://darely.xyz/` | 200 |
| Web CSP | `connect-src 'self'`（本地存储与页面同源，直传经同源代理） |
| Worker 启动清单 | `asr=deepgram:REAL、agent_model=deepseek:REAL、visual_analysis=elorian:REAL` |
| 真实浏览器 | `/sign-in` 渲染 Kinora 登录页，截图 `docs/verification/artifacts/vps-darely/04-kinora-sign-in-20261029.png` |

## 已知边界与告警

- **Elorian 未定价**：Worker 日志提示“设了 `ANCS_AI_MONTHLY_CAP_USD`，但 `elorian-1-agent` 没有单价；补上单价前不会调用它”，因此**画面理解不可用**（该账户余额也是 $0）。AI 导演（DeepSeek 已配峰值价）不受影响。
- `ANCS_AIGC_PRODUCER_CODE` 未配置：含 AI 生成内容的成片仍带显式标识与 AIGC 元数据，但服务提供者编码为空（面向中国境内公众前必须配置）。
- 单机本地存储（`/data/storage` 卷）；未配置异地数据库备份；共享 VPS 内存紧张，Worker 渲染高峰需观察 OOM/swap（worker 上限 1280m）。
- 本次未改 Caddy；`darely.xyz` 继续转发 `web` / `realtime`。

## 回滚

1. 用回滚镜像重建：`cd ~/ancs && ANCS_RUNTIME_IMAGE=ancs:runtime-rollback-20261029-1902 ANCS_WORKER_IMAGE=ancs:worker-rollback-20261029-1902 docker compose --env-file production.env -f docker-compose.prod.yml -f compose.caddy.yaml up -d`。
2. 如需恢复数据库：`gunzip -c backups/ancs-pre-20261029-1902.sql.gz | docker exec -i ancs-db-1 psql -U ancs -d ancs`（破坏性操作，先确认）。
3. 回滚后同样用 `/api/v1/ready` 与 `/sign-in` 验证。
