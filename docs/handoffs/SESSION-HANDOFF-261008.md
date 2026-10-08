# 会话交接 · v0.4 增量工程启动（2026-10-08）

## 工作区与权威

- 分支：`codex/v04-foundation`，从已推送的 `codex/quiet-frame-rebuild` 的 `2afb394` 开始；不要把 `main` 的旧 P 系列状态误作当前工作树。
- 当前需求权威：`docs/V04/ANCS_AI_Native_v0.4.md`；执行入口：`docs/V04/ANCS_v0.4_Codex_Start.md`、`ANCS_v0.4_Task_Backlog.md`；生效裁决：`docs/decisions/0009-v04-authority-and-scope.md`。旧 v0.2、P 系列与 Quiet Frame 证据保留，不清零。
- `docs/V04/` 用户输入曾部分只在文档包 ZIP 中；本轮按包内 manifest 校验并补齐任务清单、追踪矩阵、设计 token CSS/JSON 和 `task_index.json`。任务索引 219 项，需求矩阵 131 条。实际状态读 `docs/requirements/ai-native-v04-acceptance-ledger.md` 与 `ai-native-v04-traceability.md`；源清单的初始 TODO 不是实时进度。

## 已核验与在途

- `VERIFIED`：N00-01 工作区审阅；N00-02 权威切换；N00-03 隔离测试库基线；N00-07 来源/术语映射；N15-01 运营现状盘点。各自证据与交接在 `docs/verification/N*.md`、`docs/handoffs/N*.md`。这些完成的是各自文档/基线任务，**不表示** G0、O0、D0/D1 或整个 v0.4 已通过。
- `IN_PROGRESS`：N00-04 已有可复现合成媒体、攻击样例、hash 与 FFprobe 证据，但缺授权实拍、真实手机 VFR、录屏、参考及长素材；N01-01 已实现有理时基、signed PTS、比较/换算/线性边界映射与 10 项单测，尚未接入 ProjectDocument/持久化，且 N00-04 依赖未关闭；N16-01 已接入语义 token、修复部分深色控件状态、建立静态扫描，旧 UI 候选与实际浏览器矩阵未验。三个任务不得提前改为 VERIFIED。
- 本轮没有数据库迁移；最新迁移保持 0050。没有调用收费 Provider。`test:contract` 与 `test:e2e` 仍为显式 `[PLANNED]`，不能计作断言通过。

## 验证和环境

- N00-03 改动前基线 `pnpm verify` 在独立测试库退出 0：879 个真实断言（unit 347、web 139、motion 19、integration 331、security 22、render 6、golden 15）。**本轮最终代码**的 `pnpm verify` 也在独立测试库退出 0：893 个真实断言（unit 357、web 143、motion 19、integration 331、security 22、render 6、golden 15）。`test:contract`、`test:e2e` 是 `[PLANNED]`、0 断言。全量 log 位于忽略目录 `.artifacts/v04/final-pnpm-verify.log`，逐任务可复核结果见 N01-01/N16-01 验证文档。
- `scripts/verification/n16-01-browser-smoke.mjs` 在最终 Next 构建重启后，用 Playwright Chromium 对公开 `/design-system` 做明暗按钮、状态卡、顶部栏、hover 和 375px 侧栏计算样式断言，退出 0；两张全页截图和 hash 在 `docs/verification/evidence/N16-01/` 与验证文档。浏览器脚本未覆盖真实项目、开关、21 路由矩阵或媒体播放。
- **数据库隔离**：历史开发库数据恢复由用户明确要求暂缓。此后运行真实 DB 测试时只使用 `ANCS_TEST_DATABASE_URL` 指向隔离的 `ancs_quiet_frame_test_261007`，并移除当前命令环境的 `DATABASE_URL`；不要清理或重建 `ancs_dev`。浏览器现有工作区记录已丢失，不能据此声称应用功能故障或恢复完成。
- N00-04 缺真实素材。用户如提供路径，应先确认来源授权、可用范围和 hash，再补 fixture 与真实媒体证据。合成素材能验证时间/解码基本路径，但不能代替手机 VFR、实拍或第三方 Provider 验收。

## 下一步

1. 以本轮最终 `pnpm verify` 与 N00-03/N01-01/N16-01 的验证文档为基线；新回归须与原有 879 断言基线和新增 14 断言区分。Web 当前 `next start` 已在最终构建后重启，经 4000 端口可访问 `/design-system`；若以后重建 `.next`，需重新启动服务，避免旧进程引用已清理 CSS 造成无样式页面。
2. 补齐 N00-04 的授权素材后推进 N00-05/N00-06，并把 N01-01 接入 ProjectDocument/DB/API/SDK 的后续任务；保持旧毫秒项目只读兼容，严禁精度静默丢失。
3. N16 按验证文档的旧 UI 候选清理和真实浏览器状态矩阵推进。N15 后续涉及管理员授权、MFA、审批和审计，依任务依赖实施；旧 P15/P16 的暂停不能直接映射为新 N15/N16 的状态。
