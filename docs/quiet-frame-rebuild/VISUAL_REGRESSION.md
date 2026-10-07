# Quiet Frame 视觉回归：可重复采集与证据边界

更新日期：2026-10-08。此文记录 **ANCS Web 实际页面** 与设计包原型在同一 Chromium 中的采集方法。参考原型截图、隔离示意数据下的实际应用截图、真实业务验证是不同证据；当前不宣称 18 个状态均已达到 1:1。

## 采集环境与文件

| 项目 | 固定值或位置 |
|---|---|
| 原始参考 | `docs/design-reference/quiet-frame/a04a074c62f0/ANCS_Quiet_Frame/screens/`，18 个状态；原始 ZIP 与解压副本只读 |
| 参考预览 | `http://127.0.0.1:4100/index.html#<route>`，无外部资源或 API |
| ANCS 应用 | 当前本地 Next 服务 `http://127.0.0.1:4000`，源自真实 Web 代码 |
| 工具 | `scripts/quiet-frame-visual.mjs`、`scripts/quiet-frame-diff.py`、`scripts/fixtures/quiet-frame-visual.json` |
| 浏览器 | Playwright Chromium 149.0.7827.55，Windows，中文环境、上海时区、固定时间 2026-10-07 12:00 +08、减少动效 |
| 视口 | 桌面 1600×1000/DPR 1.5；手机 390×844/DPR 2；缩放 100% |
| 输出 | `.artifacts/quiet-frame/<case>/<run-id>/`，Git 忽略；全页 PNG、首屏 PNG、metadata.json；比较模式再含 overlay/diff PNG |

输出不可覆盖；同一个 run ID 再次运行会报错。`metadata.json` 记录参考图 SHA-256、实际图 SHA-256、浏览器/字体、元素边界、网络与页面错误、夹具文件 SHA-256、已服务/阻止/未匹配的 API 请求。严格 RGB 差异脚本不裁切、不遮挡、不放宽阈值，尺寸缺失部分计入差异。像素差异适用于**同数据同状态**的比较；本示意夹具与原型演示内容不同，不能把差异率直接当作最终视觉验收值。

## 隔离夹具约束

私有页面使用 `--data-label isolated-fixture --fixture-id qf-synthetic-v1 --fixture-file scripts/fixtures/quiet-frame-visual.json`。夹具仅供视觉测试，`SYNTHETIC_VISUAL_ONLY` 标签和 `example.invalid` 用户明确标示来源。它不注入到生产应用，不写数据库，不持有真实 Cookie/Secret，不调用 Provider。

Playwright 只允许实际应用 origin 上的 GET 页面/静态资源通过。应用的 `/api/` 与列出的本地 API origin 统一拦截：精确匹配的 GET 返回夹具 JSON，预检 OPTIONS 返回 CORS 头；未匹配 API 返回 501 并在证据中列出。唯一允许的非 GET 是夹具中**精确路径、精确请求正文**的 `POST .../ai-edit/plan`；它在浏览器路由层直接返回标注的脚本化计划，绝不转发到 API，且只用于 QF-14 抽屉视觉。其它非 GET 与第三方流量均被阻止。若出现未匹配或阻止请求，脚本以非零退出。这样无法把真实开发数据库的值误录进示意截图，也不会因页面按钮误触发写入。夹具当前覆盖会话、一个工作区、三个项目、一个项目详情及 Scene Graph、示意叙事与来源、八张合成素材卡、身份/Render/发布/表现空态、Provider 设置空列表、预算零值；Master Narration 返回合法 `null`，Handoff 返回空列表；Finance 来源/模板/产物也是**空列表**，仅用于展开态布局检查。夹具的折线点只有抽象阶段和数值，标注“视觉测试示意 / 非真实业务数据”，仅在隔离浏览器里检查真实 Scene Component 的布局，不是事实图表或真实余额。

夹具通过 `sessionInfoSchema`、`workspaceWithRoleSchema`、`projectSchema`、`projectDetailSchema`、`sceneGraphSchema`、`billingStatusSchema`、`narrativePlanSchema`、`contentSourceSchema`、`assetSchema`、`editPlanSchema` 与 12 个场景的组件 props/时长校验。图表的 `src_visual_synthetic` / `ds_visual_synthetic` 仅是测试响应中的引用，没有数据库记录、来源许可或事实核验；合成素材也没有实际文件，`license` 一律为 `UNKNOWN`。因此它只满足 DTO/组件视觉采集，不可用于 Render、导出或业务验收。

## 已采集状态

18 个原型状态在 `.artifacts/quiet-frame/<case>/baseline-local-261007/` 各有一份同环境基准。最终 17 个状态在 `final-261008-d` 采集；QF-13 示例按钮接入真实动作后单独用 `final-261008-e` 复拍，初始页 2.53% 差异与前次完全相同。每个成功目录均有 `metadata.json` 与参考/实际/叠加/差异 PNG。逐状态路径、精确差异、可比性和剩余偏差见 [VISUAL_PARITY_REPORT.md](VISUAL_PARITY_REPORT.md)。

此次实际应用采集全部 18 页均为零横向溢出、零页面异常、零被阻止或未匹配的夹具 API。QF-13 公共页在未登录状态请求 session/workspaces 得到 401，属于预期认证边界。部分私有页面有 `ERR_ABORTED` 页面请求，已留在元数据中供复核。QF-14 仅对精确 AI 计划路径/正文做了一次脚本化 POST 响应；没有真实 Provider 或数据库写入。

差异算法曾用同源原型对自身比较得到 0 像素差异，这是工具自检，**不是 ANCS Web 视觉通过**。本轮 QF-12 公共首页与原型差异 1.27%；QF-01/QF-18 为 6.24%；QF-04/QF-16 因真实 Scene Component 与手绘示意图不同为 33.10%/42.37%；QF-10 移除额外卡片间距后为 3.49%，QF-13 补齐状态动作后为 2.53%。QF-07/08/09/17 因可信 Render、批准、发布及平台指标缺失，只能比较合法空态；新增安全阻断与真实业务说明使 QF-07/08 页面更长。像素值无通过阈值，不能扩大或缩小容差。

QF-05 复拍可见按类型和素材 ID 变化的图表/图片/波形/文档示意，且明确标“示意”；QF-13 复拍呈现原型中的主题/快捷键及两个状态动作。在实际 Chromium 点击“切换深浅色”，确认 `body.theme-dark=true`；点击“查看快捷键”，确认帮助对话框可见。两个状态动作分别打开只读冲突/声音授权说明：520px 原生 dialog 在 1600px 视口水平居中，Esc 与关闭按钮均可关闭，Esc 后焦点返回触发按钮；没有真实项目或授权提交。QF-10 扩展详情原生 dialog 也居中且可用 Esc/按钮关闭。这些只验证本地 UI 交互，权限与业务结果仍需独立验收。

QF-11 还按相同隔离夹具实拍“用量与预算”和“工作区与成员”两个内部标签，输出分别为 `.artifacts/quiet-frame/11-settings/settings-budget-261007/` 和 `settings-workspace-261007/`；390px 设置页见 `settings-mobile-261008-a`。Finance 在项目素材页展开态的桌面/390px 证据为 `.artifacts/quiet-frame/05-assets/finance-desktop-261008-a/`、`finance-mobile-261008-a/`，768px 导演时间轴证据为 `.artifacts/quiet-frame/16-mobile-director/director-768-261008-b/`。这些额外视口均无页面错误、横向溢出、未匹配 API 或写请求；它们没有独立原型截图，属于 `ADAPTED / NOT COMPARABLE` 布局证据，不计入 18 张参考图差异率。

### 不可直接像素等同的区域

- QF-01/15/18：原型封面题字、短句和底部项目标题分开配置；真实 `Project` DTO 只有单一 `title`，卡片封面按真实字段呈现。原型“编辑中/待确认”和场景时长是演示文案。
- QF-04/14/16：原型主体为手绘曲线及示意插画；真实 Web 使用注册的 `LINE_CHART` / `HOST_FULL` Scene Component。夹具图表数据明示为非真实业务示意，不用于 Render 或导出。原型第 3 场 32 秒超过当前 `LINE_CHART` 30 秒上限；夹具取合法 30 秒，总时长仍为 4:32。
- QF-05/08：真实页面的素材图与包装封面只是视觉示意，不代表拥有素材许可、真实视频帧或已批准成片。来源、许可和成片状态以服务端为准。
- QF-06/07/08/09/17：参考图包含演示声音/成片/批准/发布/表现数据；当前隔离夹具无合法成功态，故这些动态区域标为 NOT COMPARABLE。不得用伪造数据填充生产页面。
- QF-11：实际 Provider 设置包含完整配置表单，高于原型概览。要核验功能与权限，不能为了匹配像素隐藏真实配置能力。

## 可复现命令

先启动参考静态预览于 4100，并由项目负责人启动稳定的 Next 服务于 4000。不可在 Next 构建过程中采集。所有下列命令只读，服务端业务 API 被 Playwright 隔离。

```powershell
pnpm visual:qf --list
pnpm visual:qf --case 01-workspace --mode actual --actual-url http://127.0.0.1:4000/ --data-label isolated-fixture --fixture-id qf-synthetic-v1 --fixture-file scripts/fixtures/quiet-frame-visual.json --ready-selector .project-card --run-id dashboard-<unique>
pnpm visual:qf --case 04-director --mode actual --actual-url http://127.0.0.1:4000/w/ws_visual_fixture/p/prj_visual_01/storyboard --data-label isolated-fixture --fixture-id qf-synthetic-v1 --fixture-file scripts/fixtures/quiet-frame-visual.json --ready-selector '.scene-rail .scene-card' --actual-action '.scene-card:nth-of-type(3)' --after-action-selector '.viewer [data-scene-type="LINE_CHART"]' --run-id director-<unique>
pnpm visual:qf --case 11-settings --mode actual --actual-url http://127.0.0.1:4000/w/ws_visual_fixture/settings --data-label isolated-fixture --fixture-id qf-synthetic-v1 --fixture-file scripts/fixtures/quiet-frame-visual.json --ready-selector '.qf-provider-list .qf-provider-row' --run-id settings-<unique>
pnpm visual:qf --case 11-settings --mode actual --actual-url http://127.0.0.1:4000/w/ws_visual_fixture/settings --data-label isolated-fixture --fixture-id qf-synthetic-v1 --fixture-file scripts/fixtures/quiet-frame-visual.json --ready-selector '.qf-provider-list .qf-provider-row' --actual-action '.qf-setting-nav button:has-text("用量与预算")' --after-action-selector '.qf-metric-row' --run-id settings-budget-<unique>
pnpm visual:qf --case 16-mobile-director --mode actual --actual-url http://127.0.0.1:4000/w/ws_visual_fixture/p/prj_visual_01/storyboard --data-label isolated-fixture --fixture-id qf-synthetic-v1 --fixture-file scripts/fixtures/quiet-frame-visual.json --ready-selector '.scene-rail .scene-card' --actual-action '.scene-card:nth-of-type(3)' --after-action-selector '.viewer [data-scene-type="LINE_CHART"]' --viewport 768x900 --dpr 1.5 --run-id director-768-<unique>
pnpm visual:qf --case 10-extensions --mode actual --actual-url http://127.0.0.1:4000/w/ws_visual_fixture/extensions --data-label isolated-fixture --fixture-id qf-synthetic-v1 --fixture-file scripts/fixtures/quiet-frame-visual.json --ready-selector '.qf-pack-card' --actual-action '.qf-pack-card:first-child button' --after-action-selector 'dialog[open]' --run-id extensions-detail-<unique>
pnpm visual:qf --case 13-design-system --mode actual --actual-url http://127.0.0.1:4000/design-system --data-label public --ready-selector h1 --actual-action 'button:has-text("查看解决方式")' --after-action-selector 'dialog[open]' --run-id design-conflict-<unique>
pnpm visual:qf --case 13-design-system --mode actual --actual-url http://127.0.0.1:4000/design-system --data-label public --ready-selector h1 --actual-action 'button:has-text("查看授权流程")' --after-action-selector 'dialog[open]' --run-id design-consent-<unique>
pnpm visual:qf --case 13-design-system --mode compare --actual-url http://127.0.0.1:4000/design-system --data-label public --ready-selector h1 --run-id design-system-<unique>

# 设计包无独立原图的 Finance 展开态；仅用隔离空列表核查适配，不能当真实 Finance 成功
pnpm visual:qf --case 05-assets --mode actual --actual-url http://127.0.0.1:4000/w/ws_visual_fixture/p/prj_visual_01/assets --data-label isolated-fixture --fixture-id qf-synthetic-v1 --fixture-file scripts/fixtures/quiet-frame-visual.json --ready-selector 'text=市场关系示意图' --actual-action 'summary:has-text("Finance 图表素材")' --after-action-selector 'text=Finance Pack' --run-id finance-desktop-<unique>
pnpm visual:qf --case 05-assets --mode actual --actual-url http://127.0.0.1:4000/w/ws_visual_fixture/p/prj_visual_01/assets --data-label isolated-fixture --fixture-id qf-synthetic-v1 --fixture-file scripts/fixtures/quiet-frame-visual.json --ready-selector 'text=市场关系示意图' --actual-action 'summary:has-text("Finance 图表素材")' --after-action-selector 'text=Finance Pack' --viewport 390x844 --dpr 2 --run-id finance-mobile-<unique>
```

逐状态参数表（将上面命令的 `--case`、`--actual-url`、`--ready-selector` 替换；`compare` 模式同时产生参考/实际/叠图/diff）：

| 状态 | `--actual-url` 的路径 | 稳定选择器 / 附加动作 |
|---|---|---|
| 01、15、18 | `/` | `.project-card`；18 自动启用深色主题 |
| 02 | `/w/ws_visual_fixture/new` | `.import-tab:not([disabled])` |
| 03 | `/w/ws_visual_fixture/p/prj_visual_01/script` | `text=隔离视觉测试来源` |
| 04、16 | `/w/ws_visual_fixture/p/prj_visual_01/storyboard` | `.scene-rail .scene-card`；点击第三场 `.scene-card:nth-of-type(3)`；等候 `.viewer [data-scene-type="LINE_CHART"]` |
| 05 | `/w/ws_visual_fixture/assets` | `text=市场关系示意图` |
| 06 | `/w/ws_visual_fixture/identity` | `text=旁白风格示意` |
| 07、17 | `/w/ws_visual_fixture/p/prj_visual_01/render` | `text=还没有渲染。建议先运行预检。` |
| 08 | `/w/ws_visual_fixture/p/prj_visual_01/publish` | `text=尚无发布记录。` |
| 09 | `/w/ws_visual_fixture/p/prj_visual_01/analytics` | `text=还没有复盘建议` |
| 10 | `/w/ws_visual_fixture/extensions` | `.qf-pack-card` |
| 11 | `/w/ws_visual_fixture/settings` | `text=这个类别还没有 BYOK 连接。`；预算/工作区标签可另拍 |
| 12、13 | `/welcome`、`/design-system` | `h1`，`--data-label public`，不用夹具 |
| 14 | `/w/ws_visual_fixture/p/prj_visual_01/storyboard` | `.scene-rail .scene-card`；先点第三场 `.scene-card:nth-of-type(3)`，再点 `button:has-text("缩短当前旁白")`；等候 `[data-testid="ai-edit-plan"]`；AI 计划 POST 仅返回脚本化示意 |

上述私人页面选择器仅用于等待夹具数据出现；截图后仍须检查 `metadata.json` 中是否有未匹配/阻止请求与页面异常。QF-07、08、09 的 Render、批准、发布和平台表现保持空态，不能和原型中伪造的完成或数值像素等同。

界面中的零 Credits、示意项目和 12 个隔离场景只证明页面按 API DTO 展示与响应式布局可检查。鉴权、权限、持久化、Provider 调用、实际付费、Render 和发布仍以各自的集成/端到端证据为准。18 状态已逐页实拍并建立偏差清单；最终视觉验收还需处理可修偏差和真实业务状态，并由用户检查。
