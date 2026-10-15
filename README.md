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

## 现在做到哪了（2026-10-14）

| 里程碑 | 内容 | 状态 |
|---|---|---|
| V6-0 | 工作流引擎 + FFmpeg 终渲染（素材工程导出） | 已交付，真实 FFmpeg 验证 |
| V6-1 | 共看片室最小闭环：上传 → AI 剪第一版（风格可选）→ 点选/拖选 + 文字 → 原地试改 → 采用/撤回 → 局部预览 → 导出；中英双语界面；AI 自检；初剪评测框架 | 已交付，真实浏览器 + 真实 FFmpeg 验证；**AI 导演用脚本导演验证，真实 Claude 待密钥** |
| V6-2 | 流式双语语音 + 共同注意力：共看片室里边看边说，边说边出文字，“这个/这里”按说出那一刻绑定，没说完先等后半句；新进程 Realtime Gateway | 已交付，真实浏览器（假麦克风）+ 真实网关验证；**流式识别用本地同协议假服务，真实 Deepgram 待密钥**；AI 语音回应暂用浏览器朗读 |
| V6-3 | 代码生成特效：在画面上框出一块说“这里加个爆炸/光效”→ 透明特效图层成为试改（特效轨）→ “换个颜色”只重渲图层 → 采用；6 个模板，AI 写的特效代码先过四道门禁、在隔离子进程里渲染；素材作品缺省不允许程序化特效，由用户在顶栏开启 | 已交付，真实浏览器 + 真实特效渲染 + 真实 FFmpeg 预览/终渲染验证（区域内像素变化、区域外不变）；**AI 为脚本导演，真实 Claude 待密钥**；AI 写特效代码缺省关闭，待真实模型评测后开启 |
| V6-4 | 批注式审片：手机或桌面逐处标记（位置 + 一句话 + 可选框选）→ 逐条和 AI 讨论方案 → 一次执行 → 只重渲改动的分段 → 采用；可添加到主屏幕 | 已交付，真实浏览器（手机 + 桌面）+ 真实 FFmpeg 验证；**AI 为脚本导演，真实 Claude 待密钥**；语音批注随 V6-2 |
| V6-6 | 蒸馏器：从参考视频学风格——上传文件或粘贴链接（1–5 条）→ 真实 FFmpeg 测量剪法（镜头时长、剪辑频率、节奏曲线、卡点比例与随机对照、黑场过渡、色调、响度、节拍）→ 一个可选的风格（只列测得到的，没测的如实列出）→ 改说明 → 选用后作为 AI 的风格参考 | 已交付，真实浏览器 + 真实 FFmpeg 测量验证（合成参考视频与真值一致）；**平台链接（YouTube 等）需部署方配置下载命令**，指定的三条 YouTube 视频因本环境网络不通尚未测量；模型撰写说明待密钥；景别/推拉/变速/字幕样式还没测 |
| V6-5 | 文章转视频：新建时贴一篇文章 → AI 写讲述稿、合成配音（讲述轨 + 逐句字幕）、为每个要点配图解卡（标题、要点、步骤、引用、柱状图、大数字；数据图只用文章里的数字，服务端校验）→ 共看片室里接着改；可选"知识解说"风格 | 已交付，真实浏览器 + 真实语音合成（本地 flite，英文）+ 真实特效渲染 + 真实 FFmpeg 验证；**供应商配音（中文）待接入**（进程协议已就绪，有参考实现）；**AI 为脚本导演，真实 Claude 待密钥**；旧 Scene 流水线待真实验证后下线 |
| V6-7 | 数字人与嗓音："我的形象与声音"（参考照片 + 声音样本 + 只增不改、可撤回的授权记录）→ 作品里说"用我的数字人说这段" → AI 只报价 → 你确认 → 预算预留 → 生成一次（不自动重试，结果不明进入待对账）→ 拉回自有存储 → 有声画中画试改 → 按实结算；HeyGen（数字人）+ Fish Audio（你的声音、讲述配音）适配器 | 已交付，真实浏览器 + 真实 FFmpeg 验证；**生成供应商实测用 FFmpeg 测试替身**；HeyGen / Fish Audio 适配器按公开接口用本地替身服务测过协议，**真实服务待放行网络后验证**；AI 为脚本导演 |
| V6-8 | 视频生成重特效：框出区域说"换成……"→ 报价 → 确认 → 只取框内的生成层（框外保持原片，并测量供应商是否改了框外）；生成镜头；视频生成供应商经进程协议接入；可选风格"高能娱乐"与娱乐评测集模板 | 已交付，真实浏览器 + 真实 FFmpeg 验证（框内变、框外不变）；Google Veo 与火山方舟 Seedance 生成镜头适配器就绪（按时长档位报价）；真实 Veo 测试时这把 Key 在免费层没有 Veo 配额（提交被拒、未扣费），**待开通付费层**；Runway gen4_aleph 选区重绘适配器就绪；网络已放行、各家鉴权已用真实服务通过，**真实生成待开通方舟模型 / 充值 Runway credits**；娱乐评测待你的原片 |
| 供应商：Google Gemini | 同一个模型端口接 Gemini：AI 导演、素材画面理解、风格撰写；Gemini TTS 讲述配音（中英）；Veo 生成镜头 | **导演、画面理解、中文讲述已用真实 Gemini 验证**（初剪评测 5 例、真实浏览器 4/4，记录 `docs/V06/milestones/gemini-provider.md`）；实测模型为 flash-lite（flash 当时过载）；暴露的质量问题（指向范围没守住等）如实记录；免费层 TTS 每天 10 次 |

只有带证据的 `VERIFIED` 计入完成；脚本模型 / Mock 通过 ≠ 真实 Provider 通过。各里程碑的"未验证与待办"见 `docs/V06/milestones/`。

## 需要你提供的外部能力

不配任何密钥，平台也能跑起来：剪辑内核、素材探测/代理/镜头切分、预览、导出、共看片室界面都是真实可用的；AI 相关能力会明确显示"未配置"，不会假装成功。要让 AI 真正剪片，至少在 **Worker** 进程配置（Claude 或 Gemini 二选一）：

```bash
ANCS_AGENT_DRIVER=anthropic
ANTHROPIC_API_KEY=…            # 只放在服务端环境变量 / 密钥管理，不要提交、不要贴到聊天里
ANCS_VISUAL_ANALYSIS_DRIVER=anthropic   # 可选：素材画面理解
# 或者用 Google Gemini（导演 + 画面理解 + 讲述配音，一把 Key）
# ANCS_AGENT_DRIVER=gemini
# ANCS_VISUAL_ANALYSIS_DRIVER=gemini
# ANCS_NARRATION_DRIVER=gemini
# GEMINI_API_KEY=…
# ANCS_AGENT_MODEL=gemini-flash-latest   # 高峰期过载时可换 gemini-flash-lite-latest
ANCS_ASR_DRIVER=deepgram       # 可选：素材语音转写
DEEPGRAM_API_KEY=…
# 实时语音：API 与 Realtime Gateway 两个进程都配同一把会话密钥（≥32 字符），网关另配识别驱动
ANCS_VOICE_SESSION_SECRET=…
ANCS_REALTIME_ASR_DRIVER=deepgram   # 或 openai（OpenAI 兼容转写接口，网关自己断句）
# AI 语音回应（服务端合成，可被开口打断）：openai = OpenAI 兼容 /audio/speech；不配 = 浏览器朗读并如实标注
# ANCS_REALTIME_TTS_DRIVER=openai
# OPENAI_API_KEY=…                  # 识别 / 合成共用；兼容网关另配 ANCS_OPENAI_BASE_URL（含 /v1）
# Claude 走兼容网关：ANCS_ANTHROPIC_BASE_URL=https://…（填到 /v1 之前）
```

想直接粘贴 YouTube 等平台链接学风格：Worker 机器装 `yt-dlp`，放行平台域名，并配置（不需要密钥）：

```bash
ANCS_REFERENCE_FETCH_CMD=yt-dlp --no-playlist -f mp4/bestvideo*+bestaudio/best -o {output} {url}
```

不配置也能用：下载视频后在"从参考视频学风格"里上传文件。

讲述配音（"从文章开始"做解说视频）：本机 FFmpeg 带 libflite 时可先用 `ANCS_NARRATION_DRIVER=flite`（只会英文、音质基础、无需密钥）；正式配音（含中文）推荐 Fish Audio：`ANCS_NARRATION_DRIVER=fish` + `FISH_AUDIO_API_KEY` + `ANCS_NARRATION_VOICES_JSON`（`id` 填 Fish 声音模型 id）；也可以用 `ANCS_NARRATION_DRIVER=process` 接任意供应商（参考 `scripts/narration-process-example.mjs`）。

数字人与付费生成（V6-7/V6-8，每次都先报价、由用户确认）：

```bash
ANCS_AVATAR_DRIVER=heygen      # 数字人：HeyGen 会说话的照片 + Fish Audio 用你的声音读讲稿
HEYGEN_API_KEY=…
FISH_AUDIO_API_KEY=…
ANCS_GENERATION_DRIVER=process # 生成镜头 / 选区重绘：你写的小程序调用视频生成供应商（协议见 scripts/generation-process-example.mjs）
ANCS_GENERATION_EXECUTABLE=…
ANCS_GENERATION_OFFERS_JSON=…  # 每类的每秒价格区间与单次上限（报价依据）
ANCS_VEO_OFFER_JSON=…          # 生成镜头接 Google Veo（需 GEMINI_API_KEY）：model、每秒价格（按 Google 价格页填）、durationOptions [4,6,8]
ANCS_SEEDANCE_OFFER_JSON=…     # 生成镜头接火山方舟 Seedance（需 ARK_API_KEY）：model、每秒价格（按方舟价格换算）、整数秒 durationOptions
ANCS_RUNWAY_OFFER_JSON=…       # 选区重绘接 Runway gen4_aleph（需 RUNWAYML_API_SECRET）：每秒价格（按 Runway 价格换算）
```

另外**工作区必须设置生成预算**（没设时确认会被拒绝）。网络需放行 `api.fish.audio`、`api.heygen.com`、`upload.heygen.com` 与 HeyGen 视频下载域名；配好后先跑 `NODE_USE_ENV_PROXY=1 node scripts/provider-smoke.mjs`（一句话 TTS + 读 HeyGen 额度，几乎不花钱）。

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

登录后在首页点"进入共看片室"新建作品（路由 `/w/<workspaceId>/studio/new`），放入素材，点"让 AI 剪第一版"。想加特效：顶栏打开"特效"，暂停到某一刻点"框选画面"框出位置，再说"这里加个光效"。想做解说视频：新建时选"从文章开始"贴上文章，进入后点"让 AI 讲成视频"。想学某位博主的剪法：在"风格（可选）"一行点"从参考视频学风格"，放几条这位博主的视频，学完点"用这个风格"。看完后点顶栏"审片"（`/w/<workspaceId>/review/<projectId>`，手机上可添加到主屏幕）逐处标记问题、和 AI 商量后一次改完。

## 验收与评测脚本

| 命令 | 说明 |
|---|---|
| `node scripts/studio-browser-check.mjs` | 共看片室端到端：真实浏览器 + 真实 API/Worker/FFmpeg，脚本导演；截图写入 `docs/verification/artifacts/v6-1c/`（需要支持 H.264 的 Chrome，`ANCS_BROWSER_EXECUTABLE` 指定） |
| `node scripts/voice-browser-check.mjs` | 实时语音端到端：Chrome 假麦克风 → AudioWorklet → 网关 → 流式识别（本地同协议假服务）→ 指代绑定 → 试改；中英文；截图写入 `docs/verification/artifacts/v6-2/` |
| `node scripts/voice-live-check.mjs` | Issue #9 连续语音的**真实服务**验收（需 `OPENAI_API_KEY` + `ANTHROPIC_API_KEY`，会产生少量识别 / 合成 / Claude 费用）：真实识别 → 真实 Claude → 真实合成念回应 → 开口打断 → 采用 / 撤销 → 结束；断线、过期、密钥失效、未配置、无权限；桌面 / 手机、浅色 / 深色；延迟与用量写入 `docs/verification/artifacts/v6-2/issue-9/summary.json` |
| `node scripts/effects-browser-check.mjs` | 代码生成特效端到端：项目规则开关 → 框选画面 → 特效试改（预览像素校验）→ 改颜色 → 采用，真实 API/Worker/FFmpeg + 真实特效渲染子进程，脚本导演；截图写入 `docs/verification/artifacts/v6-3/` |
| `node scripts/narration-browser-check.mjs` | 文章转视频端到端：新建页贴文章 → AI 讲述 + 图解卡（真实 flite 合成 + 真实特效渲染）→ 预览音量与卡片画面校验 → 采用；中英、深色、手机宽度；截图写入 `docs/verification/artifacts/v6-5/` |
| `node scripts/generation-browser-check.mjs` | 付费生成端到端：顶栏"生成"开关 → 框出区域说"换成……"→ 报价卡 → 确认 → 只取框内的生成层（圈外测量）→ 采用；我的形象与声音（上传、声明、授权）→ 数字人画中画；中英、深色、手机宽度；脚本导演 + FFmpeg 测试替身；截图写入 `docs/verification/artifacts/v6-7/` |
| `node scripts/provider-smoke.mjs [--heygen-generate 照片 声音] [--veo-generate] [--seedance-generate 模型]` | 真实 Fish Audio / HeyGen / Gemini / 火山方舟冒烟：缺省只合成一句话、读 HeyGen 额度、列 Gemini 模型并让导演模型调一次工具；加参数才真的生成约 2 秒数字人、4 秒 Veo 或 5 秒 Seedance 镜头（计费）。密钥只从环境变量读 |
| `node scripts/provider-network-check.mjs` | 真实供应商网络诊断：逐个域名查 DNS、出网许可（代理 CONNECT）、TLS + HTTP、免费接口鉴权；不产生生成费用，不打印密钥（结果见 `docs/verification/provider-network-report.md`） |
| `node scripts/gemini-browser-check.mjs` | 真实 Gemini 导演 + 画面理解的共看片室浏览器验收（需 `GEMINI_API_KEY`，少量费用） |
| `node scripts/eval-first-cut.mjs --set evals/first-cut/explainer.json` | 文章转视频评测（英文用例用本地 flite 讲述；中文用例需要中文配音，没有时跳过并写明原因） |
| `node scripts/distill-browser-check.mjs` | 从参考视频学风格端到端：网页链接未配置下载工具的失败提示 → 上传 + 直接链接两条已知真值的参考视频 → 结果卡与真值比对 → 改说明 → 选用后 AI 按风格剪第一版；真实 API/Worker/FFmpeg，脚本导演；截图写入 `docs/verification/artifacts/v6-6/` |
| `node scripts/distill-reference.mjs [--json out.json] <文件或链接>…` | 不用数据库直接测量 1–5 条参考视频的剪法，打印剪辑 DNA 与风格说明（与工作流同一套代码）；平台页面链接需要 `ANCS_REFERENCE_FETCH_CMD` |
| `node scripts/review-browser-check.mjs` | 批注式审片端到端：手机 390×844 触屏 + 桌面，真实 API/Worker/FFmpeg，脚本导演；截图写入 `docs/verification/artifacts/v6-4/` |
| `node scripts/eval-first-cut.mjs` | 初剪评测冒烟（`evals/first-cut/smoke.json`，脚本导演，只证明框架可用） |
| `node scripts/eval-first-cut.mjs --set evals/first-cut/travel.json --model anthropic\|gemini --export` | 真实模型初剪评测：自动指标 + 人工评分表 + 导出成片（需 `ANTHROPIC_API_KEY` 或 `GEMINI_API_KEY`；`--model gemini` 时讲述用 Gemini TTS；素材放 `Videos/`，见评分标准文档） |
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
