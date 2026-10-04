# 0006 Preview 时序共享与 packages/remotion-core

- **日期**：2026-10-04
- **状态**：已生效（P05-04 立项时产出；补充裁决 0005）
- **关联**：计划 §3.3（packages/remotion-core：Composition、时序、混音、字幕）、§3.4（依赖方向）、§8 P05-04（验收：修改标准场景可更新预览；编辑不会隐式触发昂贵视频调用）；规范 §5.2（毫秒 → frame：绝对边界、禁止逐段累加四舍五入）、§12（Preview）、§59（Remotion 使用规范：按帧确定性、禁止在组件内访问网络/凭据）；REQ-49-02（arch:check）、REQ-5-03、REQ-66-01

## 问题

P05-04 的 Remotion Player 预览与 P07 的成片渲染**必须共用同一套时序映射**（规范 §5.2 的漂移禁令；
"预览与渲染两套时序"会导致预览与成片不一致）。此外 Web 端需要 Composition 组件把 Scene Graph
映射为可播放的时间轴。需要决定代码落点与依赖边界。

## 裁决

1. **新建 `packages/remotion-core`**（计划 §3.3 既定布局，此时建立避免重复实现）：
   - `timeline.ts`：**纯函数**时序（ms → frame 的**绝对边界**换算；scene frame 数 = 结束帧 − 开始帧；
     总帧数按项目时间轴末端绝对换算；禁止逐段独立四舍五入后累加）；
   - `VideoComposition.tsx`：Scene Graph → 按帧渲染的场景序列（组件来自 `@ancs/scene-components`；
     媒体素材经 `resolveAssetUrl` 注入，缺失时组件自身的占位生效——**明确标识的 Draft 占位**）；
   - 该包只依赖 `react`、`remotion`、`@ancs/contracts`、`@ancs/scene-components`；**不访问网络/凭据/时钟**
     （§59）；预览（web Player）与成片（render-worker）共用它。
2. **R5 扩展**：`apps/web|desktop|mobile` 生产 workspace 依赖增加 `@ancs/remotion-core`
   （理由同 0005：渲染/预览单一来源；R8 已允许 render-worker 使用该包）。
3. **"编辑不隐式触发昂贵调用"作为**架构约束**落到组件依赖面：Web 预览层可用的 SDK 命名空间
   仅限只读查询与编辑协议（projects/graph/assets 读取）；**任何生成/计费/任务方法（jobs、billing、
   providerConnections、generations）不得出现在预览路径**——测试以"仅暴露所需命名空间的脚本化客户端 +
   调用清单断言"证明（未暴露命名空间被访问即抛错）。
4. 音频/字幕/混音（§3.3 的 remotion-core 其余职责）本任务不实现，保留在 P06-03（Audio-First 对齐）
   与 P07（成片合成）落地；本裁决只冻结包与依赖边。

## 实施

- `packages/remotion-core`（timeline 测试在 unit；Composition 在 web 项目 jsdom 测试）；
- arch-check R5 允许集与规则测试更新；
- Storyboard 页顶部集成 Remotion Player（预览 = Preview），保持"Scenes 列表 + Ask Director"布局（REQ-5-03）。

## 验收关联

- REQ-5-03（Preview + Ask Director + Scenes 默认布局）；REQ-66-01（每 4～12 秒视觉变化——由组件与
  Director 策略保证，预览如实呈现）；P05-04 验收两条；§5.2 无累计漂移（timeline 单测）。
