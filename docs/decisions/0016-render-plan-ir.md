# 0016 RenderPlan IR 由编辑内核编译，预览/服务端合成/终渲染共用

- 状态：生效（2026-10-11，V5-M4 第二部分 a）
- 前一裁决编号：`0015-edge-security-layer.md`
- 来源：`docs/V05/ANCS_v0.5_Architecture.md` §13（RenderPlan IR、三个消费者、能力显式）、§20 M4；v0.4 任务 N09-09（共享 RenderPlan，planHash 稳定）

## 背景

N03-08 的 `buildPlaybackSnapshot` 在领域层一边查库一边拼装播放快照，渲染规则（哪些轨道出画、静音/独奏、哪些需要逐帧渲染）与 I/O 混在一起，且有三处缺陷：

1. 音频轨上的**片段**（`insert_clip` 带出的关联音频）从不进入快照——正常插入流程的声音在预览/合成计划里静默消失；
2. 绑定片段的音频区域把**片段局部时间**当作源区间输出，源入点不为 0 时消费者会从错误的源位置取声；
3. 服务端合成计划用 `Number(ticks)` 排序，超过 2^53 的 ticks 无法区分先后。

另外，关键帧、变速/倒放、嵌套序列在快照中被静默忽略，没有任何后端实现它们却也没有被拒绝。

## 决定

1. **契约** `packages/contracts/src/render-plan.ts`：`renderPlanSchema`（`irVersion = render-plan/1.0`）——源事实（版本、资产、校验和、是否含音频）、视频层（**自下而上**，`position` 升序）、音频条目（`REGION` / `CLIP_AUDIO`，`sourceRange` 为源时钟）、字幕、需逐帧渲染的图形元素、关键帧目标、`requirements`、排除轨道与 warnings。全部时间为 `MediaTime`。
2. **编译器在内核**：`compileRenderPlan(input)`（`packages/kernel/src/render/compile.ts`）是纯函数，输入为与编辑内核同一组实体类型的序列状态 + 源事实；按 ID/起点确定排序，输入顺序不影响输出。
3. **planHash**：规范 JSON（键排序）的 SHA-256，只覆盖渲染内容（`RENDER_PLAN_HASHED_FIELDS`），不含 revision、项目/序列 ID 与 warnings——撤销/改名等不改变画面的编辑不改变哈希，可作缓存键与一致性对照键。SHA-256 在内核内纯实现（不导入 `node:*`，浏览器同值）。
4. **需求与后端裁决分离**：编译器只如实列出 `requirements`（与播放能力同一词表，新增 `KEYFRAME_ANIMATION`、`TIME_REMAP`、`NESTED_SEQUENCE`）；`assertRenderPlanSupported` 按后端声明裁决，任一需求未被显式支持 → 501 `UNSUPPORTED_CAPABILITY`（列出全部缺失项），不静默省略效果。当前没有任何后端实现关键帧/变速/嵌套序列，两套播放后端均显式声明不支持。
5. **音频语义**：音频轨片段发出原声（`CLIP_AUDIO`）；绑定到某 AV 组任一片段的音频区域接管该组音频（组内音频片段不再单独发声，避免同源叠声）。可听条目的源必须可播放，不可听条目只列出不校验。
6. **消费者只从 IR 派生**：`playbackSnapshotFromRenderPlan`、`serverSynthesisPlanFromSnapshot`（内核纯函数）；快照与合成计划回带 `planHash`。领域层 `buildPlaybackSnapshot` = `loadRenderPlanInput`（只读加载）→ 内核编译 → 投影，不再含渲染规则。终渲染后端（M4 后续部分）同样只消费 RenderPlan。

## 行为变化

- 关联音频片段进入音频段（修复缺陷 1）；区域的 `sourceRange` 改为源时钟（修复缺陷 2；当前无前端消费者读取该字段）；合成计划精确排序（修复缺陷 3）。
- 含关键帧/变速/嵌套序列的序列在两套播放后端上返回 501（此前静默忽略）。
- 隐藏的字幕轨/图形轨同样进入 `excludedTrackIds`（此前只列隐藏视频轨）。
- warnings 超过契约 200 字符上限时改为计数（此前可能使快照解析失败）。

## 未纳入（后续）

- 终渲染后端（FFmpeg 媒体图）与一致性套件：M4-2b。
- `HTML_MEDIA_BASELINE` 声明支持逐段变换/裁切/透明度，但 Web 媒体元素后端尚未应用这些参数（`apps/web/src/playback/media-element-backend.ts`）；属 N03-12 浏览器适配器，届时须让声明与实现一致。
- 混音读面 `planClipAudioMix` 只统计音频区域，未计入 `CLIP_AUDIO`；改为消费 RenderPlan 属 N09 混音任务。
