# 监控与恢复（P08-03 / 规范 §44、§71、§72）

> 本文是 P08-03 的操作手册与阈值清单：日志字段与脱敏、指标导出、告警条件、
> 备份/PITR 策略、恢复流程、密钥轮换流程。
> 可执行证据：`pnpm run recovery:rehearsal`（备份 → 隔离恢复 → 读取固定版本 → **重渲染** → 密钥轮换断言；
> CI 每次推送执行）。

## 1. 日志（§44 / §75）

- **结构化日志**：API 使用 Fastify/pino JSON 日志；请求 ID 贯穿（客户端可提供合法 `X-Request-Id`，
  否则服务端生成 `req_*`——`apps/api/src/server.ts` 的 `genReqId`）。
- **Secret 脱敏（强制）**：logger 配置对所有请求 redact
  `req.headers.authorization`、`req.headers.cookie`、`res.headers["set-cookie"]` → `[REDACTED]`。
- **严禁**：日志不得记录 Provider Key、会话令牌、未发布正文（§75；错误返回同样只给 code/message/requestId）。
- 任务/渲染/QA/审批的运行轨迹以**事件与审计记录**为准（Outbox `job.*`、`render_events`、`render_qa_reports`、
  `render_approvals`），日志仅作辅助（§24：Intent History 与 Audit 分离）。

## 2. 指标（§44 MUST 清单 → 落地口径）

导出：`GET /api/v1/admin/metrics`（Prometheus 文本格式 0.0.4；仅平台管理员，非管理员 404 反枚举）。

| §44 指标 | 落地指标名 | 来源 |
|---|---|---|
| API error rate | `ancs_api_requests_total{class="2xx/3xx/4xx/5xx"}` | 进程内中间件（重启归零） |
| API p50/p95 延迟 | `ancs_api_request_duration_seconds_bucket{le}` + `..._p50/p95_seconds`（桶估算） | 同上（精确分位随外部后端） |
| Queue depth / Job age | `ancs_jobs{status=}`、`ancs_jobs_oldest_active_seconds` | jobs 表 |
| Provider 失败/状态/成本 | `ancs_provider_generations{status=}`、`ancs_credits_debits_total` | provider_generations / credit_ledger |
| Render duration/failure | `ancs_renders{status=}`（时长口径：READY 渲染的 updated-created，随外部后端细化直方图） | renders 表 |
| QA 通过率 | `ancs_qa_reports_total{verdict,window="24h"}` | render_qa_reports |
| 审批 | `ancs_approvals_total{decision}` | render_approvals |
| 按 workspace 花费 | `client.admin.overview()` 聚合 + `/admin` 页面（V1 为平台口径；按租户明细随外部后端） | credit_ledger |
| Object storage usage / DB 性能 | **未交付**（本地驱动无用量 API；DB 指标随外部指标后端）——诚实记录 | — |

## 3. 告警条件（阈值集中定义：`OPS_ALERT_THRESHOLDS`，`GET /admin/overview` 附带 `alerts`）

| 告警 ID | 级别 | 条件 | 阈值 |
|---|---|---|---|
| `JOBS_FAILED_FINAL` | CRITICAL | 终态失败任务数 > | 0 |
| `JOBS_FAILED_RETRYABLE_HIGH` | WARNING | 待重试失败任务数 > | 10 |
| `JOBS_NEEDS_RECONCILIATION` | CRITICAL | 需对账任务数 > | 0（绝不自动重复付费提交，§5.6） |
| `QUEUE_BACKLOG` | WARNING | 最老在途任务年龄（秒）> | 600 |
| `QA_FAIL_RATE_24H` | WARNING | 24h QA 未通过数 > | 5 |

阈值变更：改常量 + 同步本表与运行手册（评审流程同代码）。外部 Alertmanager/通知渠道接入属部署环境特化
（`/admin/metrics` 可直接被 Prometheus 抓取，告警规则即上表）。

## 4. 备份 / PITR 策略（§72）

- **本地/演练口径**：点即物理副本 `CREATE DATABASE <backup> TEMPLATE <source>`（等价演练物）；
- **生产口径（目标）**：PostgreSQL `pg_basebackup` 全量 + WAL 归档（PITR，可恢复到任意时间点）；
  对象存储：云适配器阶段启用 versioning/复制（本地驱动无 versioning——诚实记录）；
- **保留**：删除策略与备份保留分离（§72）：软删（Trash 30 天）不豁免备份；备份保留窗口由部署策略定；
- **恢复点目标**：演练覆盖"备份 → 隔离库恢复 → 固定版本可读可重渲"；RPO/RTO 数值随生产环境评估（P08-04）。

## 5. 恢复流程（RTO 演练步骤 = `pnpm run recovery:rehearsal` 的步骤）

1. 预检：目标 PostgreSQL 可达；确认源库/备份标识；
2. 恢复数据库：`CREATE DATABASE <restored> TEMPLATE <backup>`（生产：`pg_restore`/PITR 到时间点）；
3. 核对 schema：迁移版本一致性（`runMigrations` 幂等执行，确认无待应用迁移）；
4. **读取固定版本**：`projectVersion` 快照可读且哈希与事故前记录一致（`--verify`）；
5. **重渲染固定版本**：以同一 `projectVersionId` 创建 Render 并真实执行（渲染输入 = 不可变快照引用），
   期望进入 QA 且渲染输入逐字段与原始一致（`--rerender`）；
6. 存储：对象按 `storage_key` 可达（本地卷挂载/云桶恢复）；
7. 恢复后重新签发签名 URL（密钥轮换见下节）。

## 6. 密钥轮换流程（与影响面）

| 密钥 | 轮换影响 | 步骤 |
|---|---|---|
| `BETTER_AUTH_SECRET`（会话/令牌签名） | 既有会话/原生令牌**全部失效**（用户需重新登录） | 1) 双密钥窗口（如需零中断，外部签发层）→ 2) 更新 Secrets → 3) 滚动重启 API/Worker → 4) 通知用户重新登录 |
| `ANCS_STORAGE_SECRET`（本地存储签名 URL，未配置时由 BETTER_AUTH_SECRET 派生） | 在途签名 URL（TTL 15 分钟）立即失效；已下载对象不受影响 | 1) 生成新密钥 → 2) 更新 Secrets → 3) 重启 → 4) 客户端/运营重新获取下载链接 |
| 凭据密文根密钥（credential vault 的 KMS 根） | Provider 凭据密文需以旧根解密后再以新根加密（本地实现 `provider/*` 凭据表） | 1) 导出/重加密脚本（真实 KMS 阶段补）→ 2) 验证连接测试 → 3) 记录审计 |

演练证据（适配器级断言）：轮换后**旧签名 URL 校验失败、新签名有效**（`recovery:rehearsal` 步骤 6）。

## 7. 已知边界（诚实记录）

1. API 指标为**进程内**累计（多副本各自导出，重启归零）；外部指标后端（Prometheus/OTel/Sentry）为部署环境特化。
2. 无外部 Alertmanager 时，告警 = 计算条件（`/admin/overview.alerts`）+ `/admin` 页面展示 + 本表阈值；通知渠道随环境。
3. 对象存储用量与 DB 性能指标未交付（本地驱动/外部后端依赖）；Render 时长直方图未细分（现状：状态计数）。
4. PITR（WAL 归档）与云存储 versioning 属生产部署配置，本地演练以 TEMPLATE 副本为等价物（明确标注，不冒充 PITR）。
