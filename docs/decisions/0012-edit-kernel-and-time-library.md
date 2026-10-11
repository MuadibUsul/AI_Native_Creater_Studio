# 0012 编辑内核与唯一时间库的包边界

- 状态：生效（2026-10-11，V5-M1）
- 前一裁决编号：`0011-v5-architecture-adoption.md`
- 来源：`docs/V05/ANCS_v0.5_Architecture.md` §4、§5.2、§6、§7

## 决定

1. 新增 `packages/time`（`@ancs/time`）：唯一有理时间库。`packages/contracts/src/common/media-time.ts` 改为转出口，`@ancs/contracts` 对外 API 不变。精确运算（`MediaTime`、`Fraction`、`exactTicks`）与显示换算（`mediaTimeToDisplay*`）都只在此实现。
2. 新增 `packages/kernel`（`@ancs/kernel`）：编辑内核。纯函数 `applyTimelineOperation(state, operation, ctx)` 返回有序写入与事件草稿；`packages/domain/src/kernel-timeline.ts` 负责加载状态与持久化，领域层不再包含已迁移操作的编辑规则。
3. arch-check 新增：
   - **R9**：`packages/kernel` 的 workspace 依赖只允许 `@ancs/contracts`、`@ancs/time`；`packages/time` 不得依赖任何 workspace 包；二者加入平台中立包（R3）。
   - **R10**：二者非测试源码不得导入 `node:*`、`@ancs/db`、`drizzle-orm`，不得使用 `process`、`fetch`、`Date.now()`、`new Date()`、`Math.random()`。ID 与时间由调用方注入，保证同输入同输出。
4. 内核错误使用 `@ancs/contracts` 的 `ApiFailure`（与服务端统一错误信封同一错误码与 `reason`），使服务端与将来的客户端乐观预览得到同一领域错误（V5 §6.1）。

## 迁移范围（M1 完成）

28 个时间线操作的全部规则已迁入内核：

- 片段原语：`insert_clip`、`delete_clip`、`split_clip`、`trim_clip`、`move_clip`、`duplicate_clip`、`replace_clip_source`
- 精剪：`slip_clip`、`slide_clip`、`roll_clip`、`ripple_clip`、`split_av_cut`
- 轨道：`create_track`、`move_track`、`delete_track`、`update_track`
- 片段参数与关联：`set_clip_transform`、`set_clip_crop`、`set_clip_opacity`、`set_av_link`、`update_clip`
- 字幕：`create_caption`、`update_caption`、`split_caption`、`cut_caption_range`、`delete_caption`
- 音频：`apply_audio_crossfade`、`update_audio_region`

仍在 `edits.ts` 的：旧 Scene 语义操作、`update_animation`（依赖视觉对象目标校验）、`restore_scene` / `restore_project_version` / `replace_asset`——随 M2（旧写入口关闭、操作日志权威）处理。

## 内核结果的形状

- 内核状态是**整个项目**的时间线（全部序列/轨道/片段/音频区域/字幕 + 对象锁 + 源事实 + 制作策略），查找语义与旧实现的查询条件一一对应（项目范围 vs 同序列），保证错误码不变。
- 结果分为**写入列表**与**事件列表**：事件顺序是撤销/重做的语义顺序，可与写入顺序不同（例如 `create_track` 先插入新轨，再记被让位轨道的事件，最后记 `CREATE_TRACK`）。事件以 `snapshots`（键 → 实体）描述 before/after/createdCaption 等快照，由领域层渲染为与旧实现同形的 patch。
- 轨道位置的唯一索引由持久化层两阶段落位处理（先移出、再落位），内核只给出最终位置。

## 行为差异（刻意且记录在案）

- INSERT/OVERWRITE 切开既有片段时，右段现在**继承**原片段的 `parameters`（变换/裁切/透明度）。旧实现遗漏该字段，导致右段丢失变换；`split_clip` 一直是继承的，现统一。
- 同一操作内受影响片段/轨道的处理顺序改为确定性排序（按序列起点或轨道位置；旧实现依赖数据库返回顺序）。
- **缺陷修复**：`update_track` 改 `position` 时旧实现漏写目标轨位置，与兄弟轨的唯一索引冲突（500）；现按 `move_track` 语义整体重排，目标轨与让位轨各记一条 `UPDATE_TRACK`，可逐条撤销。
- **缺陷修复**：`cut_caption_range` 的 CUT_CONTENT 收缝旧实现不检查锁，会改写锁定轨道/锁定对象；现在任何写入前预检：受影响对象所在轨道被锁 → 409 `TRACK_LOCKED`，平移对象锁住 POSITION、被剪对象锁住 CONTENT/DURATION/POSITION → 409 `EDIT_IMPACT_LOCKED`。

## 已知缺口（不在本裁决内修复）

- 编辑边界尚未强制对齐输出帧（v0.4 §12.3 要求"序列片段边界按输出帧对齐"）；现有规则只要求时间可在序列时基中精确表示。待内核迁移完成后作为独立规则加入（需评估对既有项目的影响）。

## 回滚

`git revert` 对应提交即可恢复 `edits.ts` 内联实现；`@ancs/time` 转出口不影响调用方。
