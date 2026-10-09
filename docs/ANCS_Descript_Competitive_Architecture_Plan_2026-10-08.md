# ANCS × Descript：竞品拆解、仓库差距与 AI-Native 编辑器改造路线

> 项目：`MuadibUsul/AI_Native_Creater_Studio`  
> 基线：2026-10-08，`main` 分支  
> 目标：把 ANCS 从“文章/研究 → 专业长视频”的自动化生产系统，升级为“生活在屏幕里的视频大师”：用户看片、指位置、说意图，AI 负责理解、试改、局部回放、追问、迭代、记忆与最终合成。  
> 原则：**专业能力完整，日常界面极简。极简是交互抽象，不是能力删减。**

---

## 0. 结论

### 0.1 不应该重写仓库

当前 ANCS 的后端基础值得保留：

- `Scene Graph` 作为项目权威状态；
- 版本、revision、并发控制；
- typed Edit Operation；
- Undo / Redo / Project Version；
- Provider Adapter；
- Queue / Worker；
- 成本账本；
- 资产、来源、血缘、权限与审计；
- Web / Desktop / Mobile 共享 API 与 Contracts 的原则。

这些都非常适合成为 AI 编辑 Agent 的执行底座。

真正需要重构的是：

1. **视频编辑数据模型的粒度**；
2. **浏览器实时播放/编辑引擎**；
3. **AI 的上下文定位方式**；
4. **Media Understanding**；
5. **从一次性 AI Edit 升级为持续协作 Agent**；
6. **从 Scene 级编辑升级为 Clip / Track / Range / Effect / Keyframe 级专业编辑**。

### 0.2 当前最大结构性问题

仓库仍然带着 v0.2 的旧产品假设：

- `V1 = Article / Research → Professional Long Video`
- “不是网页版 Premiere”
- “前几个版本不要重造完整 Premiere / DaVinci / After Effects”
- “不做完整贝塞尔关键帧编辑器”
- “AI creates; GUI corrects”

这些历史原则和最新产品目标发生了直接冲突。

新的原则应替换为：

> **ANCS 最终必须具备专业 NLE 的能力覆盖，但绝大多数能力不应默认暴露为传统面板、菜单和轨道操作。AI 是第一操作入口，GUI 是精确定位、检查、覆盖与高级控制入口。**

### 0.3 最重要的竞争差异

Descript 的核心交互仍然是：

`Transcript / Document → Video`

ANCS 应该把中心切换为：

`Video Canvas + Pointer + Voice/Text + AI Context → Structured Edits`

一句话：

> **Descript 是“像改文档一样剪视频”；ANCS 应该是“像指挥一个坐在你旁边的视频大师一样剪视频”。**

---

# 1. Descript：应该抄什么

## 1.1 Agent 真正拥有编辑工具

Descript Underlord 的价值不在聊天，而在于它能实际操作项目。

应该复制这个架构原则：

`用户意图 → Agent Planner → 编辑工具调用 → 可编辑工程状态 → 预览 → 反馈 → 下一轮`

而不是：

`用户 Prompt → LLM → 生成一段说明 / 生成一个最终视频`

ANCS 当前已经拥有 typed Edit Operation，这是非常好的起点，但操作粒度还太粗。

---

## 1.2 Media Understanding

Descript 已经从 transcript-only 发展到让 Agent 理解画面内容。

ANCS 必须建立统一 Media Index：

```text
MediaSource
├── Transcript / Word Timing
├── Speaker Segments
├── Shot Boundaries
├── OCR
├── Objects
├── Actions
├── Faces / Person Tracks
├── Visual Events
├── Audio Events
├── Music / Beat
├── Motion Intensity
├── Semantic Embeddings
└── User Markers / Notes
```

目标不是“每次问 AI 都重新把视频看一遍”。

目标是：

> 视频导入后异步结构化，以后所有编辑、检索、Agent 推理都访问这套索引。

---

## 1.3 Templates = Agent Workflow Recipe

Descript 的 Template 已经不是传统模板，而是：

- workflow prompt；
- 布局与样式；
- 用户追问；
- 编辑步骤；
- 输出约束。

ANCS 应该把它进一步升级为：

**Editing Strategy / Editing DNA**

它不仅可以由平台预置，也可以：

`参考视频 → 自动分析 → 生成 Strategy Manifest → 保存 → 以后复用`

---

## 1.4 Web 媒体引擎

Descript 的 Web 编辑器方向值得直接参考：

- WebCodecs；
- WebAssembly；
- WebGL / WebGPU；
- 云端媒体转码；
- 标准化 proxy；
- 浏览器按需流式加载；
- 硬件 decode / compose / encode。

ANCS 当前 Remotion 体系适合：

- 图形动画；
- Scene Component；
- 最终可重复渲染。

但不能单独承担未来的专业实时剪辑体验。

建议最终形成：

```text
Interactive Playback Engine
  ├─ WebCodecs / MSE
  ├─ WebAudio
  ├─ GPU compositing
  └─ Proxy / cache

Final Render
  ├─ FFmpeg media graph
  ├─ Remotion graphics
  └─ Provider-generated media
```

---

## 1.5 Generative Editing / Inpainting

Descript 的局部音频再生成、唇形修复、Jump Cut Bridge 非常关键。

ANCS 不应该把生成式视频只理解为：

“生成一段 B-roll”。

还应该支持：

- 修正一句说错的话；
- 局部语音重新生成；
- 局部唇形同步；
- 删除片段后生成连续过渡帧；
- 局部背景修复；
- 删除对象；
- 延长镜头；
- 智能补帧；
- 局部画面替换。

统一抽象：

```text
RegenerateRegionOperation
targetRange
targetRegion
constraints
preserveMask
providerRequirement
costEstimate
```

---

# 2. Descript：不应该抄什么

## 2.1 不要让 Transcript 成为产品中心

Transcript 是重要定位手段，但不应该成为 ANCS 的主界面。

原因：

- 很多剪辑意图来自画面，不来自文字；
- 音乐、动作、表情、视觉节奏无法通过 transcript 表达；
- 用户天然会说“这里”“这个人”“这一帧”“这个字幕”“这段 B-roll”。

因此 ANCS 的主状态应该围绕当前播放画面和用户指针上下文。

---

## 2.2 不要把 AI 功能堆成 30 个按钮

避免：

- AI Remove Silence
- AI Caption
- AI B-roll
- AI Eye Contact
- AI Audio Fix
- AI Reframe
- AI Translate
- AI Cleanup

全部作为首页显式功能入口。

正确方向：

> Agent 拥有这些 tools。用户描述结果，AI 决定工具组合。

高级用户仍可在 Inspector / Command Palette 中直接调用。

---

## 2.3 不要让 Credits 成为黑箱

每个付费生成操作必须在执行前具备：

- 预计费用；
- 预计耗时；
- 是否调用第三方 Provider；
- 重试是否再次收费；
- 失败退款策略；
- 结果资产的所有权 / 保存策略。

ANCS 现有 usage/cost ledger 可以继续强化。

---

## 2.4 不要牺牲专业控制

自然语言不能替代专业参数，只是改变参数的入口。

用户仍然需要：

- 精确帧；
- 精确时间码；
- position / scale / crop；
- opacity；
- speed；
- gain；
- fade；
- keyframe；
- easing；
- masks；
- blend；
- color；
- multicam；
- audio automation。

区别只是：

> 默认不把所有控制铺满屏幕。

---

# 3. ANCS 必须领先 Descript 的能力

## 3.1 Pointer-Grounded Editing

这是 ANCS 最应该做成核心专利感体验的能力。

用户在播放器里：

- hover；
- click；
- drag box；
- scrub；
- select range；
- select subtitle；
- select object；
- select person；
- select clip；
- select scene。

系统形成统一：

```ts
SelectionAnchor {
  sequenceId
  timeRange
  frame
  trackId?
  clipId?
  sceneId?
  objectTrackId?
  captionId?
  normalizedRect?
  cursorPoint?
  semanticRefs[]
}
```

用户只说：

> “这个放大一点。”

Agent 不再猜“这个”是谁。

---

## 3.2 Conversational Edit Loop

目标交互：

```text
看片
↓
指位置
↓
说要求
↓
AI 局部试改
↓
自动回放修改区域
↓
AI 追问 / 用户评价
↓
再次试改
↓
确认
↓
写入正式版本
```

这比传统的：

`Prompt → Generate Plan → Apply`

多了最关键的：

- selection context；
- preview branch；
- local replay；
- follow-up；
- acceptance memory。

---

## 3.3 Decision Notebook

AI 必须区分：

- 用户随口尝试；
- 用户明确接受；
- 项目级规则；
- 用户长期偏好；
- 当前视频特例。

建议：

```text
EditDecision
├── scope: RANGE / SCENE / PROJECT / USER
├── intent
├── acceptedOperationIds
├── rejectedAlternatives
├── reason
├── tags
├── strategyImpact
└── confidence
```

例如用户多次确认：

> 旁白停顿最多 300ms。

以后 Agent 可以自动采用，但仍保留可解释性和撤销。

---

## 3.4 Reference Video → Editing Strategy

用户上传或提供有权分析的参考视频后：

```text
Media Understanding
↓
Structure Analysis
↓
Editing Grammar Extraction
↓
Strategy Manifest
↓
Reusable Strategy
```

Strategy 至少包含：

```text
videoType
hookPattern
chapterPattern
averageShotLength
paceCurve
talkingHeadRatio
brollRules
captionGrammar
motionGrammar
transitionGrammar
musicGrammar
soundEffectRules
visualDensity
chartRules
colorRules
ctaPattern
exceptionRules
```

并保留：

- 来源；
- 版本；
- confidence；
- 哪些规则来自事实观察；
- 哪些规则由模型推断。

禁止把受版权保护视频的具体镜头、素材、台词直接复制成模板。

---

# 4. 当前仓库能力评估

## 4.1 已经很强的部分

| 能力 | 当前状态 | 判断 |
|---|---|---|
| Scene Graph Source of Truth | 已实现 | 保留 |
| Revision / optimistic concurrency | 已实现 | 保留 |
| Typed Edit Operation | 已实现 | 扩展 |
| Undo / Redo | 已实现 | 保留 |
| Project Version | 已实现 | 保留 |
| AI Edit Plan | 已实现 | 升级为 Agent |
| Provider abstraction | 已实现 | 保留 |
| Worker / queue | 已实现 | 保留 |
| Cost / credits | 已实现 | 保留 |
| Asset / source / lineage | 已实现 | 保留 |
| Remotion preview/render | 已实现 | 保留但降级为其中一层 |
| Multi-output Packs | 已实现 | 保留 |
| Publishing / CMS | 已实现 | 保留 |

当前仓库不是“半成品 Demo”，而是已经有相当完整的平台底座。

---

## 4.2 当前核心缺口

### A. `scene-graph.ts` 粒度不够

当前 Scene 主要包含：

- start / duration；
- component；
- props；
- narration；
- asset binding；
- transition。

缺少专业 NLE 所需的一等实体：

- Media Source；
- Clip Instance；
- Track；
- Sequence；
- sourceIn/sourceOut；
- trim/slip；
- transform；
- crop；
- opacity；
- blend；
- keyframe；
- speed curve；
- masks；
- effects；
- audio automation；
- nested composition；
- multicam angle。

### B. `edits.ts` 操作粒度不够

当前 14 类操作：

- update_project
- update_script
- insert_scene
- update_scene
- delete_scene
- duplicate_scene
- split_scene
- reorder_scenes
- replace_asset
- update_caption
- update_audio_track
- set_scene_lock
- restore_scene
- restore_project_version

这足以支持“Scene 编辑器”，不足以支持专业视频编辑 Agent。

### C. Web Editor 仍是表单式编辑

当前：

`ScenePreview + PropForm + LiteTimeline + AI Edit Panel`

它证明后端闭环成立，但不是未来产品形态。

需要升级为：

```text
┌─────────────────────────────────────────┐
│                 Video Canvas             │
│                                         │
│          hover / click / box select      │
│                                         │
├─────────────────────────────────────────┤
│ Smart Timeline（默认很薄，可展开专业模式） │
├─────────────────────────────────────────┤
│  Ask AI / Voice                         │
└─────────────────────────────────────────┘
```

右侧 Inspector 只在选中对象时出现。

### D. AI Edit 仍是一轮式

当前：

`prompt → plan → apply/reject`

目标：

`conversation session → grounded target → preview branch → replay → critique → patch → accept`

---

# 5. 数据模型改造

## 5.1 不要推翻 Scene Graph

建议升级为 `SceneGraph v0.2`，保持旧项目可迁移。

逻辑上新增：

```text
SceneGraph
├── mediaSources[]
├── sequences[]
│   ├── tracks[]
│   │   ├── clipInstances[]
│   │   └── automation[]
│   └── semanticScenes[]
├── captions[]
├── overlays[]
├── markers[]
├── audioTracks[]
└── sourceReferences[]
```

### MediaSource

原始素材必须 immutable：

```text
MediaSource
id
assetId
sha256
duration
width
height
fps
codec
audioStreams
proxyAssets[]
analysisState
```

### ClipInstance

所有剪辑都是引用，而不是修改原文件：

```text
ClipInstance
id
sourceId
trackId
timelineStart
timelineDuration
sourceIn
sourceOut
playbackRate
transform
crop
opacity
effects[]
keyframes[]
```

这条是“非破坏性剪辑”的核心。

---

# 6. Edit Operation v2

建议新增：

```text
insert_clip
delete_clip
move_clip
trim_clip
slip_clip
split_clip
duplicate_clip

set_clip_transform
set_clip_crop
set_clip_opacity
set_clip_speed

add_effect
update_effect
remove_effect

add_keyframe
update_keyframe
remove_keyframe

create_track
move_track
delete_track

set_audio_gain
set_audio_fade
set_audio_pan
set_audio_automation

add_marker
update_marker
remove_marker

update_caption_segment

regenerate_region
replace_region

create_preview_branch
commit_preview_branch
discard_preview_branch
```

要求：

> GUI、快捷键、Agent、未来 Desktop/Mobile 全部只能通过同一 Edit Operation 层修改工程。

这样 AI 才是真正“会剪视频”，而不是拥有一套旁路逻辑。

---

# 7. Selection / Grounding 协议

新增：

`packages/contracts/src/selection.ts`

核心结构：

```ts
type SelectionAnchor = {
  projectId: string
  sequenceId: string
  playheadMs: number
  range?: { startMs: number; endMs: number }
  sceneId?: string
  trackId?: string
  clipId?: string
  captionId?: string
  objectTrackId?: string
  rect?: { x: number; y: number; w: number; h: number }
  point?: { x: number; y: number }
  frameHash?: string
}
```

AI 请求必须携带：

```text
conversation
+
SelectionAnchor
+
current project revision
+
visible context
+
relevant Media Index
```

而不是只发送一句 prompt。

---

# 8. Agent 架构

建议新增：

```text
packages/agent-core
├── planner
├── tool-registry
├── context-builder
├── selection-resolver
├── policy
├── preview-branch
├── critic
├── memory
└── cost-estimator
```

Agent tools 不应该直接操作 DB。

正确调用链：

```text
Agent
↓
Typed Tool
↓
EditOperation[]
↓
Domain Validation
↓
Preview Revision
↓
Player
↓
User Approval
↓
Commit
```

付费生成工具：

```text
Agent
↓
Generation Proposal
↓
Cost Estimate
↓
Explicit Authorization
↓
Job
↓
Derived Asset
↓
Edit Operation
```

---

# 9. Preview Branch：最关键的新基础设施

不能让 AI 每试一次就写正式工程。

新增临时编辑分支：

```text
Project Revision 120
        │
        ├── Preview A
        │    ├ operation 1
        │    ├ operation 2
        │    └ operation 3
        │
        └── Official State
```

用户：

- Reject → 删除 Preview；
- Modify → 继续在 Preview 上补 patch；
- Accept → 原子性 squash/commit。

验收要求：

> 未 Accept 的 AI 操作不得改变正式项目历史。

这比现在“一次 Plan 再 Apply”更适合真实交互式编辑。

---

# 10. Media Understanding 服务

建议新增：

```text
packages/media-index
apps/media-worker
```

异步 Pipeline：

```text
Upload
↓
Probe
↓
Proxy
↓
Waveform
↓
ASR
↓
Shot Detection
↓
Frame Sampling
↓
Vision Understanding
↓
OCR
↓
Audio Event
↓
Embeddings
↓
Index
```

首版不需要自研所有模型。

Provider Adapter 可以接：

- ASR；
- Vision LLM；
- embedding；
- shot detector；
- object tracking；
- audio classifier。

但输出必须统一为 ANCS 自己的 canonical schema。

---

# 11. Editing Strategy Schema

建议：

`packages/contracts/src/editing-strategy.ts`

```text
EditingStrategy
id
version
name
videoType

structure
pace
shotGrammar
captionGrammar
brollGrammar
motionGrammar
audioGrammar
transitionGrammar
colorGrammar
ctaGrammar

constraints
providerPreferences
confidence
sourceEvidence[]
createdFrom
```

Strategy 是“导演和剪辑决策规则”，不是一段自由文本 prompt。

Agent 可以把 Strategy 编译成操作。

---

# 12. 专业能力路线

## 第一层：必须尽快补

- Clip 级时间线；
- source in/out；
- trim；
- slip；
- split；
- multi-track；
- transform；
- crop；
- opacity；
- audio gain/fade；
- frame-accurate playhead；
- snapping；
- waveform；
- caption timing；
- keyboard shortcuts。

## 第二层

- keyframes；
- easing；
- speed ramp；
- masks；
- blend mode；
- LUT / basic color；
- audio automation；
- adjustment layer；
- nested composition。

## 第三层

- multicam；
- advanced tracking；
- motion tracking；
- rotoscoping；
- advanced color；
- advanced audio buses；
- proxy / conform；
- XML/EDL interchange；
- background render/cache。

原则仍然是：

> 能力完整，默认 UI 不暴露全部复杂度。

---

# 13. Web 播放 / 渲染架构

## 当前

Remotion 是非常好的：

- scene component renderer；
- data-driven motion renderer；
- final render layer。

## 新增

### `playback-core`

负责实时：

- decode；
- seek；
- scrub；
- source range；
- clip compositing；
- audio sync；
- overlays；
- low-latency preview。

优先路线：

1. 标准化 proxy；
2. HTMLMediaElement / MSE fallback；
3. WebCodecs acceleration；
4. WebAudio；
5. WebGL/WebGPU compositing。

### render-worker

最终渲染改成 hybrid：

```text
Source media / cuts / audio
        ↓
     FFmpeg graph
        +
Remotion graphics / charts / UI motion
        +
Generated assets
        ↓
Final Encode
```

不要强迫所有原始视频编辑都变成 React frame render。

---

# 14. 新开发阶段建议

旧计划中的 P15 = Desktop/Mobile、P16 = Marketplace/Enterprise 不应马上启动。

新的 Web 编辑核心稳定前做多端，会把旧模型复制三遍。

建议未来阶段重新编号为：

## P15 — Editing Core v2

目标：

- MediaSource；
- Sequence / Track / Clip；
- 非破坏性剪辑；
- Edit Operation v2；
- schema migration；
- Undo / Redo 全覆盖。

退出条件：

> 三段真实上传素材可完成导入、排列、trim、split、move、音量调整、Undo/Redo；原始 asset hash 全程不变。

---

## P16 — Unified Canvas

目标：

- 单一 Video Canvas；
- Smart Timeline；
- Inspector；
- hover/click/box/range selection；
- SelectionAnchor；
- frame/time grounding。

退出条件：

> 用户点击任意 Clip/字幕/Overlay 或框选画面区域后，系统能产生稳定 SelectionAnchor，刷新后可正确解析到工程对象与时间位置。

---

## P17 — AI Editor Agent

目标：

- conversation session；
- Agent Tool Registry；
- preview branch；
- partial replay；
- follow-up；
- accept/reject；
- Decision Notebook。

退出条件：

用户执行：

> “把这里停顿缩短一点，字幕往上一点，其他地方别动。”

AI 只能修改选中范围，局部回放；拒绝不改变正式工程；接受后产生一个可撤销 revision。

---

## P18 — Media Understanding

目标：

- transcript；
- shot；
- OCR；
- visual events；
- object/person/action index；
- audio events；
- semantic search。

退出条件：

用户：

> “找到我举起手机的地方。”

系统返回正确时间段，并可直接跳转、选中、继续编辑。

---

## P19 — Strategy Generator

目标：

- Reference Video Analyze；
- Editing DNA；
- Strategy Manifest；
- versioning；
- strategy apply；
- user-editable rule；
- type-specific strategy。

退出条件：

一个合法参考视频可以生成可解释 Strategy，并在新项目中驱动剪辑；用户手动修改后的规则可另存新版本。

---

## P20 — Professional NLE Expansion

目标：

- keyframes；
- masks；
- speed；
- advanced audio；
- tracking；
- color；
- multicam 分阶段进入。

退出条件：

不以“按钮数量”验收，而以专业场景能力矩阵验收。

---

## P21 — Generative Repair

目标：

- audio regenerate；
- lip regenerate；
- jump-cut bridge；
- extend shot；
- object removal；
- local visual regeneration；
- generated B-roll。

退出条件：

所有生成操作均：

- 有范围；
- 有费用预估；
- 有 provenance；
- 可撤销；
- 不覆盖原始素材；
- 失败不污染正式工程。

---

## P22 — Desktop / Mobile

迁移原 P15。

此时多端共享的是成熟的：

- Contracts；
- Edit Operation v2；
- Agent；
- Media Index；
- Playback abstraction。

而不是复制旧 Scene Editor。

---

## P23 — Marketplace / Enterprise

迁移原 P16。

---

# 15. Codex 第一批任务

建议不要直接一次让 Codex 改完整仓库。

第一轮只做“架构迁移和垂直切片”。

## T1 文档裁决

修改：

- `creator_video_os_spec_v0.2.md`
- `ANCS_Plan261004.md`
- `README.md`
- `docs/requirements/traceability.md`

新增 ADR：

`docs/decisions/0009-ai-native-professional-editor.md`

明确：

1. Article-only 限制取消；
2. “不重建 Premiere”作为能力边界取消；
3. 专业能力最终完整；
4. 默认 UI 极简；
5. AI 和 GUI 共用 Edit Operation；
6. 用户真实素材必须非破坏性编辑；
7. Web 仍首发；
8. Desktop/Mobile 延后到新编辑核心稳定。

---

## T2 MediaSource + ClipInstance vertical slice

新增 Contracts / DB / Domain / API / SDK。

只实现：

- 1 个视频轨；
- upload source；
- create clip；
- move；
- trim；
- split；
- delete；
- Undo/Redo。

不做 AI。

先证明底层专业编辑模型成立。

---

## T3 Unified Canvas vertical slice

一个页面完成：

- 视频预览；
- play/pause；
- scrub；
- playhead；
- clip timeline；
- click clip；
- select time range；
- basic inspector。

删除“必须逐 Scene 进入单独 editor page”的主工作流。

旧 Scene Editor 可暂时保留为 debug / advanced compatibility 页面。

---

## T4 SelectionAnchor

把以下动作变成统一 grounding：

- current playhead；
- time range；
- selected clip；
- selected caption；
- selected overlay；
- pointer point；
- rectangle selection。

所有 AI 请求都必须携带 SelectionAnchor。

---

## T5 Preview Branch

实现：

- create；
- patch；
- render；
- discard；
- commit。

没有它不要开始 Conversational Agent。

---

## T6 Agent 最小闭环

首个只支持 5 个 tools：

- trim clip；
- move clip；
- split clip；
- transform；
- caption position。

用户可以：

`选择 → 说话/打字 → AI 改 → 局部回放 → 再说 → Accept`

先把交互做对，再增加 100 个 tools。

---

# 16. 最终验收标准

ANCS 的最终目标不能写成：

> “拥有 AI 剪辑功能。”

必须写成：

### 用户体验验收

普通用户第一次打开编辑器：

- 不需要理解轨道；
- 不需要理解关键帧；
- 不需要找效果；
- 不需要搜素材；
- 不需要学习传统 NLE。

他只需要：

> 看、指、说、确认。

### 专业能力验收

同一个项目在需要时必须可以展开到：

- frame accurate；
- multi-track；
- transforms；
- keyframes；
- masks；
- speed；
- audio automation；
- captions；
- effects；
- color；
- multicam；
- history；
- version；
- export。

### AI 行为验收

AI：

- 知道用户指哪里；
- 知道项目当前状态；
- 不破坏已确认部分；
- 修改范围可解释；
- 先局部预览；
- 能追问；
- 能根据反馈继续修改；
- 接受后才写正式版本；
- 所有修改可撤销；
- 付费动作先显示成本；
- 真实素材永远非破坏性。

### 架构验收

GUI 与 AI：

> **不得存在两套编辑逻辑。**

所有编辑最终都编译为同一套 typed Edit Operation。

---

# 17. 优先级

如果只看对最终产品价值的贡献：

| 优先级 | 工作 |
|---|---|
| P0 | 非破坏性 Clip/Track 数据模型 |
| P0 | SelectionAnchor |
| P0 | Preview Branch |
| P0 | Unified Canvas |
| P0 | Conversational Agent Loop |
| P1 | Media Understanding |
| P1 | Strategy Generator |
| P1 | Web playback/proxy engine |
| P1 | Professional edit primitives |
| P2 | Generative repair |
| P2 | Desktop/Mobile |
| P3 | Marketplace/Enterprise |

---

# 18. 最关键的工程判断

当前 ANCS 最大资产不是前端，不是某个 Provider，也不是文章生成链路。

真正的资产是：

```text
contracts
+
domain validation
+
version/revision
+
edit events
+
undo/redo
+
provider abstraction
+
worker
+
cost/provenance
```

这套东西已经具备成为 Agentic NLE 内核的条件。

因此正确路径不是“推倒重做一个 Descript”。

而是：

> **保留现有工程内核，把 Source of Truth 从 Scene-level 逐步提升到真正可承载专业非破坏性剪辑的 Media/Clip/Track Graph，再让 AI 成为它的首要操作者。**

---

# 19. 对 Descript 的最终定位

Descript 是重要参考，但不是终点。

可以把竞争关系理解成：

```text
Descript
= Document-first AI Editor

Premiere / DaVinci
= Tool-first Professional Editor

Runway / Veo
= Generation-first Video System

ANCS
= Intent-first Professional Video Agent
```

ANCS 最应该争夺的位置不是“更会生成视频”，而是：

> **人负责审美、方向和判断；AI 负责真正执行专业视频制作。**

当用户说：

> “这里太拖，紧一点；这个字幕别挡脸；下一段换成更克制的 B-roll；整体保持刚刚确认的节奏。”

系统能够准确知道：

- “这里”是哪；
- “这个字幕”是哪；
- “下一段”是哪；
- 什么是“刚刚确认的节奏”；
- 应该调用哪些工具；
- 哪些地方不能动；
- 修改后应该回放哪一段给用户看。

做到这里，才真正是“生活在屏幕里的视频大师”。

---

## 研究依据

本方案结合：

- Descript 2026 Underlord / AI co-editor 产品资料；
- Descript Media Understanding 工程资料；
- Descript Agent API 与 MCP 架构说明；
- Descript AI Templates / workflow recipe；
- Descript WebCodecs / Web 媒体引擎工程说明；
- Descript Video Regenerate / Smooth Jump Cuts 研究资料；
- ANCS 当前 `main` 分支代码与 2026-10-07 Session Handoff；
- 当前 `SceneGraph`、`EditOperation`、`LiteTimeline`、`AI Edit Panel`、Remotion timeline 实现。
