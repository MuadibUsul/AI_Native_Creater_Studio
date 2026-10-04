# Creator Video OS
## AI Native 视频制作平台 — 产品需求与工程实现总规范 v0.2

**状态**：Engineering Baseline / 可直接交给 Codex 推进实现  
**日期**：2026-10-04  
**首发形态**：Web 端  
**后续形态**：Windows/macOS 桌面端、iOS/Android 手机端  
**核心原则**：Web 先行，但后端、领域模型、API、任务系统、存储、权限、版本历史、Provider 抽象从第一天按多端共享设计。  
**目标用户首批范围**：财经 / 商业 / 科技 / 教育等知识型创作者、Newsletter 作者、研究员、媒体/内容团队。  

**v0.2 关键增量**：Creator Voice / 声音复制与 Speech Director、平台发布能力分级、Core + Packs + Marketplace 扩展架构、Content Core / Content Atom / Channel Recipe 预留、订阅费与 AI Compute Credits 分离、V1 范围重新收敛为 Article → Long Video。  

**V1 范围硬约束**：第一版只验证并做到极致的主链路是 `Article / Research → Professional Long Video`。Shorts、图文、社交短文、Newsletter、多平台内容适配与多平台发布均不得阻塞 V1；这些能力按 Pack / Plugin 扩展实现。  

---

# 0. 文档约定

本文档是产品与工程的统一“Source of Truth”。Codex 在实现时必须以此文档为基线，不得为了快速做 Demo 而破坏核心架构约束。

关键词含义：

- **MUST**：必须实现或必须遵守，否则视为架构偏离。
- **SHOULD**：强烈建议实现；若暂缓，必须保留接口或迁移路径。
- **MAY**：可后续实现，不阻塞当前阶段。
- **MVP**：第一阶段可实际内部使用的 Web 版本，不等于一次性 Demo。
- **Scene**：视频的语义镜头/场景，是本系统的核心编辑单元。
- **Scene Graph**：项目的结构化视频描述，是整个系统的 Source of Truth。
- **Asset**：图片、音频、视频、字幕、文档、图表输出、渲染文件等二进制或可寻址资源。
- **Provider**：外部或内部能力供应方，例如 HeyGen、Veo、Runway、ElevenLabs、LLM、对象存储、发布平台。
- **Director**：AI 导演系统，负责决定“内容应该如何视觉化”，不是单纯生成 Prompt。
- **Visual Grammar**：从内容语义到视觉表达类型的规则系统。
- **Creator Identity**：创作者长期身份资产，包括 Avatar Identity、Voice Identity、Brand Identity、Presenter/Speech Style。
- **Content Core**：从原始研究/文章中抽取出的平台无关内容核心，是未来多内容形态派生的 Source of Truth；V1 只需保留兼容结构。
- **Content Atom**：可独立表达的内容单元，例如一个结论、一个数据关系、一个因果链、一个可拆分短视频主题。
- **Pack / Plugin**：挂载在 Core Extension Points 上的可选能力，如 Shorts、XHS、Publishing、Analytics、Finance Components。

---

# 1. 产品定义

## 1.1 一句话定义

Creator Video OS 是一套 **AI Native 的视频制作操作系统**：创作者把文章、研究、脚本或资料交给系统，系统自动完成视频叙事重构、导演、分镜、数字人、数据可视化、动态图形、AI 视频镜头、字幕、配音、合成、版本管理、导出和后续分发。

它不是“再做一个 HeyGen”，也不是“网页版本 Premiere”。

产品核心价值：

> 把原本需要编剧、导演、主持人、剪辑、动效设计、数据编辑和分发人员协作完成的视频生产流程，软件化为 Creator + AI Production OS。

V1 不追求“全内容形态、全平台生产”。V1 的成功标准只有一个：

> 用户交给系统一篇高质量文章/研究后，系统可以稳定生成一条用户愿意直接发布的专业长视频。

长期能力可以从同一 Content Core 派生 Shorts、图文、短文、长文与各平台版本，但必须通过 Pack / Plugin 向外扩张，而不是把所有工具塞进主产品。

## 1.2 编译器模型

整个系统应按“编译器”理解：

```text
文章 / Research / Newsletter / Script
                ↓
        Content Normalization
                ↓
        Narrative Intermediate
                ↓
          Director Planning
                ↓
             Scene Graph
                ↓
   Provider / Remotion / Assets
                ↓
            Timeline Build
                ↓
              Render
                ↓
     Long Video / Shorts / Export
```

类比：

- 原始文章 = Source Code
- Narrative Plan = 高级中间表示
- Scene Graph = 视频中间语言 IR
- Provider = 不同执行后端
- Remotion = 可编程渲染引擎
- MP4 = 编译产物

## 1.3 产品定位边界

### 我们要做

- AI 自动完成大部分视频制作决策。
- 创作者通过自然语言修改视频。
- 用户可以手工做必要的精确修正。
- 结构化保存项目、Scene、版本、素材、编辑记录。
- 对外部模型做 Provider 抽象，可替换、可路由。
- 支持平台托管 API 和 BYOK。
- 支持高质量代码化视觉表达，而不是堆积通用 B-roll。
- 长期支持 Web、桌面、手机使用同一后端。

### 我们明确不做

至少在前几个版本中不要重造完整 Premiere / DaVinci / After Effects：

- 不做完整专业 Color Grading。
- 不做完整 Multi-Cam 系统。
- 不做完整 Audio DAW。
- 不做完整贝塞尔关键帧编辑器。
- 不做高级 Rotoscope / Mask / Tracking 工具链。
- 不做复杂 VFX 合成软件。
- 不让 Timeline 成为核心 Source of Truth。

原则：

> AI 负责创造，GUI 负责修正。

---

# 2. 不可违背的产品与架构原则

## 2.1 AI Native，而不是 AI 辅助传统剪辑器

传统 NLE 的核心对象：

```text
Track → Clip → Frame → Keyframe
```

本产品核心对象：

```text
Idea → Narrative → Scene → Visual Intent → Asset
```

用户默认不应该从空 Timeline 开始拖素材，而应该从内容、意图或文章开始。

## 2.2 Scene Graph 是 Source of Truth

MUST：项目最终状态由 Scene Graph + Project Metadata + Asset References 决定。

Timeline 只是 Scene Graph 的一种可视化编辑方式。

用户在 Timeline 修改 Scene 时，必须回写 Scene Graph，而不是生成另一套无法同步的数据结构。

## 2.3 AI First，Direct Manipulation Second

适合 AI 的操作：

- 改脚本
- 重构叙事
- 生成分镜
- 选择画面类型
- 做动态图表
- 生成地图
- 找素材
- 生成 B-roll
- 生成字幕
- 生成封面
- Shorts 切片
- 调整整体节奏

适合鼠标/触控的操作：

- Trim
- Move
- Reorder
- Delete
- Duplicate
- Resize
- Crop
- Volume
- 简单 Transition
- 字幕断句
- 简单时间调整

## 2.4 确定性视觉优先于生成式视觉

Director 的优先级 MUST 默认为：

```text
真实数据可表达
→ 数据可视化

结构关系可表达
→ Motion Graphic / Diagram

真实图片/文件可表达
→ Source / Image / Screenshot

地理关系可表达
→ Map

以上均不适合
→ AI Generated Video
```

禁止把“华尔街交易员、美元飞舞、摩天大楼延时”之类通用 AI B-roll 作为默认视觉方案。

## 2.5 Provider 不得绑死产品

HeyGen、Veo、Runway、ElevenLabs、任何 LLM 都只能作为 Provider。

MUST：业务层不得直接依赖特定模型名称或接口字段。

所有外部能力必须通过内部 Provider Contract 访问。

## 2.6 异步优先

视频生成是分钟级长任务。MUST：所有正式生成流程采用异步 Job / Workflow。

禁止：一个 HTTP 请求从“生成视频”一直等待到最终 MP4 完成。

## 2.7 Web 首发，多端后端

Web 是第一个客户端，不是系统本身。

MUST：

- 核心业务逻辑不能放在 React Component。
- 核心业务逻辑不能仅通过 Next.js Server Actions 暴露。
- 必须提供独立、版本化、可被原生 App 调用的 Backend API。
- Web/桌面/手机必须复用同一数据模型、权限、任务系统、Project ID、Scene ID、Asset ID。
- 多端共享一套 TypeScript/JSON Schema/OpenAPI contracts。

## 2.8 用户数据最小化发送给第三方

MUST：视频 Provider 只接收完成该 Scene 所需的最少数据。

例如 Veo 不应该默认收到整篇未发布文章，而只收到某个 Scene 的画面 Prompt 与必要参考素材。

---

# 3. 初始目标用户与核心使用场景

## 3.1 首批用户

第一阶段不要服务“所有视频创作者”。优先：

- 财经长视频创作者
- 商业分析创作者
- 科技内容创作者
- Newsletter 作者
- 独立研究员
- 投资研究团队
- 财经媒体
- Podcast / 访谈作者希望转视频的人群
- 教育知识类创作者

共同特征：研究和内容能力强，但视频制作成本高。

## 3.2 核心用户故事

### 用户故事 A：文章变长视频

用户发布或输入一篇 2,000～5,000 字文章：

1. 系统读取文章与 Sources。
2. 自动判断推荐视频长度。
3. 重写成口语化视频脚本。
4. 自动设计章节。
5. 自动生成 Scene Graph。
6. 用户预览 Draft。
7. 用户自然语言要求修改。
8. Final Render。
9. 输出 16:9 长视频。

### 用户故事 B：长视频自动切 Shorts（Post-MVP / Shorts Pack）

长视频确认后：

- 自动找 3～10 个高信息密度片段。
- 重构为独立 Hook。
- 生成 9:16 Scene Graph 派生版本。
- 重新排字幕、图表、数字人位置。
- 输出 Shorts/Reels/TikTok 版本。

### 用户故事 C：栏目化生产

用户保存 Creator Profile：

- 主持人 Digital Twin
- Voice
- Logo
- 字体
- 色彩
- 图表语言
- 字幕样式
- Avatar 占比
- 平均视频长度
- Hook 风格
- 结尾模板
- AI B-roll 使用强度

后续文章自动继承风格。

### 用户故事 D：AI 修改视频

用户直接说：

> “开头太慢，前 30 秒压缩一点。”

系统不是只改变播放速度，而是：

- 分析前 30 秒 Scene。
- 缩短数字人。
- 增加数据/图表变化。
- 重写必要旁白。
- 给出变更计划。
- 用户 Apply 后形成新版本。

### 用户故事 E：精确手动修正

用户可以：

- 拖动 Scene 顺序
- Trim
- Split
- Replace
- 调音量
- 调字幕
- 修改图表字段
- 更换 Transition

无需向 AI 描述所有微小操作。

---

# 4. 产品输出范围

## 4.1 输入

MVP MUST：

- 输入文章 URL
- 粘贴文章正文
- 手工输入脚本
- 上传图片
- 上传视频
- 上传音频
- 输入/编辑 Sources

SHOULD：

- PDF / Markdown / DOCX 导入
- RSS / CMS Webhook
- 网站 Publish Webhook
- Newsletter 导入

未来 MAY：

- Notion
- Google Docs
- Substack
- WordPress
- Ghost
- 自定义 CMS

## 4.2 输出

MVP MUST：

- 16:9 1080p MP4
- Draft Preview
- 字幕文件（SRT/VTT）
- Project Manifest

SHOULD（不阻塞 V1 Article → Long Video）：

- 4K
- Thumbnail
- Title Suggestions
- Description
- Chapters
- Source List

Post-MVP Packs / Plugins：

- Shorts Pack：9:16 / Shorts / Reels / TikTok 派生内容
- Social Visual Pack：1:1、4:5、Carousel、信息图
- Publishing Pack：平台授权、发布、Draft Transfer、Smart Export
- Newsletter / Text Pack：长文、短文、Thread、平台化文案
- 多语言版本
- Podcast Audio
- Platform-specific exports

---

# 5. Web 产品页面与信息架构

第一版 Web 建议路径：

```text
/login
/onboarding
/dashboard
/projects
/projects/:projectId
/projects/:projectId/script
/projects/:projectId/storyboard
/projects/:projectId/editor
/projects/:projectId/assets
/projects/:projectId/history
/projects/:projectId/render
/settings/creator
/settings/providers
/settings/storage
/settings/team
/settings/billing
```

## 5.1 Dashboard

显示：

- 最近项目
- 当前正在生成任务
- Draft / Ready / Rendering / Failed 状态
- Storage 使用量
- Video Credits / Provider Usage
- 最近错误或需人工处理任务

## 5.2 Project Workspace

主界面不要默认展示复杂 Timeline。

建议默认：

```text
┌──────────────────────────────────────────────┐
│ Project title                    Render Final │
├──────────────────────────────────────────────┤
│                                              │
│              VIDEO PREVIEW                   │
│                                              │
├──────────────────────────────────────────────┤
│ Ask Director                                 │
│ [开头节奏更快，并突出失业率变化________]     │
│                                    [Apply]   │
├──────────────────────────────────────────────┤
│ Scenes                                       │
│ 01 Host  02 BigNumber 03 Chart 04 Map ...    │
└──────────────────────────────────────────────┘
```

## 5.3 Script 页面

功能：

- 原文章和视频脚本并排对比
- 章节拆分
- 旁白编辑
- 每段估计时长
- 引用 Source 绑定
- AI 重写单段
- AI 重写章节
- Lock 段落，防止 Director 后续修改

## 5.4 Storyboard 页面

Scene 卡片列表：

- 顺序
- Scene 类型
- 缩略图
- 旁白摘要
- 时长
- 数据/Source
- Provider
- 生成状态
- 成本估计
- 锁定状态

支持：

- Drag reorder
- Multi-select
- Regenerate
- Change scene type
- Lock
- Duplicate
- Delete

## 5.5 Scene Editor

点击 Scene 展开右侧属性：

- Scene Type
- Duration
- Narration
- Visual Intent
- Data Binding
- Source Binding
- Component
- Animation preset
- Layout
- Background
- Transition
- Avatar configuration
- Asset references
- Provider strategy
- AI edit box

## 5.6 Lite Timeline

MUST 有，但不是默认首页。

最小轨道：

```text
Narration
Scenes
Music
Captions
Overlays
```

支持：

- Scene reorder
- Trim
- Split
- Duplicate
- Delete
- Move
- Replace
- Transition
- Music volume
- Voice volume
- Subtitle timing correction
- 简单 Crop/Scale

不要在 MVP 做复杂 Track nesting 或高级关键帧曲线。

## 5.7 History

显示人类可理解的 Intent History：

```text
23:42  Carl
“这段太复杂，简化。”
AI：4 层因果图 → 2 层结构

23:36  AI Director
重新生成 Scene 22

23:20  Carl
重新编排 Storyboard
```

支持：

- Undo
- Redo
- Restore project version
- Restore single Scene
- Compare versions（后续）

---

# 6. Creator Profile / Channel Profile

每个 Workspace 可以有多个 Channel。Channel 是“栏目/频道级长期默认值”，Project 可以覆盖，但不得静默覆盖历史项目。

Channel 保存长期风格：

```text
channel_name
language
default_aspect_ratio
default_duration_range
host_ratio_target
creator_identity_id
voice_profile
avatar_profile
brand_kit
font_pack
subtitle_style
chart_style
map_style
motion_style
music_policy
hook_style
chapter_style
ending_style
source_display_policy
ai_broll_policy
preferred_provider_policy
```

必须支持：

- 用户修改 Profile 后，新项目默认使用新值。
- 已有项目不会被静默覆盖。
- Project 可覆盖 Channel 默认值。
- Creator Identity 与 Channel Style 必须可分别版本化；同一个创作者可以运营多个不同视觉栏目的 Channel。

## 6.1 Creator Identity

Creator Identity 是长期身份资产，至少拆成：

```text
CreatorIdentity
├── AvatarIdentity
├── VoiceIdentity
├── BrandIdentity
└── PresenterStyle
```

### AvatarIdentity

保存：

- provider
- provider_avatar_id
- provider_account_scope / credential reference
- display_name
- status
- consent / ownership metadata
- default look / motion profile（Provider 支持时）
- created_at / updated_at / retired_at

原则：尽量由 Avatar Provider 托管原始训练素材；平台优先保存 provider_avatar_id 与必要元数据，不默认长期保存 Digital Twin 原始训练视频。

### VoiceIdentity

保存：

```text
id
workspace_id
creator_identity_id
provider
provider_voice_id
clone_type                 // INSTANT | PROFESSIONAL | PROVIDER_NATIVE | PUBLIC
ownership_type             // SELF_VERIFIED | SHARED_LICENSED | PLATFORM_PUBLIC
verification_status
managed_mode               // PLATFORM_MANAGED | BYOK
language_profile
pronunciation_dictionary_id?
default_speech_profile_id
status
created_at
updated_at
retired_at?
```

MUST：

- VoiceIdentity 不与 ElevenLabs 或 HeyGen 数据模型绑死。
- 历史 Project / Final Version 必须记录使用的 VoiceIdentity version / provider voice reference，避免用户后来换声音导致旧项目重渲染结果变化。
- Voice 删除/退休后，旧项目仍保留可审计引用；是否允许重新渲染取决于 Provider 资产是否仍存在。
- UI 必须清楚区分“平台托管声音”和“连接自己的 Provider 声音”。

## 6.2 Voice Clone Onboarding

V1 SHOULD 支持用户创建自己的 Creator Voice；如果开发节奏受限，至少必须完成 VoiceProvider 抽象、数据模型与 BYOK 连接能力。

推荐流程：

```text
Create My Voice
→ 明示仅允许本人/合法授权声音
→ 麦克风权限与设备检查
→ 录制指定文本 / 上传合法样本
→ 音质检测（噪声、削波、时长、有效语音比例）
→ Ownership / Consent 确认
→ Provider verification（若 Provider 要求）
→ Create Voice Clone
→ provider_voice_id
→ 绑定 Creator Identity
→ 试听
→ 设置默认 Speech Profile
```

两档能力：

- **Instant Voice Clone**：低门槛 onboarding，用于快速开始和试用。
- **Professional Voice Clone**：用于长期频道身份、高一致性、高质量生成；需要更多录音/验证时，UI 必须引导用户完成 Provider 要求。

不得把“上传任意名人的 MP3 → 克隆”作为产品能力。

## 6.3 Managed Voice 与 BYOK Voice

必须同时支持：

```text
Managed Voice
用户 → 我们的产品 → VoiceProvider API → provider_voice_id

BYOK Voice
用户连接自己的 Provider → 选择其合法 Voice → 我们只保存 provider_voice_id + encrypted credential ref
```

对于高价值 Professional Voice Clone，BYOK 是重要隐私与资产归属路径。

## 6.4 Speech / Presenter Profile

Creator Identity 不是只有“像不像”，还包括“怎么说”。

```text
SpeechProfile
- default_speed
- energy
- tone
- pause_style
- sentence_gap_ms
- hook_style
- body_style
- explanation_style
- quote_style
- conclusion_style
- number_reading_style
- acronym_policy
- pronunciation_dictionary
- disfluency_policy
```

未来 Director 可根据历史节目与 Analytics 自动学习 Creator Style，但自动学习必须可查看、可关闭、可恢复。

---

# 7. Content Normalization 层

任何输入必须先转成统一结构，而不是直接发给 LLM。

建议：

```ts
ContentDocument {
  id
  title
  language
  author?
  sourceUrl?
  publishedAt?
  blocks[]
  claims[]
  citations[]
  tables[]
  figures[]
  attachments[]
}
```

Block 类型：

- heading
- paragraph
- quote
- list
- table
- image
- chart
- embed

Claim：

```ts
Claim {
  id
  text
  factuality: "fact" | "analysis" | "opinion" | "uncertain"
  sourceIds[]
  structuredData?
}
```

目的：

- Director 能知道哪些内容可以做数据图。
- 视频 Source Card 可追踪出处。
- 避免后续无法知道数据来自哪里。

---

# 8. Narrative Engine

Narrative Engine 负责把“文章结构”变成“视频叙事结构”。

它不生成视觉素材。

输入：

- ContentDocument
- Creator Profile
- Target duration
- Platform
- Tone
- Audience

输出：

```ts
NarrativePlan {
  title
  thesis
  hook
  chapters[]
  narrationBlocks[]
  keyClaims[]
  requiredVisualFacts[]
  ending
  estimatedDuration
}
```

## 8.1 推荐知识视频叙事模式

默认可以采用：

```text
问题 / Hook
↓
发生了什么
↓
为什么发生
↓
历史/背景
↓
核心机制
↓
数据证据
↓
不同情景/反方
↓
影响
↓
总结
```

不要求所有视频都套同一模板。

## 8.2 约束

- 不允许直接逐字朗读文章作为默认结果。
- 视频语言必须口语化。
- 必须保留文章核心事实和逻辑。
- 用户锁定文字不得被静默修改。
- 事实与分析需要保留类型信息。

---

# 9. Director Engine

Director 是产品最核心的差异化系统。

## 9.1 输入

- NarrativePlan
- ContentDocument
- CreatorProfile
- Component Library
- Asset Library
- Provider Capabilities
- Budget mode
- Privacy mode
- Target platform
- Historical performance（未来）

## 9.2 输出

- Scene Graph
- Asset Plan
- Provider Jobs Plan
- Estimated cost
- Estimated duration
- Risk/warning list

## 9.3 Director 需要做的判断

每个 Narrative Block 需要判断：

```text
这句话是什么信息类型？
是否需要真人主持？
是否需要数据？
是否有地理关系？
是否有时间关系？
是否有因果关系？
是否有 A/B 比较？
是否必须显示 Source？
真实图片是否比 AI 画面好？
现有标准组件能否表达？
是否值得使用 Custom Motion？
是否值得使用昂贵 AI Video？
```

## 9.4 Director 默认视觉策略

必须避免长时间连续 Avatar。

初始建议值，仅作为 configurable defaults：

- Avatar 总占比：15%～30%
- 单段连续 Avatar：尽量 < 20～25 秒
- 高频视觉变化：每 4～12 秒至少有明显视觉变化
- AI Video：原则上低于总时长 10%～20%，除非 Creator Profile 指定
- 数据/信息动画优先

这些不是硬编码业务规则，应由 Channel Profile / Director Policy 配置。

---

# 10. Visual Grammar v0.1

Director 先识别语义，再选择视觉表达。

## 10.1 Semantic Types

MUST 支持：

```text
NUMBER
KPI_SET
TREND
COMPARISON
RANKING
TIMELINE
CAUSE_EFFECT
FEEDBACK_LOOP
FLOW
GEOGRAPHY
NETWORK
PROCESS
QUOTE
SOURCE
PERSON
COMPANY
DOCUMENT
IMAGE_EVIDENCE
VIDEO_EVIDENCE
CONCEPT
TRANSITION
SUMMARY
HOST_STATEMENT
```

财经扩展：

```text
YIELD_SPREAD
YIELD_CURVE
PRICE_SERIES
CANDLE_SERIES
PERCENT_CHANGE
BALANCE_SHEET
SUPPLY_DEMAND
TRADE_FLOW
CAPITAL_FLOW
POLICY_PATH
SCENARIO_COMPARE
```

## 10.2 Scene Type Mapping

建议首批实现至少 30～40 个 Component：

### Host

- HOST_FULL
- HOST_SIDE
- HOST_PIP
- HOST_OVERLAY

### Numbers / KPI

- BIG_NUMBER
- KPI_GRID
- NUMBER_COMPARE
- PERCENT_DELTA

### Charts

- LINE_CHART
- DUAL_LINE_CHART
- AREA_CHART
- SPREAD_AREA_CHART
- BAR_CHART
- STACKED_BAR_CHART
- YIELD_CURVE
- CANDLE_CHART
- POLICY_PATH
- RANKING_BAR

### Structure / Explanation

- CAUSAL_FLOW
- CAUSAL_LOOP
- PROCESS_FLOW
- FLOW_DIAGRAM
- SUPPLY_CHAIN
- NETWORK_DIAGRAM
- SCENARIO_TREE
- CONCEPT_EXPLAINER

### Time

- TIMELINE
- EVENT_SEQUENCE

### Geography

- MAP_STATIC
- MAP_ZOOM
- MAP_FLOW
- TRADE_ROUTE_MAP

### Evidence / Sources

- NEWS_HEADLINE
- SOURCE_CARD
- QUOTE_CARD
- DOCUMENT_HIGHLIGHT
- SCREENSHOT_FRAME

### Entity

- PERSON_PROFILE
- COMPANY_PROFILE
- COUNTRY_PROFILE
- LOGO_WALL

### Media

- IMAGE_FULL
- IMAGE_COLLAGE
- REAL_BROLL
- AI_VIDEO

### Structure

- CHAPTER_TITLE
- SECTION_BREAK
- SUMMARY
- CTA

### Creative

- CUSTOM_MOTION

## 10.3 事实可视化约束

MUST：

- 数据图表只能绑定结构化数据或可追踪 Source。
- 如果关键数据缺失，不得由 AI 编造图形数据。
- 缺失时应降级为 Source Card / Quote / textual explanation，或提示用户补数据。
- 图表 Scene 必须保存 data_source_ids。
- 关键财经图表建议在画面中可选显示 source label。

---

# 11. 双视觉引擎

## 11.1 Standard Scene Engine

承担约 70%～85% 的常规场景。

实现方式：Remotion React Component Library。

特点：

- 可参数化
- 可测试
- 稳定
- 品牌统一
- 低边际成本
- 实时 Preview

每个 Component 必须有：

```ts
ComponentDefinition {
  type
  version
  inputSchema
  defaults
  supportedAspectRatios
  minDuration
  maxDuration?
  previewFixture
  renderer
}
```

## 11.2 Generative Motion Engine

用于 15%～30% 的高光场景。

当标准组件无法充分表达时，Director 输出：

```text
CUSTOM_MOTION_REQUIRED
```

Motion Designer Agent 根据：

- narration
- visual intent
- duration
- aspect ratio
- brand tokens
- source data

生成一个独立 Remotion/React Scene。

### 安全要求

AI 生成代码 MUST：

1. 在隔离沙箱执行。
2. 默认无网络权限。
3. 只允许白名单依赖。
4. TypeScript 编译检查。
5. ESLint/静态分析。
6. Render smoke test。
7. 设置 CPU/RAM/执行时间限制。
8. 不允许访问平台 Secret。
9. 不允许任意 filesystem path。
10. 通过后才能进入项目。

优秀 Custom Motion 可以由用户选择“Save as Component”，经过审核后进入个人/平台 Component Library。

---

# 12. Scene Graph v0.1

Scene Graph 是跨 Web / Desktop / Mobile 的统一数据模型。

## 12.1 Project Scene Graph

示例：

```json
{
  "schemaVersion": "0.1",
  "projectId": "prj_123",
  "projectRevision": 42,
  "channelId": "chn_001",
  "format": {
    "width": 1920,
    "height": 1080,
    "fps": 30,
    "aspectRatio": "16:9"
  },
  "timeline": {
    "durationMs": 582000,
    "masterAudioAssetId": "ast_audio_01"
  },
  "scenes": [
    {
      "id": "scn_017",
      "revision": 7,
      "order": 17,
      "startMs": 91200,
      "durationMs": 8400,
      "semanticType": "YIELD_SPREAD",
      "sceneType": "SPREAD_AREA_CHART",
      "narration": "法国与德国十年期国债利差扩大……",
      "visualIntent": "突出利差达到 140bp，并展示最近五年历史区间",
      "component": {
        "componentId": "spread-area-chart",
        "version": "1.2.0",
        "props": {
          "highlightValue": 140
        }
      },
      "dataSourceIds": ["src_ecb_1"],
      "assetIds": [],
      "providerStrategy": {
        "kind": "deterministic",
        "provider": "remotion"
      },
      "transitionIn": "fade",
      "transitionOut": "cut",
      "locked": false
    }
  ]
}
```

## 12.2 Scene 必备字段

MUST：

```text
id
project_id
revision
order
start_ms
duration_ms
semantic_type
scene_type
narration
visual_intent
component/provider strategy
settings
asset references
source/data references
locked state
status
created_at
updated_at
```

SHOULD：

```text
cost_estimate
actual_cost
quality_score
render_status
provider_job_ids
user_notes
ai_reasoning_summary（非私密 CoT，只保存可解释决策摘要）
performance_metrics
```

## 12.3 时间模型

Scene Graph 中时间使用整数毫秒或整数 frame，不使用 float 秒作为权威值。

建议内部权威：`startFrame / durationInFrames` 或 `startMs / durationMs`，统一一套。

Remotion 渲染前转换。

---

# 13. Audio-First Timing

声音是知识视频的主时钟。

流程：

```text
Final Narration Script
↓
Master Voice Generation
↓
Word/Character Timestamp Alignment
↓
Scene Timing
↓
Motion Timing
↓
Subtitle Timing
```

MUST：

- 保存 Master Narration Asset。
- 保存 timestamp alignment。
- Scene 动画能够绑定 narration cue。
- 修改文字后相关音频和时间轴标记失效并触发局部重建。

例如：

```text
00:50.31 “140bp”
→ 图表标记在这一时刻出现
```

ElevenLabs 等支持 timing 的 Provider 可以直接利用；否则需要使用内部 forced alignment 服务。

---

# 14. Provider 分工

## 14.1 LLM Provider

负责：

- 内容理解
- Narrative
- Director planning
- Prompt generation
- AI editing
- Custom Motion code generation

禁止：直接让单个 LLM 决定所有不可审计的最终视频状态。

## 14.2 HeyGen / Avatar Provider

主要职责：

- Digital Twin / Avatar 主持人镜头
- Lipsync
- Avatar Voice（如果使用）

原则：

> HeyGen 是演员，不是整个视频制作系统。

Avatar 镜头应只作为完整 Scene Graph 中的一种 Scene。

## 14.3 Voice Provider

例如 ElevenLabs、HeyGen Voice 或未来 Provider。

职责：

- Master Narration
- Instant / Professional Voice Clone（Provider 支持时）
- Timestamped speech / alignment
- Voice list / Voice selection
- Pronunciation dictionary（Provider 支持时）
- Speech style / expressiveness 控制（Provider 支持时）

原则：

> 声音是 Creator Identity 的一部分，也是整部视频的主时钟。

如果使用 HeyGen 自带 Voice，仍必须统一抽象在 VoiceProvider 下，不允许业务层直接依赖 HeyGen Voice schema。

MUST：Voice clone 原始样本、授权状态、provider_voice_id、retention policy 和 ownership metadata 不得混为同一字段。

## 14.4 Veo

适合：

- Hero shot
- 难以用数据或图形表达的概念镜头
- 电影化场景
- Image-to-video
- Reference/first-last-frame 等高级生成

不适合：

- 数据图表
- 利率曲线
- 真实财经数字
- 来源引用

## 14.5 Runway

职责：

- AI Video fallback / alternate models
- 成本、速度、能力补充
- 可利用 Model Router，但平台自身仍应保留一层 Provider Router

## 14.6 Remotion

职责：

- Standard Scene Engine
- 数据可视化
- Motion Graphics
- Map
- Subtitle
- Timeline Composition
- Web Preview Player
- Final Render

Remotion 是核心渲染层，不只是一个特效工具。

---

# 15. Provider Contracts

业务层只依赖内部接口。

示例：

```ts
interface VideoGenerationProvider {
  capabilities(): Promise<VideoCapabilities>;
  estimate(input: VideoGenerationRequest): Promise<CostEstimate>;
  submit(input: VideoGenerationRequest): Promise<ProviderJob>;
  getStatus(jobId: string): Promise<ProviderJobStatus>;
  cancel?(jobId: string): Promise<void>;
  fetchResult(jobId: string): Promise<GeneratedAsset>;
}

interface AvatarProvider {
  listAvatars(ctx: ProviderContext): Promise<Avatar[]>;
  generate(req: AvatarGenerationRequest): Promise<ProviderJob>;
  getStatus(jobId: string): Promise<ProviderJobStatus>;
}

interface VoiceProvider {
  capabilities(ctx: ProviderContext): Promise<VoiceCapabilities>;
  listVoices(ctx: ProviderContext): Promise<Voice[]>;
  synthesize(req: VoiceRequest): Promise<VoiceResult>;
  createInstantClone?(req: InstantVoiceCloneRequest): Promise<VoiceCloneResult>;
  createProfessionalClone?(req: ProfessionalVoiceCloneRequest): Promise<ProviderJob | VoiceCloneResult>;
  getCloneStatus?(jobId: string): Promise<ProviderJobStatus>;
  deleteVoice?(voiceId: string): Promise<void>;
}
```

Provider Adapter 必须处理：

- auth
- retries
- rate limits
- webhooks
- polling
- provider-specific errors
- cost metadata
- retention metadata
- version changes

禁止业务代码直接出现：

```ts
if (scene.sceneType === "AI_VIDEO") {
  callVeoDirectly();
}
```

---

# 16. Provider Router

Director 输出“能力需求”，Router 决定 Provider。

示例：

```json
{
  "modality": "video",
  "shotType": "cinematic",
  "importance": "hero",
  "motionComplexity": "high",
  "characterConsistency": "low",
  "durationMs": 6000,
  "qualityProfile": "premium",
  "budgetCeiling": 2.50,
  "privacyProfile": "standard"
}
```

Router 维度：

- Capability
- Quality
- Cost
- Latency
- Provider availability
- Queue depth
- Failure rate
- Workspace provider policy
- Region
- Privacy requirement
- BYOK availability

模式：

```text
AUTO
QUALITY
BALANCED
FAST
LOW_COST
PRIVATE
PINNED_PROVIDER
```

MUST：模型名称和价格不要硬编码在业务逻辑；存 Provider Catalog / Configuration。

---

# 17. Platform Managed API 与 BYOK

采用混合模式。

## 17.1 默认

普通用户：Platform Managed。

体验：

```text
注册
→ 导入文章
→ Generate
```

用户不需要先注册 5 个 API。

## 17.2 BYOK

专业用户和企业可连接：

- HeyGen
- Google/Veo
- Runway
- ElevenLabs
- LLM Provider

决策：

```text
Workspace 有该 Provider BYOK？
YES → BYOK
NO  → Platform Managed
```

允许 Workspace 级覆盖：

```text
Avatar: BYOK HeyGen
Voice: Platform Managed
AI Video: BYOK Google + Platform fallback
```

Creator Identity Provider 允许单独选择托管模式：

```text
Avatar Identity: Platform Managed / BYOK
Voice Identity: Platform Managed / BYOK
AI Video: Automatic / Platform Managed / BYOK
```

重度创作者与企业不应被迫把 Professional Voice / Digital Twin 锁在平台账号中。

## 17.3 Secret 存储

Provider credentials MUST：

- 只在后端使用
- KMS / envelope encryption
- UI 只显示 masked token
- 日志绝不打印 Secret
- 有 created_at / last_used_at / revoked_at
- 可 rotate

绝不将完整 Provider Key 下发到 Web/Mobile/Desktop Client。

---

# 18. 三档生成模式

## 18.1 Draft

目标：快速、便宜、可频繁修改。

默认：

- Avatar → placeholder 或低成本 preview
- AI Video → still / storyboard placeholder
- Standard Scene → Remotion real preview
- Voice → preview voice / low-cost voice

MUST：用户反复编辑 Draft 不应频繁调用昂贵 Video Provider。

## 18.2 Studio

正式常规成片：

- 正式 Avatar
- 正式 Voice
- Standard Components
- 必要 AI Video
- 1080p

## 18.3 Hero / Premium

- 高质量 Avatar
- Custom Motion
- Premium Video Provider
- 高分辨率素材
- 更高渲染质量

所有档位都是策略配置，不在代码里写死供应商。

---

# 19. 异步任务与并发架构

“100 个用户同时点 Generate”不等于“同时发 100 个 HeyGen 请求”。

建议：

```text
Clients
  ↓
API
  ↓
Workflow DB
  ↓
Queue
  ├─ llm
  ├─ avatar
  ├─ voice
  ├─ video-gen
  ├─ asset-processing
  └─ render
```

## 19.1 Job 状态

统一：

```text
QUEUED
WAITING_DEPENDENCY
RUNNING
PROVIDER_QUEUED
SUCCEEDED
FAILED_RETRYABLE
FAILED_FINAL
CANCEL_REQUESTED
CANCELLED
```

项目级状态：

```text
DRAFT
SCRIPTING
STORYBOARDING
GENERATING_AUDIO
GENERATING_ASSETS
READY_FOR_REVIEW
RENDER_QUEUED
RENDERING
READY
FAILED
ARCHIVED
```

## 19.2 并发控制

MUST 有：

- Provider-specific concurrency semaphore
- Workspace rate limit
- Platform rate limit
- Queue priority
- exponential backoff
- jitter
- idempotency
- dead letter / failed job inspection
- manual retry
- provider webhook verification

Provider limit 不得写死；从配置加载。

## 19.3 初期实现建议

MVP：

- Redis
- BullMQ
- PostgreSQL 状态表
- Transactional Outbox

保留 `WorkflowEngine` 抽象，未来可切 Temporal。

---

# 20. 隐私与第三方数据最小化

## 20.1 数据分类

建议分：

```text
PUBLIC
INTERNAL
CONFIDENTIAL
IDENTITY_SENSITIVE
```

其中：

- 未发布文章 = CONFIDENTIAL
- Digital Twin 原始素材 = IDENTITY_SENSITIVE
- Voice Clone 原始音频 = IDENTITY_SENSITIVE

## 20.2 Provider 最小化

默认：

```text
完整文章/研究
→ 我们内部处理

Scene 26
→ 只把 Scene 26 必要 Prompt/参考资产发送给视频 Provider
```

Provider request metadata 必须记录：

- provider
- purpose
- data classification
- asset IDs
- retention policy snapshot

不要求在普通 UI 暴露全文，但 Enterprise/Audit 页面未来可查看。

## 20.3 身份素材

如果 Provider 支持用户直接完成 Avatar/Voice onboarding：

优先：

```text
User → Provider
Provider → avatar_id/voice_id
Our DB → only provider reference
```

避免平台长期保存不必要的原始身份训练素材。

## 20.4 隐私模式

### Standard

- Platform Managed
- 常规 Provider 策略

### Private

- Scene-level minimal data
- Signed URL
- Provider result 立即回收至平台存储
- 禁止发送完整 article 给 Video Provider
- 更严格日志脱敏
- BYOK 可选

### Enterprise

- ZDR-capable Provider
- Dedicated credentials
- DPA
- Regional storage
- Customer cloud（未来）
- Audit logs

重要：

```text
No training != No storage
API != Zero retention
Delete output != Delete logs
```

必须在产品隐私说明和工程代码里分别处理。

---

# 21. 数据与存储总架构

建议初期：

```text
PostgreSQL
→ 状态、关系、元数据

Object Storage (R2/S3)
→ 文件、音频、视频、图片、导出

Redis
→ Queue、lock、cache、rate limit

Analytics DB（后期 ClickHouse）
→ 高频事件和观看数据
```

不要把视频 blob 存 PostgreSQL。

---

# 22. 核心领域模型

## 22.1 Workspace

所有业务资源 MUST 归属 workspace。

```text
Workspace
├─ Members
├─ Channels
├─ Provider Credentials
├─ Projects
├─ Assets
├─ Billing
└─ Usage
```

未来团队/MCN/企业依赖此模型。

## 22.2 Channel

保存 Creator Profile 和长期风格。

## 22.3 Project

```text
projects
id
workspace_id
channel_id
title
source_type
status
current_version_id
aspect_ratio
resolution
fps
target_duration_ms
created_by
created_at
updated_at
deleted_at
```

## 22.4 Scenes

不要把所有 Scene 塞在一个巨大 JSON 中作为唯一数据库状态。

```text
scenes
id
workspace_id
project_id
revision
position
start_ms
duration_ms
semantic_type
scene_type
narration
visual_intent
component_id
component_version
settings_json
locked
status
created_at
updated_at
```

Scene Graph 可由这些规范化记录生成 Snapshot。

## 22.5 Assets

```text
assets
id
workspace_id
project_id?
scene_id?
asset_type
origin
provider
provider_asset_id?
storage_key
mime_type
size_bytes
duration_ms?
width?
height?
checksum
status
metadata_json
created_at
deleted_at
```

Asset Type 至少：

```text
SOURCE_DOCUMENT
SOURCE_IMAGE
USER_UPLOAD
AVATAR_CLIP
VOICE_AUDIO
MUSIC
GENERATED_IMAGE
GENERATED_VIDEO
CHART_RENDER
CUSTOM_MOTION_RENDER
SUBTITLE
DRAFT_RENDER
FINAL_VIDEO
SHORT_VIDEO
THUMBNAIL
MANIFEST
```

---

# 23. 版本与编辑历史

采用：

> Current State + Event Log + Periodic Snapshot

不要做完全纯 Event Sourcing，避免 MVP 复杂度过高。

## 23.1 Edit Events

```text
edit_events
id
workspace_id
project_id
scene_id?
actor_type
actor_id
action
intent_text?
patch_json
base_revision
result_revision
created_at
```

例：

```json
{
  "action": "UPDATE_SCENE",
  "sceneId": "scn_17",
  "intent": "这个数字需要更突出",
  "patch": {
    "sceneType": {
      "from": "LINE_CHART",
      "to": "BIG_NUMBER"
    }
  }
}
```

## 23.2 Project Versions

```text
project_versions
id
project_id
version_number
snapshot_asset_id / snapshot_json
reason
created_by
created_at
```

自动创建 Snapshot 时机：

- AI 重新编导前后
- Final Render
- Publish
- 用户手动“Save Version”
- 每 N 个编辑事件

## 23.3 Undo/Redo

Web 客户端可以 optimistic，但最终必须由服务器 Revision 检查。

每个写操作带：

```text
baseRevision
idempotencyKey
```

冲突返回明确 `409 VERSION_CONFLICT`。

这一设计为后续桌面/移动端多端同步保留基础。

---

# 24. Intent History 与 Audit Log 必须分开

## 24.1 Intent / Content History

给创作者使用：

- 改文字
- 改 Scene
- AI 重生成
- 重新导演
- 用户自然语言意图

用于 Undo / Restore / History。

## 24.2 Audit Log

给安全/企业管理：

- 登录
- 下载
- 删除
- 邀请成员
- 修改 API Key
- 发布
- Provider credential access
- 权限变更

```text
audit_logs
id
workspace_id
actor_id
action
resource_type
resource_id
ip_hash
user_agent
metadata_json
created_at
```

Audit Log 不应保存未发布文章全文或完整 prompt。

---

# 25. AI Generation / Cost Ledger

每一次 Provider 调用都必须可追踪。

```text
provider_generations
id
workspace_id
project_id
scene_id?
provider
model
operation
credential_mode
provider_job_id
input_hash
input_metadata_json
output_asset_id?
status
latency_ms
estimated_cost
actual_cost
currency
retry_count
error_code?
created_at
completed_at?
```

用途：

- 成本核算
- Credits
- Provider 质量对比
- 调试
- 容量规划
- 失败率

Prompt 如需保存，应使用加密字段并做敏感信息控制；普通日志不得打印完整 Prompt。

---

# 26. Object Storage 设计

建议 R2 / S3。

逻辑路径：

```text
/workspaces/{workspaceId}/
  projects/{projectId}/
    sources/
    uploads/
    audio/
    scenes/
    renders/
    exports/
```

数据库只存 `storage_key`，不要把 Object URL 作为永久标识。

## 26.1 Direct Upload

MUST：大文件由 Client 直传 Object Storage。

流程：

```text
Client
→ POST /assets/upload-intents
→ API 返回 signed upload URL
→ Client 直传 Object Storage
→ Client/Storage callback complete
→ API 创建/确认 Asset
```

禁止用户 5GB 视频先经过 Web App Server 再传对象存储。

## 26.2 下载/播放

通过：

- CDN
- Signed URL

避免通过 API Server 流式代理大视频。

## 26.3 Hash 去重

对上传 Asset 计算 SHA-256。

至少支持 workspace 内去重。

不建议默认跨 Workspace 物理去重，避免隐私/侧信道风险。

---

# 27. Retention Policy

默认建议：

| 数据 | 默认策略 |
|---|---|
| Final Video | 用户删除前持续保存 |
| 用户原始素材 | 用户删除前持续保存 |
| 已付费 Generated Scene Asset | 持续保存/按套餐 |
| Draft Full Render | 30 天 TTL |
| Preview Cache | 7 天 TTL |
| Temp Transcode | 24～72 小时 |
| Provider 临时文件 | 尽快清理/按 Provider 能力 |
| Trash | 30 天 Soft Delete |

删除项目：

1. `deleted_at` Soft Delete。
2. 进入 Trash。
3. 到期后 Hard Delete Worker 删除：
   - scene
   - asset metadata
   - object storage
   - search index
   - preview cache
4. Audit Log 可保留“发生过删除”事件，但不保留内容。

---

# 28. Project Manifest

每次 Final Render MUST 生成 `manifest.json`。

包含：

```text
project id
project version
scene graph schema version
script version
component versions
scene assets
master audio
render settings
provider/model metadata
source references
created timestamp
```

目标：

- 两年后能理解该视频如何构建。
- 可以重新渲染同一项目版本。
- Provider 模型不可用时可识别依赖缺口。

“可重建”不等于保证像素级完全复现外部生成模型结果；生成式 Asset 应尽可能缓存原始输出。

---

# 29. Web First + Multi-Client Backend 设计

这是强制要求。

## 29.1 总体

```text
                         Cloud Backend
                               │
             ┌─────────────────┼─────────────────┐
             │                 │                 │
           Web              Desktop           Mobile
         Next.js          Tauri/Electron     React Native
```

三个 Client：

- 使用相同 Backend API
- 使用相同 Auth/Workspace/Project ID
- 使用相同 Scene Graph Contract
- 使用相同 Assets
- 使用相同 Job 状态
- 使用相同 History

## 29.2 后端不得依赖 Web Runtime

推荐：

```text
apps/web        Next.js
apps/api        NestJS/Fastify
apps/worker     Node.js worker
apps/render     Remotion renderer
```

不要将业务 API 只实现为：

```text
app/api/* Next route handlers
Next.js Server Actions
```

Web 可以有 BFF，但权威业务必须在独立 API。

## 29.3 API 版本化

```text
/api/v1/...
```

Breaking change 必须通过新版本或兼容层处理。

Client 能发送：

```text
X-Client-Type: web | desktop | ios | android
X-Client-Version: 0.1.0
```

## 29.4 Shared Contract

建议 Monorepo：

```text
packages/contracts
packages/sdk
packages/domain
```

使用 Zod/JSON Schema 作为请求/响应和 Scene Graph schema。

生成 OpenAPI，并生成/维护统一 SDK。

Web/桌面/手机禁止分别手写三套 API type。

## 29.5 多端同步

第一阶段要求在线使用，不要求完整离线剪辑。

但 API MUST 从第一天带 revision：

```text
projectRevision
sceneRevision
baseRevision
```

未来离线模式可以把 edit operations 排队上传。

冲突策略：

- 非冲突 Scene 可自动合并。
- 同 Scene 同字段冲突 → 409 + 提示用户选择。
- AI 大范围 rewrite 需要创建新 Project Version。

## 29.6 实时状态

Web / Desktop / Mobile 都需要知道生成进度。

MVP：

- REST 获取状态
- SSE 或 WebSocket 推送 Job Event

事件示例：

```text
project.updated
scene.updated
job.started
job.progress
job.completed
job.failed
render.progress
asset.ready
```

不要让客户端轮询每秒打 API。

## 29.7 Desktop 后续设计

建议后续用 Tauri 或 Electron，优先评估 Tauri 体积与本地能力。

桌面端优势：

- 本地文件拖拽
- 本地缓存
- 快捷键
- 更强 Timeline 操作
- 本地批量导入/导出

初期 Final Render 仍建议云端，不要为了桌面版本分叉渲染逻辑。

未来可添加 Local Render Provider，但仍遵循 RenderProvider Contract。

## 29.8 Mobile 后续设计

推荐 React Native（共享 TypeScript contracts/SDK）。

移动端第一阶段重点不是完整剪辑：

- 查看项目
- 审核 Script
- 审核 Storyboard
- Preview
- AI 修改
- Scene 轻编辑
- Approve / Final Render
- 查看生成状态
- 下载/分享
- Push notification

不要一开始在手机复制桌面 Timeline 全能力。

---

# 30. 认证与会话设计

为了多端，不可只依赖 Web Cookie Session。

建议：

- Auth service
- 短生命周期 Access Token
- Rotating Refresh Token
- Web：HttpOnly Secure Cookie 保存 token/session
- Native：OS Secure Storage/Keychain/Keystore

所有 API 根据用户 + workspace membership 授权。

未来支持：

- Email/password
- Magic Link
- Google login
- Enterprise SSO

MVP 可先做简单登录，但 Auth Contract 必须兼容原生客户端。

---

# 31. Workspace RBAC

角色建议：

```text
OWNER
ADMIN
EDITOR
REVIEWER
VIEWER
```

权限示例：

- Owner：所有权限
- Admin：成员、Provider、项目管理
- Editor：创建/编辑/生成/渲染
- Reviewer：评论、批准、有限修改
- Viewer：只读

每个资源请求 MUST 验证 workspace membership。

禁止只使用 `project_id` 查询后直接返回资源。

---

# 32. Backend API v1 草案

## Auth

```text
POST /v1/auth/login
POST /v1/auth/refresh
POST /v1/auth/logout
GET  /v1/me
```

## Workspace

```text
GET  /v1/workspaces
POST /v1/workspaces
GET  /v1/workspaces/:id
PATCH /v1/workspaces/:id
GET  /v1/workspaces/:id/members
POST /v1/workspaces/:id/members
```

## Channels / Creator Profile

```text
GET   /v1/channels
POST  /v1/channels
GET   /v1/channels/:id
PATCH /v1/channels/:id
```

## Projects

```text
GET    /v1/projects
POST   /v1/projects
GET    /v1/projects/:id
PATCH  /v1/projects/:id
DELETE /v1/projects/:id
POST   /v1/projects/:id/restore
```

## Source / Content

```text
POST /v1/projects/:id/sources/url
POST /v1/projects/:id/sources/text
POST /v1/projects/:id/sources/file
GET  /v1/projects/:id/sources
```

## Narrative / Director

```text
POST /v1/projects/:id/narrative/generate
POST /v1/projects/:id/director/generate
POST /v1/projects/:id/director/edit
```

`director/edit` 请求至少：

```json
{
  "instruction": "开头太慢，前30秒压缩并增加数据图",
  "selection": {
    "sceneIds": []
  },
  "baseRevision": 41,
  "mode": "plan_then_apply"
}
```

返回 SHOULD 先提供 change plan；用户 Apply 后 commit。

## Scenes

```text
GET    /v1/projects/:id/scenes
POST   /v1/projects/:id/scenes
GET    /v1/scenes/:id
PATCH  /v1/scenes/:id
DELETE /v1/scenes/:id
POST   /v1/scenes/:id/duplicate
POST   /v1/scenes/:id/regenerate
POST   /v1/scenes/:id/change-type
POST   /v1/scenes/reorder
```

## Assets

```text
POST /v1/assets/upload-intents
POST /v1/assets/:id/complete
GET  /v1/assets/:id
DELETE /v1/assets/:id
GET  /v1/projects/:id/assets
```

## History

```text
GET  /v1/projects/:id/history
GET  /v1/projects/:id/versions
POST /v1/projects/:id/versions
POST /v1/projects/:id/versions/:version/restore
POST /v1/scenes/:id/restore/:revision
```

## Jobs

```text
GET  /v1/jobs/:id
POST /v1/jobs/:id/cancel
POST /v1/jobs/:id/retry
```

## Render

```text
POST /v1/projects/:id/renders/draft
POST /v1/projects/:id/renders/final
GET  /v1/renders/:id
```

## Providers

```text
GET    /v1/provider-connections
POST   /v1/provider-connections
PATCH  /v1/provider-connections/:id
DELETE /v1/provider-connections/:id
POST   /v1/provider-connections/:id/test
```

## Usage

```text
GET /v1/usage
GET /v1/storage
GET /v1/provider-usage
```

## Events

```text
GET /v1/events/stream
```

---

# 33. API 通用规范

每个写请求 SHOULD 支持：

```text
Idempotency-Key
X-Request-Id
```

错误统一：

```json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "Scene has changed since your last edit.",
    "requestId": "req_123",
    "details": {}
  }
}
```

API 必须支持：

- Pagination
- Filtering
- Sorting
- Request tracing
- Backwards-compatible JSON

Webhook 必须：

- 校验签名
- 防 replay
- 幂等处理

---

# 34. 推荐数据库表

第一版至少：

```text
users
sessions / refresh_tokens
workspaces
workspace_members
channels
creator_profiles
projects
project_sources
claims
source_citations
narrative_plans
scripts
scenes
scene_data_bindings
assets
scene_assets
project_versions
edit_events
audit_logs
jobs
job_dependencies
provider_generations
provider_connections
provider_configs
renders
publications
usage_ledger
credit_ledger
storage_usage
component_definitions
custom_components
notifications
webhook_events
outbox_events
```

后期：

```text
analytics_events
video_performance
scene_performance
creator_learnings
experiments
```

---

# 35. Usage / Credits / Billing

用户不应该看到混乱的 Provider Credits。

我们定义统一：

> Video Credits

例如在 UI：

```text
Draft       12 Credits
Studio      83 Credits
Premium    177 Credits
```

实际内部：

```text
Provider cost
+ render cost
+ storage cost
+ platform margin
```

## 35.1 Usage Ledger

必须使用 ledger，不要只维护一个可变 balance。

```text
credit_ledger
id
workspace_id
type: CREDIT | DEBIT | REFUND | ADJUSTMENT
amount
reference_type
reference_id
metadata
created_at
```

## 35.2 BYOK 用户

BYOK 生成不一定扣同样 Provider Credits，但仍可：

- 扣 Workflow / Render Credits
- 或包含在订阅费

计费策略不要硬编码在 generation service。

---

# 36. Storage Quota

视频项目可能很大，套餐必须考虑存储。

UI 显示：

```text
Storage 182 GB / 500 GB
```

Storage usage 应通过后台周期任务核算。

不要把所有 Draft 永久保留。

---

# 37. 自然语言 AI 编辑协议

AI 修改不能直接神秘地改数据库。

建议两阶段：

```text
User Instruction
↓
Director Edit Planner
↓
Change Plan
↓
Preview / Apply
↓
Transaction
↓
Edit Event
```

Change Plan 示例：

```json
{
  "summary": "缩短连续数字人口播并插入数据图",
  "operations": [
    {
      "op": "update_scene",
      "sceneId": "scn_2",
      "changes": {"durationMs": 7000}
    },
    {
      "op": "insert_scene",
      "after": "scn_2",
      "sceneType": "LINE_CHART"
    }
  ]
}
```

要求：

- 用户可看到改了什么。
- 大范围操作必须可撤销。
- 被 Lock 的 Scene 不允许 AI 修改，除非用户显式解锁。

---

# 38. Draft Preview

Remotion Player 作为 Web 实时 Preview 核心。

Preview 使用 Scene Graph + Draft Assets。

必须做到：

- 更改 Scene props 不需要先生成 MP4。
- Chart/Map/Motion 可以即时预览。
- AI Video 未生成时使用 placeholder。
- Avatar 未生成时使用 Avatar placeholder。

最终昂贵生成只在 Final / explicit Generate Asset 时触发。

---

# 39. Rendering

推荐：

- Web Preview → Remotion Player
- Server render → Remotion Lambda 或 Render Worker
- 后处理 → FFmpeg

Render Job 输入：

```text
project_version
scene_graph_snapshot
asset_versions
render_profile
```

Render Profile：

```text
DRAFT_720
STUDIO_1080
PREMIUM_4K
SHORT_1080x1920
```

## 39.1 Partial Regeneration

如果 Scene 17 变更：

- 不应重新调用所有外部 Provider。
- 重用未失效 Asset。
- 只生成 Scene 17 必要 Asset。

最终 MP4 重新合成可以接受，但外部昂贵 Asset 必须缓存。

后续可做 partial rendered segment cache。

---

# 40. Asset Invalidation

每个 Asset 应记录依赖 hash：

```text
scene content hash
provider config hash
source asset hash
voice/avatar config hash
```

只有依赖变化才重新生成。

例如用户改变视频标题，不应该导致 Veo Scene 重新生成。

---

# 41. Analytics Feedback Loop（后期）

未来接 YouTube 等播放数据：

```text
Content
→ Video
→ Publish
→ Retention / CTR / Watch Time
→ Scene Performance
→ Director Learning
```

目标数据模型：

```text
Scene Type
× Topic
× Duration
× Position
× Creator
× Audience Retention
```

系统可以学习：

- 某 Creator 连续 Avatar 超过 25 秒留存下降。
- 某类能源主题 Map Flow 留存更好。
- 数据图比 AI B-roll 效果好。

任何自动学习规则必须：

- 可解释
- 可关闭
- 可人工覆盖

---

# 42. Multi-Platform Publishing（Publishing Pack / Post-MVP）

发布层不是 V1 核心。任何平台都不得假设存在同等、稳定、永久可用的自动发布能力。

## 42.1 Capability Tier

平台能力统一分级：

```text
P1 DIRECT_PUBLISH
官方 API 支持可靠上传/发布/状态查询。

P2 AUTHORIZED_PUBLISH
官方 API 可发布，但要求用户授权、显式确认、应用审核或平台特定约束。

P3 UPLOAD_DRAFT / HANDOFF
可上传到 Draft/Inbox/待发布状态，最终发布由用户在目标平台确认。

P4 EXPORT_PACKAGE
无可靠公开发布 API；生成平台适配包，由 Desktop/Mobile/Web 协助用户手动完成最后一步。
```

平台能力必须来自 Capability Registry，禁止硬编码“某平台永远是 P1/P2”。平台 API 政策变化后可配置降级。

## 42.2 Distribution Provider Contract

```ts
interface DistributionProvider {
  capabilities(ctx: ProviderContext): Promise<DistributionCapabilities>;
  authorize?(req: AuthorizationRequest): Promise<AuthorizationResult>;
  validate(req: PublicationRequest): Promise<ValidationResult>;
  publish?(req: PublicationRequest): Promise<PublicationJob>;
  uploadDraft?(req: PublicationRequest): Promise<DraftTransferResult>;
  getStatus?(remoteId: string): Promise<PublicationStatus>;
  updateMetadata?(req: UpdatePublicationRequest): Promise<void>;
  fetchAnalytics?(req: AnalyticsRequest): Promise<PlatformAnalytics>;
  revoke?(req: RevokeRequest): Promise<void>;
}
```

Capabilities 至少包括：

- DIRECT_PUBLISH
- CONFIRM_TO_PUBLISH
- UPLOAD_DRAFT
- EXPORT_PACKAGE
- SCHEDULING
- THUMBNAIL
- CAPTION / DESCRIPTION
- ANALYTICS
- DELETE_REMOTE
- UPDATE_METADATA
- AIGC_DISCLOSURE

## 42.3 产品体验

UI 根据 Capability 显示不同动作，而不是所有平台都显示“自动发布”：

```text
P1 → Publish Now / Schedule
P2 → Review & Confirm Publish
P3 → Send to Draft / Open in Platform
P4 → Export Package / Send to Phone
```

P4 Export Package 可包含：

- 已适配画幅与编码的视频
- cover / thumbnail
- title
- caption / description
- hashtags
- disclosure text
- platform checklist

Mobile App 后续 MUST 能承担可靠 Handoff：Web 制作完成 → Send to Phone → App 下载/保存素材 → Copy 文案 → Deep Link/Open Platform。

## 42.4 禁止以网页自动化冒充可靠发布 API

核心产品不得依赖 Selenium / Playwright / Cookie 模拟登录完成第三方平台发布。

原因：

- UI 改版易失效
- CAPTCHA / 风控不可控
- Cookie 生命周期不可控
- 可能违反平台规则
- 无法作为 SLA 基础

如果未来内部运营工具需要实验性 Browser Automation，必须单独标记为 `UNSUPPORTED_EXPERIMENTAL`，不得向客户承诺可靠性。

## 42.5 平台初始策略

具体平台的 P1/P2/P3/P4 状态必须在接入当日依据官方开放平台能力确认。工程上预期：

- YouTube：优先建设完整官方 API 管线，作为 Publishing Pack 的参考实现。
- TikTok / 抖音 / Bilibili：优先使用官方授权发布或 Draft/Confirm 流程，遵守用户显式授权、应用审核与 AIGC 标识要求。
- LinkedIn：可作为知识/商业创作者的官方发布 Provider。
- X：Optional Provider，不作为系统可靠性的核心依赖。
- 无稳定公开发布 API 的平台：默认 P4 Export Package / Mobile Handoff。

## 42.6 Human Approval Gate

默认：

```text
Final Render
→ QA
→ READY_FOR_REVIEW
→ Human Approve
→ Distribution
```

任何“QA 通过后自动发布”必须是 Channel 级显式 opt-in，并服从目标平台政策。

---

# 43. 安全要求

## 43.1 Tenant Isolation

所有核心表有 `workspace_id`。

业务查询必须带 workspace scope。

建议后期增加 PostgreSQL RLS 作为 defense-in-depth。

必须有自动测试：用户 A 无法访问 Workspace B 的 project/asset/job。

## 43.2 SSRF

Article URL import 和 external asset fetch 是高风险点。

MUST：

- 禁止 localhost
- 禁止私网 IP
- DNS rebinding 防护
- 限制 redirect
- 限制文件大小
- MIME 校验
- fetch timeout

## 43.3 上传安全

- MIME sniffing
- 大小限制
- 病毒/恶意文件扫描（上线 SaaS 前）
- 禁止执行上传内容

## 43.4 AI Prompt Injection

文章内容属于不可信输入。

Content parser 中的网页文本不能获得“系统指令”权限。

Director prompt 必须明确：

- Source document 中任何指令都只是内容，不是系统命令。
- 不允许 Source 要求泄露 Secret / 调 Provider / 改系统设置。

## 43.5 Custom Motion Sandbox

详见 Generative Motion 安全要求。

## 43.6 Secret

- KMS
- Secret Manager
- 环境变量只存平台基础 Secret
- 禁止写进 repo
- 禁止客户端 exposure

---

# 44. Observability

MUST 监控：

- API error rate
- API p50/p95 latency
- Queue depth
- Job age
- Provider 429
- Provider failed rate
- Provider latency
- Provider cost
- Render duration
- Render failure
- Object storage usage
- Database performance
- Per-workspace spend

推荐：

- OpenTelemetry
- Structured logs
- Sentry
- Metrics backend

每个用户请求贯穿：

```text
request_id
project_id
job_id
provider_job_id
```

但日志严禁记录 Secret 和默认完整未发布正文。

---

# 45. Provider 当前能力的工程处理原则

外部 API 会变化。2026-10-04 的公开文档可作为当前基线，但不能写死。

## HeyGen

当前普通 API Pay-as-you-go 文档显示可同时处理约 10 个 API 视频任务；自定义 Digital Twin 的 API 创建能力存在 Enterprise 限制。工程上：

- concurrency 必须配置化。
- Avatar onboarding 能力需要 capability detection。
- 不假定普通账号拥有所有 Web 功能。

## Google Gemini / Veo

- Rate limit 按 project / tier / model 变化。
- Veo 生成视频公开文档当前提示生成结果服务器保留约 2 天。
- Paid Gemini API 的数据使用条款与 ZDR 配置应按当前官方规则处理。

工程上：

- 生成完成立即将 output 拉回我们的 Object Storage。
- 不依赖 Provider URL 长期存储。

## Runway

- 并发随 usage tier 增长。
- 超出并发可出现 THROTTLED 状态。
- ephemeral upload URL/URI 有时效。
- API 版本变化需要 Adapter 层吸收。

## ElevenLabs / Voice Clone Provider

- TTS 支持 timestamp / alignment 类能力，适合 Master Narration。
- Voice Provider 可支持 Instant Voice Clone 与 Professional Voice Clone，但具体训练时长、验证流程、共享权限和套餐限制视 Provider 当期规则。
- Professional Voice Clone 应视为高价值 Creator Identity 资产，而不是普通项目 Asset。
- Provider 若要求本人验证，产品必须保留该流程，不得绕过。
- Enterprise 可存在更严格的 Zero Retention / data handling 模式。
- Voice Clone 训练素材本身由于功能需要可能需要 Provider 持久化；“不用于训练”与“零保留”必须分别展示。

## Remotion

- Player 可在 React App 中动态预览参数化视频。
- Lambda 适合高并发服务端渲染，但受云平台并发/执行时长等约束。

结论：

> Provider capability、limit、price、retention 全部视为运行时/配置数据，而不是产品常量。

---

# 46. Provider Capability Registry

建议数据库/配置中心维护：

```text
provider
model
modality
supports_text_to_video
supports_image_to_video
supports_reference_image
supports_first_last_frame
supports_transparency
supports_timestamps
supports_webhook
max_duration
aspect_ratios
resolutions
concurrency_limit
rate_limit_policy
cost_formula
retention_policy
regions
privacy_tier
updated_at
```

可先手工维护，后期自动同步。

---

# 47. 法务与商业化约束

MVP 内部使用与对外 SaaS 是两件事。

正式对外收费前 MUST：

- 重新核查所有 Provider 当前 Terms。
- 确认 API 嵌入/白标/最终用户访问是否允许。
- 对需要 Enterprise/Integrated Application agreement 的 Provider 签订协议。
- 明确数字人、声音克隆的授权与 Consent。
- 建立 Content Policy / Abuse Policy。
- 提供 Privacy Policy / Terms / DPA（按目标市场）。

不要假定“能拿到 API Key = 可以任意转售 Provider 服务”。

---

# 48. 推荐技术栈

## Frontend Web

- Next.js
- React
- TypeScript
- Tailwind
- Remotion Player
- TanStack Query
- Zustand 或等价轻状态库（只存 UI/local ephemeral state）

## API

- Node.js + NestJS（或 Fastify-based modular backend）
- TypeScript
- REST v1
- OpenAPI
- Zod shared contracts

## Database

- PostgreSQL
- Prisma 或 Drizzle（二选一，统一使用）

## Queue

- Redis
- BullMQ

## Storage

- Cloudflare R2 或 AWS S3
- Signed URLs
- CDN

## Render

- Remotion
- AWS Lambda / dedicated render worker
- FFmpeg

## Analytics

MVP：Postgres aggregates

Scale：ClickHouse

## Infrastructure

- Docker
- CI/CD
- IaC（后期 Terraform/Pulumi）

---

# 49. Monorepo 结构

推荐：

```text
/apps
  /web
  /api
  /worker
  /render-worker
  /desktop          # 后期
  /mobile           # 后期

/packages
  /contracts        # Zod/JSON schemas/API DTO
  /sdk              # Client SDK
  /domain           # domain types/rules
  /db
  /auth
  /scene-schema
  /director
  /narrative
  /visual-grammar
  /scene-components
  /remotion-core
  /providers
    /llm
    /avatar
    /voice
    /video
    /image
    /publishing
  /storage
  /usage
  /ui
  /testing
```

依赖方向 MUST 控制：

```text
apps → packages
providers → contracts/domain
web → sdk/contracts

禁止 domain 依赖 Next.js
禁止 domain 依赖具体 Provider SDK
```

---

# 50. 环境配置

不要把模型参数散落在 `.env`。

`.env` 只用于基础 Secret/connection：

```text
DATABASE_URL
REDIS_URL
OBJECT_STORAGE_*
KMS_*
PLATFORM_PROVIDER_KEYS
```

Provider model routing、价格、并发策略应在配置表/管理后台管理。

---

# 51. Testing Strategy

## Unit

- Visual Grammar mapping
- Scene Graph validation
- Director rule layer
- Provider router
- cost calculation
- permission checks
- edit patch/revision

## Contract

每个 Provider Adapter 使用 fixture/mock 做 contract tests。

## Integration

- DB + Queue + Worker
- upload intents
- render pipeline
- webhook idempotency

## E2E

至少覆盖：

```text
Create project
→ import article
→ generate narrative
→ generate storyboard
→ edit scene
→ preview
→ final render with mocked external providers
→ history restore
```

Production Provider smoke test 单独运行，不作为普通 CI 必须项。

## Multi-tenant security tests

必须测试：

- Cross-workspace read denied
- Cross-workspace write denied
- Signed URL scope
- Provider credential isolation

---

# 52. AI 输出必须结构化

Narrative / Director / AI Edit 默认输出 JSON Schema，而不是自由文本后解析。

必须：

- schema validation
- retry/repair
- model output version
- prompt version

保存：

```text
prompt_template_version
schema_version
model_id
```

这样未来可以复现问题。

---

# 53. AI Director 的可解释性

不要保存或暴露模型私密 Chain of Thought。

但可以保存短的决策摘要：

```text
“该段包含时间序列与双资产比较，因此选择 DUAL_LINE_CHART；数据来自 source_12。”
```

用于：

- Debug
- User explanation
- QA

---

# 54. 审批与 Lock

Scene 支持：

```text
locked_by_user
approved
needs_review
```

用户 Lock 后：

- AI Director 重新生成项目不得修改该 Scene。
- 如果确实冲突，Director 返回 warning。

未来团队支持：

- Reviewer approval
- Final approval gate

---

# 55. 失败降级策略

系统不能因为一个 Veo Scene 失败就让整部片永久失败。

每个 Scene 可以：

```text
Primary Strategy
↓ fail
Fallback Provider
↓ fail
Fallback Static Visual
↓
Needs Review
```

例如：

```text
Veo AI Video
→ Runway
→ Generated Image + Ken Burns motion
→ Text/Motion placeholder
```

Final Render 前如果存在 unresolved required Scene，提示用户。

---

# 56. 内容来源与可信度

财经/知识视频特别要求：

- 每个关键 Claim 可绑定 Source。
- Scene 可以绑定一个或多个 Claim。
- Source 可显示在画面或 Description。
- AI 不得伪造来源。
- Source URL、文档 title、访问时间等应结构化保存。

未来可做：

- Citation overlay
- Source list auto-generated

---

# 57. 组件主题系统

每个 Scene Component 不应该写死颜色/字体。

使用 Design Tokens：

```text
font.heading
font.body
color.background
color.foreground
color.accent
color.positive
color.negative
spacing.*
radius.*
motion.duration.*
motion.easing.*
```

Creator Profile 选择/保存 Theme。

不同 Component 通过同一 Token 体系保持品牌一致。

---

# 58. Subtitle 系统

MVP MUST：

- 自动字幕
- Word/phrase timing
- 修改文字
- 调断句
- Style preset
- Burn-in optional
- SRT/VTT export

字幕也是 Scene Graph / Project 的结构化数据，不应只存在最终 MP4。

---

# 59. Music / Audio

MVP：

- 1 条 BGM track
- Voice track
- Scene media audio
- 简单音量
- ducking
- fade in/out

不要做完整 DAW。

Music Asset 必须保存授权/license metadata（如果使用第三方素材）。

---

# 60. Article Publish Automation（后期但预留）

用户自己的 CMS 发布文章后：

```text
CMS Publish
→ Webhook
→ Create Project
→ Import Article
→ Generate Narrative
→ Generate Storyboard
→ Notify user Draft ready
```

MUST 在 Project API 里支持机器创建和 idempotency，这样后续 Webhook 不需要新业务模型。

---

# 61. Notification

MVP Web：

- in-app notification
- job failure notification
- render completed

后续 Mobile/Desktop：

- Push notification
- System notification

Notification 统一在后端事件层，不写死 Web toast。

---

# 62. 搜索与资产库

后期：

- 搜 Project
- 搜 Scene narration
- 搜 Source
- 搜 Asset
- 搜 Component

MVP 可以 PostgreSQL FTS，未来专用搜索。

---

# 63. 桌面与手机不重复后端业务逻辑

Codex 实现必须满足以下检查：

如果未来新增 `/apps/mobile`：

- 不需要复制 Director 代码。
- 不需要复制 Provider 逻辑。
- 不需要复制权限逻辑。
- 不需要复制成本/credit 逻辑。
- 不需要重新设计 Project/Scene 存储。

只需要：

- 使用 `packages/sdk`
- 处理 UI/OS 交互
- 本地缓存
- 本地通知/文件系统

这就是本项目的多端验收标准。

---

# 64. Web MVP 具体范围

第一版必须聚焦，不做完整 SaaS。

## Phase 0：Foundation

MUST 完成：

- Monorepo
- API 独立服务
- PostgreSQL
- Redis/BullMQ
- Object Storage
- Auth
- Workspace
- Shared contracts
- OpenAPI
- SDK
- Project/Scene/Asset data model
- Revision model
- Event Log
- Provider interface skeleton

验收：Web Client 所有项目业务通过 API SDK 完成。

## Phase 1：Article → Scene Graph

MUST：

- Create Project
- Import URL / paste text
- ContentDocument
- Narrative Engine
- Script view/edit
- Director v0.1
- Visual Grammar v0.1
- 15～20 Standard Scene Components
- Scene Graph
- Storyboard UI

此阶段允许 Provider 使用 mock，但必须有真实 LLM integration。

## Phase 2：Preview + AI Native Editor

MUST：

- Remotion Player
- Scene Editor
- Natural language edit plan
- Apply/Undo
- Lite Timeline
- Project Versions
- Intent History
- Draft render

## Phase 3：真实 Provider

接入：

- HeyGen Avatar
- Voice Provider（TTS + VoiceIdentity；Voice Clone 可按 Provider readiness 开启）
- Veo
- Runway

MUST：

- Provider queues
- retry
- fallback
- cost ledger
- result fetch to own storage
- Provider capability registry

## Phase 4：Final Render

MUST：

- Master narration
- timing alignment
- final asset generation
- Remotion server render
- FFmpeg finalization
- MP4/SRT/VTT
- Manifest
- final version snapshot

目标：可以稳定生成一条 8～12 分钟财经视频。

## Phase 5：SaaS 基础

- Platform Credits
- BYOK
- Storage quota
- Billing
- Team roles
- Privacy modes
- Provider settings UI

## Phase 6：Post-MVP Packs

V1 Article → Long Video 达到稳定生产质量后再进入。Pack 必须通过 Extension Points 接入，不得反向污染 Core。

优先：

- Shorts Pack：Content Atom / 9:16 derivative Scene Graph / smart re-layout
- Publishing Pack：YouTube 官方 API 作为 reference implementation，其余平台按 Capability Tier 接入
- Social Visual Pack：Carousel / 信息图
- Text Pack：Thread / Newsletter / 平台文案
- Analytics Director Pack

原则：短视频不能只是机械裁切长视频，应允许从同一 Content Core 重新编导。

## Phase 7：Desktop / Mobile

Desktop：

- Tauri/Electron shell
- same SDK
- file system integration
- desktop notifications
- local cache

Mobile：

- React Native
- same SDK
- review/approve/light edit
- push notifications

禁止为了桌面/手机更改核心 backend domain 模型，除非是普遍合理的 API 演进。

---

# 65. MVP Scene Component 优先级

第一批优先实现：

1. HOST_FULL
2. HOST_SIDE
3. BIG_NUMBER
4. KPI_GRID
5. LINE_CHART
6. DUAL_LINE_CHART
7. BAR_CHART
8. SPREAD_AREA_CHART
9. YIELD_CURVE
10. TIMELINE
11. CAUSAL_FLOW
12. CAUSAL_LOOP
13. PROCESS_FLOW
14. COMPARE_SPLIT
15. MAP_STATIC
16. MAP_FLOW
17. NEWS_HEADLINE
18. SOURCE_CARD
19. QUOTE_CARD
20. PERSON_PROFILE
21. COMPANY_PROFILE
22. DOCUMENT_HIGHLIGHT
23. IMAGE_FULL
24. REAL_BROLL
25. AI_VIDEO
26. CHAPTER_TITLE
27. SUMMARY
28. CUSTOM_MOTION

第二批：

- CANDLE_CHART
- POLICY_PATH
- SUPPLY_CHAIN
- TRADE_ROUTE_MAP
- SCENARIO_TREE
- IMAGE_COLLAGE
- RANKING_BAR
- NETWORK_DIAGRAM

---

# 66. Web UI 的“复杂度预算”

不要让第一版界面像 Premiere。

默认只显示：

- Preview
- AI Director command
- Scene list
- 当前 Scene settings

Timeline 是二级入口。

高级 Provider 设置只在 Settings / Advanced 中出现。

用户无需理解：

- API endpoint
- Model ID
- Provider concurrency
- Prompt engineering

除非进入 Advanced/Developer Mode。

---

# 67. 内部 Admin 后台

正式运营前需要最小 Admin：

- Users
- Workspaces
- Projects
- Queue
- Failed Jobs
- Provider status
- Provider spend
- Usage
- Credits
- Storage
- Abuse/Moderation flag
- Manual retry

Admin 权限严格分离，不复用普通用户角色。

---

# 68. 成本保护

必须防止一个 bug 烧掉大量 API 费用。

实现：

- per-job max cost
- per-project budget
- workspace daily spend cap
- provider daily spend cap
- circuit breaker
- retry max
- idempotency
- “Final Render requires explicit action” 默认

Provider Router 在超预算时：

- 降级模型
- 提示用户
- 不允许无限重试

---

# 69. 状态与幂等

所有昂贵操作必须带 deterministic generation key，例如：

```text
hash(
  scene revision
  + provider config
  + prompt
  + source asset checksums
  + output profile
)
```

重复请求先查已有 succeeded generation。

用户双击 Generate 不得产生两个付费任务。

---

# 70. 性能目标（初始）

这些是产品目标，不是第三方 Provider SLA：

- 普通 API p95 < 500ms（不含外部生成）
- Scene patch UI optimistic response < 150ms perceived
- Project 页面首屏 < 3s
- Remotion Preview 修改标准 Scene 后尽量 < 500ms 可见更新
- 上传采用直传
- 大 Project 列表分页/虚拟化

外部生成任务只提供进度状态，不阻塞 UI。

---

# 71. 可靠性

MUST：

- Worker crash 后 Job 可恢复
- Provider webhook 重放不会重复扣费/重复生成记录
- API 请求幂等
- Render 失败可重试
- Asset generation 成功后立即持久化结果
- Provider 临时 URL 到期不影响已完成项目

---

# 72. 数据备份

Production：

- PostgreSQL automated backup
- PITR
- Object Storage versioning/replication 按成本选择
- 删除策略与 backup retention 区分

需要记录恢复流程，不只是“有备份”。

---

# 73. SaaS 套餐与 AI Compute 设计

## 73.1 软件价值与模型成本必须分离

商业模型原则：

> Subscription = 使用 Creator Video OS 的软件价值。
> AI Compute = Managed Credits 或 BYOK。

禁止把普通订阅定义成“无限生成”。生成式视频与 Digital Twin 的边际成本可能显著高于 LLM、渲染和存储；重度用户不得通过固定低价无限消耗 Provider 成本。

支持产品层级：

```text
Free / Trial
Creator
Pro
Studio
Enterprise
```

但价格不得硬编码在业务逻辑中。

## 73.2 Quota / Entitlement 维度

- Software Plan
- Managed Video Credits
- Storage
- Team seats
- Creator Identities / Channels
- BYOK
- Privacy mode
- Render priority
- 4K
- Analytics
- Pack Entitlements
- Custom Motion budget
- Provider-specific premium feature entitlement

## 73.3 Managed Credits

用户看到统一的 `Video Credits / Compute Credits`，而不是强迫理解 Veo/Runway/HeyGen 各自 token/秒数。

Router 负责将一次操作估算为：

```text
Estimated Platform Cost
+ retry/failure reserve
+ infrastructure reserve
+ platform margin
= User Credit Cost
```

必须保留足够安全边际覆盖：

- Provider 失败重试
- 重生成
- 支付手续费
- 云队列/渲染/存储/带宽
- Provider 价格变化
- 滥用风险

AI 用量不能默认按 Provider 成本原价透传。

## 73.4 BYOK

重度创作者/企业可使用自己的 HeyGen、Voice、Video、LLM Provider credentials。

BYOK 用户仍支付软件订阅，因为他们购买的是：

- Director
- Scene Graph
- Visual Grammar
- Components
- Editor
- Workflow
- History / Storage / Collaboration

而不是第三方 Token。

## 73.5 成本控制规则

- Draft 默认不得调用高成本 Final Provider。
- Generative Video 秒数必须有 Workspace / Project / Render Mode budget。
- Avatar 占比、AI Video 占比可作为 cost-aware Director constraint。
- Preview / Draft 允许 placeholder / low-cost provider。
- Final Render 前显示成本估算。
- Cost Ledger 必须可细化到 Project / Scene / Provider / Operation。

---

# 74. Enterprise 预留

后续：

- SSO/SAML
- SCIM
- Audit export
- Approval workflow
- Dedicated credentials
- Customer-managed storage
- Regional residency
- ZDR provider route
- Dedicated compute

当前 MVP 不必实现，但数据库/Workspace 设计不得阻断。

---

# 75. 不允许的实现捷径

Codex MUST NOT：

1. 把所有 Project 状态塞进前端 localStorage。
2. 把 Scene Graph 只存在一个大 JSON 且无 Scene revision。
3. 把 HeyGen/Veo API 调用直接写进 Next.js page/component。
4. 让客户端持有平台 Provider Secret。
5. 把 Provider output URL 当永久文件 URL。
6. 用户每改一次 Draft 都触发昂贵 AI Video。
7. 把整篇私密文章默认发送给所有 Provider。
8. 把最终 Timeline 作为唯一 Source of Truth。
9. 为 Web 写一套 API，未来 Mobile 再重新写业务逻辑。
10. 依赖 Provider 当前模型 ID 作为数据库核心枚举。
11. 对数据图表使用 AI 虚构数值。
12. 用无限自动 retry 处理付费 generation。
13. 删除 Project 时立即不可恢复地物理删除所有内容。
14. 把 API Key 写入日志或错误返回。
15. 让 Custom Motion AI 代码在主 API 进程中无隔离执行。

---

# 76. Codex 实现规则

每个 Phase：

1. 先更新 schema/contracts。
2. 写 migration。
3. 写 domain/service。
4. 写 API。
5. 写 SDK。
6. 写 Web UI。
7. 写 tests。
8. 写 docs。

不要先在 UI 临时写一套逻辑，后面再“抽出来”。

所有 TODO 必须写清：

- why
- dependency
- intended interface

如果 Provider 无真实凭据：

- 使用明确的 Mock Adapter
- UI 标示 MOCK
- 不伪造“真实生成成功”的测试结果

---

# 77. Definition of Done — Web MVP

当以下条件全部满足，才算 Web MVP：

1. 用户可以登录并进入 Workspace。
2. 可以创建 Channel/Creator Profile。
3. 可以从 URL 或粘贴文本创建 Project。
4. 系统生成 Narrative Script。
5. 系统生成结构化 Scene Graph。
6. 至少 15 个高质量 Standard Scene Components 可工作。
7. Remotion Player 可实时 Preview。
8. 用户可自然语言要求修改 Scene/Storyboard。
9. 用户可手动 reorder/trim/delete/replace Scene。
10. 有 Lite Timeline。
11. 有 Undo/History/Version。
12. 有资产上传和 Object Storage。
13. 有至少一个真实 Avatar Provider。
14. 有至少一个真实 Voice Provider。
15. 有至少一个真实 AI Video Provider。
16. 外部任务异步执行并显示状态。
17. Provider 结果会回收到自己的 Storage。
18. 能输出 1080p 完整 MP4。
19. 能输出字幕。
20. 能生成 Project Manifest。
21. 有 per-generation cost 记录。
22. 有 Workspace 数据隔离测试。
23. 后端 API 可独立于 Web 被调用。
24. Shared SDK 可以被未来 Native Client 使用。

---

# 78. Definition of Done — Multi-Client Readiness

即使 Desktop/Mobile 尚未开发，Web 阶段结束时也必须满足：

- 所有业务能力有 REST API。
- API 有版本。
- Auth 可以支持 Native token flow。
- 所有 DTO 有 shared schema。
- Asset 上传流程不依赖 browser-only logic。
- Job progress 有通用事件协议。
- Project/Scene 使用 server revision。
- Business logic 不依赖 Next.js。
- Provider logic 不依赖 Web。
- Render 在 server/cloud。
- Notification 由 backend event 产生。

如果以上任意一项不满足，不得宣称“后续可以直接做 App”。

---

# 79. 推荐开发顺序（给 Codex）

最先做的不是 HeyGen 按钮，而是：

```text
1. Monorepo + shared contracts
2. Auth + Workspace
3. Project/Scene/Asset DB schema
4. Scene Graph schema v0.1
5. Edit revision + history
6. Object Storage upload
7. Workflow/Queue
8. Provider interfaces
9. Content Normalizer
10. Narrative Engine
11. Visual Grammar
12. Director Engine
13. Remotion component system
14. Web storyboard/editor
15. Draft preview
16. Provider integrations
17. Final render
18. Credits/BYOK
```

原因：如果先接一堆 Provider，再补 Scene Graph，最终很容易变成脆弱的 API 串联脚本。

---

# 80. 推荐首个端到端样例

用一篇财经文章作为 Golden Fixture：

> “为什么法国国债风险突然升温？”

目标约 8～10 分钟。

至少包含：

- Host Hook
- Big Number
- 法国/德国收益率对比图
- Spread chart
- Timeline
- Causal Loop
- Map
- News Headline
- Source Card
- Quote
- Custom Motion
- 少量 AI Video
- Summary

每次 Director/Component 变更都用此 Fixture 做回归测试。

---

# 81. 产品长期护城河

不是 API 数量。

长期资产是：

```text
Narrative Engine
+
Director Engine
+
Visual Grammar
+
Scene Component Library
+
Custom Motion Library
+
Creator Profile
+
Edit/Intent Data
+
Scene Performance Dataset
+
Provider Router
```

底层模型可以被替换。

---

# 82. 最终产品体验目标

用户完成研究和文章后：

```text
Paste URL
↓
AI 已读取文章和 Sources
↓
建议 9:42 视频
↓
43 Scenes
- Avatar 8
- Charts 14
- Motion 8
- Map 2
- Sources 5
- AI Video 4
- Summary 2
↓
Generate Draft
↓
用户说：
“开头不够抓人”
“第12个图太复杂”
“结尾不要数字人”
↓
Apply
↓
Render Final
↓
16:9 Long Video
9:16 Shorts
Thumbnail
Title
Description
Chapters
Sources
```

产品做对之后，用户的评价不应该只是：

> “比 Premiere 好用。”

而应该是：

> “我基本已经不需要自己剪视频了。”

---

# Appendix A：当前官方能力基线（2026-10-04）

**注意：以下只作为 Provider Adapter 开发时的参考，不得硬编码。上线前必须再次核验。**

1. HeyGen API Pay-as-you-go：官方帮助中心说明 API 可独立购买 credits，API PAYG 当前视频并发约 10；自定义 Digital Twin 的部分 API 能力需要 Enterprise。  
   https://help.heygen.com/en/articles/10060327-heygen-api-pricing-explained

2. HeyGen 处理时间：API PAYG 当前文档列出 10 concurrency；Avatar Studio 每 1 分钟视频通常约需 10 分钟生成，实际可能更快或更慢。  
   https://help.heygen.com/en/articles/9655503-heygen-video-processing-times

3. HeyGen Privacy：公开政策说明其会处理用户文本、声音、图片、视频等输入；删除后的灾备备份可能继续保留一段时间。Enterprise 页面公开列出 Zero Data Retention 和 no-training 选项。  
   https://www.heygen.com/privacy  
   https://www.heygen.com/enterprise

4. Google Gemini API Rate Limits：限额按 project 而不是 API key 应用，并随 model / tier 变化。  
   https://ai.google.dev/gemini-api/docs/rate-limits

5. Veo 3.1 API：生成视频当前公开文档说明服务器存储期限约 2 天，因此生成结果必须及时拉回平台对象存储。  
   https://ai.google.dev/gemini-api/docs/veo

6. Gemini API Paid Services：当前条款说明付费服务不会使用 prompts/responses 改进 Google 产品，并有单独的数据处理/ZDR 文档。  
   https://ai.google.dev/gemini-api/terms  
   https://ai.google.dev/gemini-api/docs/zdr

7. Runway API Usage Tiers：并发按 tier 配置；超出并发的任务可进入 THROTTLED；Enterprise 可申请更高/保证并发。  
   https://docs.dev.runwayml.com/usage/tiers/

8. Runway Ephemeral Upload：当前文档说明 ephemeral URI 有约 24 小时有效期，因此不能作为永久 Asset URL。  
   https://docs.dev.runwayml.com/assets/uploads/

9. Runway Model Router：可按 cost/latency/quality 选择模型，但平台自身仍应保留跨 Provider 的 Router。  
   https://docs.dev.runwayml.com/model-routers/

10. Remotion Parameterized Rendering / Player：支持 JSON/props 参数化视频以及 React App 中实时预览。  
    https://www.remotion.dev/docs/parameterized-rendering  
    https://www.remotion.dev/docs/player

11. Remotion Lambda：可用于可扩展的云端渲染。  
    https://www.remotion.dev/docs/lambda

12. ElevenLabs TTS with timestamps：可返回字符级 timing，用于 narration 与画面同步。  
    https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps/

13. ElevenLabs Zero Retention：当前公开为 Enterprise 能力，并非所有产品/调用都支持。  
    https://elevenlabs.io/docs/eleven-api/resources/zero-retention-mode

---

# Appendix B：首个 Repository README 要明确写出的架构约束

建议把以下文本放进仓库根 README / AGENTS.md，防止未来 Codex 偏离：

```text
ARCHITECTURE RULES

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

---

# Appendix C：首批工程验收清单

## Architecture

- [ ] Monorepo exists
- [ ] Web and API are separate apps
- [ ] Shared contracts package exists
- [ ] OpenAPI generated
- [ ] SDK usable independently
- [ ] PostgreSQL migration system works
- [ ] Redis/BullMQ works
- [ ] Object Storage direct upload works

## Domain

- [ ] Workspace
- [ ] Channel
- [ ] Creator Profile
- [ ] Project
- [ ] Scene
- [ ] Asset
- [ ] Version
- [ ] Edit Event
- [ ] Job
- [ ] Provider Generation

## AI

- [ ] ContentDocument schema
- [ ] NarrativePlan schema
- [ ] SceneGraph schema
- [ ] Visual Grammar mapping
- [ ] Director structured output
- [ ] AI Edit change plan

## Video

- [ ] Remotion Player
- [ ] Standard Scene library
- [ ] Draft preview
- [ ] Master narration
- [ ] Subtitle timing
- [ ] Final render
- [ ] Manifest

## Reliability

- [ ] idempotency
- [ ] retry policy
- [ ] provider concurrency limiter
- [ ] result persistence
- [ ] failure fallback
- [ ] cost ledger

## Security

- [ ] tenant isolation tests
- [ ] KMS secret encryption
- [ ] signed upload
- [ ] SSRF protection
- [ ] no secrets in logs
- [ ] custom motion sandbox design

## Multi-client readiness

- [ ] no domain logic in web-only components
- [ ] auth flow supports native clients
- [ ] revision-based edits
- [ ] realtime event protocol
- [ ] shared SDK
- [ ] no browser-only asset model


# 83. Provider Native Fallback

API First 不代表必须复制每个 Provider 的全部原生编辑能力。

MUST 设计“Native Fallback / External Asset Round-trip”：

```text
Scene
→ Advanced actions
→ Open provider / Show provider job reference（能力允许时）
→ 用户在原生平台完成特殊处理
→ Import result
→ 绑定回原 Scene Asset
```

要求：

- Imported result 也必须进入我们的 Asset 管理。
- Scene Graph 继续是 Source of Truth。
- 外部修改不得导致项目脱离版本历史。
- Provider 不支持 deep link 时，至少提供 Job ID/必要说明和“上传替换结果”。

产品原则：只重做高频且与核心工作流相关的 Provider UI，不为少数高级功能复制整个第三方编辑器。

---

# 84. 素材获取、版权与授权元数据

完整视频工作流不仅包含 AI 生成素材，还包含真实素材。

Asset origin 至少支持：

```text
USER_UPLOAD
USER_LIBRARY
SOURCE_DOCUMENT
LICENSED_STOCK
PUBLIC_SOURCE
GENERATED
PROVIDER_IMPORT
```

每个可发布素材 SHOULD 保存：

```text
origin
source_url?
provider?
author?
license_type?
license_reference?
attribution_required
attribution_text?
usage_restrictions?
acquired_at
```

MUST：

- 不把“网上找到的图片”默认为可商用。
- 真实新闻/媒体素材与 AI 生成素材在 metadata 中可区分。
- 对需要 attribution 的素材，在最终 Description/Sources 中可自动生成署名。
- 用户上传素材默认声明由用户拥有或获得使用权限；对外 SaaS 时 Terms 中明确责任边界。

未来可加入 Licensed Stock Provider，但仍通过 Asset Acquisition Adapter 接入。

---

# 85. Source Snapshot 与事实证据

对于新闻标题、研究报告、网页证据，建议保存 Source Snapshot 元数据：

```text
source_id
url
title
publisher
author?
published_at?
retrieved_at
content_hash
excerpt_reference
snapshot_asset_id?
```

目的：

- 防止网页后续修改导致项目无法追踪。
- 能知道某个 Scene 在制作当时依据什么信息。
- 生成 Source Card / Description。

如果保存网页截图或全文，必须遵循版权和存储策略，不默认永久镜像所有网页内容。

---

# 86. 发布前 QA Pipeline

正式视频不是“Render 成功 = 可发布”。

Final Render 后 MUST 经过自动 QA：

## Technical QA

- 文件可读取
- duration 与 manifest 合理一致
- resolution / fps 正确
- 无明显黑帧/空白帧异常
- 无缺失 Asset
- 音轨存在
- 音频峰值/响度在配置范围
- Subtitle 时长不越界
- 无超出画布的关键文本（可基于组件安全区检测）

## Content QA

- Scene 数量与 Graph 一致
- 所有 required source bindings 存在
- Factual chart 的数据绑定有效
- 未解决的 placeholder 不允许进入 Final
- 未完成 Provider Job 不允许发布
- 被标记 `needs_review` 的 Scene 阻止自动发布

## AI/Visual QA（SHOULD）

对高价值 Scene / Custom Motion：

- 缩略帧或低帧率抽样
- 检查明显文字溢出、错误布局、素材缺失
- 检查生成视频是否与 visual intent 明显不符

AI QA 只能作为提示，不能取代确定性技术校验。

---

# 87. Human Approval Gate

默认策略：

```text
Generate
→ QA
→ READY_FOR_REVIEW
→ Human Approve
→ Publish / Export
```

MVP 不应默认“文章发布后全自动直接发 YouTube”。

用户可以在未来显式开启：

```text
Auto Publish when QA passes
```

但这是 opt-in，并且可按 Channel 设置。

企业模式可以配置 Reviewer / Approver。

---

# 88. CMS Write-back

对于“文章是唯一内容源”的工作流，系统后期应支持将成片状态写回 CMS。

流程：

```text
Article published
→ Video Project created
→ Video Ready
→ CMS callback
→ Article adds video/player/status
```

Backend SHOULD 预留：

```text
project.external_source_id
project.external_source_type
project.callback_url / integration reference
```

不要让 CMS integration 直接操作内部 DB。

---

# 89. Image / Asset Generation Provider

除 VideoProvider 外，需要显式的 ImageGenerationProvider 与 AssetSearchProvider 抽象：

```ts
interface ImageGenerationProvider {
  capabilities(): Promise<ImageCapabilities>;
  estimate(req: ImageGenerationRequest): Promise<CostEstimate>;
  generate(req: ImageGenerationRequest): Promise<GeneratedAsset>;
}

interface AssetSearchProvider {
  search(req: AssetSearchRequest): Promise<AssetSearchResult[]>;
  resolveLicense(resultId: string): Promise<LicenseMetadata>;
}
```

用途：

- Storyboard still
- Background image
- Concept illustration
- Thumbnail asset
- Licensed stock retrieval

Director 的默认选择顺序仍然是：真实证据/数据/已有资产优先，生成图片不是事实证据的替代品。

---

# 90. 自动发布与分发的幂等

Publishing Job MUST 使用 platform + account + projectVersion + outputAsset 的幂等键。

同一 Final Version 因网络超时重试时，不得重复发布两条 YouTube 视频。

Publication 状态：

```text
DRAFT
QUEUED
PUBLISHING
PUBLISHED
FAILED
DELETED_REMOTE
```

保存 remote_id / remote_url / published_at。

---

# 91. 用户导出与可迁移性

为了降低用户对平台锁定的顾虑，SHOULD 支持导出：

- Final MP4
- SRT/VTT
- Source list
- Project Manifest
- Scene Graph JSON
- 用户上传原始素材（按权限）

未来可提供 Project Bundle。

这不等于导出第三方 Provider 的内部模型资产；只导出用户有权取得的内容。

---

# 92. Extension Architecture：Core + Packs + Marketplace

长期产品结构：

```text
Creator Video OS Core
├── Content Core
├── Narrative Engine
├── AI Director
├── Scene Graph
├── Visual Grammar
├── Creator Identity
├── AI Native Editor
├── Asset / Version / Render Core
└── Extension Runtime
      ├── Shorts Pack
      ├── Publishing Pack
      ├── Social Visual Pack
      ├── Newsletter / Text Pack
      ├── Analytics Director Pack
      ├── Finance Pack
      └── Future Marketplace Plugins
```

第一版可以没有“插件商城”，但 Core 从第一天必须存在稳定 Extension Points。

## 92.1 Output Plugin

```ts
interface OutputPlugin {
  manifest(): PluginManifest;
  analyze(core: ContentCore, ctx: PluginContext): Promise<OutputPlan>;
  generate(plan: OutputPlan, ctx: PluginContext): Promise<Artifact[]>;
  validate?(artifacts: Artifact[], ctx: PluginContext): Promise<ValidationResult>;
}
```

禁止在 Core 中不断添加：

```ts
if (outputType === 'youtube') ...
if (outputType === 'xhs') ...
if (outputType === 'newsletter') ...
```

## 92.2 Plugin 权限与隔离

插件必须声明 Capability：

- read_content_core
- read_project_assets
- create_assets
- create_scene_graph
- provider_access
- distribution_access
- analytics_access
- network_access（如允许）

第三方插件未来必须支持版本、签名、权限提示、资源配额和撤销。

## 92.3 商业模式

产品长期可以形成：

```text
Core Subscription
+ Official Packs
+ Compute Credits / BYOK
+ Marketplace Revenue Share
```

但 V1 禁止为了未来 Marketplace 增加不必要的运行时复杂度；先定义 contracts 和 registry。

---

# 93. Content Core / Content Atom / Channel Recipe（Post-MVP 预留）

未来“研究一次，全平台生产”不能通过多个互相独立的生成器实现。必须从一个平台无关 Content Core 派生。

```text
Original Article / Research
          ↓
      Content Core
          ↓
     Content Atoms
          ↓
    Channel Recipes
          ↓
Long Video / Short Video / Text / Carousel / Newsletter / Platform Outputs
```

## 93.1 Content Core

建议数据：

```text
core_question
core_thesis
key_claims[]
key_facts[]
key_numbers[]
causal_relations[]
entities[]
timeline[]
geography[]
source_evidence[]
story_arcs[]
uncertainties[]
```

V1 的 `ContentDocument + Narrative` 必须可无损演进到 ContentCore，不要求首版一次实现完整多平台编译器。

## 93.2 Content Atom

一篇长文章可以拆成多个可独立传播单元，例如：

- 一个关键数字
- 一个反直觉结论
- 一个因果关系
- 一个问答
- 一个时间线
- 一个市场影响
- 一个可独立成为 Short 的子主题

Shorts Pack 应从 Content Atom 重新编导，而不是只从长视频时间轴机械裁切。

## 93.3 Channel Recipe

Channel Recipe 描述某个平台/内容形式的表达规则，而不是简单“尺寸模板”。

示例：

```text
YouTube Explainer
- 8–12 min
- narrative_depth: high
- charts: high
- avatar_ratio: 15–25%
- sources: visible

Short Insight
- 45–90 sec
- hook < 3 sec
- one core idea
- captions: large
- visual changes: fast

Carousel
- 6–10 slides
- one idea per slide
- portrait
- high information density
```

## 93.4 Channel Fit

未来 Director 可计算“某内容是否值得生成某平台版本”。不得默认一篇文章自动制造所有平台垃圾内容。

输出可以是：

```text
RECOMMENDED
OPTIONAL
NOT_RECOMMENDED
```

并给出原因。

---

# 94. Speech Director

Speech Director 是 Director 的子系统，将“语义意图”翻译为声音表现控制。

输入：

- narration text
- semantic emphasis
- Scene role
- Creator Speech Profile
- Provider capabilities
- target duration

输出：

```text
voice_identity_id
voice_identity_version
speed
energy
tone / style instruction
pauses[]
emphasis_spans[]
pronunciation_overrides[]
expected_duration
```

默认规则示例：

- Hook：更高能量、更快进入重点。
- 复杂概念解释：适度降低语速。
- 关键数字：允许前后停顿和单独 emphasis。
- 引用：与主播主叙述有轻微语气区分。
- 结论：稳定、清晰，避免过度情绪。

Master Narration 生成后，实际 word/segment timestamps 再驱动画面、字幕、Avatar Scene 和 Motion timing。

不得让不同 Provider 的私有 style 参数泄漏到 Scene Graph 核心 schema；需要映射层。

---

# 95. Voice Consent / Security / Lifecycle

声音与 Digital Twin 属于身份敏感资产。

MUST：

- 创建 Voice Clone 前记录 consent / ownership。
- 如果 Provider 要求本人验证，必须保留验证状态。
- 原始训练音频标记 `IDENTITY_SENSITIVE`。
- 非必要不复制 Provider 托管训练素材。
- 临时上传使用 Signed URL / provider ephemeral upload 时遵循最小权限和 TTL。
- 不在普通日志记录原始声音文件 URL、未遮罩 provider secret 或完整敏感 Prompt。
- 用户删除 VoiceIdentity 时必须区分：从我们平台解除引用、请求 Provider 删除、历史 Manifest 审计引用。
- Enterprise/BYOK 可让身份资产尽可能留在客户自己的 Provider account。

SHOULD：

- 支持 VoiceIdentity retirement，而不是直接破坏历史项目。
- UI 展示 Provider retention / zero-retention 能力。
- 支持 pronunciation dictionary 与品牌/人名/财经术语发音词典版本化。

---

# 96. v0.2 增量验收清单

## Scope

- [ ] V1 明确只以 Article → Professional Long Video 为主链路。
- [ ] Shorts / Social / Publishing / Newsletter 不阻塞 V1。
- [ ] Extension contracts 不依赖 Web 前端。

## Creator Identity / Voice

- [ ] CreatorIdentity / AvatarIdentity / VoiceIdentity 数据模型存在。
- [ ] VoiceProvider 不绑死 ElevenLabs/HeyGen。
- [ ] 支持 Platform Managed 与 BYOK Voice 路由。
- [ ] 保存 Voice ownership / verification metadata。
- [ ] SpeechProfile / Speech Director schema 已定义。
- [ ] Master Narration timestamp 仍是最终 Timeline timing 基础。

## Commercial

- [ ] Software plan 与 AI compute ledger 分离。
- [ ] 不存在“无限 Managed AI Generation”硬编码套餐。
- [ ] Final Render 前可估算 Credits / provider cost。
- [ ] BYOK 用户可以绕过平台托管 Provider 用量，但仍通过统一 Router/Adapter。

## Publishing

- [ ] DistributionProvider 有 capability registry。
- [ ] 支持 P1/P2/P3/P4 体验。
- [ ] P4 可生成 Export Package。
- [ ] 核心产品不以 browser automation 作为可靠发布能力。
- [ ] Mobile Handoff 协议已预留。

## Plugin Readiness

- [ ] OutputPlugin / Pack registry contract 已定义。
- [ ] Core 业务没有对 XHS/YouTube/Newsletter 等输出类型硬编码分支。
- [ ] ContentDocument/Narrative 可向 ContentCore 演进。

---

# 97. 最终产品原则总结

工程实现时若出现冲突，按以下优先级决策：

1. Scene Graph / Project 数据完整性
2. 用户隐私和 Workspace 隔离
3. 可恢复、可撤销、可审计
4. 多端 API 一致性
5. Provider 可替换性
6. Draft 成本控制
7. 最终视频质量
8. UI 便利性

不能为了“Demo 看起来更快”牺牲 1～5。

---

**End of v0.2 Specification**
