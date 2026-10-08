# 会话交接 · v0.4 增量工程启动（2026-10-08）

## 工作区与权威

- 分支：`codex/v04-foundation`，从已推送的 `codex/quiet-frame-rebuild` 的 `2afb394` 开始；不要把 `main` 的旧 P 系列状态误作当前工作树。
- 已验证的 N15-02/N16-02 与此前增量提交已推送到私有远端 `origin/codex/v04-foundation`，当前推送 HEAD 为 `c33f8ef`；本机 Git 默认 TLS 连接一度重置，单次命令 `git -c http.sslBackend=schannel push origin codex/v04-foundation` 成功，没有修改仓库 TLS 配置。仓库 `.github/workflows/ci.yml` 仅在 `main` push 或 PR 触发，单独推送功能分支不会产生 GitHub Actions 运行；不能把“无 CI 记录”说成 CI 已通过。尚未创建 PR 或合并。
- 当前需求权威：`docs/V04/ANCS_AI_Native_v0.4.md`；执行入口：`docs/V04/ANCS_v0.4_Codex_Start.md`、`ANCS_v0.4_Task_Backlog.md`；生效裁决：`docs/decisions/0009-v04-authority-and-scope.md`。旧 v0.2、P 系列与 Quiet Frame 证据保留，不清零。
- `docs/V04/` 用户输入曾部分只在文档包 ZIP 中；本轮按包内 manifest 校验并补齐任务清单、追踪矩阵、设计 token CSS/JSON 和 `task_index.json`。任务索引 219 项，需求矩阵 131 条。实际状态读 `docs/requirements/ai-native-v04-acceptance-ledger.md` 与 `ai-native-v04-traceability.md`；源清单的初始 TODO 不是实时进度。

## 已核验与在途

- `VERIFIED`：N00-01/02/03/07、N15-01/02、N16-01/02，共 **8/219** 项。N15-02 是独立运营身份/MFA/会话工程验收，生产旧 `/admin/*` 全部读写维持 403；N16-02 是账号同步主题、设备覆盖与首屏工程验收。O0、D0/D1、G0 和整个 v0.4 均未关闭，生产账号与外部通知尚未启用。逐项证据与交接在 `docs/verification/N*.md`、`docs/handoffs/N*.md`。
- `IN_PROGRESS`：N00-04 已有可复现合成媒体、攻击样例、用户指定横屏 CFR/竖屏 VFR 视频、三段 Pexels 外部参考、ANCS 公共页面录屏及 20 分钟重复派生片的哈希、流和完整解码证据；尚缺手机原始采集 VFR 的来源与授权。N00-06 的独立浏览器/媒体骨架已通过真实 Chromium 播放、完整解码与错误路径测试，但未接入授权项目播放和双租户清理。N01-01 已实现有理时基、signed PTS、比较/换算、半开范围、精确帧边界与无损旧 ms 投影，尚未接入 ProjectDocument/持久化，且 N00-04 依赖未关闭。三项不得提前改为 VERIFIED。
- 最新已验证迁移为 **0052**：0051 运营认证与 0052 用户外观偏好均在精确隔离测试库通过。N15-03 已有只读候选权限矩阵 `docs/handoffs/N15-03-PREWORK.md`，任务仍 `TODO`；生产旧后台读写保持关闭直到逐动作授权与安全投影到位。没有调用收费 Provider。`test:contract` 与 `test:e2e` 仍为显式 `[PLANNED]`，不能计作断言通过。

## 验证和环境

- N00-03 改动前基线 `pnpm verify` 为 879 个已实现测试；N16-01/N01-01/N00-06 后为 893。N15-02/N16-02 与 N16-03 窄屏补丁进入树后，精确隔离 DB 的完整 `pnpm verify` 于 2026-10-08 14:20 退出 **0**：Unit 363、Web 150、Motion 19、Integration 339、Security 24、Render 6、Golden 15，合计 **916/916**。`test:contract`、`test:e2e` 为 `[PLANNED]`、0 断言。日志在忽略目录 `.artifacts/v04/N15-02-N16-02-N16-03-pnpm-verify-final.log`；N16-02 随后只补强浏览器验收脚本并做定向 lint、secrets、真实会话复测，产品源码未改。此前两次完整验证分别因 `.artifacts` 临时探针被 lint 扫描及运营页旧标题断言失败，已修复并从头重跑，不将失败掩盖为通过。
- `scripts/verification/n16-01-browser-smoke.mjs` 在最终 Next 构建重启后，用 Playwright Chromium 对公开 `/design-system` 做明暗按钮、状态卡、顶部栏、hover、375px 侧栏和粗指针命中尺寸断言，退出 0；两个图标按钮宽度和 10 个可见按钮高度实际为 44px，两张全页截图和 hash 在 `docs/verification/evidence/N16-01/` 与验证文档。浏览器脚本未覆盖真实项目、开关、21 路由矩阵或媒体播放。
- **数据库隔离**：历史开发库数据恢复由用户明确要求暂缓。此后运行真实 DB 测试时只使用 `ANCS_TEST_DATABASE_URL` 指向隔离的 `ancs_quiet_frame_test_261007`，并移除当前命令环境的 `DATABASE_URL`；不要清理或重建 `ancs_dev`。浏览器现有工作区记录已丢失，不能据此声称应用功能故障或恢复完成。
- N00-04 已收到横屏与竖屏两段用户明确指定的本地 MP4，原片没有入库或推送；竖屏是 13.89 秒、9:16 VFR，但含可识别人脸/账号且不能证明手机原始采集。用户另指定 Pexels：三段免费许可参考下载到 Git 忽略目录，实际为 9:16 25 fps、80 秒 30000/1001、120 秒 25 fps，3/3 完整解码通过；本仓库只记录页链、创作者、许可、哈希和流。新增匿名浏览器对公开 `/design-system` 的 4.84 秒 VP8 录屏；从 Pexels 80 秒原片及音轨重复派生 20 分钟本地压力片，长时间轴完整解码、递增 PTS 和末端 seek 通过，但不是连续实拍。详见 `docs/verification/N00-04.md`、各媒体 manifest。现有 Web 新建入口不接受视频，素材库上传后也没有视频播放路径；不得称产品端到端测试通过。
- N16-02 已用真实 Better Auth、隔离 PostgreSQL、Fastify、Next 和三浏览器会话验证账号主题同步、各设备 system、SSR 首屏、用户隔离及主题切换时项目/SceneGraph/账本不变；补强浏览器脚本直接观察 Remotion 播放时间 2→2→3 秒、播放持续，内部逐帧 epoch 未直接读取。N16-03 的 15 组宽窄视口与 Chrome 原生 200% 公开路由检查通过，仍因原型 SVG 图标商业许可、macOS/Safari 实机及已登录全站证据保持 `IN_PROGRESS`；晚间清单已登记权利确认。

## 下一步

1. 以最新 **916/916** 已实现测试的 `pnpm verify` 和逐项验证文档为基线；879、893 是更早的对照数，不是当前进度。全量构建后已核对并重启本仓库 3000 `next start`，保留 4000 网关；对 `http://127.0.0.1:4000/design-system` 重新运行真实 Chromium 的 `n16-02-browser-smoke.mjs` 退出 0，明暗首屏、系统变化和 hydration 检查通过。若以后再次重建 `.next`，需重新核对并重启旧进程。
2. 继续补齐 N00-04 所需的手机原始 VFR 来源与授权；公共页面录屏、Pexels 参考和 20 分钟重复压力片已备。N00-06 已有隔离浏览器/媒体验收骨架，授权项目视频播放和限定清理须待相应产品能力接通后再验。把 N01-01 接入 ProjectDocument/DB/API/SDK 的后续任务。用户需配合的近端与后续事项集中在 `docs/handoffs/USER-ACTIONS-261008.md`，不重复逐项追问。保持旧毫秒项目只读兼容，严禁精度静默丢失。
3. N16-02 账号偏好契约、持久化、Web 首屏和真实会话已验；N16-03 继续图标权利/替代方案、macOS 与受保护路由的缩放证据，D0/D1 未关闭。N15-02 独立身份/MFA 已验，生产旧 `/admin` 读写全关闭；下一项 N15-03 按预研矩阵实现逐动作/对象授权，不能因 TEST 的旧后台测试通过而开放生产面。用户需晚间确认真实生产操作者与独立复核人；旧 P15/P16 的暂停不能直接映射为新 N15/N16 状态。
