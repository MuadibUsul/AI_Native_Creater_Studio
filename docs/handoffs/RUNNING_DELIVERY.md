# 持续交付与接手总表（RUNNING DELIVERY）

> 用途：**每次完成一部分就在这里追加一条**；上下文窗口切换、换人接手、或定时任务接手时，先读本文件即可知道"做到哪、下一步做什么、怎么验证"。
> 详细证据仍在 `docs/verification/<taskId>.md`，交接细节在 `docs/handoffs/<taskId>.md`；本文件只做**总览与续跑指令**。

**最后更新：** 2026-10-10（第五组：N04-04 主体投影与时间选择→对象；第四组为 N06-04 收口）
**分支：** `codex/v04-foundation`（不推 main）
**当前 HEAD：** 见文末"提交序列"最后一行
**账本：** `docs/requirements/ai-native-v04-acceptance-ledger.md`（唯一进度口径）
**迁移：** 到 0086（`content_protections`）；**`db:generate` 已修复**（见第三节「基础设施」）
**交付节奏（2026-10-10 用户确认）：** **按组批量** —— 组内逐任务写 verification/handoff、跑定向套件；**组末统一跑一次全量 `pnpm verify` 并提交**。N06 收尾组已收口；**第二组（基础设施 + N06-07 收口）已完成**。

---

## 一、当前状态速览

| 维度 | 值 |
|---|---|
| 已完成任务（仅算 VERIFIED） | N00 7/7、N01 11/11、N02 15/15、**N03-01…09（9/16）**、**N04-09**、**N06-01／02／03／04／05／06／07**、N15-01/02、N16-01/02 = **54/219（24.66%）**；另有 **N05-01／N05-02／N04-05／N04-10／N04-02-s1／N04-04-s1／N06-08 已部分交付（IN_PROGRESS，不计入）** |
| 剩余 | 165 项 |
| 本地 `pnpm verify` | **14/14，1297/1297**（第五组组末实测；Unit 518 / Web 191 / Motion 25 / Integration 518 / Security 24 / Render 6 / Golden 15）（另有独立 `pnpm test:eval`：意图评测 102 用例通过） |
| 未通过的总门 | G0—G4、O0、D0/D1 全部未过（任务项完成 ≠ 可交付） |
| 增量设计（关键需求） | 设计 + 差距映射已就绪；首批契约已落地；垂直切片尚未闭合 |

---

## 二、本轮连续交付（按时间倒序追加）

### 2026-10-10 · 第五组 · N04-04 主体（真实片段/轨道投影 + 时间选择→对象）— **IN_PROGRESS**
- **内容：** 新增契约 `packages/contracts/src/timeline-projection.ts`：`projectSequenceToTimeline`（真实轨道/片段 → 车道与几何；有理时基换算；越界如实标 `clippedLeft/Right`；零宽不进 segments 但列入 `outsideViewportClipIds`；孤儿片段列入 `orphanClipIds` 不静默丢弃）、`clipsInTemporalSelection`（POINT 半开区间命中；RANGES 区分完整覆盖/部分相交，**不合并显式多区间**；支持轨道作用域）、`pointSelection`；Web 侧新增 `projectionToBandLanes` 适配器把权威投影喂给既有 `TimelineBand`（只做形状映射，几何只算一次）。
- **证据：** `docs/verification/N04-04.md`（契约 9 项单测 + jsdom 3 项：真实片段渲染与投影可见集合一致 / 点击发 clipId / 窗外片段不渲染但仍在数据里）· `docs/handoffs/N04-04.md`
- **为何不是 VERIFIED：** 逐帧步进 UI 与分数帧率用例、源/序列双时间码、说话句段与音乐 region 的语义指向、空间×时间在应用层的组装、真实浏览器高 DPI 目检（N04-01）均未做。
- **下一步：** 见第三节。


### 2026-10-10 · 第四组 · N06-04 收口 — **VERIFIED**
- **内容：** `proposals.ts` 新增 `PROPOSAL_TRIAL_TTL_HOURS=24` / `PROPOSAL_TRIAL_MAX_PER_PROJECT=50`（可由 `deps.retention` 覆盖）；`loadCachedTrial` **忽略过期行**；`storeTrial` 写入后按最旧淘汰超出容量的行；新增 `proposalTrialCacheStats`；`runRetentionSweep` 新增第 8 步清理过期试片并计入 `proposalTrialCachePurged`；HTTP `GET .../proposal-trial-cache` + SDK。
- **证据：** `docs/verification/N06-04.md`（集成 4 项：TTL 过期不复用 / 容量按最旧淘汰 / retention 清理 / 默认策略经 HTTP 暴露）· `docs/handoffs/N06-04.md`
- **为何转 VERIFIED：** 原缺口（无 TTL/容量、无跨实例策略、无可观测）已补齐；**跨实例**由"依赖键 + TTL + 容量"共同保证，不依赖实例本地状态。已知限制：无命中率计数器、无主动预热。
- **下一步：** 见第三节。


### 2026-10-10 · 第三组 · 外部评审响应（P0 修复 + 逐条核实）
- **背景：** 用户转来外部评审（`ANCS-改进建议.md`，基于说明快照、未读源码）。已**逐条核实**并只对"属实"项动手；完整结论见 `docs/decisions/0010-review-response-20261010.md`。
- **已修（均有测试证据）：** ①**意图识别重写**（P0-4，属实并已复现：「特别好，就用这个」曾被判成**丢弃**）：去单字标记、加否定/惯用语护栏、采纳先于泛化微调、支持复合意图（一律要求确认）、补 `confidence`/`evidence`，8 条复现用例全绿；②**意图评测集** 102 用例 + 准确率/误采纳率指标，独立 `pnpm test:eval`（当前准确率 100%、误采纳 0%）；③**沙箱环境隔离**（P0-1）：`{...process.env}` → `sandboxEnv()` 白名单 + `cwd=os.tmpdir()`；④**词法门补漏**：补 `.constructor` 点号形式与 `Reflect.*`/`setPrototypeOf` 逃逸；⑤**凭据密钥生产强制**（P0-2）：生产缺 `ANCS_CREDENTIAL_KEYS` 即启动失败、非生产改 HKDF 派生并告警、env schema 与 `.env.example` 同步；⑥**FFmpeg 协议收敛**：10 处输入点加 `-protocol_whitelist file,pipe`，真实 ffmpeg 集成 7/7 通过；⑦**仓库卫生**：删 3 个已提交 `.tmp-*.py`、`.gitignore` 补 `.tmp-*`、14 个文件的本机绝对路径清为零命中、`AGENTS.md` 新增三条禁止规则。
- **核实后判"不属实"（未改）：** `articleFetcher` 的 SSRF **已实现**（逐跳复检 + 私网/元数据拦截 + 5 MiB/15 s 上限），仅残留 DNS rebinding；签名 URL 已短时效 + 最小权限；无 `docs/ai-native-studio-v03-*` 分支；无 LICENSE 文件（`package.json` 为 `UNLICENSED`）。
- **剩余项 / 需你决策：** 见 0010 第三、四节（历史密钥扫描与轮换、LICENSE、陈旧分支删除、供应商与预算、Web 域/CORS/CSRF、部署形态）。
- **未按评审执行（我的判断）：** 转向单一楔子、冻结 P 系列、暂停商业化属**产品战略决策**；G0 的"FFmpeg 智能渲染"受 N03-16 与真实凭据阻塞，不宜提前声称完成。

### 2026-10-10 · 第二组 · 基础设施：修复 `db:generate` 快照冲突
- **问题：** `migrations/meta/0080_snapshot.json` 与 `0081_snapshot.json` 的 `id`/`prevId` 完全相同 → `drizzle-kit generate` 报 `are pointing to a parent snapshot … collision`，导致 0078—0086 的迁移全部只能手工编写 + 手改 journal（风险累积）。
- **修复：** 删除冲突的两份快照；用一次性脚手架配置在与当前 schema 一致的临时目录生成快照，改写为新 `id`、`prevId` 指向 0077 快照（保持链一致），落位为 `0085_snapshot.json`（对应 journal 末条 idx 85），随后删除脚手架。
- **验证：** `pnpm --filter @ancs/db run db:generate` → **`No schema changes, nothing to migrate`**（不再报冲突，也不再产出多余迁移）；`runMigrations`（journal + SQL）与全部集成测试不受影响。
- **教训：** 手工改迁移名时必须同步 `meta` 快照，否则下一次 `generate` 就会撞车；快照只影响 `generate`，不影响运行时迁移。

### 2026-10-10 · 第二组 · N06-07 收口（转 **VERIFIED**）
- **内容：** `resolveScopeGuard` 增 `exact` 语义（总时长变化**不可确定**时一律要求解释，**不得当作等长放行**）；`createRangeEditPlanRequestSchema` 增 `preservesEverythingElse`；`packages/contracts/src/range-edit.ts` 新增纯函数 `estimateRangeEditDurationDeltaMs`（由操作负载确定性估算：INSERT/APPEND 变长、涟漪 TRIM_* 按收缝量变短、涟漪 DELETE 与 delete_clip 无法确定 → `exact=false`）与 `rangeEditPlanSchema.lengthGuard`；`planRangeEdit` 回带守卫判定，`requiresExplanation` 时附 rationale（**计划本身不执行、不改工程**）。
- **证据：** `docs/verification/N06-07.md`（估算器 5 项单测 + 规划器端到端 1 项集成，新增 `range_edit_ripple` Mock 脚本）· `docs/handoffs/N06-07.md`　**verify：** 14/14（1265/1265）
- **为何转 VERIFIED：** 两条实现内容（三轴指纹/范围外报告、总时长守卫）与两条验收负面路径均有真实库证据；保护范围仅 CLIP 属**已知限制**（显式 501，不静默放过），不影响验收。
- **下一步：** 见第三节。

### 2026-10-10 · N06 收尾组收口（N06-05 / N06-07 / N06-08）— 组末全量 verify 14/14（1259/1259）
- **组内交付：** N06-05（`783ee0f`，VERIFIED）、N06-07（`aa9a52b`，IN_PROGRESS）、N06-08（本组末提交，IN_PROGRESS）。
- **组末证据：** `pnpm verify` = **14/14 通过**，Unit 494 / Web 188 / Motion 19 / Integration **513** / Security 24 / Render 6 / Golden 15。

### 2026-10-10 · N06-08 A/B 比较与差异标记 — **IN_PROGRESS**
- **内容：** 契约 `packages/contracts/src/proposal-compare.ts` + Domain `compareProposal`：右侧 = 候选**试改后真实执行结果**（事务内跑完回滚），左侧 = 当前确认版或缺省的另一候选；差异按三轴标记（ADDED/REMOVED/CHANGED/UNCHANGED）；**片段数/时长不同时按内容锚点对齐**（素材版本 + 嵌套序列 + 源区间），无法唯一对齐的锚点如实进 `unmatchedAnchors`；**回带双方实际 `assetVersionId`**（证明对照真资产而非重新生成）；对照零写入。HTTP `POST .../proposals/:proposalId/compare` + SDK。
- **证据：** `docs/verification/N06-08.md`（集成 3 项：与确认版对照并回带实际素材 / 片段数时长不同按锚点对齐 / 候选间 A/B 对照且不改工程）· `docs/handoffs/N06-08.md`
- **为何不是 VERIFIED：** 播放器侧"同一画布切换前后 / 音频 AB / 局部循环回放"与 UI 未做；版本恢复复用 N01-08 补偿事件（已 VERIFIED，无新增）；**依赖 N04-04 仅 s1 就绪（显式降级）**。
- **下一步（下一组）：** 见第三节「下一组计划」。

### 2026-10-10 · N06-07 已确认内容保护与回归指纹 — **IN_PROGRESS**
- **内容：** 迁移 0086 `content_protections`（保护记录，非第二份作品状态）。契约新增 `packages/contracts/src/content-protection.ts`：三轴指纹（CONTENT 源区间/映射/参数/源流、POSITION 轨道与序列区间、ASSET 素材版本/嵌套序列）、`confirmedContentRecordSchema`、`regressionReportSchema`（含 `outOfScope` 范围外变化）、**`resolveScopeGuard`**（"其他别动 + 总时长改变 → 先解释 / 改等长方案"）。Domain：`clipDigestsOf`、`captureConfirmedContent`、`checkConfirmedContent`、`assertProtectedContentStable`；`runDeterministicTrial` 现在返回**试改后状态指纹**，采用/部分采用的可选 `protectionIds` 用它判定"受保护对象被改动但非本批显式目标"的**附带变化/意外移位** → 409 `CONFIRMED_CONTENT_REGRESSION` 且零写入。HTTP/SDK 4 端点。
- **证据：** `docs/verification/N06-07.md`（范围守卫 5 项单测 + 集成 4 项：三轮修改后 UNCHANGED / 涟漪附带移位 409 零写入 / 显式目标不算范围外 / 非 CLIP 501）· `docs/handoffs/N06-07.md`
- **为何不是 VERIFIED：** ①"其他别动 + 总时长改变"只有**权威判定契约 + 单测**，尚未接到规划器（`planRangeEdit` 计算总时长变化并回带判定/等长替代）——属"接口存在 ≠ 功能交付"；②保护范围仅 CLIP（字幕/音频区域/视觉对象显式 501 待扩）；③无 UI 呈现。
- **下一步（本组内）：** **N06-08**（A/B 比较与版本恢复；依赖 N04-04 仅 s1 就绪，开工前评估）→ 组末全量 verify + 提交。

### 2026-10-10 · N06-05 采用、继续微调、拒绝与部分采用 — **VERIFIED**
- **内容：** 迁移 0085 给 `proposals` 加 `adopted_operation_indexes`。契约新增 `packages/contracts/src/proposal-disposition.ts`（`resolveProposalDisposition` 纯函数：显式 UI 动作优先 → 拒绝 → 后面也这样 → 继续微调 → 采用；**沉默/无法识别 → 需确认，绝不据此采用**；多候选无唯一目标 → 需消歧）+ 9 项单测。Domain 新增 `computePartialAdoptClosure`（① 引用闭包：消费 `createdClipId` → 并入其创建操作；② 音画配对闭包：同一 `avGroupId` 的视频/音频操作必须同进；两条迭代到不动点）与 `adoptProposalPartial`；抽出 `assertAdoptPreconditions` 供采用/部分采用共用。响应如实回报 `adoptedOperationIndexes`/`remainingOperationIndexes`/`closureExpanded`/`effectiveWriteTargets`（作用范围明确可见）；越界选择 422 `PROPOSAL_PARTIAL_SCOPE_INVALID` 零写入；部分采用为一次性交付（`PARTIALLY_ADOPTED`，闭包覆盖全部则 `COMMITTED`）。HTTP `POST .../adopt-partial` + SDK。
- **证据：** `docs/verification/N06-05.md`（处置 9 项单测 + 集成 5 项：音画配对闭包 / 引用闭包 / 闭包覆盖全部=COMMITTED 且不可重复采用 / 越界 422 零写入 / 哈希不符 409）· `docs/handoffs/N06-05.md`
- **为何是 VERIFIED：** 实现内容与验收四条（"再慢一点"未提前采用、沉默不确认、多候选消歧、部分采用不切断音画依赖）全部是服务端/契约语义且均有真实库证据；本项**无用户可见 UI**（对比回放界面属 N06-08）。
- **下一步（本组内）：** **N06-07**（已确认内容保护与回归指纹）→ N06-08（A/B 比较与版本恢复；依赖 N04-04 未完全就绪，开工前需评估）→ 组末全量 verify + 提交。

### 2026-10-10 · N06-06 提案替代、取消与晚到结果隔离 — **VERIFIED**
- **内容：** 迁移 0084：`proposals` 增 `generation`/`superseded_by_proposal_id`/`superseded_at`/`cancelled_at`，**新增 `proposal_artifacts` 隔离台账**。候选带工程内单调递增 `generation`；创建时自动**取代**同谱系（`intentRevisionId` 优先，否则 `selectionAnchorId`）旧 OPEN 候选并记录取代者；`cancelProposal` 标 `CANCELLED` 但**保留**试片/产物结果（与丢弃语义不同），取消后采用/试改 409、回调不改 acceptedRevision；`submitProposalArtifact` 只在"候选仍 OPEN 且为谱系当前代际"才 `bound=true`，其余（`SUPERSEDED`/`CANCELLED`/`STALE_GENERATION`/`NOT_CURRENT`/`ALREADY_BOUND`）**隔离不自动绑定**；`runRetentionSweep` 新增第 7 步按保留期清理 `bound=false` 孤儿行、保留已绑定结果。HTTP `POST .../cancel`、`POST|GET .../artifacts` + SDK。
- **证据：** `docs/verification/N06-06.md`（集成 5 项：逆序完成仍展示最新意图 / 无谱系不取代 / 取消保留结果且回调不改 revision / 孤儿产物隔离 / 隔离产物保留清理）· `docs/handoffs/N06-06.md`　**verify：** 14/14（1233/1233）
- **为何是 VERIFIED：** 实现内容（revision-任务绑定、新指令 supersede、取消不丢结果、外部晚到隔离）与验收三条全部是服务端语义且均有真实库证据；本项**无用户可见 UI**（"方向对再改/采用/后面也这样"的 UI 与语音语义区分属 N06-05）。
- **下一步：** N06-05（采用/继续微调/拒绝/部分采用）→ N03-16（G0 基础播放同步）→ N03-10（G0 纯素材交付门）。

### 2026-10-10 · N06-03 影响集、陈旧提案与受控 rebase — **VERIFIED**
- **内容：** 迁移 0083 给 `proposals` 加 `read_set`/`write_set`/`write_targets`/`asset_version_signature`/`rebase_count`/`rebased_from_revision`/`rebase_log`。创建候选时**记录**字段读写集（操作注册表并集）、具体写目标（对象 + 对象锁六维 + 来源操作下标）与候选引用片段的源素材绑定签名。契约新增 `packages/contracts/src/edit-impact.ts`（纯函数 `computeOperationTargetRefs`：操作负载 → 受影响对象与维度；`targetRefsIntersect` 同对象同维度判定；读不出形状时**保守取全维度**）。`computeProposalImpact` 把写目标与 base revision 之后 `edit_events` 还原的干预改动做**同对象同维度**竞争判定；`rebaseProposal` 仅在无竞争且身份（锚点指纹）/源素材未变时受控推进 base revision（仍在新 base 上用真实执行器事务内跑完回滚验证），失败即 409（`PROPOSAL_REBASE_CONFLICT` / `PROPOSAL_REVIEW_REQUIRED`），**绝不以最新 revision 强覆盖**。HTTP `GET .../impact` + `POST .../rebase` + SDK。
- **证据：** `docs/verification/N06-03.md`（契约 9 项单测 + 集成 8 项：不同片段可合并 / 同对象同维度 409 / 同对象不同维度可合并 / 涟漪位移的间接影响可检测 / 源素材变化重新审核 / 身份变化重新审核 / 已最新幂等空操作 / 创建即记录读写集与写目标）· `docs/handoffs/N06-03.md`　**verify：** 14/14（1228/1228）
- **为何是 VERIFIED：** 本项实现内容与四条验收/负面路径全部是服务端语义，且均有真实库集成证据；本项**无用户可见 UI**（影响集是只读 API，rebase 是服务端操作；A/B 对比与局部回放的可见呈现属 N06-08／N04-08）。
- **下一步：** N06-06（提案替代、取消与晚到隔离）→ N06-05（采用/继续微调/拒绝/部分采用）→ 回主线 N03-10。

### 2026-10-10 · N06-04 局部试片缓存与依赖失效 — **IN_PROGRESS**
- **内容：** 迁移 0082 `proposal_trials`（行身份 `(workspace, project, dependency_key)`）；依赖键 = sha256(base revision + operationsHash + selectionFingerprint + intentRevisionId + 素材版本签名)；`previewProposal` 命中缓存直接返回（`cached=true`，不跑执行器），未命中才跑真执行器并 upsert；`invalidateProposalTrials` 显式失效 + 采用/丢弃后清理。
- **证据：** `docs/verification/N06-04.md`（3 项集成：缓存命中、素材版本依赖失效、显式/采用清理）· `docs/handoffs/N06-04.md`　**verify：** 14/14（详见运行日志）
- **为何不是 VERIFIED：** UI 呈现/真实浏览器证据未做；缓存为单实例 DB 表，无跨实例 TTL/容量与自动失效调用。
- **下一步：** N06-03（影响集/陈旧提案 rebase）→ N06-06（替代/取消/晚到隔离）→ 回主线 N03-10。

### 2026-10-10 · N05-02 语音采集、能力协商与时间对齐 — **IN_PROGRESS**
- **内容：** `packages/contracts/src/voice-alignment.ts`：采集状态/约束、`VOICE_CLOCK` 采样、播放锚点、能力协商（请求未声明支持 → fail-closed）、音频↔单调↔序列映射；`alignVoiceUtterance` 精度如实标注（WORD_EXACT/AUDIO_RANGE/UTTERANCE_SNAPSHOT/UNAVAILABLE，不伪造逐词精确）；Web `useMicrophoneCapture` + `VoiceCaptureControl`（显式授权、可见监听/电平、卸载停止）。
- **证据：** `docs/verification/N05-02.md`（领域 7 项 + jsdom 7 项）· `docs/handoffs/N05-02.md`　**verify：** 14/14（详见运行日志）
- **为何不是 VERIFIED：** **真实 VAD/流式 ASR 未接**（无凭据，保持 `UNVERIFIED_CREDENTIALS_REQUIRED`）；采集控件未挂载到共看片室对话栏（N04-01/N16-06）；无真实浏览器/麦克风证据。
- **下一步：** N06-04（局部试片缓存与依赖失效）→ N06-03（影响集/陈旧提案 rebase）→ N06-06（替代/取消/晚到隔离）→ 回主线 N03-10。

### 2026-10-10 · N04-10 刷新/嵌套/时序变更后的锚点自动恢复 — **IN_PROGRESS**
- **内容：** 目标引用新增可选恢复基线 `bindingBaseline`（不参与指纹、兼容旧锚点）；`recoverSelectionAnchor`：刷新**幂等**（无实质变化不追加修订）、`expectedRevision` + 主键冲突两层并发保护（409 `SELECTION_CONCURRENT_UPDATE`）、`FOLLOW_OBJECT` 位移跟随、`FOLLOW_SOURCE` 源映射重投影（失败标 `STALE`）、嵌套父序列缺失标 `PARTIAL`；新增 `addMediaTime`/`subtractMediaTime`；HTTP `POST .../selection-anchors/:anchorId/recover` + SDK。
- **证据：** `docs/verification/N04-10.md`（4 项集成：位移跟随+幂等、源映射重投影、并发 409、嵌套 PARTIAL）· `docs/handoffs/N04-10.md`　**verify：** 14/14（详见运行日志）
- **为何不是 VERIFIED：** UI 呈现与真实浏览器刷新恢复证据未做（N04-01/N04-08）；真实嵌套/代理时序链路端到端未覆盖。
- **下一步：** N05-02 起真实语音链路（待凭据，协议/夹具先行）→ N06-04/N06-03/N06-06 → 回主线 N03-10。

### 2026-10-10 · N04-05 AttentionSnapshot 与事件缓冲 — **IN_PROGRESS**
- **内容：** `packages/contracts/src/attention.ts`：11 类共同注意力事件（含真实呈现帧 `PRESENTED_FRAME` 与语音时钟 `VOICE_CLOCK`）、本地单调时钟 + 会话 epoch、有界事件缓冲（默认 8s/512，epoch/单调时钟回退/seq 违反 fail-closed）、鼠标轨迹最小保留（最小距离去样 + 点数上限）、快照导出（缺词级时间时 `wordTimingAvailable=false`）。
- **证据：** `docs/verification/N04-05.md`（9 项契约单测）· `docs/handoffs/N04-05.md`　**verify：** 14/14（详见本次运行日志）
- **为何不是 VERIFIED：** `AttentionRecorder` 接线、真实语音时钟映射与服务端按发话时观看记录定位未做（属垂直切片/N05-02）。
- **下一步：** （N06-04 已完成服务端部分，见上方条目）N06-03 → N06-06 → 回主线 N03-10；真实语音链路待凭据后接入。

### 2026-10-10 · N04-02-s1／N04-04-s1 画布原生对象命中 + 横向时间带 — **IN_PROGRESS**（主任务 N04-02／N04-04 未完成）
- **内容：** `packages/contracts/src/timeline-band.ts`（可视窗口→有理时基换算、播放头/时间选区分离、单击 POINT／拖动半开 RANGES、显式多区间不合并、帧吸附坍缩降级、区间上限 fail-closed）；`visual-picking.ts`（复用 `hitTestVisualObject`，zOrder→细粒度→输入顺序，隐藏/父隐藏排除，重叠轮换，投影四边形）；`selection.ts` 新增 `composeSelectionAnchor`（交互产物→规范锚点+指纹，选择不改工程）。Web 新增 `TimelineBand`、`CanvasInteractionLayer`，并在 `LiteTimeline`（**保留、扩展**）与 `WorkflowDirector`「展开轻时间线」内可选接线。
- **证据：** `docs/verification/N04-02-s1.md`、`docs/verification/N04-04-s1.md`（契约 18 项 + jsdom 11 项 + 全量 verify）· `docs/handoffs/N04-02-s1.md`、`docs/handoffs/N04-04-s1.md`　**verify：** 14/14（**1180/1180**：Unit 454 / Web 181 / Motion 19 / Integration 481 / Security 24 / Render 6 / Golden 15）
- **为何不是 VERIFIED：** 真实浏览器/高 DPI 目检、v2 片段/轨道投影、锚点持久化/恢复（N04-10）未做；在真实画布与真实时长接线前不宣称 UI 验收。
- **下一步：** N04-05（AttentionSnapshot 本体）／N04-10（锚点自动恢复）→ N05-02 起真实语音链路（待凭据）→ N06-04/N06-03/N06-06 → 回主线 N03-10。

### 2026-10-10 · N06-01／N06-02 私有候选分支 → 确定性试改 → 原子采用 — **VERIFIED**（N06-04 未交付）
- **内容：** 迁移 0081 `proposals`；候选只存操作集与绑定（不改工程）；**试改 = 真实执行器在事务内跑完再无条件回滚**（同一操作集同一结果，`projectUntouched` 结构性保证）；采用按幂等键/状态/操作哈希/选择指纹/base revision 逐项校验后经统一编辑协议**原子**执行（失败保持 OPEN、零部分写入）；丢弃幂等、旧候选 SUPERSEDED；HTTP 五端点 + SDK。
- **证据：** `docs/verification/N06-01.md`（5 项集成用例）· `docs/handoffs/N06-01.md`　**verify：** 14/14（**1151/1151**）
- **下一步：** N04-02-s1／N04-04-s1（画布命中 + 横向时间带，保留 `LiteTimeline`）→ N04-05／N04-10 → N05-02 起的真实语音链路（待凭据）。

### 2026-10-10 · N05-01 实时会话与短期凭证适配（含流式协议状态机）— **IN_PROGRESS**
- **内容：** 迁移 0080 `voice_sessions`；创建/读取/事件/封存/关闭/撤销六个端点 + SDK；短期 HMAC 凭证（**只返回一次**、TTL 15 分钟、未配置密钥 501 fail-closed，长期 Key 永不下发）；创建需 `project:write`（跨租户 404）；能力表按传输方式显式声明（浏览器回退不承诺服务端 VAD/逐词时间戳/工具）；流式事件信封带状态/代际/时钟/序号四道门；`partial` 转写只写会话草稿（工程零变更）、改口产生新转写修订；`sealUtterance` 封存最新修订为 IntentRevision（需绑定 SelectionAnchor）供 `planRangeEdit` 使用。
- **证据：** `docs/verification/N05-01.md`（5 项集成用例）· `docs/handoffs/N05-01.md`　**verify：** 14/14（**1146/1146**）
- **为何不是 VERIFIED：** 真实 WebRTC/sideband 传输与真实 VAD/流式 ASR 未接入（待凭据），保持 `UNVERIFIED_CREDENTIALS_REQUIRED`。
- **下一步：** N04-02-s1/N04-04-s1（画布命中 + 横向时间带，保留 `LiteTimeline`）→ N06-01-s1/N06-02-s1/N06-04-s1（私有候选/试改/原子采用）。

### 2026-10-10 · N04-09 SelectionAnchor 归一与旧 Attention 兼容
- **内容：** 规范 `SelectionAnchor`（几何 × 时间 × 轨道 × 属性 × 区域模式 × 发话时间 + 目标顺序引用与版本 + 解析状态/证据/重映射历史/指纹）持久化为**追加式修订日志**（迁移 0079，行主键 = workspace+project+anchorId+revision）；旧 inline 选择（分镜/片段/字幕/素材范围/像素区域）经适配器**解析一次**且不丢有理时基；越权与"帧哈希当身份"被拒；重映射把失效选择标成 FAILED／PARTIAL／AMBIGUOUS（附候选证据）／STALE 并记 `remapHistory`；保存锚点**不改工程**（不写 edit_events、不动 revision）。
- **证据：** `docs/verification/N04-09.md`（4 项集成用例）· `docs/handoffs/N04-09.md`
- **提交：** `d7aacea`　**verify：** 14/14（Unit 436 / Web 170 / Motion 19 / Integration 471 / Security 24 / Render 6 / Golden 15 ⇒ **1141/1141**）

### 2026-10-10 · 增量设计首批契约（N04-09-s1）
- **内容：** `packages/contracts/src/selection.ts`：`GeometrySelection`（点/线/矩形/多边形/笔刷 × 用途）、`SelectionAnchor` 增量、`IntentRevision` 状态机、`legacySelection` 适配器、指纹输入纯函数；8 项契约单测。
- **证据：** `docs/verification/N04-09-s1.md`

### 2026-10-10 · 新需求扫描与差距映射
- **内容：** 读 `docs/V04/ANCS_v04_Mouse_Voice_Incremental_Design_20261010.md` + 提示词，产出 `docs/design/mouse-voice-gap-map.md`（逐条要求 → 现有实现 → N04/N05/N06 目标任务 → 状态，含 13 个新增子任务与推进次序）。

### 2026-10-10 · CI 修复（解除 GitHub 合并阻塞）
- **内容：** 真实媒体用例（探测/索引/转码）从 unit 移到 integration（unit 定义 = 无外部依赖），CI verify 作业安装 FFmpeg。**不放宽断言、不静默跳过。**
- **提交：** `a76dc66`

### 2026-10-10 · N03-09 范围编辑指令的最小 AI 入口
- **内容：** `planRangeEdit`（选中片段 + 允许操作清单 + 源证据 → 五道校验后的可执行操作；越界逐条 `outOfScope` 说明；零写库、零 Provider 媒体调用）+ API `POST /ai-edit/range-plan` + SDK `client.narrative.rangeEditPlan` + 三个确定性 Mock 脚本模式。
- **证据：** `docs/verification/N03-09.md`（4 项）· **提交：** `7881bf9`

### 2026-10-09 · N03-01 … N03-08（时间线全链路）
- **内容：** 插入/覆盖/追加 → 拆分·裁剪·移动·复制·替换源 → 精剪（ripple/roll/slip/slide/J-L cut）→ 多轨·AV 链接·轨道控制 → 可编辑变换与关键帧 → 基础混音与原声保护 → 字幕与转写驱动剪辑 → 多轨媒体预览与真实合成（播放快照 + 服务端合成计划）。
- **提交：** `06c887b`、`17d431a`、`4a4607a`、`66faa91`、`e49a411`、`ad6ccdf`、`f4c27cc`、`6a2dd16`
- **证据：** `docs/verification/N03-01.md` … `N03-08.md`（含 9 个实测抓出的真实缺陷与修法）

---

## 三、下一步（按优先级，来自 gap map §4；2026-10-10 更新）

**已完成（本会话，均 IN_PROGRESS）：** N04-02-s1 / N04-04-s1（画布命中 + 横向时间带）、N04-05（AttentionSnapshot）、N04-10（锚点自动恢复）、N05-02（语音采集/协商/对齐）、N06-04（局部试片缓存与依赖失效）、N06-07（已确认内容保护与回归指纹）、N06-08（A/B 比较与差异标记）。
**已完成并 VERIFIED：** **N06-03**（影响集、陈旧提案与受控 rebase）、**N06-06**（提案替代、取消与晚到结果隔离）、**N06-05**（采用、继续微调、拒绝与部分采用）、**N06-07**（已确认内容保护与回归指纹，含总时长守卫接入规划器）—— 见上方条目。

**第二组已完成**（基础设施 `db:generate` 修复 + N06-07 收口；组末 verify 14/14、1265/1265）。**第三组计划：**

1. **收口 N06-04 / N06-08 的缺口**：N06-04 跨实例试片缓存策略 + ghost 预览对接（N04-02-s1／N04-04-s1）；N06-08 播放器侧（切换前后/音频 AB/循环回放）。
2. **N04 主线收口**：N04-04 主体（横向时间带的片段/轨道投影与时间选区）→ N04-01（真实画布与高 DPI 目检）→ N04-08（垂直切片真实验收）。
3. **回主线 N03**：**N03-16（G0 基础播放同步）** → **N03-10（G0 纯素材交付门）** → N03-11 PlaybackEngine → … → N16。**⚠ N03-10 硬依赖 N03-16（未交付）**，且需新增"素材渲染 kind + QA 变体 + 冻结时间线快照"（详见本文件「N03-10 现状」）。
4. **真实语音链路**：待 ASR/VAD 凭据后按 N05-02 verification 的回放路径接入（保持 `UNVERIFIED_CREDENTIALS_REQUIRED`）。
5. **已有 IN_PROGRESS 的 UI/浏览器证据收口**：N05-01／N05-02／N04-05／N04-10／N04-02-s1／N04-04-s1。
6. **并行工作（可选）**：互斥文件集 + 独立测试库即可并行——`ancs_quiet_frame_test_agentb` 已建好；**同一时刻仍只跑一份 `pnpm verify`**。

### N03-10 现状（Explore 代理调研结论，2026-10-10）

**硬依赖未满足：** N03-10 的 v0.4 增量要求「G0 加入 baseline 播放同步验收 **N03-16**」，而 N03-16 未交付（无真实浏览器连续播放证据）。**先做 N03-16 的 baseline 切片**，或在 N03-10 验证文档中显式降级并写回依赖（**不得**虚报 G0 通过）。

**主要缺口（工作量不小，不是收尾）**：① `createRender`（`packages/domain/src/render.ts:64`）被三道门挡住纯素材——N01-04 场景守卫（有字幕/音频区域即 409 `NORMALIZED_COMPOSITION_RENDER_UNAVAILABLE`）、`MASTER_NARRATION_MISSING`、`NO_SCENES`；② 冻结快照 `projectVersions.snapshot` 只含 scenes/graph，**不含时间线**（素材"冻结"不权威，V03-32/V03-40/V04-26）；③ `buildPlaybackSnapshot`/`buildServerSynthesisPlan` 只到 domain 层，**无 HTTP/SDK**；④ 无"素材成片"执行器（现有 `RenderExecutor` 只有 Remotion scene 一种）；⑤ QA 是场景中心（`SCENES_PRESENT`/`MASTER_NARRATION_PRESENT` 会让纯素材必然 FAIL），且**从不校验输入素材源 hash 未改**；⑥ 无端到端全旅程用例与真实导出证据；⑦ 无 UI 交付卡。

**已有可复用基础**：统一编辑协议 + 撤销/恢复（N03-01…09、N01-08 全 VERIFIED）；`planClipAudioMix`；字幕词条权威；`playback.ts` 投影；`render.ts`/`render-execution.ts`/`approval.ts`/`qa.ts` 冻结-执行-QA-批准-导出链；真实夹具 `packages/testing/fixtures/media-v04/`（含 `manifest.json` 的 sha256 = "源 hash 未改"证据）；CI 已装 FFmpeg。

**架构边界**：V04-14（共享 RenderPlan / FFmpeg+Remotion 混合终渲染）正式落地在 N09-08—11，**N03-10 只能做 G0 baseline（受控预渲染）**，不要把 N09 的功能提前声称完成。

---

## 四、续跑指令（换窗口/换人必读）

```bash
# 环境
cd .                       # 分支 codex/v04-foundation
docker compose -f infra/docker-compose.dev.yml up -d   # ancs-dev-db / ancs-dev-redis
export ANCS_TEST_DATABASE_URL='postgres://ancs:ancs@localhost:55432/ancs_quiet_frame_test_261007'  # 库名必须含 test

# 单项目验证（跑得快，先做这个）
pnpm exec vitest run --project integration apps/api/src/<task>.integration.test.ts

# 完整验证（提交前必跑）
pnpm verify                            # 14 步；若遇环境抖动（FFmpeg 启动失败 / 未处理 Promise 拒绝）单独复跑该套件并如实记录，不改阈值
```

**每项任务的完成定义（逐项、不跳步）**：contracts → migration（`cd packages/db && pnpm run db:generate`）→ domain/service → API/SDK → UI（用户可见功能先写 `docs/design/features/<taskId>.md` 交付卡）→ tests → docs；写 `docs/verification/<taskId>.md`（实际改动文件 + 命令 + 退出码 + 真实浏览器/媒体证据 + 失败与剩余缺口）与 `docs/handoffs/<taskId>.md`；同步三个账本；**本项提交并推送后才开始下一项**；**完成一部分就回到本文件追加一条**。

**纪律（违反即返工）**：
- 不删断言、不放宽阈值、不静默跳过、不伪造日志与性能数字；**没跑过的测试不许写成通过**。
- 源素材与已确认版本不可变；越界/无法保真一律 fail-closed 并在文档写明依赖任务。
- 真实 Provider 未验证就标 `UNVERIFIED_CREDENTIALS_REQUIRED` 并写回放路径；不触发未授权费用。
- 选择/语音等新能力必须复用既有权威层（ProjectDocument、SelectionAnchor、Edit Operation v2、权限/锁/影响集/版本/预算），**不新建第二套状态**。

**已知坑（都踩过）**：
- 轨道重排必须**两阶段写入**（先偏移再落位），否则 `(sequence_id, position)` 唯一索引瞬时冲突 → 500。
- 补偿路径（undo/redo）必须豁免策略类守卫，否则撤不回去。
- 修改 `@ancs/sdk` 后，apps/api 的类型检查读 `src`、运行读 `dist`，**改完要 `pnpm --filter @ancs/sdk build`**。
- 改账本的 python 脚本里别混入直引号（会 SyntaxError 静默不落盘）；写完必须 `grep` 复核计数。
- 字幕文本以**词条**为权威；`trim_clip` 遇到本地区域超出新时长的音频区域会 409（区域级时钟重算属 N03-06）。
- CI 已装 FFmpeg；**unit 套件不放需要 ffmpeg/DB 的用例**（用 `*.integration.test.ts`）。
- 测试库安全门用**库名含 test** 判据（本地 `ancs_quiet_frame_test_261007`、CI `ancs_test` 都可），
  不要把守卫写成"必须等于某个固定库名"，否则 CI 会因库名不同整文件失败。
- 真实媒体夹具在 `packages/testing/fixtures/media-v04/`；worker 测试用 `createFfmpegSourceMediaProbe`；工程夹具经 domain 的 `createChannel` 建通道。
- **不要并发跑两个 verify/integration 实例**（共用同一个测试库）：会互相清理数据，表现为大量无关套件报
  `projects_workspace_id_workspaces_id_fk` 之类的假失败。被中断的 verify 若进程仍在，先确认没有残留再重跑；
  确认方法：单独重跑失败套件（本文档 2026-10-10 曾因此误判 28 个文件失败，单独重跑 5 个文件 42 项全绿）。

---

## 五、提交序列（最新在下）

```
06c887b  feat(n03-01) 插入／覆盖／追加
17d431a  feat(n03-02) 拆分／裁剪／移动／复制／替换源
4a4607a  feat(n03-03) 精剪 ripple/roll/slip/slide/J-L cut
66faa91  feat(n03-04) 多轨、AV 链接与轨道控制
e49a411  feat(n03-05) 可编辑变换与基础关键帧
ad6ccdf  feat(n03-06) 基础混音与原声保护
f4c27cc  feat(n03-07) 字幕与转写驱动剪辑
6a2dd16  feat(n03-08) 多轨媒体预览与真实合成
a76dc66  fix(ci) CI 安装 FFmpeg + 真实媒体用例归 integration
7881bf9  feat(n03-09) 范围编辑最小 AI 入口 + 差距映射
ec20a44  feat(n04-09-s1) 点线面 × 时间 × 意图统一契约
969fe13  test(n04-09-s1) 修正集合级校验用例类型
d7aacea  feat(n04-09) SelectionAnchor 归一/持久化/兼容/重映射 + CI 测试库守卫修正
         （同批新增 docs/handoffs/RUNNING_DELIVERY.md 本文件）
dea4496  docs: 记录 N04-09 的 verify 结果与并发验证陷阱
da45f2c  feat(n05-01) 实时会话与短期凭证适配（含流式协议状态机）
7592147  feat(n06-01/n06-02) 私有候选分支 → 确定性试改 → 原子采用
7bdd31f  docs: 补记 N06 切片 verify 实测与会话切换交接段
238ef90  docs: 新增新会话启动提示词
9dae282  feat(n04-02-s1/n04-04-s1) 画布原生对象命中 + 横向时间带
baa715c  feat(n04-05) AttentionSnapshot 本体 + 有界事件缓冲 + 轨迹最小保留
82cc785  feat(n04-10) 刷新/嵌套/时序变更后的锚点自动恢复
f178a11  feat(n05-02) 语音采集、能力协商与时间对齐
1683b74  feat(n06-04) 局部试片缓存与依赖失效（迁移 0082）
f4f81f2  feat(n06-03) 影响集、陈旧提案与受控 rebase（迁移 0083）
ee0c83d  feat(n06-06) 提案替代、取消与晚到结果隔离（迁移 0084）
783ee0f  feat(n06-05) 采用、继续微调、拒绝与部分采用（迁移 0085）
aa9a52b  feat(n06-07) 已确认内容保护与回归指纹（迁移 0086）— IN_PROGRESS
e6a604d  feat(n06-08) A/B 比较与差异标记（N06 收尾组收口）— IN_PROGRESS
3da0131  chore(db) + feat(n06-07) 修复 db:generate 快照冲突；N06-07 收口转 VERIFIED（第二组）
65325d0  fix(review) 外部评审逐条核实与 P0 修复（意图识别/沙箱隔离/凭据密钥/FFmpeg 协议/仓库卫生）
f9344d8  fix(env) liveEnv 夹具补 ANCS_CREDENTIAL_KEYS（修复评审响应引入的 unit 回归）
f9b612b  feat(n06-04) 试片缓存收口（TTL/容量/保留清理/可观测）→ VERIFIED（第四组；组末 verify 14/14、1285/1285）
305e5ad  feat(n04-04) 真实片段/轨道投影 + 时间选择→对象解析（第五组；组末 verify 14/14、1297/1297）
```

---

## 六、会话切换交接（2026-10-10）

**本会话完成的全部内容**（每个都已提交推送，提交号见第五节）：

1. `N03-01` … `N03-09`：素材到序列的插入／覆盖／追加、拆分·裁剪·移动·复制·替换源、精剪（ripple/roll/slip/slide/J-L cut）、多轨与轨道控制、可编辑变换与基础关键帧、基础混音与原声保护、字幕与转写驱动剪辑、多轨媒体预览与真实合成（播放快照 + 服务端合成计划）、范围编辑最小 AI 入口。
2. `N04-09`（+ `N04-09-s1` 契约）：SelectionAnchor 归一、持久化（迁移 0078）、旧格式兼容、重映射（FAILED/PARTIAL/AMBIGUOUS/STALE）。
3. `N05-01`（部分交付，IN_PROGRESS）：实时会话与短期凭证适配 + 流式协议状态机（迁移 0080）。
4. `N06-01`／`N06-02`：私有候选分支 → 确定性试改（真执行器事务内跑完回滚）→ 原子采用（迁移 0081）。
5. `N06-03`：影响集、陈旧提案与受控 rebase（迁移 0083）—— 创建即记录读写集/写目标/素材签名；同对象同维度竞争 409；身份/素材变化要求重新审核；绝不以最新 revision 强覆盖。
6. `N06-06`：提案替代、取消与晚到结果隔离（迁移 0084）—— 候选代际 + 同谱系自动取代；取消保留结果；外部晚到产物隔离台账；隔离产物按保留期清理。
7. `N06-05`：采用、继续微调、拒绝与部分采用（迁移 0085）—— 处置解析纯函数（沉默不确认、多候选消歧）；部分采用按依赖闭包扩张（引用闭包 + 音画配对闭包），作用范围如实回报。
8. `N06-07`：已确认内容保护与回归指纹（迁移 0086，IN_PROGRESS）—— 三轴指纹 + 回归报告 + 意外移位阻止自动采用（试改后状态比对）；范围守卫仅到契约层。
9. `N06-08`：A/B 比较与差异标记（IN_PROGRESS）—— 对照载荷 + 内容锚点对齐 + 实际素材版本引用；播放器侧未做。
7. 两次 CI 阻塞修复：verify 作业安装 FFmpeg + 真实媒体用例从 unit 归入 integration；隔离库安全门改为「库名含 test」。
8. 新需求（鼠标点线面 × 横向时间定位 × 流式语音）扫描 + 差距映射：`docs/design/mouse-voice-gap-map.md`。

**当前仓库状态**：分支 `codex/v04-foundation`，HEAD 见第五节末；**工作树干净**；迁移到 0086；账本 52/219（23.74%）；`pnpm verify` **14/14、1259/1259**（N06 收尾组组末实测）。

**下一步（严格按序，见第三节「下一组计划」）**：

1. **N06-07 收口**（把 `resolveScopeGuard` 接入规划器）→ 可转 VERIFIED；**N06-04／N06-08 的 UI 与跨实例收口**。
2. **N04 主线收口**：N04-04 主体 → N04-01 → N04-08。
3. **回主线 N03 收口**：**N03-16（G0 基础播放同步）** → **N03-10（G0 纯素材交付门）** → N03-11 PlaybackEngine → … → N16。**⚠ N03-10 硬依赖 N03-16（未交付）**，且需新增"素材渲染 kind + QA 变体 + 冻结时间线快照"（详见第三节末「N03-10 现状」）。
4. **真实语音链路**：待 ASR/VAD 凭据后接入（保持 `UNVERIFIED_CREDENTIALS_REQUIRED`）。

**恢复工作前先做三件事**：① `git log --oneline -5` 与 `git status` 确认与本文一致；② 读 `docs/design/mouse-voice-gap-map.md` 的「进度记录」；③ 跑一次 `pnpm verify` 确认基线（注意：**同时只能跑一份**）。

**本机环境备注（本会话踩过）**：此 Linux/WSL 工作区里 `node_modules` 原先是在 Windows 上安装的（只有 win32 原生二进制），导致 `pnpm verify` 的 `build` 报 `Cannot find module '../lightningcss.linux-x64-gnu.node'`、单测首个 `buildServer` 因从 `外挂盘`（9p）懒加载模块而超过 5s 默认超时。已用 `cp -a` 把 `node_modules` 复制到 Linux 盘并 `sudo mount --bind <Linux 盘上的 node_modules 副本> /mnt./node_modules`（路径不变，workspace 符号链接仍有效）。**这是会话级挂载，不是仓库改动**；换机/重启后若再遇 win32 原生模块缺失，按此重建挂载后再跑 verify。不要通过放宽测试超时或改断言来绕过。

**平台切换备注（2026-10-10 新增）**：若在 **Windows（Git Bash）** 下接手而 `node_modules` 里只有 Linux 原生二进制（`@rolldown/binding-linux-x64-gnu`、`lightningcss-linux-x64-gnu`），`vitest` 会以 `Cannot find native binding`／`@rolldown/binding-wasm32-wasi` 启动失败。修法是按当前平台重装依赖：`CI=true pnpm install --config.confirmModulesPurge=false`（会整目录重装并下载 win32 原生包；`pnpm-lock.yaml` 不变）。**不要**用放宽超时或改断言绕过。

**推送凭据（本会话踩过）**：WSL 内 `git push` 无凭据（`fatal: could not read Username`）。本机 Windows 侧的 Git for Windows 已配置 `credential.helper=manager` 且缓存了 github.com 凭据，可用 Windows git 推送同一提交：
`cd . && GIT_TERMINAL_PROMPT=0 "系统安装的 git" push origin codex/v04-foundation`（提交仍由 WSL git 创建，二者共享同一 `.git`）。

**本会话新增的纪律/教训（都踩过，务必遵守）**：
- **同一时刻只跑一份 verify/测试实例**（共用同一测试库会互相清理数据 → 大量假失败；若被中断，先 `pkill -f vitest` 再重跑）。
- 改 `@ancs/sdk` 后要 `pnpm --filter @ancs/sdk build`（apps/api 的类型检查读 `src`、运行读 `dist`）。
- 改账本的 python 脚本里不要混入直引号（会 SyntaxError 静默不落盘）；**写完必须 grep 复核计数与任务行**——本会话就出现过 N03-06 漏记、N06-04 误标两起，均已在后续提交修正。
- 迁移文件改名后要同步 `meta/_journal.json` 的 tag 与 `idx`，并重建测试库（`drop database … create database …`）。
- **`cd packages/db && pnpm run db:generate` 目前不可用**：既有 `migrations/meta/0080_snapshot.json` 与 `0081_snapshot.json` 的 `id`/`prevId` 相同（此前手工改迁移名时未同步快照）→ drizzle-kit 报 `are pointing to a parent snapshot … collision`。新迁移按仓库既有做法**手工编写 SQL + 同步 `meta/_journal.json`**；`runMigrations`（journal + SQL）与集成测试正常。修复快照属独立基础设施项。
- 新增原语/契约后跑一次 `pnpm arch:check` 与 `pnpm lint`，R7 依赖规则与未使用导入是最常见的红灯。
