# 运行期测试问题记录（2026-10-17 本地实测）

范围：本地 Web / API / Worker 全栈手工测试（`localhost:3000`）期间由监控采集与人工排查确认的问题。本文是**结构化记录**，不替代里程碑验收，不新增或覆写 N/P 账本；未修复项不得视为已解决。

- 测试环境：本地 Postgres（`ancs-local-db` 容器，127.0.0.1:55433）+ 本地 Redis + `next start`（生产构建）+ Worker（`ANCS_AGENT_DRIVER=deepseek`、`ANCS_ASR_DRIVER=deepgram`）。
- 监控：API / Worker / Web 日志每 1 秒增量采集（5xx→error，4xx→warning，请求/响应按 `reqId` 关联 URL；15 秒一次健康检查），浏览器端注入采集器捕获 `window.error`、`unhandledrejection`、`console.error`、失败 fetch/XHR、可见错误面板与“上传失败”文案。原始事件副本（已脱敏本机绝对路径）：`docs/verification/artifacts/runtime-monitor-20261017/`（`server-events.jsonl`、`browser-events.jsonl`、`monitor.log`）；会话内实时文件在 `.tmp-monitor/`。
- 记录口径：**待修复**＝已定位、代码/配置未改；**已处理**＝有针对性处置并有验证；**待定位**＝现象确认、根因未闭合。

## 问题总表

| ID | 问题 | 严重度 | 状态 |
|---|---|---|---|
| RT-01 | 全部视频上传失败：分片直传被浏览器 CSP 拦截 | 阻断 | 已处理（本地构建放行 3001，直连验证 200） |
| RT-02 | 上传失败后界面永久卡在 “Processing your footage” | 高 | 已临时解锁（取消未完成意图）；代码未修复 |
| RT-03 | 大文件上传极慢：瓶颈在浏览器并发读本地文件 | 高 | 已定位；未修改 |
| RT-04 | 上传无跨刷新续传：刷新/失败即从头再来 | 高 | 已确认；未修复 |
| RT-05 | 大文件 confirm 被 Web 代理 30 秒超时断开，界面误报 “Upload failed” | 阻断 | 已定位；服务端实际完成合并，无需重传 |
| RT-06 | 素材视觉/音频分析任务失败（能力未装配） | 中 | 已确认；属既有 ISS-14 范围 |
| RT-07 | 上传相关 WriteStream 监听器泄漏警告 | 低 | 待定位 |
| RT-08 | 开发期预期 404（ops/session）被监控记为 warning | 低 | 已归类为 info |
| RT-09 | 并发重试 confirm 导致 500（分片已被首次合并清理，ENOENT） | 中 | 已确认；未修复 |
| RT-10 | 预览等待时间长：真实渲染 65s，前面有 13 分钟 AI 轮次 + 3 分钟排队；渲染无进度 | 高 | 已定位；未修复 |
| RT-11 | 本地 `pnpm verify` 因 `.tmp-*` 临时脚本未过 lint 而中止（业务代码无关） | 中 | 已确认；按要求未改代码 |
| RT-12 | 本地 ffmpeg 缺少 `flite` 滤镜 → 讲述/数字人集成测试失败（环境问题） | 中 | 已确认；未改代码 |
| RT-13 | Windows 下讲述进程驱动引擎名 `process:node.exe` 与断言 `process:node` 不一致 | 低 | 已确认；仅 Windows 测试可移植性 |
| REQ-01 | **需求**：AI 剪辑过程必须可见，不能是黑箱（无限画布平铺素材 + 下方时间轴，AI 的每个动作实时反映） | 产品需求 | 已记录；未排期 |
| REQ-02 | **需求**：全流程速度优化（上传 / 首剪 / 预览 / 媒体处理），能优化的算法必须优化 | 产品需求 | 已记录；未排期 |
| REQ-03 | **需求**：视频/画面理解接入 Elorian（elorian-1-agent） | 产品需求 | 代码已接（单测/typecheck/build/arch 通过）；真实推理被账户余额 $0.00 阻塞 |
| OBS-01 | 首剪产出偏薄：33 次工具调用只有 1 次剪辑，66 秒/5 段/只用 3 条素材（观察，非缺陷） | 观察 | 已记录；根因含转写缺失（RT-06） |
| OBS-02 | 全量 unit 首次运行偶发失败一次，随后两次重跑均通过 | 观察 | 已记录；未捕获具体用例，疑似 flake |

---

## RT-01 全部视频上传失败：直传被 CSP 拦截

- **现象**：11 个文件全部 “Upload failed”，时间线为空。
- **证据**：11 个 upload-intents 与 33 个分片目标请求均 200；但 `/parts/:n/complete`、`/assets/:id/confirm`、`/api/v1/storage/upload` 均为 0 条（连 OPTIONS 都没有）。页面内 `fetch('http://localhost:3001/api/v1/health')` → `TypeError: Failed to fetch`；同源请求正常。响应头 `connect-src 'self'`；上传目标为 `PUT http://localhost:3001/api/v1/storage/upload?token=…`。
- **根因**：Web 以生产构建运行（`next build` + `next start`），生产 CSP 不允许跨源 `localhost:3001`；而 `ANCS_STORAGE_PUBLIC_BASE_URL=http://localhost:3001`，分片直传必然是跨源请求。
- **处置**：按 runbook 的构建期配置 `ANCS_CSP_EXTRA_ORIGINS=http://localhost:3001` 重建并重启 Web；新 CSP 的 `img-src`/`media-src`/`connect-src` 已包含该源，页面内直连 API 返回 200。
- **结论**：本地启动配置不匹配，非业务代码回归；开发模式（`next dev`）默认放行，故日常不出现。
- **注意（2026-10-17 补充）**：`pnpm build` / `pnpm verify` 会用**未设置** `ANCS_CSP_EXTRA_ORIGINS` 的构建覆盖 Web 产物，CSP 会回退为 `connect-src 'self'`，上传再次失败。跑完全量验证后必须按构建期配置重建 Web（本次已重建恢复）。

## RT-02 上传失败后界面永久转圈

- **现象**：11 个失败素材留在服务端 `PENDING_UPLOAD` 后，画布永久停在 “Processing your footage”，每 2.5 秒轮询；Tasks 面板同时把同一批显示为 “Running / Probing, building the edit proxy and index…”。
- **证据**：`packages/domain/src/studio.ts:152` 把非 READY/PROCESSING/FAILED 的资产一律映射为 `UPLOADING`；`apps/web/src/studio/StudioRoom.tsx:569-571` 据此判定 `mode='processing'`；`apps/web/src/studio/useStudio.ts` 在该状态每 2.5 秒轮询且无超时出口。数据库 11 个资产均为 `PENDING_UPLOAD`，无处理任务。
- **影响**：上传失败后用户被困在“处理中”，刷新也无法解除（状态在服务端）。
- **处置**：通过产品接口 `DELETE /api/v1/workspaces/:id/assets/upload-intents/:intentId` 取消 11 个未完成意图（全部 200），资产标为 FAILED、分片清理，界面恢复空状态。
- **待修复**：`PENDING_UPLOAD` 不应映射为 `UPLOADING`（需失败/超时出口）；失败态应与重试入口一致；任务面板与画布使用同一状态源。

## RT-03 大文件上传极慢：客户端并发读本地文件

- **现象**：7 个文件并行上传，进度 1–5%，聚合约 2.1 片/秒（8MB 分片）≈ 17MB/s；单文件 2.6GB 需 328 片。
- **实测**：
  - 服务端每片：target 22ms / PUT 28ms / complete 56ms（p50）。
  - 浏览器网络：target 34ms / PUT 89ms / complete 57ms。
  - **浏览器读源文件切片 `File.slice().arrayBuffer()`：p50 8.6s、p90 11.0s / 8MB**；SHA-256 仅 9–10ms。
  - 磁盘：HDD（TOSHIBA DT01ACA200 2TB，E:/D:/F:）+ SSD（Samsung 860 EVO 500GB，C:）；`.storage` 在 E:。上传期间 E: 原始顺序读 42.9MB/s，C: GB/s 级。
  - `StudioRoom.tsx:501-518` 对每个文件都 `void uploadResumable(...)`，单文件 `concurrency: 3` → 7 个文件 21 个并发 8MB 读者同时打同一块 HDD。
- **根因**：单片 95% 以上时间在读本地文件；并发读者在同盘寻道抖动，把聚合读取压到 ~8.5MB/s。8MB 分片放大次数（82–328 片/文件），每片另有 3 次往返、双端 SHA-256、服务端写盘后整片回读校验，confirm 时再整文件读+写。
- **待修复方向**：限制总并发（文件串行或最多 2 个在飞；SDK 已有逐文件串行的 `uploadBatch`，Studio 未用）；分片调至 32–64MB（服务端上限 64MB）；PUT 时顺流计算校验和，避免回读；本地存储按偏移写最终文件，免去 compose 全量复制。

## RT-04 上传无跨刷新续传

- **现象**：刷新或重新选择同一文件会创建新意图，已上传分片不复用。
- **证据**：`StudioRoom.tsx:501-518` 只传 `assetType/filename/contentType/data/projectId`，options 仅 `concurrency/onIntent/onProgress`；SDK 的 `resumeIntentId` 未被持久化。
- **影响**：大文件中途刷新/失败=从头再来；与 RT-03 叠加时代价很大。

## RT-05 大文件 confirm 被 Web 代理 30 秒超时断开（本轮核心故障）

- **现象**：7 个文件里 4 个完成、3 个显示 “Upload failed”；仅 1 次 confirm 正常完成（865MB，3.3s）。
- **证据**（2026-10-17 09:26–09:39）：
  - 数据库：2.6GB / 3.6GB / 3.9GB 三个意图**全部分片已完成**（328/328、457/457、488/488），仍为 `PENDING`，资产 `PENDING_UPLOAD`。
  - API 日志：6 次 `POST …/assets/:id/confirm` 只有 1 次完成记录，其余 6 次**无完成记录**。
  - Web 日志：对应时刻均为 `Failed to proxy … /confirm [Error: socket hang up] { code: 'ECONNRESET' }`；请求开始到断开的间隔稳定在 **约 30–31 秒**（09:32:43→09:33:14、09:34:42→09:35:13、09:37:46→09:38:17、09:38:18→09:38:48）。
  - API 未配置请求超时（Fastify 默认 `requestTimeout: 0`），故 30 秒限制来自 Web 的 `/api/v1/*` 重写代理。
- **根因**：`confirm` 在 HTTP 请求内**同步执行分片合并**（`composeMultipartUpload` 读全部 8MB 分片、复制为完整文件、再探测/嗅探）；大文件合并远超 30 秒，Web 代理先断开，客户端把整个文件标为 “Upload failed”，但服务端可能仍在合并并最终提交（出现“界面说失败、资产已 READY”的不一致）。
- **处置与最终结果（更正）**：Web 代理断开只影响客户端；**服务端继续执行合并并最终提交**。2026-10-17 09:55 复查：7 个文件全部合并成功（2.6GB / 3.6GB / 3.9GB 的最终文件均在存储中、大小与声明一致），意图陆续转为 `COMPLETED`，资产进入 `PROCESSING`/`READY`。**不需要重新上传**，此前界面上的 “Upload failed” 是客户端误报。合并速度实测约 2.8MB/s（`composeObjects` 对 328 个 8MB 分片逐一“读分片→写输出”，读写交替在 HDD 上寻道抖动；同期原始写入测试为 73MB/s，慢约 26 倍）。
- **待修复**：confirm 不应同步做分钟级工作——改为返回 202 + 后台作业（`COMPOSE_UPLOAD`），或本地存储按偏移写最终文件使 confirm O(1)（同时消除寻道抖动）；客户端需区分“合并未完成”与“上传失败”，确认后以服务端状态为准，而不是要求重传。

## RT-06 素材视觉/音频分析任务失败（转写缺失直接影响首剪质量）

- **现象**：上传确认后的分析任务批量失败（`FAILED_FINAL`，attempts=1），集中在 09:30、09:44 两批。
- **证据**（`jobs.error`）：`MEDIA_VISUAL_ANALYSIS` → `VISUAL_ANALYSIS_CAPABILITY_UNAVAILABLE`；`MEDIA_AUDIO_ANALYSIS` → `AUDIO_ANALYSIS_CAPABILITY_UNAVAILABLE`；`MEDIA_TRANSCRIPT` → `This operation was aborted`。
- **影响（重要）**：转写为空直接导致首剪只能按画面/手势节奏切，无法按讲述内容对齐句子——轮次 `agt_f1e9a0ad` 的回复明确写着“这批素材的语音转写全部为空（分析还在跑），所以我是按画面和手势节奏找的切点”。因此 RT-06 不只是后台任务失败，它直接拉低了首剪质量（见 OBS-01）。
- **判定**：视觉/音频两类是能力未装配（与 `20261014issues.md` 的 ISS-14 一致）；转写是 ASR 调用被中止，需查超时/取消路径（`ANCS_ASR_DRIVER=deepgram`）。
- **状态**：已记录，待按 ISS-14 范围处理；修复前首剪质量受限。

## RT-07 WriteStream 监听器泄漏警告

- **现象**：上传期间 API 反复输出 `MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 finish/end/error/close listeners added to [WriteStream]`。
- **判定**：与并发的大量长连接/流有关（compose 或上传写入）；尚未确认是否导致 RT-05，但同属流的生命周期管理问题。**待定位**。

## RT-08 预期 404 的归类

- `GET /api/v1/ops/session` 在 `ANCS_OPS_ENVIRONMENT=DEVELOPMENT` 下返回 404 属预期；监控已将该 URL 的 404 归类为 `info`，不计入故障。

---

## RT-09 并发重试 confirm 导致 500

- **现象**：在首次 confirm 仍在合并时再次发起 confirm，第二次返回 500。
- **证据**：API 日志 `level:50`：`ENOENT: no such file or directory, open '.storage/multipart/upi_b7fde2e1-…/part-00050'`；第一次请求已合并成功并清理分片，第二次请求读分片时文件已不存在。代码中已有“已完成 → 直接返回”的幂等分支（`packages/domain/src/assets.ts` `confirmUpload`），但**并发窗口内两次请求都通过状态检查**，后到的请求在分片被清理后失败，且返回 500 而不是可理解的 409。
- **影响**：客户端超时重试/多标签重试可能制造 500；本次结果未受破坏（首次请求已成功提交），但错误码与可诊断性不合格。
- **待修复**：按上传意图加锁/条件更新（如 `UPDATE … WHERE status='PENDING'` 抢占），并发请求直接返回已完成结果或 409；合并失败路径要能区分“分片已清理”与真实损坏。

## RT-10 预览等待长、无进度

- **现象**：从发出“剪第一版”到看到预览约 17 分钟；期间只有转圈。
- **拆解**（2026-10-17 09:55–10:12）：AI 轮次 09:55:11→10:08:27（13m16s，33 工具）；预览任务 10:08:28 创建、约 10:11:37 才被认领（排队约 3 分钟）；渲染 10:11:37→10:12:42，**render_ms=65,142ms，34 段**，状态 `READY`。
- **渲染内部成本**：`preview-render-handler.ts` 先对 `plan.sources` 逐个 `materializeObject`（**整份复制**）；本轮 3 个源 650MB + 1969MB + 2618MB ≈ 5.2GB，且其中 2 个 proxy 仍为 PENDING，复制的是原片；随后按 2 秒窗口共 33 段 + 1 条音轨，逐段调用 FFmpeg（输入 seek `-ss` 在 `-i` 之前，策略正确），最后流复制拼接。
- **进度缺失**：`sequence_previews` 只在完成时写入 `segments_total/segments_rendered/render_ms`，渲染中始终为 0；前端拿不到阶段与进度。
- **待修复**：见 REQ-02 的预览条目；另外预览应优先于后台分析，且 proxy 应先生成。

## RT-11 本地 verify 被 `.tmp-*` 临时脚本卡在 lint

- **现象**：2026-10-17 自动化验证第一次 `pnpm verify` 在 lint 步骤中止（后续套件全部 SKIP），8 个 error 全部来自本地临时脚本：`.tmp-deepseek-browser.mjs`（早前会话遗留）与 `.tmp-monitor/watch.mjs`（本次监控脚本）。
- **证据**：eslint：`no-unused-vars` ×1、`no-empty` ×1、`no-undef` ×3（`document`）、`no-control-regex` ×1（ANSI 转义正则）、`no-undef` ×1（`AbortSignal`）。
- **判定**：不是业务代码问题。`.tmp-*` 被 `.gitignore` 忽略，但**未被 ESLint 忽略**；任何遗留脚手架都会让本地 verify 卡在 lint。CI 从干净检出运行，不受影响。
- **建议**：ESLint ignore 增加 `.tmp-*` / `.tmp-*/**`，或规定脚手架脚本加 `eslint-disable`。本次按要求**未改代码**。
- **后续**：为拿到其余套件结果，已手动依次运行 typecheck / build / arch:check / capabilities:check 与各测试套件（结果见“自动化验证记录”）。

## RT-12 本地 ffmpeg 缺少 `flite` 滤镜（3 个集成测试失败根因）

- **现象**：`narration.integration.test.ts` 2 项、`paid-generation.integration.test.ts` 数字人 1 项失败。
- **证据**：错误统一为 `speech synthesis failed: ffmpeg exited with … Error opening input file flite=textfile='…':voice=slt. Error opening input files: Filter not found`；`ffmpeg -hide_banner -filters | grep -i flite` 无输出；本机 ffmpeg 为 Chocolatey 版本（`C:\ProgramData\chocolatey\bin\ffmpeg.exe`），`.env` 未配置 `ANCS_FFMPEG_PATH`。数字人测试替身在 `apps/worker/src/paid-generation.ts:273` 使用 `flite` 合成讲稿。
- **判定**：本地 ffmpeg 构建未包含 `libflite`，不是业务代码回归。V6-5/V6-7 此前记录依赖带 flite 的 ffmpeg；CI 的 ubuntu ffmpeg 是否带 flite 需核对（若不带的同样会红）。
- **影响**：本地自动化门禁在讲述/数字人相关集成测试上必红。
- **建议（未实施，按要求不改代码）**：使用带 `--enable-libflite` 的 ffmpeg，或用 `ANCS_FFMPEG_PATH` 指向该构建；不要静默跳过测试。

## RT-13 Windows 引擎名不一致（进程驱动测试）

- **现象**：`narration.integration.test.ts` 的“进程驱动”用例断言失败。
- **证据**：expected `engine: 'process:node'`，实际 `engine: 'process:node.exe'`（`apps/worker/src/narration.integration.test.ts:261`）。Windows 上 `process.execPath` 的 basename 含 `.exe`。
- **判定**：仅 Windows 的测试可移植性问题；Linux/CI 不受影响。不是产品缺陷。
- **建议（未实施）**：断言改为平台无关（如 `process:node` + 可选 `.exe`），或统一引擎标签的规范化规则。

## 本轮最终状态（2026-10-17 09:56）

- 7 个上传：**全部 `COMPLETED`**（3.9GB 于 10:12 完成，资产 `PROCESSING`；此前 3 个 `READY`、3 个 `PROCESSING`）；**全部数据在存储中，无需重传**。
- 首剪轮次 10:08 完成，产出 66 秒 / 5 段 / 3 条素材（见 OBS-01）；用户 10:13 发起“重做一遍”，进行中。
- 预览 10:12:42 `READY`，渲染 65 秒（见 RT-10）。
- 早前取消的 11 个失败上传仍是 `FAILED` 记录（界面素材数因此显示 18）；如需清理，在素材库删除即可。
- 用户已在共看片室发起“用这些素材剪出第一版”的 AI 轮次（任务面板显示进行中）。

## 自动化验证记录（2026-10-17，独立测试库 `ancs_test`）

> 目标（用户要求）：功能完好即可；只找问题、不改代码。独立测试库 `ancs_test` 建在本地 Postgres（127.0.0.1:55433），Redis 用 `redis://localhost:56379`。

- **第一次 `pnpm verify`**：secrets ✓ → spec ✓（219 项任务，VERIFIED 54 / IN_PROGRESS 16）→ **lint ✗（RT-11，8 个 error 全部来自 `.tmp-*` 临时脚本）** → 其余步骤按脚本逻辑 SKIP。
- **手动继续其余门禁**（只运行，不改代码）：typecheck ✓ · build ✓（33 个 workspace 包）· arch:check ✓（33 包，R1—R12 通过）· capabilities:check ✓（NATIVE 24）。
- **全部测试套件**：

| 套件 | 结果 |
|---|---|
| test:unit | 118 文件 / **848 项通过** |
| test:web | 50 文件 / **306 项通过** |
| test:motion | 4 文件 / **38 项通过** |
| test:contract | `[PLANNED]` 占位通过 |
| test:integration | 134 文件 / 627 项：**623 通过，4 失败**（2 文件，耗时约 15.7 分钟） |
| test:e2e | `[PLANNED]` 占位通过 |
| test:security | 5 文件 / **24 项通过** |
| test:render | 3 文件 / **8 项通过** |
| test:golden | 2 文件 / **15 项通过** |

- **合计**：**1,862 项通过 / 4 项失败**（另有 contract/e2e 两个占位套件，不含实际用例）。
- **4 个失败的归因**：
  - 讲述 ×2 → RT-12（本地 ffmpeg 无 `flite` 滤镜）；
  - 数字人 ×1 → RT-12（数字人测试替身用 `flite` 合成讲稿）；
  - 讲述进程驱动 ×1 → RT-13（Windows 下引擎名 `process:node.exe` 与断言 `process:node` 不一致）。
- **结论**：业务代码没有回归；4 个失败全部是本地环境/测试可移植性问题。除环境阻塞项外，其余套件全绿。要拿到 100% 绿，需要：带 flite 的 ffmpeg（RT-12）、修 lint 忽略规则（RT-11）、平台无关的引擎名断言（RT-13）。
- **证据**：`docs/verification/artifacts/runtime-monitor-20261017/verify-run-1.log`、`verify-gates.log`、`verify-tests.log`（已脱敏本机绝对路径）。

## REQ-01 AI 剪辑过程必须可见（用户需求，2026-10-17 提出）

> 本节是**产品需求**，不是缺陷记录；与上面的 RT-xx 分开维护。

- **用户原意**：AI 在剪辑时，应该可以看到它正在做什么，不能完全是黑箱。想法是：无限画布上把素材平铺起来，下边是时间轴；AI 做任何动作（排布、剪切、调用工具……）都作用到时间轴上，用户都能看到；这样等待也不至于那么枯燥。
- **背景**：大素材首剪等待时间长（本轮实测上传/合并/处理动辄几分钟到十几分钟），当前界面只有一句 “AI 正在剪…”，用户无法判断它在做什么、还要多久、是否卡住。等待成本被完全转嫁给用户。
- **需求（行为）**：
  1. 无限画布以平铺方式展示素材（缩略图/片段），下方是时间轴；保持现有共看片室的画布隐喻。
  2. AI 的每个动作在发生时即可见，并以时间轴为落点：素材排布、剪切/删除、片段移动、使用特效/图解/讲述等工具、生成试改等，都能看到"正在做什么"。
  3. 未提交的草稿修改与已提交的结果要区分显示；失败、取消、重试要可见，不能静默。
  4. 等待期间展示真实进行中的动作，不得用假进度条或与真实操作无关的动画填充（与既有“不得虚构进度”的口径一致）。
- **依赖（实现前必须解决的边界）**：当前 `agent_turns.tool_calls` / `draft_operations` 是**轮次结束后一次性落库**，前端轮询只能看到最终结果；要做实时可见，需要 Worker/运行时在动作发生时产出事件（SSE/WebSocket 或增量轮询），并让前端以服务端权威事件为准渲染。不得在前端本地模拟 AI 动作。
- **验收要点（草稿）**：
  - 一轮首剪中，工具调用与草稿操作按发生顺序出现，时间轴随动作增量更新；最终显示与提交的草稿一致。
  - 刷新/重新进入后能恢复已发生的动作记录；轮次失败/取消有明确终态。
  - 中英双语；不新增单语硬编码文案。
  - 实时更新不阻塞剪辑交互，且不因为展示而重复请求或放大服务端负载。
- **状态**：需求已记录，未排期、未实现；后续应归入 V6 共看片室/画布交互的里程碑（与无限画布、时间轴、AI 动作投影一并设计），不在本轮运行期修复范围内。

## REQ-02 全流程速度优化（用户需求，2026-10-17 提出）

> 本节是**产品需求**，不是缺陷记录。用户明确要求：各个流程的速度优化必须做好，否则工具太鸡肋；能优化的算法必须优化，让整体各环节速度都能提升。

### 本轮实测基线（同一台机器：HDD + SSD，单 Worker，本地存储）

| 环节 | 实测 | 说明 |
|---|---|---|
| 上传 7 个视频（约 10GB） | 聚合 ~17MB/s；单文件 8MB 分片读取 8.6s（p50） | 21 个并发读者打同一块 HDD；8MB 分片 82–328 片/文件 |
| confirm 合并 | ~2.8MB/s（原始写 73MB/s） | 逐片“读→写”交替，HDD 寻道抖动；大文件超过 Web 代理 30s |
| AI 首剪一轮 | 13 分 16 秒，33 次工具调用 | 大部分是 `look_at_footage`/`inspect_footage`，在 4GB 原片上抽帧 |
| 预览排队 | 创建后约 3 分钟才被 Worker 认领 | 单并发 FIFO，排在 12 个媒体任务之后 |
| 预览渲染 | 65 秒（66 秒时间线，34 段） | 先把 3 个源文件整份复制到临时目录（合计 5.2GB 读+写），再逐窗渲染 |
| 后台媒体处理 | 17 个任务仍排队 | probe/index/proxy/transcript/visual/audio × 7 个文件，单并发 |

### 必须优化的算法/工程点（按收益排序）

1. **上传**：文件串行或最多 2 个在飞（Studio 现在全部并行）；分片 32–64MB；PUT 时顺流算 SHA-256（去掉服务端回读）；本地存储按偏移直接写最终文件（去掉 compose 全量复制）。
2. **预览**：本地存储不要整份物化源文件（直接使用对象路径，或只物化所需区间）；窗口渲染可批量化；优先使用 proxy（短 GOP，seek 更快）；实时暴露阶段与窗口进度。
3. **AI 轮次**：抽帧改用 proxy、批量抽帧并缓存、只读工具并行调用、限制重复/无效的 `look_at_footage`；把工具调用与草稿动作实时暴露（与 REQ-01 同一投影）。
4. **媒体处理**：proxy 先于分析生成；分析任务改为按需/懒加载（AI 真正需要时再跑），不阻塞预览与首剪；引入任务优先级（交互 > proxy > 分析），或独立 interactive worker lane。
5. **可观测性**：每个环节都要有可核对的阶段、计数与耗时（不得用假进度）；本次 RT-10 的直接原因就是渲染进度只在完成时写入。

### 建议目标（待与 V6 规范对齐，不是既有承诺）

- 预览：同一时间线首次 ≤ 15 秒，命中缓存后 ≤ 3 秒；
- 首剪：10 分钟素材的只读分析 + 出草稿控制在 2–3 分钟内（当前 13 分钟）；
- 上传：局域网/本地环境下达到磁盘顺序读的 60% 以上；
- 所有交互环节都有阶段与进度，不再是黑箱转圈。

**状态**：需求已记录、未排期。与 REQ-01 同属“共看片室体验”改进，建议合并成一个性能与可观测性里程碑，先做基准复测再定硬指标。

## REQ-03 视频/画面理解接入 Elorian（2026-10-17 提出并接入）

- **需求**：给“素材画面理解”（V6-1b 镜头说明，写入统一索引供 AI 检索）增加一个新模型供应商 Elorian。
- **已交付**：
  - 新包 `packages/providers/elorian`：`ElorianAgentModel` 实现既有 `AgentModelAdapter`，OpenAI 兼容 `POST https://api.elorian.ai/v1/chat/completions`，缺省模型 `elorian-1-agent`；图片以 data URL 放入 user 消息，工具结果图片按调用 id 关联；适配器自身不重试。
  - `ANCS_VISUAL_ANALYSIS_DRIVER` 增加 `elorian`；缺 `ELORIAN_API_KEY` 启动失败（fail-closed）；Worker 装配后启动清单显示 `visual_analysis=elorian:REAL`。
  - 余额不足（HTTP 429 + `insufficient_quota`）归为**不可重试**的 AUTH，避免把计费问题当限流重试。
  - 单测 10 项（消息映射、并行工具调用、缓存用量拆分、HTTP 分类、配额错误、凭据不回显）；`env.test.ts` 增加 Elorian 配置校验。
  - `.env.example`、`docs/V06/integration-checklist.md` 已更新。
- **验证结果**：
  - 单测 41 项通过（Elorian 10 + env 31）；`@ancs/providers-elorian` typecheck/build 通过；Worker typecheck/build 通过；`arch:check` 34 包 R1—R12 通过；改动文件的 ESLint 无问题；`secrets:check` 通过。
  - `GET /v1/models` 鉴权成功，确认 `elorian-1-agent` 支持 text/image/video（max_images 100 / max_frames 376）。
  - **真实推理未验证**：账户余额 $0.00，`POST /v1/chat/completions` 返回 **HTTP 429 `{"type":"insufficient_quota","code":"credits_exhausted"}`**。充值后需按 integration-checklist 跑一条素材并记录模型、用量、耗时与费用，才能标 VERIFIED_REAL。
  - **真实素材链路测试（2026-10-17 21:00）**：对 650MB 素材 `ast_49153516…` 通过产品接口重建 SAMPLING/VISION 阶段；Worker 认领 `MEDIA_VISUAL_ANALYSIS`（job `job_b235fe…`），完成抽帧并调用 Elorian，返回 `Elorian request failed (HTTP 429, insufficient quota)`；`attempts=1`、`FAILED_FINAL`（按设计不重试）。说明**抽帧 → 适配器 → 供应商调用**链路已打通，唯一阻塞是账户余额。
- **安全**：密钥只写入本地未跟踪的 `.env`；未进入代码、日志、错误消息或文档。该密钥曾在聊天中出现，建议充值/使用后轮换。

## 监控说明与盲区

- **预期噪声**：09:04 前后的 3 条 `web unreachable` 是我重建并重启 Web 的空窗；10:25–10:48 前后的 `web/api unreachable` 是为跑全量 verify 主动停服的空窗；`GET /api/v1/ops/session` 的 404 在 DEVELOPMENT 下预期（见 RT-08）。
- **分类器修正**：Worker 日志“派发：enqueued=1 failed=0”曾被错误分类为 error（`failed` 关键词命中）；已修正为忽略 `failed=0`，此前记录按原文保留、按本条解释。
- 采集器注入在页面运行时，整页刷新会清除；源码保存在 localStorage 的 `ancs.monitor.injector`，每次检查时重新注入。刷新前的记录保存在 localStorage（上限 400 条）。
- SDK 在创建客户端时捕获 `fetch`（`const doFetch = options.fetchImpl ?? fetch`），页面级 fetch 包装看不到 SDK 请求；被 CSP 拦截的跨源请求也不会到达服务端日志。因此 RT-01 的早期失败只能从界面文案与 API 日志的“缺失”推断，已通过新增“上传失败”文案探针补上这一类信号。

## OBS-01 首剪产出偏薄（观察，非缺陷）

- **用户反馈**（2026-10-17）：“感觉 AI 根本没怎么动手。”
- **实际动作**（轮次 `agt_f1e9a0ad`，09:55:11→10:08:27）：33 次工具调用 = 7×`inspect_footage`、16×`look_at_footage`、3×`search_footage`、1×`list_footage`、1×`list_effects`、3×`look_at_timeline`、1×`review_draft`、**1×`edit_timeline`**；提案 10 个操作（5×insert_clip + 5×set_sequence_duration），成片 **66 秒、5 个片段、只用了 7 条素材中的 3 条**；无字幕、无音乐、无特效。
- **不是被轮次上限截断**：`DEFAULT_AGENT_RUNTIME_LIMITS.maxIterations=24`，本轮回复是正常完成语（“第一版做好了：66 秒、5 个头……”），不是 `LIMIT_REPLIES.iterations`。
- **模型自己给出的原因**：语音转写全部为空（分析任务还在跑/失败），所以按画面和手势节奏找切点；并指出素材里没有真正的开箱画面。
- **观察结论**：AI 的时间主要花在“看片”（16 次抽帧），实际剪辑只有 5 刀；在缺少转写的情况下，它只能做视觉节奏粗剪。若用户期望“用全部素材剪完整故事”，当前的首剪策略没有覆盖度/时长要求，也没有“用全部素材”的显式指令或旋钮。
- **建议（属 REQ-02/REQ-01 范围）**：首剪明确目标时长与覆盖度（如默认 1–2 分钟、尽量覆盖所有可用素材，或提供“高光/完整”选择）；把转写作为首剪前置（失败要如实说明并重试）；降低抽帧成本（proxy + 批量抽帧）；把本次的“看片→剪”动作过程展示出来（REQ-01）。

## OBS-02 全量 unit 首次偶发失败（观察）

- **现象**：接入 Elorian 后第一次 `pnpm test:unit` 退出码 1（具体失败用例未捕获，输出尾部被性能提示截断）；随后连续两次重跑均为 **119 文件 / 859 项通过**。
- **判定**：疑似 flake（或首次运行时的瞬时资源竞争）。没有可复现证据，不作为产品缺陷；记录以便后续复查。
- **建议**：出现时保留完整输出（`pnpm test:unit > unit.log 2>&1`），按用例名定位；当前不修改代码。
