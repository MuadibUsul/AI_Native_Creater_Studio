# 0007 Final 合成执行边界（渲染执行器 seam 与 FFmpeg 口径）

- **日期**：2026-10-05
- **状态**：已生效（P07-04 立项时产出）
- **关联**：计划 §3.4（依赖方向）、§8 P07-04（"Remotion 服务端渲染、FFmpeg 最终处理，生成 MP4/SRT/VTT/Manifest"）；规范 §28（Manifest）、§39（Rendering：Server render = Render Worker；后处理 FFmpeg）、§58（字幕 burn-in 可选）、§59（音频叠加）、§86（QA 前置于发布）；REQ-28-01、REQ-39-01、REQ-49-02（arch:check）

## 问题

P07-04 需要把"冻结快照（P07-03）"变成成片产物，但存在三个边界问题：

1. **渲染栈落点**：Remotion/@remotion/renderer/React 不能被 domain（平台中立，R3）或 API 依赖；
   render-worker（R8 白名单：contracts/scene-schema/scene-components/remotion-core）又不能触数据库/存储。
2. **编排落点**：谁负责"读快照 → 落素材 → 调渲染 → 产物入库 → QA 迁移"？谁负责进程隔离与恢复语义？
3. **FFmpeg 口径**："FFmpeg 最终处理"在 V1 采用什么形态——独立 ffmpeg 二进制后处理，还是 Remotion 内置管线？

## 裁决

1. **渲染执行 = 接口 seam**：契约层定义 `RenderExecutor`（`packages/contracts/src/render-execution.ts`），
   输入 `{ renderId, spec, workDir }`（`<workDir>/spec.json` 进、`<workDir>/out/*` 出），不触数据库/凭据。
   - **实现（真实渲染）**：`apps/render-worker`（`executor.ts` + `run-render.ts` CLI + `FinalComposition`——
     画面与预览共用 remotion-core `VideoComposition`/`timelineOf`）；
   - **编排（业务流）**：`packages/domain/src/render-execution.ts`（纯投影构建 spec + 冻结素材落工作目录
     + 产物 sha256 复核 + 入库 + QA 迁移）——domain 只依赖 `RenderExecutor` 接口，不依赖渲染栈；
   - **调度（任务化）**：`apps/worker` 注册 `RENDER_FINAL` 处理器；生产装配为**进程隔离执行器**
     （spawn `run-render.ts`，硬超时 SIGKILL；`ANCS_RENDER_EXECUTOR_CMD` 可覆盖）——渲染崩溃不拖垮 Worker，
     任务租约回收可续跑一次（`maxAttempts=2`），执行失败显式定性 `FAILED_FINAL`（不允许无限自动重试）。
2. **素材同源服务**：编排层把冻结对象（存储取回）落工作目录，执行器复制进 Remotion bundle 的静态目录，
   组件只消费相对 URL（`/assets/<fileName>`）——**组件不访问网络/凭据**（§59），且与 P07-03"只引用不可变版本"一致。
3. **FFmpeg 口径（V1）**：成片编码/封装/音轨复用使用 **Remotion 渲染管线内置 FFmpeg**（h264 + aac）；
   **独立 ffmpeg 后处理**（码率档位策略、多平台转码、字幕外挂/烧录切换的批量处理）不在 V1 交付，
   留待 P08（部署/性能/运维口径）评估引入——本口径在 P07-04 验证与交接中已明确记录（诚实记录，不冒充已实现）。
4. **Manifest 哈希口径**：`manifest_hash` = **manifest.json 文件的 SHA-256**（字节级），编排层在入库前
   重算复核（不一致 → 拒绝入 QA）。避免 canonical JSON 歧义；QA/P07-06 以字节复核"Manifest 与实际文件一致"。
5. **主题快照补强**：project_version 快照 meta 固化 `themeTokens`（P07-03 快照的 meta 为开放记录，属兼容扩展）——
   成片主题与快照时刻一致，渠道后续改主题不影响既有版本/在途渲染。

## 实施

- `packages/contracts/src/render-execution.ts`（spec/result/manifest/executor 接口 + `RENDER_FINAL` 任务类型）；
- `packages/domain/src/render-execution.ts`（builder/编排/入库）；`createRender` 同事务入队任务（`createJobInTx`）；
- `apps/render-worker/src/{FinalComposition.tsx,executor.ts,run-render.ts,root.tsx}`；
- `apps/worker/src/{render-handler.ts,render-executor-process.ts}` + 注册表/主循环装配；
- 无新增 arch-check 规则（R8 白名单已含 `@ancs/remotion-core`；worker 侧依赖均在 R7 允许集内）。

## 验收关联

- REQ-28-01（每次 Final Render 生成 manifest.json；hash=字节 SHA-256）；
- REQ-39-01（Server render = Render Worker；FFmpeg 形态见裁决 3）；REQ-39-02（输入=冻结快照；Job 化执行）；
- P07-04 验收两条（1920×1080、30fps、音轨和时长正确；产物全部进入存储）——证据 `docs/verification/P07-04.md`。
