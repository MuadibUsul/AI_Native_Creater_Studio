# ANCS — Creator Video OS

AI Native 视频制作平台：在同一工程内核中制作真实素材剪辑、生成内容和混合视频。文章／研究转长视频保留为其中一个入口。当前增量工程以 v0.4 的 N 系列任务和真实证据推进。

## 文档入口

| 文档 | 用途 |
|---|---|
| `docs/V04/ANCS_AI_Native_v0.4.md` | 当前需求权威；冲突优先级见 §1.4 |
| `docs/V04/ANCS_v0.4_Codex_Start.md` | 接手和增量开发顺序 |
| `docs/V04/ANCS_v0.4_Task_Backlog.md` · `ANCS_v0.4_Traceability.md` | N 系列任务及需求来源（初始 TODO 不代表仓库实际状态） |
| `docs/requirements/ai-native-v04-traceability.md` · `ai-native-v04-acceptance-ledger.md` | v0.4 实际状态和验收证据 |
| `docs/decisions/` | 范围与架构裁决；0009 记录 v0.4 替换关系 |
| `creator_video_os_spec_v0.2.md` · `ANCS_Plan261004.md` | 历史 V1 规范与 P 系列计划；不再单独指挥当前 N 任务 |
| `docs/requirements/traceability.md` · `v1-acceptance-ledger.md` | 历史 V1 证据，不用 v0.4 初始 TODO 清零 |
| `docs/handoffs/` · `docs/verification/` | 任务交接记录与验收证据 |

## 快速开始

要求：Node ≥ 22、pnpm 9；集成测试需要本地 PostgreSQL（Docker 提供）。

```bash
pnpm install
docker compose -f infra/docker-compose.dev.yml up -d   # 本地 PostgreSQL（端口 55432）
# 先创建独立测试库，并将 ANCS_TEST_DATABASE_URL 显式指向数据库名含 test 的 PostgreSQL URL
pnpm verify                  # secrets → lint → typecheck → build → arch:check → 全部测试套件（含真实渲染）
pnpm test:provider-smoke     # 真实 Provider smoke（默认关闭，需显式开启与凭据，会产生费用）
```

## 验证命令

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
| `pnpm test:golden` | 金样完整性：结构 / 来源哈希 / 可追溯性 / §80 场景覆盖 / 合成负面用例（Director 与组件回归自 P04/P05 加入） |
| `pnpm test:contract` / `test:e2e` | 尚未实现的套件以 `[PLANNED]` 显式占位，不伪造通过 |
| `pnpm test:security` | 现有安全测试；新增 v0.4 攻击面仍须逐项验证 |
| `pnpm test:provider-smoke` | 真实 Provider smoke，单独开启 |
| `pnpm verify` | 默认验证入口，不产生真实 Provider 费用 |

## 目录

```text
apps/        web / api / worker / render-worker / motion-worker
packages/    contracts / domain / db / sdk / providers 等 11 个既有包
docs/        V04 / decisions / handoffs / requirements / verification / runbooks
scripts/     仓库级验证脚本和显式占位脚本
```

## ARCHITECTURE RULES

当前规则以 v0.4 §12—§15 和裁决 0009 为准；旧安全、版本、账本、可恢复与多端原则继续生效。任何违反需先改架构裁决，不得绕过。

```text
1. ProjectDocument is the sole work-state authority; SemanticPlan and Composition are linked views.
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
15. Professional direct editing and AI editing share validated Edit Operations, revisions, and history.
16. FOOTAGE_EDIT, GENERATIVE, and HYBRID share one kernel; protect originals and confirmed work.
```

## 当前状态

截至 2026-10-08，旧 P 系列与 Quiet Frame Web 检查记录保存在 `docs/quiet-frame-rebuild/FINAL_HANDOFF.md` 和 `docs/verification/QUIET-FRAME-REBUILD.md`。用户现已明确要求启动 v0.4 增量工程；新 N 系列进度见 v0.4 活账本和最新 `docs/handoffs/N*.md`。旧 P15/P16 的暂停不等于新 N15/N16 的暂停。只有任务验收与证据齐全的 `VERIFIED` 计入新版本完成；Mock、视觉复拍、接口存在均不能替代真实媒体或 Provider 验收。
