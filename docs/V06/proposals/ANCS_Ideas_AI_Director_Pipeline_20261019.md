# AI Native Creator Studio｜新增需求思路：AI 导演剪辑流水线 + AI 补拍

<page url="https://app.notion.com/p/3fe29acf24f8814e991de22069b6d921">
<properties>
{"date:日期:is_datetime":0,"date:日期:start":"2026-10-19","url":"https://app.notion.com/p/3fe29acf24f8814e991de22069b6d921","摘要":"素材层只做转写、视频识别、切分和打标签；导演模型统筹排序与风格；多个工具并行生成，可打回重做，局部阻塞不影响全局；用数字人、克隆声音和生成场景做 AI 补拍。","标题":"AI Native Creator Studio｜新增需求思路：AI 导演剪辑流水线 + AI 补拍","状态":"归档","负责Agent":"Prodr","项目":["AI Native Creator Studio"]}
</properties>
<iconMetadata>null</iconMetadata>
<content>
> 已被最终版取代：<mention url="https://app.notion.com/p/3fe29acf24f88138a63af06e1e2899a4" />（2026-10-19）

> 来源：ethan 语音口述，2026-10-19，由 Prodr 整理。状态为待ethan确认。工具名已由 ethan 在 2026-10-19 确认。

## 〇、仓库现状（2026-10-19 Prodr 核对）

> 只读核对 [MuadibUsul/AI\_Native\_Creater\_Studio](https://github.com/MuadibUsul/AI_Native_Creater_Studio)（私有仓库）main 分支，最新提交 <code>8047b59</code>（PR #10 合并，2026-10-15 美东时间）。依据代码与仓库自带文档 <code>README.md</code>、<code>docs/V06/</code>；仓库自己的规则是"脚本模型 / Mock 通过不等于真实供应商通过"，下文照此区分。

- <b>技术栈</b>：TypeScript pnpm monorepo。Web 用 Next.js（<code>apps/web</code>），API 用 Fastify（<code>apps/api</code>），任务与工作流在 Worker（<code>apps/worker</code>，队列为 BullMQ <code>packages/providers/queue-bullmq</code>），实时语音网关（<code>apps/realtime</code>），数据库 PostgreSQL + Redis。探测、镜头切分、预览、终渲染都用 FFmpeg（<code>apps/worker/src/render-plan/</code>）。Remotion 4 只用于特效 / 图解卡图层和旧 Scene 流水线（<code>apps/render-worker</code>、<code>packages/remotion-core</code>），不负责主剪辑。
- <b>产品形态（V6「共看片室」）</b>：上传素材 → AI 剪第一版（作为提案）→ 用户点选 / 拖选，加文字或语音指令 → 原地试改 → 采用或撤回 → 只重渲改动段的预览 → 导出 MP4。界面在 <code>apps/web/src/studio/*</code>，局部重渲在 <code>apps/worker/src/preview-render-handler.ts</code>。
- <b>素材理解</b>：FFmpeg 镜头边界（scene>0.3）、黑场、静音检测、波形（<code>apps/worker/src/source-media-indexer-process.ts</code>）；Deepgram 批量转写，带词级时间戳，可选说话人分离（<code>apps/worker/src/deepgram-speech-recognition.ts</code>，需要密钥）；画面理解用 Claude Haiku 或 Gemini 抽帧，逐帧写镜头说明（<code>apps/worker/src/model-visual-analysis.ts</code>）；节拍检测（<code>packages/domain/src/audio-beats.ts</code>）。
- <b>导演</b>：通用导演 Agent（<code>packages/domain/src/agent-runtime.ts</code>、<code>agent-prompt.ts</code> 版本 director-v8、<code>agent-tools.ts</code> 统一工具目录）。Claude 适配器在 <code>packages/providers/anthropic</code>，默认模型 claude-opus-5-5（<code>.env.example</code>），也能换成 Gemini。工具包括：看时间线、列出 / 检查 / 搜索 / 看素材、批量编辑时间线、自检 <code>review_draft</code>、看成片画面 <code>look_at_timeline</code>，以及特效、讲述、文章、付费生成。
- <b>生成与外部工具</b>：代码特效有 6 个模板，可选让 AI 写特效代码（默认关闭，<code>agent-effects.ts</code>、<code>effect-templates.ts</code>）；讲述配音可用 flite / Fish Audio / Gemini TTS，自动逐句加字幕（<code>agent-narration.ts</code>）；数字人用 HeyGen + Fish Audio 合成用户自己的声音（<code>apps/worker/src/heygen.ts</code>、<code>fish-audio.ts</code>）；生成镜头接 Veo / Seedance，选区重绘接 Runway（<code>gemini-media.ts</code>、<code>ark-media.ts</code>、<code>runway-media.ts</code>）。付费生成走固定流程：报价 → 用户确认 → 预算预留 → 只生成一次 → 结算（<code>apps/worker/src/paid-generation.ts</code>）。
- <b>其他已做</b>：4 个内置风格预设（<code>packages/domain/src/strategies.ts</code>）；蒸馏器，从参考视频学风格（<code>reference-distill.ts</code>、<code>distill-dna.ts</code>）；批注式审片（<code>apps/web/src/review</code>）；连续语音对话（<code>apps/realtime</code>、<code>apps/web/src/voice</code>）；V4 遗留的声音克隆模块（<code>packages/domain/src/voice-clone.ts</code>，有没有接通真实供应商未确认）。
- <b>验证程度</b>：真实 Gemini 已跑通导演和画面理解。真实 Claude 初剪仓库标为"待密钥"，V6-1/3/4/5 的验收用的是脚本导演。HeyGen / Fish Audio 只用本地替身测过协议，真实服务未验证。Veo / Seedance / Runway 适配器已就绪，真实生成要等开通额度（见 <code>README.md</code> 进度表、<code>docs/V06/milestones/V6-7.md</code>）。

## 实现状态对照

| 需求项 | 状态 | 证据 / 说明 |
| --- | --- | --- |
| 转写，生成整套字幕 | 🟡部分实现 | Deepgram 转写已实现（词级时间戳，<code>deepgram-speech-recognition.ts</code>）。没找到"按原声转写一键生成整轨字幕"的工具：导演只能用 <code>add_caption</code> 逐条加（<code>agent-operations.ts</code>），讲述配音才会自动逐句加字幕。 |
| 根据字幕粗理解素材 | 🟡部分实现 | 没有单独的粗理解 / 摘要步骤。导演每轮自己调用 <code>inspect_footage</code>、<code>search_footage</code> 读转写和索引（<code>agent-tools.ts</code>）。 |
| [elorian.ai](http://elorian.ai) 视频识别、打内容标签 | ❌未实现 | 文件名、<code>.env.example</code>、README 的驱动清单里都没有 elorian（私有仓库无法全文检索，这一点未确认）。现有替代是 Claude Haiku / Gemini 抽帧写逐帧镜头说明（<code>model-visual-analysis.ts</code>），不是标签体系。 |
| 切碎、去气口 | 🟡部分实现 | 已有镜头边界、静音、黑场标记（<code>source-media-indexer-process.ts</code>），系统提示要求导演去掉 dead air（<code>agent-prompt.ts</code>）。没有独立的按句切分 / 去气口步骤，也没有口头禅识别。 |
| 只切不判，片段可追溯 | 🟡部分实现 | 理解层只写索引，不做取舍；索引项带素材版本和源时间码（<code>unified-media-index.ts</code>）。但给导演层和工具层共用的"结构化片段清单"中间格式还没有单独定义。 |
| 导演形成整体方案（Claude Opus） | 🟡部分实现 | 导演 Agent 和 Claude 适配器已实现，默认 claude-opus-5-5。导演不产出单独的"整体方案"，而是直接编辑草稿形成提案。真实 Claude 未验证，真实 Gemini 已验证。 |
| 逐段确定执行方案 | 🟡部分实现 | 导演在一轮里分批调用 <code>edit_timeline</code> 逐步执行，没有"逐段方案"的数据结构。 |
| 工具调度：字幕工具 | 🟡部分实现 | 有 <code>add_caption</code> / <code>remove_caption</code> 和讲述逐句字幕；没有原声自动字幕（见第一行）。 |
| 工具调度：文生图 | ❌未实现 | 生成类型只有 AVATAR\_CLIP / VIDEO\_SHOT / VIDEO\_REGION（<code>agent-generation.ts</code>）。图解卡是模板渲染，不是文生图。 |
| 工具调度：文生视频 | 🟡部分实现 | VIDEO\_SHOT 接 Veo / Seedance，VIDEO\_REGION 接 Runway，适配器已就绪。真实生成还没跑通（额度未开），每次都要用户确认报价。 |
| 工具调度：数字人（HeyGen） | 🟡部分实现 | 适配器、授权档案、报价流程都已实现（<code>apps/worker/src/heygen.ts</code>，V6-7），真实 HeyGen 服务未验证。 |
| 工具调度：代码剪辑（Remotion） | 🟡部分实现 | 剪辑和终渲染走纯函数内核 + FFmpeg RenderPlan（<code>packages/kernel</code>、<code>apps/worker/src/render-plan/</code>）；Remotion 只渲染特效和图解卡图层（<code>apps/render-worker</code>）。 |
| 流水线并行（前半段处理时，后半段已在排队） | ❌未实现 | 同一会话同一时间只能有一个进行中的轮次，一轮里的工具调用按顺序执行（<code>agent-runtime.ts</code>）。BullMQ 队列和工作流引擎这些基础设施已有，但没有分段并行调度。 |
| 验收与打回重做 | 🟡部分实现 | 导演用 <code>review_draft</code>、<code>look_at_timeline</code> 自检，可以自己修剪辑；有迭代上限（24）和成本上限（<code>agent-runtime.ts</code>）。付费生成按设计只执行一次、不自动重试（<code>paid-generation.ts</code>），没有"导演不满意就打回工具"的循环。 |
| 局部阻塞不影响全局 | ❌未实现 | 没有分段任务调度。现有"只重渲变化段"（<code>preview-render-handler.ts</code>）属于渲染缓存，不是生产调度。 |
| AI 补拍（数字人 + 克隆声音 + 生成场景） | 🟡部分实现 | 零件都有：HeyGen 数字人 + Fish Audio 用户声音 + Veo / Seedance 生成镜头。没有"发现缺镜头并自动补拍"的流程，必须由用户提出并确认报价；真实服务未验证。 |
| 中间格式（Prodr 补充） | 🟡部分实现 | 统一媒体索引（镜头 / 转写 / 质量 / 视觉事件，带时间码）可以作为基础，但没有正式的片段清单格式。 |
| 打回上限与预算（Prodr 补充） | 🟡部分实现 | 轮次有迭代和成本上限；付费生成需要工作区预算，生成前先预留（V6-7）。没有按段的重试次数。 |
| 拼接一致性检查（Prodr 补充） | 🟡部分实现 | <code>review_draft</code> 查黑场、静音、闪帧、画面空洞、句中剪切、素材重复（<code>agent-review.ts</code>）。没看到色调、数字人形象、响度统一的检查（未确认）。 |
| 成本与时长估算（Prodr 补充） | 🟡部分实现 | 每条视频的 AI 成本计量（<code>previews.ts</code> 中的 <code>projectAgentCost</code>），架构文档有成本模型。视觉分析成本还没入账（<code>docs/V06/milestones/V6-1.md</code> 待办）。 |
| 补拍合规（Prodr 补充） | ✅已实现 | 形象和声音授权记录只增不改，换素材要重新授权；生成产物标记来源 GENERATED（<code>docs/V06/milestones/V6-7.md</code>）。 |
| MVP 主链路：转写、切分、导演出方案、代码剪辑、加字幕（Prodr 补充） | 🟡部分实现 | 链路基本具备，并经过真实浏览器 + FFmpeg 验收。欠缺：原声自动字幕、真实 Claude 验证、去气口。 |
| 风格 / 类型预设 | 🟡部分实现 | 内置 4 个：旅行纪实、节奏卡点、知识解说、高能娱乐，带旋钮，蒸馏器可以学新风格（<code>strategies.ts</code>）。缺口播、教学、游戏解说；配乐、是否允许补拍等参数是否在预设里，未确认。 |
| 通用定位，实拍为核心 | ✅已实现 | 架构明确是通用剪辑软件，导演代码不按类型分支（<code>docs/V06/ANCS_v0.6_Product_Architecture.md</code> 第二、六节；<code>agent-prompt.ts</code>）；素材剪辑是主路径，生成只作补充。 |
| 用户只在开始前交代需求，不参与生产，方案不需确认 | ❌未实现（与现状冲突） | 现在的形态是共看片室：AI 每轮结果都是提案，要用户采用；付费生成必须用户确认报价（<code>agent-prompt.ts</code>、V6-7）。 |
| （第六节）成片后按段提意见、局部重剪 | ✅已实现 | 批注式审片：逐处标记 → 和 AI 讨论 → 一次执行 → 只重渲改动段（V6-4，<code>apps/web/src/review</code>）。 |
| （第六节）导出 PR / 剪映工程文件 | ❌未实现 | 只有成片 MP4 导出，以及旧 Scene Graph 的 JSON 导出（<code>project-exports.ts</code>）。没发现 FCPXML / EDL / 剪映草稿导出。 |

## 一、核心思路

把剪辑拆成三层：<b>素材理解层</b>负责机械处理，不做判断；<b>导演层</b>由大模型决定怎么剪；<b>工具执行层</b>并行生成和交付。另外加一个<b>AI 补拍</b>能力，用来补缺失的镜头。

## 二、流程

### 1. 素材理解（预处理，只切不判）

- 上传视频后，先把语音转成文字，生成整套字幕。
- 根据字幕文本，粗略理解这批素材讲了什么。
- 再用视频理解模型（[elorian.ai](https://elorian.ai)）识别画面细节，给每段视频打上内容标签。
- 把视频切碎，包括去掉气口等。
- <b>边界</b>：这一层不判断哪段有意义、哪段没意义，也不判断怎么排序，只负责切分和标注，每个片段都要可追溯（「哪段是哪段」）。

### 2. 导演（大模型统筹）

- 导演模型（Claude Opus）读完全部片段、字幕和标签，形成整体思路：结构怎么排、怎么剪、用什么风格。
- 再逐段确定执行方案。

### 3. 工具调度与并行执行

- 导演负责调度各种工具，包括字幕工具、文生图、文生视频、数字人（HeyGen），以及用代码剪视频的工具（Remotion）等。
- <b>流水线并行</b>：导演处理前半段的同时，后半段的指令已经发给各个工具排队了。
- <b>验收与打回</b>：工具交付结果，导演不满意就打回重做。
- <b>局部阻塞不影响全局</b>：比如一个 10 分钟的视频，第 2 分钟那段被打回了，第 3 分钟、第 5 分钟等后面的段落照样往前推。辅助生成工具也全部并行。

### 4. AI 补拍

- 实拍经常缺镜头，电影语言上也可能不完整，拍完之后又没有条件再补拍。
- 用 AI 补拍：数字人加克隆声音加生成式场景，补齐缺的镜头。

## 三、Prodr 补充（待讨论）

- <b>中间格式</b>：素材层要输出结构化的片段清单（时间码、字幕、标签、画面描述），导演层和工具层都以它为准。建议先把这个格式定下来。
- <b>导演方案可审</b>：已否决。ethan 定了：默认导演是专业的，方案不需要用户确认。
- <b>打回要有上限</b>：给每段设重试次数和预算上限，超出就降级处理或交给人决定。
- <b>拼接一致性</b>：并行生成的片段在色调、字幕样式、数字人形象、音量上要统一，最后需要一个统一检查环节。
- <b>成本与时长</b>：视频理解和生成都很贵，需要估算一条 10 分钟视频的单条成本和总耗时。
- <b>补拍合规</b>：数字人和声音只限用户本人授权的形象，生成的镜头要标记为 AI 生成。
- <b>MVP 建议</b>：第一版只做「转写、切分、导演出方案、代码剪辑、加字幕」这条主链路，AI 补拍和文生视频放到第二阶段。

## 四、待 ethan 确认

1. <s>模型和工具名称</s>：已确认，视频理解用 [elorian.ai](http://elorian.ai)，导演用 Claude Opus，数字人用 HeyGen，代码剪辑用 Remotion。
2. <s>目标用户和视频类型</s>：已确认，面向通用用户，视频类型不限，用预设来区分，见第五节。
3. <s>导演方案要不要先给用户确认</s>：已确认，不需要。

## 五、产品定位与交互原则（ethan 2026-10-19 确认）

### 定位

- 做一个通用的 AI 视频剪辑工具，对标今天 Premiere Pro、剪映的位置。
- 它是综合工具，不只是生成视频。<b>实拍和真人出镜是核心</b>：假的东西越多，真的东西就越值钱，人离不开实拍和真人出镜。AI 生成和补拍只起辅助作用。

### 用户参与方式

- 用户只在开始前给导演交代风格和需求，之后不参与生产过程。
- 默认导演是专业的，方案不用用户确认，由导演自己做完整个流程。

### 视频类型与预设

- 不限制视频类型。
- 提供风格预设和类型预设，不同类型的剪辑偏好差别很大，比如 Vlog、口播、教学、游戏解说、知识解说。
- Prodr 建议：预设就是交给导演的一套默认参数，包括节奏、镜头时长、字幕样式、转场、配乐、是否允许 AI 补拍、成片时长等，用户可以在预设基础上再补充需求。

## 六、待定（Prodr 提出）

- 用户不参与生产过程，那么成片出来之后要不要支持修改？比如用户按段提意见，由导演局部重剪；另外要不要导出工程文件，可以在 PR 或剪映里继续编辑。

## 七、权限档位设计（ethan 2026-10-19 提出）

> 参考 ChatGPT 的操作审批设置。用户在开始前就设好权限，之后由导演按档位自己执行，用来解决「用户不参与生产」和现在「每轮都要用户采用、付费要确认报价」之间的冲突。状态：❌ 未实现。

三档权限：

1. <b>逐项审批</b>：每轮结果和每次付费生成都要用户确认，相当于现在的共看片室模式。
2. <b>自动审批</b>：常规剪辑、字幕、免费工具由导演直接执行；只有高风险操作才问用户，比如单次花费超过阈值、超出总预算、用数字人或克隆声音生成本人出镜内容、覆盖或删除原始素材。
3. <b>完全授权</b>：导演全程自主，不再询问，用户只看成片。

提前设置的内容（Prodr 建议）：

- 默认档位，可以设成全局默认，也可以每个项目单独设。
- 预算：单条视频的总预算上限和单次生成的上限。即使选完全授权，超过总预算也必须停下（ethan 2026-10-19 已确认）。
- 允许使用的工具和生成类型，比如是否允许 AI 补拍、数字人、文生视频。
- 每段最多打回几次。
- 预算预留和花费记录照常保留，完全授权下也能事后查看每笔花了多少。
</content>
</page>
