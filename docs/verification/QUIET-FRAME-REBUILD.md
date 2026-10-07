# Quiet Frame Web 重构验证记录

日期：2026-10-08。工作区 `E:\Codes\ANCS`，分支 `codex/quiet-frame-rebuild`。本记录只覆盖本轮 Web 设计迁移和回归；不把参考原型的 QA、视觉夹具或 Mock 结果当作真实业务完成。

## 基线与参考

- 基线 `main @ 2fa881db7a9d024a03b5077f197f7cedbbeea194` 的命令结果和开发库测试数据事件见 [QUIET-FRAME-BASELINE.md](QUIET-FRAME-BASELINE.md)。原始设计包 SHA-256 为 `a04a074c62f03dcb09f9aa94aa22f2861740a808e9872312501dd8871cb2ed4a`；33 个文件只读展开并逐项盘点，见 `docs/quiet-frame-rebuild/REFERENCE_INVENTORY.md`。
- 视觉原型与产品页面由同一台 Windows 的 Playwright Chromium 149.0.7827.55 采集，固定 `zh-CN`、上海时区、时间、DPR 和 `reducedMotion`。逐页结果、不可比原因、截图 run ID 见 `docs/quiet-frame-rebuild/VISUAL_PARITY_REPORT.md`。图片、叠图、差异图和 metadata 在本机忽略目录 `.artifacts/quiet-frame/`；原始参考图未修改。

## 自动检查

所有数据库测试使用显式 `ANCS_TEST_DATABASE_URL` 指向独立 `ancs_quiet_frame_test_261007`；测试入口拒绝未指定测试库或把开发库当测试库。日志不包含连接口令。本轮没有启动真实付费 Provider、真实平台发布或购买。

| 命令 / 层级 | 结果 | 原始证据与界限 |
|---|---|---|
| `pnpm verify`，2026-10-07 首轮完整构建 | 退出码 0；secrets、lint、typecheck、build、arch 全通过 | `.artifacts/quiet-frame-rebuild/verify-final-261007.log`；之后继续修复响应式、弹层和设计系统交互，不能代表最终源码的验证结果 |
| `pnpm test:unit`（首轮 verify 内） | 42 文件、347/347 | 同上；不含真实 Provider |
| `pnpm test:web`（首轮 verify 内） | 27 文件、134/134 | jsdom + SDK 替身；验证交互与调用边界，不证明 API 持久化 |
| `pnpm test:motion`（首轮 verify 内） | 2 文件、19/19 | 同上 |
| `pnpm test:integration`（首轮 verify 内） | 74 文件、331/331 | 真实独立 PostgreSQL 测试库，未接触开发业务库 |
| `pnpm test:security`（首轮 verify 内） | 4 文件、22/22 | 同上 |
| `pnpm test:render`（首轮 verify 内） | 2 文件、6/6 | 本地渲染测试，非第三方 Provider |
| `pnpm test:golden`（首轮 verify 内） | 2 文件、15/15 | 同上 |
| `test:contract`、`test:e2e`（verify 内） | `[PLANNED]`，无断言 | 退出 0 仅表示占位脚本按预期运行，**不计通过** |
| 首次修复后重跑 `pnpm verify` | 退出码 1，停在 lint；未执行后续步骤 | `.artifacts/quiet-frame-rebuild/verify-final-261008.log`。本机视觉审计脚本误以 `.mjs` 留在 `.artifacts`，ESLint 对其浏览器上下文的 `document` 报 9 个 `no-undef`；证据脚本保留并改名 `.mjs.txt`，不修改产品源码的 lint 规则 |
| 弹层居中修复前的 `pnpm verify` | 主动中止于 integration，**不算完整通过** | `.artifacts/quiet-frame-rebuild/verify-final-261008-b.log`；已通过 secrets、lint、typecheck、build、arch、unit 347、Web 136、motion 19；视觉复拍发现原生 dialog 被全局 margin reset 贴到左上角，因此修复并重建后另跑最终完整验证 |
| 设计系统样式示例接线前的 `pnpm verify` | 主动中止于 integration，**不算完整通过** | `.artifacts/quiet-frame-rebuild/verify-final-261008-c.log`；已通过 secrets、lint、typecheck、build、arch、unit 347、Web 136、motion 19。交互审计发现 QF-13 三个按钮外观样式示例仍是静态 `span`，先改为真实安全操作再运行最终全量 |
| 设计系统动作接线后的 `pnpm verify` | 退出码 0；secrets、lint、typecheck、build、arch 及所有已实现套件通过 | `.artifacts/quiet-frame-rebuild/verify-final-261008-d.log`；unit 347、Web 138、motion 19、integration 331、security 22、render 6、golden 15。随后发现命令搜索列表两个合法入口共用 React key，修复后另跑最终验证 |
| 命令搜索 key 修复聚焦测试 | 1 文件、9/9；无重复 key 警告 | `pnpm exec vitest run apps/web/src/ui/StudioShell.test.tsx --reporter=dot`，退出码 0；仅验证该组件，不替代全量 |
| 最终源码的 `pnpm verify` | **退出码 0**；secrets、lint、typecheck、build、arch 全通过；unit 42 文件/347、Web 27/138、motion 2/19、integration 74/331、security 4/22、render 2/6、golden 2/15 | `.artifacts/quiet-frame-rebuild/verify-final-261008-e.log`；`test:contract` 与 `test:e2e` 仍是 `[PLANNED]` 无断言，不计测试通过 |

`git diff --cached --check` 对新纳入的原始设计参考目录报 3 处 Markdown 行尾双空格（`README.md:3`、`handoff/IMPLEMENTATION_HANDOFF.md:3-4`），这是 ZIP 原文的换行标记，按只读要求保留。排除该只读参考目录后的 `git diff --cached --check -- . ':(exclude)docs/design-reference/quiet-frame/a04a074c62f0/ANCS_Quiet_Frame/**'` 退出 0；没有产品实现文件空白错误。

## 实际浏览器链路

`ANCS_TEST_DATABASE_URL=…test… node scripts/quiet-frame-browser-smoke.mjs` 在最终源码构建的生产 Next、Chromium、本地 Fastify/API 和独立 PostgreSQL 上退出 0。登录 → 创建工作区/项目 → 粘贴正文 → 刷新恢复 → Mock LLM 生成脚本 → 深链接刷新 → 校验数据库持久化，并访问 11 个次级页面；记录 0 `pageerror`、0 hydration 错误。最终链路截图为 `.artifacts/quiet-frame-rebuild/browser-smoke/qf-smoke-3614b8ed-d968-4e1b-9241-80118fb206f4.png`，11 张子页图在同名 `-routes/` 目录；日志 `.artifacts/quiet-frame-rebuild/browser-smoke-final-261008-c.log`。此前 `b` 和 `e44e5ed6…` 运行保留供追溯；本次 smoke 未测试设计系统示例按钮、命令搜索或新增业务写操作，这些由各自聚焦检查或待验项覆盖。

该链路使用 Mock LLM 与本地对象存储，没有真实素材上传、声音训练、旁白合成、Render、QA、批准、导出、发布或支付。Web 组件测试的替身调用也不等于真实 API 写入。新增的 Director 候选、Voice 生命周期、发布对账/交接、Finance 表单已做聚焦组件测试；浏览器 smoke 未触发这些写操作。

## 视觉、响应式与剩余门控

- 18 个原型状态有同环境对照图；真实产品的合法空态与原型的演示成功数据不同，大量全图像素值不可比，**不能称为 1:1 通过**。逐行差异及最终 run ID 见视觉报告。截图夹具以 `SYNTHETIC_VISUAL_ONLY` 命名，拦截写请求，不读写开发数据库。
- 320/390/768/1280/1920 宽度的创作台、导演、成片、设置、Finance 共 25 组初拍发现唯一整页溢出：768px 导演时间线超出 150px。改为容器内横向滚动后，使用已纳入仓库的 `pnpm visual:qf:responsive --run-id 261008-final-cli` 在全新目录 `.artifacts/quiet-frame/responsive-audit/261008-final-cli/` 重拍 25 PNG 与 JSON：25/25 根节点无横向溢出，主操作裁切 0，页面错误、夹具未命中及外部请求均为 0；768px 时间线本身 282px 可视宽、679px 内容宽，可独立滚动。早期临时审计脚本一次误用了 261007 输出目录，覆盖当时的 JSON 和导演 768 PNG；原参考图与 18 状态视觉基准没有被覆盖。本轮最终目录与初拍摘要分开保存，不把被覆盖的 JSON 当完整初始证据。
- 新建 Render、付费 Voice Clone 训练/重试和 Master Narration 合成受后端费用/任务/幂等门控缺口阻塞；UI 显示原因，未造假成功。Provider 侧删除缺服务端归属和版本条件。详见 `docs/quiet-frame-rebuild/FUNCTIONAL_REGRESSION_REPORT.md` §4。无法以本轮 Mock 或本地数据关闭这些真实 Provider 项。
- 本轮没有 push 或 GitHub CI 结果；用户要求 Web 检查后暂停，P15/P16 未启动。开发库历史数据恢复按用户指示留待之后，不能从当前本地材料声称已恢复。
