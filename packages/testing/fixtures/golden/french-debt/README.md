# Golden Fixture：法国国债风险（french-debt）

规范 §80 指定的首个端到端样例：财经主题《为什么法国国债风险突然升温？》，目标时长 8—10 分钟。

## 性质与出处

- **场景重构**：以 2024 年 6—7 月法国政治冲击（解散国民议会、利差走阔、评级动作、欧盟过度赤字程序）为骨架，基于公开历史报道与统计编制。
- **数值标注**：每个数据点带 `accuracy`（`anchor` = 公开报道/统计的关键点位；`reconstructed` = 为保持序列连续所做的平滑重构）；来源快照带 `snapshot_kind: fixture_reconstruction`。
- **不是对现实市场的陈述，也不是投资建议**；用于视频生成管线的确定性回归测试。
- **无网络依赖**：测试只读取本目录的 JSON 文件，不访问任何网页；这满足计划 P00-04 验收“测试不依赖实时网页内容变化”。

## 文件结构

| 文件 | 内容 | 对应规范 |
|---|---|---|
| `content.json` | ContentDocument：28 个稳定 ID 的内容块、14 条 Claim（fact/analysis/opinion/uncertain）、11 条 Citation、2 张表格 | §7、§56 |
| `sources.json` | 9 条 SourceSnapshot（url/title/publisher/时间戳/contentHash/摘录；正式契约见 `@ancs/contracts`） | §85 |
| `datasets.json` | 4 个结构化数据集（利差、两国收益率、财政指标、股指），逐点标注锚点/重构 | §10.3、§56 |
| `expected.json` | 预期结构：5 章、13 个必备场景（§80 要素全集）、QA 期望（无占位、来源标注、Avatar/AI Video 占比等） | §80、§9.4 |

## 完整性约束（`pnpm test:golden` 自动校验）

1. 结构校验：四个文件均可通过 `@ancs/contracts` 的正式 schema（经 `packages/testing` 加载器校验；P01-01 起）。
2. 来源哈希：每条 `contentHash` 必须等于其 `excerpt` 的 SHA-256。
3. 可追溯：所有 Claim/Citation/Dataset/预期场景的 source/dataset 引用必须可解析；`fact` 级 Claim 必须有来源。
4. 领域不变量：利差序列 = 两条收益率序列之差（±1bp）；预期时长 480—600s；格式 1920×1080@30fps。
5. §80 覆盖：13 个必备场景类型齐备。
6. 溢出启发式：长文本不触发阈值（组件级安全区检测自 P05 起接管）。

## 使用方式

```ts
import { GOLDEN_FRENCH_DEBT_DIR, loadFixtureBundle, auditFixture } from '@ancs/testing';
```

后续阶段：P04（Narrative/Director 以本 fixture 为输入回归）、P05（组件渲染验收使用 `expected.requiredScenes`）、P08-05（真实成片）。
