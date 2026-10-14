# V6 外部能力接入清单

这份清单列出需要**你提供凭据或外部服务**才能变成"真实可用"的能力：配哪些环境变量、配在哪个进程、没配时产品如何表现、配好后怎么验证。没有出现在这里的功能不需要外部凭据（剪辑内核、FFmpeg 探测/代理/预览/终渲染、提案与撤销、共看片室界面都已用真实媒体验证）。

规则（AGENTS.md、V5 §4）：

- 密钥只放在服务端进程的环境变量里（云环境的 Secrets / 部署平台的密钥管理），**不要写进仓库、`.env.example`、日志或聊天**；客户端永远拿不到 Provider Key。
- 没配置的能力**明确失败**并在界面显示"未配置"，不会回退到 Mock；生产进程装配 Mock 需要显式 `ANCS_ALLOW_MOCK_PROVIDERS`。
- 配好之后的第一次真实调用就是验证：按下面"怎么验证"跑一遍，把结果（模型、用量、成本、耗时、截图）写进对应里程碑记录，才算真实 Provider 验证通过。

## 已接好代码、只差凭据

| 能力 | 用在哪 | 进程 | 环境变量 | 没配时 | 怎么验证 |
|---|---|---|---|---|---|
| AI 导演（Claude） | 共看片室的每一轮对话：剪第一版、按指令改、自检 | Worker | `ANCS_AGENT_DRIVER=anthropic`、`ANTHROPIC_API_KEY`；可选 `ANCS_AGENT_MODEL`（缺省 `claude-opus-5-5`） | 轮次失败 `AGENT_MODEL_NOT_CONFIGURED`，界面显示"AI 导演还没配置好" | ① 起 API + Worker + Web，新建作品、放 3 条素材、点"让 AI 剪第一版"；② 初剪评测：`node scripts/eval-first-cut.mjs --set evals/first-cut/travel.json --model anthropic --export`（见 `docs/V06/eval/first-cut-rubric.md`） |
| 镜头理解（视觉模型） | 素材"理解"中的画面说明，写入统一索引供 AI 检索 | Worker | `ANCS_VISUAL_ANALYSIS_DRIVER=anthropic`、`ANTHROPIC_API_KEY`；可选 `ANCS_VISION_MODEL`（缺省 `claude-haiku-5-5`） | 素材卡显示"画面：未配置"；AI 仍可用 `look_at_footage` 直接看帧（同样需要导演模型） | 上传一条素材，等"画面"变为"已理解"；在评测报告中查看说明质量与单条成本 |
| 语音转写（Deepgram 批量） | 素材里的说话内容，供 AI 找句子、不剪断句子 | Worker | `ANCS_ASR_DRIVER=deepgram`、`DEEPGRAM_API_KEY`；可选 `ANCS_DEEPGRAM_MODEL`、`ANCS_DEEPGRAM_LANGUAGE` | 素材卡显示"语音：未配置"；评测里"句子完整"为"无法评估" | 已在 `docs/verification/provider-real-deepgram.md` 核验过适配器；配好后上传一条有人声的素材，看"语音"变为"已理解" |
| 实时语音识别（共看片室边看边说） | 麦克风 → Realtime Gateway → 流式识别 → 边说边出的文字、"这个/这里"按说出那一刻绑定 → 一句话说完作为一轮对话发给 AI | Realtime Gateway（`apps/realtime`，新进程） | `ANCS_REALTIME_ASR_DRIVER=deepgram`、`DEEPGRAM_API_KEY`（可与批量转写同一把）；与 API 同一把 `ANCS_VOICE_SESSION_SECRET`（≥32 字符，API 也要配）；`ANCS_ALLOWED_ORIGINS`；可选 `ANCS_DEEPGRAM_LIVE_MODEL_ZH`（缺省 nova-2）/ `_EN`（缺省 nova-3）；反向代理转发 `/realtime/v1/voice` | 没配会话密钥：开麦提示"语音还没配置好"；没配识别：网关连接时回"未配置"并关闭 | 起网关（`node apps/realtime/dist/main.js`，`/health` 显示 deepgram）→ 共看片室点麦克风说"把这里剪短一点"（中文）和一句英文 → 看边说边出的文字、指向标签与生成的试改；记录首段转写延迟 |
| AI 当场写特效代码（可选，能力探测后开启） | 共看片室里模板不够用时，AI 自己写特效代码（先过四道门禁再渲染）；不开时只用模板库（模板特效无需任何凭据） | Worker | 先接好 AI 导演（上一行）；`ANCS_EFFECT_CODEGEN=enabled` | 缺省 `disabled`：AI 只用模板；写代码会被拒绝并提示用模板 | 用同一组"框选 + 一句话"请求分别走模板与写代码，记录门禁通过率、渲染耗时与人工评分（见 `docs/V06/milestones/V6-3.md`），达标后再开启 |
| 讲述配音（V6-5） | "从文章开始"做解说视频时的 AI 配音，以及任何作品里的讲述轨 | Worker | 二选一：`ANCS_NARRATION_DRIVER=flite`（本机 FFmpeg 带 libflite 即可，**只会英文**、音质基础，无需密钥）；或 `ANCS_NARRATION_DRIVER=process` + `ANCS_NARRATION_EXECUTABLE`（你写的小程序调用任意供应商：每句启动一次，stdin 一行 JSON `{"text","voice","speed"}`，stdout 输出音频；供应商密钥由这个程序自己从环境读取）+ `ANCS_NARRATION_VOICES_JSON`（声音与语言，如 `[{"id":"zh-female-1","name":"晓晓","languages":["zh"],"description":"温和女声"}]`）；可选 `ANCS_NARRATION_ARGS_JSON` | 不装配：AI 回复"这个部署没有配置配音"，可以只做图解卡与字幕；只配 flite 时中文讲述被如实拒绝（"没有会说中文的声音"） | 新建 → 从文章开始（中文文章）→ "让 AI 讲成视频" → 预览里听到讲述、字幕逐句出现；记录每分钟合成耗时与费用 |
| 从参考视频学风格：平台链接（可选） | 在"从参考视频学风格"里直接粘贴平台视频页链接（如 YouTube）；上传文件和直接的视频文件链接不需要这一项 | Worker | `ANCS_REFERENCE_FETCH_CMD`（必须含 `{url}` 与 `{output}`），例：`yt-dlp --no-playlist -f mp4/bestvideo*+bestaudio/best -o {output} {url}`（需在 Worker 机器上安装 yt-dlp 与 FFmpeg）；网络放行该平台的页面与媒体域名（YouTube：`www.youtube.com`、`youtube.com`、`m.youtube.com`、`youtubei.googleapis.com`、`*.googlevideo.com`）；可选 `ANCS_REFERENCE_MAX_MB` | 页面链接明确失败"这个链接是网页，服务端还没配置下载工具……请先把视频下载下来再上传" | ① 本机先试：`ANCS_REFERENCE_FETCH_CMD='…' node scripts/distill-reference.mjs <链接1> <链接2> <链接3> --json style.json`，看每条的剪点、节拍、色彩与合成的风格说明；② 共看片室"风格（可选）"→"从参考视频学风格"粘贴同样的链接。平台可能拒绝数据中心 IP（如 YouTube 要求登录验证），这时在本机下载后上传文件。参考视频的使用须符合平台条款与版权，系统只测量手法、记录来源 |
| 风格说明由 AI 撰写（可选） | 学风格时 AI 看测量结果和抽帧写说明（补充画面类观察）；数值仍只来自测量 | Worker | 与 AI 导演同一配置（`ANCS_AGENT_DRIVER`、`ANTHROPIC_API_KEY`） | 用规则版说明（结果卡标明"按测量统计自动写的说明（没有 AI 看片）"） | 学同一组参考视频，结果卡显示"AI 看过测量结果和画面后写的说明"；记录模型、用量与成本（工作流输出 `costMicros`） |
| 音频事件分析（可选） | 笑声、掌声、音乐段落等 | Worker | `ANCS_AUDIO_ANALYSIS_EXECUTABLE`（+ `ANCS_AUDIO_ANALYSIS_ARGS_JSON`）：你自己的子进程，stdout 输出 `GeneratedMediaAudioAnalysis` JSON | 不装配，该层缺失 | 上传素材后看统一索引里出现音频事件层 |

## 测试素材（可选，只用于本地测试与评测）

| 来源 | 环境变量 | 网络 | 怎么用 |
|---|---|---|---|
| Pexels（免费，Pexels License，需署名，不入库） | `PEXELS_API_KEY`（https://www.pexels.com/api/ 免费申请） | 放行 `api.pexels.com`、`videos.pexels.com`；云端会话里 Node 需 `NODE_USE_ENV_PROXY=1` | `NODE_USE_ENV_PROXY=1 node scripts/fetch-pexels-footage.mjs --query "iceland road trip" --count 6` → `Videos/pexels/<查询词>/`（素材、`credits.json`、`eval-set.json`）→ `node scripts/eval-first-cut.mjs --set Videos/pexels/<查询词>/eval-set.json --model anthropic --export` |

替代方案：转写与视觉也可以接你自己的子进程（`ANCS_ASR_EXECUTABLE` / `ANCS_VISUAL_ANALYSIS_EXECUTABLE`，协议见 `packages/contracts/src/env.ts` 注释），适合本地模型或其他供应商。

## 基础设施（任何部署都要）

| 项 | 进程 | 环境变量 | 说明 |
|---|---|---|---|
| 数据库 | API、Worker | `DATABASE_URL` | PostgreSQL 16；部署前执行迁移（命令见 `docs/ops/deployment-runbook.md`） |
| 会话签名 | API、Worker | `BETTER_AUTH_SECRET`（≥16 字符）、`BETTER_AUTH_URL` | |
| 凭据加密 | API | `ANCS_CREDENTIAL_KEYS`（`v1:<base64 32 字节>`） | **生产必填**，不得与会话密钥共用 |
| 存储签名 | API、Worker | `ANCS_STORAGE_SECRET`（两者同一把）、`ANCS_STORAGE_PUBLIC_BASE_URL` | 当前只有本地磁盘驱动；S3/R2 适配器属后续 |
| 队列 | Worker | `ANCS_QUEUE_DRIVER=bullmq` + `REDIS_URL` | 缺省为数据库轮询 |
| 特效渲染（V6-3） | Worker | 无需凭据；需要 Chromium 无头浏览器（`REMOTION_BROWSER_EXECUTABLE`）与 FFmpeg；可选 `ANCS_EFFECT_RENDER_CMD` | 在仓库根启动 Worker 时自动装配；`ANCS_DISABLE_RENDER=1` 时不装配（特效工具明确报不可用）。素材作品缺省不允许程序化特效，由用户在共看片室顶栏开启 |
| 参考视频测量（V6-6） | Worker | 无需凭据；需要 FFmpeg（镜头、黑场、色彩、响度、节拍全部本地测量） | 缺 FFmpeg 时学风格明确失败"这个部署还没有装好分析工具"。参考视频存为工作区素材库里的草稿资产（30 天保留类，许可证"未知"并记录来源链接） |
| 浏览器来源 | API | `ANCS_ALLOWED_ORIGINS` | Web 与 API 不同源时列出 Web 的 origin（留空 = `BETTER_AUTH_URL` 的 origin） |

完整变量与校验规则：`packages/contracts/src/env.ts`；部署步骤：`docs/ops/deployment-runbook.md`；示例：`.env.example`。

## 后续里程碑会新增（届时补到本表）

| 里程碑 | 能力 | 预计需要 |
|---|---|---|
| V6-2（剩余） | AI 用合成语音回应（当前用浏览器自带朗读）；中国大陆可用的实时语音供应商（区域路由） | 语音合成 Provider 的 Key；国内流式识别供应商的 Key（接入同一个 `StreamingSpeechRecognizer` 端口） |
| V6-7 | 数字人 | 数字人 Provider 的 Key |
| V6-8 | 生成式特效与视频生成（先报价、后生成）；特效自动配音效 | 视频生成 Provider 的 Key；音效生成或音效库；按次计费，生成前必须展示报价并由用户确认 |
