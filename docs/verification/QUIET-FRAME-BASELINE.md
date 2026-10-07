# Quiet Frame 前端重构前基线与测试数据库隔离

记录时间：2026-10-07。原始基线为 `main`，HEAD `2fa881db7a9d024a03b5077f197f7cedbbeea194`；唯一未跟踪文件为用户提供的 `docs/ANCS_Quiet_Frame_Design_Package.zip`。原始命令与日志保存在本地忽略目录 `.artifacts/quiet-frame-rebuild/baseline/`。

## 原有验证结果

| 命令 | 结果 |
| --- | --- |
| `pnpm verify` | 退出码 1；`secrets:check`、`lint`、`typecheck` 通过；`build` 失败，后续步骤未运行 |
| `pnpm arch:check` | 通过 |
| `pnpm test:unit` | 346/346 通过 |
| `pnpm test:web` | 72/72 通过 |
| `pnpm test:motion` | 19/19 通过 |

`build` 在 Next.js 静态预渲染时报 `/admin/page`、`/_not-found/page` 缺失和 `.next/server/vendor-chunks` 模块缺失。当时 `next dev` 正使用同一个 `apps/web/.next`，因此并发产物冲突是可能原因；需在开发服务停止后复验，不能把本次失败归为产品代码回归。

运行服务快照：Web `3000`、API `3001`、同域网关 `4000`、PostgreSQL `55432`、Redis `56379` 均监听。API 与网关 `/api/v1/health` 返回 200，服务版本 `0.0.0`。Web 首页最初返回 200；构建期间一次请求超过 10 秒。

## 共享开发库事件

首次独立启动 `pnpm test:integration` 时，当前 shell 未设置 `ANCS_TEST_DATABASE_URL` 或 `DATABASE_URL`。旧 `resolveTestDatabaseUrl()` 回退到 `ancs_dev`；`apps/worker/src/congestion.integration.test.ts` 的 `beforeEach` 对 `workspaces` 执行全表删除。发现后立即中止测试，未运行后续数据库套件。中止前日志显示该文件有 2 条测试，其中 1 条失败；整个集成套件没有完成。

事后只读 SQL 查询表明，用户浏览器 URL 中的工作区 `ws_b3dd602f-e00c-4037-89ea-575ff254ea71` 和项目 `prj_8de47190-9ad7-4f4f-a994-8f0479bb99bd` 在 `ancs_dev` 中均为 0 行；现存 1 条工作区和 1 条项目记录属于测试数据。测试前未保存这两条记录的 SQL 快照，因此无法从数据库快照精确量化被删除的全部内容。

恢复来源只读排查：PostgreSQL `archive_mode=off`，`archive_command` 未配置，复制槽为 0；Docker 只有 `infra_ancs_dev_pgdata` 普通数据卷，未发现备份卷或数据库目录中的 dump。仓库、`E:\Codes`、本地 `.artifacts` 未发现相关 dump/backup；另一个演练数据库也没有上述工作区或项目。现有本地材料不足以进行完整、可靠的时间点恢复；若用户另有外部备份或尚未刷新的浏览器缓存，应单独核查。

## 防复发修复

- `resolveTestDatabaseUrl()` 现在只接受显式 `ANCS_TEST_DATABASE_URL`，要求 PostgreSQL URL 的数据库名包含 `test`，并拒绝与 `DATABASE_URL` 完全相同的连接串。
- CI 的 PostgreSQL 数据库及测试连接统一改为 `ancs_test`。
- `create-user` CLI 继续使用开发库默认连接，不复用测试保护函数。
- 新建独立库 `ancs_quiet_frame_test_261007`。定向 `packages/db/src/transactions.test.ts` 在该库运行，5/5 通过；`@ancs/db` 与 `@ancs/auth` 的类型检查均通过。

隔离库全量 `pnpm test:integration` 退出码 1：74 个文件中 73 个通过、1 个失败；331 条断言中 330 条通过、1 条失败。失败在 `apps/api/src/content.integration.test.ts:129`，测试对未使用 `ORDER BY` 的 SQL 查询结果要求固定顺序，实际顺序为 `[3,4,0,1,2]`，预期 `[0,1,2,3,4]`。未修改该断言或降低门槛。完整日志见 `.artifacts/quiet-frame-rebuild/baseline/integration-isolated.log`。后续数据库测试必须显式设置 `ANCS_TEST_DATABASE_URL` 指向独立库。
