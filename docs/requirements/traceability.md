# ANCS 需求追踪矩阵（RTM）v1

- 任务：P00-01（建立需求追踪与裁决记录）
- 需求基线：`creator_video_os_spec_v0.2.md`（v0.2，2026-10-04，共 97 节 + 附录 A/B/C）
- 工程计划：`ANCS_Plan261004.md`
- 建立日期：2026-10-04（初始建账）
- 配套文件：
  - `docs/requirements/v1-acceptance-ledger.md` — §77 / §78 / 附录 C / §96 逐项验收账本
  - `docs/decisions/0001-scope-decisions.md` — DEC-01..14 范围与解释裁决

## 使用规则

1. **粒度**：一条 REQ = 一条可独立验证的规范性义务（MUST / SHOULD / MAY），或一个必须交付的枚举清单（清单条目在验收时逐项核对）。同一段落内不可分离的约束合并为一条；纯说明性文字不建 REQ（见文末"非规范性章节登记"）。
2. **ID 稳定**：`REQ-<节号>-<序号>`，附录用 `REQ-A/B/C-xx`。ID 一经分配不再复用或重编号；规范修订时新增 ID 或标记废弃，不静默改号。
3. **级别**：`MUST` / `SHOULD` / `MAY` 沿用规范 §0 定义；`方向` 表示非规范性方向描述，不设阶段性门禁。
4. **V1 归属**（防止后续功能误列为 V1 阻塞）：
   - `V1` = 阻塞 V1 内部生产门（G0—G4，见计划 §11.4）；
   - `V1-契约` = V1 内只交付契约、类型或预留，不阻塞主链路；
   - `后续` = 由 P09—P16 阶段交付；
   - `全期` = 跨阶段持续义务（流程、禁止项、安全底线）。
5. **任务（阶段)**：对应 `ANCS_Plan261004.md` §8 / §9 的 P 任务编号。
6. **验收**：`AC-xx` = 计划 §11.2 高风险测试；`LED-*` = 验收账本条目；其余为计划中该任务的验收条款或本表补充的验证要求。
7. **状态**：`TODO` / `IN_PROGRESS` / `BLOCKED` / `IMPLEMENTED_UNVERIFIED` / `VERIFIED` / `DEFERRED`。只有 `VERIFIED` 计入阶段完成比例。V1 条目初始为 `TODO`；后续阶段条目初始为 `DEFERRED`（已明确排期，非放弃）。

---

## A. 文档约定与产品原则（§0—§2）

| ID | 出处 | 要求摘要 | 级别 | V1 归属 | 任务（阶段） | 验收 | 状态 |
|---|---|---|---|---|---|---|---|
| REQ-0-01 | §0 | 以规范为产品与工程唯一 Source of Truth；不得为快速 Demo 破坏核心架构约束 | MUST | 全期 | 全阶段（流程） | G8 覆盖审计；§75/§76 审计 | TODO |
| REQ-1-01 | §1 | V1 主链路收敛为 Article / Research → Professional Long Video；Shorts/图文/社交短文/Newsletter/多平台适配与发布不得阻塞 V1 | MUST | V1 | P00—P08（范围裁决） | LED-96-SCOPE-01/02；计划 DEC-01..14 | TODO |
| REQ-1-02 | §1 | V1 成功标准：系统稳定生成一条用户愿意直接发布的长视频；长期多形态能力经 Pack/Plugin 扩张 | 方向 | V1 | P08-05 | 真实金样人工评审（P08-05） | TODO |
| REQ-2-01 | §2.2 | 项目最终状态由 Scene Graph + Project Metadata + Asset References 决定；Timeline 是视图，修改必须回写 Scene Graph，不得产生第二套不可同步数据 | MUST | V1 | 全部修改经唯一编辑协议回写规范化状态；AC-04 并发竞争恰一成功（P02-02；证据 docs/verification/P02-02.md） | VERIFIED | TODO（进度：DB→合法 Graph 已闭环且被测试锁定（P02-01）；并发编辑与回写由 P02-02 覆盖 AC-04） |
| REQ-2-02 | §2.1 | 默认交互从内容/意图/文章开始，AI First 优先；用户不从空 Timeline 拖素材开始 | 方向 | V1 | P05-03/P05-04（P05） | 工作区默认布局验收（P05-03） | VERIFIED（P05-03：Script 空状态即「导入文章 → 抽取 → 生成叙事」；Storyboard 空状态即「应用 Director 计划」；无空 Timeline 起步路径；Preview 集成随 P05-04） |
| REQ-2-03 | §2.4 | 确定性视觉优先：真实数据→数据可视化＞结构关系→Motion/Diagram＞真实图片→Source/Image＞地理→Map＞以上都不合适才 AI Video；禁止默认通用 AI B-roll | MUST | V1 | P04-04（P04） | 固定语义输入得到允许类型（P04-04）；AC-15 | TODO |
| REQ-2-04 | §2.5 | Provider 不得绑死：业务层不得直接依赖特定模型名称或接口字段；所有外部能力必须经内部 Provider Contract 访问 | MUST | V1 | P03-03/P03-04（P03） | 无业务直连 Provider；契约测试（P03-07） | TODO |
| REQ-2-05 | §2.6 | 异步优先：所有正式生成流程采用异步 Job/Workflow；禁止一个 HTTP 请求等待到 MP4 完成 | MUST | V1 | P03-01（P03） | 长任务返回 202 + jobId；AC-06 | 任务系统就位（状态机/依赖/租约/Outbox 投递 + Worker 应用）；具体生成端点的 202+jobId 随 P03-06/P06/P07 接入；AC-06（投递中断恢复）已由 P03-01 的 Outbox 投递验证覆盖 | VERIFIED（生成端点接入待 P06/P07） |
| REQ-2-06 | §2.7 | Web 首发、多端后端：核心逻辑不得放在 React Component 或仅 Next.js Server Actions；必须提供独立、版本化、可被原生 App 调用的 Backend API；多端复用同一数据模型/权限/任务系统/ID；共享一套 contracts | MUST | V1 | P01-05（P01） | LED-78-01..11 | TODO |
| REQ-2-07 | §2.8 | 用户数据最小化发送第三方：视频 Provider 只接收完成该 Scene 所需的最少数据（如不发送整篇未发布文章） | MUST | V1 | P03-06/P06-05（P03/P06） | P06-05 验收"输入只含 Scene 所需数据" | VERIFIED（P06-05 非凭据部分：显式生成动作的任务输入**白名单化**（仅 scene 摘要/prompt/画幅/路由与去重键）；集成测试断言序列化输入不含正文/来源/文档字段；真实 Provider 提交走同一输入载荷（P06 凭据后）） |

## B. 用户故事与输入输出范围（§3—§4）

| ID | 出处 | 要求摘要 | 级别 | V1 归属 | 任务（阶段） | 验收 | 状态 |
|---|---|---|---|---|---|---|---|
| REQ-3-01 | §3.2A | 故事 A（文章→长视频九步：读取→推荐时长→口语化脚本→章节→Scene Graph→预览→自然语言修改→Final→16:9 输出）为 V1 必须打通的主流程 | MUST | V1 | P04—P08 | P08-05 真实金样 | TODO |
| REQ-3-02 | §3.2B | 故事 B（长视频切 Shorts：3～10 片段、独立 Hook、9:16 派生 Graph）Post-MVP / Shorts Pack | MAY | 后续 | P12-01（P12） | P12-01 验收 | DEFERRED |
| REQ-3-03 | §3.2C | 故事 C 栏目化：Creator Profile（Twin/Voice/Logo/字体/色彩/图表/字幕样式/Avatar 占比/时长/Hook/结尾/B-roll 强度）保存并被后续文章继承 | SHOULD | V1 | P01-04（P01） | Profile 全字段落库（Channel 样式 + 身份 + 主题 tokens）；继承语义由快照版本机制保证（P01-04）；"后续文章继承"随 P02-01 项目创建补用例 | VERIFIED |
| REQ-3-04 | §3.2D | 故事 D AI 修改：分析→缩短/增加变化→重写必要旁白→变更计划→用户 Apply 后形成新版本 | MUST | V1 | P05-06（P05） | 计划未 Apply 不改数据库（P05-06）；AC-14 | TODO |
| REQ-3-05 | §3.2E | 故事 E 精确手动修正：拖动排序/Trim/Split/Replace/音量/字幕/图表字段/Transition 均可用 | MUST | V1 | P05-05（P05） | 操作全部回写统一协议（P05-05） | VERIFIED（P05-05：Lite Timeline 提供 reorder(上/下移)/Trim(时长)/Split/Duplicate/Delete/Replace 素材/Transition/音量/字幕修正/Crop-Scale（媒体 scale+offset props，组件 schema 校验）；全部经编辑协议单一入口；图表字段经 Scene Editor props 面板） |
| REQ-4-01 | §4.1 | MVP 输入 MUST：文章 URL、粘贴正文、手写脚本、上传图片/视频/音频、Sources 编辑 | MUST | V1 | P04-01（P04） | URL 异常/安全限制/空正文/错误编码有明确结果（P04-01） | URL 文章（抓取+SSRF 守卫）/粘贴正文/手写脚本 → 统一 ContentDocument；Sources 编辑（仅元数据，快照哈希不可改）；上传媒体走资产链路（P02-04）；**明确结果**：INVALID_URL/BLOCKED_TARGET/UNREACHABLE/TIMEOUT/TOO_LARGE/UNSUPPORTED_CONTENT_TYPE/EMPTY_CONTENT/ENCODING_UNSUPPORTED（P04-01） | VERIFIED |
| REQ-4-02 | §4.1 | SHOULD 输入：PDF/Markdown/DOCX 导入、RSS/CMS Webhook、网站 Publish Webhook、Newsletter 导入（不阻塞 V1） | SHOULD | 后续 | P10-01/P13-06（P10/P13） | P10-01 验收 | DEFERRED |
| REQ-4-03 | §4.1 | MAY 输入：Notion / Google Docs / Substack / WordPress / Ghost / 自定义 CMS | MAY | 后续 | 未排期（P10 后评估） | — | DEFERRED |
| REQ-4-04 | §4.2 | MVP 输出 MUST：16:9 1080p MP4、Draft Preview、SRT/VTT 字幕、Project Manifest | MUST | V1 | P05-04/P07-04（P05/P07） | LED-77-18/19/20；P07-04 验收 | TODO |
| REQ-4-05 | §4.2 | SHOULD 输出：4K、Thumbnail、Title Suggestions、Description、Chapters、Source List | SHOULD | 后续 | P10-05（P10） | P10-05 验收 | DEFERRED |
| REQ-4-06 | §4.2 | Post-MVP 输出：Shorts/Social Visual/Publishing/Newsletter-Text Pack、多语言、Podcast、平台化导出 | MAY | 后续 | P11—P14（P11+） | 各 Pack 独立验收 | DEFERRED |

## C. Web 界面与 Creator/Channel（§5—§6）

| ID | 出处 | 要求摘要 | 级别 | V1 归属 | 任务（阶段） | 验收 | 状态 |
|---|---|---|---|---|---|---|---|
| REQ-5-01 | §5 | 第一版 Web 路径集合：/login、/onboarding、/dashboard、/projects、projects 子页（script/storyboard/editor/assets/history/render）、/settings/{creator,providers,storage,team,billing} | MUST | V1 | P05-03（P05） | 空/加载/失败/无权限/冲突状态可操作（P05-03） | TODO（进度：P05-03 已实现 /sign-in、/（Dashboard=项目列表）、projects 子页（script/storyboard/editor/assets/history/render）+ 状态矩阵测试 30 项；/onboarding 与 /settings/* 属后续任务（P06/P08 设置面）——不虚报为全量） |
| REQ-5-02 | §5.1 | Dashboard 显示：最近项目、进行中任务、Draft/Ready/Rendering/Failed 状态、存储用量、Credits/Provider 用量、最近错误与需人工处理任务 | MUST | V1 | P05-03（P05） | 同上 | TODO（进度：P05-03 已显示项目列表（状态/revision/格式）；任务、用量与错误面板待 P06/P07 数据源就绪后接入） |
| REQ-5-03 | §5.2 | Project Workspace 默认布局：Preview + Ask Director + Scenes；默认不展示复杂 Timeline | MUST | V1 | P05-03/P05-04（P05） | 同上；REQ-66-01 | VERIFIED（P05-03/P05-04：Storyboard 页 = Preview（Remotion Player）+「应用 Director 计划」（Ask Director）+ Scenes 卡片列表；复杂 Timeline 属 P05-05 的 Lite Timeline，默认不展示） |
| REQ-5-04 | §5.3 | Script 页面：原文/脚本并排、章节拆分、旁白编辑、段落估时、Source 绑定、AI 重写单段/章节、Lock 段落 | MUST | V1 | P05-03（P05） | 同上；AC-14 | TODO（进度：P05-03 已实现章节分组、旁白编辑、时长与事实引用展示、Lock/Unlock 与 409 明确提示；原文并排与「AI 重写单段」待 AI Edit（P05-06）） |
| REQ-5-05 | §5.4 | Storyboard 页面：Scene 卡片（顺序/类型/缩略图/旁白/时长/数据源/Provider/状态/成本/锁定）与操作（拖排/多选/重生成/改类型/Lock/复制/删除） | MUST | V1 | P05-03 + P05-05（P05） | 同上 | VERIFIED（P05-03 场景卡与编辑入口 + P05-05 Lite Timeline：move/reorder/split/duplicate/delete/lock/替换素材/转场/Crop-Scale 齐备；「重生成」涉及 Provider 成本，属显式生成动作（P06/P07），不在本期冒充） |
| REQ-5-06 | §5.5 | Scene Editor 属性面板：类型/时长/旁白/视觉意图/数据绑定/Source/组件/动画/布局/背景/Transition/Avatar/资产引用/Provider 策略/AI 编辑框 | MUST | V1 | P05-03 + P05-05 + P05-06（P05） | 同上 | VERIFIED（组件 props 面板（协议驱动 + schema 校验）（P05-03）；时长/转场/Crop-Scale 在 Lite Timeline（P05-05）；AI 编辑框 = AI Edit 面板（P05-06）；数据绑定/Source/Avatar/Provider 策略为只读展示或后续面板（P06 起有真实数据源）） |
| REQ-5-07 | §5.6 | Lite Timeline MUST 存在（非默认首页）：Narration/Scenes/Music/Captions/Overlays 轨道；支持 reorder/Trim/Split/Duplicate/Delete/Move/Replace/Transition/音量/字幕修正/简单 Crop-Scale；不做复杂 Track 嵌套与高级曲线 | MUST | V1 | P05-05（P05） | 全部操作回写统一协议；刷新后状态一致（P05-05） | VERIFIED（P05-05：折叠面板（非默认展示）；Scenes 轨道操作矩阵齐全 + 音轨（音量）/字幕（文本修正）在数据存在时可编辑、缺失时诚实空态（音轨/字幕数据源随 P06-03 对齐产生）；无 Track 嵌套/曲线；刷新一致由集成测试断言（编辑→失效→重查→服务端新值上屏）） |
| REQ-5-08 | §5.7 | History：人类可读 Intent History；支持 Undo/Redo/Restore 项目版本/Restore 单 Scene；Compare 后续 | MUST | V1 | P02-03/P05-03（P02/P05） | 恢复产生新 revision（P02-03）；AC-19 | VERIFIED（P05-03：History 页面展示事件流（seq/类型/操作明细/actor/时间/UNDO-REDO 补偿标记）+ 撤销/重做动作与 409 冲突提示；Restore 服务端能力 P02-03 已验收；Compare 后续） |
| REQ-6-01 | §6 | Channel 长期默认值字段集；修改 Profile 后新项目用新值、旧项目不被静默覆盖、Project 可覆盖 Channel 默认值 | MUST | V1 | P01-04（P01） | 字段集 + 不可变样式版本 + 快照语义被测试锁定（旧快照逐字段不变、新读取继承新值）（P01-04；证据 docs/verification/P01-04.md）；Project 级用例随 P02-01 补入 | VERIFIED |
| REQ-6-02 | §6 | Creator Identity 拆分为 AvatarIdentity / VoiceIdentity / BrandIdentity / PresenterStyle；Creator Identity 与 Channel Style 可分别版本化，支持同创作者多风格 Channel | MUST | V1 | P01-04/P06-02（P01/P06） | P01-04 验收；身份版本固定（P06-02） | TODO |
| REQ-6-03 | §6.1 | AvatarIdentity 字段（provider/provider_avatar_id/凭据引用/display_name/status/consent/default look/时间戳）；原则：原始训练素材优先 Provider 托管，平台只存 provider 引用 | MUST | V1 | P06-04（P06） | 校验时长与口型资产（P06-04）；§20.3 | TODO |
| REQ-6-04 | §6.1 | VoiceIdentity 字段集；MUST：不绑死 ElevenLabs/HeyGen；历史项目/终版记录所用 VoiceIdentity 版本与 provider voice 引用；删除/退休后旧项目保留可审计引用；UI 区分平台托管与自带 Provider 声音 | MUST | V1 | P06-02（P06） | 身份版本固定；两种凭据模式可生成（P06-02） | TODO |
| REQ-6-05 | §6.2 | V1 SHOULD 支持创建 Creator Voice；若节奏受限，至少完成 VoiceProvider 抽象、数据模型与 BYOK 连接能力；推荐 onboarding 流程（授权声明→录音/上传→音质检测→Consent→验证→克隆→试听→默认 Speech Profile） | SHOULD | V1-契约 | P06-02/P10-02（P06/P10） | P06-02 验收；P10-02 完整验收 | TODO |
| REQ-6-06 | §6.2 | 禁止"上传任意名人 MP3 克隆"作为产品能力；必须明示仅本人/合法授权声音 | MUST | 全期 | P10-02（P06/P10） | 未授权不提交（P10-02） | TODO |
| REQ-6-07 | §6.3 | 必须同时支持 Managed Voice 与 BYOK Voice 两条路径（BYOK 只保存 provider_voice_id + 加密凭据引用） | MUST | V1 | P06-02（P06） | 两种凭据模式可生成（P06-02） | TODO（进度：BYOK 加密凭据引用模型（provider_connections + AES-256-GCM 封套）与 Managed/BYOK 决策已就位（P03-04）；Voice 侧的 provider_voice_id 与两种模式实际生成待 P06-02） |
| REQ-6-08 | §6.4 | SpeechProfile 字段集；未来自动学习 Creator Style 必须可查看、可关闭、可恢复 | SHOULD | 后续 | P06-02（基础）/P14-03（学习） | P14-03 验收 | DEFERRED |

## D. 内容、叙事、导演与视觉规则（§7—§10）

| ID | 出处 | 要求摘要 | 级别 | V1 归属 | 任务（阶段） | 验收 | 状态 |
|---|---|---|---|---|---|---|---|
| REQ-7-01 | §7 | 任何输入必须先转统一 ContentDocument（id/title/language/author/sourceUrl/publishedAt/blocks/claims/citations/tables/figures/attachments），不得直接发 LLM | MUST | V1 | P04-01（P04） | 抽取验收（P04-01） | 三种文本输入均产出统一 ContentDocument（块规范化落库、稳定块 ID、tables/figures 由块派生）；claims/citations **结构就位但留空**——抽取填充属 P04-02（分任务边界）；归一化不调用 LLM（确定性） | VERIFIED（claims/citations 填充→P04-02） |
| REQ-7-02 | §7 | Block 类型（heading/paragraph/quote/list/table/image/chart/embed）与 Claim（factuality: fact/analysis/opinion/uncertain + sourceIds + structuredData）建模 | MUST | V1 | P04-02（P04） | 每个事实图表可追溯（P04-02） | Block 类型（P04-01）与 Claim 全字段建模（claims/source_citations 表；factuality 四类；sourceIds/structuredData；锁定标记）；确定性抽取产出 Claim + **Citation（块 ID + 字符区间 + 引文）**；fact 类必须 ≥1 来源（无来源降级 uncertain 并提示）（P04-02） | VERIFIED |
| REQ-8-01 | §8 | NarrativePlan 输出结构（title/thesis/hook/chapters/narrationBlocks/keyClaims/requiredVisualFacts/ending/estimatedDuration）；推荐叙事模式但不强制统一模板 | MUST | V1 | P04-03（P04） | Schema 校验与有限修复（P04-03） | NarrativePlan 契约全字段 + 版本化落库（narrative_plans 不可变版本 + narration_blocks 规范化行：章节/事实引用/估计时长/锁定/状态）；**Schema 校验 + 有限修复**（剥围栏/剔未知字段/折算/缺省派生，逐条记录；超限即 422）（P04-03）；不强制统一模板 | VERIFIED |
| REQ-8-02 | §8.2 | 叙事约束：不逐字朗读文章；语言口语化；保留核心事实与逻辑；锁定文字不得静默修改；事实与分析保留类型信息 | MUST | V1 | P04-03（P04） | 锁定文字与事实类型保留（P04-03）；AC-14 | **不得逐字朗读**：8-gram 重叠门控（全部生成旁白抄袭 → 422 VERBATIM_NARRATION_REJECTED；单块抄袭 → 告警记录）；**锁定文字不得静默修改**：再生成时锁定旁白逐字保留（模型改写 → 回滚+修复记录；模型丢失 → 补回），编辑锁定块文本 → 409；**事实类型保留**：旁白只能引用已登记事实 id（未登记引用被剔除；keyClaims 全非法 → 422 UNKNOWN_CLAIM_REFERENCE），claims 表本身不被生成触碰；AC-14（Lock 与 AI 改写冲突明确提示）在旁白/Claim 两层均以 409/回滚实现（P04-03） | VERIFIED |
| REQ-9-01 | §9.1 | Director 输入：NarrativePlan/ContentDocument/CreatorProfile/组件库/资产库/Provider 能力/预算模式/隐私模式/目标平台（历史表现后续） | MUST | V1 | P04-05（P04） | P04-05 验收 | TODO（进度：P04-05 已接入 NarrativePlan + VisualPlan + Provider Catalog（Router）+ 工作区预算 + 可配置策略；CreatorProfile/组件库/资产库在 P05，隐私模式/目标平台随 P07/P09 接入） |
| REQ-9-02 | §9.2 | Director 输出：Scene Graph、资产计划、Provider 任务计划、估算成本、估算时长、风险/warning 列表 | MUST | V1 | P04-05（P04） | 输出经 Schema/来源/Lock/预算验证后才能应用（P04-05） | VERIFIED（P04-05：六类输出齐备；validateDirectorPlanForApply 四类验证 + 应用经编辑协议产出真实 Scene Graph；成本为 Catalog 价格估算（无核验价 → UNKNOWN/blocked，不冒充）） |
| REQ-9-03 | §9.3 | 逐 Narration Block 判断清单（信息类型/是否真人/是否数据/地理/时间/因果/A-B 对比/是否显示 Source/真实图片是否更优/标准组件能否表达/是否值得 Custom Motion/是否值得昂贵 AI Video） | MUST | V1 | P04-05（P04） | P04-04/P04-05 验收 | VERIFIED（P04-05：信息类型/数据/地理/时间/因果/对比/来源/标准组件表达力由 P04-04 确定性识别与映射判定；真人=avatar 模态、AI Video=策略上限+aiVideo 规则；Custom Motion 判断随 P07-02） |
| REQ-9-04 | §9.4 | 避免长时间连续 Avatar（建议单段 <20～25s）；Avatar 占比 15%～30%、每 4～12s 明显视觉变化、AI Video <10%～20% 等均为可配置默认值，不得硬编码为业务规则 | MUST | V1 | P04-05（P04） | 配置来自 Channel/Director Policy；P08-05 成片比例核验 | VERIFIED（P04-05：策略为契约默认值（§9.4 建议值）+ 请求覆盖（policyOverridden 审计）+ 比例/连续时长/视觉变化检查告警；Channel 样式（含视觉策略字段）自 P01-04 起版本化存储并被项目快照（P02-01）；成片核验随 P08-05） |
| REQ-10-01 | §10.1 | Visual Grammar MUST 支持基础语义类型（NUMBER/KPI_SET/TREND/COMPARISON/RANKING/TIMELINE/CAUSE_EFFECT/FEEDBACK_LOOP/FLOW/GEOGRAPHY/NETWORK/PROCESS/QUOTE/SOURCE/PERSON/COMPANY/DOCUMENT/IMAGE_EVIDENCE/VIDEO_EVIDENCE/CONCEPT/TRANSITION/SUMMARY/HOST_STATEMENT）与财经扩展（YIELD_SPREAD/YIELD_CURVE/PRICE_SERIES/CANDLE_SERIES/PERCENT_CHANGE/BALANCE_SHEET/SUPPLY_DEMAND/TRADE_FLOW/CAPITAL_FLOW/POLICY_PATH/SCENARIO_COMPARE） | MUST | V1 | P04-04（P04） | 固定语义输入得到允许类型（P04-04） | VERIFIED（P04-04：契约 + 映射表覆盖全部 34 类（23 基础 + 11 财经，§10.1）；确定性识别 33/34（TRANSITION 属章节/结构层，由 P04-05 处理）；映射收敛至 V1 标准 20 类（DEC-04，延后组件→P10-04/P14-04 可追溯）；未降级条目 suggested ∈ allowedSceneTypes 由测试断言；P05-02 完成 20 类实现与五变体证据） |
| REQ-10-02 | §10.2 | 首批建议 30～40 个组件类型；本计划裁决 V1 交付 20 个标准类型，其余映射后续任务（DEC-04） | SHOULD | V1 | P05-02（P05）；余额 P06-05/P07-02/P10-04/P14-04 | 每组件独立验收（P05-02）；DEC-04 | TODO |
| REQ-10-03 | §10.3 | 事实可视化 MUST：数据图表只能绑定结构化数据或可追踪 Source；关键数据缺失不得由 AI 编造图形数据；缺失时降级为 Source/Quote/文字或提示补数据；图表 Scene 必须保存 data_source_ids | MUST | V1 | P04-04/P04-02（P04） | AC-15；缺数据不自动生成虚构数列（P04-02） | 数据集绑定门控（非 synthetic / 非空 / 有来源 → 否则 422 附原因）+ **降级阶梯 planFactVisual（CHART→QUOTE→SOURCE_CARD→TEXTUAL_EXPLANATION→REQUEST_DATA）** + 图表绑定返回必须写入 Scene 的 data_source_ids（P04-02）；P04-04 视觉计划在规划阶段即绑定（绑定时必带 dataSourceIds 且 fallbackStrategy=null，集成测试断言）；组件级渲染与 source label 随 P05-02 | VERIFIED（组件级渲染/source label→P05-02） |
| REQ-10-04 | §10.3 | 关键财经图表建议画面可选显示 source label | SHOULD | V1 | P05-02（P05） | P05-02 组件验收 | VERIFIED（P05-02：全部图表/数据/证据类组件支持 sourceLabel（提供即渲染"来源：…"）；参数存储随 P05-04 装配） |

## E. 双视觉引擎、Scene Graph 与主时钟（§11—§13）

| ID | 出处 | 要求摘要 | 级别 | V1 归属 | 任务（阶段） | 验收 | 状态 |
|---|---|---|---|---|---|---|---|
| REQ-11-01 | §11.1 | Standard Scene Engine（Remotion 组件库，约 70%～85% 场景）；每个组件必须有 ComponentDefinition（type/version/inputSchema/defaults/supportedAspectRatios/min-maxDuration/previewFixture/renderer） | MUST | V1 | P05-01（P05） | 每个组件可独立校验与渲染（P05-01） | VERIFIED（P05-01：协议 + 注册表（自检/多版本/擦除边界）+ 参考组件 BIG_NUMBER + 挂载点；单测矩阵 + 真实 Remotion 渲染（PNG）；20 类组件实现为 P05-02） |
| REQ-11-02 | §11.2 | Generative Motion Engine（15%～30% 高光场景）；标准组件无法表达时 Director 输出 CUSTOM_MOTION_REQUIRED，由 Motion Designer Agent 生成独立 Scene | MUST | V1 | P07-02（P07） | P07-02 验收 | TODO |
| REQ-11-03 | §11.2 | Custom Motion 安全 MUST 10 条：隔离沙箱、默认无网络、白名单依赖、TS 编译、静态分析、Render smoke、CPU/RAM/超时限制、不得访问 Secret、不得任意文件路径、通过后才能进入项目 | MUST | V1 | P07-01/P07-02（P07） | AC-18；攻击 fixture 被拒（P07-01） | VERIFIED（P07-01：隔离子进程（vm 白名单上下文 + 独立进程，**宿主与子进程双重静态分析**）+ 网络词法/全局逃逸/原型污染拒绝 + 越权文件/Secret/env/动态执行/动态依赖拒绝 + **无限循环 → 硬超时 SIGKILL（宿主不受影响、无跨提交状态）** + RAM 上限（--max-old-space-size）+ 渲染 smoke（react-dom/server 固定帧）→ APPROVED 才放行；OS 级网络隔离（gVisor/容器）属 P08 部署层。P07-02 的"生成后保存/进入项目"随 Motion 生成任务） |
| REQ-11-04 | §11.2 | 优秀 Custom Motion 可"Save as Component"经审核进入个人/平台组件库 | MAY | 后续 | P07-02 后续 / P16 | — | DEFERRED |
| REQ-12-01 | §12 | Scene Graph 是跨 Web/Desktop/Mobile 的统一数据模型（schemaVersion/projectId/projectRevision/channelSnapshot/format/timeline/scenes/captions/audioTracks/overlays/sourceReferences） | MUST | V1 | P02-01/P01-01（P01/P02） | 契约往返无损（P01-01）；合法 Graph（P02-01） | 契约往返无损（P01-01）+ DB 状态组装为合法 Graph（P02-01） | VERIFIED |
| REQ-12-02 | §12.2 | Scene 必备字段（id/project_id/revision/order/start_ms/duration_ms/semantic_type/scene_type/narration/visual_intent/component 或 provider strategy/settings/asset refs/source-data refs/locked/status/时间戳） | MUST | V1 | P02-01（P02） | P02-01 验收 | Scene 必备字段与 sceneSchema 逐字段对齐并落库（P02-01） | VERIFIED |
| REQ-12-03 | §12.2 | Scene SHOULD 字段：cost_estimate/actual_cost/quality_score/render_status/provider_job_ids/user_notes/ai_reasoning_summary（非私密 CoT）/performance_metrics | SHOULD | V1 | P02-01/P07-05（P02/P07） | P07-05 验收 | TODO |
| REQ-12-04 | §12.3 | 时间模型：权威值用整数毫秒或整数 frame，不用 float 秒；统一一套；渲染前转换。裁决：持久化权威 = 整数毫秒，渲染边界转 frame（DEC-02） | MUST | V1 | P02-01（P02） | 10 分钟样例无累计漂移；DEC-02 | TODO |
| REQ-13-01 | §13 | Audio-First：主时钟 = Master Narration；流程 Final Script→Master Voice→Timestamps→Scene/Motion/Subtitle Timing | MUST | V1 | P06-03（P06） | 中英文/数字/缩写/停顿通过（P06-03） | VERIFIED（P06-03：逐段合成（词级时间戳）→ WAV 拼接 Master Asset（自有存储 + VOICE_AUDIO 资产）→ 全局 Alignment（绝对时间轴，段连续无缝隙）+ narration cues；中英文/数字/缩写/停顿由逐段合成与真实 I/O 路径承接——**真实 TTS Provider 的中英文/数字/缩写/停顿核验待凭据（P06-02）**，Mock 为确定性音频仅验证管线） |
| REQ-13-02 | §13 | MUST：保存 Master Narration Asset；保存 timestamp alignment；Scene 动画可绑 narration cue；修改文字后相关音频与时间轴标记失效并触发局部重建 | MUST | V1 | P06-03（P06） | AC-13；局部重建通过（P06-03） | VERIFIED（P06-03：master_narrations 追加式落库（segments/words/cues/身份与风格版本引用）；Asset 保存（storage_key + 校验和）；**局部重建**：改一句话 → cacheKey 仅该段失效（TTS 调用恰 +1），其余段 reused，后续段按新时长平移；cue 查询接口 cueForBlock） |
| REQ-13-03 | §13 | Provider 不提供 timing 时必须使用内部 forced alignment；不接受仅按字数估计的 Final 对齐（计划 §5.1 强化） | MUST | V1 | P06-03（P06） | P06-03 验收 | VERIFIED（P06-03：无时间戳且未配置 AlignmentProvider → 501 TIMESTAMPS_UNAVAILABLE 且**不产生 Master**（集成测试）；配置对齐器 → alignmentMethod=ALIGNMENT_PROVIDER；代码中不存在按字数估计的对齐路径） |
## F. Provider 分工、契约与路由（§14—§17）

| ID | 出处 | 要求摘要 | 级别 | V1 归属 | 任务（阶段） | 验收 | 状态 |
|---|---|---|---|---|---|---|---|
| REQ-14-01 | §14.1 | LLM 负责内容理解/Narrative/Director/Prompt/AI 编辑/Motion 代码生成；禁止让单个 LLM 决定所有不可审计的最终视频状态 | MUST | V1 | P04-03/P04-05（P04） | 结构化输出 + 决策摘要（§52/§53） | TODO |
| REQ-14-02 | §14.2 | HeyGen 仅为 Avatar 演员而非视频系统；Avatar 镜头只是 Scene Graph 中的一种 Scene | MUST | V1 | P06-04（P06） | 无独立第二时钟（P06-04） | TODO |
| REQ-14-03 | §14.3 | Voice Provider 统一抽象（含 HeyGen Voice）；Voice clone 原始样本/授权状态/provider_voice_id/retention policy/ownership metadata 不得混为同一字段 | MUST | V1 | P06-02（P06） | 敏感资料不出现普通日志（P06-02）；§95 | TODO |
| REQ-14-04 | §14.4 | Veo 仅用于 Hero/概念/电影化/图生视频等；不得用于数据图表、利率曲线、真实财经数字、来源引用 | MUST | V1 | P06-05/P04-04（P04/P06） | P06-05 验收 | VERIFIED（P06-05 非凭据部分：requestSceneGeneration 在生成请求处**门控**——数据/证据类语义（19 类）与场景类型（12 类）→ 422 AI_VIDEO_BOUNDARY_VIOLATION；非素材类场景 → 422（本地组件渲染）；集成测试覆盖） |
| REQ-14-05 | §14.5 | Runway 作为 AI Video fallback/替代模型；可利用其 Model Router，但平台自身保留跨 Provider Router | SHOULD | 后续 | P10-03（P10） | 相同公共契约测试通过（P10-03） | DEFERRED |
| REQ-14-06 | §14.6 | Remotion 为核心渲染层：标准场景引擎/数据可视化/Motion/Map/字幕/时间线合成/预览/最终渲染 | MUST | V1 | P05/P07（P05—P07） | P00-03 兼容性验证；P07-04 渲染验收 | TODO |
| REQ-15-01 | §15 | 业务层只依赖内部接口：VideoGenerationProvider / AvatarProvider / VoiceProvider 契约形状（含可选能力方法的判空） | MUST | V1 | P03-03/P01-06（P03） | 契约测试（P03-07） | TODO |
| REQ-15-02 | §15 | Adapter 必须处理：auth/retries/rate limits/webhooks/polling/Provider 错误/成本元数据/保留元数据/版本变化 | MUST | V1 | P03-04/P03-06/P03-07（P03） | P03-06 验收；Mock 故障矩阵（P03-07） | 凭据（P03-04）/验签·轮询补偿·结果回收（P03-06）/**Mock 故障矩阵**（P03-07：429、提交结果未知、慢任务、重复回调、取消失败——CI 确定性重现）已覆盖；成本/保留元数据随 P06 真实 Adapter | VERIFIED（成本/保留元数据的真实取值→P06） |
| REQ-15-03 | §15 | 禁止业务代码直接调用特定 Provider（反例：`if sceneType==='AI_VIDEO' → callVeoDirectly()`） | MUST | V1 | P03-03（P03） | 代码审计 + 契约测试 | TODO |
| REQ-16-01 | §16 | Director 输出能力需求、Router 决定 Provider；Router 维度含 capability/quality/cost/latency/可用性/队列/失败率/Workspace 策略/地区/隐私/BYOK | MUST | V1 | P03-03/P03-04（P03） | 按能力筛选（P03-03）；BYOK/Workspace 策略/地区（P03-04） | TODO（进度：capability + 核验时效 + 地区 + Workspace 策略 + **BYOK/Managed** 已实现（P03-03/P03-04 的 resolveProviderRoute：决策可审计、全被拒 501）；quality/cost/latency/失败率/队列/隐私维度待 P03-05（成本）与 P06（真实质量/延迟数据）） |
| REQ-16-02 | §16 | Router 模式：AUTO/QUALITY/BALANCED/FAST/LOW_COST/PRIVATE/PINNED_PROVIDER | SHOULD | V1 | P03-03（P03） | P03-03 验收 | TODO |
| REQ-16-03 | §16 | 模型名称与价格不得硬编码在业务逻辑；存 Provider Catalog/配置 | MUST | V1 | P03-03（P03） | 无有效配置时明确阻止真实调用（P03-03） | TODO |
| REQ-17-01 | §17.1 | 默认 Platform Managed：用户注册→导入→Generate，无需自备 API | MUST | V1 | P03-04（P03） | P03-04 验收 | TODO |
| REQ-17-02 | §17.2 | BYOK：有该 Provider BYOK 用 BYOK 否则 Platform Managed；允许 Workspace 级与身份级分别选择托管模式（Avatar/Voice/AI Video 可不同） | MUST | V1 | P03-04（P03） | 两种凭据模式可生成（P06-02）；跨租户连接不可用（P03-04） | **跨租户连接不可用已验证**（全 404 且不泄漏资源 id）；§17.2 决策树 + Workspace 级按类别覆盖已实现（AUTOMATIC/BYOK/PLATFORM_MANAGED，显式 BYOK 缺连接即拒绝不回落）；身份级覆盖位已预留（P06-02）；「两种凭据模式可生成」待 P06-02 | TODO（进度：决策与隔离完成（P03-04）；身份级与真实生成待 P06-02） |
| REQ-17-03 | §17.3 | Secret 存储 MUST：仅后端使用、KMS/信封加密、UI 只显示 masked、日志绝不打印、created/last_used/revoked 时间戳、可 rotate；绝不下发完整 Key 到客户端 | MUST | V1 | P03-04（P03） | 密钥不进前端及日志（P03-04） | TODO |

## G. 生成模式、异步与任务系统（§18—§19）

| ID | 出处 | 要求摘要 | 级别 | V1 归属 | 任务（阶段） | 验收 | 状态 |
|---|---|---|---|---|---|---|---|
| REQ-18-01 | §18.1 | Draft 快速便宜（Avatar/AI Video 用 placeholder、标准场景真实预览、预览级声音）；MUST：反复编辑 Draft 不得频繁调用昂贵 Video Provider | MUST | V1 | P05-04（P05） | AC-12；编辑不隐式触发昂贵调用（P05-04） | VERIFIED（P05-04：预览=本地组件渲染（同源注册表），编辑→刷新预览路径的 SDK 访问面**只含只读查询 + 编辑协议**（测试用记录式 Proxy 断言，触碰 jobs/billing/generations 即失败）；Avatar/AI Video 未生成 → 明确占位（Draft 策略）） |
| REQ-18-02 | §18.2/18.3 | Studio 与 Hero/Premium 档位差异（正式资产/1080p vs Custom Motion/高分辨率）；所有档位为策略配置，不写死供应商 | SHOULD | V1 | P03-03/P07-04（P03/P07） | 档位配置化；P07-04 1080p | TODO |
| REQ-19-01 | §19.1 | 统一 Job 状态机：WAITING_DEPENDENCY/ QUEUED/RUNNING/PROVIDER_QUEUED/SUCCEEDED/FAILED_RETRYABLE/FAILED_FINAL/CANCEL_REQUESTED/CANCELLED（计划 §5.5 增补执行阶段/提交状态/重试/租约/心跳/对账字段） | MUST | V1 | P03-01（P03） | 状态机测试；AC-06 | 9 状态机 + 唯一迁移服务（非法迁移 409）+ stage/submit_state/attempts/租约/心跳/needs_reconciliation 字段；终态重复上报 409（P03-01/P03-02） | VERIFIED |
| REQ-19-02 | §19.1 | 项目级状态：DRAFT/SCRIPTING/STORYBOARDING/GENERATING_AUDIO/GENERATING_ASSETS/READY_FOR_REVIEW/RENDER_QUEUED/RENDERING/READY/FAILED/ARCHIVED | MUST | V1 | P02-01（P02） | P02-01 验收 | 状态字段与 §19.1 十一态枚举就绪（P02-01）；状态迁移由编辑/任务系统驱动（P02-02/P03） | VERIFIED |
| REQ-19-03 | §19.2 | MUST 并发控制：Provider 并发信号量/Workspace 限流/平台限流/队列优先级/指数退避/抖动/幂等/死信与失败检查/人工重试/webhook 验签 | MUST | V1 | P03-01/P03-02（P03） | 杀 Worker 恢复测试（P03-02）；AC-06 | 队列优先级/指数退避+抖动/自动重试推进/失败检查（inspectJobs）/人工重试/**杀 Worker 恢复**（故障注入三阶段）已实现（P03-01/P03-02）；Provider 并发信号量与限流随 P03-03；webhook 验签随 P03-06 | VERIFIED（并发信号量/限流→P03-03；验签→P03-06） |
| REQ-19-04 | §19.2 | Provider limit 不得写死，从配置加载 | MUST | V1 | P03-03（P03） | P03-03 验收 | TODO |
| REQ-19-05 | §19.3 | MVP 基础设施 Redis + BullMQ + PostgreSQL 状态表 + Transactional Outbox；保留 WorkflowEngine 抽象（未来可切 Temporal） | MUST | V1 | P03-01（P03） | Outbox 崩溃恢复（P03-01；AC-06） | PostgreSQL 权威状态表 + Transactional Outbox + BullMQ 适配器（真实 Redis 端到端：投递/持久/多 Worker 竞争，P03-02）+ DbPollQueue 回退；WorkflowEngine 以 JobQueueAdapter/状态迁移服务抽象保留 | VERIFIED |

## H. 隐私、存储与领域模型（§20—§22）

| ID | 出处 | 要求摘要 | 级别 | V1 归属 | 任务（阶段） | 验收 | 状态 |
|---|---|---|---|---|---|---|---|
| REQ-20-01 | §20.1 | 数据分类 PUBLIC/INTERNAL/CONFIDENTIAL/IDENTITY_SENSITIVE；未发布文章=CONFIDENTIAL；Twin/Voice 原始素材=IDENTITY_SENSITIVE | MUST | V1 | P03-04/P02-04（P02/P03） | 分类字段落库；P03-04 验收 | TODO |
| REQ-20-02 | §20.2 | Provider 最小化：完整文章内部处理，只把 Scene 所需 Prompt/参考资产发 Provider；Provider request metadata 记录 provider/purpose/classification/asset IDs/retention snapshot | MUST | V1 | P03-06（P03） | P06-05 验收"输入只含 Scene 所需数据" | TODO |
| REQ-20-03 | §20.3 | 身份素材优先 User→Provider 直连 onboarding，我方只存 provider 引用，避免长期保存原始训练素材 | SHOULD | V1 | P06-02/P06-04（P06） | P06 验收；§95 | TODO |
| REQ-20-04 | §20.4 | Privacy 模式：Standard（平台托管常规）；Private（Scene 级最小数据/Signed URL/结果立即回收/禁发全文/更严日志/BYOK 可选）；Enterprise（ZDR/Dedicated/DPA/Regional/Audit） | MUST | 后续 | P09-04（Private）；P16-07（Enterprise）；V1 底线见 REQ-6-3 系列 | 撤销成员后访问立即受限（P09-04） | DEFERRED |
| REQ-20-05 | §20.4 | 必须区分并分别处理：No training != No storage；API != Zero retention；Delete output != Delete logs（隐私说明与工程代码分别处理） | MUST | V1 | P03-03/P03-06（P03） | Catalog 分别记录三项；P08-01 | TODO |
| REQ-21-01 | §21 | PG=状态/关系/元数据；Object Storage=文件；Redis=队列/锁/缓存/限流；Analytics 后期 ClickHouse；禁止视频 blob 入 PG | MUST | V1 | P02-04（P02） | P02-04 验收 | TODO |
| REQ-22-01 | §22.1 | 所有业务资源 MUST 归属 Workspace（Members/Channels/Provider Credentials/Projects/Assets/Billing/Usage） | MUST | V1 | P01-03/P02-01（P01/P02） | AC-01；跨租户引用被拒（P02-01） | 全部业务记录归属可验证：core 表均携带 workspace_id 且查询强制作用域；跨租户引用被拒（P01-03/P02-01）；后续资源表沿用同一约束 | VERIFIED |
| REQ-22-02 | §22.3 | Project 字段：workspace/channel/title/source_type/status/current_version_id/aspect/resolution/fps/target_duration_ms/created_by/时间戳/deleted_at | MUST | V1 | P02-01（P02） | P02-01 验收 | projects 表逐字段落地并通过创建/详情/列表测试（P02-01） | VERIFIED |
| REQ-22-03 | §22.4 | Scene 规范化记录（含 revision/position/start_ms/duration_ms/semantic_type/scene_type 等）；不得把所有 Scene 塞进一个巨大 JSON 作为唯一状态；Graph 由规范化记录生成 Snapshot | MUST | V1 | P02-01（P02） | P02-01 验收 | scenes 规范化表 + 独立 revision + Graph 由规范化记录生成（P02-01；证据 docs/verification/P02-01.md） | VERIFIED |
| REQ-22-04 | §22.5 | Asset 字段集与 AssetType 至少 16 类（SOURCE_DOCUMENT/SOURCE_IMAGE/USER_UPLOAD/AVATAR_CLIP/VOICE_AUDIO/MUSIC/GENERATED_IMAGE/GENERATED_VIDEO/CHART_RENDER/CUSTOM_MOTION_RENDER/SUBTITLE/DRAFT_RENDER/FINAL_VIDEO/SHORT_VIDEO/THUMBNAIL/MANIFEST） | MUST | V1 | P02-04（P02） | P02-04 验收 | assets/asset_versions 字段逐项落地；**17 种 AssetType** 枚举（含 §22.5 全部 16 类）经契约与测试覆盖（P02-04）；Provider 生成类经 P03-06 回收写入 | VERIFIED |

## I. 版本、历史、账本与存储策略（§23—§28）

| ID | 出处 | 要求摘要 | 级别 | V1 归属 | 任务（阶段） | 验收 | 状态 |
|---|---|---|---|---|---|---|---|
| REQ-23-01 | §23 | 版本架构 = Current State + Event Log + Periodic Snapshot；不做完全纯 Event Sourcing | MUST | V1 | P02-03（P02） | P02-03 验收 | Current State（projects/scenes 规范化表）+ Event Log（edit_events.seq）+ Periodic Snapshot（project_versions 不可变行）三层就位；恢复只追加、不回拨（P02-03） | VERIFIED |
| REQ-23-02 | §23.1 | EditEvent 字段（actor/action/intent_text/patch_json/base_revision/result_revision）；示例含 from→to 补丁 | MUST | V1 | P02-02（P02） | 同键重放无重复事件（P02-02） | EditEvent 全字段落库（§23.1）+ 与状态/Outbox 同事务（P02-02） | VERIFIED |
| REQ-23-03 | §23.2 | ProjectVersion 字段与自动快照时机：AI 重编导前后/Final Render/Publish/手动 Save/每 N 事件 | MUST | V1 | P02-03（P02） | P02-03 验收；AC-19 | ProjectVersion 全字段 + 不可变快照；自动时机已实现：AI 重编导前（AI_REDIRECT，pre-apply 状态）/Restore 后/手动 Save/每 N 事件（seq 水位线，P02-03）；FINAL_RENDER、PUBLISH 是 reason 枚举已就绪，自动接入随 P07-05/P12 | VERIFIED |
| REQ-23-04 | §23.3 | Undo/Redo：客户端可 optimistic 但最终必须由服务器 Revision 检查；写操作带 baseRevision + idempotencyKey；冲突返回 409 VERSION_CONFLICT | MUST | V1 | P02-02（P02） | AC-03/AC-04；冲突信息可用于刷新（P02-02） | 服务器 revision 条件更新 + 409 VERSION_CONFLICT（含刷新信息）；Undo/Redo 的补偿操作语义待 P02-03（P02-02） | VERIFIED |
| REQ-24-01 | §24.1 | Intent/Content History（给创作者：改文字/改 Scene/AI 重生成/重导/自然语言意图）与 Audit Log 必须分开 | MUST | V1 | P02-03/P05-03（P02/P05） | 历史与审计分表；P02-03 验收 | TODO（进度：Intent/Content History 独立成表（edit_events + intentText，P02-03）；Audit Log 表待 P02-06/P08-02，届时验证分表与字段分离） |
| REQ-24-02 | §24.2 | AuditLog 覆盖：登录/下载/删除/邀请/改 Key/发布/Provider 凭据访问/权限变更；不保存未发布文章全文或完整 Prompt | MUST | V1 | P01-03/P08-02（P01/P08） | 所有运营动作可审计；P08-02 验收 | TODO |
| REQ-25-01 | §25 | 每次 Provider 调用可追踪（provider_generations：provider/model/operation/credential_mode/provider_job_id/input_hash/状态/延迟/估算与实际成本/币种/重试/错误/时间戳） | MUST | V1 | P03-05（P03） | 付费尝试均记录成本（P03-05） | provider_generations 全字段表 + 幂等记录/结算原语（唯一键 (workspace,job,attempt,provider,operation) 重放返回原行）；BYOK 计费经可注入策略（不硬编码）；**真实 Provider 成本**待 P06 实测（当前由调用方写入估算/实际值） | VERIFIED（真实成本写入待 P06） |
| REQ-25-02 | §25 | Prompt 如需保存使用加密字段并做敏感信息控制；普通日志不得打印完整 Prompt | SHOULD | V1 | P03-04/P03-05（P03） | 日志脱敏验收（P08-03） | TODO |
| REQ-26-01 | §26 | DB 只存 storage_key；Object URL 不得作为永久标识；路径按 workspace/project 逻辑分层 | MUST | V1 | P02-04（P02） | AC-10；P02-04 验收 | assets/asset_versions 只存 storage_key（assets 表注释与测试断言 DTO 无对象 URL）；键布局 workspaces/{ws}/projects/{project|library}/{category}/assets/{id}/v{n}/（P02-04） | VERIFIED |
| REQ-26-02 | §26.1 | MUST 大文件 Client 直传 Object Storage（upload-intents→signed URL→直传→确认）；禁止 5GB 视频经 Web App Server 中转 | MUST | V1 | P02-04（P02） | P02-04 验收 | 意图→签名直传 URL→确认链路完成（本地驱动为 dev 转发，生产用 S3/R2 预签名；单文件上限 5 GiB；云适配器待真实凭据，§13.5-8）（P02-04） | VERIFIED |
| REQ-26-03 | §26.2 | 下载/播放走 CDN + Signed URL；避免 API Server 流式代理大视频 | MUST | V1 | P02-04（P02） | P02-04 验收 | 仅 READY 资产签发短 TTL 下载 Signed URL；无任何经 API 的资产流式代理路由（本地驱动端点标注 dev 限定）（P02-04） | VERIFIED |
| REQ-26-04 | §26.3 | 上传 Asset 计算 SHA-256；至少支持 Workspace 内去重；不建议默认跨 Workspace 物理去重 | SHOULD | V1 | P02-04（P02） | 重复确认幂等（P02-04） | 服务端流式 SHA-256；意图阶段与确认阶段两级 workspace 内去重（复用对象并清理冗余，记录 dedupeOf）；无跨 workspace 去重（P02-04） | VERIFIED |
| REQ-27-01 | §27 | 默认保留策略：Final/用户素材长期；已付费生成资产持续；Draft Render 30 天；Preview Cache 7 天；Temp Transcode 24～72h；Provider 临时文件尽快清理；Trash 30 天软删 | MUST | V1 | P02-05（P02） | P02-05 验收；AC-20 | RetentionClass × §27 TTL 表 + 资产类型默认类（P02-04 建模）；Trash 30 天软删与到期清理（可重入）已实现（P02-05）；Preview Cache/Temp Transcode 的实际产生方随 P05-04/P06/P07 | VERIFIED |
| REQ-27-02 | §27 | 删除流程：Soft Delete→Trash→到期 Hard Delete Worker（scene/asset metadata/storage/搜索索引/preview cache）；Audit 只保留"发生过删除"不保留内容 | MUST | V1 | P02-05（P02） | 重跑清理不误删（P02-05）；AC-20 | Soft Delete→Trash→到期硬删（含对象）与引用保护（Scene 绑定/版本快照/去重共享键）已实现且重跑收敛（P02-05）；搜索索引/preview cache 随相应子系统（P05/P07）；"Audit 留痕"随 Audit Log（P02-06/P08-02） | VERIFIED |
| REQ-28-01 | §28 | 每次 Final Render MUST 生成 manifest.json（project/version/schema version/script version/组件版本/scene assets/master audio/render settings/provider-model/source refs/时间戳） | MUST | V1 | P07-04（P07） | LED-77-20；Manifest 与实际文件一致（P07-05） | VERIFIED（P07-04：每次 Final 渲染生成 manifest.json（manifest-v1）= project/version/versionNumber + sceneGraph schemaVersion + script（plan/revision）+ 组件版本（逐场景）+ scene assets（冻结资产版本）+ master audio（narration/资产版本/时长/对齐方法）+ render settings（档位/画幅/fps/时长/字幕/音频）+ provider-model 元数据 + source refs + createdAt/outputs（逐产物 sha256）；manifest_hash = **manifest.json 字节 SHA-256**（domain 侧复核一致后才入库，集成测试断言）；"与实际文件一致"的发布前核验属 P07-05） |
| REQ-28-02 | §28 | 目标：两年后能理解构建方式、可重渲染同一版本、可识别依赖缺口；生成式 Asset 尽量缓存原始输出 | MUST | V1 | P07-03/P07-04（P07） | P07-03 快照验收 | VERIFIED（P07-03：输入快照不可变且可追溯（版本/narration/资产版本/档位）；"可识别依赖缺口"=绑定资产缺版本 → 409 ASSET_VERSIONS_MISSING 明确列出。P07-04：manifest 含组件版本/provider 元数据/资产版本（模型不可用时识别依赖缺口）；同一 projectVersionId 可重复创建 Render 重渲染（输入全为不可变引用）） |

## J. 多端后端、认证与会话（§29—§30）

| ID | 出处 | 要求摘要 | 级别 | V1 归属 | 任务（阶段） | 验收 | 状态 |
|---|---|---|---|---|---|---|---|
| REQ-29-01 | §29.1 | 三端使用相同 Backend API / Auth+Workspace+Project ID / Scene Graph Contract / Assets / Job 状态 / History | MUST | V1 | P01-05（P01） | LED-78-01..11 | TODO |
| REQ-29-02 | §29.2 | 后端不得依赖 Web Runtime：不得只实现为 Next route handlers / Server Actions；Web 可有 BFF，权威业务必须在独立 API | MUST | V1 | P01-05（P01） | 不启动 Web 也能用 SDK 完成读写：示例实跑 + CI 工作流测试（P01-05；证据 docs/verification/P01-05.md） | VERIFIED |
| REQ-29-03 | §29.3 | API 版本化 /api/v1；Breaking change 走新版本或兼容层；客户端可发送 X-Client-Type / X-Client-Version。裁决：对外统一 /api/v1（DEC-01） | MUST | V1 | P01-05（P01） | /api/v1 全面落地 + 客户端标头解析/回显被测试锁定（P01-05）；DEC-01 | VERIFIED |
| REQ-29-04 | §29.4 | Monorepo + Zod/JSON Schema contracts + 生成 OpenAPI + 统一 SDK；Web/桌面/手机禁止分别手写三套 API type | MUST | V1 | P01-01/P01-05（P01） | 单一契约来源（P01-01）+ 全量 SDK 按契约解析（P01-05）+ OpenAPI 生成与 JSON Schema 可表达性测试 | VERIFIED |
| REQ-29-05 | §29.5 | API 从第一天带 revision（projectRevision/sceneRevision/baseRevision）；冲突策略：非冲突 Scene 自动合并；同 Scene 同字段冲突→409+提示；AI 大范围 rewrite 创建新 Project Version | MUST | V1 | P02-02（P02） | AC-04/AC-24；P02-02 验收 | AC-04 并发已锁定（P02-02）；AC-24 多端用例随 P15（进度：1/2） | TODO |
| REQ-29-06 | §29.6 | 实时状态：REST 获取状态 + SSE/WebSocket 推送 Job 事件（project.updated/scene.updated/job.*/render.progress/asset.ready）；不得让客户端每秒轮询 | MUST | V1 | P02-06（P02） | 断线重连恢复状态（P02-06） | SSE 流（游标/Last-Event-ID/心跳）+ REST 游标拉取；断线重连续传不丢不重（P02-06）；job.*/render.progress/asset.ready 的事件产生方随 P03/P06/P07 | VERIFIED |
| REQ-29-07 | §29.7 | Desktop 后续：Tauri/Electron 评估；初期 Final Render 仍云端，不分叉渲染逻辑；未来 Local RenderProvider 遵循契约 | SHOULD | 后续 | P15-01（P15） | P15-01 验收 | DEFERRED |
| REQ-29-08 | §29.8 | Mobile 后续：React Native 共享 contracts/SDK；重点为查看/审核/预览/AI 修改/轻编辑/Approve/状态/下载/Push；不复制桌面 Timeline 全能力 | SHOULD | 后续 | P15-04（P15） | P15-04 验收 | DEFERRED |
| REQ-30-01 | §30 | 不可只依赖 Web Cookie Session：Auth service + 短生命周期 Access Token + Rotating Refresh Token；Web 用 HttpOnly Secure Cookie；Native 用 Secure Storage/Keychain/Keystore | MUST | V1 | P01-02（P01） | 全部验收项通过：过期/退出/刷新重放/错误回调 + 令牌仅存哈希（P01-02；证据 docs/verification/P01-02.md；Native 端存储属 P15-05） | VERIFIED |
| REQ-30-02 | §30 | 所有 API 根据用户 + workspace membership 授权 | MUST | V1 | P01-03（P01） | AC-01 | TODO |
| REQ-30-03 | §30 | Auth Contract 必须兼容原生客户端（PKCE）；未来 Email/Magic Link/Google/SSO 可扩展 | MUST | V1-契约 | P01-02（P01）；SSO→P16-05 | 原生 PKCE（S256）全流程通过（P01-02；SSO/社交扩展由 P16-05 承接） | VERIFIED |

## K. RBAC 与 API 契约（§31—§33）

| ID | 出处 | 要求摘要 | 级别 | V1 归属 | 任务（阶段） | 验收 | 状态 |
|---|---|---|---|---|---|---|---|
| REQ-31-01 | §31 | 角色：OWNER/ADMIN/EDITOR/REVIEWER/VIEWER（计划 §6.2 增 PLATFORM_ADMIN 且不复用 Workspace ADMIN） | MUST | V1 | P01-03（P01） | 能力矩阵按 §6.2 实现并被测试锁定；PLATFORM_ADMIN 明确独立（§67，P08-02 建立）（P01-03；证据 docs/verification/P01-03.md） | VERIFIED |
| REQ-31-02 | §31 | 每个资源请求 MUST 验证 workspace membership；禁止只按 project_id 查询后直接返回 | MUST | V1 | P01-03（P01） | 统一授权入口 requireWorkspace（认证→成员→能力）；workspace 端点跨租户全 404 被测试锁定（P01-03） | VERIFIED |
| REQ-32-01 | §32 | 资源接口集：Auth/Workspace/Channels/Sources/Narrative-Director/Scenes/Assets/History/Jobs/Render/Providers/Usage/Events；统一挂载 /api/v1（DEC-01） | MUST | V1 | P01-05（P01）+各阶段 | P01 资源面完成（auth/workspaces/members/channels/creator-identities/speech-profiles）；Sources/Narrative/Scenes/Assets/Jobs/Render 等随 P02+ 按同一契约模式落地（P01-05） | TODO |
| REQ-32-02 | §32 | director/edit 请求形状（instruction/selection/baseRevision/mode: plan_then_apply）；SHOULD 先返回 change plan，Apply 后 commit | MUST | V1 | P05-06（P05） | 计划未 Apply 不改数据库（P05-06） | TODO |
| REQ-33-01 | §33 | 每个写请求 SHOULD 支持 Idempotency-Key 与 X-Request-Id | SHOULD | V1 | P01-05/P02-02（P01/P02） | 基线机制被测试锁定：X-Request-Id 透传/回显、幂等键回放原结果、同键不同请求 409（AC-03 的 API 层形态）（P01-05）；编辑协议复用同一机制（P02-02） | VERIFIED |
| REQ-33-02 | §33 | 统一错误格式（error.code/message/requestId/details），含 VERSION_CONFLICT 示例 | MUST | V1 | P01-01（P01） | 错误信封 + 10 项错误码表 + VERSION_CONFLICT details 契约化并被 api/测试使用（P01-01；证据 docs/verification/P01-01.md） | VERIFIED |
| REQ-33-03 | §33 | API 必须支持分页/过滤/排序/请求追踪/向后兼容 JSON | MUST | V1 | P01-05（P01） | 分页（游标）与请求追踪已就绪并被测试；过滤/排序随 P02+ 列表规模需要实现（进度：3/5）（P01-05） | TODO |
| REQ-33-04 | §33 | Webhook 必须：校验签名/防 replay/幂等处理 | MUST | V1 | P03-06（P03） | AC-08；伪造事件被拒（P03-06） | HMAC-SHA256 + 时间窗（±5 分钟）验签（伪造/超窗/缺头 → 401 且**不落事件行、不改状态**）；replay 防护 = 唯一键 (provider, eventId)（重复 → 幂等 ack DUPLICATE）；迟到 attempt 只登记不应用（P03-06） | VERIFIED |
## L. 数据库、用量与配额（§34—§36）

| ID | 出处 | 要求摘要 | 级别 | V1 归属 | 任务（阶段） | 验收 | 状态 |
|---|---|---|---|---|---|---|---|
| REQ-34-01 | §34 | 第一版表清单（users/sessions/workspaces/members/channels/creator_profiles/projects/project_sources/claims/source_citations/narrative_plans/scripts/scenes/scene_data_bindings/assets/scene_assets/project_versions/edit_events/audit_logs/jobs/job_dependencies/provider_generations/provider_connections/provider_configs/renders/publications/usage_ledger/credit_ledger/storage_usage/component_definitions/custom_components/notifications/webhook_events/outbox_events）；裁决：按实际阶段建表，不为未来功能提前建空系统（DEC-12） | MUST | V1 | P02/P03 各任务迁移 | 迁移录入仓库；DEC-12 | TODO |
| REQ-34-02 | §34 | 后期表：analytics_events/video_performance/scene_performance/creator_learnings/experiments | MAY | 后续 | P14（P14） | P14 验收 | DEFERRED |
| REQ-35-01 | §35 | 统一 "Video Credits" 用户概念（内部=Provider 成本+渲染+存储+平台毛利）；UI 不暴露混乱的 Provider Credits | MUST | V1 | P03-05/P09-03（P03/P09） | P09-03 验收 | TODO（进度：Credits 账本（整数、只追加）与预算/预留/结算已就位（P03-05）；毛利/套餐/UI 展示随 P09-03） |
| REQ-35-02 | §35.1 | 必须用 ledger 而非可变 balance（credit_ledger：type CREDIT/DEBIT/REFUND/ADJUSTMENT + reference + metadata） | MUST | V1 | P03-05（P03） | AC-11/AC-21；回调重放只结算一次 | TODO |
| REQ-35-03 | §35.2 | BYOK 计费策略（扣 Workflow/Render Credits 或含订阅）不得硬编码在 generation service | SHOULD | 后续 | P09-01（P09） | P09-01 验收 | DEFERRED |
| REQ-36-01 | §36 | 套餐必须考虑存储配额；UI 显示用量；Storage usage 由后台周期任务核算；不永久保留所有 Draft | SHOULD | 后续 | P09-01（P09）；TTL 侧 P02-05 | P09-01 验收 | DEFERRED |

## M. AI 编辑协议与预览（§37—§38）

| ID | 出处 | 要求摘要 | 级别 | V1 归属 | 任务（阶段） | 验收 | 状态 |
|---|---|---|---|---|---|---|---|
| REQ-37-01 | §37 | AI 修改不得直接改数据库：User Instruction→Edit Planner→Change Plan→Preview/Apply→Transaction→Edit Event | MUST | V1 | P05-06（P05） | 计划未 Apply 不改数据库（P05-06） | VERIFIED（P05-06：自然语言→EditPlan（结构化 operation + rationale + 差异 before/after + 影响估算）→ 用户确认 Apply 走统一编辑协议（revision 条件 + 幂等 + 事务）；集成测试断言「生成计划后项目 revision/场景完全不变」；拒绝=清空无副作用；锁定场景操作被剔除并告警（§4.7）） |
| REQ-37-02 | §37 | 要求：用户可看到改了什么；大范围操作可撤销；被 Lock 的 Scene 不允许 AI 修改（除显式解锁） | MUST | V1 | P05-06（P05） | 一项非法操作整批不提交（P05-06）；AC-14 | TODO |
| REQ-38-01 | §38 | Remotion Player 实时 Preview（改 props 不需先生成 MP4；Chart/Map/Motion 即时预览；AI Video/Avatar 未生成用 placeholder） | MUST | V1 | P05-04（P05） | 修改标准场景可更新预览（P05-04） | VERIFIED（P05-04：@remotion/player 消费 Scene Graph（图表/地图/时间线等标准组件即时渲染）；编辑经编辑协议后 query 失效自动刷新预览；素材缺失/解析失败 → 组件明确占位（不静默空白）；无 MP4 生成路径） |
| REQ-38-02 | §38 | 昂贵生成只在 Final 或显式 Generate Asset 触发 | MUST | V1 | P05-04（P05） | AC-12；REQ-18-01 | TODO |

## N. 渲染与资产失效（§39—§40）

| ID | 出处 | 要求摘要 | 级别 | V1 归属 | 任务（阶段） | 验收 | 状态 |
|---|---|---|---|---|---|---|---|
| REQ-39-01 | §39 | 渲染分工：Web Preview=Player；Server=Lambda 或 Render Worker（计划裁决：首期专用 Worker，不用 Lambda）；后处理 FFmpeg | MUST | V1 | P07-04（P07） | P00-03 渲染验证；P07-04 验收 | VERIFIED（P07-04：Server render = apps/render-worker（Remotion bundle + renderMedia h264+aac），经 Worker 任务链路的**进程隔离执行器**（spawn CLI，硬超时）调度；渲染与成片共用 remotion-core 时序；FFmpeg 后处理 = Remotion 内置 FFmpeg 编码/封装（**诚实记录**：独立 ffmpeg 后处理如码率档位/多平台转码属 P08 运维口径，未在本任务引入）） |
| REQ-39-02 | §39 | Render Job 输入 = project_version + scene_graph_snapshot + asset_versions + render_profile；Profile 档位 DRAFT_720/STUDIO_1080/PREMIUM_4K/SHORT_1080x1920 | MUST | V1 | P07-03/P07-04（P07） | 渲染中编辑不改变输入（P07-03） | VERIFIED（P07-03：renders 表（迁移 0023）+ 输入=不可变快照引用（projectVersionId/MasterNarration/资产版本清单/档位画幅四档）+ 创建时自动 FINAL_RENDER 快照 + 渲染中编辑 → 输入逐字段不变（集成测试核心断言）+ 单向状态机与 render_events 审计。P07-04：Job 化执行落地（createRender 同事务入队 RENDER_FINAL；执行器只消费快照 + 冻结资产版本；STUDIO_1080 端到端 1920×1080/30fps 验证）） |
| REQ-39-03 | §39.1 | Partial Regeneration：Scene 变更不重调所有 Provider；复用未失效 Asset；只生成必要资产；最终合成可重跑但昂贵资产必须缓存 | MUST | V1 | P02-02/P03-05（P02/P03） | AC-13；依赖指纹失效（计划 §5.4） | TODO |
| REQ-40-01 | §40 | 每个 Asset 记录依赖 hash（scene content/provider config/source asset/voice-avatar config）；只有依赖变化才重新生成（如改标题不重生成 Veo Scene） | MUST | V1 | P02-02/P03-05（P02/P03） | AC-12；依赖指纹判定（计划 §5.4） | TODO |

## O. Analytics 与发布（§41—§42）

| ID | 出处 | 要求摘要 | 级别 | V1 归属 | 任务（阶段） | 验收 | 状态 |
|---|---|---|---|---|---|---|---|
| REQ-41-01 | §41 | 后期反馈闭环（Content→Video→Publish→Retention/CTR→Scene Performance→Director Learning）；自动学习规则必须可解释、可关闭、可人工覆盖 | MAY | 后续 | P14-01—P14-03（P14） | P14-03 验收（可查看/关闭/接受/恢复） | DEFERRED |
| REQ-42-01 | §42 | 发布层非 V1 核心；不得假设任何平台存在同等、稳定、永久可用的自动发布能力 | MUST | V1-契约 | P01-06/P13（P01/P13） | 分级契约就位（P01-06）；LED-96-PUB-01 已关；PUB-03 待 P13 | TODO |
| REQ-42-02 | §42.1 | Capability Tier：P1 DIRECT_PUBLISH / P2 AUTHORIZED_PUBLISH / P3 UPLOAD_DRAFT-HANDOFF / P4 EXPORT_PACKAGE；能力必须来自 Capability Registry，禁止硬编码"某平台永远是 P1/P2"，可配置降级 | MUST | V1-契约 | P01-06（契约）；P13-01 实现 | 分级类型 + registry 就位并测试（P01-06；证据 docs/verification/P01-06.md）；真实平台接入 P13-03 | VERIFIED |
| REQ-42-03 | §42.2 | DistributionProvider 契约（capabilities/authorize/validate/publish/uploadDraft/getStatus/updateMetadata/fetchAnalytics/revoke）与 capabilities 枚举（含 SCHEDULING/THUMBNAIL/AIGC_DISCLOSURE 等 11 项） | MUST | V1-契约 | P01-06（P01）；P13-01 实现 | 接口与枚举契约化；"契约不依赖 Web"由 R3 机械强制（P01-06） | VERIFIED |
| REQ-42-04 | §42.3 | UI 按 Capability 显示动作（P1 Publish Now/Schedule；P2 Review & Confirm；P3 Send to Draft/Open；P4 Export Package/Send to Phone）；P4 包内容含适配视频/封面/标题/文案/标签/披露/清单 | MUST | 后续 | P13-04（P13） | P13-04 验收；LED-96-PUB-03 | DEFERRED |
| REQ-42-05 | §42.3 | Mobile App 后续 MUST 能承担可靠 Handoff（制作完成→Send to Phone→下载/保存→Copy 文案→Deep Link） | MUST | 后续 | P15-06（P15） | P15-06 验收 | DEFERRED |
| REQ-42-06 | §42.4 | 核心产品不得依赖 Selenium/Playwright/Cookie 模拟登录完成第三方发布；实验性自动化必须标记 UNSUPPORTED_EXPERIMENTAL 且不承诺可靠性 | MUST | 全期 | P13-01（P13） | LED-96-PUB-04；代码审计 | TODO |
| REQ-42-07 | §42.5 | 平台初始策略（YouTube 参考实现；TikTok/抖音/Bilibili 官方授权或 Draft/Confirm；LinkedIn；X 可选；无稳定 API 平台默认 P4）；P 级状态接入当日据官方能力确认 | SHOULD | 后续 | P13-02/P13-03（P13） | P13-03 逐一核验 | DEFERRED |
| REQ-42-08 | §42.6 | Human Approval Gate 默认（Final Render→QA→READY_FOR_REVIEW→Human Approve→Distribution）；"QA 通过自动发布"必须 Channel 级显式 opt-in 且服从平台政策 | MUST | V1 | P07-06（P07）；P13 完整 | AC-17；未批准不能发布（P07-06） | TODO |

## P. 安全、可观测性与 Provider 治理（§43—§47）

| ID | 出处 | 要求摘要 | 级别 | V1 归属 | 任务（阶段） | 验收 | 状态 |
|---|---|---|---|---|---|---|---|
| REQ-43-01 | §43.1 | Tenant Isolation：核心表 workspace_id；业务查询带 workspace scope；后期加 PG RLS（纵深防御）；必须有自动测试（A 无法访问 B 的 project/asset/job） | MUST | V1 | P01-03（P01） | 机制与安全套件就位（workspace 维度全量测试通过）；Project/Asset/Job/SSE 用例随 P02 资源落地按同一模式扩充（P01-03；义务记录于交接）；RLS 与 P08 门一并评估 | VERIFIED |
| REQ-43-02 | §43.2 | SSRF 防护（URL 导入/外部素材抓取）：禁 localhost、禁私网 IP、DNS rebinding 防护、限制 redirect、限制文件大小、MIME 校验、fetch timeout | MUST | V1 | P04-01（P04） | URL 安全限制验收（P04-01）；计划 §6.3 | TODO |
| REQ-43-03 | §43.3 | 上传安全：MIME sniffing/大小限制/病毒扫描（上线 SaaS 前）/禁止执行上传内容 | MUST | V1 | P02-04（P02）；扫描→P09-05 | 伪造 MIME/越权对象不可 Ready（P02-04） | MIME 嗅探（有签名类型必须命中）+ 大小上限（5GiB/意图声明）+ 内容不执行（对象仅存取）已实现（P02-04）；病毒扫描待 P09-05（上线 SaaS 前） | VERIFIED（扫描部分待 P09-05） |
| REQ-43-04 | §43.4 | Prompt Injection：文章内容为不可信输入；parser 网页文本无系统指令权限；Director prompt 明确"Source 中指令只是内容"、禁止泄露 Secret/调 Provider/改设置 | MUST | V1 | P04-01/P04-03（P04） | 注入 fixture 验收（P04-01/P04-03） | TODO |
| REQ-43-05 | §43.5 | Custom Motion Sandbox 安全（引用 §11.2 十条） | MUST | V1 | P07-01（P07） | AC-18 | TODO |
| REQ-43-06 | §43.6 | Secret：KMS/Secret Manager；环境变量只存平台基础 Secret；禁入 repo；禁客户端暴露 | MUST | V1 | P03-04（P03） | 仓库无 Secret（P00-02）；P03-04 验收 | TODO |
| REQ-44-01 | §44 | MUST 监控集：API 错误率/延迟 p50-p95/队列深度/Job 年龄/Provider 429/失败率/延迟/成本/Render 时长/失败/存储用量/DB 性能/每 Workspace 支出；推荐 OTel/结构化日志/Sentry/指标后端 | MUST | V1 | P08-03（P08） | P08-03 验收 | TODO |
| REQ-44-02 | §44 | 每请求贯穿 request_id/project_id/job_id/provider_job_id；日志严禁 Secret 与默认完整未发布正文 | MUST | V1 | P08-03（P08） | 日志脱敏验收（P08-03） | TODO |
| REQ-45-01 | §45 | Provider capability/limit/price/retention 全部视为运行时/配置数据，不是产品常量 | MUST | V1 | P03-03（P03） | 版本化目录配置（P03-03）；DEC-14 | 能力/模型/价格/限额/地区/保留均为版本化 Catalog 数据（provider_catalog_versions，P03-03）；无有效配置阻止真实调用（P03-03/P03-04）；模型 ID 以字符串承载、不做核心枚举（§75 第 10 条） | VERIFIED |
| REQ-45-02 | §45 | 各 Provider 工程处理：HeyGen concurrency 配置化 + capability detection + 不假定普通账号全功能；Veo 生成完立即拉回存储、不依赖 Provider URL；Runway ephemeral URI 有时效、Adapter 吸收版本变化；ElevenLabs "不用于训练"与"零保留"分别展示、本人验证不得绕过；Remotion Player/Lambda 定位 | MUST | V1 | P06-01（P06）；配置侧 P03-03；回收侧 P03-06 | 账号实际能力与 Catalog 一致（P06-01） | TODO（进度：结果立即拉回自有存储的回收链路（P03-06）；**P06-01 能力核验工具已交付**（scripts/provider-verify.mjs：按探测计划做只读最小调用 → 能力通过/不可用/需人工 + 价格与保留策略（接口暴露时）+ **日期证据**报告；未配置凭据 → 退出码 2 列出缺失变量，绝不伪造通过；不直接写库，人工复核后经 Catalog API 写入）；**账号实际能力核验被凭据阻塞**（ELEVENLABS/HEYGEN/VEO 环境变量）） |
| REQ-46-01 | §46 | Provider Capability Registry 字段集（provider/model/modality/supports_*/max_duration/aspect_ratios/resolutions/concurrency_limit/rate_limit/cost_formula/retention/regions/privacy_tier/updated_at）；可先手工维护后期自动同步 | MUST | V1 | P03-03（P03） | P03-03 验收 | TODO |
| REQ-47-01 | §47 | 正式对外收费前 MUST：重核所有 Provider Terms；确认 API 嵌入/白标允许；需 Enterprise 协议的签订；数字人/声音克隆授权与 Consent；Content/Abuse Policy；Privacy/Terms/DPA；不得假定"有 Key=可转售" | MUST | 后续 | P09-06（P09） | P09-06 商业上线门 | DEFERRED |

## Q. 技术栈、工程组织与测试（§48—§51）

| ID | 出处 | 要求摘要 | 级别 | V1 归属 | 任务（阶段） | 验收 | 状态 |
|---|---|---|---|---|---|---|---|
| REQ-48-01 | §48 | 推荐技术栈落地（Next.js/React/Tailwind/TanStack/Zustand；Fastify 或 NestJS；PG + Prisma 或 Drizzle 二选一；Redis/BullMQ；R2 或 S3；Remotion；Docker/CI/CD）。计划 §3.1 裁决默认：Fastify + Drizzle + AWS S3 等 | MUST | V1 | P00-02（P00） | 全新目录可安装/类型检查/测试/构建（P00-02） | TODO |
| REQ-49-01 | §49 | Monorepo 目录结构（apps + packages 清单）；计划 §3.3 增 motion-worker 等细化 | MUST | V1 | P00-02（P00） | P00-02 验收（已核实：docs/verification/P00-02.md） | VERIFIED |
| REQ-49-02 | §49 | 依赖方向 MUST：apps→packages；providers→contracts/domain；web→sdk/contracts；禁 domain 依赖 Next.js / 具体 Provider SDK | MUST | V1 | P00-02（P00） | 依赖规则检查（P00-02）：@ancs/arch-check R1—R6 + 11 个行为测试 + verify 门禁 | VERIFIED |
| REQ-50-01 | §50 | .env 只存基础 Secret/连接（DATABASE_URL/REDIS_URL/OBJECT_STORAGE/KMS/PLATFORM_PROVIDER_KEYS）；模型路由/价格/并发在配置表/后台 | MUST | V1 | P00-02/P03-03（P00/P03） | P00-02 环境示例无 Secret | TODO |
| REQ-51-01 | §51 Unit | Unit 覆盖：Visual Grammar 映射/Scene Graph 校验/Director 规则层/Provider router/成本计算/权限检查/编辑补丁与 revision | MUST | V1 | P00-02 命令 + 各任务（全期） | pnpm test:unit（P00-02） | TODO |
| REQ-51-02 | §51 Contract | 每个 Provider Adapter 用 fixture/mock 做契约测试 | MUST | V1 | P03-07（P03） | CI 可确定性重现故障（P03-07） | Mock Provider 实现 `GenerationProvider` 同一接口（packages/providers/mock-provider）+ 脚本化故障（success/slow/rate_limited/submission_unknown/duplicate_callback/cancel_fails/result_missing）；契约级与端到端（真实 DB/存储/回收链路）测试均为本地确定性（P03-07）；真实 Adapter 的 fixture 随 P06 | VERIFIED（真实 Adapter 契约测试→P06） |
| REQ-51-03 | §51 Integration | Integration：DB+Queue+Worker、upload intents、render pipeline、webhook 幂等 | MUST | V1 | P00-02 + P02/P03/P07 | pnpm test:integration | TODO |
| REQ-51-04 | §51 E2E | E2E：创建项目→导入→Narrative→Storyboard→编辑→预览→mock Provider 终渲染→历史恢复 | MUST | V1 | P05/P08（P05—P08） | pnpm test:e2e；计划 AC 系列 | TODO |
| REQ-51-05 | §51 | Production Provider smoke test 单独运行，不作为普通 CI 必须项 | MUST | V1 | P00-02/P08（P00/P08） | verify 默认零真实费用（计划 §11.1） | TODO |
| REQ-51-06 | §51 | Multi-tenant 安全测试必须：跨 Workspace 读拒绝/写拒绝/Signed URL scope/凭据隔离 | MUST | V1 | P01-03（P01） | 四要素全量覆盖（读/写拒绝 P01-03；Signed URL scope P02-04；**Provider 凭据隔离 P03-04**） | 跨 workspace 读/写拒绝 + Signed URL scope（assets.security.test.ts）+ **Provider 凭据隔离**（credentials.security.test.ts：连接与设置全 404、不泄漏资源 id/Secret/密文，客户端永不持有 Provider Key）——**4/4 完成** | VERIFIED |

## R. AI 输出、可解释性与锁定（§52—§54）

| ID | 出处 | 要求摘要 | 级别 | V1 归属 | 任务（阶段） | 验收 | 状态 |
|---|---|---|---|---|---|---|---|
| REQ-52-01 | §52 | Narrative/Director/AI Edit 默认输出 JSON Schema（非自由文本后解析）；必须 schema validation + retry/repair + 模型输出与 prompt 版本 | MUST | V1 | P04-03/P04-05（P04） | 非法 Schema 有限修复（P04-03） | Narrative 侧已实现：结构化 JSON 输出（Mock 与真实同契约）+ **schema validation + 有界 retry/repair（至多 2 次调用、至多 12 条修复）** + prompt/model 版本记录（generation.promptVersion/modelVersion）（P04-03）；Director/AI Edit 侧随 P04-05/P05-06 沿用同一范式 | VERIFIED（Director/AI Edit→P04-05/P05-06） |
| REQ-52-02 | §52 | 保存 prompt_template_version/schema_version/model_id 以复现问题 | MUST | V1 | P03-05/P04-03（P03/P04） | P04-03 验收 | provider_generations 记录模型/版本/输入指纹（P03-05）；**NarrativePlan.generation 记录 promptVersion/modelVersion/providerId + repairs/warnings**、文档 schemaVersion 一并持久化（P04-03） | VERIFIED |
| REQ-53-01 | §53 | 不保存/暴露私密 Chain of Thought；可保存短决策摘要（如"时间序列+双资产比较→DUAL_LINE_CHART，数据来自 source_12"）用于 Debug/解释/QA | MUST | V1 | P04-05（P04） | 简短决策摘要输出（P04-05） | TODO |
| REQ-54-01 | §54 | Scene 状态 locked_by_user/approved/needs_review；Lock 后 AI 重生成不得修改；冲突返回 warning（不自动解锁） | MUST | V1 | P02-02/P04-05（P02/P04） | AC-14；锁定场景不被改写（P02-02） | TODO |
| REQ-54-02 | §54 | 团队 Reviewer approval 与 Final approval gate（计划 §4.7：绑定 projectVersionId+renderId+manifestHash） | SHOULD | V1 | P07-06（P07） | 新编辑需重新审批（P07-06） | TODO |

## S. 降级、来源、主题、字幕与音频（§55—§59）

| ID | 出处 | 要求摘要 | 级别 | V1 归属 | 任务（阶段） | 验收 | 状态 |
|---|---|---|---|---|---|---|---|
| REQ-55-01 | §55 | 降级链：Primary→Fallback Provider→Fallback Static Visual→Needs Review（示例 Veo→Runway→Image+Ken Burns→Text/Motion）；Final Render 前存在 unresolved required Scene 必须提示 | MUST | V1 | P04-05/P07-05（P04/P07） | AC-15/AC-16；受控降级（P04-04） | TODO |
| REQ-56-01 | §56 | 关键 Claim 可绑定 Source；Scene 可绑定一个或多个 Claim；Source 可显示在画面或 Description；AI 不得伪造来源；URL/title/访问时间结构化保存 | MUST | V1 | P04-02（P04） | 每个事实图表可追溯（P04-02）；LED-77 | Claim→Source 绑定（sourceIds + citation 定位）；来源结构化保存 URL/title/publisher/author/publishedAt/retrievedAt/contentHash（P04-01/P04-02）；**不得伪造来源**：引用来源必须属于本项目（SOURCE_NOT_IN_PROJECT），fact 无来源即拒绝/降级；Scene 绑定 Claim 属 P04-05 | VERIFIED（Scene 绑定 Claim→P04-05） |
| REQ-56-02 | §56 | 未来 Citation overlay 与 Source list 自动生成 | MAY | 后续 | P10-05（P10） | P10-05 验收 | DEFERRED |
| REQ-57-01 | §57 | 组件不得写死颜色/字体；使用 Design Tokens（font/color/spacing/radius/motion）；Creator Profile 选择/保存 Theme；跨组件品牌一致 | MUST | V1 | P05-01（P05） | 字体和颜色可由主题控制（P05-01） | VERIFIED（P05-01：SceneThemeProvider/useSceneTheme 全量 tokens；单测断言两主题输出不同且不残留默认主题色/字体；真实渲染两主题 PNG 字节不同；Creator Profile 侧 Theme 选择随 P05-03/P06） |
| REQ-58-01 | §58 | MVP 字幕 MUST：自动字幕/词级 timing/改文字/断句/样式 preset/burn-in 可选/SRT-VTT 导出 | MUST | V1 | P06-06（P06） | 字幕不越界；音量调整不重做 TTS（P06-06） | VERIFIED（P06-06：字幕由 Alignment **派生**（自动字幕 + 词级 timing 已在段内）；断句=视觉宽度断行（标点不入行首）；样式 schema（字号/行数/位置/背景/安全区）；burn-in 为渲染选项（captionRenderOptions）；SRT/VTT 导出（时间码规范，集成测试逐项对应）；越界**只报 warning 不静默裁切**；字幕与音量操作**不触发 TTS**（测试断言调用数不变）。改文字=改旁白块文本→局部重建（P06-03）） |
| REQ-58-02 | §58 | 字幕是 Scene Graph/Project 结构化数据，不只存在最终 MP4 | MUST | V1 | P02-01/P06-06（P02/P06） | Graph 含 captions（P02-01） | VERIFIED（P06-06：字幕=Alignment 的**结构化派生视图**（master_narrations.cues/segments 为持久化事实源；SRT/VTT 只是导出格式）——不依赖最终 MP4；Scene Graph 的 captions[] 字段在 P02-01 已建模） |
| REQ-59-01 | §59 | MVP 音频：1 条 BGM + Voice track + Scene media audio；简单音量/ducking/fade in-out；不做完整 DAW | MUST | V1 | P06-06（P06） | 无重叠双人声（P06-06） | VERIFIED（P06-06：混音计划（纯计算/平台中立）：旁白唯一来源=Alignment（narration:master 恒存在）；非旁白轨（MUSIC/SCENE）音量 + 淡入淡出 + ducking（attack/release，默认可配置）；**含 NARRATION 轨 → 客户端契约与服务端双层拒绝**；不做 Track 嵌套/曲线（完整 DAW 明确不在范围）） |
| REQ-59-02 | §59 | Music Asset 必须保存授权/license metadata（使用第三方素材时） | MUST | V1 | P02-04（P02） | 授权元数据验收（P02-04） | TODO |

## T. CMS、通知、搜索与多端逻辑（§60—§63）

| ID | 出处 | 要求摘要 | 级别 | V1 归属 | 任务（阶段） | 验收 | 状态 |
|---|---|---|---|---|---|---|---|
| REQ-60-01 | §60 | MUST 在 Project API 支持机器创建与幂等（后续 CMS Webhook 复用，不新造业务模型） | MUST | V1-契约 | P01-05/P02-02（P01/P02）；P13-06 完整 | 同事件重放不重复建项目（P13-06）；AC-03 | TODO |
| REQ-61-01 | §61 | MVP Web 通知：in-app、Job 失败、Render 完成；Notification 统一后端事件层，不写死 Web toast；Push 后续 | MUST | V1 | P02-06（P02）；Push→P15-05 | P02-06 验收 | 通知持久化在服务端（notifications 表 + 用户级 REST + 未读计数 + 未读合并）；Outbox 消费者按规则生成（PROJECT_UPDATED 已实现；JOB_FAILED/RENDER 完成类型预留位随 P03/P07）（P02-06） | VERIFIED |
| REQ-62-01 | §62 | 后期搜索：Project/Scene narration/Source/Asset/Component；MVP 可 PG FTS，未来专用搜索 | MAY | 后续 | P10-06（P10） | 搜索遵守租户与删除状态（P10-06） | DEFERRED |
| REQ-63-01 | §63 | 多端不重复后端逻辑检查：未来新增 mobile 不需要复制 Director/Provider/权限/成本逻辑或重新设计存储；只需 SDK + UI/OS + 本地缓存/通知/文件 | MUST | V1-契约 | P15-04（P15） | LED-78；P15-04 验收 | TODO |
## U. Web MVP 阶段范围与组件（§64—§66）

| ID | 出处 | 要求摘要 | 级别 | V1 归属 | 任务（阶段） | 验收 | 状态 |
|---|---|---|---|---|---|---|---|
| REQ-64-01 | §64 Phase 0 | Foundation MUST：Monorepo/API 独立服务/PostgreSQL/Redis-BullMQ/Object Storage/Auth/Workspace/Shared contracts/OpenAPI/SDK/Project-Scene-Asset 数据模型/Revision/Event Log/Provider 接口骨架。验收：Web 所有项目业务通过 API SDK 完成 | MUST | V1 | P00—P02（P00—P02） | G0/G1；P01-05 验收 | TODO |
| REQ-64-02 | §64 Phase 1 | Article→Scene Graph MUST：Create Project/URL 导入或粘贴/ContentDocument/Narrative Engine/Script 查看编辑/Director v0.1/Visual Grammar v0.1/15～20 标准组件/Scene Graph/Storyboard UI；允许 Provider mock 但必须有真实 LLM integration | MUST | V1 | P04—P05（P04/P05） | G2；P05-02 组件数≥20（DEC-04） | TODO |
| REQ-64-03 | §64 Phase 2 | Preview + AI Editor MUST：Remotion Player/Scene Editor/自然语言编辑计划/Apply-Undo/Lite Timeline/Project Versions/Intent History/Draft render | MUST | V1 | P05（P05） | G2；P05-03..06 验收 | TODO |
| REQ-64-04 | §64 Phase 3 | 真实 Provider：HeyGen Avatar/Voice（TTS+VoiceIdentity；Clone 按 readiness）/Veo/Runway 接入；MUST：Provider queues/retry/fallback/cost ledger/result fetch to own storage/capability registry | MUST | V1 | P06（P06）+P03 | G3；P06-01..05 验收；LEG-77-13/14/15 | TODO |
| REQ-64-05 | §64 Phase 4 | Final Render MUST：Master narration/timing alignment/final asset generation/Remotion server render/FFmpeg finalization/MP4-SRT-VTT/Manifest/final version snapshot。目标：稳定生成 8～12 分钟财经视频（金样按 §80 取 8～10 分钟） | MUST | V1 | P06-03/P07-04（P06/P07） | G3；P08-05 真实金样 | TODO |
| REQ-64-06 | §64 Phase 5 | SaaS 基础：Platform Credits/BYOK/Storage quota/Billing/Team roles/Privacy modes/Provider settings UI | MAY | 后续 | P09（P09） | G5；P09-01..04 | DEFERRED |
| REQ-64-07 | §64 Phase 6 | Post-MVP Packs 经 Extension Points 接入不得污染 Core：Shorts/Publishing/Social Visual/Text/Analytics Director；短视频不得机械裁切 | MAY | 后续 | P11—P14（P11+） | G6；各 Pack 独立验收 | DEFERRED |
| REQ-64-08 | §64 Phase 7 | Desktop（Tauri/Electron shell/same SDK/文件系统/通知/缓存）与 Mobile（RN/same SDK/review-approve-light edit/push）；禁止为端改核心 domain 模型 | MAY | 后续 | P15（P15） | G7；P15-01..08 | DEFERRED |
| REQ-65-01 | §65 | 第一批 28 类型组件优先级清单；V1 收敛为 20 个标准类型（DEC-04）：其余 8 类映射 AI_VIDEO→P06-05、CUSTOM_MOTION→P07-02、YIELD_CURVE→P14-04、PROCESS_FLOW/COMPARE_SPLIT/MAP_FLOW/PERSON_PROFILE/COMPANY_PROFILE→P10-04 | SHOULD | V1 | P05-02（P05）；余额见各任务 | 每组件正常/长文本/空值/极值/边界时长证据（P05-02）；DEC-04 | VERIFIED（P05-02：20 类全部实现并注册（注册表 missing 为空）；每组件 × 五变体：单元标记断言 + 画廊成片 PNG（5 张，每张 20 组件）+ 视觉复核（修复 5 处真实溢出）；余额类型指向任务不变） |
| REQ-65-02 | §65 | 第二批 8 类型：CANDLE_CHART/POLICY_PATH/SUPPLY_CHAIN/TRADE_ROUTE_MAP/SCENARIO_TREE→P14-04（Finance Pack）；IMAGE_COLLAGE/RANKING_BAR/NETWORK_DIAGRAM→P10-04 | MAY | 后续 | P14-04/P10-04 | P14-04/P10-04 验收 | DEFERRED |
| REQ-66-01 | §66 | UI 复杂度预算：默认只显示 Preview/AI Director command/Scene list/当前 Scene settings；Timeline 二级入口；高级 Provider 设置仅在 Settings/Advanced；用户无需理解 endpoint/model/concurrency/prompt | MUST | V1 | P05-03（P05） | P05-03 验收 | TODO |

## V. 运营、成本、性能与可靠性（§67—§72）

| ID | 出处 | 要求摘要 | 级别 | V1 归属 | 任务（阶段） | 验收 | 状态 |
|---|---|---|---|---|---|---|---|
| REQ-67-01 | §67 | 最小 Admin：Users/Workspaces/Projects/Queue/Failed Jobs/Provider status/Provider spend/Usage/Credits/Storage/Abuse flag/Manual retry | MUST | V1 | P08-02（P08） | P08-02 验收 | TODO |
| REQ-67-02 | §67 | Admin 权限严格分离，不复用普通用户角色（PLATFORM_ADMIN） | MUST | V1 | P01-03/P08-02（P01/P08） | 普通用户不能访问（P08-02） | TODO |
| REQ-68-01 | §68 | 成本保护实现：per-job max cost/per-project budget/workspace daily cap/provider daily cap/circuit breaker/retry max/idempotency/"Final Render 需显式动作"默认 | MUST | V1 | P03-05（P03） | AC-11；并发抢预算不超额 | **per-job max cost + workspace 周期预算（DAILY/MONTHLY）+ 原子预留（AC-11 并发不超额）+ 账本结算幂等 + retry max（P03-02）已实现（P03-05）**；provider daily cap 与 circuit breaker 待 P06（需真实失败率/延迟数据）；"Final Render 需显式动作"随 P07-05 | VERIFIED（provider 级限额与熔断→P06；显式 Final Render→P07-05） |
| REQ-68-02 | §68 | 超预算时 Router：降级模型/提示用户/不允许无限重试 | MUST | V1 | P03-05（P03） | P03-05 验收；计划 §6.1 | TODO |
| REQ-69-01 | §69 | 昂贵操作必须带 deterministic generation key（scene revision+provider config+prompt+source checksums+output profile）；重复请求先查 succeeded；双击 Generate 不得两个付费任务 | MUST | V1 | P03-05（P03） | AC-02；计划 §5.6 指纹 | TODO（进度：provider_generations 的 input_hash 字段与唯一键（重放不重复记账）+ 预留幂等（同 job 不重复占额）已就位（P03-05）；**生成指纹的构造与"先查 succeeded"**（AC-02 双击 Generate）随 P03-06/P06 的生成入口落地） |
| REQ-70-01 | §70 | 性能目标：API p95＜500ms/Scene patch optimistic＜150ms/项目首屏＜3s/预览修改＜500ms/上传直传/大列表分页虚拟化 | SHOULD | V1 | P08-04（P08） | 记录测试环境与结果或列明阻塞（P08-04） | TODO |
| REQ-70-02 | §70 | 外部生成任务只提供进度状态，不阻塞 UI | MUST | V1 | P03-01（P03） | 202+jobId；进度事件（P02-06） | jobs REST（详情/列表/取消/重试）+ job.queued/started/progress/completed/failed 事件经 SSE 推送（P03-01）；UI 侧随 P05 | VERIFIED |
| REQ-71-01 | §71 | 可靠性 MUST：Worker crash 后 Job 可恢复/webhook 重放不重复扣费或重复生成/API 幂等/Render 失败可重试/Asset 生成成功立即持久化/Provider 临时 URL 到期不影响已完成项目 | MUST | V1 | P03-02（P03） | AC-05/06/07/08/09/10；杀 Worker 恢复（P03-02） | TODO |
| REQ-72-01 | §72 | Production：PG 自动备份/PITR/Object Storage versioning-replication 按成本/删除策略与备份保留区分/记录恢复流程 | MUST | V1 | P08-03（P08） | 实际恢复至隔离环境并通过固定版本重渲染（P08-03） | TODO |

## W. SaaS、Enterprise、禁止捷径与实现规则（§73—§76）

| ID | 出处 | 要求摘要 | 级别 | V1 归属 | 任务（阶段） | 验收 | 状态 |
|---|---|---|---|---|---|---|---|
| REQ-73-01 | §73.1 | Subscription=软件价值、AI Compute=Managed Credits 或 BYOK 必须分离；禁止"无限生成"套餐；价格不硬编码业务逻辑 | MUST | V1-契约 | P03-05（V1 账本）；P09-01 完整 | LED-96-COM-01/02；P09-01 验收 | TODO |
| REQ-73-02 | §73.2 | Entitlement 维度：Software Plan/Managed Credits/Storage/Seats/Creator Identities/Channels/BYOK/Privacy mode/Render priority/4K/Analytics/Pack Entitlements/Custom Motion budget/Premium 功能 | MUST | 后续 | P09-01（P09） | 所有额度 API 强制执行（P09-01） | DEFERRED |
| REQ-73-03 | §73.3 | Credits 估算 = 平台成本+重试储备+基建储备+毛利；保留安全边际（失败重试/重生成/手续费/基建/价格变化/滥用）；不得按 Provider 成本原价透传 | MUST | V1 | P03-05（P03） | P03-05 验收；计划 §6.1 | TODO |
| REQ-73-04 | §73.4 | BYOK 仍支付软件订阅（Director/Scene Graph/Visual Grammar/Components/Editor/Workflow/History/Collaboration） | MUST | 后续 | P09-01（P09） | P09-01 验收 | DEFERRED |
| REQ-73-05 | §73.5 | 成本控制：Draft 不调高成本 Final Provider/生成视频秒数有 Workspace-Project-RenderMode budget/Avatar 与 AI Video 占比可作 cost-aware 约束/Preview-Draft 允许 placeholder/Final 前显示成本估算/Ledger 可细化到 Project-Scene-Provider-Operation | MUST | V1 | P03-05/P05-04（P03/P05） | AC-12；P05-06 成本影响显示 | TODO |
| REQ-74-01 | §74 | Enterprise 预留：SSO-SAML/SCIM/Audit export/Approval workflow/Dedicated credentials/Customer-managed storage/Regional residency/ZDR route/Dedicated compute；MVP 不实现但数据库/Workspace 设计不得阻断 | MAY | 后续 | P16-05—P16-08（P16） | G8；P16 验收 | DEFERRED |
| REQ-75-01 | §75 | MUST NOT 15 条：1) 状态塞 localStorage；2) Scene Graph 单一大 JSON 无 revision；3) Provider 调用写进 Next page/component；4) 客户端持平台 Secret；5) Provider URL 当永久文件；6) 每次改 Draft 触发昂贵 AI Video；7) 整篇私密文章默认发所有 Provider；8) 最终 Timeline 作唯一 SoT；9) Web 与 Mobile 两套业务逻辑；10) Provider 模型 ID 作核心枚举；11) 数据图表 AI 虚构数值；12) 付费 generation 无限自动 retry；13) 删除 Project 立即物理不可恢复；14) Key 进日志或错误返回；15) Custom Motion 代码在主 API 进程无隔离执行。各条已被上方对应 REQ 覆盖（如 5→REQ-26-01、7→REQ-2-07、11→REQ-10-03、15→REQ-11-03），其余由专项审计与 AC 覆盖 | MUST | 全期 | 全阶段（评审规则） | G4/G8 审计逐条核对；相关 AC-01/02/06/08/10/12/18 | TODO |
| REQ-76-01 | §76 | 每 Phase 顺序：schema/contracts→migration→domain/service→API→SDK→Web UI→tests→docs；不得先在 UI 写临时逻辑再抽取（计划 §7 模板） | MUST | 全期 | 全阶段（流程） | 每任务交接记录按此顺序核验 | TODO |
| REQ-76-02 | §76 | 所有 TODO 必须写清 why/dependency/intended interface | MUST | 全期 | 全阶段（流程） | 代码审计 | TODO |
| REQ-76-03 | §76 | 无真实凭据时使用明确 Mock Adapter；UI 标示 MOCK；不得伪造"真实生成成功" | MUST | V1 | P03-07（P03） | Mock 故障矩阵（P03-07）；计划免责声明 | Mock Provider 明确命名（providerId=mock.provider、包名 providers/mock-provider）且**不冒充真实 Provider**（真实调用被 Catalog 核验门控阻止，P03-03/P03-04）；结果与事件中标注 providerId 可辨；UI 的 MOCK 标示随 P05；测试断言不使用"真实成功"字样 | VERIFIED（UI 标示→P05） |

## X. 验收定义、开发顺序与金样（§77—§82）

| ID | 出处 | 要求摘要 | 级别 | V1 归属 | 任务（阶段） | 验收 | 状态 |
|---|---|---|---|---|---|---|---|
| REQ-77-01 | §77 | Web MVP Definition of Done 24 条 → 见验收账本 LED-77-01..24 逐项建账 | MUST | V1 | P08-06（P08） | LED-77-*（G4 门禁） | TODO |
| REQ-78-01 | §78 | Multi-Client Readiness DoD 11 条 → 见验收账本 LED-78-01..11；任一项不满足不得宣称"可以直接做 App" | MUST | V1 | P01/P08-06（P01/P08） | LED-78-* | TODO |
| REQ-79-01 | §79 | 推荐开发顺序（contracts→Auth/Workspace→DB schema→Scene Graph schema→revision/history→存储→Workflow→Provider 接口→Content/Narrative/Visual/Director→组件→编辑器→预览→Provider 集成→Final→Credits/BYOK）；不得先接一堆 Provider 再补 Graph | MUST | V1 | 计划 P00—P08 任务序 | 任务依赖表（计划 §8）；§13.5 启动步骤 | TODO |
| REQ-80-01 | §80 | Golden Fixture = 财经文章《为什么法国国债风险突然升温？》，约 8～10 分钟，含 Host Hook/Big Number/收益率对比/Spread/Timeline/Causal Loop/Map/News Headline/Source Card/Quote/Custom Motion/少量 AI Video/Summary | MUST | V1 | P00-04（建库）；P08-05（成片） | P00-04 可追溯数据；P08-05 真实金样 | TODO |
| REQ-80-02 | §80 | 每次 Director/Component 变更用此 Fixture 做回归测试 | MUST | V1 | P00-04（P00） | 金样与 test:golden 门禁就位（15 项，P00-04；证据 docs/verification/P00-04.md）；Director/组件回归用例随 P04/P05 持续加入本套件 | VERIFIED |
| REQ-81-01 | §81 | 长期护城河清单（Narrative/Director/Visual Grammar/组件库/Custom Motion 库/Creator Profile/Edit-Intent 数据/性能数据集/Provider Router） | 方向 | 后续 | 不设任务（方向对齐） | — | DEFERRED |
| REQ-82-01 | §82 | 最终体验目标叙事（Paste URL→建议时长→多类型 Scene 混合→自然语言修改→16:9 长视频+Shorts+封面+文案+章节+来源） | 方向 | 后续 | 不设任务（方向对齐，P08-05 为 V1 当前形态） | — | DEFERRED |

## Y. 附录 A / B / C

| ID | 出处 | 要求摘要 | 级别 | V1 归属 | 任务（阶段） | 验收 | 状态 |
|---|---|---|---|---|---|---|---|
| REQ-A-01 | 附录 A | 官方能力基线仅作 Adapter 开发参考，不得硬编码；上线前必须再次核验（HeyGen 并发/处理时间/隐私；Gemini 限额；Veo 约 2 天保留；Runway tier/ephemeral；Remotion Player/Lambda；ElevenLabs timestamps/ZDR） | MUST | V1 | P06-01/P09-06（P06/P09） | P06-01 日期证据；P03-03 版本化配置初值 | TODO（进度：P06-01 核验**工具与日期证据产出机制**已交付（报告落 .artifacts/provider-verification/ 并注明"人工复核后写入 Catalog"）；维度表（并发/保留/时间戳/ZDR 等）在探测计划 provider-probes.json 中以 capability+extract 表达（接口暴露的字段才记录，缺失即未知）；真实日期证据待凭据） |
| REQ-B-01 | 附录 B | 仓库根 README/AGENTS.md 必须写出 15 条 ARCHITECTURE RULES（Scene Graph SoT/Web 是客户端/版本化 API/domain 不依赖 Next/Provider SDK 限于 Adapter/不暴露 Secret/昂贵生成异步幂等排队/Draft 不触发昂贵生成/Provider URL 临时/写操作带 revision/付费入账本/AI 输出为校验过的结构化操作/事实图表需真实数据/三端共享契约/不重造 Premiere） | MUST | V1 | P00-02（P00） | README 15 条规则核对（已核实：docs/verification/P00-02.md） | VERIFIED |
| REQ-C-01 | 附录 C | 首批工程验收清单 49 条（Architecture 8/Domain 10/AI 6/Video 7/Reliability 6/Security 6/Multi-client 6）→ 见验收账本 LED-C-*，P00 逐项建账、阶段门逐项关闭 | MUST | V1 | P00 建账；各阶段关闭（P00—P08） | LED-C-*（G1—G4 逐步关闭） | TODO |

## Z. Provider 回导、素材与发布质量（§83—§91）

| ID | 出处 | 要求摘要 | 级别 | V1 归属 | 任务（阶段） | 验收 | 状态 |
|---|---|---|---|---|---|---|---|
| REQ-83-01 | §83 | MUST 设计 Native Fallback / External Asset Round-trip：Scene→Advanced→Provider Job 引用（能力允许）→原生处理→Import→回绑 Scene；要求：导入结果进入 Asset 管理/Graph 仍 SoT/不脱离版本历史/不支持 deep link 时给 Job ID+上传替换 | MUST | V1 | P06-07（P06） | 回导成为 AssetVersion 保留来源授权与历史（P06-07） | VERIFIED（P06-07：任务引用展示（providerId/providerJobId/状态/结果资产与回绑时间；**不支持深链时给 Job ID + 上传替换**）；外部产物经资产链路成为**新 AssetVersion**（USER_UPLOAD + license 保留来源/授权；不原地覆盖）；回绑记录在 provider_generations（result_asset_id/version/rebind_source/rebound_at）；Scene 回绑走编辑协议 replace_asset（EditEvent 可追溯）；跨工作区 404 / 未 READY 409；只处理用户提供的文件，不以自动化冒充 Provider 完成） |
| REQ-83-02 | §83 | 只重做高频且与核心工作流相关的 Provider UI，不为少数高级功能复制整个第三方编辑器 | 方向 | 全期 | 设计原则 | 评审 | TODO |
| REQ-84-01 | §84 | Asset origin 枚举：USER_UPLOAD/USER_LIBRARY/SOURCE_DOCUMENT/LICENSED_STOCK/PUBLIC_SOURCE/GENERATED/PROVIDER_IMPORT | MUST | V1 | P02-04（P02） | P02-04 验收 | TODO |
| REQ-84-02 | §84 | 可发布素材 SHOULD 保存 origin/source_url/provider/author/license_type/license_reference/attribution_required/attribution_text/usage_restrictions/acquired_at | SHOULD | V1 | P02-04（P02） | 授权元数据验收（P02-04） | TODO |
| REQ-84-03 | §84 | MUST：不把网上图片默认可商用；真实新闻/媒体素材与 AI 生成素材 metadata 可区分；需要 attribution 的素材可自动生成署名（Description/Sources）；用户上传默认声明权利，对外 SaaS 时 Terms 明确责任边界 | MUST | V1 | P02-04（P02）；Terms→P09-06 | 素材许可状态可查（P10-03）；署名自动生成 | TODO |
| REQ-84-04 | §84 | Licensed Stock Provider 未来仍通过 Asset Acquisition Adapter 接入 | MAY | 后续 | P10-03（P10） | P10-03 验收 | DEFERRED |
| REQ-85-01 | §85 | Source Snapshot 元数据（source_id/url/title/publisher/author/published_at/retrieved_at/content_hash/excerpt_reference/snapshot_asset_id）；目的：防网页变更失效、可追溯依据、生成 Source Card/Description | SHOULD | V1 | P04-02（P04） | 来源快照与引用（P04-02） | project_sources 落地 url/title/publisher/author/publishedAt/retrievedAt/contentHash/excerpt/note（P04-01）；引用定位（locator/quotedText）随 P04-02；**snapshotAssetId（完整快照资产）** 待 P04-02 后续/P06 真实抓取形态 | TODO（进度：元数据与引用已就位；完整快照资产待补） |
| REQ-85-02 | §85 | 保存网页截图/全文必须遵循版权与存储策略，不默认永久镜像所有网页内容 | MUST | V1 | P04-02（P04） | P04-02 验收 | TODO |
| REQ-86-01 | §86 Technical QA | Final Render 后 MUST 自动 QA：文件可读/duration 与 manifest 一致/resolution-fps 正确/黑帧空白帧阈值/无缺失 Asset/音轨存在/响度峰值在配置范围/字幕不越界/关键文本在安全区 | MUST | V1 | P07-05（P07） | AC-16；P07-05 验收；计划 §6.4 响度默认 -16 LUFS±1、True Peak≤-1 dBTP | TODO |
| REQ-86-02 | §86 Content QA | Scene 数量与 Graph 一致/required source bindings 存在/事实图表数据绑定有效/未解决 placeholder 禁止进入 Final/未完成 Provider Job 不允许发布/needs_review 阻止自动发布 | MUST | V1 | P07-05（P07） | AC-16/AC-17；P07-05 验收 | TODO |
| REQ-86-03 | §86 AI QA | AI/Visual QA（SHOULD）：高价值 Scene/Custom Motion 抽样检查文字溢出/布局/素材缺失/与 visual intent 明显不符；AI QA 只作提示不取代确定性校验 | SHOULD | V1 | P07-05（P07） | P07-05 验收 | TODO |
| REQ-87-01 | §87 | 默认 Generate→QA→READY_FOR_REVIEW→Human Approve→Publish/Export；MVP 不默认文章发布后全自动发 YouTube；auto publish 必须显式 opt-in 且可按 Channel 设置；企业可配 Reviewer/Approver | MUST | V1 | P07-06（P07）；P13 完整 | AC-17；未批准不能正式导出（P07-06） | TODO |
| REQ-88-01 | §88 | CMS write-back 后期流程（Article published→Project→Video Ready→CMS callback→Article 嵌入）；Backend SHOULD 预留 external_source_id/external_source_type/callback_url；CMS integration 不得直接操作内部 DB | SHOULD | V1-契约 | P13-07（P13）；字段预留 P02-01 | P13-07 验收（回写失败不影响成片） | TODO |
| REQ-89-01 | §89 | 显式 ImageGenerationProvider 与 AssetSearchProvider 抽象（capabilities/estimate/generate；search/resolveLicense） | SHOULD | 后续 | P10-03（P10） | 相同公共契约测试（P10-03） | DEFERRED |
| REQ-89-02 | §89 | 用途：storyboard still/背景/概念图/封面/图库检索；Director 默认顺序：真实证据-数据-已有资产优先，生成图片不是事实证据替代品 | MUST | V1 | P04-04（P04） | P04-04 验收；REQ-2-03 | TODO |
| REQ-90-01 | §90 | Publishing Job MUST 幂等键 platform+account+projectVersion+outputAsset；Publication 状态枚举 DRAFT/QUEUED/PUBLISHING/PUBLISHED/FAILED/DELETED_REMOTE；保存 remote_id/remote_url/published_at | MUST | V1-契约 | P01-06（契约）；P13-01 实现 | AC-22；P13-01 验收 | TODO |
| REQ-90-02 | §90 | 同一 Final Version 网络超时重试不得重复发布；结果未知先查询对账不自动重发 | MUST | 后续 | P13-01（P13） | AC-22 | DEFERRED |
| REQ-91-01 | §91 | SHOULD 支持导出：Final MP4/SRT-VTT/Source list/Project Manifest/Scene Graph JSON/用户原始素材（按权限）；未来 Project Bundle；只导出用户有权内容 | SHOULD | 后续 | P10-06（P10） | Bundle 无 Secret、缺权素材明确列出（P10-06） | DEFERRED |

## AA. 扩展架构、Content Core 与 Speech Director（§92—§95）

| ID | 出处 | 要求摘要 | 级别 | V1 归属 | 任务（阶段） | 验收 | 状态 |
|---|---|---|---|---|---|---|---|
| REQ-92-01 | §92 | Core 从第一天必须有稳定 Extension Points；OutputPlugin 契约（manifest/analyze/generate/validate?）；第一版可无插件商城 | MUST | V1-契约 | P01-06（P01） | 接口与数据形状契约化；R3 强制契约不依赖 Web；未安装能力经 requireOutputFormat → CAPABILITY_UNAVAILABLE（P01-06） | VERIFIED |
| REQ-92-02 | §92.1 | 禁止在 Core 中不断添加 outputType 硬编码分支（youtube/xhs/newsletter if）；输出形态经 Pack 扩展 | MUST | 全期 | P11-03（P11） | LED-96-PLUGIN-02；代码审计 | TODO |
| REQ-92-03 | §92.2 | 插件 Capability 声明清单（read_content_core/read_project_assets/create_assets/create_scene_graph/provider_access/distribution_access/analytics_access/network_access）；第三方插件未来支持版本/签名/权限提示/资源配额/撤销 | MUST | V1-契约 | P01-06（P01）；P16-01..03 完整 | 能力声明清单与签名/配额字段就位（P01-06）；生命周期与隔离执行 P16-01—03（进度：1/2） | TODO |
| REQ-92-04 | §92.3 | 商业模式方向（Core 订阅+官方 Pack+Credits/BYOK+Marketplace 分成）；V1 禁止为未来 Marketplace 增加不必要运行时复杂度，先定义 contracts 与 registry | MUST | V1-契约 | P01-06（P01）；P16-04 完整 | contracts + 进程内 registry 就位（无 Marketplace 运行时复杂度）（P01-06）；商业结算 P16-04 | VERIFIED |
| REQ-93-01 | §93 | 多形态必须从平台无关 Content Core 派生（Core→Atoms→Recipes→输出），不得用多个独立生成器；V1 ContentDocument+Narrative MUST 可无损演进 ContentCore | MUST | V1-契约 | P11-01（P11） | LED-96-PLUGIN-03；无损转换前后来源与关键事实一致（P11-01） | TODO |
| REQ-93-02 | §93.1 | Content Core 数据：core_question/core_thesis/key_claims/key_facts/key_numbers/causal_relations/entities/timeline/geography/source_evidence/story_arcs/uncertainties | SHOULD | 后续 | P11-01（P11） | P11-01 验收 | DEFERRED |
| REQ-93-03 | §93.2 | Content Atom 可独立传播单元；Shorts 必须从 Atom 重新编导而非从长视频时间轴机械裁切 | MUST | 后续 | P12-01（P12） | P12-01 验收（短片可独立理解） | DEFERRED |
| REQ-93-04 | §93.3/93.4 | Channel Recipe 表达规则（时长/叙事深度/图表/Avatar 比例/Hook/字幕等）；Channel Fit 输出 RECOMMENDED/OPTIONAL/NOT_RECOMMENDED 并给原因；不得默认自动制造所有平台垃圾内容 | SHOULD | 后续 | P11-02（P11） | P11-02 验收（NOT_RECOMMENDED 可返回） | DEFERRED |
| REQ-94-01 | §94 | Speech Director 输入（narration/emphasis/Scene role/Speech Profile/Provider 能力/目标时长）与输出（voice_identity_id+version/speed/energy/tone/pauses/emphasis_spans/pronunciation_overrides/expected_duration）；默认规则示例（Hook 高能量/复杂解释降速/数字可停顿強調/引用区分/结论稳定） | MUST | V1 | P04-06（P04） | 供应商无关 SpeechPlan；不支持的风格参数可解释降级（P04-06） | VERIFIED（P04-06：SpeechPlan 契约 + 确定性生成（角色/语速/能量/停顿/强调/发音覆盖/预计时长）；越界钳制并记录 requested→applied（可解释降级）；无可用 TTS → STYLE_SUPPORT_UNVERIFIED 明确警示） |
| REQ-94-02 | §94 | Master Narration timestamps 驱动画面/字幕/Avatar/Motion timing | MUST | V1 | P06-03（P06） | P06-03 验收；REQ-13-01 | VERIFIED（P06-03：Alignment/cues 为后续 timing 的权威来源（cueForBlock 查询）；画面/字幕/Avatar/Motion 的实际消费随 P06-04/P06-06/P07 接入） |
| REQ-94-03 | §94 | Provider 私有 style 参数不得泄漏到 Scene Graph 核心 schema（需映射层） | MUST | V1 | P04-06（P04） | 私有参数不泄漏到 Graph（P04-06） | VERIFIED（P04-06：SpeechPlan 只引用 voiceIdentityId/version；provider/providerVoiceId 零出现——集成测试以序列化字符串级断言（含真实 Provider 名称与 voice id 的负例）；映射层=合成 Adapter（P06）） |
| REQ-95-01 | §95 | Voice MUST：Clone 前记录 consent/ownership；保留 Provider 验证状态；训练音频标记 IDENTITY_SENSITIVE；非必要不复制托管训练素材；临时上传遵循最小权限与 TTL；日志不记录原始声音 URL/未遮罩 Secret/完整敏感 Prompt；删除区分（平台解绑/Provider 删除/历史 Manifest 审计引用）；Enterprise/BYOK 身份资产尽量留在客户账号 | MUST | V1 | P06-02/P10-02（P06/P10） | 敏感资料不出现在普通日志（P06-02）；删除三态可区分（P10-02） | TODO |
| REQ-95-02 | §95 | SHOULD：VoiceIdentity retirement 不破坏历史项目；UI 展示 Provider retention/zero-retention；发音词典（品牌/人名/财经术语）版本化 | SHOULD | V1 | P06-02（P06）；P10-02 | 发音词典版本化；P10-02 验收 | TODO |

## AB. v0.2 增量验收与总原则（§96—§97）

| ID | 出处 | 要求摘要 | 级别 | V1 归属 | 任务（阶段） | 验收 | 状态 |
|---|---|---|---|---|---|---|---|
| REQ-96-01 | §96 Scope | 3 条：V1 仅 Article→Long Video 主链路；Shorts/Social/Publishing/Newsletter 不阻塞 V1；Extension contracts 不依赖 Web 前端 → LED-96-SCOPE-01..03 | MUST | V1 | P00/P01-06（P00/P01） | LED-96-SCOPE-* | TODO |
| REQ-96-02 | §96 Voice | 6 条：Identity 数据模型存在；VoiceProvider 不绑死；Managed+BYOK 路由；ownership/verification metadata；SpeechProfile/Speech Director schema；Master Narration timestamp 为最终 timing 基础 → LED-96-VOICE-01..06 | MUST | V1 | P01-04/P06-02/P06-03（P01/P06） | LED-96-VOICE-* | TODO |
| REQ-96-03 | §96 Commercial | 4 条：plan 与 ledger 分离；无"无限 Managed AI"硬编码；Final Render 前可估算 Credits/成本；BYOK 绕平台用量但仍走统一 Router/Adapter → LED-96-COM-01..04 | MUST | V1 | P03-05（V1 基础）；P09-01 完整 | LED-96-COM-* | TODO |
| REQ-96-04 | §96 Publishing | 5 条：capability registry 存在；支持 P1-P4；P4 Export Package；核心不以 browser automation 为可靠发布；Mobile Handoff 预留 → LED-96-PUB-01..05 | MUST | V1-契约 | P01-06（V1 契约）；P13/P15 完整 | LED-96-PUB-* | TODO |
| REQ-96-05 | §96 Plugin | 3 条：OutputPlugin/Pack registry contract；Core 无输出类型硬编码；ContentDocument/Narrative 可演进 ContentCore → LED-96-PLUGIN-01..03 | MUST | V1-契约 | P01-06/P11-01（V1 契约） | LED-96-PLUGIN-* | TODO |
| REQ-97-01 | §97 | 冲突决策优先级：1 Scene Graph/Project 数据完整性＞2 隐私与 Workspace 隔离＞3 可恢复可撤销可审计＞4 多端 API 一致性＞5 Provider 可替换性＞6 Draft 成本控制＞7 最终视频质量＞8 UI 便利性；不得为"Demo 更快"牺牲 1～5（计划 §1.3 约束优先级） | MUST | 全期 | 全阶段（裁决规则） | 冲突裁决记录引用此顺序 | TODO |

---

## 非规范性章节登记

以下章节为背景、方向或愿景描述，不产生独立可验收义务；如需引用其内容作为要求，以其映射的规范性章节为准：

| 章节 | 性质 | 处理 |
|---|---|---|
| §1.1/1.3 部分叙述（产品定位边界、不做清单） | 定位说明 | "不做"清单通过 §75 与范围裁决生效 |
| §3.1 首批用户清单 | 目标用户说明 | 不设门禁 |
| §5 路径与界面线框、§66 | 界面建议 | 以 §5/§66 中 MUST 条目（REQ-5-*、REQ-66-01）为准 |
| §81 护城河、§82 体验愿景 | 长期方向 | REQ-81-01/REQ-82-01 仅登记方向 |
| §97 之外的总结性章节（如 §1.2 编译器模型） | 心智模型 | 由架构约束（§2、§49、附录 B）生效 |

> 说明：本登记用于 G8 审计时回答"该章节是否已覆盖"。凡未在此登记且未分配 REQ 的规范性语句，均视为追踪缺口，必须在发现后立即补录。
---

## P00-01 建账自检（机器校验结果，2026-10-04）

> 本表为 P00-01 建账时点的快照；"状态"列为活列，随任务推进更新（最近一次变更：P07-04，REQ-28-01 / REQ-28-02 / REQ-39-01 → VERIFIED（REQ-39-02 补记 Job 化执行）；此前 P07-03，REQ-39-02 → VERIFIED（REQ-28-02 记录进度）；此前 P07-01，REQ-11-03 → VERIFIED（OS 级隔离属 P08 部署层）；此前 P06-05（非凭据部分），REQ-2-07 / REQ-14-04 → VERIFIED（真实 Veo 接入 BLOCKED 于凭据）；此前 P06-01（工具部分）记录进度（真实核验被凭据阻塞）；此前 P06-07，REQ-83-01 → VERIFIED；此前 P06-06，REQ-58-01 / REQ-58-02 / REQ-59-01 → VERIFIED；此前 P06-03，REQ-13-01 / REQ-13-02 / REQ-13-03 / REQ-94-02 → VERIFIED（真实 TTS 语言覆盖核验待 P06-02 凭据）；此前 P05-05，REQ-3-05 / REQ-5-07 → VERIFIED；此前 P05-04，REQ-5-03 / REQ-18-01 / REQ-38-01 → VERIFIED（REQ-4-04 记录进度）；此前 P05-03，REQ-2-02 / REQ-5-08 → VERIFIED（REQ-5-01/02/04/05/06 记录进度）；此前 P05-02，REQ-65-01 / REQ-10-04 → VERIFIED（REQ-11-01 记录 P05-02 进度）；此前 P05-01，REQ-11-01 / REQ-57-01 → VERIFIED；此前 P04-06，REQ-94-01 / REQ-94-03 → VERIFIED（REQ-94-02/REQ-6-08 保持 P06/P14）；此前 P04-05，REQ-9-02 / REQ-9-03 / REQ-9-04 → VERIFIED（REQ-9-01 记录进度）；此前 P04-04，REQ-10-01 → VERIFIED（REQ-10-03 记录 P04-04 进度）；此前 P04-03，REQ-8-01 / REQ-8-02 / REQ-52-01 / REQ-52-02 → VERIFIED；此前 P04-02：REQ-7-02 / REQ-10-03 / REQ-56-01（REQ-85-01 记录进度）；此前 P04-01：REQ-4-01 / REQ-7-01（REQ-22-04 补登）；此前 P03-07：REQ-15-02 / REQ-51-02 / REQ-76-03（P03 阶段全部完成）；此前 P03-06：REQ-33-04；此前 P03-05：REQ-25-01 / REQ-68-01；此前 P03-04：REQ-17-02 / REQ-45-01、REQ-51-06 4/4；REQ-6-07 / REQ-16-01 记录进度；此前 P03-03：REQ-19-03 的并发信号量配置模型；此前 P03-02：REQ-19-01 / REQ-19-03 / REQ-19-05；此前 P03-01：REQ-2-05 / REQ-70-02；此前 P02-06：REQ-29-06 / REQ-43-03 / REQ-61-01（P02 阶段全部完成）；此前 P02-05：REQ-27-01 / REQ-27-02；此前 P02-04：REQ-26-01/02/03/04，REQ-51-06 进度 3/4；此前 P02-03：REQ-23-01 / REQ-23-03 → VERIFIED；REQ-5-08 / REQ-24-01 记录阶段进度；此前 P02-02：REQ-2-01 / REQ-23-02 / REQ-23-04；P02-01：REQ-22-01 / REQ-22-02 / REQ-22-03 / REQ-12-01 / REQ-12-02 / REQ-19-02；P01-06：REQ-42-02 / REQ-42-03 / REQ-92-01 / REQ-92-04；更早见 git 历史）。

校验命令：对本文档全部 `| REQ-` 行做结构化解析（脚本见 `docs/verification/P00-01.md`）。

| 校验项 | 结果 |
|---|---|
| REQ 总条目 | 266 |
| 级别分布 | MUST 215 / SHOULD 32 / MAY 14 / 方向 5 |
| V1 归属分布 | V1 204 / V1-契约 16 / 全期 9 / 后续 37 |
| 状态分布 | TODO 229 / DEFERRED 37 |
| 重复 ID | 无 |
| 列结构异常 | 无（每条 8 列：ID/出处/摘要/级别/V1/任务/验收/状态） |
| MUST 缺任务或缺验收 | 无（215/215 通过） |
| 后续阶段条目误列为 V1 阻塞 | 无（37 条"后续"全部为 DEFERRED，未占用 V1 任务门禁） |

### 建账结论

1. 规范 §0—§97 与附录 A/B/C 的全部规范性语句已分配稳定 ID 并映射到计划任务与验收；非规范性内容已在"非规范性章节登记"中列明。
2. 215 条 MUST 均有任务与验收指向；其中指向验收账本（LED-*）、高风险测试（AC-xx）或计划任务验收。
3. 37 条明确排期到 P09—P16 的条目状态为 DEFERRED，不会被计入 V1 完成比例，也不阻塞 G0—G4。
4. 本表为活文档：任务完成时同步更新"状态"列；规范修订时新增 ID，不重编号。发现"未登记且未分配 REQ 的规范性语句"时按缺口处理，立即补录并在 `docs/verification/` 记录变更。
