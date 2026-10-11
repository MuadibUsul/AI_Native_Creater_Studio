# ANCS AI 供应商注册与接入执行单

> 目标：让 Grok Bot 按本文件完成 ANCS 第一阶段所需 AI 供应商账号注册、API 开通、密钥创建、预算限制、环境变量配置与最小可用性测试。
>
> 项目：AI Native Creator Studio（ANCS）
>
> 原则：优先完成 **ASR + LLM**，其次完成视觉理解，TTS 暂缓。
>
> 安全底线：
> 1. API Key / Secret / Token **禁止发送到聊天窗口、截图、Issue、日志或 Git 仓库**。
> 2. 密钥只允许写入本机/服务器的安全环境变量或 `.env`；确认 `.env` 已加入 `.gitignore`。
> 3. 遇到 CAPTCHA、短信/邮箱验证码、支付卡、实名/KYC、2FA、服务条款确认等需要账户持有人决定的步骤，**立即停下并请求人工完成**，不得规避或代替确认。
> 4. 不开启无限额自动充值。除非账户必须充值才能使用，否则先用免费额度/最小充值。
> 5. 每家供应商创建独立项目/工作区和独立 API Key，名称统一使用 `ANCS-dev`。
> 6. 先跑开发环境，不创建生产密钥。
> 7. 注册完成后不要把完整密钥回传，只回传“已创建 / 未创建”、Key 前后各 3–4 位掩码、项目名、区域、预算和测试结果。

---

# 一、最终推荐组合

## 第一优先级：立即注册并开通

| 优先级 | 能力 | 供应商 | ANCS 用途 | 推荐配置 |
|---|---|---|---|---|
| P0 | 实时 ASR | Deepgram | 边说边出字、逐词时间戳、低延迟语音交互 | Nova-3 Multilingual + Flux Multilingual |
| P0 | 快速 LLM | OpenAI API | 意图分类、JSON 结构化操作、轻量编辑指令 | 便宜快速模型优先，保留更强模型作为升级 |
| P0 | 复杂 Planner | Anthropic Claude API | 多约束剪辑规划、复杂编辑意图、长上下文推理 | Claude Sonnet 系列优先 |

## 第二优先级：第一阶段跑通后注册

| 优先级 | 能力 | 供应商 | ANCS 用途 | 推荐配置 |
|---|---|---|---|---|
| P1 | 视觉理解 | Google Gemini API | 抽帧、场景理解、人物/物体/镜头定位 | Gemini Flash / 多模态模型 |
| P2 | TTS | ElevenLabs | 后续旁白/声音生成 | 暂不阻塞 G0 |

## 本地能力，不需要注册

- FFmpeg：抽音轨、静音检测、音量、切段、转码、时间戳处理。
- VAD：优先本地方案（Silero VAD 或 WebRTC VAD）。
- 原则：能本地完成的基础音频分析不要上云。

---

# 二、执行顺序

严格按以下顺序执行：

1. Deepgram
2. OpenAI API
3. Anthropic Claude API
4. Google Gemini API
5. ElevenLabs（可选，前四项完成后再做）
6. 配置 ANCS `.env`
7. 分别运行最小 API 测试
8. 输出注册验收报告

如果某一家被地区、支付、KYC、账户资格等卡住，不要阻塞整个流程：
- 标记为 `BLOCKED`
- 写明具体卡点
- 继续下一家

---

# 三、Deepgram —— P0 / ASR 主用

## 官方入口

- 官网：https://deepgram.com/
- 文档：https://developers.deepgram.com/
- Flux Quickstart：https://developers.deepgram.com/docs/flux/quickstart
- API Key 文档：https://developers.deepgram.com/docs/create-additional-api-keys

## 注册目标

创建：
- Account
- Project：`ANCS-dev`
- Development API Key

## 必须确认的模型

### 1. Nova-3
用途：
- 普通实时语音转写
- 中文/多语言测试
- 逐词时间戳
- 流式 partial transcript

首测模型：
- `nova-3`

### 2. Flux Multilingual
用途：
- 超低延迟语音交互
- turn detection
- interruption / barge-in
- 边说边响应

首测模型：
- `flux-general-multi`

Flux WebSocket：
`wss://api.deepgram.com/v2/listen?model=flux-general-multi`

## 环境变量

```env
DEEPGRAM_API_KEY=YOUR_SECRET
ANCS_ASR_PROVIDER=deepgram
ANCS_ASR_MODEL=nova-3
ANCS_ASR_REALTIME_MODEL=flux-general-multi
```

## 预算

开发阶段建议：
- 月预算软上限：`$20`
- 如果控制台支持硬限额/告警：设置 `$20`
- 不开启高额自动充值

## 验收测试

必须测试：

1. API Key 是否有效。
2. Nova-3 是否能识别一段中文音频。
3. 是否返回逐词时间戳。
4. WebSocket 流式转写是否正常。
5. Flux 是否能实时返回 turn 相关事件。
6. 测一次中文短句延迟。
7. 记录：
   - 首个 partial transcript 延迟
   - final transcript 延迟
   - 逐词时间戳是否存在
   - 中文准确性主观评价

## 通过标准

状态标记：
- `PASS`：Nova-3 + Flux 都能真实调用。
- `PARTIAL`：Nova-3 可用但 Flux 不可用。
- `BLOCKED`：账号/API/地区/支付问题导致无法真实调用。

---

# 四、OpenAI API —— P0 / 快速结构化 LLM

## 官方入口

- API 平台：https://platform.openai.com/
- API 定价：https://platform.openai.com/pricing/
- Structured Outputs：
  https://developers.openai.com/api/docs/guides/structured-outputs

## 注册目标

创建：
- API Platform Account
- Project：`ANCS-dev`
- Development API Key

不要使用普通 ChatGPT 登录状态来替代 API Key 验证。

## ANCS 用途

优先承担：
- 用户编辑意图分类
- accept / reject / revise 分类
- “删这里 / 从这里开始 / 保留原音”等自然语言转操作
- 鼠标定位信息 + 语音信息联合解析
- 强约束 JSON 输出
- 低延迟高频请求

## 模型策略

不要把最强模型用于所有请求。

至少保留两个逻辑档位：

### Fast
用于：
- 分类
- 参数提取
- JSON
- 简单 edit plan

### Strong
用于：
- 模糊意图
- 多约束计划
- Fast 模型置信度不足时升级

具体模型名以注册当天控制台实际可用型号为准，不在自动注册脚本中硬编码一个可能已经变更的型号。

## 强制要求

必须验证 Structured Outputs / JSON Schema。

测试 Schema 示例：

```json
{
  "type": "object",
  "properties": {
    "intent": {
      "type": "string",
      "enum": ["cut", "trim", "keep", "reject", "revise", "unknown"]
    },
    "confidence": {
      "type": "number"
    }
  },
  "required": ["intent", "confidence"],
  "additionalProperties": false
}
```

## 环境变量

```env
OPENAI_API_KEY=YOUR_SECRET
ANCS_FAST_LLM_PROVIDER=openai
ANCS_FAST_LLM_MODEL=MODEL_SELECTED_AFTER_CONSOLE_CHECK
```

## 预算

开发阶段建议：
- 月预算软上限：`$30`
- 有硬限额则设置 `$30`
- 开启低余额提醒
- 不开启无限额自动充值

## 验收测试

1. API Key 有效。
2. 文本请求成功。
3. Structured Outputs 能严格匹配 Schema。
4. 连续 20 次同一分类任务无非法 JSON。
5. 记录：
   - P50 响应时间
   - P95 响应时间
   - 输入 tokens
   - 输出 tokens
   - 单次估算成本

---

# 五、Anthropic Claude API —— P0 / 复杂 Planner

## 官方入口

- Claude API：https://www.anthropic.com/claude/api
- Claude Platform / Console：https://platform.claude.com/
- Pricing 文档：https://platform.claude.com/docs/en/about-claude/pricing

## 注册目标

创建：
- Anthropic / Claude Platform Account
- Workspace / Project：`ANCS-dev`
- Development API Key
- 最低必要的 prepaid credit（仅在 API 调用必须充值时）

## ANCS 用途

Claude 不作为每一句语音指令的默认模型。

主要承担：
- 复杂剪辑意图规划
- 多约束编辑
- 长上下文视频项目理解
- Fast LLM 低置信度升级
- 跨多个片段的编辑计划
- 保留语义条件下的大规模剪辑

示例：

“把这段 15 分钟访谈剪成 90 秒，保留原话含义，前 20 秒建立冲突，中间保留产品案例，把最后一句放结尾。”

## 模型策略

默认优先测试：
- Claude Sonnet 系列

不要默认使用 Opus 处理高频简单操作。

具体型号以当天平台可用模型为准。

## 环境变量

```env
ANTHROPIC_API_KEY=YOUR_SECRET
ANCS_PLANNER_PROVIDER=anthropic
ANCS_PLANNER_MODEL=MODEL_SELECTED_AFTER_CONSOLE_CHECK
```

## 预算

开发阶段建议：
- 初始 prepaid credit：尽量 `$10–20`
- 月预算软上限：`$30`
- 如果开启 auto-reload：
  - 默认不要开启
  - 必须开启时，需要用户人工批准具体金额

## 验收测试

1. API Key 有效。
2. 简单 Messages API 请求成功。
3. 复杂剪辑需求可稳定返回结构化 Edit Plan。
4. 测试至少 5 个复杂编辑场景。
5. 记录：
   - 延迟
   - 输入/输出 token
   - 成本
   - 是否出现格式漂移
   - 是否需要二次修复 JSON

---

# 六、Google Gemini API —— P1 / 视觉理解

## 官方入口

- Google AI Studio：https://aistudio.google.com/
- Gemini API 文档：https://ai.google.dev/gemini-api/docs/
- API Key 文档：https://ai.google.dev/gemini-api/docs/api-key
- Pricing：https://ai.google.dev/gemini-api/docs/pricing

## 注册目标

创建：
- Google AI Studio / Cloud Project：`ANCS-dev`
- Gemini API auth key / API credential

注意：
Google 的 API key / auth key 规则会变化，以 AI Studio 当前要求为准。
不要创建 unrestricted key。

## ANCS 用途

- 视频抽帧理解
- 人物出现时间
- 商品/物体出现
- 镜头变化
- 场景分类
- OCR / 屏幕文字理解
- 根据用户鼠标点位理解“这个人 / 这个区域 / 这个画面”

长期目标生成 Scene Index，例如：

```text
00:12 人物 A 进入
00:16 镜头切换
00:21 产品出现
00:28 屏幕字幕出现
```

不要在每次语音命令时重新上传完整视频。

## 环境变量

```env
GEMINI_API_KEY=YOUR_SECRET
ANCS_VISION_PROVIDER=gemini
ANCS_VISION_MODEL=MODEL_SELECTED_AFTER_CONSOLE_CHECK
```

## 预算

开发阶段建议：
- 优先使用可用免费额度进行测试
- 进入付费后月预算软上限：`$20`

## 验收测试

准备 5 张项目视频抽帧：

1. 人物画面
2. 产品/物体画面
3. 字幕画面
4. 多人画面
5. 场景切换附近画面

验证：
- 人物/物体描述是否正确
- OCR 是否正确
- JSON 是否稳定
- 单帧延迟
- 单帧成本

---

# 七、ElevenLabs —— P2 / 可选 TTS

## 官方入口

- 官网：https://elevenlabs.io/
- API Pricing：https://elevenlabs.io/pricing/api

## 状态

默认：`OPTIONAL`

只有 Deepgram + OpenAI + Claude + Gemini 完成后才继续。

## 用途

后续：
- AI 新旁白
- TTS
- 声音生成/配音

不要现在投入时间做声音克隆、音色市场等非 G0 功能。

## 环境变量

```env
ELEVENLABS_API_KEY=YOUR_SECRET
ANCS_TTS_PROVIDER=elevenlabs
```

## 预算

第一阶段：
- 免费层或最小付费档
- 不超过 `$15/月`

---

# 八、ANCS 统一环境变量

所有 Key 都必须在后端环境使用。

建议 `.env`：

```env
# ===== Deepgram =====
DEEPGRAM_API_KEY=
ANCS_ASR_PROVIDER=deepgram
ANCS_ASR_MODEL=nova-3
ANCS_ASR_REALTIME_MODEL=flux-general-multi

# ===== OpenAI =====
OPENAI_API_KEY=
ANCS_FAST_LLM_PROVIDER=openai
ANCS_FAST_LLM_MODEL=

# ===== Anthropic =====
ANTHROPIC_API_KEY=
ANCS_PLANNER_PROVIDER=anthropic
ANCS_PLANNER_MODEL=

# ===== Gemini =====
GEMINI_API_KEY=
ANCS_VISION_PROVIDER=gemini
ANCS_VISION_MODEL=

# ===== Optional TTS =====
ELEVENLABS_API_KEY=
ANCS_TTS_PROVIDER=elevenlabs

# ===== Existing ANCS provider key aggregation =====
ANCS_PLATFORM_PROVIDER_KEYS=
ANCS_CREDENTIAL_KEYS=
```

如果项目当前已经定义了不同环境变量名称：
- 优先兼容现有代码
- 不要为了本文件强行重命名
- 输出映射关系

---

# 九、密钥安全

Grok Bot 必须执行：

1. 检查仓库 `.gitignore` 是否包含：
   - `.env`
   - `.env.local`
   - `.env.*.local`
2. 扫描 git tracked files，确认没有 API Key。
3. 不把 API Key 写入：
   - README
   - Markdown 文档
   - source code
   - browser localStorage
   - frontend bundle
   - test snapshots
   - console logs
4. 如必须在浏览器侧短期访问供应商：
   - 后端签发短期 token
   - 不下发长期主密钥
5. 开发和生产使用不同 Key。
6. 给 Key 能设置的最小权限。
7. 记录 Key 创建日期与用途。

---

# 十、需要人工介入时的标准行为

遇到以下情况立即暂停当前网站：

- CAPTCHA
- 手机验证码
- 邮箱验证码，需要用户查看邮箱
- 2FA
- 实名/KYC
- 支付卡信息
- 服务条款中出现需要用户明确同意的重要收费/数据条款
- 自动充值
- 高于本文件预算的充值
- 企业合同
- 需要上传身份证件

向用户只输出：

```text
[需要人工操作]
供应商：
当前页面：
需要操作：
完成后告诉我“继续”。
```

完成后继续原流程。

---

# 十一、不要做的事情

- 不通过验证码代打/绕过服务绕 CAPTCHA。
- 不购买来路不明 API Key。
- 不使用共享账号。
- 不使用第三方“中转 API”代替本轮官方真实验证。
- 不开启无上限计费。
- 不创建生产环境资源。
- 不擅自提交企业合同。
- 不上传真实客户的私密视频做人脸/声音测试。
- 不用真实客户数据做首轮验证。
- 不把密钥发回对话。

---

# 十二、真实验证素材

先用非敏感测试素材。

ASR 至少包含：

1. 普通话清晰语音
2. 普通话口语快速表达
3. 带轻背景音乐
4. 两人说话
5. 有停顿/打断
6. 编辑命令：
   - “把这里删掉”
   - “从这个镜头开始”
   - “前面的废话删掉，但原音保留”
   - “刚才那个不要”
   - “这个人出现以后往后剪三秒”

LLM 至少包含：

1. cut
2. trim
3. keep
4. reject
5. revise
6. ambiguous intent
7. point/line/area selection context
8. timeline time range context

视觉至少包含：

1. 单人
2. 多人
3. 产品
4. 屏幕字幕
5. 场景转换

---

# 十三、统一性能目标

第一轮真实验证记录：

## Voice Path

用户结束一句话 → UI 出现可用结果

目标：
- P50 < 0.8 秒
- P95 < 2 秒

用户中途打断：
- 目标 < 0.3 秒响应

## Preview

AI edit plan → 试剪预览第一帧：
- 目标 < 3 秒

注意：
这是目标，不允许为了“通过”而伪造测试值。
真实数据不达标就记录真实值。

---

# 十四、注册完成后的最终报告模板

完成后创建：

`ANCS-PROVIDER-REGISTRATION-RESULT.md`

内容严格按：

```markdown
# ANCS Provider Registration Result

日期：

## 1. Deepgram
Status: PASS / PARTIAL / BLOCKED
Project:
API Key: 已创建 / 未创建
Key Mask: xxx...xxx
Billing:
Budget:
Models:
Region:
Nova-3 test:
Flux test:
Word timestamp:
Streaming:
Latency:
Blocker:

## 2. OpenAI
Status:
Project:
API Key:
Key Mask:
Billing:
Budget:
Fast model selected:
Strong/fallback model selected:
Structured Outputs:
20-run JSON test:
P50:
P95:
Blocker:

## 3. Anthropic
Status:
Workspace/Project:
API Key:
Key Mask:
Credits:
Budget:
Planner model:
Complex edit-plan test:
Latency:
Blocker:

## 4. Gemini
Status:
Project:
Credential:
Key Mask:
Billing:
Budget:
Vision model:
Image test:
OCR test:
JSON test:
Latency:
Blocker:

## 5. ElevenLabs
Status: PASS / OPTIONAL / SKIPPED / BLOCKED
Plan:
API Key:
Key Mask:
Budget:
Blocker:

## Security Check
.env ignored:
No key committed:
No key in frontend:
No key in logs:
Dev/prod separated:

## ANCS .env
Configured: YES / NO
Missing variables:

## Final Result
P0 usable:
P1 usable:
Blocking issue:
Next recommended action:
```

---

# 十五、完成标准

本任务不是“账号注册成功”就结束。

P0 完成必须同时满足：

### Deepgram
- 真实 API 调用成功
- Nova-3 转写成功
- 流式能力真实测试
- 逐词时间戳真实验证

### OpenAI
- 真实 API 调用成功
- JSON Schema / Structured Outputs 真实验证

### Anthropic
- 真实 API 调用成功
- 至少一个复杂 Edit Plan 真实生成成功

### ANCS
- Key 已安全配置到后端
- `.env` 未被 Git 跟踪
- 不存在前端泄露
- 每家有预算控制/告警或明确记录
- 生成最终验收报告

只有满足这些条件，才允许标记：

`ANCS_PROVIDER_ONBOARDING_P0 = PASS`

否则保持：

`PARTIAL` 或 `BLOCKED`

---

# 十六、给 Grok Bot 的最终执行指令

你现在负责为 AI Native Creator Studio 完成上述 AI Provider Onboarding。

执行原则：

1. 直接开始执行，不要重复解释任务。
2. 严格按照优先级 Deepgram → OpenAI → Anthropic → Gemini → ElevenLabs。
3. 能自动完成的页面操作直接完成。
4. CAPTCHA、验证码、2FA、付款、实名和重要条款确认必须交给账户持有人。
5. 不得把任何秘密密钥发送到聊天。
6. 所有密钥只写到 ANCS 本地/服务器安全环境变量。
7. 不得使用第三方中转 API 替代官方 API。
8. 每注册一家立即做真实 API smoke test，不要等全部注册后再测试。
9. 遇到一家受阻，记录并继续下一家。
10. 所有测试必须使用非敏感测试数据。
11. 最后输出 `ANCS-PROVIDER-REGISTRATION-RESULT.md`。
12. 不得将“账号存在”“页面打开”“Mock 成功”算作真实验证通过。
13. 只有真实调用、真实响应、真实延迟和真实成本数据才算 PASS。
