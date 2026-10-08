# 会话交接文档（Session Handoff）

> **2026-10-08 当前状态优先：** 用户已明确取消旧的 Web 人工验收暂停，要求连续推进全部 v0.4。当前分支 `codex/v04-foundation`；N00-01—07、N01-01—06、N15-01/02、N16-01/02 共 **17/219** 项 VERIFIED。N01-05 已完成旧 Scene/audio/caption/version 的可恢复投影与单写切换；N01-06 已完成 14 种编辑操作注册表、正式批内 ID 和整批候选状态校验；最新迁移 **0060**；`pnpm verify` **968/968**。下一任务 N01-07。以下 P14/main/暂停内容是 2026-10-07 历史交接，若冲突以本段和 v0.4 验收账本为准。

- **交接时点**：2026-10-07（P14 阶段 5/5 全部完成；按用户指令暂停验收）
- **仓库**：`E:\Codes\ANCS`（remote: `https://github.com/MuadibUsul/AI_Native_Creater_Studio.git`，branch main）
- **P14 交付提交**：`06c979e` `feat(p14): Analytics Director 与 Finance Pack Web 闭环`；最终功能/验收头 `34b68c4`；GitHub CI run `37611980360` 全绿
- **权威文档**：需求 `creator_video_os_spec_v0.2.md`；计划 `ANCS_Plan261004.md`；协作规则 `AGENTS.md`（**接手前必读并按其 §13.5 启动步骤执行**）

---

## 1. 总体进度

**104 项计划任务：78 项已交付（75%），P14 已收尾；`pnpm verify` 14 步全绿。当前按用户指令暂停。**

| 阶段 | 任务数 | 状态 |
|---|---|---|
| P00–P08（V1 内部生产） | 48 | ✅ 交付 45（P08-05 真实金样、P06-02/04 真实 Provider 核验 **BLOCKED 凭据**——代码/工具已就位） |
| P09（对外 SaaS 与商业运营） | 6 | ✅ 全部交付（真实 Stripe BLOCKED；P09-06 上线门机制交付，LG-01…14 人工台账全 BLOCKED） |
| P10（输入/声音/素材/组件/输出/检索） | 6 | ✅ 全部交付（真实克隆/素材/Runway BLOCKED 凭据——seam 与验收矩阵就位） |
| P11（Content Core 与官方 Pack） | 4 | ✅ 全部交付（756/759/762/765；LED-96-PLUGIN-02/03 闭合） |
| P12（Shorts/Social/Text/多语言/Podcast） | 5 | ✅ 全部交付（768/771/774/777/780；各 Pack analyze/generate/validate 完整链路） |
| P13（Publishing/Handoff/CMS） | 7 | ✅ 7/7 全部交付：P13-07 CMS 回写完成（803；签名、SSRF、有限重试、崩溃恢复、失败不改 Render） |
| P14（Analytics Director 与 Finance Pack） | 5 | ✅ 5/5 全部交付：表现采集、冻结 Graph 归因、可控学习、六类 Finance、许可来源与版本模板 |
| P15–P16 | 17 | ⏸️ 暂停（P15 8 / P16 9；未经用户明确验收确认不进入） |

- 测试规模：**810 项真实断言**（unit 346 · web 72 · motion 19 · integration 330 · security 22 · render 6 · golden 15；contract/e2e 为显式 `[PLANNED]`）
- 迁移最新编号：**0050**（P14 Analytics/Finance 共 7 张表）；下一迁移为 0051
- **事故记录（诚实披露）**：P12-05 验收中发生过一次编造验收记录事故（未完成验证即写出虚构结果文档）——已删除并以真实运行证据重写；P12-03 修复的种子竞态曾致 P12-01/02 CI 失败（后续提交全绿）。两起均在对应 verification 文档中留档。

## 2. 每阶段一句话备忘（详见 docs/verification/ 对应文件）

- **P09**：Plan 版本化+六处权益强制执行；收款事件幂等闸门（DUPLICATE/OUT_OF_ORDER/验签 401）；Credits 事件入账至多一次+退款扣回（DEBIT+refund_of）+对账；邀请/席位三入口/隐私档位/降级超额（overCommitted）；上传扫描拒绝落盘+滥用 RESTRICTED 闸门+支持访问不可无痕+audit_log；上线门 `ANCS_SAAS_MODE=live` fail-closed（当前代码下 live 必然失败=未就绪不放行）。
- **P10**：文档导入（扫描件 422 不伪造）；Voice Clone（Consent 硬门槛 Provider 零调用/三态生命周期）；素材获取（服务端复核许可 422/自动署名/生成图不冒充证据 QA 守卫 EVIDENCE_ASSET_ORIGIN）；组件扩展 14 类（34 组件五变体矩阵+扩展画廊 PNG）；输出增强（章节/编码/署名与已批准 manifest 一致性，越界 422；THUMBNAIL 真实静帧）；检索迁移（五维搜索租户+软删纪律/Graph 导出无存储键/Bundle 缺权明列）。

## 3. 凭据/外部阻塞项（等用户提供后按矩阵回放）

| 项 | 阻塞 | 回放路径 |
|---|---|---|
| P06-01/02/04/05 真实 Provider 核验、P08-05 真实金样 | ElevenLabs/HeyGen/Veo/LLM API Key | `pnpm run provider:verify` + 各 verification 文档矩阵 |
| P09-02/P09-06 LG-11 真实收款 | Stripe 测试账号 | 实现 StripePaymentProvider → 同一事件矩阵回放 |
| P10-02 真实克隆 / P10-03 真实素材·图像·Runway | 对应 Provider 凭据+端点核验 | 实现 VoiceCloneProvider/AssetSearchProvider/GenerationProvider seam → 回放验收矩阵 |
| P09-06 LG-01…14 | 法务/商务/财务（人工） | `docs/ops/launch-gate.md` 台账举证 → `launch-gate-check.mjs --live` |

## 4. P11 阶段完成（2026-10-06；9b70d34 / b949889 / df2175a / 6d3d6a8）——下一任务：P12-01 Shorts Pack

- **P11-01 交付摘要**：契约 content-core.ts + 迁移 0034（content_cores，project 唯一）+ domain（1:1 派生/facts=fact 子投影/relations 不推断/thesis 不编造/原文档零改动/inputsDigest 幂等）+ API/SDK（client.content.contentCore.{migrate,state}）+ 集成 4/4 + verify 756。详见 docs/verification/P11-01.md。
- **P11-02 交付摘要**：契约 atoms.ts（7 类 Atom sourceRefs≥1 强制 + Recipe requirements 数据化 + Fit verdict/reasons/inputs）+ 迁移 0035（content_atoms + channel_recipes）+ domain（createAtom 悬空引用 422；官方三渠道种子幂等；evaluateChannelFit 三档判定 NOT_RECOMMENDED=200）+ API/SDK（client.content.{atoms,channelRecipes,channelFit}）+ 集成 3/3 + verify 759。详见 docs/verification/P11-02.md。
- **P11-03 交付摘要**：契约 pack-runtime.ts（安装/启用/绑定三段 + restrictedPluginContext + PackPlugin 接口）+ 迁移 0036（pack_installations/pack_enablements/project_pack_bindings）+ domain（四道闸门：绑定→安装→启用→权益白名单 403；buildRestrictedContext 能力门控**无 DB/Secret**）+ 官方 Shorts Analyzer（Fit/Atom → OutputPlan）+ API/SDK（client.packs.{list,enable,disable,bind,analyze}）+ 集成 3/3 + verify 762。详见 docs/verification/P11-03.md。
- **P11-04 交付摘要**：契约 lineage.ts（血缘=派生时输入快照 coreInputsDigest/inputsSnapshot/packVersion/channelKey + 可选 projectVersionId）+ 迁移 0037/0038 + domain（recordPlanLineage 只追加；stale=读取时提示不改状态；approve 一次性+重复 409+可选绑定项目版本同项目校验）+ analyze 自动挂血缘 + API/SDK（client.derivations.{list,approve}）+ 集成 3/3 + verify 765；审计 REQ-92-02（Core 无输出硬编码分支）。详见 docs/verification/P11-04.md。
- **P12-01 设计要点（下一任务）**：Shorts 必须**从 Atom 重新编导**（REQ-93-03，非长视频时间轴机械裁切）；落 generate 切面（OutputPlan → 9:16 派生 SceneGraph）；**原长视频/图不被修改**（派生独立产物，不写回源项目）；竖屏安全区校验（§10 规则复用）；来源保留 = 派生 Scene 引用 Atom→Claim 链；短片独立理解 = Hook 重写 + 单主题约束。已有基础：P11-02 Atom/Recipe/Fit、P11-03 Pack 生命周期 + analyze、P11-04 血缘（approve 可绑 projectVersionId）。落地顺序按 AGENTS.md：contracts → migration → domain → API → SDK → tests → docs。
- **后续**：P12（各 Pack：Shorts/Social/Text/多语言/Podcast）→ P13（发布/交付/CMS）→ P14（运营与学习）→ P15（多端）→ P16（Marketplace/Enterprise，含插件签名与生命周期）。

## 4b. P13 已完成任务摘要（2026-10-07；8c052e7/cc3efa1/93a4367/c62689d/d55ea5b/abc8985，全部 CI 绿或本地 verify 全绿）

- **P13-01 发布核心**：publications 表（幂等键四元组唯一索引 platform+account+projectVersion+outputAsset）；批准闸门（render_approvals + manifestHash 对账，漂移 409 NOT_APPROVED）；reconcile 以 Provider getStatus 为准**不重发**；能力闸门投递方式感知；client.publications.{request,list,get,reconcile}。
- **P13-02 YouTube**：providers/youtube 包（YoutubeApiClient seam：RealYoutubeClient 官方 API v3 代码就位但**真实远端 BLOCKED OAuth 凭据** + MockYoutubeClient 故障重放 timeout_after_upload）；**超时恢复不重复创建**三层（核心唯一索引 / publish 前幂等键标签回查 / reconcile 采纳）；AIGC 披露逐字 + alteredContent；契约 additive `findByPublicationKey?`。
- **P13-03 平台矩阵**：PLATFORM_CAPABILITY_MATRIX 数据驱动（TikTok=P1/抖音=P4/Bilibili=P2/LinkedIn=P2/X=P4，全标注 UNVERIFIED_CREDENTIALS_REQUIRED——**平台实测 BLOCKED 账号凭据**）；PlatformStubProvider 生效能力=声明∩已核验=空 → 闸门 422 CAPABILITY_MISSING（tier 透出，UI 与真实 capability 一致）。
- **P13-04 P3/P4 体验**：deliveryMode（PUBLISH|DRAFT——Draft 状态 publishedAt 恒 null **不显示为 Published** + transferInstructions）；P4 导出包（export_packages 表；矩阵声明 EXPORT_PACKAGE 才可打包；批准闸门与发布同源；PLATFORM_EXPORT_CHECKLISTS 数据驱动、**末步=由用户完成 finalStepByUser=true**）；能力闸门模式感知（DRAFT→UPLOAD_DRAFT）。
- **P13-05 Handoff**：handoffs 表；创建（Artifact 逐个校验真实归属 422）/claim（**过期 410 HANDOFF_EXPIRED**（isExpired 读取时计算）；并发领取条件更新；REVOKED/COMPLETED 409）/cancel（可撤销）/get/list（**跨租户 404 反枚举**）；TTL 上限 7 天；claim 端点为 P15-06 移动端预留。
- **P13-06 CMS 输入**：cms_ingestions 表（**事件幂等唯一索引 workspace+source+externalId+contentHash**）；ingestCmsEvent（contentHash=内容字节 sha256——URL 先抓取再哈希；重放 deduped 不重复建项目；**正文变化 → 同项目新 ContentDocument 新来源版本（旧版本保留）**；机器路径复用人工链路 P04-01 URL 抓取/P10-01 HTML 导入；并发重放 onConflictDoNothing 兜底）；client.cms.{ingest,list}。
- **P13-07 CMS 回写（P13 收尾）**：Render QA→READY 同事务创建 delivery/首 attempt/SYSTEM Job；固定事件表示等待人工批准；HMAC-SHA256 `timestamp.rawBody`；Secret 密文且只回掩码；原生 HTTP Sender 在 DNS 全解析后拒绝私网/保留地址并固定 IP 连接；最多四次自动发送；3xx/其余 4xx/SSRF 最终失败；崩溃旧 PENDING→UNKNOWN；自动/人工重发复用 deliveryId/occurredAt/规范正文；失败不改 Render；API/SDK 与跨租户 404。证据：docs/verification/P13-07.md。

## 4c. 用户验收暂停门槛（2026-10-07）

- 继续推进 P14-01—P14-05，直到 Web 端计划全部 VERIFIED。
- P14 全部完成后立即暂停，让用户检查和测试。
- 未收到用户明确验收确认前，禁止开始 P15（Desktop/Mobile）或 P16（Marketplace/Enterprise）。

## 4d. P14 已完成任务摘要（2026-10-07）

- **P14-01 数据采集**：Publication analytics collect/list；采样区间/粒度/时区/来源落库；缺失指标保持 null；授权撤销时在 Provider 调用前停止；Web 显示未知而非 0。
- **P14-02 Scene 归因**：只读取发布时不可变 ProjectVersion Graph；留存点按 Scene 左闭右开时间窗聚合；派生行保存方法和样本数，固定 CORRELATION_ONLY。
- **P14-03 学习建议**：节奏/Scene 类型/Avatar 比例三类解释性建议；可查看/接受/禁用/恢复；channelMutationApplied 固定 false，Channel Style 不被静默修改。
- **P14-04 Finance Pack**：Candle/Yield Curve/Policy Path/Supply Chain/Trade Route/Scenario Tree 六类结构化产物；单位/币种/时区/调整口径/来源强制可追溯；缺失值 422 fail closed。
- **P14-05 数据与模板**：许可来源、事务串行的模板版本、产物内嵌来源许可证和模板快照；创建 v2 不改变历史 v1 产物。Web 完成来源/模板/产物操作面。
- **证据**：docs/verification/P14-01.md—P14-05.md；pnpm verify 14 步全绿，810 项真实断言；GitHub CI run 37611980360 全绿；最新迁移 0050。
- **外部边界**：Analytics 使用脚本化 Provider，真实平台 OAuth 核验仍需凭据；Finance 使用 fixture 与许可元数据，没有冒充真实收费数据源实测。
- **当前门槛**：P14 5/5 已完成，立即暂停。等待用户检查 Web 与测试；明确确认后才可选择 P15-01。

## 5. 本仓库工作模式与已踩过的坑（新会话必读）

**流程纪律**
- 每任务完成定义 = `pnpm verify`（14 步）全绿 + verification/handoff 文档 + `docs/requirements/traceability.md` 状态列与文末 changelog 更新 + 提交推送 + `gh run list` 确认 CI 绿（约 13–15 分钟）。
- 提交信息格式：`feat(pXX-YY): 中文标题（关键验收点）` + 正文要点列表。
- **禁止**：Mock 冒充真实核验、虚构数值、伪造提取成功、Secret 入库（测试假密钥行尾加 `// secrets:check-ignore：测试专用假密钥`）。

**技术坑（本会话实际踩过并已修复，警惕复发）**
1. **Bash 内联 `node -e` 含反引号模板字符串会被 shell 吞掉 `${...}`**（本会话发生 4+ 次）——**一律用 Write 工具写 `.mjs` 补丁文件再 `node file.mjs`**，或用 Edit 工具。
2. **vitest alias**：新增 `packages/providers/*` 包必须加进 `vitest.config.ts` 的 `workspaceAliases`（否则测试解析陈旧 dist——已补 mock-payments/malware-heuristic/document-extract；render 项目也已加 alias）。
3. **Remotion/render 测试的 dist 陈旧**：改了 packages 源码后跑 render 前先 `pnpm --filter <pkgs> run build`（CI 的 verify 顺序天然保证；本地注意）。
4. **zod v4 `.default({})` 不解析内部默认值**——对象字段默认值必须写完整显式对象。
5. **drizzle `sql\`\`` 内插列对象渲染为未限定列名**——相关子查询必须写显式限定名（`wm.user_id = "user".id`），否则计数恒 0。
6. **drizzle 0.45 错误包装**：唯一冲突判定用 `@ancs/db` 的 `isUniqueViolation(error)`（解包 cause），不要直接读 `error.code`。
7. **SDK `Headers` 实例不能展开**（`{...headers}` 得到空对象）——用 `headers.set()`。
8. **bash 工作目录会在调用间漂移**——每个脚本前显式 `cd /e/Codes/ANCS`；多替换 python 脚本必须**最后才写文件**（中途 assert 失败 = 文件未写，勿假设部分生效）。
9. **zod default 字段的 SDK 类型**：`z.infer` 输出类型必填——客户端入参用 `z.input`（如 PublicationRequestInput/CreateExportPackageRequestInput），SDK 方法签名用 Input 类型。
10. **只 throw 的 async 方法推断 Promise<void>**（非 never）——实现接口时必须显式注解返回类型；**410 等非标准状态**复用 `ERROR_CODES.PRECONDITION_FAILED` + status 参数区分。
11. **catch 回调内丢失类型窄化**（如 `input.content.url`）——窄化值先提取为局部变量再进回调。
12. **本机渲染集成测试贴近超时线**（110–115s，高负载下曾越线级联 26 失败）——**不得放宽阈值**（AGENTS.md）；静置后复跑即绿；CI runner 稳定，以 CI 为准。
8. **二进制端点必须显式 `bodyLimit`**（Fastify 默认 1MiB）：存储 64MB、文档导入 25MB。
8a. **SDK 编辑后必须 `pnpm install`** 刷新 apps/api 的注入拷贝（workspace 拷贝非符号链接——不刷新则 typecheck 读旧类型）。
8b. **SDK 防重复守卫陷阱**：向 client.ts 插接口+实现分两步时，接口含 `xxx: {` 会使实现的 `includes` 守卫误判已存在——实现需单独 Edit 插入。
9. **新迁移流程**：改 `packages/db/src/schema/*` → `cd packages/db && pnpm run db:generate` → 检查 SQL → typecheck。
10. 迁移文件命名随机；提交前确认 `_journal.json` 与 snapshot 一致并入库。

**常用命令**
```bash
pnpm verify                                   # 14 步全链路
pnpm vitest run --project integration apps/api/src/<x>.integration.test.ts
pnpm vitest run --project unit|web|render ...
gh run list --limit 3                         # CI 状态
docker ps | grep ancs                         # 本地 DB/Redis（55432）
```

## 6. 交接时仓库状态

- P14-01—05 完成后应保持工作树干净；当前没有可自动开始的任务。
- 若新会话发现未提交变更：为上一会话中断的部分实现——先 `git status`/`git diff` 评估，按 §4 的任务定义继续或干净丢弃（勿盲目提交）。
- `.artifacts/` 为 gitignore 的本地产物目录（渲染 PNG/测试存储），可随时清理。

— 交接完毕。当前必须暂停，等待用户检查测试；未经用户明确确认不得开始 P15 或 P16。
