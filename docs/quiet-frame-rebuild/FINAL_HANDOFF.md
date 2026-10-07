# Quiet Frame Web 重构交付说明

更新：2026-10-08。当前分支：`codex/quiet-frame-rebuild`。本轮工作限于现有 ANCS Web 的设计迁移与业务接线；按用户要求，Web 交付后暂停，待用户亲自检查测试，再决定是否推进 P15、P16。开发库旧业务数据的恢复也按用户指示留待之后处理。

## 交付范围

- 原始设计包 `docs/ANCS_Quiet_Frame_Design_Package.zip` 保持不变，SHA-256 与 33 个文件清单见 `REFERENCE_INVENTORY.md`；只读参考目录为 `docs/design-reference/quiet-frame/a04a074c62f0/ANCS_Quiet_Frame/`。
- 将 Quiet Frame 的 token、SVG 图标、外壳、导航、搜索、主题和响应式布局迁移到现有 Next Web。18 个原型状态均映射到真实页面或状态；独立历史、管理、登录等无原图页面仍有入口。双向功能去向见 `ROUTE_AND_FEATURE_MAP.md`。
- 创作台、新建作品、脚本、导演工作台、素材、身份、成片审核、交付发布、作品表现、扩展、设置、团队、账单、产品首页和设计系统已使用现有 SDK/API 数据形状。Director 空图先预览候选与费用信息，再由用户确认；AI 修改先看差异再提交。Finance 制作放在项目素材页的独立展开区，不遮蔽作品表现。
- 当前 Web 只显示真实业务状态或明确空态，不把原型中的播放量、成片、声音、批准和发布成功数据放入产品默认页面。截图专用 DTO 只在 Playwright 网络拦截中存在，标记 `SYNTHETIC_VISUAL_ONLY`。
- QF-13 设计系统的三个示例动作已可点击：有工作区时“开始创作”“生成草稿”均进入当前工作区新建页；无工作区时进入创作台选择工作区。“取消”只说明此页无待取消操作，不提交业务请求。

## 可检查入口

本机服务运行时，打开 `http://127.0.0.1:4000/welcome` 查看产品首页，或 `http://127.0.0.1:3000/welcome` 直连 Next。登录后进入创作台；原型只读预览为 `http://127.0.0.1:4100/index.html`。端口仅是这台机器当前会话的配置，重启后应以实际服务输出为准。

从源码重启：先按仓库 README 启动本地 PostgreSQL 与 API，并提供本地环境配置；执行 `pnpm install`、`pnpm build`，再执行 `pnpm --filter @ancs/web start`。Web 的 `/api/v1` 同源请求由 Next 代理至本地 API。不得把截图夹具作为 API 数据装入开发库。

## 验证方法和证据

1. 最新源码的 `pnpm verify` **退出码 0**，secrets、lint、typecheck、build、架构与各项已实现测试均通过；其中 Web 为 27 文件、138/138 项通过。证据见[最终验证日志](../../.artifacts/quiet-frame-rebuild/verify-final-261008-e.log)。测试库必须显式设置 `ANCS_TEST_DATABASE_URL`，数据库名包含 `test`；不要对 `ancs_dev` 运行集成套件。`[PLANNED]` 套件不执行断言，不算通过。
2. `pnpm visual:qf --list` 列出 18 个设计状态；采集与复拍命令见 [视觉运行说明](VISUAL_REGRESSION.md)，逐项结果和证据链接见 [视觉对照报告](VISUAL_PARITY_REPORT.md)。最终 17 个状态为 `final-261008-d`，QF-13 新动作后的复拍为 `final-261008-e`；初始页差异仍 2.53%，未登录状态下两个入口均实际点击至创作台，取消只显示说明。另有五页 × 五种宽度的 25/25 合成数据响应式审计，整页横向溢出及所识别主操作裁切均为 0。截图与 diff 在本地忽略目录 `.artifacts/quiet-frame/`，不随 Git 提交。
3. 最新源码 browser smoke **退出码 0**：登录→工作区→作品→粘贴正文→刷新→Mock LLM 脚本→深链接→持久化核对，加 11 个次级路由全部 PASS，0 `pageerror`、0 hydration 错误。证据为[运行日志](../../.artifacts/quiet-frame-rebuild/browser-smoke-final-261008-c.log)和[主链路截图](../../.artifacts/quiet-frame-rebuild/browser-smoke/qf-smoke-3614b8ed-d968-4e1b-9241-80118fb206f4.png)，同名 `-routes/` 目录有 11 张路由图。Mock LLM 与本地对象存储不能代替真实 Provider 或发布；各功能层级边界见 [功能回归报告](FUNCTIONAL_REGRESSION_REPORT.md)，逐项未验收范围见 [交互矩阵](INTERACTION_QA_MATRIX.md)。

## 尚未验收或依赖后端的事项

- 18 个设计状态已有同环境截图，但演示数据与合法真实空态不同，不能宣称像素级 1:1 全部通过。逐项剩余视觉偏差与待用户确认的设计/业务差异见 `VISUAL_PARITY_REPORT.md`、`ACCEPTED_DEVIATIONS.md`。
- 新 Render 的 Web 提交保持关闭：当前预检只有 QA 报告，缺少可信报价、预算及 Provider 可用性确认。现有 Render 的状态、QA、批准、导出入口仍按服务端闸门工作。
- Master Narration 的当前 POST 是同步 TTS，尚缺付费生成所需报价、Credits 预留、成本任务和并发幂等。Voice Clone 付费训练/重试及 Provider 删除同样等待后端费用与所有权/版本原子校验；Web 已显示安全限制及已有生命周期的受控操作。
- 真实第三方 Provider、平台发布、付款、完整 Render→批准→交付链路未在本轮执行。Mock LLM、本地存储、SDK 替身和视觉 DTO 各有独立证据边界，不能推断为真实外部服务通过。
- 先前误用开发库的集成测试删除了旧业务行；代码未丢失。未找到本地可用备份，恢复工作已按用户要求延后。事故与测试库防复发见 `docs/verification/QUIET-FRAME-BASELINE.md`。

本轮不会自动推送、部署、触发付费 Provider 或推进 P15/P16。当前是否接受上述视觉与功能待验项，由用户在检查 Web 后决定；未获确认的偏差均保留 `PENDING`。
