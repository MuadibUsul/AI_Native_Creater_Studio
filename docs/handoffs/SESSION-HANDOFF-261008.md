# 会话交接 · v0.4 增量工程启动（2026-10-08）

> **2026-10-09 当前状态优先：** 用户要求不再停下来做 Web 人工检查，连续推进全量 v0.4。当前为 **24/219** 项 VERIFIED：N00-01—07、N01-01—11、N02-01/02、N15-01/02、N16-01/02。N02-02 已交付真实媒体探测、逐流时基／PTS／旋转／色彩／声道／VFR 事实、显式格式能力与失败恢复；最新迁移 0065，`pnpm verify` 1003/1003。下一项为 N02-03。下文较早数字仅保留历史上下文。

## 工作区与权威

- 分支：`codex/v04-foundation`，从已推送的 `codex/quiet-frame-rebuild` 的 `2afb394` 开始；不要把 `main` 的旧 P 系列状态误作当前工作树。
- 已验证的 N15-02/N16-02 与此前增量提交已推送到私有远端 `origin/codex/v04-foundation`；本轮 N00-06 `820765b`、N16-10 `b9044ef`、N15-03 `713337e` 也已推送。命令 `git -c http.sslBackend=schannel push origin codex/v04-foundation` 成功，没有修改仓库 TLS 配置。仓库 `.github/workflows/ci.yml` 仅在 `main` push 或 PR 触发，单独推送功能分支不会产生 GitHub Actions 运行；不能把“无 CI 记录”说成 CI 已通过。尚未创建 PR 或合并。
- 当前需求权威：`docs/V04/ANCS_AI_Native_v0.4.md`；执行入口：`docs/V04/ANCS_v0.4_Codex_Start.md`、`ANCS_v0.4_Task_Backlog.md`；生效裁决：`docs/decisions/0009-v04-authority-and-scope.md`。旧 v0.2、P 系列与 Quiet Frame 证据保留，不清零。
- `docs/V04/` 用户输入曾部分只在文档包 ZIP 中；本轮按包内 manifest 校验并补齐任务清单、追踪矩阵、设计 token CSS/JSON 和 `task_index.json`。任务索引 219 项，需求矩阵 131 条。实际状态读 `docs/requirements/ai-native-v04-acceptance-ledger.md` 与 `ai-native-v04-traceability.md`；源清单的初始 TODO 不是实时进度。

## 已核验与在途

- `VERIFIED`：N00-01—07、N01-01—04、N15-01/02、N16-01/02，共 **15/219** 项。N00 基础阶段已全部关闭；N01-01—04 已完成有理时基、ProjectDocument v1.0、三模式 ProductionPolicy、规范化 Sequence/Track/Clip，以及迁移 0059 的稳定 VisualObject、版本化效果／参数／动画、字幕和音频局部时间。旧版本迁移和工程 API 属于 N01-05/09。N15-02 是独立运营身份/MFA/会话工程验收，生产旧 `/admin/*` 全部读写维持 403；N16-02 是账号同步主题、设备覆盖与首屏工程验收。O0、D0/D1、G0—G4 和整个 v0.4 均未关闭，生产账号与外部通知尚未启用。逐项证据与交接在 `docs/verification/N*.md`、`docs/handoffs/N*.md`。
- N00-04 新增来源可追溯且仓库声明 CC0 的 Shotstack `test-media` Galaxy S9 四段原始方向/VFR 素材，本地 4/4 hash、大小、PTS 差值和完整解码通过；N00-05 已实现发布门和工作区能力偏好；N00-06 的真实浏览器、签名上传、故意失败、跨租户 404 与安全清理最终复跑通过。
- 0051 运营认证、0052 用户外观偏好及 N15-03 的 0053—0055 权限 scope、策略版本和受限紧急授权模型均在精确隔离测试库通过。N15-03 仍为 `IN_PROGRESS`：缺可信同人关联、独立复核/发布流程及多数旧 GET 安全投影；生产旧后台读写保持关闭。没有调用收费 Provider。`test:contract` 与 `test:e2e` 仍为显式 `[PLANNED]`，不能计作断言通过。

## 验证和环境

- 精确隔离 DB 的最新完整 `pnpm verify` 于 2026-10-08 22:32 退出 **0**：Unit 372、Web 159、Motion 19、Integration 364、Security 24、Render 6、Golden 15，合计 **959/959**。953、950、943、939、937、879、893、916、929、933 是更早基线。`test:contract`、`test:e2e` 为 `[PLANNED]`、0 断言。该运行包含 N01-04、迁移 0059、legacy Render fail-closed 门与全部既有套件；测试数不等于尚在途产品门关闭。
- `scripts/verification/n16-01-browser-smoke.mjs` 在最终 Next 构建重启后，用 Playwright Chromium 对公开 `/design-system` 做明暗按钮、状态卡、顶部栏、hover、375px 侧栏和粗指针命中尺寸断言，退出 0；两个图标按钮宽度和 10 个可见按钮高度实际为 44px，两张全页截图和 hash 在 `docs/verification/evidence/N16-01/` 与验证文档。浏览器脚本未覆盖真实项目、开关、21 路由矩阵或媒体播放。
- **数据库隔离**：历史开发库数据恢复由用户明确要求暂缓。此后运行真实 DB 测试时只使用 `ANCS_TEST_DATABASE_URL` 指向隔离的 `ancs_quiet_frame_test_261007`，并移除当前命令环境的 `DATABASE_URL`；不要清理或重建 `ancs_dev`。浏览器现有工作区记录已丢失，不能据此声称应用功能故障或恢复完成。
- N00-04 已收到横屏与竖屏两段用户指定的本地 MP4，原片没有入库或推送；另有 Pexels 参考、ANCS 公共页录屏和 20 分钟派生压力片。最终用 Shotstack `test-media` 固定提交中的四段 Galaxy S9 原始方向素材补齐可追溯 CC0 手机 VFR 来源，4/4 hash、大小、PTS 差值和完整解码通过。详见 `docs/verification/N00-04.md` 与各媒体 manifest。N00-06 已在精确隔离库用合成 CFR 样本、真实签名存储和双租户权限回归验证。长视频真实项目、最终成片和完整编辑链路继续由后续任务证明。
- N16-02 已用真实 Better Auth、隔离 PostgreSQL、Fastify、Next 和三浏览器会话验证账号主题同步、各设备 system、SSR 首屏、用户隔离及主题切换时项目/SceneGraph/账本不变；补强浏览器脚本直接观察 Remotion 播放时间 2→2→3 秒、播放持续，内部逐帧 epoch 未直接读取。N16-03 的 15 组宽窄视口与 Chrome 原生 200% 公开路由检查通过，仍因原型 SVG 图标商业许可、macOS/Safari 实机及已登录全站证据保持 `IN_PROGRESS`；晚间清单已登记权利确认。

## 下一步

### 2026-10-08 全局 Web 收尾补充

- 用户最新要求取消 Web 检查暂停，一口气继续全量 v0.4，完成后再统一交付。本轮已统一公开入口、Workspace、Studio、项目交付/分析、账单、团队和 Ops；媒体/作品内容保留原色，欢迎页与 Dashboard 不再展示虚构图表或假封面。
- N15-03 新增 workspace 限定项目/存储和 principal+ticket 限定支持授权安全投影，真实运营 MFA 浏览器脚本通过双 scope 拒绝、支持审计/Outbox、深浅主题、390 窄屏与原生 200%。仍缺生产独立复核/发布，因此保持 `IN_PROGRESS`。
- 最终 `pnpm verify` 于 19:01 exit 0：939/939 已实现断言；contract/e2e 仍为 `[PLANNED]`。全局 Web 证据见 `docs/verification/N16-global-web.md`，最终技术截图在 `.artifacts/global-ui-final/`、`.artifacts/n15-03-ops-ui/` 与 `.artifacts/n16-route-audit/`。
- 本机生产 Web 运行于 `http://127.0.0.1:4200/welcome`。后续按验收账本选择编号最小且依赖已满足的任务，不再等待用户逐页 UI 检查。

### 2026-10-08 19:01 全路由验收补充

- `scripts/verification/n16-02-real-session.mjs` 已扩展到公开 3 路由与登录后 18 路由，在 1440×900 浅色、1280×800 深色和 390×844 窄屏共完成 63 次页面检查；页面错误、告警、横向溢出和可见控件越界为 0，窄屏小于 32px 的可见触控目标为 0。移动导航与 Studio Inspector 共 5 次真实开合通过。
- 修复了窄屏创作输入越界、移动导航关闭与长账户信息、身份空态、最后一名 OWNER 保护和版本历史中文标题。人工查看 `.artifacts/n16-route-audit/authenticated-narrow-390/workspace-navigation.png` 与 `project-editor-inspector.png`，未发现新的裁切或重叠。
- 22:32 的最新 `pnpm verify` 为 Unit 372、Web 159、Motion 19、Integration 364、Security 24、Render 6、Golden 15，共 **959/959** 已实现断言。contract/e2e 仍为 `[PLANNED]`、0 断言。N01-04 已关闭并进入 N01-05；用户已取消 Web 检查暂停，整个 v0.4、D0/D1 和依赖未闭合的 N15/N16 任务仍没有被标为完成。

1. 以本文件末尾更新的最新 `pnpm verify` 和逐项验证文档为基线；953、950、939、937、879、893、916、929、933 是更早对照数。若再次重建 `.next`，重新核对并重启 4200 进程。
2. N00、N01-01—04 已 VERIFIED；从 N01-05 继续旧 Scene/audio/caption/version 的增量兼容、可重试回填与单写切换。必须先建立可比投影和失败恢复，再改变权威读取；禁止旧表和新 Composition 双写。用户需配合的外部账号、生产审批与设备事项集中在 `docs/handoffs/USER-ACTIONS-261008.md`，不逐项中断工程。
3. N16-02 账号偏好契约、持久化、Web 首屏和真实会话已验；N16-10 单色图表、320px 滚动与真实媒体同帧主题隔离已通过定向浏览器检查，但仍缺正式 ProjectDocument 内容 hash 的切主题前后对照。N16-03 继续图标权利/替代方案、macOS 与受保护路由缩放证据，D0/D1 未关闭。N15-02 独立身份/MFA 已验；N15-03 已有 0053—0055 权限与安全投影切片，生产旧 `/admin` 读写全关闭，独立复核和发布等剩余见单项交接。用户需配合的真实生产操作者、可信同人别名来源与独立复核人已集中登记，不阻塞当前可独立完成的工程。
