# 0017 FFmpeg 媒体图终渲染后端与播放/终渲染一致性套件

- 状态：生效（2026-10-11，V5-M4 第二部分 b）
- 前一裁决编号：`0016-render-plan-ir.md`
- 来源：`docs/V05/ANCS_v0.5_Architecture.md` §13（同一 IR 三个消费者、一致性套件）、§18（渲染一致性层）；v0.4 任务 N09-10（FFmpeg 媒体图）、N09-11（预览/终渲染逐能力对照）

## 背景

现有终渲染（`render-execution.ts` → Remotion）只服务 Article/Scene 流水线：输入是项目版本的 Scene 图与 Master Narration。纯素材工程（多轨片段、音频区域）没有任何导出路径，G0（N03-10）"真实导出"无从谈起；也没有任何测试证明预览与成片在时间映射上一致。

## 决定

1. **后端只消费 RenderPlan**：`apps/worker/src/render-plan/`。`compileFfmpegMediaGraph`（纯函数）把计划 + 档位 + 落盘源的流事实编译为 FFmpeg argv（`graphHash` = argv 的 SHA-256）；`createFfmpegRenderPlanExecutor` 负责探测、spawn、侧载字幕、Manifest 与逐文件哈希。执行器契约 `RenderPlanExecutor` 在 contracts，后端裁决经领域层取得内核的 `assertRenderPlanSupported`（R7：worker 不直接依赖内核）。
2. **帧选择 = 保持语义**（与浏览器 `<video>` 定位一致）：输出第 k 帧显示"源 PTS ≤ 映射源时刻"的最后一帧。实现：每段换到精确公共时基（`settb=1/L`，L 为源时基与偏移分母的最小公倍数）→ 平移到序列时间 → `fps=…:round=up` → 按**整数帧号** `trim=start_pts:end_pts`；基底画布与各段时间戳逐帧相同，不依赖 overlay 的跨帧率同步（原型实测 overlay 直接叠加会取到下一帧）。源末尾 `tpad` 克隆最后一帧；输入用 `-noaccurate_seek -ss <源入点向下取整> -copyts -start_at_zero`，保证"保持帧"一定被解码且时间戳为绝对源时间。
3. **几何与命中检测同一模型**：恒等变换时对象完整矩形 = 画布；裁切 → 缩放 → 绕锚点旋转 → 位移，与 `projectVisualPoint` 逐点一致（单测 ±1px）。
4. **音频语义写进 IR**（`RENDER_PLAN_AUDIO_RULES`）：等功率淡变（`afade curve=qsin`）、WebAudio StereoPanner 立体声声像公式（`stereoPanCoefficients`）、缺省单声道复制到双声道、显式 `channelMapping` 路由、各条目不归一化求和、按序列起点整数采样延迟。浏览器 baseline 的增益包络 `gainDbAt` 同步改为等功率（此前为"dB 线性"，与编辑契约 N03-06 的 in² + out² = 1 不一致）。
5. **字幕交付显式选择**：档位 `captionDelivery = SIDECAR`（缺省）输出 SRT/VTT（时间码只经 `mediaTimeToDisplayMilliseconds`），`requirementsForDelivery` 据此不要求烧录能力；`BURNED_IN` 本后端不支持 → 501（需要可复现的含 CJK 字体管线，属 N09-10 后续）。字幕文本**不进入** argv。
6. **能力声明**：`FFMPEG_MEDIA_GRAPH` 支持多层合成、逐段变换/裁切/透明度、增益/淡变/声像；不支持字幕烧录、图形组件、关键帧、变速、嵌套序列——这些需求一律 501 并列出全部缺失项。
7. **安全**：argv 只含数值生成的滤镜参数与执行器生成的相对文件名（`[A-Za-z0-9_.-]`）；每个输入都带 `-protocol_whitelist file,pipe`；子进程环境走 `childProcessEnv(MEDIA_CHILD_ENV)`；硬超时与输出上限；失败只回传有限诊断尾部。
8. **一致性套件（精简集，每次提交）** `apps/worker/src/render-plan-conformance.integration.test.ts`：真实 Postgres + 真实编辑流水线（`processEdits` 插入/变换）+ 真实 FFmpeg 编解码。金样源每帧编码"帧号 + 1"；期望值从 **baseline 播放快照**按保持语义计算，终渲染解码后**逐帧相等**（两层：全画幅 + 缩放 0.5 置于左上）；音频起点误差 ≤ 1 ms、等功率淡入中点增益误差 ≤ 0.5 dB、全左声像右声道静音；Manifest 与计划同一 planHash，产物哈希可复核；加入图形对象后显式 501。变异验证：`round=near` 与线性淡变（`curve=tri`）各使套件失败。

## 未纳入（后续）

- Remotion 图形层（alpha 输出、与媒体图统一编码）、字幕烧录：N09-10 后续。
- 终渲染工作流（冻结 → 计划 → 执行 → 产物入库 → 技术 QA → 交付）、渲染记录与 API：M4-3（与工作流引擎一起）。
- 真实浏览器呈现侧对照（同一计划在 Chromium baseline 播放器中实际呈现帧）：N09-11 / N03-16 后续；本套件对照的是 baseline **投影**。
- 变速/倒放（`TIME_REMAP`）与大量段的分区执行（每段一个输入会占用多个解码器）：分段执行随 M4-3 FinalRender 工作流。
- 画幅不一致时恒等变换会拉伸源（与命中检测模型一致）；是否引入 fit/fill 策略属产品决策。
