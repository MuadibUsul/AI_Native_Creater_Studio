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
| 音频事件分析（可选） | 笑声、掌声、音乐段落等 | Worker | `ANCS_AUDIO_ANALYSIS_EXECUTABLE`（+ `ANCS_AUDIO_ANALYSIS_ARGS_JSON`）：你自己的子进程，stdout 输出 `GeneratedMediaAudioAnalysis` JSON | 不装配，该层缺失 | 上传素材后看统一索引里出现音频事件层 |

替代方案：转写与视觉也可以接你自己的子进程（`ANCS_ASR_EXECUTABLE` / `ANCS_VISUAL_ANALYSIS_EXECUTABLE`，协议见 `packages/contracts/src/env.ts` 注释），适合本地模型或其他供应商。

## 基础设施（任何部署都要）

| 项 | 进程 | 环境变量 | 说明 |
|---|---|---|---|
| 数据库 | API、Worker | `DATABASE_URL` | PostgreSQL 16；部署前执行迁移（命令见 `docs/ops/deployment-runbook.md`） |
| 会话签名 | API、Worker | `BETTER_AUTH_SECRET`（≥16 字符）、`BETTER_AUTH_URL` | |
| 凭据加密 | API | `ANCS_CREDENTIAL_KEYS`（`v1:<base64 32 字节>`） | **生产必填**，不得与会话密钥共用 |
| 存储签名 | API、Worker | `ANCS_STORAGE_SECRET`（两者同一把）、`ANCS_STORAGE_PUBLIC_BASE_URL` | 当前只有本地磁盘驱动；S3/R2 适配器属后续 |
| 队列 | Worker | `ANCS_QUEUE_DRIVER=bullmq` + `REDIS_URL` | 缺省为数据库轮询 |
| 浏览器来源 | API | `ANCS_ALLOWED_ORIGINS` | Web 与 API 不同源时列出 Web 的 origin（留空 = `BETTER_AUTH_URL` 的 origin） |

完整变量与校验规则：`packages/contracts/src/env.ts`；部署步骤：`docs/ops/deployment-runbook.md`；示例：`.env.example`。

## 后续里程碑会新增（届时补到本表）

| 里程碑 | 能力 | 预计需要 |
|---|---|---|
| V6-2 | 流式双语语音对话（边说边识别、AI 语音回应） | 流式 ASR（Deepgram 流式，同一把 `DEEPGRAM_API_KEY`）；语音合成 Provider 的 Key |
| V6-5 | 讲述/旁白配音 | TTS Provider 的 Key |
| V6-7 | 数字人 | 数字人 Provider 的 Key |
| V6-8 | 生成式特效与视频生成（先报价、后生成） | 视频生成 Provider 的 Key；按次计费，生成前必须展示报价并由用户确认 |
