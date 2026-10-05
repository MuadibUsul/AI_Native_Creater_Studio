# 会话交接文档（Session Handoff）

- **交接时点**：2026-10-06（上一会话结束于 P10 全部完成；本会话因上下文满而交接）
- **仓库**：`E:\Codes\ANCS`（remote: `https://github.com/MuadibUsul/AI_Native_Creater_Studio.git`，branch main）
- **最后已推送提交**：`9b70d34` feat(p11-01) ContentCore —— CI 状态见 gh run list（推送于会话尾）
- **权威文档**：需求 `creator_video_os_spec_v0.2.md`；计划 `ANCS_Plan261004.md`；协作规则 `AGENTS.md`（**接手前必读并按其 §13.5 启动步骤执行**）

---

## 1. 总体进度

**104 项计划任务：61 项已交付（≈59%），全部有 `docs/verification/<taskId>.md` 证据 + `docs/handoffs/<taskId>.md` 交接 + RTM 更新，`pnpm verify` 14 步全绿。**

| 阶段 | 任务数 | 状态 |
|---|---|---|
| P00–P08（V1 内部生产） | 48 | ✅ 全部交付（P08-05 真实金样、P06-01/02/04/05 真实 Provider 核验 **BLOCKED 凭据**——代码/工具已就位） |
| P09（对外 SaaS 与商业运营） | 6 | ✅ 全部交付（真实 Stripe BLOCKED；P09-06 上线门机制交付，LG-01…14 人工台账全 BLOCKED） |
| P10（输入/声音/素材/组件/输出/检索） | 6 | ✅ 全部交付（真实克隆/素材/Runway BLOCKED 凭据——seam 与验收矩阵就位） |
| P11（Content Core 与官方 Pack） | 4 | P11-01 ✅（ContentCore 1:1 派生迁移，验证 756）；**P11-02 Atom/Recipe 为下一项**；P11-03/04 未开始 |
| P12–P16 | 40 | ⬜ 未开始 |

- 测试规模：**752**（unit 341 · web 70 · motion 19 · integration 279 · security 22 · render 6 · golden 15）
- 迁移最新编号：**0033**（voice_clone 三表）；下一迁移为 0034

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

## 4. P11-01 已完成（2026-10-06；commit 9b70d34）——下一任务：P11-02 Atom/Recipe

- **P11-01 交付摘要**：契约 content-core.ts + 迁移 0034（content_cores，project 唯一）+ domain（1:1 派生/facts=fact 子投影/relations 不推断/thesis 不编造/原文档零改动/inputsDigest 幂等）+ API/SDK（client.content.contentCore.{migrate,state}）+ 集成 4/4 + verify 756。详见 docs/verification/P11-01.md。
- **P11-02 设计要点**：Atom = 核心模型最小可复用单元（claim/fact/source-quote 级），**必须携带来源引用**（sourceIds/claimId）；Recipe = 渠道→结构映射（版本化）；Fit = 规则化评估（时长/结构/渠道约束），不合适 → **NOT_RECOMMENDED + 原因**（非报错）。已有基础：P11-01 核心模型 + Channel 版本化样式（P01-04）。
- **后续**：P11-03 官方 Pack（NOT_RECOMMENDED 通道）→ P11-03 官方 Pack（受限 PluginContext）→ P11-04 派生血缘 → P12（各 Pack）→ P13（发布）→ P14（运营/学习）→ P15（性能/规模）→ P16（合规收尾，含 Enterprise 隐私）。

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
8. **二进制端点必须显式 `bodyLimit`**（Fastify 默认 1MiB）：存储 64MB、文档导入 25MB。
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

- 工作树**干净**（全部已提交推送）；P11-01 已完成（9b70d34）。
- 若新会话发现未提交变更：为上一会话中断的部分实现——先 `git status`/`git diff` 评估，按 §4 的任务定义继续或干净丢弃（勿盲目提交）。
- `.artifacts/` 为 gitignore 的本地产物目录（渲染 PNG/测试存储），可随时清理。

— 交接完毕。接手后从 **§4 P11-01** 开始，按 AGENTS.md 启动步骤先复核本文件与最新 `docs/handoffs/`。
