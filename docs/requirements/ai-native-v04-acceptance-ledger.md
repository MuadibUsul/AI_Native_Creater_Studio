# ANCS v0.4｜N 系列实施与验收账本

本表是 v0.4 的**实施状态**，不同于 `docs/V04/ANCS_v0.4_Task_Backlog.md` 的初始 TODO。仅 `VERIFIED` 计入完成；旧 P 系列状态与证据保留在旧账本，不在这里清零。每项需有 `docs/verification/Nxx-yy.md` 和 `docs/handoffs/Nxx-yy.md`，按任务验收与适用 G/O/D 门判断。首次建立：2026-10-08。

来源：`docs/V04/ANCS_AI_Native_v0.4.md` §21—§24、任务清单和包内 `task_index.json`。本文件仅追踪仓库执行；来源中的 P15—P23/T1—T6 不是另一组可执行任务。缺少真实媒体、浏览器或 Provider 证据时，不能把依赖于它们的任务标为 VERIFIED。

**证据级别（2026-10-10 新增，回应外部评审 §九）：** `VERIFIED` 目前**默认指"用 Mock 或确定性夹具验证"**。为免对外沟通失真，约定两个级别：
- `VERIFIED_MOCK` = 契约/领域/API 用 Mock 或确定性夹具 + 真实数据库/HTTP 验证通过；
- `VERIFIED_REAL` = 另有**真实 Provider / 真实浏览器 / 真实媒体**证据。

**当前状态：已 `VERIFIED` 的任务均属 `VERIFIED_MOCK`**（真实 ASR/VAD/LLM/视觉凭据此前未提供）。G0—G4 总门只认 `VERIFIED_REAL`。

**2026-10-11 首次取得 `VERIFIED_REAL` 证据：** 用户提供 Deepgram（ASR）与 DeepSeek（LLM）凭据；Deepgram **批量识别适配器已实现并用真实密钥 + 真实手机素材跑通**（59 词 / 4 段 / 词级时间戳 / 置信度 988/1000 / 20s 音频耗时 3.4s），详见 `docs/verification/provider-real-deepgram.md`。**注意：这不等同于 N05-01/N05-02 转 `VERIFIED`**——流式（边说边出字）、浏览器采集与长时序夹具仍未验证；DeepSeek 适配器尚未接入。本表暂不为每行加列，以免与逐项证据二次漂移；级别口径以本节为准，逐项真实证据待凭据到位后补。


当前：N00-01—07、N01-01—11、N02-01—15、**N03-01…09**、**N03-11**、**N06-01／02／03／04／05／06／07**、N15-01/02、N16-01/02 共 54 项 `VERIFIED`（54/219，24.66%）；剩余 165 项（75.34%）。**统计以下方明细表为唯一事实源，由 `node scripts/spec-check.mjs` 校验（V5-M0，2026-10-11）；N04-09 因依赖 N04-05 未完成回调为 `IMPLEMENTED_UNVERIFIED`。**D0/D1、O0 与 G0—G4 总门仍未通过。N00、N01 基础阶段已经全部关闭，**N02 素材输入阶段全部关闭**，N03 时间线原语已开局。N02-15 已完成 Director/选区/参考分析共用 MediaIndex 读投影、来源版本+索引指纹+权限上下文的缓存 key、命中与用量记录、跨租户 404/no-store，并修复空分镜分支不显示带入片段的真实缺陷（浏览器 E2E 抓出）；迁移已到 0075。N03-01 交付 `insert_clip`（INSERT／OVERWRITE／APPEND，含涟漪切分、AV 关联与三种负路径）与 `delete_clip` 规范原语，v2 覆盖层 `insert_clip` 由 PLANNED 翻为 NATIVE，并修掉两个真实缺陷（执行器按自造字段形状判定原声导致 AV 关联永不触发；undo/redo 对 INSERT_CLIP／DELETE_CLIP 的两组 case 放反）；下一项 N03-03。第三方 ASR/视觉/音频分析 Provider 因无授权凭据保持 `UNVERIFIED_CREDENTIALS_REQUIRED`，不把脚本 Adapter 当真实 Provider。N15-03 已落地 0053—0055 权限策略、工作区项目/存储与工单支持授权安全读投影；独立复核与生产发布尚未交付。全局 Web 已按 v0.4 黑白语义层迁移并完成 21 个现存路由的多视口检查；用户已要求不再等待 Web 检查，继续全量 v0.4。N16-03 仍缺原型图标权利和 macOS/Safari 实机证据；N16-10 仍需正式 ProjectDocument 内容 hash 证据。所有 `IN_PROGRESS` 均不计入完成。N03-02 交付 `split_clip`（右段为子片段、AV 同步切分）、`trim_clip`（入出点，越界/时长不等/重叠 fail-closed）、`move_clip`（保持时长与轨类型）、`duplicate_clip`（只复制引用不复制二进制）与 `replace_clip_source`（时长匹配 + 批准按 revision 失效），v2 覆盖层把 move/trim 由别名提升为原生、split/duplicate/delete 翻为 NATIVE，并修掉裁剪时 AV 关联片段源出点被放大 1000 倍的真实缺陷；下一项 N03-03。N03-03 交付 `slip_clip`（滑移素材内容）、`slide_clip`（邻居伸缩吸收位移）、`roll_clip`（卷动剪辑点）、`ripple_clip`（**显式**涟漪收缝，逐条事件报告被平移片段）与 `split_av_cut`（J/L cut，音频切点错开且原音连续），`slip_clip` 由别名提升为原生；并修掉五个真实缺陷（涟漪 TRIM_TAIL 源出点为负导致 500、TRIM_HEAD 留缺口反压、slide 邻居语义写反、slip 的 AV 同步量取错、roll 的 undo 锚点取错）；下一项 N03-06。N03-04 交付多轨与轨道控制：`create_track`／`move_track`／`delete_track`（非空轨策略）／`update_track`（静音·独奏·隐藏·锁定·同步锁）／`set_av_link`（链接·解链），迁移 0076 为 `sequence_tracks` 增加 `solo`／`sync_locked`，同步锁参与涟漪范围判定；并修掉轨道重排触发 `(sequence_id, position)` 唯一索引冲突导致的 HTTP 500（改为两阶段落位）；下一项 N03-05。N03-05 交付可编辑变换与基础关键帧：`set_clip_transform`／`set_clip_crop`／`set_clip_opacity` 三个规范原语（v2 由 PLANNED 翻为 NATIVE）、`visual-transform.ts` 参数契约与命中换算纯函数（裁切→缩放→旋转→位移，正逆互验）、迁移 0077 给片段加 `parameters`；变换是参数化修改（不重生成镜头，Scene 行数不变），派生片段继承参数、undo 逐条回退；下一项 N03-06。N03-06 交付基础混音与原声保护：`apply_audio_crossfade`（等功率、严格相邻校验）与片段级混音计划 `planClipAudioMix`（无削波 422 MIX_CLIPPING_DETECTED / 无意外静音 409 MIX_EMPTY_OUTPUT 两道 fail-closed 门），并在 `preserveOriginalSpeech` 下拒绝触碰源时钟的音频编辑（409 ORIGINAL_SPEECH_PROTECTED，增益/淡入淡出/声像仍允许），补偿路径（undo/redo）不受守卫限制。N03-07 交付字幕与转写驱动剪辑：字幕文本由**词条**重建（否定词与数字逐字保留）、`create_caption`／`split_caption`／`cut_caption_range`／`delete_caption` 四个规范原语并把 `update_caption` 由 PLANNED 翻为 ACTIVE（写字幕绝不动画面与原声），转写驱动剪辑必须显式选择模式（CAPTION_ONLY 只改字幕 / CUT_CONTENT 真正剪内容并跨轨收缝、字幕跟随左移不越界、被切口完全包含的其他字幕 409 fail-closed）。下一项 N03-08。N03-08 交付播放快照与服务端合成计划：`buildPlaybackSnapshot` 由**同一份**工程文档投影出视频段／音频段／字幕／能力／排除项并回带 `documentRevision`，`buildServerSynthesisPlan` 由同一快照派生逐帧合成计划（预览与合成逐帧可对照）；能力按后端**显式声明**（baseline 精度 `KEYFRAME_APPROXIMATE` 且不支持逐帧图形渲染，未列出的能力一律不支持），空时间线／源不可播放／图形对象走 baseline 均 fail-closed；并修掉「隐藏视频轨仍产出播放段」的真实缺陷。下一项 N03-09。N03-09 交付范围编辑的最小 AI 入口：`planRangeEdit` 把选中片段、Brief、**允许操作清单**与源证据交给规划器，输出经契约/允许清单/源引用/对象锁/原声保护五道校验的可执行操作，越界请求逐条记入 `outOfScope` 并说明原因（不静默丢弃、不整批失败）；计划阶段零数据库写入、零 Provider 媒体调用（`providerMediaCalls` 为字面量 0），Apply 仍走统一编辑协议。同时修复 CI：真实媒体用例按套件定义从 unit 迁到 integration，并在 CI 安装 FFmpeg（`spawn ffprobe ENOENT` 不再阻塞合并）。N04-09 交付 SelectionAnchor 归一与旧 Attention 兼容：规范锚点（几何 × 时间 × 轨道 × 属性 × 区域模式）持久化为追加式修订日志（迁移 0079），旧 inline 选择（分镜/片段/字幕/素材范围/像素区域）经适配器**解析一次**且不丢有理时基，越权与帧哈希身份被拒，重映射能把失效选择明确标成 FAILED/PARTIAL/AMBIGUOUS/STALE 并记入 remapHistory；选择动作永不改工程。增量设计（鼠标点线面 × 横向时间定位 × 流式语音）首批契约与推进次序见 docs/design/mouse-voice-gap-map.md。N05-01 已交付**实时会话与短期凭证适配**的可验证部分（迁移 0080）：短期 HMAC 凭证只返回一次且 TTL 15 分钟、长期 Key 永不下发、未配置密钥即 501；创建需 `project:write`（跨租户 404）；能力表按传输方式显式声明（浏览器回退不承诺服务端 VAD/逐词时间戳/工具）；流式事件信封带代际/时钟/序号四道门，`partial` 转写只写会话草稿（工程零变更）、改口产生新转写修订；`sealUtterance` 把最新修订 + 解释动作 + 目标绑定封存成 IntentRevision（需绑定选择锚点）供 `planRangeEdit` 使用。**真实 WebRTC/sideband 传输与真实 VAD/流式 ASR 未接（待凭据，保持 UNVERIFIED_CREDENTIALS_REQUIRED）**，故本项为 IN_PROGRESS。下一步按增量设计：N04-02-s1/N04-04-s1（画布命中与横向时间带，保留 LiteTimeline）与 N06-0x-s1（私有候选/试改/原子采用）；主线仍待 N03-10。N06-01／N06-02 已交付**私有候选 → 确定性试改 → 原子采用**（迁移 0081；N06-04 的局部试片缓存与依赖失效仍未交付）：候选只存操作集与绑定且不改工程；试改在事务内用真实执行器跑完再无条件回滚（同一操作集同一结果，`projectUntouched` 为结构性保证）；采用按幂等键/状态/操作哈希/选择指纹/base revision 绑定校验后经统一编辑协议原子执行，失败不显示已采用且零部分写入；丢弃与取代（SUPERSEDED）齐备。**N04-02-s1／N04-04-s1**（增量设计「鼠标点线面 × 横向时间定位」首批 UI 切片，均 `IN_PROGRESS`，不计入完成）：新增 `packages/contracts/src/timeline-band.ts`（可视窗口→有理时基换算、播放头/时间选区分离、POINT 与半开 RANGES、显式多区间不合并、帧吸附、区间上限 fail-closed）与 `visual-picking.ts`（复用 `hitTestVisualObject`，zOrder→细粒度→输入顺序，隐藏/父隐藏排除，重叠轮换，投影四边形），并新增 `composeSelectionAnchor` 组装规范锚点（选择动作不改工程）；Web 侧新增 `TimelineBand`（标尺 scrub 播放头 + 专用选择带拖动/Shift 叠加 + 片段轨道块）与 `CanvasInteractionLayer`（悬浮高亮、点击命中发 `OrderedTargetRef`、多选 A/B、框选），并在 `LiteTimeline`（保留、扩展）与 `WorkflowDirector`「展开轻时间线」内可选用接线。真实浏览器/高 DPI 目检、v2 片段轨道投影、锚点持久化仍待（N04-01/N04-10 等）。**N04-05**（AttentionSnapshot 本体，`IN_PROGRESS`）新增 `packages/contracts/src/attention.ts`：11 类共同注意力事件（含 `PRESENTED_FRAME` 真实呈现帧与 `VOICE_CLOCK` 语音时钟）、有界缓冲（默认 8s/512 事件，epoch/单调时钟/seq fail-closed）、鼠标轨迹最小保留（最小距离去样 + 点数上限）与快照导出；录制器接线与服务端按发话时观看记录定位仍属垂直切片/N05-02。**N04-10**（刷新/嵌套/时序变更后的锚点自动恢复，`IN_PROGRESS`）：目标引用新增可选恢复基线 `bindingBaseline`（不参与指纹、兼容旧锚点）；`recoverSelectionAnchor` 提供幂等刷新恢复（无实质变化不追加修订）、`expectedRevision` 与主键冲突两层并发保护（409 `SELECTION_CONCURRENT_UPDATE`）、`FOLLOW_OBJECT` 位移跟随与 `FOLLOW_SOURCE` 源映射重投影（映射失败标 STALE）、嵌套父序列缺失显式标 PARTIAL；新增 `addMediaTime`/`subtractMediaTime`；HTTP `POST .../selection-anchors/:anchorId/recover` + SDK。UI 呈现与真实浏览器证据待 N04-01/N04-08。**N05-02**（语音采集、转写与时间对齐，`IN_PROGRESS`）：`packages/contracts/src/voice-alignment.ts` 落地采集状态/约束、`VOICE_CLOCK` 采样、播放锚点、能力协商（请求未声明支持 → fail-closed）与音频↔单调↔序列映射；`alignVoiceUtterance` 精度如实标注（WORD_EXACT/AUDIO_RANGE/UTTERANCE_SNAPSHOT/UNAVAILABLE，无词级时间不伪造逐词精确）；Web 新增 `useMicrophoneCapture` + `VoiceCaptureControl`（显式授权、可见监听/电平、卸载即停止）。**真实 VAD/流式 ASR 未接（待凭据，保持 `UNVERIFIED_CREDENTIALS_REQUIRED`）**，回放路径见 verification。**N06-04**（局部试片缓存与依赖失效，`IN_PROGRESS`）：新增迁移 0082 `proposal_trials`（行身份 `(workspace, project, dependency_key)`）；依赖键 = sha256(base revision + operationsHash + selectionFingerprint + intentRevisionId + 素材版本签名)，任一依赖变化即自然失效；`previewProposal` 命中缓存直接返回（`cached=true`，不重复跑执行器），未命中才跑真执行器并 upsert；提供 `invalidateProposalTrials` 显式失效，采用/丢弃后清理该候选缓存行。迁移因既有 0080/0081 快照冲突（`id`/`prevId` 相同）手工编写并同步 journal。**N06-03**（影响集、陈旧提案与受控 rebase，`VERIFIED`）交付：创建候选时**记录**字段读写集（操作注册表并集）、具体写目标（对象 + 对象锁六维）与候选引用片段的源素材绑定签名（迁移 0083）；`computeProposalImpact` 把写目标与 base revision 之后 `edit_events` 还原的干预改动做**同对象同维度**竞争判定，`rebaseProposal` 仅在无竞争且身份（锚点指纹）/源素材未变时受控推进 base revision（仍在新 base 上用真实执行器事务内验证后回滚），失败即 409（`PROPOSAL_REBASE_CONFLICT` / `PROPOSAL_REVIEW_REQUIRED`），**绝不以最新 revision 强覆盖**；契约 `packages/contracts/src/edit-impact.ts`（纯函数影响集映射，读不出形状时保守取全维度）+ 9 项单测、HTTP/SDK 端点、8 项集成用例（不同片段可合并、同对象同维度 409、同对象不同维度可合并、涟漪位移的间接影响可检测、源素材/身份变化要求重新审核、已最新则幂等空操作）。**N06-06**（提案替代、取消与晚到结果隔离，`VERIFIED`）交付（迁移 0084）：候选带工程内单调递增 `generation`，创建时自动**取代**同谱系（`intentRevisionId` 优先，否则 `selectionAnchorId`）的旧 OPEN 候选并记录 `supersededByProposalId`；`cancelProposal` 标记 `CANCELLED` 但**保留**试片与产物结果（与丢弃不同），取消后采用/试改 409、回调不改 acceptedRevision；外部晚到产物落 **`proposal_artifacts` 隔离台账**，仅"候选仍 OPEN 且为谱系当前代际"才 `bound=true`，其余（`SUPERSEDED`/`CANCELLED`/`STALE_GENERATION`/`NOT_CURRENT`/`ALREADY_BOUND`）一律隔离且不自动绑定；`runRetentionSweep` 新增第 7 步按保留期清理 `bound=false` 的孤儿行、保留已绑定结果。契约 + HTTP/SDK（cancel/artifacts）+ 5 项集成（逆序完成仍展示最新意图、无谱系不取代、取消保留结果、孤儿隔离、保留清理）。**N06-05**（采用、继续微调、拒绝与部分采用，`VERIFIED`）交付（迁移 0085）：`packages/contracts/src/proposal-disposition.ts` 提供**确定性处置解析**（显式 UI 动作优先 → 拒绝 → 后面也这样 → 继续微调 → 采用；**沉默/无法识别 = 需确认，绝不据此采用**；多候选无唯一目标 = 需消歧），9 项单测；`adoptProposalPartial` 支持**部分采用**并按**依赖闭包**扩张（引用闭包：消费 `createdClipId` → 并入其创建操作；音画配对闭包：同一 `avGroupId` 的视频/音频操作必须同进），响应如实回报 `adoptedOperationIndexes`/`remainingOperationIndexes`/`closureExpanded`/`effectiveWriteTargets`；部分采用为一次性交付（`PARTIALLY_ADOPTED`，闭包覆盖全部则 `COMMITTED`），越界选择 422 `PROPOSAL_PARTIAL_SCOPE_INVALID` 零写入；5 项集成。**N06-07**（已确认内容保护与回归指纹，`IN_PROGRESS`）：迁移 0086 `content_protections`（保护记录，非第二份作品状态）；`clipDigestsOf` 提供三轴指纹（CONTENT 源区间/映射/参数/源流、POSITION 轨道与序列区间、ASSET 素材版本/嵌套序列）；`captureConfirmedContent` 采集、`checkConfirmedContent` 输出差异与**范围外变化**报告、`assertProtectedContentStable` 用**试改后状态**判定"受保护对象被改动但非本批显式目标"的**附带变化/意外移位** → 409 `CONFIRMED_CONTENT_REGRESSION` 且零写入（采用/部分采用的可选 `protectionIds` 才多跑一次试改）；`resolveScopeGuard` 提供"其他别动 + 总时长改变 → 先解释 / 改等长方案"的权威判定（**仅契约层，尚未接规划器**）；保护范围当前仅 CLIP（字幕/音频区域/视觉对象显式 501 待扩）；HTTP/SDK 4 端点 + 4 项集成。**收口（同日第二批，转 VERIFIED）：** `resolveScopeGuard` 增 `exact` 语义（总时长变化不可确定时一律要求解释，**不得当作等长放行**），并**接入规划器** —— `createRangeEditPlanRequestSchema` 增 `preservesEverythingElse`；`packages/contracts/src/range-edit.ts` 新增纯函数 `estimateRangeEditDurationDeltaMs`（由操作负载确定性估算：INSERT/APPEND 变长、涟漪 TRIM_* 按收缝量变短、涟漪 DELETE 与 delete_clip 无法确定 → `exact=false`）与 `rangeEditPlanSchema.lengthGuard`；`planRangeEdit` 回带判定，`requiresExplanation` 时附 rationale（计划本身不执行、不改工程）；5 项估算器单测 + 1 项规划器端到端集成用例（新增 `range_edit_ripple` Mock 脚本）。**N06-08**（A/B 比较与差异标记，`IN_PROGRESS`）：`packages/contracts/src/proposal-compare.ts` + `compareProposal` —— 右侧为候选**试改后真实执行结果**（事务内跑完回滚），左侧为当前确认版或另一候选；差异按三轴标记（ADDED/REMOVED/CHANGED/UNCHANGED）；**片段数/时长不同时按内容锚点对齐**（素材版本 + 嵌套序列 + 源区间），无法唯一对齐的锚点如实进 `unmatchedAnchors`；**回带双方实际 `assetVersionId`**（证明对照真资产而非重新生成）；对照零写入。播放器侧切换前后/音频 AB/循环回放与 UI 未做；版本恢复复用 N01-08 补偿事件（已 VERIFIED）；**依赖 N04-04 仅 s1 就绪（显式降级）**；3 项集成。当前 `pnpm verify` 见 docs/handoffs/RUNNING_DELIVERY.md。

| 工作流 | 任务数 | VERIFIED | 说明 |
|---|---:|---:|---|
| N00 | 7 | 7 | 基础阶段全部 VERIFIED |
| N01 | 11 | 11 | N01 全部 VERIFIED |
| N02 | 15 | 15 | **N02 全部 VERIFIED**（素材输入阶段关闭） |
| N03 | 16 | 10 | N03-01…09、N03-11 VERIFIED（时间线原语 + 精剪 + 多轨 + 变换 + 混音 + 字幕 + 播放快照 + 范围编辑 AI 入口）；下一项 N03-10 |
| N04 | 11 | 0 | N04-09 自身验收已通过，但依赖 N04-05 未 VERIFIED → `IMPLEMENTED_UNVERIFIED`（2026-10-11 依 spec-check 回调）；增量设计首批契约见 docs/verification/N04-09-s1.md |
| N05 | 8 | 0 | 以任务表逐项证据为准 |
| N06 | 11 | 7 | N06-01／N06-02／N06-03／N06-04／N06-05／N06-06／N06-07 VERIFIED；N06-08（A/B 比较与差异标记）`IN_PROGRESS` |
| N07 | 13 | 0 | 以任务表逐项证据为准 |
| N08 | 10 | 0 | 以任务表逐项证据为准 |
| N09 | 11 | 0 | 以任务表逐项证据为准 |
| N10 | 13 | 0 | 以任务表逐项证据为准 |
| N11 | 13 | 0 | 以任务表逐项证据为准 |
| N12 | 8 | 0 | 以任务表逐项证据为准 |
| N13 | 12 | 0 | 以任务表逐项证据为准 |
| N14 | 8 | 0 | 以任务表逐项证据为准 |
| N15 | 40 | 2 | N15-01/02 单项通过；O0 未关闭 |
| N16 | 12 | 2 | N16-01/02 单项通过；D0/D1 未关闭 |

## 任务明细

### N00

| 任务 | 标题 | 依赖 | v0.4 状态 | 证据 / 交接 |
|---|---|---|---|---|
| N00-01 | 锁定工作区与逐层复核现有实现 | 无 | VERIFIED | [`验证`](../verification/N00-01.md) · [`交接`](../handoffs/N00-01.md) |
| N00-02 | 切换需求权威与旧裁决 | N00-01 | VERIFIED | [`验证`](../verification/N00-02.md) · [`交接`](../handoffs/N00-02.md) |
| N00-03 | 复跑基线验证并建立缺口账本 | N00-01 | VERIFIED | [`验证`](../verification/N00-03.md) · [`交接`](../handoffs/N00-03.md) |
| N00-04 | 建立多素材与对照样例集 | N00-03 | VERIFIED | [`验证`](../verification/N00-04.md) · [`交接`](../handoffs/N00-04.md) |
| N00-05 | 功能差项、发布门与开关 | N00-02, N00-04 | VERIFIED | [`验证`](../verification/N00-05.md) · [`交接`](../handoffs/N00-05.md) |
| N00-06 | 建立新浏览器与媒体验收骨架 | N00-03, N00-04 | VERIFIED | [`验证`](../verification/N00-06.md) · [`交接`](../handoffs/N00-06.md) |
| N00-07 | 合并增量术语、来源边界和阶段映射 | N00-01, N00-02 | VERIFIED | [`验证`](../verification/N00-07.md) · [`交接`](../handoffs/N00-07.md) |

### N01

| 任务 | 标题 | 依赖 | v0.4 状态 | 证据 / 交接 |
|---|---|---|---|---|
| N01-01 | 有理时基、PTS与换算原语 | N00-02, N00-04 | VERIFIED | [`验证`](../verification/N01-01.md) · [`交接`](../handoffs/N01-01.md) |
| N01-02 | ProjectDocument与模式约束 | N01-01 | VERIFIED | [`验证`](../verification/N01-02.md) · [`交接`](../handoffs/N01-02.md) |
| N01-03 | 序列、轨道、Clip与源范围 | N01-02 | VERIFIED | [`验证`](../verification/N01-03.md) · [`交接`](../handoffs/N01-03.md) |
| N01-04 | 图形、效果、字幕与音频对象 | N01-03 | VERIFIED | [`验证`](../verification/N01-04.md) · [`交接`](../handoffs/N01-04.md) |
| N01-05 | 增量迁移与旧项目兼容适配 | N01-03, N01-04 | VERIFIED | [`验证`](../verification/N01-05.md) · [`交接`](../handoffs/N01-05.md) |
| N01-06 | 操作注册表与候选状态校验 | N01-04 | VERIFIED | [`验证`](../verification/N01-06.md) · [`交接`](../handoffs/N01-06.md) |
| N01-07 | 范围锁与间接影响计算 | N01-06 | VERIFIED | [`验证`](../verification/N01-07.md) · [`交接`](../handoffs/N01-07.md) |
| N01-08 | 版本、快照与补偿事件扩展 | N01-05, N01-06, N01-07 | VERIFIED | [`验证`](../verification/N01-08.md) · [`交接`](../handoffs/N01-08.md) |
| N01-09 | 工程API、SDK与事件契约 | N01-08 | VERIFIED | [`验证`](../verification/N01-09.md) · [`交接`](../handoffs/N01-09.md) |
| N01-10 | MediaSource与ClipInstance单一权威映射 | N01-03, N01-05 | VERIFIED | [`验证`](../verification/N01-10.md) · [`交接`](../handoffs/N01-10.md) |
| N01-11 | Edit Operation v2全清单与别名编译 | N01-06, N01-10 | VERIFIED | [`验证`](../verification/N01-11.md) · [`交接`](../handoffs/N01-11.md) |

### N02

| 任务 | 标题 | 依赖 | v0.4 状态 | 证据 / 交接 |
|---|---|---|---|---|
| N02-01 | 有界内存的批量分片直传 | N00-06, N01-02 | VERIFIED | [证据](../verification/N02-01.md) · [交接](../handoffs/N02-01.md) · [UI](../design/features/N02-01.md) |
| N02-02 | 媒体探测与格式能力状态 | N02-01, N01-01 | VERIFIED | [证据](../verification/N02-02.md) · [交接](../handoffs/N02-02.md) · [UI](../design/features/N02-02.md) |
| N02-03 | 代理转码与源时间映射 | N02-02, N01-03 | VERIFIED | [证据](../verification/N02-03.md) · [交接](../handoffs/N02-03.md) · [UI](../design/features/N02-03.md) |
| N02-04 | 缩略、波形、镜头与片段索引 | N02-02 | VERIFIED | [证据](../verification/N02-04.md) · [交接](../handoffs/N02-04.md) · [UI](../design/features/N02-04.md) |
| N02-05 | 转写、说话人与字幕锚点 | N02-02, N01-04 | VERIFIED | [证据](../verification/N02-05.md) · [交接](../handoffs/N02-05.md) · [UI](../design/features/N02-05.md) |
| N02-06 | 语义素材检索与实际片段查看 | N02-04, N02-05 | VERIFIED | [证据](../verification/N02-06.md) · [交接](../handoffs/N02-06.md) · [UI](../design/features/N02-06.md) |
| N02-07 | 来源、许可与媒体生命周期 | N02-01, N01-03 | VERIFIED | [证据](../verification/N02-07.md) · [交接](../handoffs/N02-07.md) · [UI](../design/features/N02-07.md) |
| N02-08 | 缺失媒体、重新链接与外部回绑 | N02-03, N02-07 | VERIFIED | [证据](../verification/N02-08.md) · [交接](../handoffs/N02-08.md) · [UI](../design/features/N02-08.md) |
| N02-09 | 素材输入真实端到端验收 | N02-01, N02-03, N02-06, N02-07, N02-08 | VERIFIED | [证据](../verification/N02-09.md) · [交接](../handoffs/N02-09.md) · [UI](../design/features/N02-09.md) |
| N02-10 | 统一Media Index契约与证据记录 | N01-03, N02-02 | VERIFIED | [证据](../verification/N02-10.md) · [交接](../handoffs/N02-10.md) · [UI](../design/features/N02-10.md) |
| N02-11 | 媒体分析分阶段检查点与局部失效 | N02-10, N02-03 | VERIFIED | [证据](../verification/N02-11.md) · [交接](../handoffs/N02-11.md) · [UI](../design/features/N02-11.md) |
| N02-12 | 动作、对象、人物轨迹与运动强度索引 | N02-11 | VERIFIED | [证据](../verification/N02-12.md) · [交接](../handoffs/N02-12.md) · [UI](../design/features/N02-12.md) |
| N02-13 | 音频事件、节拍和声画时间关联 | N02-11, N02-05 | VERIFIED | [证据](../verification/N02-13.md) · [交接](../handoffs/N02-13.md) · [UI](../design/features/N02-13.md) |
| N02-14 | 索引纠错覆盖层与删除权限同步 | N02-10, N02-07 | VERIFIED | [证据](../verification/N02-14.md) · [交接](../handoffs/N02-14.md) · [UI](../design/features/N02-14.md) |
| N02-15 | 共用素材检索与参考证据缓存 | N02-12, N02-13, N02-14, N02-06 | VERIFIED | [`验证`](../verification/N02-15.md) · [`交接`](../handoffs/N02-15.md) |

### N03

| 任务 | 标题 | 依赖 | v0.4 状态 | 证据 / 交接 |
|---|---|---|---|---|
| N03-01 | 素材到序列的插入／覆盖／追加 | N01-09, N02-03 | VERIFIED | [`验证`](../verification/N03-01.md) · [`交接`](../handoffs/N03-01.md) |
| N03-02 | 拆分、裁剪、移动、替换与子片段 | N03-01 | VERIFIED | [`验证`](../verification/N03-02.md) · [`交接`](../handoffs/N03-02.md) |
| N03-03 | ripple、roll、slip、slide和J/L cut | N03-02, N01-07 | VERIFIED | [`验证`](../verification/N03-03.md) · [`交接`](../handoffs/N03-03.md) |
| N03-04 | 多轨、AV链接与轨道控制 | N03-02 | VERIFIED | [`验证`](../verification/N03-04.md) · [`交接`](../handoffs/N03-04.md) |
| N03-05 | 可编辑变换与基础关键帧 | N01-04, N03-02 | VERIFIED | [`验证`](../verification/N03-05.md) · [`交接`](../handoffs/N03-05.md) |
| N03-06 | 基础混音与原声保护 | N03-04 | VERIFIED | [`验证`](../verification/N03-06.md) · [`交接`](../handoffs/N03-06.md) |
| N03-07 | 字幕与转写驱动剪辑 | N02-05, N03-03 | VERIFIED | [`验证`](../verification/N03-07.md) · [`交接`](../handoffs/N03-07.md) |
| N03-08 | 多轨媒体预览与真实合成 | N03-03, N03-04, N03-05, N03-06, N03-07 | VERIFIED | [`验证`](../verification/N03-08.md) · [`交接`](../handoffs/N03-08.md) |
| N03-09 | 范围编辑指令的最小AI入口 | N03-08, N02-06 | VERIFIED | [`验证`](../verification/N03-09.md) · [`交接`](../handoffs/N03-09.md) |
| N03-10 | G0纯素材交付门 | N03-09, N01-08, N02-09, N03-16 | TODO | — |
| N03-11 | PlaybackEngine契约与统一播放快照 | N01-09, N02-03, N01-11 | VERIFIED（状态机/事件/能力协商/后端端口 + 假后端会话证据；具体后端适配属 N03-12） | [`验证`](../verification/N03-11.md) · [`交接`](../handoffs/N03-11.md) |
| N03-12 | 标准proxy与HTML媒体／MSE回退路径 | N03-11, N02-03 | IN_PROGRESS（策略层已交付：选路/精度如实/URL刷新不重置选区/有界缓存与预取；浏览器适配器与冷热首帧实测未做） | [`验证`](../verification/N03-12.md) · [`交接`](../handoffs/N03-12.md) |
| N03-13 | WebAudio主时钟与音画同步调度 | N03-12, N03-06 | IN_PROGRESS（统一时钟/seek epoch/挂起冻结恢复重锚/变速连续/许可提示/同步决策/淡变包络已交付；真实 WebAudio 接线未做） | [`验证`](../verification/N03-13.md) · [`交接`](../handoffs/N03-13.md) |
| N03-14 | WebCodecs加速、可选WASM与帧资源预算 | N03-12 | TODO | — |
| N03-15 | GPU合成与交互缓存生命周期 | N03-14, N03-05 | TODO | — |
| N03-16 | 播放基础矩阵与帧／音频一致性验证 | N03-12, N03-13, N03-08 | IN_PROGRESS（测量矩阵本体已交付并在**真实 Chromium + 真实 MP4** 跑通，3 夹具全 PASS；真机/长片/预渲染路径与音频偏移未覆盖） | [`验证`](../verification/N03-16.md) |

### N04

| 任务 | 标题 | 依赖 | v0.4 状态 | 证据 / 交接 |
|---|---|---|---|---|
| N04-01 | 共看片室壳与项目默认路由 | N00-05, N03-08 | TODO | — |
| N04-02 | 结构化对象命中注册 | N01-04, N03-05, N04-01 | IN_PROGRESS（s1 命中契约+覆盖层已交付；真实画布挂载/注册/高DPI目检未完成） | [`验证(s1)`](../verification/N04-02-s1.md) · [`交接(s1)`](../handoffs/N04-02-s1.md) |
| N04-03 | 点击、悬浮、框选与组合选择 | N04-02 | TODO | — |
| N04-04 | 时间范围、逐帧和音频目标 | N04-01, N03-04, N03-07 | IN_PROGRESS（s1 换算层+组件；**主体：真实片段/轨道投影 + 时间选择→对象解析 + jsdom 渲染证据已交付**；逐帧 UI/双时间码/说话句段与音乐 region 指向/空间×时间应用层组网未做） | [`验证`](../verification/N04-04.md) · [`交接`](../handoffs/N04-04.md) · [`验证(s1)`](../verification/N04-04-s1.md) |
| N04-05 | AttentionSnapshot与事件缓冲 | N04-03, N04-04, N01-09 | IN_PROGRESS（契约+有界缓冲+轨迹最小保留已交付；录制器接线/真实语音时钟未接） | [`验证`](../verification/N04-05.md) · [`交接`](../handoffs/N04-05.md) |
| N04-06 | 指代解析与源视频区域锚点 | N04-05, N02-06 | TODO | — |
| N04-07 | 按需专业控制与直接操作共用协议 | N04-01, N03-03, N03-05, N01-09 | TODO | — |
| N04-08 | 无障碍与真实指点旅程 | N04-03, N04-04, N04-06, N04-07 | TODO | — |
| N04-09 | SelectionAnchor归一与旧Attention兼容 | N04-05, N01-10 | IMPLEMENTED_UNVERIFIED（2026-10-11 由 VERIFIED 回调：自身验收证据保留且有效，但依赖 N04-05 仍为 IN_PROGRESS，按 AGENTS.md 启动步骤 4 不计完成；N04-05 转 VERIFIED 后复核即可恢复，见 `scripts/spec-check.mjs`） | [`验证`](../verification/N04-09.md) · [`交接`](../handoffs/N04-09.md) |
| N04-10 | 刷新、嵌套与时序变更后的锚点恢复 | N04-09, N04-06, N03-12 | IN_PROGRESS（服务端自动恢复+幂等+并发保护+时序重投影+嵌套失效已交付；UI/真实浏览器未做） | [`验证`](../verification/N04-10.md) · [`交接`](../handoffs/N04-10.md) |
| N04-11 | Smart Timeline与共用命令／Inspector入口 | N04-07, N01-11 | TODO | — |

### N05

| 任务 | 标题 | 依赖 | v0.4 状态 | 证据 / 交接 |
|---|---|---|---|---|
| N05-01 | 实时会话与短期凭证适配 | N01-09, N04-05 | **IN_PROGRESS**（会话/凭证/权限/过期撤销 + 流式协议状态机已交付并验证；真实 WebRTC/流式 ASR 待凭据） | [`验证`](../verification/N05-01.md) · [`交接`](../handoffs/N05-01.md) |
| N05-02 | 语音采集、转写与时间对齐 | N05-01, N04-05 | IN_PROGRESS（采集状态/能力协商/时间对齐协议与浏览器采集已交付；真实 VAD/流式 ASR 未接） | [`验证`](../verification/N05-02.md) · [`交接`](../handoffs/N05-02.md) |
| N05-03 | VAD、回声与用户声源边界 | N05-02 | TODO | — |
| N05-04 | 语音与制作任务分离的取消协议 | N05-03, N01-09 | TODO | — |
| N05-05 | 会话断网重连与去重恢复 | N05-02, N05-04 | TODO | — |
| N05-06 | AI提问与短回应策略 | N05-03, N04-06 | TODO | — |
| N05-07 | 实时能力与费用可见性 | N05-01, N05-04 | TODO | — |
| N05-08 | 真实语音端到端验收 | N05-05, N05-06, N05-07, N04-08 | TODO | — |

### N06

| 任务 | 标题 | 依赖 | v0.4 状态 | 证据 / 交接 |
|---|---|---|---|---|
| N06-01 | Proposal与私有候选分支 | N01-08, N03-08 | VERIFIED | [`验证`](../verification/N06-01.md) · [`交接`](../handoffs/N06-01.md) |
| N06-02 | 提案预检与原子采用 | N06-01, N01-07 | VERIFIED | [`验证`](../verification/N06-02.md) · [`交接`](../handoffs/N06-02.md) |
| N06-03 | 影响集、陈旧提案与rebase | N06-02 | VERIFIED | [`验证`](../verification/N06-03.md) · [`交接`](../handoffs/N06-03.md) |
| N06-04 | 局部试片缓存与依赖失效 | N06-01, N03-08 | VERIFIED（依赖键缓存 + 命中复用 + 失效/清理 + TTL/容量/保留清理/可观测） | [`验证`](../verification/N06-04.md) · [`交接`](../handoffs/N06-04.md) |
| N06-05 | 采用、继续微调、拒绝与部分采用 | N06-02, N06-04 | VERIFIED | [`验证`](../verification/N06-05.md) · [`交接`](../handoffs/N06-05.md) |
| N06-06 | 提案替代、取消与晚到结果 | N06-01, N06-04 | VERIFIED | [`验证`](../verification/N06-06.md) · [`交接`](../handoffs/N06-06.md) |
| N06-07 | 已确认内容保护与回归指纹 | N06-03, N06-05 | VERIFIED（三轴指纹 + 回归报告 + 意外移位阻止自动采用 + "其他别动"总时长守卫接入规划器；保护范围仅 CLIP，字幕/音频区域/视觉对象显式 501） | [`验证`](../verification/N06-07.md) · [`交接`](../handoffs/N06-07.md) |
| N06-08 | A/B比较、局部循环与版本恢复 | N06-04, N06-05, N04-04 | IN_PROGRESS（对照载荷 + 内容锚点对齐 + **回放计划** + **可见 A/B 面板**已交付并验证；未挂真实播放器/画布与真实浏览器证据；恢复复用 N01-08） | [`验证`](../verification/N06-08.md) · [`交接`](../handoffs/N06-08.md) |
| N06-09 | 多轮收敛端到端验收 | N06-06, N06-07, N06-08, N04-08 | TODO | — |
| N06-10 | Preview Branch双日志与拒绝语义 | N06-01, N01-08 | TODO | — |
| N06-11 | 预览采用单事务、重试与并发证明 | N06-10, N06-02, N06-03, N06-06 | TODO | — |

### N07

| 任务 | 标题 | 依赖 | v0.4 状态 | 证据 / 交接 |
|---|---|---|---|---|
| N07-01 | CreativeBrief与最少提问 | N01-02, N02-06 | TODO | — |
| N07-02 | 创作诊断与方案规划 | N07-01, N06-01 | TODO | — |
| N07-03 | 素材／生成选择与硬约束编译 | N07-02, N01-06 | TODO | — |
| N07-04 | 领域工具授权与结果观测 | N07-03, N06-02 | TODO | — |
| N07-05 | 三层决策笔记与采用绑定 | N06-05, N07-01 | TODO | — |
| N07-06 | 上下文编译与会话续作 | N07-05, N04-05 | TODO | — |
| N07-07 | 笔记可见性、纠错和删除 | N07-05, N04-01 | TODO | — |
| N07-08 | 导演与记忆综合回归 | N07-04, N07-06, N07-07, N06-09, N07-11, N07-12, N07-13 | TODO | — |
| N07-09 | Agent Tool Registry与可用能力投影 | N07-04, N01-11 | TODO | — |
| N07-10 | 持久Conversation Session与有限Agent执行 | N07-09, N06-11, N04-09, N07-06 | TODO | — |
| N07-11 | 五工具交互垂直切片实测 | N07-10, N03-02, N03-05, N03-07, N06-08, N04-11 | TODO | — |
| N07-12 | 决策笔记的拒绝依据与策略影响 | N07-05, N07-07, N06-11 | TODO | — |
| N07-13 | Agent上下文与MediaIndex证据预算 | N07-10, N02-15 | TODO | — |

### N08

| 任务 | 标题 | 依赖 | v0.4 状态 | 证据 / 交接 |
|---|---|---|---|---|
| N08-01 | 现有Provider审计与能力补齐 | N07-03, N00-03 | TODO | — |
| N08-02 | 程序化动效生成与可编辑对象 | N08-01, N01-04, N04-02 | TODO | — |
| N08-03 | 声音录入、Speech Director与原声并存 | N08-01, N07-05 | TODO | — |
| N08-04 | 可选数字人录入与镜头生成 | N08-01, N07-05 | TODO | — |
| N08-05 | 图像／视频／音乐／音效局部制作 | N08-01, N06-04 | TODO | — |
| N08-06 | 身份、产品和风格连续性 | N08-03, N08-04, N08-05 | TODO | — |
| N08-07 | 受控生成式局部修改 | N08-05, N04-06, N01-07 | TODO | — |
| N08-08 | 三模式真实制作验收 | N08-02, N08-03, N08-04, N08-05, N08-06, N08-07, N06-09 | TODO | — |
| N08-09 | RegenerateRegion时空契约与保护区域 | N08-07, N01-11 | TODO | — |
| N08-10 | 区域修复报价、异步资产与来源绑定 | N08-09, N13-10, N13-04 | TODO | — |

### N09

| 任务 | 标题 | 依赖 | v0.4 状态 | 证据 / 交接 |
|---|---|---|---|---|
| N09-01 | 全片预览与增量缓存依赖 | N03-10, N06-04 | TODO | — |
| N09-02 | ReviewSession与批准失效 | N09-01, N06-07, N07-05 | TODO | — |
| N09-03 | FrozenManifest与确定性正式合成 | N09-02, N01-08 | TODO | — |
| N09-04 | 技术QA读真实输出 | N09-03 | TODO | — |
| N09-05 | 声画／叙事模型QA与人工复核 | N09-04, N07-04 | TODO | — |
| N09-06 | 封面、字幕、母版包与多规格 | N09-03, N03-07 | TODO | — |
| N09-07 | 合成中断恢复与结果验收状态 | N09-03, N09-04 | TODO | — |
| N09-08 | G1/G2完整发布门验证 | N09-05, N09-06, N09-07, N05-08, N07-08 | TODO | — |
| N09-09 | 共享RenderPlan与混合后端分区 | N01-09, N03-11, N09-03 | IN_PROGRESS（V5-M4：内核 `compileRenderPlan` 编译唯一 RenderPlan，planHash 对同一内容稳定、不支持需求显式 501；预览快照/合成计划/FFmpeg 终渲染共用。冻结 ProjectDocument 输入（依赖 N09-03）、色彩与 graphics/预渲染子图分区未做） | [V5-M4 证据](../verification/V5-M4.md) |
| N09-10 | FFmpeg媒体图与Remotion图形合成后端 | N09-09, N09-04, N03-08 | IN_PROGRESS（V5-M4：FFmpeg 受限参数化媒体图——多层合成/变换/裁切/透明度/增益/等功率淡变/声像，侧载字幕；真实编解码一致性用例通过。Remotion 图形层（alpha）、字幕烧录与技术 QA（N09-04）未做） | [V5-M4 证据](../verification/V5-M4.md) |
| N09-11 | 浏览器预览与混合终渲染逐能力对照 | N09-10, N03-16 | IN_PROGRESS（V5-M4：同一 RenderPlan 的 baseline 投影与 FFmpeg 终渲染逐帧源帧号相等、音频起点/增益/声像/等功率淡变对照通过（精简集）；真实浏览器呈现侧对照与全能力矩阵未做） | [V5-M4 证据](../verification/V5-M4.md) |

### N10

| 任务 | 标题 | 依赖 | v0.4 状态 | 证据 / 交接 |
|---|---|---|---|---|
| N10-01 | 类型策略与时间约束契约 | N07-03, N01-01 | TODO | — |
| N10-02 | 参考链接／文件获取与授权分级 | N02-07, N00-06 | TODO | — |
| N10-03 | 多模态参考分析与证据覆盖 | N10-02, N02-04, N02-05 | TODO | — |
| N10-04 | 剪辑节奏与声画事件对齐 | N10-03, N01-01 | TODO | — |
| N10-05 | 可编辑ReferenceBlueprint | N10-04, N01-04 | TODO | — |
| N10-06 | 可迁移DirectorStrategyPackage | N10-05, N10-01 | TODO | — |
| N10-07 | 策略编译、覆盖与项目例外 | N10-06, N07-03, N06-02 | TODO | — |
| N10-08 | 等效重建与跨内容评估 | N10-07, N09-04 | TODO | — |
| N10-09 | 策略库、管理后台与极简选择 | N10-08, N04-01 | TODO | — |
| N10-10 | 参考到新片再局部修改闭环 | N10-09, N06-09, N09-06, N10-13 | TODO | — |
| N10-11 | Editing DNA显式语法与统计字段 | N10-06, N02-15 | TODO | — |
| N10-12 | Workflow Recipe条件追问与可执行步骤 | N10-11, N10-07, N07-09 | TODO | — |
| N10-13 | 参考与素材共用索引的策略闭环 | N10-12, N10-03, N10-08 | TODO | — |

### N11

| 任务 | 标题 | 依赖 | v0.4 状态 | 证据 / 交接 |
|---|---|---|---|---|
| N11-01 | 高级关键帧、路径与嵌套动画 | N03-05, N06-02 | TODO | — |
| N11-02 | 完整时间重映射与速度曲线 | N03-03, N01-01 | TODO | — |
| N11-03 | 路径蒙版、分割、跟踪与校正 | N04-06, N01-04 | TODO | — |
| N11-04 | 生成式修复与对象编辑质量门 | N08-07, N11-03, N09-05 | TODO | — |
| N11-05 | 多机位同步与漂移模型 | N03-04, N02-05, N01-01 | TODO | — |
| N11-06 | 多机位导演与切角操作 | N11-05, N10-01, N06-02 | TODO | — |
| N11-07 | 色彩管理、调色与HDR | N02-02, N03-05, N09-03 | TODO | — |
| N11-08 | 专业音频处理与交付 | N03-06, N01-04, N09-04 | TODO | — |
| N11-09 | 专业字幕与跨画幅版式 | N03-07, N11-01, N09-06 | TODO | — |
| N11-10 | 局部语音替换与原始内容差异审阅 | N08-10, N08-03, N02-05 | TODO | — |
| N11-11 | 局部唇形与跳切桥接的连续性修复 | N11-10, N08-10, N11-03 | TODO | — |
| N11-12 | 画面局部修复、延长、补帧与替换 | N08-10, N11-03, N11-02 | TODO | — |
| N11-13 | 九类生成修复质量与不干扰总门 | N11-10, N11-11, N11-12, N11-04, N09-11 | TODO | — |

### N12

| 任务 | 标题 | 依赖 | v0.4 状态 | 证据 / 交接 |
|---|---|---|---|---|
| N12-01 | 稳定、追踪运动与重构画幅 | N11-03, N03-05 | TODO | — |
| N12-02 | 绿幕、混合模式、调整层与复杂合成 | N11-03, N11-07, N11-01 | TODO | — |
| N12-03 | 工程交换与损失可见性 | N01-03, N01-08, N09-06 | TODO | — |
| N12-04 | 专业容器、编码、图像序列与母版 | N02-02, N11-07, N11-08, N09-06 | TODO | — |
| N12-05 | 特殊制作与空间媒体能力 | N12-04, N12-02 | TODO | — |
| N12-06 | 多渲染后端与逐能力一致性 | N12-02, N11-02, N09-03 | TODO | — |
| N12-07 | 效果插件、模板兼容与高级可控入口 | N12-06, N08-02, N04-07 | TODO | — |
| N12-08 | 专业对照与完整差项验收 | N11-09, N11-06, N12-01, N12-03, N12-04, N12-05, N12-07, N11-13, N13-11 | TODO | — |

### N13

| 任务 | 标题 | 依赖 | v0.4 状态 | 证据 / 交接 |
|---|---|---|---|---|
| N13-01 | 新实体租户与授权回归 | N01-03, N00-06 | TODO | — |
| N13-02 | 提示注入、URL、媒体与生成代码防护 | N02-02, N04-05 | TODO | — |
| N13-03 | 完整用量与预算预留账本 | N01-09, N00-03 | TODO | — |
| N13-04 | 任务公平、恢复与取消一致性 | N01-09, N13-03 | TODO | — |
| N13-05 | 配额、引用式回收与灾备恢复 | N02-07, N01-08 | TODO | — |
| N13-06 | CI、浏览器E2E与部署回滚 | N00-06, N01-05, N03-10 | TODO | — |
| N13-07 | 隐私、身份、服务嵌入与授权上线审查 | N02-07, N08-01 | TODO | — |
| N13-08 | 观测、性能与故障用户体验 | N04-05, N06-01, N13-03, N13-04 | TODO | — |
| N13-09 | SaaS计费、后台与生产总门 | N13-01, N13-02, N13-03, N13-04, N13-05, N13-06, N13-07, N13-08, N09-08, N13-10, N13-12, N15-38 | TODO | — |
| N13-10 | 透明报价、耗时不确定性与重试退款协议 | N13-03 | TODO | — |
| N13-11 | 媒体缓存、GPU与分析任务隔离回归 | N03-15, N02-14, N13-02 | TODO | — |
| N13-12 | 增量依赖、操作覆盖与阶段门自动校验 | N00-07, N00-06, N01-11 | TODO | — |

### N14

| 任务 | 标题 | 依赖 | v0.4 状态 | 证据 / 交接 |
|---|---|---|---|---|
| N14-01 | 发布、导出交接与多产物回归 | N01-05, N09-06, N13-06 | TODO | — |
| N14-02 | CMS／RSS／Analytics／Finance兼容 | N01-05, N09-03, N13-06 | TODO | — |
| N14-03 | 桌面壳、缓存与可选本地处理 | N13-09, N12-06 | TODO | — |
| N14-04 | 手机共看片室与触控语音 | N13-09, N05-08, N04-08 | TODO | — |
| N14-05 | 团队协作、审阅与企业权限 | N06-03, N09-02, N13-01 | TODO | — |
| N14-06 | 策略／效果／输出扩展与商业授权 | N10-09, N12-07, N13-09 | TODO | — |
| N14-07 | 跨端和完整产品覆盖账本闭合 | N14-01, N14-02, N14-03, N14-04, N14-05, N14-06, N12-08, N14-08 | TODO | — |
| N14-08 | 跨端Playback与Agent能力协议复用 | N14-03, N14-04, N07-09, N03-16, N09-11 | TODO | — |

### N15

| 任务 | 标题 | 依赖 | v0.4 状态 | 证据 / 交接 |
|---|---|---|---|---|
| N15-01 | 运营范围、现有后台与权限实体盘点 | N00-01, N00-07 | VERIFIED | [`验证`](../verification/N15-01.md) · [`交接`](../handoffs/N15-01.md) |
| N15-02 | 管理员认证、多因素与生产会话 | N15-01, N00-03 | VERIFIED | [`验证`](../verification/N15-02.md) · [`交接`](../handoffs/N15-02.md) |
| N15-03 | 运营RBAC/ABAC与职责分离策略 | N15-02 | IN_PROGRESS | [`验证`](../verification/N15-03.md) · [`交接`](../handoffs/N15-03.md) |
| N15-04 | AdminAction预检、审批与幂等执行框架 | N15-03, N01-08 | TODO | — |
| N15-05 | 运营动作与敏感访问追加式审计 | N15-04 | TODO | — |
| N15-06 | 运营台导航、全局检索与详情框架 | N15-03, N15-05 | TODO | — |
| N15-07 | 经营与运行指标字典和事实层 | N15-01, N13-03 | TODO | — |
| N15-08 | 运营总览与异常钻取 | N15-06, N15-07 | TODO | — |
| N15-09 | 增长漏斗、cohort与制作质量分析 | N15-07, N15-08 | TODO | — |
| N15-10 | 用户中心与受控账号生命周期 | N15-06, N15-04 | TODO | — |
| N15-11 | 工作区、成员、席位与客户管理入口 | N15-10, N15-03 | TODO | — |
| N15-12 | 客服工单、时间线与脱敏诊断包 | N15-06, N15-10 | TODO | — |
| N15-13 | 限时支持访问与禁止冒充用户 | N15-12, N15-04, N15-05 | TODO | — |
| N15-14 | 项目版本、媒体依赖与故障诊断 | N15-12, N01-08, N02-07 | TODO | — |
| N15-15 | 任务DAG、队列和attempt详情 | N15-06, N13-04 | TODO | — |
| N15-16 | 幂等任务恢复、取消与死信操作 | N15-15, N15-04, N15-05, N13-03 | TODO | — |
| N15-17 | 供应商目录、健康与路由配置运营 | N15-06, N15-04 | TODO | — |
| N15-18 | 凭据生命周期与write-only轮换 | N15-17, N15-03, N15-05 | TODO | — |
| N15-19 | 套餐、价格、权益和试用规则管理 | N15-06, N15-04, N13-03 | TODO | — |
| N15-20 | 订单订阅、续费与权益事件运营 | N15-19, N15-10 | TODO | — |
| N15-21 | Credits、预算预留与用量追账台 | N15-06, N15-04, N13-03 | TODO | — |
| N15-22 | 退款、拒付与支付差异对账 | N15-20, N15-21, N15-04 | TODO | — |
| N15-23 | 全成本、单位经济性与财务导出 | N15-07, N15-21, N15-22 | TODO | — |
| N15-24 | 素材、配额、回收与依赖保护运营 | N15-06, N15-04, N13-05 | TODO | — |
| N15-25 | 隐私导出、删除、更正与下游证明 | N15-24, N15-04, N15-05, N15-13 | TODO | — |
| N15-26 | 声音、数字人授权与身份运营 | N15-13, N15-24, N15-04, N08-03, N08-04 | TODO | — |
| N15-27 | 内容审核、投诉、限制与申诉 | N15-13, N15-04, N15-05 | TODO | — |
| N15-28 | 策略、组件和Pack审核发布台 | N15-06, N15-04, N15-27, N10-09 | TODO | — |
| N15-29 | 模型、prompt、工具与质量回归台 | N15-06, N15-04, N07-09, N15-17 | TODO | — |
| N15-30 | 配置、功能开关、灰度与实验控制 | N15-04, N15-05, N15-07 | TODO | — |
| N15-31 | 通知模板、事务消息与授权触达 | N15-06, N15-04, N15-12 | TODO | — |
| N15-32 | 发布、CMS、Webhook与授权连接运营 | N15-15, N15-04, N15-18, N14-01 | TODO | — |
| N15-33 | 告警、事故、成本止损与runbook | N15-08, N15-16, N15-17, N15-21 | TODO | — |
| N15-34 | 环境、容量、备份与隔离恢复台 | N15-04, N15-05, N13-05, N13-06 | TODO | — |
| N15-35 | 开发者API、客户Key与事件诊断 | N15-18, N15-32 | TODO | — |
| N15-36 | 后台批量、敏感导出和下载审计 | N15-06, N15-04, N15-05 | TODO | — |
| N15-37 | O0最小安全运营台垂直验收 | N15-02, N15-03, N15-04, N15-05, N15-06, N15-08, N15-10, N15-12, N15-13, N15-14, N15-16, N15-17, N15-18, N15-21, N15-24, N15-33 | TODO | — |
| N15-38 | O1收费与治理运营验收 | N15-37, N15-11, N15-19, N15-20, N15-22, N15-25, N15-26, N15-27, N15-30, N15-31, N15-32, N15-34, N15-35, N15-36 | TODO | — |
| N15-39 | O2增长、策略和AI质量运营验收 | N15-38, N15-09, N15-23, N15-28, N15-29, N15-30, N15-31 | TODO | — |
| N15-40 | 运营全流程角色回归、runbook与最终交接 | N15-39, N15-36 | TODO | — |

### N16

| 任务 | 标题 | 依赖 | v0.4 状态 | 证据 / 交接 |
|---|---|---|---|---|
| N16-01 | 设计基线、语义token和禁用样式盘点 | N00-01 | VERIFIED | [`验证`](../verification/N16-01.md) · [`交接`](../handoffs/N16-01.md) |
| N16-02 | 外观偏好、系统主题与首屏初始化 | N16-01 | VERIFIED | [`验证`](../verification/N16-02.md) · [`交接`](../handoffs/N16-02.md) |
| N16-03 | 中文字体、数字排版与合法图标规范 | N16-01 | IN_PROGRESS | [`验证`](../verification/N16-03.md) · [`交接`](../handoffs/N16-03.md) |
| N16-04 | 单色共享组件全状态与键盘支持 | N16-02, N16-03 | TODO | — |
| N16-05 | 动效约束、降低动画与性能基线 | N16-04 | TODO | — |
| N16-06 | 共看片室、语音与试改界面迁移 | N16-04, N16-05, N04-01 | TODO | — |
| N16-07 | 专业时间轴、Inspector与选区样式迁移 | N16-04, N04-07, N04-09 | TODO | — |
| N16-08 | 运营台24模块视觉基础与审批流程迁移 | N16-04, N15-06 | TODO | — |
| N16-09 | Workspace设置、身份录入与付款风格统一 | N16-04, N15-11 | TODO | — |
| N16-10 | 数据可视化单色编码与媒体主题隔离 | N16-01, N16-02 | IN_PROGRESS | [`验证`](../verification/N16-10.md) · [`交接`](../handoffs/N16-10.md)；现有快照派生哈希已补证，官方 ProjectDocument hash 待 N01-02 |
| N16-11 | 跨主题真实浏览器与可访问性设计回归 | N16-05, N16-06, N16-07, N16-08, N16-09, N16-10, N00-06 | TODO | — |
| N16-12 | 全站视觉迁移账本、模块完整性与设计交接 | N16-11, N15-40, N12-08 | TODO | — |

## 完成边界

- `VERIFIED` 只证明对应 N 任务自身的验收；不会自动关闭其关联的全部 V03/V04 需求。
- 合同、E2E、真实 Provider、付费、视觉和媒体验收分别记录；`[PLANNED]`、Mock 与第三方实测不混同。
- 任何状态变更同时更新本表、`ai-native-v04-traceability.md`、任务验证和交接。
