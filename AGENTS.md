# AGENTS.md — 代理协作规则

**唯一权威：`docs/V06/ANCS_v0.6_Product_Architecture.md`（V6，按里程碑 V6-0—V6-8 推进，裁决见 `docs/decisions/0018-v6-adoption.md`）。** V6 增量：裁决 `docs/decisions/0020-autonomous-production-adoption.md` 纳入自主制作模式（提案原文 `docs/V06/proposals/`，里程碑 V6-9—V6-11）；生产与商业化缺口见 `docs/V06/production-readiness-checklist.md`。 V7 增量：裁决 `docs/decisions/0022-v7-borrow-harness-mechanisms.md`（取代 0021 的运行时迁移）：Agent 运行时只有 ANCS 自己的循环，从 DeepSeek Harness 逐项借鉴具体机制（清单与记录在 `docs/V07/`，每项一个 `milestones/B<n>.md`）。借鉴不改变产品定义与工程权威（V6、ProjectDocument、操作日志、提案、内核、RenderPlan），冲突时以它们为准。 V5（`docs/V05/ANCS_v0.5_Architecture.md` 与裁决 0011—0017）的架构骨架继续有效；v0.4 文档（`docs/V04/`）是需求与交互细节的参考库，N 系列任务账本冻结为历史（`pnpm spec:check` 继续校验其一致性，不新增条目）。冲突优先级：项目所有者后续明确要求 → V6 → V5 架构裁决 → v0.4 需求参考 → 更早的规范。

任何模型接手前必须按顺序执行：

## 启动步骤

1. 通读 V6；按当前里程碑需要查阅 V4 的对应章节（共看片室 §4、共同注意力 §7、语音 §8、AI 导演 §9、提案 §10；鼠标点线面增量设计）。
2. 阅读生效裁决（`docs/decisions/`，0018 起为 V6 裁决）。
3. 检查仓库真实状态与最新里程碑记录（`docs/V06/milestones/`；历史交接见 `docs/handoffs/`）。
4. 按 V6 §11 的里程碑顺序推进：每个里程碑以可演示的用户体验收尾，后端只做该体验需要的部分；冻结范围（V6 §9.1）不主动扩展。
5. 检查相关代码与测试，不重复初始化已有工程。

## 实现规则

- 顺序（v0.4 §22）：contracts → migration → domain/service → API → SDK → UI → tests → docs。不涉及的层明确写"不适用"；禁止先在 UI 内实现权威规则再抽取。
- 用户可见功能必须经真实浏览器操作验证并截图目检（`docs/design/ui-delivery-contract.md` 的原则继续适用）；新界面一律中英双语（i18n），不新增硬编码单语文案。
- 无对应高保真稿时按当前 v0.4 设计系统和现有共享组件自行补齐，不等待新图，不用临时管理模板，不擅自重做本轮未影响的已确认界面。运营读面只显示已授权投影；有副作用的操作走 AdminAction 的预检、授权、执行、逐项结果和审计，不因按钮隐藏而放松服务端权限。
- 完成定义：只有 `VERIFIED` 计入完成；Mock 验证通过 ≠ 真实 Provider 验证通过；接口存在 ≠ 功能交付。
- 证据与交接：每个 V6 里程碑在 `docs/V06/milestones/<id>.md` 记录目标、验收、命令与结果、实测数据和交接；N 系列与旧 P 账本保持历史语义，不用新状态覆写。
- 历史账本一致性仍由 `pnpm spec:check`（在 `pnpm verify` 中）校验，不得改坏；V6 不再向其新增条目。
- V5 架构约束（逐阶段生效，见 V5 §4、§20）：编辑规则进入纯函数内核（禁止 I/O）；权威路径禁用毫秒/浮点秒，显示换算只用 `mediaTimeToDisplay*`；外部/付费调用只经工作流与 Provider Gateway；业务包不得读取 `process.env`；组合状态以操作日志为权威，组合表只能经 `packages/domain/src/composition-projector.ts` 写入（arch-check R11，裁决 0013）；业务包读取 `process.env` 由 arch-check R12 拦截，配置在入口校验后注入；编辑能力覆盖统计不得手写，改注册表或测试后运行 `pnpm capabilities:generate`（verify 中校验，裁决 0014）。
- AI 通用能力（V6 §6，裁决 0018）：AI 的导演与调度代码不得按视频类型或策略分支；新组件一律注册进统一工具目录（契约、权限、预算、能力声明、评测）供 AI 自由组合，不为某类型写专用流水线；策略剪辑是可选功能，策略包只以数据形式进入 AI 上下文，不得裁剪工具集合或绕过通用自检；质量评测以不选策略的通用能力为主。导演可接多家模型 API（裁决 0022 第 6 条）：Agent 循环与轮次日志与供应商无关、只追加，不改写已发出的历史；只发历史的一部分、换模型、图片预算、压缩等按供应商的请求整形只在该供应商的适配器里做，并配离线协议测试。
- TODO 必须写清 why / dependency / intended interface。
- 未实现测试套件必须使用显式 `[PLANNED]` 占位（`scripts/planned-suite.mjs`），不得伪造断言、扩大阈值或静默跳过。
- 依赖方向由 `pnpm arch:check` 强制（见 `packages/arch-check`）；新增依赖边前先核对现有规则和 v0.4 架构。

## 禁止事项（规范 §75，摘要）

- 不得把 Secret 写入仓库、日志或错误返回；客户端不得持有 Provider Key。
- 不得把 Provider output URL 当永久文件；付费生成不得无限自动重试。
- 数据图表不得使用虚构数值；不得让 Custom Motion 代码在无隔离进程执行。
- 不得以浏览器自动化冒充可靠发布能力；不得为 Demo 牺牲统一 ProjectDocument、原素材、隐私、可恢复性或多端一致性。
- `FOOTAGE_EDIT`、`GENERATIVE`、`HYBRID` 共用一套作品状态与编辑操作；纯素材项目的禁生成约束在服务端生效。旧安全底线见 v0.2 §75；当前架构规则见 v0.4 §12—§15 与 README。
- 不得在**已跟踪文件**中写入本机绝对路径（`E:\…`、`C:\Users\…`、`/mnt/…`、`/home/<user>/…`）；一律用仓库相对路径。一次性脚手架脚本命名 `.tmp-*`（`.gitignore` 已忽略），不进提交。
- 不得把**凭据加密密钥**与会话密钥共用一把：生产必须显式配置 `ANCS_CREDENTIAL_KEYS`（缺失即启动失败），派生兜底仅限非生产。
- 不得让运行未受信代码的子进程继承宿主环境变量（沙箱 spawn 必须走 `sandboxEnv()` 白名单）。
