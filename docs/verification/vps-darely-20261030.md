# darely.xyz 生产部署（2026-10-30，a0cfff8）

状态：**已部署并验证**。线上从 `021dece` 更新到 `a0cfff8`（上传性能：素材可用时间缩短、单遍索引、排队上传）。本次仍为手动部署，不走 Veynod 部署门。

## 三端同步状态

| 端 | 提交 | 状态 |
|---|---|---|
| 本地 `codex/v04-foundation` | `a0cfff8` | 与 `origin/codex/v04-foundation` 一致 |
| GitHub `origin/codex/v04-foundation` | `a0cfff8` | 本次部署来源 |
| 生产 VPS（`darely.xyz`） | 由 `a0cfff8` 构建的 `ancs:runtime` / `ancs:worker` | 已加载并运行 |

分支审计：

- `origin/main` = `a75cd99`，比 codex 分支少 `a0cfff8`（多出的 3 个提交均为 PR #12–#14 的合并提交）；**最新代码尚未合并进 main**（项目惯例是 PR 合并，本次未改动 main）。
- `origin/docs/ai-native-studio-v03-20261008` 是旧文档分支（最后提交 `2fa881d`），未合并，保留未动。
- 本地无未推送分支、无 stash；本地 `main` 已快进到 `origin/main`。

## 构建与传输

- 本机构建（构建参数同生产：`ANCS_API_INTERNAL_URL=http://api:3001`，实时语音地址与 CSP 额外来源为空）：
  - `ancs:runtime`（`02c97c2eee97…`）
  - `ancs:worker`（`70929361da30…`，含 FFmpeg/Chromium/CJK 字体）
- 打包：`docker save ancs:runtime ancs:worker | gzip -1` → 923,055,515 字节，sha256 `c43a73caa95b4f326bc6cd362ce7ece5931e3ed4b3e3856308c2307987872a27`。
- 传输：`rsync --partial --inplace`（约 0.4 MB/s，约 37 分钟），服务器端 sha256 一致。
- 加载：`docker load -i images/ancs-images-a0cfff8.tar.gz`。

## 备份与回滚点

- 数据库备份：`~/ancs/backups/ancs-pre-20261030a.sql.gz`（305 KB；`gzip -t` 通过；149 条 `CREATE TABLE`）。
- 回滚镜像：`ancs:runtime-rollback-20261030a`、`ancs:worker-rollback-20261030a`（即 `021dece` 版本）。

## 部署与验证

```
cd ~/ancs
docker compose --env-file production.env -f docker-compose.prod.yml -f compose.caddy.yaml up -d
```

| 检查 | 结果 |
|---|---|
| 迁移 | `已是最新（共 103 个迁移；等锁 7 ms，用时 120 ms）`（本提交无新迁移） |
| 容器 | api / web / db healthy；worker / realtime Up |
| `GET https://darely.xyz/api/v1/ready` | 200 `{status:"ready", database:"ok"}` |
| `GET https://darely.xyz/sign-in` | 200 |
| `GET https://darely.xyz/` | 200 |
| Worker 启动清单 | `asr=deepgram:REAL、agent_model=deepseek:REAL、visual_analysis=elorian:REAL` |

## 已知边界（与上一次部署相同）

- `elorian-1-agent` 未定价：设置 `ANCS_AI_MONTHLY_CAP_USD` 时该模型不被调用，**画面理解不可用**；DeepSeek 导演不受影响。
- `ANCS_AIGC_PRODUCER_CODE` 未配置（AIGC 服务提供者编码为空）。
- 单机本地存储；无异地数据库备份；共享 VPS 内存紧张，Worker 渲染高峰需观察 OOM/swap。

## 回滚

```
cd ~/ancs
ANCS_RUNTIME_IMAGE=ancs:runtime-rollback-20261030a \
ANCS_WORKER_IMAGE=ancs:worker-rollback-20261030a \
docker compose --env-file production.env -f docker-compose.prod.yml -f compose.caddy.yaml up -d
```

数据库恢复（仅在确认需要时）：`gunzip -c backups/ancs-pre-20261030a.sql.gz | docker exec -i ancs-db-1 psql -U ancs -d ancs`。
