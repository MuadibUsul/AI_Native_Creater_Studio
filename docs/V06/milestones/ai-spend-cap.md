# 工作区 AI 月度费用上限

- **起因：** 首轮内测仅限受邀（D-04）后，受邀用户可以无限次地让 AI 导演工作，模型费用全部由部署方承担；此前只有"每轮 $1.50"的单轮上限和自主制作的授权预算，没有按工作区、按月的总上限。不需要所有者输入即可做，先做成保护；具体金额与按套餐区分额度留给 D-03。
- **状态：** VERIFIED（单元 + 真实 PostgreSQL 集成 + 组件测试 + 真实浏览器）。导演模型为脚本导演（SCRIPTED，按价格表中的模型单价计费），不调用真实 Provider——Mock 通过 ≠ 真实 Provider 通过；本项不涉及 Provider 行为，计费口径与真实调用相同（`agentModelCostMicros`）。

## 目标

1. 每个工作区每月的 AI 模型费用有上限，服务端强制执行，不能靠隐藏按钮绕过。
2. 上限可配置：部署缺省（`ANCS_AI_MONTHLY_CAP_USD`），套餐可单独设（`aiSpendMicrosPerMonth`，以套餐为准）。
3. 达到上限时：进行中的一轮在下一次模型调用前停下，已完成的修改保留为提案；新的一轮被拒绝；界面用中英文说明额度与恢复日期。
4. 生产不能忘记配置：生产启动时必须显式给出金额或 `unlimited`。

## 口径与规则

- **计入：** UTC 自然月内开始的导演轮次（对话、审片讨论、审片执行、自主制作）的模型费用（`agent_turns.cost_micros`），加上风格撰写（参考视频蒸馏 compose 步骤记录的 `costMicros`）。
- **不计入：** 付费生成（配音、数字人、生成镜头）——它们另有工作区生成预算（报价 → 确认 → 预留 → 结算），不重复计算。未定价的调用不计金额（不填零），另计次数。
- **上限来源：** 套餐 `aiSpendMicrosPerMonth`（非 null 时）→ 否则部署缺省 `ANCS_AI_MONTHLY_CAP_USD` → 都没有 = 不设上限。套餐里的 `null` 表示"套餐不设"，与其他权益维度"null = 不限"不同，目的是忘记配置时仍有部署缺省兜底；套餐设 `0` = 不能用 AI。默认套餐种子都不设（金额待 D-03）。
- **执行点：** `startAgentTurn`（覆盖对话、审片讨论 / 执行）在建轮次前检查，幂等键重放已有轮次不受影响；`startAutonomousRun` 开始前检查；导演循环在每次模型调用前检查（覆盖自主制作中途达到上限）；风格撰写达到上限时改用规则撰写（不调用模型，结果照常可用）。
- **超出边界：** 检查发生在调用之前，所以实际花费最多超出上限"一次模型调用"的费用（同一工作区并发的几轮各一次）。单轮 $1.50 上限仍然有效，先到先停。
- **自主制作报告：** 因月度上限停下时，交付报告"要留意"列出"工作区本月的 AI 额度用完，AI 提前停下"（`MONTHLY_AI_LIMIT`）；开始时已达上限则当场说明。

## 实现（contracts → migration → domain → API → SDK → UI → tests → docs）

- **contracts**：`aiSpendSchema`（period、capMicros、capSource、spentMicros、unpricedCalls、reached、resetsAt）；`AGENT_ERROR_REASONS.MONTHLY_CAP_REACHED = 'AI_MONTHLY_CAP_REACHED'`；套餐权益 `aiSpendMicrosPerMonth`；
  共看片室读面 `aiSpend`；自主制作 `MONTHLY_AI_LIMIT`；环境变量 `ANCS_AI_MONTHLY_CAP_USD`（API 与 Worker 共用；金额最多两位小数或 `unlimited`；生产必填）。
- **migration**：`0100_agent_turns_workspace_idx`（`agent_turns (workspace_id, created_at)`，每次模型调用前的月度汇总走索引）。手写。
- **domain**：`ai-spend.ts`（`workspaceAiSpend`、`assertAiSpendAvailable`、`aiSpendWindow`）；`plans.ts` 抽出 `getWorkspacePlan`（只解析套餐，不跑用量统计）；`deployment-policy.ts` 加 `aiMonthlyCapMicros`（入口注入，领域层不读 `process.env`）；
  `agent-runtime.ts` 两处检查与中英停下说明；`autonomous-production.ts` 开始前检查、报告映射；`reference-distill.ts` 达到上限时改用规则撰写；`studio.ts` 读面带 `aiSpend`。
- **API**：`configureDeploymentPolicy` 注入（API 与 Worker 入口）；agent / autonomy / review 路由声明 402；错误体 `402 BUDGET_EXCEEDED`，`details.reason = AI_MONTHLY_CAP_REACHED`，带 `capMicros`、`spentMicros`、`resetsAt`。
- **SDK**：不适用（读面字段随 `StudioState` 类型自动带出，错误经 `AncsApiError.details`）。
- **Web**：对话栏输入框上方显示"这个工作区本月的 AI 额度（$20.00）已用完，11月1日恢复。"/"This workspace has used its AI allowance for this month ($20.00). It resets on November 1."，发送按钮不可用；
  读面未刷新时服务端 402 显示同一说明；顶栏 AI 费用提示加上"本工作区本月 AI 费用 $x / 额度 $y"；自主制作的开始错误与报告条目。全部中英双语。
- **配置示例**：`infra/production.env.example` `ANCS_AI_MONTHLY_CAP_USD=20`（所有者可改，见 `docs/OWNER_ACTION_ITEMS.md` D-16）；`.env.example` 留空（开发不设）。

## 验收与命令

| 命令 | 结果 |
|---|---|
| `pnpm -s typecheck` / `pnpm -s lint` / `arch:check` / `spec:check` / `secrets:check` / `capabilities:check` | 通过 |
| `npx vitest run --project unit packages/contracts/src/env.test.ts` | 38 通过（新增：金额换算、非法格式、生产 API / Worker 必填） |
| `npx vitest run --project integration packages/domain/src/ai-spend.integration.test.ts` | 4 通过（部署缺省上限：调用前停下、402、幂等重放、读面、下月重算；英文停下说明 + 风格撰写计入；单轮与月度同时到达时说明月度；套餐额度优先、套餐 0、无上限） |
| `npx vitest run --project web apps/web/src/studio/studio.test.tsx` | 31 通过（新增：额度用完的提示与发送不可用；402 的说明） |
| `npx vitest run --project unit` / `--project web` | 879 / 346 通过 |
| `npx vitest run --project integration`（全量） | 146 个文件 / 679 个测试通过（含新增 4 个与生产启动守卫） |
| `node scripts/ai-spend-browser-check.mjs` | 4/4 通过（证据 `docs/verification/artifacts/ai-spend/`） |

## 本次结果（真实浏览器，2026-10-22）

- 上限 $1.00、本月 $0：没有额度提示，可以发送。
- 说一句"看看有什么素材"：第 1 次调用 $0.80（未达上限）→ 第 2 次 $1.60（达到）→ 第 3 次调用没有发生；对话里："这个工作区本月的 AI 额度（$1.00）已用完，我先停在这里；目前的修改已保留为提案。额度在 2026-11-01（UTC）恢复。"
  输入框上方："这个工作区本月的 AI 额度（$1.00）已用完，11月1日恢复。"；写了字发送仍不可用；顶栏"AI 用量 $1.60"的提示含"本工作区本月 AI 费用 $1.60 / 额度 $1.00"（`01-cap-reached-zh.png`）。
- 绕过界面用 SDK 直接发起：402 `AI_MONTHLY_CAP_REACHED`（capMicros 1000000、spentMicros 1600000、resetsAt 2026-11-01T00:00:00.000Z），模型没有被调用。
- 英文："This workspace has used its AI allowance for this month ($1.00). It resets on November 1."（`02-cap-reached-en.png`）；深色（`03-cap-reached-dark.png`）；390 px 无横向溢出（`04-cap-reached-mobile.png`）。
- 浏览器实测发现并修正：最初单轮上限（$1.50）先于月度上限检查，两者同时到达时只说"这一轮达到成本上限"，而用户真正需要知道的是本月已不能再用——改为先查月度，并加集成测试。

## 已知边界与交接

- **画面理解（上传后的视觉描述）的模型费用尚未计量**：Worker 的模型视觉分析适配器丢弃了用量，既不计入月度上限也不显示；每条素材最多 120 帧（约 10 次调用），总量受存储额度约束。要计入需要适配器回报用量并落库——列为下一步。
- 实际花费最多超出上限一次模型调用（见上）；需要严格不超时，改为"调用前按最大输出预留"——当前不做，代价是每轮更早停下。
- 月份按 UTC 计算；界面显示的恢复日期也是 UTC 日期。
- 金额（生产示例 $20）与按套餐区分额度是商业决定（D-03 / D-16），由所有者定；改金额只需改环境变量并重启 API 与 Worker。
- 只给运营看的"各工作区本月 AI 花费"列表没有做（目前只在共看片室里给工作区成员看）。
