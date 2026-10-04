# 0008 Custom Motion 生成、门禁与渲染边界

- **日期**：2026-10-05
- **状态**：已生效（P07-02 立项时产出）
- **关联**：计划 §8 P07-02（"生成独立组件，执行类型检查、静态检查、抽帧和渲染测试 | 失败不能进入项目；通过后保存代码、依赖、输入和产物版本"）；规范 §11.2（Generative Motion Engine + 安全 MUST 10 条）、§75 第 15 条；REQ-11-02、REQ-11-03、REQ-43-05

## 问题

"Motion Designer Agent 生成独立 Scene"在 V1 落地时有三个必须裁决的边界：

1. **代码契约**：生成代码在沙箱（P07-01：vm 白名单上下文）里怎么跑，与"白名单依赖"（§11.2-3）怎么统一？
2. **门禁组合**：类型检查/静态检查/抽帧/渲染测试如何串联、拒绝路径如何保证"不进入项目"？
3. **成片渲染**：CUSTOM_MOTION 场景在 Final 合成里由谁执行——render-worker（R8 白名单：只允许验证过的组件）如何承接？

## 裁决

1. **沙箱代码契约 = 零依赖 + registerMotion + 注入全局**：生成代码是**纯 JS 脚本**（无 JSX/无 import/无 TS 类型），
   顶层调用 `registerMotion({ name, component })`，组件仅可使用注入全局（React/hooks/确定性 remotion 语义/
   Math/JSON 等）。"白名单依赖"（§11.2-3）在 V1 的落点 = `MOTION_DEPENDENCY_WHITELIST` **空集**：依赖一律为注入全局，
   模块加载词法由静态分析（宿主 + 子进程双重）直接拒绝。提示词（`MOTION_PROMPT_VERSION`）以该契约为权威描述。
2. **四道门禁（顺序固定；任一失败即拒绝）**：
   1) 静态分析（词法，24 模式，双执行）；
   2) **类型检查**（tsc 编译器 API + 内存虚拟文件系统：**不落盘、不执行**；`checkJs` + `strict:false`——
      生成代码无 JSDoc，开 noImplicitAny 会因"参数隐式 any"误杀；仍检查名称解析/arity/显式类型不符）；
   3) 沙箱评估（隔离子进程 + vm 白名单上下文 + 硬超时 SIGKILL + RAM 上限）；
   4) **抽帧**（多帧渲染 smoke：首/中/末帧，逐帧 markup 哈希——确定性、可复算的证据）。
   门禁报告含 `sourceSha256`，落库前由 domain **逐字节复核**（杜绝"验 A 存 B"）。
3. **"失败不能进入项目" = 落库门禁**：仅 APPROVED 写 `custom_motion_components/versions` 与存储对象
   （`source.js` + `frames.json`）；拒绝**不产生任何行/对象**，细节留在任务错误（job.error.report，FAILED_FINAL，
   不自动重试——确定性失败，用户可再次发起生成以取新样本）。
4. **成片渲染边界（V1 诚实口径）**：Custom Motion 的**像素级成片合成**（网络阻断的浏览器渲染进程 / gVisor 容器）
   属部署层（P08-01/P08-02 按计划 §3.1 落地）——V1 的 Final 渲染管线**不执行**生成代码（R8 白名单与 §11.2-1 的一致性），
   CUSTOM_MOTION 场景在成片中呈现明确的"组件未注册"占位（不静默冒充）；生成阶段的抽帧为 markup 级（非像素栅格化）。
   生成产物（代码/依赖/输入/抽帧证据）可审计、可复验，作为"进入项目"的组件版本供后续任务/UI 消费。
5. **验证器 seam**：契约层定义 `MotionValidator`（domain/worker 只依赖接口）；实现 = apps/motion-worker
   （`validateMotion`）+ 生产装配的**进程隔离 CLI**（spawn `run-validate.ts`，`ANCS_MOTION_VALIDATOR_CMD` 可覆盖）——
   与渲染执行器（决策 0007）同一范式：验证崩溃不拖垮 Worker，任务租约回收可续跑。

## 实施

- `packages/contracts/src/custom-motion.ts`（草稿/报告/fixture/组件版本/`MotionValidator`）+ `MOTION_GENERATE_JOB_TYPE`；
- 迁移 0024（`custom_motion_components` + `custom_motion_components_versions`，append-only）；
- `packages/domain/src/custom-motion.ts`（提示词/解析/依赖校验/fixture/入队/生成执行/读取）；
- `apps/motion-worker/src/{typecheck.ts,validator.ts,limits.ts,run-validate.ts}` + 沙箱多帧抽帧扩展；
- `apps/worker/src/{motion-handler.ts,motion-validator-process.ts}` + 注册表/主循环装配；
- API/SDK：`POST /projects/:projectId/scenes/:sceneId/custom-motion`、`GET .../custom-motion[/:componentId]`；
  SDK `customMotion.start/list/get`。

## 验收关联

- REQ-11-02（生成链路 + CUSTOM_MOTION 场景约束）；REQ-11-03（十条安全 MUST 的可执行门禁）；
- REQ-43-05 / LED-C-SEC-06（Custom Motion 沙箱安全）；P07-02 验收两条
  （"失败不能进入项目"= 拒绝路径零行零对象；"通过后保存代码、依赖、输入和产物版本"= APPROVED 版本化落库 + 存储）。
- 证据：`docs/verification/P07-02.md`。
