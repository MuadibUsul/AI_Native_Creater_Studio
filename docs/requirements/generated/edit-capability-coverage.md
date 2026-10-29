# 编辑能力覆盖账本（生成物）

> **生成物，请勿手改。** 由 `pnpm capabilities:generate`（`scripts/capability-ledger.mjs`）从 `EDIT_OPERATION_V2_REGISTRY`、
> `EDIT_OPERATION_REGISTRY`、`KERNEL_TIMELINE_OPERATIONS` 与测试引用生成；`pnpm capabilities:check`（在 `pnpm verify` 中）校验一致性与原生声明规则。
> 原生（NATIVE）= 规范操作 ACTIVE + 编辑内核执行 + 至少一个内核单测与一个集成测试；别名与计划项不计为原生能力（V5 §10.1）。
> 金样测试列在 RenderPlan IR 与一致性套件（V5-M4）前统一为 PLANNED。

**汇总：** 源操作 44 个 —— NATIVE 24、COMPILED_ALIAS 9、PLANNED 11；编辑内核执行的规范操作 29 个。

| 源操作 | 解析 | 规范操作 | 执行方 | 内核单测 | 集成测试 | 金样 | 限制 | 负责任务 |
|---|---|---|---|---|---|---|---|---|
| `insert_clip` | NATIVE | `insert_clip` | KERNEL | 2 | 11 | PLANNED | — | — |
| `delete_clip` | NATIVE | `delete_clip` | KERNEL | 1 | 2 | PLANNED | — | — |
| `move_clip` | NATIVE | `move_clip` | KERNEL | 1 | 6 | PLANNED | — | — |
| `trim_clip` | NATIVE | `trim_clip` | KERNEL | 1 | 12 | PLANNED | — | — |
| `split_clip` | NATIVE | `split_clip` | KERNEL | 1 | 5 | PLANNED | — | — |
| `duplicate_clip` | NATIVE | `duplicate_clip` | KERNEL | 1 | 1 | PLANNED | — | — |
| `replace_clip_source` | NATIVE | `replace_clip_source` | KERNEL | 1 | 2 | PLANNED | — | — |
| `slip_clip` | NATIVE | `slip_clip` | KERNEL | 1 | 2 | PLANNED | — | — |
| `slide_clip` | NATIVE | `slide_clip` | KERNEL | 1 | 1 | PLANNED | — | — |
| `roll_clip` | NATIVE | `roll_clip` | KERNEL | 1 | 1 | PLANNED | — | — |
| `ripple_clip` | NATIVE | `ripple_clip` | KERNEL | 1 | 7 | PLANNED | — | — |
| `split_av_cut` | NATIVE | `split_av_cut` | KERNEL | 1 | 1 | PLANNED | — | — |
| `update_track` | NATIVE | `update_track` | KERNEL | 1 | 5 | PLANNED | — | — |
| `set_av_link` | NATIVE | `set_av_link` | KERNEL | 1 | 1 | PLANNED | — | — |
| `set_clip_transform` | NATIVE | `set_clip_transform` | KERNEL | 1 | 4 | PLANNED | — | — |
| `set_clip_crop` | NATIVE | `set_clip_crop` | KERNEL | 1 | 2 | PLANNED | — | — |
| `set_clip_opacity` | NATIVE | `set_clip_opacity` | KERNEL | 1 | 11 | PLANNED | — | — |
| `set_clip_speed` | COMPILED_ALIAS | `update_clip` | KERNEL | 1 | 3 | PLANNED | CONSTANT_LINEAR_REVERSE_ONLY | N11-02 |
| `add_effect` | PLANNED | — | — | 0 | 0 | PLANNED | NO_EXECUTABLE_HANDLER | N03-05 |
| `update_effect` | PLANNED | — | — | 0 | 0 | PLANNED | NO_EXECUTABLE_HANDLER | N03-05 |
| `remove_effect` | PLANNED | — | — | 0 | 0 | PLANNED | NO_EXECUTABLE_HANDLER | N03-05 |
| `add_keyframe` | COMPILED_ALIAS | `update_animation` | DOMAIN | 0 | 4 | PLANNED | LINEAR_AND_HOLD_INTERPOLATION_ONLY | N11-01 |
| `update_keyframe` | COMPILED_ALIAS | `update_animation` | DOMAIN | 0 | 4 | PLANNED | LINEAR_AND_HOLD_INTERPOLATION_ONLY | N11-01 |
| `remove_keyframe` | COMPILED_ALIAS | `update_animation` | DOMAIN | 0 | 4 | PLANNED | FINAL_KEYFRAME_REQUIRES_BINDING_REMOVAL | N11-01 |
| `create_track` | NATIVE | `create_track` | KERNEL | 2 | 3 | PLANNED | — | — |
| `move_track` | NATIVE | `move_track` | KERNEL | 1 | 1 | PLANNED | — | — |
| `delete_track` | NATIVE | `delete_track` | KERNEL | 1 | 2 | PLANNED | — | — |
| `set_sequence_duration` | NATIVE | `set_sequence_duration` | KERNEL | 1 | 3 | PLANNED | — | — |
| `set_audio_gain` | COMPILED_ALIAS | `update_audio_region` | KERNEL | 1 | 3 | PLANNED | — | — |
| `set_audio_fade` | COMPILED_ALIAS | `update_audio_region` | KERNEL | 1 | 3 | PLANNED | — | — |
| `set_audio_pan` | COMPILED_ALIAS | `update_audio_region` | KERNEL | 1 | 3 | PLANNED | — | — |
| `set_audio_automation` | COMPILED_ALIAS | `update_animation` | DOMAIN | 0 | 4 | PLANNED | EXISTING_AUTOMATION_BINDING_REQUIRED, LINEAR_AND_HOLD_INTERPOLATION_ONLY | N11-08 |
| `apply_audio_crossfade` | NATIVE | `apply_audio_crossfade` | KERNEL | 1 | 1 | PLANNED | — | — |
| `add_marker` | PLANNED | — | — | 0 | 0 | PLANNED | NO_EXECUTABLE_HANDLER | N03-09 |
| `update_marker` | PLANNED | — | — | 0 | 0 | PLANNED | NO_EXECUTABLE_HANDLER | N03-09 |
| `remove_marker` | PLANNED | — | — | 0 | 0 | PLANNED | NO_EXECUTABLE_HANDLER | N03-09 |
| `update_caption_segment` | COMPILED_ALIAS | `update_caption` | KERNEL | 0 | 3 | PLANNED | TEXT_AND_RANGE_ONLY | N11-13 |
| `cut_caption_range` | NATIVE | `cut_caption_range` | KERNEL | 1 | 1 | PLANNED | — | — |
| `split_caption` | NATIVE | `split_caption` | KERNEL | 1 | 1 | PLANNED | — | — |
| `regenerate_region` | PLANNED | — | — | 0 | 0 | PLANNED | NO_EXECUTABLE_HANDLER | N08-09 |
| `replace_region` | PLANNED | — | — | 0 | 0 | PLANNED | NO_EXECUTABLE_HANDLER | N08-09 |
| `create_preview_branch` | PLANNED | — | — | 0 | 0 | PLANNED | NO_EXECUTABLE_HANDLER | N06-10 |
| `commit_preview_branch` | PLANNED | — | — | 0 | 0 | PLANNED | NO_EXECUTABLE_HANDLER | N06-11 |
| `discard_preview_branch` | PLANNED | — | — | 0 | 0 | PLANNED | NO_EXECUTABLE_HANDLER | N06-10 |
