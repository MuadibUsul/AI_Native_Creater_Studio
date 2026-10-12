# ANCS — Creator Video OS

AI Native 视频制作平台。V6 的核心体验是**共看片室**：你和 AI 一起看同一条视频，用说话、点选和拖选告诉它改哪里，AI 原地试改给你看，你说"就这样"才采用，随时撤销；改哪里只重渲哪里。真实素材剪辑、生成内容和混合视频共用一个工程内核。

## 文档入口

| 文档 | 用途 |
|---|---|
| `docs/V06/ANCS_v0.6_Product_Architecture.md` | **唯一权威**：V6 产品架构与里程碑 V6-0—V6-8（裁决 `docs/decisions/0018-v6-adoption.md`） |
| `docs/V06/milestones/` | 每个里程碑的交付、验收命令与结果、未验证项 |
| `docs/V06/integration-checklist.md` | **外部能力接入清单**：要配哪些密钥、配在哪、没配时的表现、配好后怎么验证 |
| `docs/V06/eval/first-cut-rubric.md` | 初剪评测：人工评分标准、自动指标、怎么跑 |
| `docs/V05/ANCS_v0.5_Architecture.md` · `docs/decisions/0011`—`0017` | 继续有效的架构骨架（纯函数内核、操作日志、RenderPlan、Provider Gateway） |
| `docs/V04/` | 需求与交互细节参考库（N 系列账本冻结为历史，`pnpm spec:check` 仍校验） |
| `docs/ops/deployment-runbook.md` | 部署步骤与环境变量校验 |
| `AGENTS.md` | 代理协作规则与禁止事项（接手前必读） |

## 现在做到哪了（2026-10-12）

| 里程碑 | 内容 | 状态 |
|---|---|---|
| V6-0 | 工作流引擎 + FFmpeg 终渲染（素材工程导出） | 已交付，真实 FFmpeg 验证 |
| V6-1 | 共看片室最小闭环：上传 → AI 剪第一版（风格可选）→ 点选/拖选 + 文字 → 原地试改 → 采用/撤回 → 局部预览 → 导出；中英双语界面；AI 自检；初剪评测框架 | 已交付，真实浏览器 + 真实 FFmpeg 验证；**AI 导演用脚本导演验证，真实 Claude 待密钥** |
| V6-2 | 流式双语语音 + 共同注意力：共看片室里边看边说，边说边出文字，“这个/这里”按说出那一刻绑定，没说完先等后半句；新进程 Realtime Gateway | 已交付，真实浏览器（假麦克风）+ 真实网关验证；**流式识别用本地同协议假服务，真实 Deepgram 待密钥**；AI 语音回应暂用浏览器朗读 |
| V6-3 | 代码生成特效（模板库 + 沙箱渲染 + 合成） | 未开始 |
| V6-4 | 批注式审片：手机或桌面逐处标记（位置 + 一句话 + 可选框选）→ 逐条和 AI 讨论方案 → 一次执行 → 只重渲改动的分段 → 采用；可添加到主屏幕 | 已交付，真实浏览器（手机 + 桌面）+ 真实 FFmpeg 验证；**AI 为脚本导演，真实 Claude 待密钥**；语音批注随 V6-2 |
| V6-5 — V6-8 | 讲述配音、蒸馏器（参考视频 → 风格）、数字人、生成式特效与视频生成 | 未开始 |

只有带证据的 `VERIFIED` 计入完成；脚本模型 / Mock 通过 ≠ 真实 Provider 通过。各里程碑的"未验证与待办"见 `docs/V06/milestones/`。

## 需要你提供的外部能力

不配任何密钥，平台也能跑起来：剪辑内核、素材探测/代理/镜头切分、预览、导出、共看片室界面都是真实可用的；AI 相关能力会明确显示"未配置"，不会假装成功。要让 AI 真正剪片，至少在 **Worker** 进程配置：

```bash
ANCS_AGENT_DRIVER=anthropic
ANTHROPIC_API_KEY=…            # 只放在服务端环境变量 / 密钥管理，不要提交、不要贴到聊天里
ANCS_VISUAL_ANALYSIS_DRIVER=anthropic   # 可选：素材画面理解
ANCS_ASR_DRIVER=deepgram       # 可选：素材语音转写
DEEPGRAM_API_KEY=…
# 实时语音：API 与 Realtime Gateway 两个进程都配同一把会话密钥（≥32 字符），网关另配识别驱动
ANCS_VOICE_SESSION_SECRET=…
ANCS_REALTIME_ASR_DRIVER=deepgram
```

完整清单（每项的作用、没配时的表现、验证方法）见 `docs/V06/integration-checklist.md`。

## 快速开始

要求：Node ≥ 22（部署用 24）、pnpm 9、FFmpeg/ffprobe；集成测试需要本地 PostgreSQL 16 与 Redis（Docker 提供）。

```bash
pnpm install
docker compose -f infra/docker-compose.dev.yml up -d   # 本地 PostgreSQL（55432）与 Redis（56379）
# 先创建独立测试库，并将 ANCS_TEST_DATABASE_URL 显式指向数据库名含 test 的 PostgreSQL URL（ANCS_TEST_REDIS_URL 同理）
pnpm verify                  # secrets → spec → lint → typecheck → build → arch → capabilities → 全部测试套件（含真实渲染）
```

本地运行（环境变量以 `.env.example` 为模板，步骤与迁移命令见 `docs/ops/deployment-runbook.md`）：

```bash
pnpm build
node apps/api/dist/index.js          # API（缺省 3001）
node apps/worker/dist/main.js        # Worker（在仓库根启动）
node apps/realtime/dist/main.js      # Realtime Gateway（实时语音，可选；缺省 3002，反向代理转发 /realtime/v1/voice）
cd apps/web && npx next start -p 3000
```

登录后在首页点"进入共看片室"新建作品（路由 `/w/<workspaceId>/studio/new`），放入素材，点"让 AI 剪第一版"。看完后点顶栏"审片"（`/w/<workspaceId>/review/<projectId>`，手机上可添加到主屏幕）逐处标记问题、和 AI 商量后一次改完。

## 验收与评测脚本

| 命令 | 说明 |
|---|---|
| `node scripts/studio-browser-check.mjs` | 共看片室端到端：真实浏览器 + 真实 API/Worker/FFmpeg，脚本导演；截图写入 `docs/verification/artifacts/v6-1c/`（需要支持 H.264 的 Chrome，`ANCS_BROWSER_EXECUTABLE` 指定） |
| `node scripts/voice-browser-check.mjs` | 实时语音端到端：Chrome 假麦克风 → AudioWorklet → 网关 → 流式识别（本地同协议假服务）→ 指代绑定 → 试改；中英文；截图写入 `docs/verification/artifacts/v6-2/` |
| `node scripts/review-browser-check.mjs` | 批注式审片端到端：手机 390×844 触屏 + 桌面，真实 API/Worker/FFmpeg，脚本导演；截图写入 `docs/verification/artifacts/v6-4/` |
| `node scripts/eval-first-cut.mjs` | 初剪评测冒烟（`evals/first-cut/smoke.json`，脚本导演，只证明框架可用） |
| `node scripts/eval-first-cut.mjs --set evals/first-cut/travel.json --model anthropic --export` | 真实模型初剪评测：自动指标 + 人工评分表 + 导出成片（需 `ANTHROPIC_API_KEY`，素材放 `Videos/`，见评分标准文档） |
| `node scripts/fetch-pexels-footage.mjs --query "iceland road trip"` | 从 Pexels 下载免费测试素材到 `Videos/pexels/`（不入库），同时生成作者署名与可直接使用的评测用例集；需要 `PEXELS_API_KEY`，云端会话还需放行 `api.pexels.com`、`videos.pexels.com` 并加 `NODE_USE_ENV_PROXY=1` |
| `pnpm test:provider-smoke` / `pnpm provider:verify` | 真实 Provider 探测，默认关闭，需显式开启与凭据，会产生费用 |

## 验证命令

| 命令 | 说明 |
|---|---|
| `pnpm verify` | 默认验证入口，不产生真实 Provider 费用 |
| `pnpm secrets:check` | 仓库 Secret 扫描（禁止凭据入库） |
| `pnpm spec:check` | 历史账本一致性 |
| `pnpm lint` / `pnpm typecheck` / `pnpm build` | ESLint、全工作区严格类型检查、构建 |
| `pnpm arch:check` | 依赖方向与架构规则（含 R11 组合表只经投影器写入、R12 业务包禁读 `process.env`） |
| `pnpm capabilities:check` | 编辑能力覆盖账本与注册表/测试一致（改动后运行 `pnpm capabilities:generate`） |
| `pnpm test:unit` / `test:web` / `test:integration` | 单元（含内核纯函数）、Web 组件、真实 PostgreSQL + FFmpeg 集成测试 |
| `pnpm test:render` / `test:golden` / `test:security` | 真实渲染、金样完整性、安全测试 |
| `pnpm test:contract` / `test:e2e` | 尚未实现的套件以 `[PLANNED]` 显式占位，不伪造通过 |

## 目录

```text
apps/        web（Next.js，共看片室、审片）/ api（Fastify）/ worker（任务与工作流）/ realtime（实时语音网关）/ render-worker / motion-worker
packages/    contracts / kernel（纯函数编辑内核）/ time / domain / db / sdk / providers / arch-check 等
evals/       评测用例集（初剪金样集模板与冒烟集）
docs/        V06 / V05 / V04 / decisions / ops / verification / handoffs
scripts/     验证、验收、评测脚本（scripts/lib：共看片室进程内环境与脚本导演）
```

## ARCHITECTURE RULES

V6 不改变以下底线；V5 增加的约束（纯函数内核、操作日志为权威、外部调用只经工作流与 Provider Gateway、AI 导演与调度不得按视频类型分支）见 `AGENTS.md`。任何违反需先改架构裁决，不得绕过。

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
