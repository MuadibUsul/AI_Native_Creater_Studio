# v0.4 增量来源、术语和阶段映射

本表落实 `docs/V04/ANCS_AI_Native_v0.4.md` §1.4、§12.6、§21.4、§26.5、§27 和任务 N00-07。`[U01]` 是用户提供的 `docs/ANCS_Descript_Competitive_Architecture_Plan_2026-10-08.md`；`[U02]` 是详尽运营后台要求；`[U03]` 是苹果式极简白／黑设计要求。v0.4 总规范是当前需求权威，`docs/V04/ANCS_v0.4_Task_Backlog.md` 及 `docs/requirements/ai-native-v04-acceptance-ledger.md` 是唯一 N 任务执行账本。下列 P15—P23、T1—T6 是**来源标签／切片映射**，不创建第二组任务、迁移或完成状态。

## [U01] §0—19 逐项处置

“采纳／扩展”表示需求进入规范，不表示代码已经实现；“来源声明”表示仍需以当前代码和测试核验。需求 ID 可在 `docs/requirements/ai-native-v04-traceability.md` 查到。

| 来源章节 | 处置与合并边界 | 当前规范／需求 | 唯一 N 任务落点 |
|---|---|---|---|
| §0 结论 | 采纳增量改造与画布中心；旧工程和有效历史保留；来源所说的仓库现状先重审。 | §1.4、§12.6、§21.4；V04-01/02/26 | N00-01/02/07，N01-10 |
| §1.1 Agent 编辑工具 | 扩展结构化工具注册与直接操作共用编辑原语，不给 Agent 绕过权限、预算或锁。 | §9.5—9.7；V04-17/18 | N07-09—11，N13-03/10 |
| §1.2 Media Understanding | 扩展统一 Media Index、分阶段就绪和可回溯证据；不把低采样总结当帧级定位。 | §5.7—5.9；V04-04—09 | N02-10—15，N07-13 |
| §1.3 Template / Workflow Recipe | 扩展为有证据与版本的导演策略包；不是一条风格提示词。 | §16.8—16.9；V04-21/22 | N10-11—13 |
| §1.4 Web 媒体引擎 | 扩展标准代理播放、可靠回退、精确定位和共享 RenderPlan；保留有效 Remotion 图形链路。 | §15.6—15.11；V04-10—14 | N03-11—16，N09-09—11 |
| §1.5 生成式修复 | 扩展九类能力的时空范围、报价、授权、身份、血缘和连续性验收；纯素材模式后台禁生成。 | §14.6—14.7；V04-23/24/25 | N08-09/10，N11-10—13，N13-10 |
| §2.1 不以转写为中心 | 保留文字转写入口，但默认交互围绕共看片画布和素材／作品。 | §4.5；V04-16 | N04-01/11 |
| §2.2 不堆 AI 按钮 | 渐进展示 Smart Timeline、Inspector 和命令入口；专业能力继续存在。 | §4.5；V04-16 | N04-07/11，N16-06/07 |
| §2.3 Credits 透明 | 扩展报价、耗时不确定性、重试和退款语义；不把无媒体生成误称零成本。 | §18.6、§28.10—28.11；V04-25/38/39 | N13-03/10，N15-19—23 |
| §2.4 专业控制 | 保留鼠标／触控／键盘精确操作和专业覆盖目标；按场景能力与证据验收。 | §6、§13.5；V03-14—23、V04-03 | N01-11，N03，N11，N12 |
| §3.1 Pointer-Grounded Editing | 将 SelectionAnchor 纳入 AttentionSnapshot，绑定对象、观看版本、媒体时间和发话时间；歧义不得猜选。 | §7.5；V04-15 | N04-02/05/09/10 |
| §3.2 Conversational Edit Loop | 保留持续试改、局部回放、再次修改与明确采用；未采用不改确认工程。 | §9.6、§10.6；V04-18/19 | N06-10/11，N07-10/11 |
| §3.3 Decision Notebook | 扩展拒绝理由、策略影响和长期偏好提议；只有明确授权才晋升长期默认。 | §11.4；V04-20 | N07-12 |
| §3.4 Reference → Strategy | 扩展参考蓝图与可执行策略包，证据片段、观测／推测／未知分开。 | §16.8—16.9；V04-21/22 | N10-11—13 |
| §4 当前仓库评估 | 作为历史来源声明保留；“已实现／强项／缺口”以当前 HEAD 和独立验证重审，不直接计入完成。 | §2、§26.5、§27；V04-01 | N00-01/07，具体能力归对应 N 任务 |
| §5 MediaSource / Clip 模型 | 术语合并到单一 ProjectDocument、SourceAssetVersion 和 Clip；不建第二套可变原件或入出点。 | §12.6；V04-02 | N01-02/03/10，N02-02 |
| §6 Edit Operation v2 | 扩展操作清单与旧别名编译，GUI、快捷键和 Agent 共用服务端校验。 | §13.5；V04-03 | N01-06/11，N07-09 |
| §7 Selection / Grounding | SelectionAnchor 是 AttentionSnapshot 内的稳定选择；旧毫秒字段兼容读取，不降低精确时基。 | §7.5；V04-15 | N04-09/10 |
| §8 Agent 架构 | 采纳 Tool Registry、上下文和结果证据合同；先扩展现有包，物理拆包按部署需要决策。 | §9.5—9.7、§17.6；V04-17/18/25 | N07-09—13，N13-10 |
| §9 Preview Branch | 归入 Proposal 私有候选；拒绝不改变正式编辑历史，但费用、任务和审计留存。 | §10.6；V04-19 | N06-01/10/11 |
| §10 Media Understanding 服务 | 归入统一 Media Index 的异步阶段、缓存、纠错与权限生命周期，不另造第二份检索事实。 | §5.7—5.9、§17.6；V04-04—09 | N02-10—15 |
| §11 Editing Strategy Schema | 归一为 DirectorStrategyPackage 及其 DNA／Recipe 投影；证据、能力和版本可校验。 | §16.8—16.9；V04-21/22 | N10-11—13 |
| §12 专业能力路线 | 保留三层分期，但不缩减 v0.3 已列的专业目标；外部 round-trip 与原生完成分列。 | §6、§13.5、§21.4；V03-14—23/57/60 | N03，N11，N12 |
| §13 Playback / Render | 增量建立 PlaybackEngine 与混合 RenderPlan，预览／终渲一致性有独立门；不整体替换 Remotion。 | §15.6—15.11；V04-10—14 | N03-11—16，N09-09—11 |
| §14 新阶段 P15—P23 | 仅保留来源阶段标签，逐项映射到下表；不重编号现有 P 或 N 任务。 | §21.4；V04-26 | N00-07，N13-12；执行项见下表 |
| §15 切片 T1—T6 | 逐项映射到下表；T2 先证明确定性单轨剪辑，不调用 AI。 | §21.4；V04-18/26 | N00-07；执行项见下表 |
| §16 最终验收 | 将用户体验、专业、AI 和架构要求归入各任务及 G0—G4；接口存在和 Mock 不等于真实产品验收。 | §20.6、§21.4、§23；V04-03/10/18/19/24/26 | N03-10，N07-11，N09-08，N12-08，N13-09/12，N14-07 |
| §17 优先级 | 将来源 P0—P3 转为任务依赖和安全门；不按来源阶段号直接施工。 | §21.3—21.4、§23；V04-26 | N00-07，N13-12 |
| §18 最关键工程判断 | 保留“现有内核增量演进、AI 理解选择和持续改进”方向；具体能力需验收。 | §1、§9、§12；V03-01/02/55 | N00，N01，N07 |
| §19 竞品定位 | 保留产品目标，竞品比较不是功能已交付证据；按同素材、同目标对照测试。 | §1、§20；V03-01/60 | N00-04/05，N07-08，N12-08 |

### 研究依据与事实层级

来源文档末尾的“研究依据”列出 Descript Underlord/AI co-editor、Media Understanding、Agent API/MCP、AI Templates、WebCodecs 媒体引擎、生成修复资料，以及当时的 ANCS `main`、Session Handoff、SceneGraph/EditOperation/LiteTimeline/AI Edit/Remotion 代码。它们解释方案动机，**不是本轮独立复核的竞品规格、API 可用性或当前仓库能力**。竞品与技术声明在对应 N02/N03/N07/N08/N10/N13 任务中按实际版本、地区、账号和官方资料复查；旧仓库判断由 N00-01 的当前 HEAD 审阅起步，能力完成仍按真实代码与测试证据判定。v0.4 §26.2 的 [S01]—[S11] 是历史官方技术资料引用；§29.14 的 [D01]—[D05] 支撑设计原则，但 ANCS token 数值为本项目自定，不能写成 Apple 官方 token。

## 来源阶段 P15—P23 → 唯一 N 任务

此处“来源 P15/P16”分别指编辑内核和画布；仓库旧 P15（桌面／手机）与旧 P16（商城／企业）保留原编号及历史暂停记录，**不共享状态**。新 N15 是运营工作流，N16 是设计工作流，也不按数字等到所有客户端完成。

| [U01] §14 来源阶段 | N 任务映射 | 来源退出条件在 v0.4 的处理 |
|---|---|---|
| P15 Editing Core v2 | N00、N01、N02 基础、N03 | 三份真实素材的非破坏性编辑、原件 hash 不变、Undo/Redo；G0 还需适用安全和 O0 门。 |
| P16 Unified Canvas | N03 播放基线、N04 | 同一画布、Smart Timeline、稳定 SelectionAnchor；失效锚点显式返回。 |
| P17 AI Editor Agent | N05、N06、N07 | 五工具持续试改、局部回放、采用和笔记；真实语音另验。 |
| P18 Media Understanding | N02-10—15、N07-13 | probe/proxy 先做，深度索引渐进交付；动作检索需来源区间证据。 |
| P19 Strategy Generator | N10、N02 共享索引 | 参考蓝图＋DNA/Recipe、三内容迁移和版本治理。 |
| P20 Professional NLE | N11、N12、N03 加速与专业后端 | 按专业制作场景验收，不按按钮数量。 |
| P21 Generative Repair | N08-09/10、N11-10—13 | 九类修复逐项验证费用、权限、血缘、可撤销和不干扰。 |
| P22 Desktop / Mobile | N14-03/04/08 | Web 内核成熟后共用契约和 SDK，不复制旧 Scene Editor。 |
| P23 Marketplace / Enterprise | N14-05—07、N13 商业门 | 企业安全基础按依赖提前，商城运行时和多端扩展后验。 |

## 来源切片 T1—T6 → 唯一 N 任务

| [U01] §15 来源切片 | N 任务映射 | 最小证据与边界 |
|---|---|---|
| T1 文档裁决 | N00-01/02/03/07，N13-12 | 生效入口、旧限制替换、安全保留、基线差项；文档通过不算业务能力完成。 |
| T2 MediaSource＋Clip | N01 原语/兼容、N02-01/02/03/07、N03-01/02 及相关 Undo/权限 | 一条视频轨上完成真实导入、移动、trim、split、delete、Undo/Redo；不调用 AI，不取消后续多轨。 |
| T3 Unified Canvas | N03-11/12/13、N04-01/03/04/07/11 | 同页播放、暂停、scrub、选择 Clip/范围、精确检查；baseline 不冒充 WebCodecs/GPU 已完成。 |
| T4 SelectionAnchor | N04-02/05/06/09/10 | 画面、字幕、overlay、音频、范围、发话均绑定版本与时间；冲突/歧义有明确失败。 |
| T5 Preview Branch | N06-01—08、N06-10/11 | create/patch/预览/拒绝/采用；正式历史与实际费用、审计分离。 |
| T6 五工具 Agent | N07-04/09/10/11，依赖相关编辑原语及 T5；后接 N05 真实语音 | 先文字版 trim/move/split/transform/caption-position，多轮局部回放后再采用；不以五工具缩减长期专业能力。 |

## 术语合并与禁止双写

| 来源术语 | 唯一权威／兼容投影 | 禁止的重复状态 | 后续任务 |
|---|---|---|---|
| MediaSource | 不可变 SourceAssetVersion＋源媒体流／属性视图 | 第二份可变原文件或冲突的 source hash | N01-10，N02-02 |
| ClipInstance | ProjectDocument 中 Clip 的一个引用实例，含源/序列范围与时间映射 | 第二套入出点或用 Scene 时长冒充源范围 | N01-03/10，N03-02 |
| SceneGraph v0.2 | ProjectDocument 的兼容投影；SemanticPlan 保留 Scene | 另一个可写工程和独立 Undo | N01-02/05/10 |
| SelectionAnchor | AttentionSnapshot 内的稳定选择，绑定版本、时间和发话上下文 | 两套可变选择或语音返回时重新读取鼠标位置 | N04-09/10 |
| PreviewBranch | Proposal 私有候选及其补丁/快照 | 第二套 acceptedRevision 或正式历史 | N06-10/11 |
| EditDecision | DecisionRecord 的字段增量 | 聊天摘要冒充用户已确认决定 | N07-12 |
| EditingStrategy / Editing DNA / Strategy Manifest | DirectorStrategyPackage 的语法、策略与版本/证据/能力清单 | 仅存风格提示词，或混同作品 FrozenManifest | N10-11—13 |

文档版本、schemaVersion 与产品发布版本分别管理。来源概念字段 `fps`/`duration`/`sourceIn`/`sourceOut` 不要求新契约退回浮点秒；旧毫秒接口经兼容适配读取。拒绝 Proposal 不改确认工程，但不能删除费用、任务和安全审计。允许保留既有 Remotion 能力，新增 PlaybackEngine/RenderPlan 经一致性门逐步开启。

## [U02] 运营后台与 [U03] 设计系统

| 来源 | 纳入范围与门 | N 任务与未完成边界 |
|---|---|---|
| [U02] “详尽运营后台” | v0.4 §28／`ANCS_v0.4_Operations_Backoffice.md` 规定 Studio、Workspace、Platform Ops 权限域及 OP01—OP24；AdminAction 的预检、审批、幂等、副作用对账、脱敏与审计必须覆盖写操作。G0 内部真实使用需 O0/N15-37；对外收费需 O1/N15-38；完整后台 O2/N15-40。 | N15-01—40 横切推进，相关安全/费用门 N13-01—10；现有后台接口或页面不能替代 24 模块和角色回归。 |
| [U03] “苹果极简白、黑” | v0.4 §29／`ANCS_v0.4_Design_System.md` 将中性浅/深主题、字体、层级、留白、交互状态和可访问性应用到 Studio、专业工具、Workspace、Ops；D0 基础与 D1 全站分开验收。 | N16-01—12 横切推进；设计 token JSON/CSS 是参考材料，未接入与未浏览器验证不算完成。主题不改变作品像素、品牌颜色、FrozenManifest 或费用。 |

## 编号、进度与回滚边界

已检查 `docs/decisions/` 当前文件编号 **0001—0009**；来源 T1 建议新建的 `0009-ai-native-professional-editor.md` 与实际 `0009-v04-authority-and-scope.md` 冲突，故采用现有 0009 的生效裁决，**不创建第二个 0009**。旧 `0001-scope-decisions.md` 与 P 系列证据保留历史语义。`docs/V04/task_index.json` 与本版账本有 219 个 N 任务；本文件只是对它们的来源别名和验收目标做索引，不新增 P/T 执行行，也不将来源“已实现”声称转成 VERIFIED。

本映射为文档变更，无 contracts、迁移、domain、API、SDK 或 UI 改动；没有真实媒体、浏览器、Provider、后台或设计系统完成证据。下一步按 N 任务依赖实施。若后续来源事实、用户要求或裁决变化，应追加有证据的映射/ADR 版本，保留此版和旧证据，不重排已有 ID 或抹去历史。
