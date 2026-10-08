# v0.4 UI 交付覆盖

此表只记录正在推进的用户可见切片；全部 N 任务及依赖仍以 [`ai-native-v04-acceptance-ledger`](../requirements/ai-native-v04-acceptance-ledger.md) 为准。`VERIFIED` 须满足 [`UI 交付规约`](ui-delivery-contract.md) 和单项真实证据。

| 任务/需求 | 用户入口与目标 | 设计来源/覆盖 | 组件与关键状态 | 业务/浏览器证据 | 状态 |
|---|---|---|---|---|---|
| N00-05 / V03-06/60/64 | `/w/:workspaceId/settings` →“新能力”；Owner/Admin 选择工作区希望启用的 v0.4 能力，成员查看真实有效状态 | [交付卡](features/N00-05.md)；沿用设置页结构，扩展五个发布门状态；旧高保真无对应控件，按现有 Token 新增 | `FeatureSettings`；加载、错误、OFF、等待发布门、ENABLED、只读角色；服务端有效状态权威 | [验证](../verification/N00-05.md)：0056 + 隔离库跨租户/旧项目回归；Chromium 浅色桌面、深色小桌面、390px 窄屏完成 GET→选择→PUT→重新读取，3 张截图已人工查看 | VERIFIED |
| N16 跨页面工作包 / V04-52—63 | 现有 21 个 Web 路由；全站按 v0.4 黑白语义 Token 对齐，媒体保色 | [交付卡](features/N16-global-web.md)；Quiet Frame 01/13/18 已目检；共享壳层、公开入口、Workspace、Studio、交付、分析、账单、团队和 Ops 已定点迁移 | `StudioShell`、公共 Token、`Monochrome.module.css`、状态/导航/表格/抽屉；身份空态、OWNER 保护、长文本、窄屏触控、主题/焦点/200% | [全局证据](../verification/N16-global-web.md)：21 路由 × 3 环境，63 次真实页面检查；窄屏导航和 Studio Inspector 5 次交互；真实会话/播放、媒体同帧及原生 200% 均通过，截图已人工查看。现有 Web 切片可交用户检查；Safari/macOS、图标权利及尚未落地的 N16 功能仍待后续任务 | IN_PROGRESS |
| N15-03 / V04-27/28/29 | `/admin`；授权运营人员按工作区查看安全诊断，支持人员按工单查看自己的限时授权 | v0.4 §28/§29；原 Quiet Frame 包无运营台图，按当前 Token **新增**紧凑只读诊断区；旧失效写控件从可用流程中**替代** | `OpsSessionPanel`、工作区诊断/支持授权；空、加载、无权、过期、失败、结果与作用域切换 | [交付卡](features/N15-03.md)；隔离库 5 文件 23/23；真实 MFA + Fastify + Next 浏览器覆盖 1440 浅色、1280 深色、390 窄屏、原生 200%、跨 scope 拒绝及支持访问审计；截图已人工查看 | IN_PROGRESS |
| N16-03 / V04-55/56/62 | Web 排版、图标与缩放；覆盖公开与真实登录路由 | v0.4 §29、Quiet Frame 参考包；沿用系统字体，扩展字阶与窄屏 | 公共排版 Token、QuietIcon；窄屏/200%/长中英混排 | [证据](../verification/N16-03.md)：公开、脚本化和真实登录 Chrome 200%；图标权利/macOS 待确认 | IN_PROGRESS |
| N02-01 / V03-08/09/53 | `/w/:workspaceId/p/:projectId/assets` →“上传素材”；创作者批量上传并在网络波动时暂停、继续或取消 | [交付卡](features/N02-01.md)；扩展现有素材 Modal 和黑白 Token，新增紧凑文件队列 | `DeliveryAssets`、SDK resumable upload；排队、上传、暂停、失败、完成、取消、长文件名与窄屏 | [验证](../verification/N02-01.md)：0064 + 真实 DB/Fastify/LocalSignedStorage/production Next；真实 MP4 多选、排队取消、在途暂停继续并 READY；1440 浅色、1280 深色、390 深色截图已查看 | VERIFIED |
