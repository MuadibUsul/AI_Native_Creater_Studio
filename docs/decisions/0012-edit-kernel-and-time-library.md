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

## 迁移范围（M1 第一批）

`insert_clip`、`delete_clip`、`split_clip`、`trim_clip`、`move_clip`、`duplicate_clip`、`replace_clip_source`。其余时间线操作（slip/slide/roll/ripple/split_av_cut、轨道、变换、字幕、音频）按 M1 后续批次迁移；迁移前仍由 `edits.ts` 处理。

## 行为差异（刻意且记录在案）

- INSERT/OVERWRITE 切开既有片段时，右段现在**继承**原片段的 `parameters`（变换/裁切/透明度）。旧实现遗漏该字段，导致右段丢失变换；`split_clip` 一直是继承的，现统一。
- 同一操作内受影响片段的处理顺序改为按序列起点排序（旧实现依赖数据库返回顺序，不确定）。

## 已知缺口（不在本裁决内修复）

- 编辑边界尚未强制对齐输出帧（v0.4 §12.3 要求"序列片段边界按输出帧对齐"）；现有规则只要求时间可在序列时基中精确表示。待内核迁移完成后作为独立规则加入（需评估对既有项目的影响）。

## 回滚

`git revert` 对应提交即可恢复 `edits.ts` 内联实现；`@ancs/time` 转出口不影响调用方。
