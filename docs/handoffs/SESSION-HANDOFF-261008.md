# 会话交接 · v0.4 增量工程启动（2026-10-08）

## 工作区与权威

- 分支：`codex/v04-foundation`，从已推送的 `codex/quiet-frame-rebuild` 的 `2afb394` 开始；不要把 `main` 的旧 P 系列状态误作当前工作树。
- 本轮实现提交 `2665c00`（`feat(v04): establish incremental baseline and time primitives`）已推送到私有远端 `origin/codex/v04-foundation`。仓库 `.github/workflows/ci.yml` 仅在 `main` push 或 PR 触发，单独推送此功能分支不会产生 GitHub Actions 运行；不能把“无 CI 记录”说成 CI 已通过。尚未创建 PR 或合并。
- 当前需求权威：`docs/V04/ANCS_AI_Native_v0.4.md`；执行入口：`docs/V04/ANCS_v0.4_Codex_Start.md`、`ANCS_v0.4_Task_Backlog.md`；生效裁决：`docs/decisions/0009-v04-authority-and-scope.md`。旧 v0.2、P 系列与 Quiet Frame 证据保留，不清零。
- `docs/V04/` 用户输入曾部分只在文档包 ZIP 中；本轮按包内 manifest 校验并补齐任务清单、追踪矩阵、设计 token CSS/JSON 和 `task_index.json`。任务索引 219 项，需求矩阵 131 条。实际状态读 `docs/requirements/ai-native-v04-acceptance-ledger.md` 与 `ai-native-v04-traceability.md`；源清单的初始 TODO 不是实时进度。

## 已核验与在途

- `VERIFIED`：N00-01 工作区审阅；N00-02 权威切换；N00-03 隔离测试库基线；N00-07 来源/术语映射；N15-01 运营现状盘点。各自证据与交接在 `docs/verification/N*.md`、`docs/handoffs/N*.md`。这些完成的是各自文档/基线任务，**不表示** G0、O0、D0/D1 或整个 v0.4 已通过。
- `IN_PROGRESS`：N00-04 已有可复现合成媒体、攻击样例、用户指定横屏 CFR/竖屏 VFR 视频、三段 Pexels 外部参考与 ANCS 公共页面录屏的哈希、流和完整解码证据；手机原始采集 VFR、长时序压力媒体及真实项目工作流尚缺；N01-01 已实现有理时基、signed PTS、比较/换算/线性边界映射与 10 项单测，尚未接入 ProjectDocument/持久化，且 N00-04 依赖未关闭；N16-01 已接入语义 token、修复部分深色控件状态、建立静态扫描，旧 UI 候选与实际浏览器矩阵未验。三个任务不得提前改为 VERIFIED。
- 本轮没有数据库迁移；最新迁移保持 0050。没有调用收费 Provider。`test:contract` 与 `test:e2e` 仍为显式 `[PLANNED]`，不能计作断言通过。

## 验证和环境

- N00-03 改动前基线 `pnpm verify` 在独立测试库退出 0：879 个真实断言（unit 347、web 139、motion 19、integration 331、security 22、render 6、golden 15）。**本轮最终代码**的 `pnpm verify` 也在独立测试库退出 0：893 个真实断言（unit 357、web 143、motion 19、integration 331、security 22、render 6、golden 15）。`test:contract`、`test:e2e` 是 `[PLANNED]`、0 断言。全量 log 位于忽略目录 `.artifacts/v04/final-pnpm-verify.log`，逐任务可复核结果见 N01-01/N16-01 验证文档。
- `scripts/verification/n16-01-browser-smoke.mjs` 在最终 Next 构建重启后，用 Playwright Chromium 对公开 `/design-system` 做明暗按钮、状态卡、顶部栏、hover 和 375px 侧栏计算样式断言，退出 0；两张全页截图和 hash 在 `docs/verification/evidence/N16-01/` 与验证文档。浏览器脚本未覆盖真实项目、开关、21 路由矩阵或媒体播放。
- **数据库隔离**：历史开发库数据恢复由用户明确要求暂缓。此后运行真实 DB 测试时只使用 `ANCS_TEST_DATABASE_URL` 指向隔离的 `ancs_quiet_frame_test_261007`，并移除当前命令环境的 `DATABASE_URL`；不要清理或重建 `ancs_dev`。浏览器现有工作区记录已丢失，不能据此声称应用功能故障或恢复完成。
- N00-04 已收到横屏与竖屏两段用户明确指定的本地 MP4，原片没有入库或推送；竖屏是 13.89 秒、9:16 VFR，但含可识别人脸/账号且不能证明手机原始采集。用户另指定 Pexels：三段免费许可参考下载到 Git 忽略目录，实际为 9:16 25 fps、80 秒 30000/1001、120 秒 25 fps，3/3 完整解码通过；本仓库只记录页链、创作者、许可、哈希和流。新增匿名浏览器对公开 `/design-system` 的 4.84 秒 VP8 录屏，可复查但不代表真实编辑工作流。详见 `docs/verification/N00-04.md`、各媒体 manifest。现有 Web 新建入口不接受视频，素材库上传后也没有视频播放路径；不得称产品端到端测试通过。

## 下一步

1. 以本轮最终 `pnpm verify` 与 N00-03/N01-01/N16-01 的验证文档为基线；新回归须与原有 879 断言基线和新增 14 断言区分。Web 当前 `next start` 已在最终构建后重启，经 4000 端口可访问 `/design-system`；若以后重建 `.next`，需重新启动服务，避免旧进程引用已清理 CSS 造成无样式页面。
2. 继续补齐 N00-04 所需的手机原始 VFR 与更长物理样本；公共页面录屏和 Pexels 参考已备，但真实用户项目录屏仍需后续场景。N00-06 可准备隔离浏览器/媒体验收骨架，实际视频播放和剪辑须待相应产品能力接通后再验。把 N01-01 接入 ProjectDocument/DB/API/SDK 的后续任务。用户需配合的近端与后续事项集中在 `docs/handoffs/USER-ACTIONS-261008.md`，不重复逐项追问。保持旧毫秒项目只读兼容，严禁精度静默丢失。
3. N16 按验证文档的旧 UI 候选清理和真实浏览器状态矩阵推进。N15 后续涉及管理员授权、MFA、审批和审计，依任务依赖实施；旧 P15/P16 的暂停不能直接映射为新 N15/N16 的状态。
