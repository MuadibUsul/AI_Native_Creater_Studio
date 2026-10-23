# V6 外部能力接入清单

这份清单列出需要**你提供凭据或外部服务**才能变成"真实可用"的能力：配哪些环境变量、配在哪个进程、没配时产品如何表现、配好后怎么验证。没有出现在这里的功能不需要外部凭据（剪辑内核、FFmpeg 探测/代理/预览/终渲染、提案与撤销、共看片室界面都已用真实媒体验证）。

规则（AGENTS.md、V5 §4）：

- 密钥只放在服务端进程的环境变量里（云环境的 Secrets / 部署平台的密钥管理），**不要写进仓库、`.env.example`、日志或聊天**；客户端永远拿不到 Provider Key。
- 没配置的能力**明确失败**并在界面显示"未配置"，不会回退到 Mock；生产进程装配 Mock 需要显式 `ANCS_ALLOW_MOCK_PROVIDERS`。
- 配好之后的第一次真实调用就是验证：按下面"怎么验证"跑一遍，把结果（模型、用量、成本、耗时、截图）写进对应里程碑记录，才算真实 Provider 验证通过。

## 已接好代码、只差凭据

### DeepSeek 导演（2026-10-15 已真实验证）

Worker 配置 `ANCS_AGENT_DRIVER=deepseek`、`DEEPSEEK_API_KEY`；可选 `ANCS_AGENT_MODEL`，缺省 `deepseek-v4-pro`。
含图像的会话历史使用 `deepseek-flash`（Pro 为文本模型）；图像只作为 user 消息发送，工具返回图片按调用 id 关联。
密钥只放服务端环境或未跟踪的 `.env`，不发给浏览器。缺密钥启动失败，不回退 Mock。
工具调用、提案、预算、工作流重试与用量账本沿用现有导演链路；没有内置价格，界面明确显示未定价调用。
真实工具往返、浏览器导演轮次和 Flash 看帧验证见 `docs/V06/milestones/deepseek-provider.md`。
**计价**：DeepSeek 不在内置单价表里。设了 `ANCS_AI_MONTHLY_CAP_USD` 时必须在 `ANCS_MODEL_PRICES_JSON` 给出 `deepseek-v4-pro` 与 `deepseek-flash` 的单价（按账户价格页），否则导演不调用它（手册 §10.5）。

### Elorian 视频/画面理解（2026-10-17 接入；真实推理待余额）

Worker 配置 `ANCS_VISUAL_ANALYSIS_DRIVER=elorian`、`ELORIAN_API_KEY`；可选 `ANCS_VISION_MODEL`，缺省 `elorian-1-agent`。设了月度 AI 上限时同样需要在 `ANCS_MODEL_PRICES_JSON` 给出 `elorian-1-agent` 的单价。
OpenAI 兼容 Chat Completions（`https://api.elorian.ai/v1/chat/completions`）；模型支持 text/image/video（`/v1/models` 实测），图片以 data URL 放在 user 消息里，工具返回图片按调用 id 关联。
适配器不自动重试；余额不足返回 429 + `insufficient_quota` 时归为**不可重试**的 AUTH，避免把计费问题当限流反复重试。密钥只放服务端环境或未跟踪的 `.env`；缺密钥启动失败，不回退 Mock。
**验证状态**：代码、单测、typecheck、build、arch:check 通过；`GET /v1/models` 鉴权成功；**真实推理尚未验证——账户余额 $0.00（HTTP 429 `insufficient_quota`）**。真实素材链路已实测：对 650MB 素材重建 SAMPLING/VISION 阶段，Worker 抽帧后调用 Elorian 并返回 `Elorian request failed (HTTP 429, insufficient quota)`，`attempts=1`、`FAILED_FINAL`（不重试），说明链路已通、只差余额。充值后按表格里的"怎么验证"跑一次并记录模型、用量、耗时与费用。


| 能力 | 用在哪 | 进程 | 环境变量 | 没配时 | 怎么验证 |
|---|---|---|---|---|---|
| AI 导演（Claude） | 共看片室的每一轮对话：剪第一版、按指令改、自检 | Worker | `ANCS_AGENT_DRIVER=anthropic`、`ANTHROPIC_API_KEY`；可选 `ANCS_AGENT_MODEL`（缺省 `claude-opus-5-5`）；走兼容 Anthropic Messages 协议的网关时加 `ANCS_ANTHROPIC_BASE_URL`（https，填到 `/v1` 之前，Key 填网关发的） | 轮次失败 `AGENT_MODEL_NOT_CONFIGURED`，界面显示"AI 导演还没配置好" | ① 起 API + Worker + Web，新建作品、放 3 条素材、点"让 AI 剪第一版"；② 初剪评测：`node scripts/eval-first-cut.mjs --set evals/first-cut/travel.json --model anthropic --export`（见 `docs/V06/eval/first-cut-rubric.md`） |
| AI 导演（Google Gemini，已真实验证） | 同上（与 Claude 二选一；风格撰写也用它） | Worker | `ANCS_AGENT_DRIVER=gemini`、`GEMINI_API_KEY`；可选 `ANCS_AGENT_MODEL`（缺省 `gemini-flash-latest`；高峰期 flash 可能 503 或首字很慢，实测用 `gemini-flash-lite-latest`）；网络放行 `generativelanguage.googleapis.com`（本云环境已通） | 同上 | 已验证（2026-10-14，`gemini-flash-lite-latest`，见 `docs/V06/milestones/gemini-provider.md`）：全部导演工具 schema 被接受、思考签名回放、并行工具调用、工具返回的抽帧图像；初剪评测 5 个用例全部完成；浏览器全流程 `scripts/gemini-browser-check.mjs` 4/4。Gemini 的价格本仓库没有可核对的公开价，计量显示"含未定价调用" |
| 镜头理解（视觉模型） | 素材"理解"中的画面说明，写入统一索引供 AI 检索 | Worker | `ANCS_VISUAL_ANALYSIS_DRIVER=anthropic`、`ANTHROPIC_API_KEY`；可选 `ANCS_VISION_MODEL`（缺省 `claude-haiku-5-5`） | 素材卡显示"画面：未配置"；AI 仍可用 `look_at_footage` 直接看帧（同样需要导演模型） | 上传一条素材，等"画面"变为"已理解"；在评测报告中查看说明质量与单条成本 |
| 镜头理解（Gemini 视觉，已真实验证） | 同上 | Worker | `ANCS_VISUAL_ANALYSIS_DRIVER=gemini`、`GEMINI_API_KEY`；可选 `ANCS_VISION_MODEL`（缺省 `gemini-flash-lite-latest`） | 同上 | 已验证：3 段素材 16 s 内"画面"全部"已理解"（浏览器截图 `docs/verification/artifacts/gemini/01-footage-understood.png`） |
| 镜头理解（Elorian，2026-10-17 接入） | 同上 | Worker | `ANCS_VISUAL_ANALYSIS_DRIVER=elorian`、`ELORIAN_API_KEY`；可选 `ANCS_VISION_MODEL`（缺省 `elorian-1-agent`） | 同上（画面"未配置"） | **真实推理待余额**：账户 $0.00 时返回 429 `insufficient_quota`（已归为不可重试的 AUTH）。充值后上传一条素材，等"画面"变为"已理解"，记录模型、用量、耗时与费用；单测与协议形状见 `packages/providers/elorian/src/index.test.ts` |
| 语音转写（Deepgram 批量） | 素材里的说话内容，供 AI 找句子、不剪断句子 | Worker | `ANCS_ASR_DRIVER=deepgram`、`DEEPGRAM_API_KEY`；可选 `ANCS_DEEPGRAM_MODEL`、`ANCS_DEEPGRAM_LANGUAGE` | 素材卡显示"语音：未配置"；评测里"句子完整"为"无法评估" | 已在 `docs/verification/provider-real-deepgram.md` 核验过适配器；配好后上传一条有人声的素材，看"语音"变为"已理解" |
| 实时语音识别（共看片室边看边说） | 麦克风 → Realtime Gateway → 流式识别 → 边说边出的文字、"这个/这里"按说出那一刻绑定 → 一句话说完作为一轮对话发给 AI（AI 忙时排队） | Realtime Gateway（`apps/realtime`，新进程） | 二选一：`ANCS_REALTIME_ASR_DRIVER=deepgram` + `DEEPGRAM_API_KEY`（可选 `ANCS_DEEPGRAM_LIVE_MODEL_ZH` / `_EN`）；或 `ANCS_REALTIME_ASR_DRIVER=openai` + `OPENAI_API_KEY`（OpenAI 兼容转写接口；兼容网关另配 `ANCS_OPENAI_BASE_URL`，含 `/v1`；可选 `ANCS_REALTIME_ASR_MODEL` 缺省 `gpt-4o-transcribe`、`ANCS_REALTIME_ASR_INTERIM_MS` 缺省 900）。都需要与 API 同一把 `ANCS_VOICE_SESSION_SECRET`（≥32 字符）、`ANCS_ALLOWED_ORIGINS`；反向代理转发 `/realtime/v1/voice` | 没配会话密钥：开麦提示"语音还没配置好"；没配识别：网关回"未配置"并关闭，界面如实说明 | **openai 驱动已真实验证**（2026-10-15，经 OpenAI 兼容网关，`gpt-4o-transcribe`；Issue #9，见 `docs/V06/milestones/V6-2.md`）：`node scripts/voice-live-check.mjs`。openai 驱动是"分段转写"：网关自己断句，说话中每 0.9 s 音频转写一次出临时文字，词时间按发声段估算；首段文字要等一次转写往返（实测 2–4.5 s），比真正的流式识别慢。Deepgram 流式仍待密钥 |
| AI 语音回应（服务端合成，可打断） | 用语音说的那一轮，AI 回应的要点由网关合成后边合成边下发、浏览器边收边播；用户一开口立即停播；可切换声音（只列实际可用的） | Realtime Gateway | `ANCS_REALTIME_TTS_DRIVER=openai`、`OPENAI_API_KEY`（与识别共用）；可选 `ANCS_REALTIME_TTS_MODEL`（缺省 `gpt-4o-mini-tts`）、`ANCS_REALTIME_TTS_VOICES_JSON`（如 `[{"id":"coral","name":"Coral"},{"id":"onyx","name":"Onyx"}]`，缺省只有 coral） | 用浏览器自带朗读（语音条标注"浏览器朗读"），不显示声音下拉 | 已真实验证（同上）：回应首块音频 1.5–3.3 s，开口到停声约 0.1 s；用量按字符（只念回应开头至多 360 字、到句号为止） |
| AI 当场写特效代码（可选，能力探测后开启） | 共看片室里模板不够用时，AI 自己写特效代码（先过四道门禁再渲染）；不开时只用模板库（模板特效无需任何凭据） | Worker | 先接好 AI 导演（上一行）；`ANCS_EFFECT_CODEGEN=enabled` | 缺省 `disabled`：AI 只用模板；写代码会被拒绝并提示用模板 | 用同一组"框选 + 一句话"请求分别走模板与写代码，记录门禁通过率、渲染耗时与人工评分（见 `docs/V06/milestones/V6-3.md`），达标后再开启 |
| 讲述配音（V6-5） | "从文章开始"做解说视频时的 AI 配音，以及任何作品里的讲述轨 | Worker | 二选一：`ANCS_NARRATION_DRIVER=flite`（本机 FFmpeg 带 libflite 即可，**只会英文**、音质基础，无需密钥）；或 `ANCS_NARRATION_DRIVER=process` + `ANCS_NARRATION_EXECUTABLE`（你写的小程序调用任意供应商：每句启动一次，stdin 一行 JSON `{"text","voice","speed"}`，stdout 输出音频；供应商密钥由这个程序自己从环境读取）+ `ANCS_NARRATION_VOICES_JSON`（声音与语言，如 `[{"id":"zh-female-1","name":"晓晓","languages":["zh"],"description":"温和女声"}]`）；可选 `ANCS_NARRATION_ARGS_JSON` | 不装配：AI 回复"这个部署没有配置配音"，可以只做图解卡与字幕；只配 flite 时中文讲述被如实拒绝（"没有会说中文的声音"） | 新建 → 从文章开始（中文文章）→ "让 AI 讲成视频" → 预览里听到讲述、字幕逐句出现；记录每分钟合成耗时与费用 |
| 讲述配音：Fish Audio（V6-5，推荐） | 同上；**中英文等多语言**、自然音色，声音由你在 Fish Audio 上选择或克隆 | Worker | `ANCS_NARRATION_DRIVER=fish`、`FISH_AUDIO_API_KEY`、`ANCS_NARRATION_VOICES_JSON`（`id` 填 Fish Audio 的声音模型 id，如 `[{"id":"<fish 声音 id>","name":"我的声音","languages":["zh","en"],"description":"…"}]`）；可选 `ANCS_FISH_AUDIO_MODEL`（缺省 `s1`）；网络放行 `api.fish.audio` | 同上 | ① `FISH_AUDIO_API_KEY=… NODE_USE_ENV_PROXY=1 node scripts/provider-smoke.mjs --fish-voice <声音 id>`（合成一句话，几分钱以内）；② 从文章开始（中文文章）→ 让 AI 讲成视频 → 预览里听到中文讲述、字幕逐句出现；记录每分钟耗时与 Fish 账单费用。协议形状已用本地替身测试（`apps/worker/src/fish-heygen.integration.test.ts`），**真实服务尚未验证** |
| 讲述配音：Gemini TTS（V6-5，已真实验证中文） | 同上；中英等多语言，Gemini 预置声音（缺省 Kore / Charon / Puck / Aoede，可用 `ANCS_NARRATION_VOICES_JSON` 覆盖，`id` 为小写声音名） | Worker | `ANCS_NARRATION_DRIVER=gemini`、`GEMINI_API_KEY`；可选 `ANCS_GEMINI_TTS_MODEL`（缺省 `gemini-3.8-flash-lite-tts`） | 同上 | 已验证：中文文章用例的讲述由 Gemini 合成（3 句），导出成片里再用 Gemini 转写回来与原文逐字一致。**免费层每个 TTS 模型每天只有 10 次请求**（逐句合成，一篇文章就用掉一半以上）；按分钟的配额会按供应商给的等待时间有界重试，按天的配额用完立即如实失败。正式使用请开通付费层 |
| 数字人出镜：HeyGen + Fish Audio（V6-7） | 共看片室里说"用我的数字人说这段"：AI 报价 → 你确认 → 用你的照片（HeyGen 会说话的照片）+ 你的声音（Fish Audio 用声音样本建私有声音）生成出镜片段，放进试改 | Worker | `ANCS_AVATAR_DRIVER=heygen`、`HEYGEN_API_KEY`、`FISH_AUDIO_API_KEY`；可选 `ANCS_AVATAR_OFFER_JSON`（报价依据，缺省为 V6 §10.1 规划区间 $2–6/分钟，请按你的 HeyGen 套餐改）；网络放行 `api.heygen.com`、`upload.heygen.com`、HeyGen 视频下载域名（视频完成后返回的签名链接所在域名）、`api.fish.audio`；**工作区必须设置生成预算**（计费设置，或 `PUT /workspaces/:id/billing/budget`） | 没配：AI 回复"这个部署还没有接入这类生成的供应商"；没设预算：确认被拒"工作区还没有设置生成预算" | ① `… node scripts/provider-smoke.mjs` 读 HeyGen 额度（不计费）；② `… --heygen-generate 照片.png 声音.wav` 生成约 2 秒（消耗额度）；③ 共看片室：我的形象与声音页上传照片与声音样本并授权 → 作品里"生成：开""配音：开" → 说"用我的数字人在右下角说「…」" → 确认报价 → 试改里出现画中画与人声轨；记录耗时、HeyGen 实际扣的额度与报价是否吻合。HeyGen 不在接口里报美元费用，平台按报价上限结算并标明 |
| 视频生成：生成镜头 / 选区重绘（V6-8） | "生成一个镜头""把框里的天空换成晚霞"：AI 报价 → 你确认 → 生成一次 → 放进试改（选区重绘只取框内，框外保持原片并测量供应商是否改了框外） | Worker | `ANCS_GENERATION_DRIVER=process`、`ANCS_GENERATION_EXECUTABLE`（你写的小程序调用供应商，协议见 `scripts/generation-process-example.mjs`）、`ANCS_GENERATION_OFFERS_JSON`（每类的每秒价格区间与单次上限）；可选 `ANCS_GENERATION_ARGS_JSON`、`ANCS_GENERATION_PASS_ENV`（要传给小程序的供应商密钥变量名，子进程只拿到这些）、`ANCS_GENERATION_TIMEOUT_SECONDS`；同样要求工作区生成预算 | 同上 | 照示例写好小程序后：共看片室框出区域说"把这里换成……" → 确认 → 看试改与"框外改动"提示；记录单次耗时、费用与报价是否吻合 |
| 生成镜头：Google Veo（V6-8） | "生成一个镜头"：AI 报价 → 你确认 → Veo 文生视频一次 → 统一到项目画布与帧率 → 放进试改。Veo 只能生成 4/6/8 秒，报价与预留按不短于所需的最短一档；选区重绘不走 Veo | Worker | `GEMINI_API_KEY` + `ANCS_VEO_OFFER_JSON`（配置即启用），例 `{"kind":"VIDEO_SHOT","providerId":"veo","implementation":"REAL","model":"veo-3.1-fast-generate-preview","perSecondMicros":{"min":…,"max":…},"maxSeconds":8,"durationOptions":[4,6,8]}`——**价格请按 Google 价格页填写**（本环境打不开价格页，平台不内置）；同样要求工作区生成预算 | 同上 | 协议形状与计费结局已用本地替身测试（`apps/worker/src/gemini-media.integration.test.ts`）；**真实 Veo 还没生成过**：2026-10-14 经你确认做了一次 4 秒测试，这把 Key 在免费层没有 Veo 配额，fast 与 lite 都在提交时被拒（429，没有生成、没有扣费）。开通 Google Cloud 结算（付费层）后：`GEMINI_API_KEY=… NODE_USE_ENV_PROXY=1 node scripts/provider-smoke.mjs --veo-generate`（生成 4 秒），再在共看片室说"在开头生成一个 4 秒的……镜头"走全流程；记录耗时、Google 账单金额与报价是否吻合、被安全过滤时是否计费 |
| 生成镜头：火山方舟 Seedance（V6-8） | "生成一个镜头"：AI 报价 → 你确认 → Seedance 文生视频一次（缺省同时生成声音）→ 统一到项目画布与帧率 → 放进试改。画面比例按项目画布取 Seedance 支持的最接近一档（21:9 / 16:9 / 4:3 / 1:1 / 3:4 / 9:16），时长按报价依据的整数秒档位 | Worker | `ARK_API_KEY` + `ANCS_SEEDANCE_OFFER_JSON`（配置即启用），例 `{"kind":"VIDEO_SHOT","providerId":"seedance","implementation":"REAL","model":"doubao-seedance-2-5-260628","perSecondMicros":{"min":…,"max":…},"maxSeconds":10,"durationOptions":[5,10]}`——方舟按 token 计价、人民币结算，**请按方舟价格页换算成美元微单位填写**（平台不内置）；可选 `ANCS_SEEDANCE_GENERATE_AUDIO=0`、`ANCS_SEEDANCE_RESOLUTION`（如 720p）、`ANCS_ARK_BASE_URL`（海外区域）；网络放行 `ark.cn-beijing.volces.com` 与成片下载所在的对象存储域名（`*.tos-cn-beijing.volces.com`，或直接 `*.volces.com`）；同样要求工作区生成预算 | 同上 | 协议形状与计费结局已用本地替身测试（`packages/providers/ark/src/index.test.ts`、`apps/worker/src/ark-media.integration.test.ts`）；**真实 Seedance 尚未调用：本云环境的网络策略拦下了 `*.volces.com`**。放行后：`ARK_API_KEY=… NODE_USE_ENV_PROXY=1 node scripts/provider-smoke.mjs --seedance-generate doubao-seedance-2-5-260628`（生成 5 秒），再在共看片室说"在开头生成一个 5 秒的……镜头"走全流程；记录耗时、用量 tokens、方舟账单与报价是否吻合 |
| 选区重绘：Runway gen4_aleph（V6-8） | "把框里的天空换成……"：AI 报价 → 你确认 → 被重绘的那段原片（执行器已裁好并适配画布）压成小体积、去声音，以 data URI 交给 Runway 改写一次 → 成片统一到画布与帧率 → 只取框内放进试改，框外保持原片并测量 Runway 是否改了框外 | Worker | `RUNWAYML_API_SECRET` + `ANCS_RUNWAY_OFFER_JSON`（配置即启用），例 `{"kind":"VIDEO_REGION","providerId":"runway","implementation":"REAL","model":"gen4_aleph","perSecondMicros":{"min":…,"max":…},"maxSeconds":5}`——**价格按 Runway 价格页换算填写**（credits 按秒计）；可选 `ANCS_RUNWAY_BASE_URL`；网络放行 `api.dev.runwayml.com` 与成片下载域名（以第一次任务返回的链接为准）；同样要求工作区生成预算 | 同上 | 鉴权已用真实服务验证（`gen4_aleph` 在该账户可用模型里）；协议与计费结局用本地替身测试（`packages/providers/runway/src/index.test.ts`、`apps/worker/src/runway-media.integration.test.ts`）；**真实生成待充值 credits**：`RUNWAYML_API_SECRET=… NODE_USE_ENV_PROXY=1 node scripts/provider-smoke.mjs --runway-generate`（改写 2 秒测试原片） |
| 从参考视频学风格：平台链接（可选） | 在"从参考视频学风格"里直接粘贴平台视频页链接（如 YouTube）；上传文件和直接的视频文件链接不需要这一项 | Worker | `ANCS_REFERENCE_FETCH_CMD`（必须含 `{url}` 与 `{output}`），例：`yt-dlp --no-playlist -f mp4/bestvideo*+bestaudio/best -o {output} {url}`（需在 Worker 机器上安装 yt-dlp 与 FFmpeg）；网络放行该平台的页面与媒体域名（YouTube：`www.youtube.com`、`youtube.com`、`m.youtube.com`、`youtubei.googleapis.com`、`*.googlevideo.com`）；可选 `ANCS_REFERENCE_MAX_MB` | 页面链接明确失败"这个链接是网页，服务端还没配置下载工具……请先把视频下载下来再上传" | ① 本机先试：`ANCS_REFERENCE_FETCH_CMD='…' node scripts/distill-reference.mjs <链接1> <链接2> <链接3> --json style.json`，看每条的剪点、节拍、色彩与合成的风格说明；② 共看片室"风格（可选）"→"从参考视频学风格"粘贴同样的链接。平台可能拒绝数据中心 IP（如 YouTube 要求登录验证），这时在本机下载后上传文件。参考视频的使用须符合平台条款与版权，系统只测量手法、记录来源 |
| 风格说明由 AI 撰写（可选） | 学风格时 AI 看测量结果和抽帧写说明（补充画面类观察）；数值仍只来自测量 | Worker | 与 AI 导演同一配置（`ANCS_AGENT_DRIVER` + 对应密钥：Claude 或 Gemini） | 用规则版说明（结果卡标明"按测量统计自动写的说明（没有 AI 看片）"） | 学同一组参考视频，结果卡显示"AI 看过测量结果和画面后写的说明"；记录模型、用量与成本（工作流输出 `costMicros`） |
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
| V6-2（剩余） | 真正的流式识别（首字更快）；中国大陆可用的实时语音供应商（区域路由） | Deepgram 或国内流式识别供应商的 Key（接入同一个 `StreamingSpeechRecognizer` 端口） |
| V6-8（剩余） | 特效自动配音效；生成带透明通道的元素贴进选区并跟随物体（V6 §7.3 第二档） | 音效生成或音效库；带透明通道的元素生成供应商 |
