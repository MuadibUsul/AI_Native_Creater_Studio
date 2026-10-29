# 本地部署门结果（2026-10-29）

范围：在本地 Windows + Docker Desktop 环境上执行仓库自带的部署门禁脚本，验证「按 Runbook 可重复部署」与备份/恢复、上线门信息模式。**只运行脚本与本地环境修复，未改业务代码。**

## 环境

- 仓库：`codex/v04-foundation`（`25157f4` 之上；部署门前已有记录提交 `517ca06`）。
- 数据库：容器 `ancs-local-db`（PostgreSQL 16），`127.0.0.1:54500`；Redis `ancs-dev-redis`（`127.0.0.1:56379`）。
- 构建：复用 `pnpm build` 的 dist（`ANCS_REHEARSAL_SKIP_BUILD=1`）；演练脚本自行创建/删除临时库与存储卷。

## 结果

| 门禁 | 结果 | 说明 |
|---|---|---|
| `pnpm run deploy:rehearsal` | **11/11 PASS** | 构建/全新库（迁移 148 张表）/API `/health` 200/Worker 单轮/本地存储读写校验/6a–6c 反向配置 fail-closed/清理 |
| `pnpm run recovery:rehearsal` | **8/8 PASS** | 源库 + 固定版本 Render → TEMPLATE 副本备份 → 恢复隔离库 → 快照哈希一致 → 重渲染固定版本（→ QA，输入逐字段一致）→ 签名密钥轮换（旧 URL 失效）→ 清理 |
| `pnpm run launch:gate` | 信息模式通过（exit 0） | 机器条件 5 项不满足（live 放行被拒绝，符合 pre-launch 预期）；人工台账 APPROVED 0 / 14（全部 BLOCKED） |

## 过程中发现并修复的本地环境问题

**现象**：首次 `deploy:rehearsal` 在步骤 3 失败——`API 未就绪（exit=null）`，且没有任何 API 日志。

**根因**：本机 `.env` 的 `DATABASE_URL` 使用 `localhost`，Node 解析到 `::1`，而容器只映射 `127.0.0.1:54500`，API 的数据库连接池挂起（迁移步骤碰巧连上，造成“迁移通过但 API 起不来”的错觉）。把 `DATABASE_URL` 的主机改为 `127.0.0.1` 后，演练 11/11 通过。

**处置**：仅修改本机未跟踪的 `.env`（`localhost` → `127.0.0.1`），未进仓库。建议后续把本地 `.env` 模板与 `infra/docker-compose.dev.yml` 的绑定地址保持一致（compose 本来就用 `127.0.0.1`）。

## 复现命令

```bash
# 数据库容器
docker start ancs-local-db ancs-dev-redis

# 部署演练（复用既有 dist；如需连构建一起去掉 SKIP_BUILD）
ANCS_TEST_DATABASE_URL=postgres://…@127.0.0.1:54500/ancs_dev \
ANCS_REHEARSAL_SKIP_BUILD=1 pnpm run deploy:rehearsal

# 备份/恢复演练
ANCS_TEST_DATABASE_URL=postgres://…@127.0.0.1:54500/ancs_dev pnpm run recovery:rehearsal

# 上线门（信息模式；live 判定需运营在部署前执行 node scripts/launch-gate-check.mjs --live）
pnpm run launch:gate
```

## 结论与边界

- 本地部署门禁全部通过（部署 11/11、恢复 8/8）；上线门仍按设计停留在 pre-launch（人工台账 14 项未批准、live 机器条件不满足），**不代表可以对外收费或公开注册**。
- 本机 GPU/ffmpeg 环境与生产不同：部署演练不含讲述（flite）与真实 Provider 调用；真实 Provider 验证见各自里程碑记录。
- 本轮未部署到 `darely.xyz`：该操作需要生产机 SSH 凭据（本机现有密钥均被拒绝），另行处理。
