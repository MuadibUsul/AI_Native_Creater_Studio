# 鼠标点线面 × 横向时间定位 × 流式语音：差距映射

**日期：** 2026-10-10　**需求来源：** `docs/V04/ANCS_v04_Mouse_Voice_Incremental_Design_20261010.md`（下称"增量设计"）+ `docs/V04/ANCS_Mouse_Voice_Codex_Prompt.md`
**代码基线：** `codex/v04-foundation`（本文件写作时 HEAD = `6a2dd16`，已远超增量设计审阅基线 `b469ade`；未回退、未覆盖任何后续实现）
**性质：** 差距映射与子任务划分。**不改变任何既有任务状态**；只有实际跑过的证据才升级状态。

## 0. 一句话结论

增量设计的核心（鼠标点线面几何 + 横向时间定位 + 低延迟流式语音 + 私有真实候选 + 原子采用）在**权威层几乎完全缺失**：`SelectionAnchor`／`AttentionSnapshot`／几何选择／意图修订／提案分支都没有实现（对应 N04-05、N04-09、N04-04、N06-* 仍为 TODO），但**它依赖的地基已经就位**（ProjectDocument v2、有理时基与源映射、视觉变换与命中换算、Edit Operation v2 与事务执行器、对象锁与影响集、历史/版本/预算、MediaIndex 与词条级转写、播放快照与服务端合成计划、Mock LLM 结构化补全 seam）。因此正确的推进方式是：**先统一选择与意图契约，再闭合一条垂直切片**，而不是先做后台或机械刷完 219 项。

## 1. 横向时间轴现状（"必须先查明并保留"）

| 事实 | 位置 | 判断 |
|---|---|---|
| 现有横向时间带 = `LiteTimeline`（P05-05，**场景制**：场景块 + reorder/move/trim/split/duplicate/delete/replace/transition/crop-scale/音量/字幕） | `apps/web/src/ui/LiteTimeline.tsx`（325 行），由 `components/quiet-frame/workflow-director.tsx` 挂载 | **保留，不重写**；它写回统一编辑协议（operations + 双 revision + 幂等键），本增量把它从"场景块"扩展为"片段/轨道块 + 播放头 + 时间选区" |
| 是否存在 v2（片段/轨道）时间线 UI | `grep composition\.clips` 在 `apps/web` 无命中 | **缺失**：v2 时间线 UI 属 N03-08 的 UI 接线与本增量的 N04-04/N04-11 补充验收 |
| 其它分支 | `codex/quiet-frame-rebuild` 与当前分支在 `apps/web` 有差异（净删除多于新增，且无时间线新增） | 未发现用户在别处的"新横向时间轴"；若用户在本地/工作树另加了时间轴，实施时应先 `git status`/看工作树，**以用户新增物为准，不覆盖** |
| 播放条 vs 时间选区 | `PreviewPlayer` 仅有播放（场景制），无独立播放头/选区模型 | **缺失**：属 N04-04 补充验收（区分播放头与时间选区） |

## 2. 逐条要求 → 现有实现 → 目标任务 → 状态

状态口径：**已实现**（有运行证据）、**部分**（地基在、缺口明确）、**缺失**（无实现）、**依赖真实 Provider**（凭据/设备不可得时保持未验证）。

### 2.1 点、线、面几何（增量设计 §3、§8.1）

| 要求 | 现有实现 | 目标任务 | 状态 |
|---|---|---|---|
| 点选"目标对象"而非屏幕坐标 | 片段/视觉对象/效果/字幕/音频区域皆有稳定 id；`hitTestVisualObject`/`projectVisualPoint`/`invertVisualPoint`（N03-05）已能做裁切/旋转后的命中换算 | **N04-09-s1**（契约）+ N04-02 | **部分**：几何命中纯函数在，缺"选择"契约与画布交互 |
| 线必须保存用途（路径/边界/起终点） | 无 | N04-03-s1（线用途）+ N04-06-s2（多边形/笔刷） | **缺失** |
| 面区分固定区域 vs 跟随对象（`regionMode`） | 无（`timeBinding` 已有 CLIP_LOCAL/SOURCE/SEMANTIC_CUE 先例可对齐） | N04-09-s1 + N04-06-s3 | **缺失** |
| 线/面不得压成矩形或交给 prompt 猜 | 无 | N04-03-s1（严格判别联合 + 用途必填） | **缺失** |
| 几何合法性（有限数/范围/点数/自交/退化） | `visualCropSchema` 有类似非空约束先例 | N04-09-s1 | **缺失** |

### 2.2 横向时间定位（§4）

| 要求 | 现有实现 | 目标任务 | 状态 |
|---|---|---|---|
| 四类定位（播放头/时间点/连续区间/多区间） | 有理时基 `mediaTimeSchema` + 半开 `mediaRangeSchema` + `compareMediaTime`；`segments`/`clips` 已有 sequenceRange | N04-04-s1 | **部分**（时间类型完备，缺"选区"模型与 UI） |
| 时空联合选择（空间几何 × 时间范围 × 轨道 × 属性 × 版本） | `editOperationSchema` + `operationImpacts` + 对象锁维度（CONTENT/POSITION/DURATION/TRACK/STYLE/ASSET）已能表达"作用范围" | **N04-09-s1**（SelectionAnchor 承载作用域）+ N04-04-s2 | **部分** |
| 源时间与序列时间区分 | `sourceRange` vs `sequenceRange` + `timeMapping`（N01-03/N03-*） | 复用，无新任务 | **已实现** |

### 2.3 共同注意力与指代（§5、§8.2、§8.3）

| 要求 | 现有实现 | 目标任务 | 状态 |
|---|---|---|---|
| `SelectionAnchor` 归一（`geometries[]`/`orderedTargetRefs`/`temporalSelection`/`trackScope`/`regionMode`/`timeBindingPolicy`/`trackingRef`/`remapHistory`） | **无任何实现**（全仓库无 selectionAnchor/attentionSnapshot 代码） | **N04-09-s1**（本次首要）+ N04-05 | **缺失**（地基：对象 id 与版本、命中换算、时间类型齐备） |
| `AttentionSnapshot`（含短时事件缓冲、发话时钟） | 无 | N04-05-s1 | **缺失** |
| `IntentRevision`（sessionId/utteranceId/intentId/revision、targetBindings、status DRAFT→SEALED→SUPERSEDED/CANCELLED、supersedes） | 最近的先例是 N03-09 的 `range-edit` 计划（操作 + 越界说明 + revision + 零媒体调用） | **N05-01-s1** + N05-02 | **缺失**（可复用 range-edit 计划的校验骨架） |
| 事件信封（eventId/sessionId/clockEpoch/seq/utteranceId/intentRevision/proposalRevision/causationId） | `edit_events` 有项目内 `seq` 与 `compensatesEventId`（undo 链）；无会话/时钟维度 | N05-03-s1 + N05-04 | **部分** |
| 多对象指代（"这两个""中间那个"） | 无 | N05-02-s1 | **缺失** |

### 2.4 流式语音（§6、§7）

| 要求 | 现有实现 | 目标任务 | 状态 |
|---|---|---|---|
| 真流式（部分转写/修订/草稿状态），非"整段上传后才理解" | 仅有"整段音频 → 转写"链路（N02-05 worker 侧），无流式会话 | N05-01-s1 | **缺失** |
| 三条执行通道（本地即时反馈 / 私有试改 / 正式编辑）分离 | 正式编辑通道完备（统一编辑协议）；本地反馈与私有试改无 | N05-01-s1 + N06-01-s1 | **缺失** |
| 能力协商（按适配器真实能力，不假定同一 VAD/时间戳） | LLM/ASR/TTS 适配器接口 + 能力声明先例（`LlmAdapter.completePrompt?` 可选 → 未实现即 501） | N05-02-s2 | **部分**（模式在，语音能力面未建） |
| 真实麦克风采集与低延迟 | 无（`apps/web` 无 MediaRecorder/AudioWorklet） | N05-01-s1（浏览器侧） | **缺失 + 依赖真实环境** |
| VAD/ASR 真实 Provider | 无凭据 → 保持未验证 | N05-01/N05-02 | **依赖真实 Provider** |
| partial transcript 只读准备、不得改动确认工程 | 编辑协议天然只在 Apply 时写库（计划不落库，N03-09/P05-06 已验证） | 复用；N05-01-s1 明确"未 SEALED 不写" | **部分** |
| 否定/半句话/改口/断句/三类取消（停止播报/取消生成/取消采用） | 无 | N05-03-s1 + N05-04-s1 | **缺失** |
| 回声与自激防护（片中字幕/参考视频/AI 声音不得成为授权） | 无 | N05-04-s2 | **缺失** |

### 2.5 私有候选与原子采用（§8.5、§9）

| 要求 | 现有实现 | 目标任务 | 状态 |
|---|---|---|---|
| 提案/预览分支（create/commit/discard preview branch） | v2 注册表已有三个 `PLANNED` 条目（`supportedBackends: ['PROPOSAL_SERVICE']`）——**只有契约占位，无实现** | N06-01-s1 | **缺失**（seam 已定） |
| 确定性私有试改（不触碰确认版） | 编辑事务 + 版本快照 + undo/redo 齐备；"试改"层无 | N06-02-s1 | **缺失** |
| 采用绑定（baseProjectRevision + intentRevision + selectionFingerprint + operationsHash + assetVersionRefs + proposalRevision）并由服务端重验 | 幂等键 + 请求摘要 + 双 revision 校验已实现（P02-02 起）；缺 intentRevision/selectionFingerprint/proposalRevision 维度 | N06-04-s1 | **部分** |
| 晚到结果不得抢回新画面、取消有代际隔离 | 无（补偿事件有谱系，但无"代际"概念） | N05-04-s1 + N06-06-s1 | **缺失** |
| 成本/预算/外部任务守门 | 预算与费用账本、Provider 调用计数已实现（P-series/N06-* 部分） | 复用；N05-05-s1 补会话费用与取消状态 | **部分** |

### 2.6 呈现与精度（§2、§10、§11、§13）

| 要求 | 现有实现 | 目标任务 | 状态 |
|---|---|---|---|
| 大画布 + 紧凑横向时间带 + 一条可打断对话栏（黑白极简、按需展开） | 画布风格已按 v0.4 黑白语义层迁移（N16-01/02）；现有时间带是场景制 `LiteTimeline` | 复用 + N04-02-s1（画布交互） | **部分** |
| 播放与真实预览（连续播放，不用静态截图） | 播放快照 + 服务端合成计划（N03-08）；PlaybackEngine 生命周期属 N03-11 | N03-11（既有）+ N04-08 | **部分** |
| 性能指标只作建议目标，不得写死伪造数据 | — | N04-08-s1（真实测量 p50/p95 起止） | **待测量** |
| 隐私：麦克风可见开关、最小保留、内容/命令隔离 | 无语音采集 | N13 相关 + N05-04-s2 | **缺失** |

## 3. 新增子任务（不重编号既有任务）

编号规则：`<既有任务>-s<n>`。状态一律从 TODO 起算，只有拿到证据才升级。

| 子任务 | 归属既有任务 | 内容 | 最小证据 | 依赖 |
|---|---|---|---|---|
| N04-09-s1 | N04-09 | **统一契约**：`GeometrySelection`（点/线/矩形/多边形/笔刷 × 目标/路径/边界/起点终点/保护/排除）、`SelectionAnchor` 增量、`IntentRevision`；严格判别联合 + 合法性（自交/退化/越界） | ✅ **契约层已完成（2026-10-10）**：`packages/contracts/src/selection.ts` + 8 项单测（见 `docs/verification/N04-09-s1.md`）；持久化与旧 Attention 兼容仍在 N04-09 主体 | 无 |
| N04-05-s1 | N04-05 | `AttentionSnapshot`（含短时事件缓冲、发话时钟、`evidenceRefs`、`remapHistory`） | 事件缓冲窗口与重映射测试 | N04-09-s1 |
| N04-02-s1 | N04-02 | 画布原生对象命中与点选/框选、覆盖层绘制、手势隔离 | 真实浏览器点选 + 高 DPI 截图对照 | N04-09-s1 |
| N04-04-s1 | N04-04 | 时间点/连续/多区间、轨道与属性作用域、**播放头与时间选区分离** | 帧/源时间映射 + 多轨联合选择测试 | N04-09-s1 |
| N04-03-s1 | N04-03 | 线用途语义（路径/边界/起终点）与多边形/笔刷几何 | 真实旅程：路径/边界/圈选不混淆 | N04-04-s1 |
| N05-01-s1 | N05-01 | 真流式会话骨架（浏览器侧持续采集 + 服务端会话 + 转写修订事件），未 SEALED 不写库 | 真麦克风 + partial transcript + 延迟 trace（缺凭据时明确未验证，用确定性本地夹具只验证协议与状态机，不宣称"语音已通"） | N04-09-s1 |
| N05-02-s1 | N05-02 | 指代解析与能力协商（按真实适配器文档） | 能力矩阵 + 未支持能力 501 | N05-01-s1 |
| N05-03-s1 | N05-03 | 否定/半句话/断句与 `IntentRevision` 修订链 | 改口后旧结果不覆盖 | N05-01-s1 |
| N05-04-s1 | N05-04 | 回声/自激防护、三类取消、晚到隔离（代际） | 乱序回调与取消测试 | N05-03-s1 |
| N06-01-s1 | N06-01 | 私有真实候选（preview branch 落地，替换 v2 的 PLANNED 占位） | 确认版在试改期间逐字节不变 | N04-09-s1 |
| N06-02-s1 | N06-02 | 确定性私有试改 + 局部回放 | 同一选择 + 同一意图 → 同一操作集 | N06-01-s1 |
| N06-04-s1 | N06-04 | 原子采用（绑定 revision/intent/selection/operationsHash/proposalRevision 后服务端重验） | 版本冲突不写入、失败不显示"已采用" | N06-02-s1 |
| N04-08-s1 | N04-08 | 垂直切片真实验收（点选→横向选段→说改→试改→打断纠正→采用→局部回放） | 真素材 + 真浏览器 + 延迟 p50/p95 测量起止 | 上述全部 |

## 4. 推进次序（与增量设计 §12 一致，按真实依赖裁决）

1. **N04-09-s1 契约统一**（本次立即开工；`GeometrySelection`/`SelectionAnchor`/`IntentRevision` 三件套 + 单测）。
2. 并行：**N04-02-s1 画布命中**、**N04-04-s1 横向时间**（两者都只依赖 s1 契约，且互不共享文件）、**N05-01-s1 流式会话骨架**。
3. 随后：**N06-01-s1/N06-02-s1/N06-04-s1** 候选与采用链（复用统一编辑协议与预览分支 seam）。
4. 最后：**N05-03-s1/N05-04-s1** 改口与取消、**N04-03-s1** 线面语义、**N04-08-s1** 端到端真实验收。

**第一条必须闭合的路径**（不可被后台工作插队）：
真实素材 → 点选对象 → 横向选时段 → 说一句修改 → 流式反馈 → 私有真实预览 → 打断并纠正 → 原子采用。

## 5. 与既有计划的关系

- 既有 N 系列任务继续按账本推进（当前 N03 已 8/16）；本增量的子任务**挂在既有任务上**，不新建平行账本。
- `N03-09`（范围编辑最小 AI 入口）与本增量天然衔接：它产出的"结构化操作 + 越界说明 + revision + 零媒体调用"计划，正是 `IntentRevision` 的落点。N03-09 完成后，`planRangeEdit` 应成为 `IntentRevision → 操作集` 的一条既有路径，而不是第二套协议。
- 真实 Provider（流式 ASR/VAD、视觉跟踪）在拿到凭据前保持 `UNVERIFIED_CREDENTIALS_REQUIRED`；协议、状态机与本地确定性夹具可以先做并验证，但**不得**据此声称"真实语音/真实跟踪已通"。

## 5.1 进度记录

- **2026-10-10**：`N04-02-s1`（画布原生对象命中）与 `N04-04-s1`（横向时间带）子任务**首批交付**（均 `IN_PROGRESS`，不计入主任务完成）：
  - `packages/contracts/src/timeline-band.ts`：可视窗口→有理时基换算（非浮点毫秒权威）、播放头/时间选区分离、单击 POINT / 拖动半开 RANGES、显式多区间不合并、帧吸附坍缩降级、区间上限 fail-closed；
  - `packages/contracts/src/visual-picking.ts`：复用 `hitTestVisualObject`，zOrder→细粒度→输入顺序，隐藏/父隐藏排除，重叠轮换，投影四边形；
  - `packages/contracts/src/selection.ts` 新增 `composeSelectionAnchor`（交互产物→规范锚点+指纹，选择不改工程）；
  - Web 新增 `TimelineBand` / `CanvasInteractionLayer`，并在 `LiteTimeline`（**保留、扩展**）与 `WorkflowDirector`「展开轻时间线」内可选接线；
  - 证据：契约 18 项、jsdom 11 项、`pnpm verify` 14/14（1180/1180）；**真实浏览器/高 DPI 目检、v2 片段轨道投影与锚点持久化/恢复未做**（待 N04-01/N04-10）。

- **2026-10-10**：`N04-05`（AttentionSnapshot 本体）权威契约 + 有界缓冲交付（`IN_PROGRESS`）：`packages/contracts/src/attention.ts` 覆盖本地单调时钟 + 会话 epoch、11 类共同注意力事件（含 `PRESENTED_FRAME` 真实呈现帧与 `VOICE_CLOCK` 语音时钟）、有界事件缓冲（默认 8s/512，epoch/单调时钟回退/seq 违反 fail-closed）、鼠标轨迹最小保留（最小距离去样 + 点数上限）与快照导出（缺词级时间时 `wordTimingAvailable=false`）。证据：`docs/verification/N04-05.md`（9 项）、`docs/handoffs/N04-05.md`；`AttentionRecorder` 接线、真实语音时钟映射与服务端按发话时观看记录定位未做（属 N05-02/垂直切片）。

- **2026-10-10**：`N03-09`（范围编辑最小 AI 入口）已完成并推送（`7881bf9`）——它的"结构化操作 + 越界说明 + revision + 零媒体调用"计划是本增量 `IntentRevision` 的既有落点，后续接流式语音时**复用该路径**。
- **2026-10-10**：`N04-09-s1` 契约层完成（`packages/contracts/src/selection.ts` + 8 项单测，见 `docs/verification/N04-09-s1.md`）：点线面几何 × 时间选择 × SelectionAnchor × IntentRevision 已统一；`SelectionAnchor` 持久化/兼容（N04-09 主体）、画布（N04-02）、时间带（N04-04）、流式会话（N05-01）尚未开始。
- **基础设施**：CI 已安装 FFmpeg；真实媒体用例按套件定义从 unit 迁到 integration（`a76dc66`）。

## 6. 待用户裁决的最小问题

1. 横向时间轴是否就是 `apps/web/src/ui/LiteTimeline.tsx`（场景制），还是你在本地另有未提交实现？若有，请指出路径；实施将以其为基线保留并扩展。
2. 流式语音首批目标：先只做**浏览器侧采集 + 协议/状态机 + 本地确定性夹具**（不接真实 ASR），还是你已能提供 ASR/VAD 凭据以便同批接真实 Provider？
