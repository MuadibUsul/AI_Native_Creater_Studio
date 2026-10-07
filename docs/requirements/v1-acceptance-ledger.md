# V1 验收账本（§77 / §78 / 附录 C / §96）

- 任务：P00-01（计划 §12 覆盖索引要求"验收清单 附录 C、96 → P00 逐项建账，阶段门逐项关闭"）
- 用途：G4（内部生产可用）与 G8（全规范覆盖）的逐项关闭清单；P08-06 对账依据。
- 2026-10-08 界面验收备注：Quiet Frame Web 重构的页面覆盖、视觉差异和本地功能回归单独记录于 `docs/verification/QUIET-FRAME-REBUILD.md`；演示夹具与 Mock 不改变本表原有条目状态。按用户要求，Web 人工检查前不推进 P15/P16。
- 规则：
  1. 每项初始 `TODO`；关闭时须有可执行证据（测试、脚本输出、账号截图、人工评审记录），记录在 `docs/verification/`。
  2. Mock 验证通过不等于真实 Provider 验证通过；接口存在不等于功能交付。
  3. 阶段门（G0—G4）关闭时逐项核验；任一项未关闭不得称"V1 可内部生产使用"。
- 关联文件：`docs/requirements/traceability.md`（REQ 编号与任务映射）、`ANCS_Plan261004.md` §11.4。

## 1. §77 Definition of Done — Web MVP（24 项）

| ID | 条目 | 关联 REQ | 任务（阶段） | 状态 |
|---|---|---|---|---|
| LED-77-01 | 用户可以登录并进入 Workspace | REQ-30-01/REQ-22-01 | P01-02/P01-03（P01） | VERIFIED（2026-10-04：登录 → 创建/列出/进入 Workspace（含 OWNER 自动成员）全链路测试） |
| LED-77-02 | 可以创建 Channel / Creator Profile | REQ-6-01/REQ-6-02 | P01-04（P01） | VERIFIED（2026-10-05 对账回填：Channel/CreatorIdentity（含版本化子身份）全链路；证据：docs/verification/P01-04.md） |
| LED-77-03 | 可以从 URL 或粘贴文本创建 Project | REQ-4-01 | P04-01（P04） | VERIFIED（2026-10-05 对账回填：URL/粘贴文本 → ContentDocument（规范化落库）；证据：docs/verification/P04-01.md） |
| LED-77-04 | 系统生成 Narrative Script | REQ-8-01 | P04-03（P04） | VERIFIED（2026-10-05 对账回填：NarrativePlan 生成（结构化/有限修复/锁定保留/逐字门控）；证据：docs/verification/P04-03.md） |
| LED-77-05 | 系统生成结构化 Scene Graph | REQ-12-01/REQ-12-02 | P02-01/P04-05（P02/P04） | VERIFIED（2026-10-05 对账回填：Scene Graph 契约（P01-01）+ 状态组装（P02-01）+ Director 应用产出结构化场景（P04-05）；证据：P02-01/P04-05） |
| LED-77-06 | 至少 15 个高质量 Standard Scene Components 可工作（本计划交付 20 个，DEC-04） | REQ-65-01/REQ-64-02 | P05-02（P05） | VERIFIED（2026-10-04：20 类实现并注册；五类输入变体（正常/长文本/空值/极值/边界时长）单元断言 + 成片级画廊 PNG（5 张）+ 视觉复核修复全部溢出；证据：docs/verification/P05-02.md） |
| LED-77-07 | Remotion Player 可实时 Preview | REQ-38-01 | P05-04（P05） | VERIFIED（2026-10-04：@remotion/player 消费 Scene Graph；与成片共用 packages/remotion-core 时序（绝对边界、无累计漂移，10 分钟样例单测）；编辑经查询失效刷新预览；Draft 占位明确；证据：docs/verification/P05-04.md） |
| LED-77-08 | 用户可自然语言要求修改 Scene/Storyboard | REQ-37-01 | P05-06（P05） | VERIFIED（2026-10-05 对账回填：AI Edit 计划（不落库）→ Apply 经编辑协议；证据：docs/verification/P05-06.md） |
| LED-77-09 | 用户可手动 reorder/trim/delete/replace Scene | REQ-3-05/REQ-5-07 | P05-05（P05） | VERIFIED（2026-10-05 对账回填：reorder/trim/split/duplicate/delete/move/replace 全走编辑协议（含冲突 409 与刷新）；证据：docs/verification/P05-05.md） |
| LED-77-10 | 有 Lite Timeline | REQ-5-07 | P05-05（P05） | VERIFIED（2026-10-04：折叠面板 + 操作矩阵（reorder/Trim/Split/Duplicate/Delete/Move/Replace/Transition/Crop-Scale/音量/字幕）全走编辑协议；刷新一致与 409 冲突有测试；证据：docs/verification/P05-05.md） |
| LED-77-11 | 有 Undo / History / Version | REQ-5-08/REQ-23-03 | P02-03 + P05-03（P02/P05） | VERIFIED（2026-10-04：服务端 Undo/Redo/Restore 全链路（P02-03）+ History UI（P05-03：事件流/补偿标记/撤销重做动作/冲突提示，状态矩阵测试覆盖）） |
| LED-77-12 | 有资产上传和 Object Storage | REQ-26-02/REQ-22-04 | P02-04（P02） | VERIFIED（2026-10-04：真实本地对象存储驱动端到端——意图→签名直传→真实探测确认→Signed URL 下载回读；伪造 MIME/越权对象/不完整上传不可 Ready；S3/R2 云适配器待真实凭据，§13.5-8） |
| LED-77-13 | 有至少一个真实 Avatar Provider | REQ-64-04/REQ-14-02 | P06-04（P06） | BLOCKED（凭据）：数据模型与 Mock 故障矩阵已就位（P01-04/P03-07）；真实 Avatar Provider 账号与核验待 P06-04——不冒充真实。 |
| LED-77-14 | 有至少一个真实 Voice Provider | REQ-6-07/REQ-14-03 | P06-02（P06） | BLOCKED（凭据）：Voice 路由/对齐/TTS 契约与 Mock 就位（P03-04/P06-03）；真实 Voice Provider 待 P06-02。 |
| LED-77-15 | 有至少一个真实 AI Video Provider（默认 Veo，DEC-05） | REQ-64-04/DEC-05 | P06-05（P06） | BLOCKED（凭据）：AI_VIDEO 组件 + 显式生成动作（去重/输入最小化/边界门控）已验（P06-05 非凭据部分）；真实 Veo 适配器与核验待凭据（P06-01 工具就绪）。 |
| LED-77-16 | 外部任务异步执行并显示状态 | REQ-2-05/REQ-29-06 | P03-01/P02-06（P03/P02） | VERIFIED（2026-10-05 对账回填：任务系统九态/依赖/租约/恢复（P03-01/02/07）+ jobs REST/SSE 事件 + 真实长任务端到端（渲染/QA/渲染中取消语义）；真实外部 Provider 任务执行受凭据阻塞另行核验） |
| LED-77-17 | Provider 结果会回收到自己的 Storage | REQ-45-02/REQ-26-01 | P03-06（P03） | VERIFIED（2026-10-04：通用回收链路——下载（大小上限/超时）→ 校验（大小/魔术字节嗅探/校验和）→ 写入自有存储 → 落 Asset；测试含「Provider URL 失效后已完成资产仍可用」（AC-10）与「下载失败不重生成、只重试回收」（AC-09）） |
| LED-77-18 | 能输出 1080p 完整 MP4 | REQ-4-04 | P07-04（P07） | VERIFIED（2026-10-05：STUDIO_1080 端到端——真实 Remotion 渲染经生产任务链路（RENDER_FINAL → spawn CLI），parseMedia 校验 1920×1080/30fps/**含 aac 音轨**、容器时长=合成输入（±0.35s）；MP4 入自有存储（FINAL_VIDEO/KEEP_FINAL）；证据：docs/verification/P07-04.md） |
| LED-77-19 | 能输出字幕（SRT/VTT） | REQ-58-01 | P06-06（P06） | VERIFIED（2026-10-04：由 Alignment 派生的 SRT/VTT 导出（时间码规范/样式可覆盖/越界 warning）；证据：docs/verification/P06-06.md） |
| LED-77-20 | 能生成 Project Manifest | REQ-28-01 | P07-04（P07） | VERIFIED（2026-10-05：每次 Final Render 生成 manifest.json（项目/版本/组件版本/资产版本/Master 音频/渲染设置/provider 元数据/来源/时间戳/产物 sha256）；manifest_hash=字节 SHA-256 并在入库前复核；证据：docs/verification/P07-04.md） |
| LED-77-21 | 有 per-generation cost 记录 | REQ-25-01 | P03-05（P03） | VERIFIED（2026-10-05 对账回填：provider_generations（估算/实际/延迟/重试/凭证模式）+ 账本结算幂等（P03-05）；**真实成本数值**随真实 Provider 凭据写入） |
| LED-77-22 | 有 Workspace 数据隔离测试 | REQ-43-01/REQ-51-06 | P01-03（P01） | VERIFIED（2026-10-05 对账回填：security 套件 22 项跨租户全拒绝（含资产/任务/渲染/审批/QA/Admin）+ Signed URL 作用域 + Provider 凭据隔离（Mock 路径，P03-04）；真实凭据隔离随凭据阶段复验） |
| LED-77-23 | 后端 API 可独立于 Web 被调用 | REQ-29-02 | P01-05（P01） | VERIFIED（2026-10-04：示例与 CI 均在不启动 Web 下完成授权读写） |
| LED-77-24 | Shared SDK 可以被未来 Native Client 使用 | REQ-29-04/REQ-63-01 | P01-05（P01） | VERIFIED（2026-10-07 持续扩充：@ancs/sdk 覆盖 CMS writeback 与 P14 Analytics/Finance 全部 API；全量资源面 + 双认证模式 + 独立示例与 CI 工作流） |

## 2. §78 Definition of Done — Multi-Client Readiness（11 项）

| ID | 条目 | 关联 REQ | 任务（阶段） | 状态 |
|---|---|---|---|---|
| LED-78-01 | 所有业务能力有 REST API | REQ-32-01 | P01-05 起各阶段（P01+） | VERIFIED（2026-10-07 持续扩充：P14 表现采集/归因/学习操作与 Finance 来源/模板/产物均为 `/api/v1` REST；OpenAPI 同源生成 + SDK 覆盖） |
| LED-78-02 | API 有版本 | REQ-29-03（DEC-01：/api/v1） | P01-05（P01） | VERIFIED（2026-10-04：全路由 /api/v1 + 客户端标头） |
| LED-78-03 | Auth 可以支持 Native token flow | REQ-30-03 | P01-02（P01） | VERIFIED（2026-10-05 对账回填：PKCE S256 + 轮换令牌原生流程真实测试；证据：docs/verification/P01-02.md） |
| LED-78-04 | 所有 DTO 有 shared schema | REQ-29-04 | P01-01（P01） | VERIFIED（2026-10-07 持续扩充：Analytics sampling/performance/scene learning 与 Finance source/template/artifact DTO 位于 @ancs/contracts，API/SDK/Web/testing 共用） |
| LED-78-05 | Asset 上传流程不依赖 browser-only logic | REQ-26-02 | P02-04（P02） | VERIFIED（2026-10-05 对账回填：上传=意图 + 直传 PUT + 确认（纯 HTTP/标准客户端；集成测试与基线脚本均非浏览器路径）；证据：P02-04/P08-04） |
| LED-78-06 | Job progress 有通用事件协议 | REQ-29-06 | P02-06（P02） | VERIFIED（2026-10-05 对账回填：job.* 事件协议（Outbox + SSE，单调 seq 游标）；证据：docs/verification/P02-06.md） |
| LED-78-07 | Project/Scene 使用 server revision | REQ-29-05 | P02-02（P02） | VERIFIED（2026-10-05 对账回填：条件更新（base/expected revision）+ 409 刷新信息；证据：docs/verification/P02-02.md） |
| LED-78-08 | Business logic 不依赖 Next.js | REQ-29-02/REQ-49-02 | P00-02/P01-05（P00/P01） | VERIFIED（2026-10-05 对账回填：arch-check R1—R3 机械强制（domain/contracts 禁 Next/React/Remotion；apps 隔离）；API 独立于 Web 运行（P01-05）） |
| LED-78-09 | Provider logic 不依赖 Web | REQ-49-02/REQ-15-01 | P03-03（P03） | VERIFIED（2026-10-05 对账回填：Provider 逻辑位于 packages/providers/*（R3/R4 强制：providers 只依赖 contracts/domain；Web 不可达）） |
| LED-78-10 | Render 在 server/cloud | REQ-39-01 | P07-04（P07） | VERIFIED（2026-10-05：Server render=apps/render-worker，Worker 经进程隔离执行器（spawn，硬超时）调度；FFmpeg=Remotion 内置编码管线（独立 ffmpeg 后处理属 P08 运维口径，诚实记录）；证据：docs/verification/P07-04.md） |
| LED-78-11 | Notification 由 backend event 产生 | REQ-61-01 | P02-06（P02） | VERIFIED（2026-10-05 对账回填：通知由后端事件（Outbox → 派发）产生；证据：docs/verification/P02-06.md） |

## 3. 附录 C 首批工程验收清单（49 项）

### 3.1 Architecture（8）

| ID | 条目 | 关联 REQ | 任务（阶段） | 状态 |
|---|---|---|---|---|
| LED-C-ARCH-01 | Monorepo exists | REQ-49-01 | P00-02（P00） | VERIFIED（2026-10-04，证据：docs/verification/P00-02.md） |
| LED-C-ARCH-02 | Web and API are separate apps | REQ-29-02 | P00-02/P01-05（P00/P01） | VERIFIED（2026-10-05 对账回填：apps/web 与 apps/api 分离（各自构建/启动；R1 禁止 apps 相互依赖）） |
| LED-C-ARCH-03 | Shared contracts package exists | REQ-29-04 | P01-01（P01） | VERIFIED（2026-10-04：@ancs/contracts 正式化，被 api/sdk/testing 共用；证据：docs/verification/P01-01.md） |
| LED-C-ARCH-04 | OpenAPI generated | REQ-29-04/REQ-33-02 | P01-01（P01） | VERIFIED（2026-10-04 机制已核：/openapi.json 由同一份 Zod 契约生成并被测试断言；内容随 P01 扩展。证据：docs/verification/P00-03.md） |
| LED-C-ARCH-05 | SDK usable independently | REQ-29-02 | P01-05（P01） | VERIFIED（2026-10-04：全量 SDK + 独立客户端示例实跑 + CI 工作流测试；证据：docs/verification/P01-05.md） |
| LED-C-ARCH-06 | PostgreSQL migration system works | REQ-34-01 | P00-02 起（P00/P02） | VERIFIED（2026-10-04：drizzle-kit 生成 + runMigrations + CI 每套件执行；已累积迁移 0000—0018） |
| LED-C-ARCH-07 | Redis/BullMQ works | REQ-19-05 | P03-01（P03） | VERIFIED（2026-10-04：真实 Redis + BullMQ 端到端（投递/持久/多 Worker 无重复消费）；DbPollQueue 回退；证据：docs/verification/P03-02.md） |
| LED-C-ARCH-08 | Object Storage direct upload works | REQ-26-02 | P02-04（P02） | VERIFIED（2026-10-04：意图→签名直传→确认→下载（真实本地驱动）；S3/R2 云适配器待真实凭据） |

### 3.2 Domain（10）

| ID | 条目 | 关联 REQ | 任务（阶段） | 状态 |
|---|---|---|---|---|
| LED-C-DOM-01 | Workspace | REQ-22-01 | P01-03（P01） | VERIFIED（2026-10-04：workspaces/workspace_members + 迁移 0001 + 服务与授权；证据：docs/verification/P01-03.md） |
| LED-C-DOM-02 | Channel | REQ-6-01/REQ-22-02 | P01-04（P01） | VERIFIED（2026-10-04：channels + 不可变样式版本 + 快照语义测试；证据：docs/verification/P01-04.md） |
| LED-C-DOM-03 | Creator Profile | REQ-6-02 | P01-04（P01） | VERIFIED（2026-10-04：CreatorIdentity + 独立版本化子身份（Avatar/Voice/Brand）+ SpeechProfile；证据：docs/verification/P01-04.md） |
| LED-C-DOM-04 | Project | REQ-22-02 | P02-01（P02） | VERIFIED（2026-10-04：projects 表 + Channel 快照 FK + revision；证据：docs/verification/P02-01.md） |
| LED-C-DOM-05 | Scene | REQ-22-03 | P02-01（P02） | VERIFIED（2026-10-04：scenes 规范化表 + 独立 revision + Graph 组装） |
| LED-C-DOM-06 | Asset | REQ-22-04 | P02-04（P02） | VERIFIED（2026-10-04：assets/asset_versions 全字段 + 17 种 AssetType；证据：docs/verification/P02-04.md） |
| LED-C-DOM-07 | Version | REQ-23-03 | P02-03（P02） | VERIFIED（2026-10-04：project_versions 不可变快照 + 自动时机；证据：docs/verification/P02-03.md） |
| LED-C-DOM-08 | Edit Event | REQ-23-02 | P02-02（P02） | VERIFIED（2026-10-04：edit_events 全字段 + base/result revision + 同事务 Outbox；证据：docs/verification/P02-02.md） |
| LED-C-DOM-09 | Job | REQ-19-01 | P03-01（P03） | VERIFIED（2026-10-04：jobs 九态状态机 + 依赖 + 租约 + 对账字段；证据：docs/verification/P03-01.md） |
| LED-C-DOM-10 | Provider Generation | REQ-25-01 | P03-05（P03） | VERIFIED（2026-10-04：provider_generations 全字段 + 幂等记录/结算；回收链路写入（P03-06）；真实成本数值待 P06） |

### 3.3 AI（6）

| ID | 条目 | 关联 REQ | 任务（阶段） | 状态 |
|---|---|---|---|---|
| LED-C-AI-01 | ContentDocument schema | REQ-7-01 | P04-01（P04） | VERIFIED（2026-10-04：三种文本输入 → 统一 ContentDocument（块规范化落库）；证据：docs/verification/P04-01.md） |
| LED-C-AI-02 | NarrativePlan schema | REQ-8-01 | P04-03（P04） | VERIFIED（2026-10-04：NarrativePlan 全字段 + 版本化落库 + 有限修复/锁定保留/逐字门控；证据：docs/verification/P04-03.md） |
| LED-C-AI-03 | SceneGraph schema | REQ-12-01 | P01-01/P02-01（P01/P02） | VERIFIED（2026-10-04：契约就绪（P01-01）+ DB 状态组装为合法 Graph（P02-01）） |
| LED-C-AI-04 | Visual Grammar mapping | REQ-10-01 | P04-04（P04） | VERIFIED（2026-10-04：34 类语义映射（23 基础 + 11 财经）+ 确定性识别（33/34；TRANSITION 属结构层）+ 允许类型 ⊆ V1 标准 20 类（DEC-04）+ 数据/来源门控与降级阶梯复用 P04-02；证据：docs/verification/P04-04.md） |
| LED-C-AI-05 | Director structured output | REQ-9-02/REQ-52-01 | P04-05（P04） | VERIFIED（2026-10-04：DirectorPlan 六类输出（场景/资产/任务/成本/告警/决策摘要）+ 确定性规划（章节结构场景、Router 决定 Provider、BigInt 定点成本）+ Schema/来源/Lock/预算四类应用前验证 + 经编辑协议原子应用（幂等）；证据：docs/verification/P04-05.md） |
| LED-C-AI-06 | AI Edit change plan | REQ-37-01 | P05-06（P05） | VERIFIED（2026-10-04：EditPlan（operation+rationale+差异+影响）不落库；Apply 经编辑协议（revision 条件/事务/补偿可撤销）；锁定剔除 + 非法整批拒绝有测试；证据：docs/verification/P05-06.md） |
| LED-C-AI-07 | Claims/Citations 可追溯（Claim→Citation→Source；图表绑定门控与降级阶梯） | REQ-7-02/REQ-10-03/REQ-56-01 | P04-02（P04） | VERIFIED（2026-10-04：确定性抽取产出 Claim+Citation（块 ID+字符区间+引文）；数据集绑定门控（非 synthetic/非空/有来源）；缺数据降级阶梯（不虚构数列）；证据：docs/verification/P04-02.md） |

### 3.4 Video（7）

| ID | 条目 | 关联 REQ | 任务（阶段） | 状态 |
|---|---|---|---|---|
| LED-C-VID-01 | Remotion Player | REQ-38-01 | P05-04（P05） | VERIFIED（2026-10-05 对账回填：@remotion/player 实时预览；证据：docs/verification/P05-04.md） |
| LED-C-VID-02 | Standard Scene library | REQ-11-01/REQ-65-01 | P05-02（P05） | VERIFIED（2026-10-05 对账回填：20 类标准组件 + 画廊渲染证据；证据：docs/verification/P05-02.md） |
| LED-C-VID-03 | Draft preview | REQ-38-01/REQ-18-01 | P05-04（P05） | VERIFIED（2026-10-05 对账回填：Draft 预览（组件占位明确；与成片共用时序）；证据：docs/verification/P05-04.md） |
| LED-C-VID-04 | Master narration | REQ-13-01 | P06-03（P06） | VERIFIED（2026-10-04：逐段合成→拼接→Master 资产（自有存储/校验和）；真实 TTS 音质与语言覆盖待 P06-02 凭据；证据：docs/verification/P06-03.md） |
| LED-C-VID-05 | Subtitle timing | REQ-13-02/REQ-58-01 | P06-03/P06-06（P06） | VERIFIED（2026-10-04：词级时间戳 + cues（P06-03）+ SRT/VTT 导出与断行（P06-06）） |
| LED-C-VID-06 | Final render | REQ-39-01/REQ-64-05 | P07-04（P07） | VERIFIED（2026-10-05：同 LED-77-18；产物四件套（MP4/SRT/VTT/Manifest）全部入自有存储并可读回） |
| LED-C-VID-07 | Manifest | REQ-28-01 | P07-04（P07） | VERIFIED（2026-10-05：同 LED-77-20） |

### 3.5 Reliability（6）

| ID | 条目 | 关联 REQ | 任务（阶段） | 状态 |
|---|---|---|---|---|
| LED-C-REL-01 | idempotency | REQ-33-01/REQ-69-01 | P02-02/P03-05（P02/P03） | VERIFIED（2026-10-05 对账回填：编辑协议/API 幂等（P02-02）+ 幂等键 TTL（P02-05）+ 凭据操作幂等（P03-04）+ 账本结算幂等/用量唯一键（P03-05）+ 生成去重键（P06-05）+ 渲染/QA/审批幂等键（P07-03—06）） |
| LED-C-REL-02 | retry policy | REQ-19-03/REQ-71-01 | P03-02（P03） | VERIFIED（2026-10-05 对账回填：退避+抖动、重试上限、租约回收、对账标记（429/提交未知不自动重复付费）；证据：docs/verification/P03-02.md、P03-07.md） |
| LED-C-REL-03 | provider concurrency limiter | REQ-19-03/REQ-19-04 | P03-01/P03-03（P03） | VERIFIED（2026-10-05 对账回填：Provider 并发信号量配置模型 + 429 退避（P03-03）；真实后端并发观测随凭据） |
| LED-C-REL-04 | result persistence | REQ-45-02/REQ-71-01 | P03-06（P03） | VERIFIED（2026-10-05 对账回填：结果回收链路（下载→校验→自有存储→Asset；重试只回收不重生成）；证据：docs/verification/P03-06.md） |
| LED-C-REL-05 | failure fallback | REQ-55-01 | P04-05/P03-02（P04/P03） | VERIFIED（2026-10-05 对账回填：降级链（Director 受控降级阶梯 + needs_review；失败重试语义（P03-02））；证据：P04-05/P03-02） |
| LED-C-REL-06 | cost ledger | REQ-25-01/REQ-35-02 | P03-05（P03） | VERIFIED（2026-10-04：credit_ledger 只追加（余额为条目效果推论）+ 预算/原子预留/结算幂等/退款（HOLD_RELEASE 释放）全链路测试；Provider 成本数值随 P06 实测写入） |
| LED-C-REL-07 | pre-publish QA pipeline | REQ-86-01/REQ-86-02 | P07-05（P07） | VERIFIED（2026-10-05：渲染完成后**自动**入队 QA（§86）；同一检查引擎服务渲染前预检与 Final QA；技术核验为**独立复核**（校验和重算/MP4 元数据探测/字幕边界）；内容核验（占位/needs_review/图表数据/来源/缺素材/未完成 Provider 任务）；阻止项失败 → Render FAILED；响度/AI 视觉 QA 显式 SKIP 记录（未交付，不静默）；证据：docs/verification/P07-05.md） |
| LED-C-REL-08 | human approval gate | REQ-54-02/REQ-87-01 | P07-06（P07） | VERIFIED（2026-10-05：批准绑定 renderId+manifestHash+projectVersionId+projectRevision（append-only）；**未批准/驳回/批准失效不能导出**（409 守卫）；批准 → 受控导出（MP4/SRT/VTT/Manifest 签名 URL，TTL 15 分钟），集成测试真实下载字节与 Manifest sha256 一致；证据：docs/verification/P07-06.md） |
| LED-C-REL-09 | reproducible deployment（Runbook + fail-closed 配置） | REQ-50-01 | P08-01（P08） | VERIFIED（2026-10-05：环境配置契约一次收集全部问题（含未实现驱动的显式拒绝）；docs/ops/deployment-runbook.md（安装/构建/数据库/存储/启动/队列/验证/边界）；**可执行演练**（pnpm run deploy:rehearsal）在全新库上 0—7 步 + 反向校验 10/10 PASS（构建→建库→迁移 54 表→API /health→Worker 单轮→存储卷校验和→错误配置必须失败→清理）；CI 在 verify 后运行该演练；证据：docs/verification/P08-01.md） |
| LED-C-REL-10 | minimal ops console（admin 角色分离） | REQ-67-01/REQ-67-02 | P08-02（P08） | VERIFIED（2026-10-05：平台管理员名单来自部署配置（与 workspace 角色完全分离，OWNER 403 不适用→404 反枚举/未认证 401/空名单整面不可用）；`/admin` 界面（总览/失败任务+人工重试/审计）经 `/api/v1/admin/*`；人工重试复用任务服务（预算/幂等/版本规则不变）；证据：docs/verification/P08-02.md） |
| LED-C-REL-11 | monitoring & recovery（指标/告警/备份恢复/密钥轮换） | REQ-44-01/REQ-44-02/REQ-72-01 | P08-03（P08） | VERIFIED（2026-10-05：日志脱敏强制（[REDACTED]；单测断言原文不落日志）；`/admin/metrics` Prometheus 导出（API 错误率/延迟桶/队列/渲染/QA/审批/成本/告警）；告警阈值表（overview.alerts + /admin 展示）；**恢复演练 8/8**（备份→隔离恢复→读取固定版本→**重渲染固定版本**→密钥轮换断言，CI 执行）；证据：docs/verification/P08-03.md） |
| LED-C-REL-12 | performance baseline & fault semantics | REQ-70-01/REQ-71-01 | P08-04（P08） | VERIFIED（2026-10-05：基线六项达 §70 API 目标（Scene patch p95 60ms<150ms；预览回合 p95 72.7ms<500ms；列表/场景图/上传记录）；队列 50 任务恰好一次（attempts=1）+ 并发认领不重复；存储故障注入 → 受控失败（下载 404 / 确认明确失败）；浏览器侧列明未测；证据：docs/verification/P08-04.md） |

### 3.6 Security（6）

| ID | 条目 | 关联 REQ | 任务（阶段） | 状态 |
|---|---|---|---|---|
| LED-C-SEC-01 | tenant isolation tests | REQ-43-01/REQ-51-06 | P01-03（P01） | VERIFIED（2026-10-04：test:security 真实套件 14 项含跨租户全拒绝；资源维度随 P02 扩充） |
| LED-C-SEC-02 | KMS secret encryption | REQ-17-03/REQ-43-06 | P03-04（P03） | VERIFIED（2026-10-05 对账回填：凭据密文 AES-256-GCM（本地实现，密钥脱敏/轮换影响文档化；真实云 KMS 随部署阶段）；证据：docs/verification/P03-04.md、docs/ops/monitoring-recovery.md §6） |
| LED-C-SEC-03 | signed upload | REQ-26-02 | P02-04（P02） | VERIFIED（2026-10-05 对账回填：Signed URL 上传（作用域 + TTL + 端点校验）；证据：docs/verification/P02-04.md） |
| LED-C-SEC-04 | SSRF protection | REQ-43-02 | P04-01（P04） | VERIFIED（2026-10-05 对账回填：SSRF 防护（逐跳校验/私网拒绝/大小与超时）；证据：docs/verification/P04-01.md） |
| LED-C-SEC-05 | no secrets in logs | REQ-17-03/REQ-44-02 | P03-04/P08-03（P03/P08） | VERIFIED（2026-10-05 对账回填：日志强制脱敏（Authorization/Cookie → [REDACTED]；单测断言原文不落日志）；证据：docs/verification/P08-03.md） |
| LED-C-SEC-06 | custom motion sandbox design | REQ-11-03/REQ-43-05 | P07-01/P07-02（P07） | VERIFIED（2026-10-04：apps/motion-worker——隔离子进程（vm 白名单上下文）+ 双重静态分析 + 攻击 fixture 矩阵（网络/文件/依赖/Secret/eval/原型污染）全拒 + 无限循环硬超时 kill + RAM 上限 + 渲染 smoke。2026-10-05（P07-02）：门禁落地——类型检查（tsc 内存程序）+ 多帧抽帧 + **仅 APPROVED 版本化落库（拒绝零行零对象）** + 零依赖白名单；证据：docs/verification/P07-01.md、P07-02.md） |

### 3.7 Multi-client readiness（6）

| ID | 条目 | 关联 REQ | 任务（阶段） | 状态 |
|---|---|---|---|---|
| LED-C-MC-01 | no domain logic in web-only components | REQ-2-06/REQ-49-02 | P00-02/P01-05（P00/P01） | VERIFIED（2026-10-05 对账回填：R1—R3 机械强制（业务逻辑在 domain/API/SDK；Web 仅消费 SDK）） |
| LED-C-MC-02 | auth flow supports native clients | REQ-30-03 | P01-02（P01） | VERIFIED（2026-10-04：PKCE S256 + 轮换令牌全流程真实测试；证据：docs/verification/P01-02.md） |
| LED-C-MC-03 | revision-based edits | REQ-23-04/REQ-29-05 | P02-02（P02） | VERIFIED（2026-10-04：条件更新 + 409 刷新信息，服务与 HTTP 双层锁定） |
| LED-C-MC-04 | realtime event protocol | REQ-29-06 | P02-06（P02） | VERIFIED（2026-10-05 对账回填：realtime 事件协议（Outbox + SSE，seq 游标）；证据：docs/verification/P02-06.md） |
| LED-C-MC-05 | shared SDK | REQ-29-04 | P01-05（P01） | VERIFIED（2026-10-04：@ancs/sdk 全量资源面，双认证模式） |
| LED-C-MC-06 | no browser-only asset model | REQ-26-02/REQ-63-01 | P02-04（P02） | VERIFIED（2026-10-05 对账回填：资产模型为 server 权威（storage_key + 意图/确认；无浏览器专有逻辑）；证据：docs/verification/P02-04.md） |

## 4. §96 v0.2 增量验收清单（21 项）

### 4.1 Scope（3）

| ID | 条目 | 关联 REQ | 任务（阶段） | 状态 |
|---|---|---|---|---|
| LED-96-SCOPE-01 | V1 明确只以 Article → Professional Long Video 为主链路 | REQ-1-01 | P00/P08-06（P00/P08） | VERIFIED（2026-10-05 对账回填：范围裁决（计划 §1.2/§2）：V1=Article → Professional Long Video 主链路（P04—P07 全链路证据）） |
| LED-96-SCOPE-02 | Shorts / Social / Publishing / Newsletter 不阻塞 V1 | REQ-1-01/REQ-4-06 | P00（范围裁决） | VERIFIED（2026-10-05 对账回填：范围裁决：Shorts/Social/Publishing/Newsletter 不阻塞 V1（计划 §1.3 明确非 V1）） |
| LED-96-SCOPE-03 | Extension contracts 不依赖 Web 前端 | REQ-92-01 | P01-06（P01） | VERIFIED（2026-10-04：R3 机械强制平台中立包（contracts/extensions 禁 Web 框架）；裁决 0004） |

### 4.2 Creator Identity / Voice（6）

| ID | 条目 | 关联 REQ | 任务（阶段） | 状态 |
|---|---|---|---|---|
| LED-96-VOICE-01 | CreatorIdentity / AvatarIdentity / VoiceIdentity 数据模型存在 | REQ-6-02/REQ-6-03/REQ-6-04 | P01-04/P06-02（P01/P06） | VERIFIED（2026-10-05 对账回填：三身份数据模型（版本化子身份）；证据：docs/verification/P01-04.md） |
| LED-96-VOICE-02 | VoiceProvider 不绑死 ElevenLabs/HeyGen | REQ-6-04/REQ-14-03 | P06-02（P06） | VERIFIED（2026-10-05 对账回填：Provider 无关路由（Catalog/Router/Adapter；Mock 与真实适配器同契约）；真实 Provider 接入受凭据阻塞另行核验） |
| LED-96-VOICE-03 | 支持 Platform Managed 与 BYOK Voice 路由 | REQ-6-07/REQ-17-02 | P06-02（P06） | VERIFIED（2026-10-05 对账回填：Platform Managed 与 BYOK 路由决策（P03-04）；真实托管密钥随凭据阶段） |
| LED-96-VOICE-04 | 保存 Voice ownership / verification metadata | REQ-95-01 | P06-02（P06） | VERIFIED（2026-10-05 对账回填：ownership/verification metadata（P01-04 模型 + P03-04 凭据绑定；SELF_VERIFIED/SHARED_LICENSED 等枚举）） |
| LED-96-VOICE-05 | SpeechProfile / Speech Director schema 已定义 | REQ-6-08/REQ-94-01 | P04-06（P04） | VERIFIED（2026-10-04：SpeechPlan 契约（§94 输出字段全集）+ 确定性生成 + 供应商无关（私有参数零泄漏，字符串级断言）+ 可解释降级；SpeechProfile 契约自 P01-04；证据：docs/verification/P04-06.md） |
| LED-96-VOICE-06 | Master Narration timestamp 仍是最终 Timeline timing 基础 | REQ-13-01/REQ-94-02 | P06-03（P06） | VERIFIED（2026-10-04：Alignment/cues 为唯一 timing 来源（驱动画面/字幕/Avatar/Motion 的接入随 P06-04/06/P07）；证据：docs/verification/P06-03.md） |

### 4.3 Commercial（4）

| ID | 条目 | 关联 REQ | 任务（阶段） | 状态 |
|---|---|---|---|---|
| LED-96-COM-01 | Software plan 与 AI compute ledger 分离 | REQ-73-01/REQ-35-02 | P03-05（P03） | VERIFIED（2026-10-05 对账回填：软件计划与 AI compute ledger 分离（billing policy 配置化；账本只追加）；证据：docs/verification/P03-05.md） |
| LED-96-COM-02 | 不存在"无限 Managed AI Generation"硬编码套餐 | REQ-73-01 | P03-05/P09-01（P03/P09） | VERIFIED（2026-10-05 对账回填：无"无限 Managed AI Generation"硬编码套餐（预算/额度模型 + 按任务成本记账；套餐 UI 随 P09-01）） |
| LED-96-COM-03 | Final Render 前可估算 Credits / provider cost | REQ-73-05/REQ-9-02 | P03-05/P07-03（P03/P07） | 进度（Render.estimatedCost 字段已建模（P07-03）；按快照的渲染前估算实现待定——随真实 Provider 成本口径（P06 凭据）与 P09 运营） |
| LED-96-COM-04 | BYOK 用户可以绕过平台托管 Provider 用量，但仍通过统一 Router/Adapter | REQ-17-02/REQ-73-04 | P03-04/P06-02（P03/P06） | VERIFIED（2026-10-05 对账回填：BYOK 绕过平台用量但仍经统一 Router/Adapter（P03-04 决策路径测试）；真实 BYOK 凭据随凭据阶段） |

### 4.4 Publishing（5）

> P13-07 增量核验（2026-10-07）：CMS READY 回写已通过共享契约、REST/SDK、签名、SSRF、有限重试与崩溃恢复矩阵；回写失败不修改 Render，证据见 `docs/verification/P13-07.md`。

| ID | 条目 | 关联 REQ | 任务（阶段） | 状态 |
|---|---|---|---|---|
| LED-96-PUB-01 | DistributionProvider 有 capability registry | REQ-42-02/REQ-42-03 | P01-06（P01）契约；P13-01 实现 | VERIFIED（2026-10-04：契约级——DistributionProvider 接口 + ExtensionRegistry 持有分发 Provider；真实平台接入 P13-01。证据：docs/verification/P01-06.md） |
| LED-96-PUB-02 | 支持 P1/P2/P3/P4 体验（V1=能力分级类型与协议；完整体验 P13-04） | REQ-42-02/REQ-42-04 | P01-06（契约）；P13-04 完整 | VERIFIED（2026-10-04：契约级——P1—P4 分级类型与协议就位；完整体验 P13-04） |
| LED-96-PUB-03 | P4 可生成 Export Package | REQ-42-04 | P13-04（P13） | 进度（P07-06 交付平台无关的受控导出（四件签名 URL + Manifest 一致）；P4 平台适配包（含发布元数据/封面等）随 P13-04） |
| LED-96-PUB-04 | 核心产品不以 browser automation 作为可靠发布能力 | REQ-42-06 | 全期；P13-01 审计 | VERIFIED（2026-10-05 对账回填（V1 审计）：V1 不含任何发布能力，不存在以 browser automation 冒充可靠发布的实现；发布属 P13（审计义务记录于后续）） |
| LED-96-PUB-05 | Mobile Handoff 协议已预留 | REQ-42-05/REQ-42-03 | P01-06（P01）契约；P15-06 完整 | VERIFIED（2026-10-04：HandoffDescriptor 契约（状态机/限时/artifacts）就位；完整实现 P15-06） |

### 4.5 Plugin Readiness（3）

| ID | 条目 | 关联 REQ | 任务（阶段） | 状态 |
|---|---|---|---|---|
| LED-96-PLUGIN-01 | OutputPlugin / Pack registry contract 已定义 | REQ-92-01/REQ-92-03 | P01-06（P01） | VERIFIED（2026-10-04：OutputPlugin 接口 + PackManifest + registry 就位并测试） |
| LED-96-PLUGIN-02 | Core 业务没有对 XHS/YouTube/Newsletter 等输出类型硬编码分支 | REQ-92-02 | P11-04 审计（P11） | VERIFIED（2026-10-06 P11-04 审计：domain/contracts/api **非测试**代码无 `outputType ===` 与平台名（YOUTUBE/XHS/XIAOHONGSHU/TIKTOK/NEWSLETTER…）条件分支（零命中）；渠道键仅作为 Recipe 种子数据（atoms.ts）与 Pack manifest 声明（official-packs.ts，经公开契约消费）；输出形态经 Pack analyze 扩展（P11-03）；证据：docs/verification/P11-04.md） |
| LED-96-PLUGIN-03 | ContentDocument / Narrative 可向 ContentCore 演进 | REQ-93-01 | P11-01（P11） | VERIFIED（2026-10-06：P11-01 无损演进——ContentDocument/claims/project_sources 1:1 派生 ContentCore，原文档零改动、幂等可重跑、漂移可发现；证据：docs/verification/P11-01.md） |

## 汇总

> P14 增量核验（2026-10-07）：P14-01—05 全部 VERIFIED；Analytics 与 Finance Web 工作台、REST/SDK、迁移 0047—0050、许可/模板历史快照及 810 项全量断言证据见 docs/verification/P14-01.md—P14-05.md。按用户要求，P15/P16 在人工检查前暂停。

| 来源 | 条目数 | 状态（P08-06 对账后） |
|---|---|---|
| §77 Web MVP DoD | 24 | 21 VERIFIED / 0 进度 / 0 TODO / 3 BLOCKED |
| §78 Multi-Client Readiness | 11 | 11 VERIFIED / 0 进度 / 0 TODO / 0 BLOCKED |
| 附录 C | 56 | 56 VERIFIED / 0 进度 / 0 TODO / 0 BLOCKED |
| §96 增量验收 | 21 | 19 VERIFIED / 2 进度 / 0 TODO / 0 BLOCKED（2026-10-06 更新：LED-96-PLUGIN-02/03 → VERIFIED） |
| 合计 | 112 | 见上（P08-06 对账：2026-10-04；2026-10-06：§96 PLUGIN-02/03 闭合） |

本账本与 `traceability.md` 的"状态"列同步维护；关闭动作记录在 `docs/verification/` 对应阶段文件中。
