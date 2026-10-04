# ANCS — Creator Video OS

AI Native 视频制作平台：把文章 / 研究稳定转换为可直接发布的专业长视频。
V1 主链路：**Article / Research → Professional Long Video**。

## 文档入口

| 文档 | 用途 |
|---|---|
| `creator_video_os_spec_v0.2.md` | 产品需求与工程实现总规范（唯一需求权威） |
| `ANCS_Plan261004.md` | 工程推进细则：任务顺序、裁决、验收（开工前必读 §13.5） |
| `docs/requirements/traceability.md` | 需求追踪矩阵（REQ → 任务 → 验收） |
| `docs/requirements/v1-acceptance-ledger.md` | V1 验收账本（§77/§78/附录 C/§96 逐项关闭） |
| `docs/decisions/` | 范围与架构裁决（DEC-01..14） |
| `docs/handoffs/` · `docs/verification/` | 任务交接记录与验收证据 |

## 快速开始

要求：Node ≥ 22、pnpm 9；集成测试需要本地 PostgreSQL（Docker 提供）。

```bash
pnpm install
docker compose -f infra/docker-compose.dev.yml up -d   # 本地 PostgreSQL（端口 55432）
pnpm verify                  # secrets → lint → typecheck → build → arch:check → 全部测试套件（含真实渲染）
pnpm test:provider-smoke     # 真实 Provider smoke（默认关闭，需显式开启与凭据，会产生费用）
```

## 统一命令（计划 §11.1）

| 命令 | 说明 |
|---|---|
| `pnpm lint` | ESLint（含 TypeScript） |
| `pnpm secrets:check` | 仓库 Secret 扫描（禁止凭据入库，REQ-43-06） |
| `pnpm typecheck` | 全工作区严格类型检查 |
| `pnpm build` | 全工作区构建 |
| `pnpm arch:check` | 依赖方向强制检查（R1—R8，见 `packages/arch-check`） |
| `pnpm test:unit` | 单元测试（Vitest；含 Fastify inject 路由测试与 SDK↔API 往返） |
| `pnpm test:integration` | 真实 PostgreSQL 集成测试（事务/回滚/乐观并发原语） |
| `pnpm test:render` | 真实 Remotion 渲染（预览静帧 PNG + MP4 元数据校验；本机 Chrome 复用或自动下载 Headless Shell） |
| `pnpm test:contract` / `test:e2e` / `test:security` / `test:golden` | 尚未实现的套件以 `[PLANNED]` 显式占位，不伪造通过 |
| `pnpm test:provider-smoke` | 真实 Provider smoke，单独开启 |
| `pnpm verify` | 默认验证入口，不产生真实 Provider 费用 |

## 目录

```text
apps/        web / api / worker / render-worker（按任务逐步创建）
packages/    contracts / domain / db / providers 等共享包（按任务逐步创建）
docs/        decisions / handoffs / requirements / verification / runbooks
scripts/     仓库级验证与占位脚本
```

## ARCHITECTURE RULES

（规范附录 B；任何违反需先改架构裁决，不得绕过）

```text
1. Scene Graph is the source of truth.
2. Web is a client, not the backend.
3. All product capabilities must be reachable through versioned backend APIs.
4. Core domain code must not depend on Next.js.
5. Provider SDKs may only be used inside provider adapters.
6. Never expose provider secrets to clients.
7. Expensive generation must be asynchronous, idempotent, and queued.
8. Draft editing must not trigger expensive video generation by default.
9. Provider output URLs are temporary; persist outputs to our storage.
10. Every mutating project operation must carry a base revision.
11. Every paid generation must be written to the usage/cost ledger.
12. AI may suggest edits, but the result must be a validated structured operation.
13. Factual charts require real source data; do not invent numerical series.
14. Web, Desktop, and Mobile share the same contracts and backend.
15. Do not rebuild Premiere. AI creates; GUI corrects.
```

## 当前状态

处于 **P00 工程基线** 阶段（内部生产版本从 P00 推进至 P08）。
任务完成状态以 `docs/handoffs/` 最新记录为准；只有 `VERIFIED`（验收通过且证据齐全）计入完成。
