# 0013 操作日志权威、组合投影器、引用图与旧 Scene 写入口收口

- 状态：生效（2026-10-11，V5-M2）
- 前一裁决编号：`0012-edit-kernel-and-time-library.md`
- 来源：`docs/V05/ANCS_v0.5_Architecture.md` §6.2—§6.5、§9、§14.1—§14.2、§20 M2（V5 文档 §21 中的 ADR 0012/0013/0020 在本仓库合并为本裁决）

## 决定

1. **操作日志是组合状态的权威**（迁移 `0087_op_log_reference_edges`）。`project_op_log` 每个被接受的写批次一行：
   - `position` 在项目内从 1 连续递增，唯一键 `(project_id, position)` 即线性化保证；
   - 编辑（`EDIT`）、补偿（`COMPENSATION`）、直接写入（`DIRECT`）的 `revision` = 写入后项目 revision，部分唯一索引 `(project_id, revision)` 让并发写在数据库层也只能有一个成功；
   - `changes` 为物化变更（`put` 完整行 / `delete` id），按位置折叠即可重建全部组合投影表；`operations` 记录请求的语义操作（审计与将来的内核重放），重建不依赖它；
   - 首行 `BASELINE`：日志启用前已存在的组合状态，在该项目第一次写入时于同一事务内惰性补齐；
   - 旧项目迁移（`MIGRATION`）每个已提交步骤一行，不改变 revision（旧版场景图与其摘要保持不变）。
2. **组合投影器是投影表的唯一写入方**：`packages/domain/src/composition-projector.ts`。序列、轨道、片段、视觉对象、效果、动画、字幕、音频区域、对象锁、操作日志与引用边只能经它写入；内核持久化、`update_animation`、版本恢复、对象锁、直接创建 API 与旧项目迁移全部改走投影器。arch-check **R11** 在 `apps/**`、`packages/**` 非测试源码中强制此规则（Drizzle 与原生 SQL 两种写法）。
3. **投影可重建**：`verifyCompositionProjection`（只读，REPEATABLE READ 快照）逐行比较日志折叠结果与投影表；`rebuildCompositionProjection` 以日志为准只修有差异的行，不追加日志、不整表清空（选区锚点等外部表对序列有级联外键）。
4. **引用图**：`reference_edges` 由投影器随日志维护（当前为片段 → 素材版本）。对象删除或改指向时关闭边（`closed_position`），不删除边。迁移回填既有片段引用（`opened_position = 0`）。资产清理把**当前与历史**引用边都视为引用：撤销/恢复可以让历史引用重新生效，资产在其项目存续期间不得被硬删；项目硬删时边随项目级联删除。原有的场景绑定、当前片段、版本快照与派生边检查保留为纵深防御。
5. **试改引擎**（`packages/domain/src/edit-trial.ts`）：全部为内核操作的批次在一致性快照上**内存**执行（不写库、不取项目行锁，与正式编辑互不阻塞）；含 Scene、对象锁、动画、版本恢复等非内核操作时退回"事务内执行再回滚"。两条路径对同一批内核操作产出相同的事件序列、revision、逐字节相同的片段行（jsonb 键顺序按 PostgreSQL 规则归一）与三轴指纹，错误也相同。提案试改（N06-01/02/04）、rebase 验证（N06-03）、已确认内容保护（N06-07）与 A/B 对照（N06-08）共用该引擎。
6. **旧 Scene 写入口**：`LEGACY_SCENE_WRITE_OPERATIONS`（`@ancs/contracts`，由操作注册表的写集派生）列出写 Scene/场景顺序的 9 个操作。项目切换到组合权威（`authorityMode = COMPOSITION`）后只拒绝这些操作；组合编辑与整项目版本恢复照常可用。

## 行为差异（刻意且记录在案）

- 直接创建 API（`createSequence/Track/Clip`、`createVisualObject/EffectInstance/AnimationBinding/CaptionSpan/AudioRegion`、`repositionVisualObject`）现在锁项目行、在单事务内写入并使项目 revision +1（旧实现不加锁、不推进 revision：基于 revision 的试改缓存可能返回过期结果）。它们不产生编辑事件（不可撤销），只在 HTTP 之外作为构造型 API 使用。
- **缺陷修复**：切换到组合权威后，旧实现拒绝**全部**编辑（包括组合操作），已迁移项目完全无法编辑；现只拒绝写 Scene 的操作。
- **缺陷修复**：`delete_track` 只检查片段，轨道上的字幕/音频区域/视觉对象由数据库外键级联静默删除且撤销无法恢复；现内核把它们计入，存在即 409 `TRACK_NOT_EMPTY`（`objectCount`），`MOVE_CLIPS` 只迁移片段。
- **缺陷修复**：A/B 对照把任何错误（含数据库故障）都包装为 422；现与提案试改同一分类（只有业务拒绝 → 422，其余原样抛出）。
- 事务内的串行查询：快照构建与组合列表在事务连接上用 `inOrder` 顺序执行，替代 `Promise.all`（pg 在同一连接上并发查询已弃用，pg@9 移除）。

## 未纳入（明确的后续工作）

- **旧 Scene 写入口未清零**：未切换的项目仍可使用 Scene 操作。调用方：`apps/web/src/ui/LiteTimeline.tsx`、`apps/web/src/components/quiet-frame/workflow-director.tsx`、`delivery-assets.tsx`、`preview-harness.tsx`，`packages/domain/src/director.ts`、`projects.ts`（AI 导演与项目初始化插入场景）、`packages/providers/mock-llm`（模拟 AI 编辑），以及 `undo-redo.ts` 中这些操作的补偿路径。依赖：这些界面改用组合操作（需按 UI 交付规约走设计补全与浏览器验证）与旧项目批量迁移。接口：届时把 `assertLegacyProjectWriteAllowed` 的条件从"已切换"改为"总是"，并删除 Scene 写分支。
- **Scene 表不在日志中**：日志只覆盖组合状态；Scene 是待退役的兼容数据。
- **引用图范围**：目前只维护片段 → 素材版本。音频区域的 `sourceStreamId` 是不透明字符串（无外键），视觉对象无素材引用列；版本快照中的引用仍由子串检查兜底。扩展时在投影器 `referenceTargetsOf` 增加映射即可。
- **整批内核执行**：正式编辑仍按操作逐条"加载 → 内核 → 持久化"；内存整批执行目前只用于试改。正式路径改为整批内存执行 + 一次持久化属于性能优化，不改变语义。
- **日志压缩/快照点**：日志按项目无限增长；`project_doc_snapshots`（每 N 条折叠一次）与热缓存留待读路径改造。
