# Google Gemini 接入：导演 / 视觉理解 / 讲述配音 / Veo 生成镜头

- 状态：**导演、视觉理解、讲述配音已用真实 Gemini 验证**（2026-10-14，项目所有者提供的 API Key，免费层）；Veo 生成镜头的适配器与计费结局已用本地替身验证，**真实 Veo 尚未调用**（按秒计费，等项目所有者确认）。这不是新的 V6 里程碑，而是给 V6-1（导演）、V6-1b（视觉理解）、V6-5（讲述）、V6-6（风格撰写）、V6-8（生成镜头）接上第二家真实供应商；产品行为与界面不变
- 依据：V6 §6（AI 通用能力：导演与调度代码不按供应商或类型分支，模型只是端口）、§8（Agent Runtime 的模型端口）、§10（付费生成先报价、不自动重试）；AGENTS.md（密钥只在服务端；Mock ≠ 真实验证；价格不臆造；外部调用只经 Worker 端口）
- 目标体验：只有 Gemini Key 的部署也能用真实 AI 剪片、理解画面、用中文讲述；生成镜头接 Veo 时报价准确、失败如实

## 设计要点

- **一个模型端口，两家实现。** `packages/providers/gemini` 的 `GeminiAgentModel` 实现与 Claude 相同的 `AgentModelAdapter`：系统提示 → `systemInstruction`，工具 → `functionDeclarations`（`parametersJsonSchema` 直接用工具的 JSON Schema，只去掉 `$schema`），工具结果 → `functionResponse`（按调用 id 找回工具名），工具返回的抽帧图像作为同一轮的 `inlineData` 跟在后面。导演、视觉理解（`createModelVisualAnalysisAdapter`）与风格撰写都不知道背后是哪家。
- **思考签名原样回放。** Gemini 把 `thoughtSignature` 挂在返回的分片上，下一次请求必须原样带回：转成紧挨在对应块前面的 `opaque` 块，回放时挂回下一个分片；无法表示的分片整片存成 `opaque`。别家写的工具调用回放给 Gemini 时用文档给出的占位签名。
- **失败分类与有界重试。** 429 / 503 / 5xx / 连接失败：优先按供应商给的 `RetryInfo.retryDelay`（≤ 60 s）等待，否则指数退避，缺省最多 2 次（TTS 4 次）；**按天的配额用完不重试**（立即如实失败）；鉴权 / 请求错误不重试；`MALFORMED_FUNCTION_CALL` 原样重发至多 2 次。错误信息只取供应商的 `error.message`（截断），不含密钥。
- **密钥只在请求头。** `x-goog-api-key`；文件下载只对 API 同源链接带密钥，**不自动跟随跳转**——跳转到存储域名时不带密钥另行请求（测试断言存储主机收不到密钥）。
- **讲述配音：** Gemini TTS 预置声音（缺省 Kore / Charon / Puck / Aoede，`id` 为小写声音名），逐句合成；裸 PCM（`audio/L16;rate=…`）包成 WAV；Gemini 没有语速参数，语速由 FFmpeg 统一调整。
- **Veo 生成镜头：** 只接 `VIDEO_SHOT`（选区重绘仍走进程协议）。Veo 只能生成固定时长（4/6/8 秒）→ 报价依据新增 `durationOptions`，**报价、预留与计费都按不短于所需的最短一档**（`billedSeconds`），工具结果里给 AI 看 `billedSeconds`；生成后统一到项目画布（等比放大铺满后居中裁切）与帧率，保留 Veo 生成的声音。计费结局：提交 4xx = 不扣费；提交 5xx / 断网 = 结果不明；任务报错或被安全过滤 = 按不扣费处理（**以 Google 账单为准，待真实核对**）；超时 = 结果不明；已产出但下载 / 转换失败 = 已扣费；从不自动重试。Veo 不报告费用 → 按报价上限结算并标明。
- **价格不臆造。** 本环境打不开 Google 价格页：Gemini 模型调用记用量、成本记"未定价"（界面显示"AI 用量含未定价调用"）；Veo 的每秒价格由部署方在 `ANCS_VEO_OFFER_JSON` 里按价格页填写，平台不内置缺省价。

## 交付内容

| 层 | 内容 |
|---|---|
| contracts | `env.ts`：`ANCS_AGENT_DRIVER` / `ANCS_VISUAL_ANALYSIS_DRIVER` / `ANCS_NARRATION_DRIVER` 增加 `gemini`，`GEMINI_API_KEY`、`ANCS_GEMINI_TTS_MODEL`、`ANCS_VEO_OFFER_JSON`（必须带 `durationOptions`）；选 gemini 缺密钥启动失败（逐项说明）。`paid-generation.ts`：报价依据 `durationOptions`（最长一档不超过 `maxSeconds`） |
| migration | 不适用 |
| domain | `billedSeconds` + `quoteGeneration` 按档位报价；`list_generation_options` 告诉 AI 供应商只做固定时长；`quote_generation` 结果带 `billedSeconds` |
| providers | 新包 `@ancs/providers-gemini`：HTTP 层（密钥头、超时、错误归一、RetryInfo / 按天配额识别、跳转不带密钥）、`GeminiAgentModel`、`createGeminiSpeech`、`createGeminiVeo` |
| worker | `gemini-media.ts`：`createGeminiNarrationSynthesizer`、`createVeoGenerationProvider`；`main.ts` 装配（导演 / 视觉 / 讲述 / Veo，装配清单 `video_generation=veo`） |
| API / SDK / UI | 不适用（行为与界面不变） |
| scripts | `eval-first-cut.mjs --model gemini [--voice gemini]`；`gemini-browser-check.mjs`（真实 Gemini 导演 + 视觉的共看片室验收）；`provider-smoke.mjs` 增加 Gemini（模型列表、导演一次工具调用、TTS 一句话；`--veo-generate` 才真的生成）；`studio-env.mjs` 的讲述引擎可替换 |

## 验收与结果

| 验收项 | 证据 |
|---|---|
| 请求形状、思考签名回放、工具结果与图像、错误分类、重试（含 RetryInfo 与按天配额）、TTS 格式、Veo 长任务与跳转不带密钥 | `packages/providers/gemini/src/index.test.ts`（6 项，本地替身） |
| Gemini 讲述经 FFmpeg 拼接、句界精确；Veo 按档位提交 → 下载 → 统一画布、保留声音；六种计费结局；超出报价档位或类型不对不提交 | `apps/worker/src/gemini-media.integration.test.ts`（3 项，本地替身 + 真实 FFmpeg） |
| 按档位报价 | `packages/domain/src/paid-generation.test.ts`（新增 1 项） |
| 配置校验 | `packages/contracts/src/env.test.ts`（新增 1 项） |
| **真实** 导演：全部工具 schema 被接受；工具调用往返（含思考签名、并行调用、隐式缓存命中）；工具返回的图像被看懂 | 一次性脚本实测（数据见下） |
| **真实** 初剪评测（素材 2 例 + 文章 3 例） | `node scripts/eval-first-cut.mjs --model gemini`（数据见下；报告在本地 `.artifacts/eval/first-cut/`，不入库） |
| **真实** 浏览器：上传 → Gemini 理解画面 → AI 剪第一版 → 指着一段说一句 → 采用 | `scripts/gemini-browser-check.mjs` 4/4，截图 `docs/verification/artifacts/gemini/`（已人工查看） |

### 实测数据（2026-10-14，免费层 Key，导演 `gemini-flash-lite-latest` → 实际服务 `gemini-3.5-flash-lite`）

| 项 | 结果 |
|---|---|
| 模型可用性 | 列出 63 个模型（含 TTS 与 Veo 3.1 系列）。`gemini-3.5-flash` 返回 503（高峰过载）；`gemini-3.8-flash` 首字 87 s；`gemini-3.1-pro-preview` 429（免费层无配额）；`gemini-2.5-flash` 已不对新用户开放。flash-lite 稳定，单次 0.7–1.5 s |
| 导演工具往返 | 17 个导演工具 + 系统提示一次被接受（输入 7,552 tokens，1.4 s）；第二轮带思考签名回放 0.7 s，命中隐式缓存 4,036 tokens；并行两个 `inspect_footage`；工具结果附带 JPEG 抽帧，模型正确描述了画面颜色 |
| 初剪评测 · 素材（合成测试画面） | 不选策略：22.4 s 一轮，看素材 → 看帧 → 剪 → 自检 → 看成片，18 s 成片，自动指标 0.83（"长度"0 分：这个用例的请求里没写 9 秒目标，属评测集问题）；选用"节奏卡点"：17.2 s，6 s 成片、1 秒一剪，自动指标 1。两例画面理解都是真实 Gemini 视觉（"已理解"） |
| 初剪评测 · 文章 | 第一轮 3 例都完成（65–118 s 一轮）：中文"城市的树"由 Gemini TTS 讲述（3 句，Kore），导出成片平均响度 −15.6 dB；**再用 Gemini 把成片音频转写回来，与讲述稿逐字一致**（只差标点）。两个英文用例讲述失败：免费层 TTS 配额（每模型每天 10 次）用完，导出无声。第二轮 3 例的讲述都因按天配额失败（已改为按天配额不重试、按分钟配额按 RetryInfo 等待） |
| 浏览器全流程 | 3 段素材画面理解 16 s；第一版 29 s（9 次工具调用），试改可播放；指着 00:01.8–00:06.3 说"这一段剪短一点"→ 23 s 新试改（复用 3/4 段）；采用：版本 4 → 5 |
| Provider 冒烟 | 模型列表 539 ms；导演一次工具调用 `trim_clip({"clipId":"clp_1","seconds":3})` 693 ms；TTS 因按天配额如实失败、未重试 |
| 成本 | Gemini 调用计为"未定价"（没有可核对的公开价）；用量照记 |

### 真实模型暴露的质量问题（flash-lite，如实记录）

- **指向范围没守住：** 选了 00:01.8–00:06.3 说"这一段剪短一点"，模型把三段都剪成了 2 秒（回复也照实说了"三段素材均缩短至 2 秒"）。
- **工具失败后回复没交代：** 讲述合成失败的两个英文用例里，回复只说"做好了解说视频"，没提配音没成功（成片无声）。
- **偶发写错工具名 / 参数：** 一次调用了不存在的工具、两次 `edit_timeline` 参数不合法，都被运行时拒绝并由模型自行改正。
- 这些都是同一套通用能力下的模型表现，导演与调度代码不为某家模型打补丁；换更强的模型（`ANCS_AGENT_MODEL`）后用同一套评测对比。

### 命令与结果（2026-10-14，本地 Postgres 16 + Redis）

```
pnpm secrets:check / spec:check / lint / typecheck / arch:check / capabilities:check → 全部通过
pnpm build            → 通过
pnpm test:unit        → 111 文件 / 813 项通过（含 Gemini 适配器 6 项、按档位报价 1 项、配置校验 1 项）
pnpm test:web / security / motion / render / golden → 243 / 24 / 38 / 8 / 15 项通过
pnpm test:integration → 132 文件 / 618 项一次通过（含 gemini-media 3 项；单独运行约 12 分钟）
GEMINI_API_KEY=… NODE_USE_ENV_PROXY=1 ANCS_AGENT_MODEL=gemini-flash-lite-latest \
  node scripts/eval-first-cut.mjs --set evals/first-cut/smoke.json --model gemini --export      → 2/2 完成
  node scripts/eval-first-cut.mjs --set evals/first-cut/explainer.json --model gemini --export  → 3/3 完成（讲述受免费层配额限制，见上）
  node scripts/gemini-browser-check.mjs                                                          → 4/4
  node scripts/provider-smoke.mjs                                                                → 模型列表、导演 OK；TTS 按天配额用完
```

## 未验证与待办

- **真实 Veo：** 按秒计费，等项目所有者确认后运行 `node scripts/provider-smoke.mjs --veo-generate`（4 秒），再在共看片室走"报价 → 确认 → 试改"；核对：Veo REST 参数形状（`durationSeconds` 等）、单次耗时、Google 账单与报价是否吻合、被安全过滤是否计费（当前按不扣费处理）。价格先按 Google 价格页填进 `ANCS_VEO_OFFER_JSON`。
- **TTS 配额：** 免费层每个 TTS 模型每天 10 次请求，逐句合成一篇文章就会用掉大半。TODO（why：生产讲述不能受免费层限制；dependency：付费层或按整段合成；interface：`GeminiSpeech.synthesizeScript(sentences)` 一次合成整段并用静音检测切分句界，`createHttpNarrationSynthesizer` 增加整段模式）。
- **Gemini 计价：** TODO（why：成本面与每轮预算上限目前对 Gemini 不起作用；dependency：可核对的价格来源；interface：`AGENT_MODEL_PRICES` 增加 Gemini 模型或部署方用 `ANCS_AGENT_MODEL_PRICES_JSON` 声明）。在此之前每轮仍受迭代次数上限约束。
- **更强的 Gemini 导演模型：** flash / pro 在实测时过载或免费层无配额；付费层下用同一套评测（`--model gemini`，`ANCS_AGENT_MODEL=gemini-flash-latest` 等）对比指向范围与失败交代两项。
- **语音转写：** Gemini 也能转写（上面的逐字核对就是用它做的），但没有词级时间戳；转写仍以 Deepgram 为准，未接 Gemini 转写端口。
- **密钥：** 项目所有者在聊天里贴过这把 Key；测试完建议在 Google AI Studio 作废重建，正式使用时放进云环境的密钥设置（`GEMINI_API_KEY`），不要再贴在聊天里。
