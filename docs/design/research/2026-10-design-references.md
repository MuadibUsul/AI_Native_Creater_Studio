# 设计资源研究报告（2026-10-14）

> 用途：为 ANCS 界面精修（`docs/design/ui-refresh-2026-10.md`）提供有出处的设计依据。
> 方法：在云端容器里用真实 Chromium（Playwright，1440×900，深色偏好）逐站打开首页与指定文档页，截取首屏与滚动后画面，并在页面内读取**计算后的样式**（字体、字号、颜色、圆角、阴影、过渡时长与曲线、`prefers-reduced-motion` 规则数量）。下文的数字都来自这次读取，不是记忆或推测。
> 版权：第三方页面截图只留在本地临时目录用于分析，**不进仓库**；本报告只引用链接、可观察的规律和测得的数值，不复制任何设计资产。

## 1. 访问情况（如实标注）

| 站点 | 结果 | 说明 |
|---|---|---|
| https://www.obsidianui.dev | ✅ 已访问 | 首页、`/components` |
| https://mobbin.com | ✅ 仅公开首页 | 截图库需要登录，**未浏览**具体 App 界面与流程 |
| https://godly.website | ✅（跳转） | 301 跳转到 https://recent.design（同一作者的新站），按 recent.design 分析 |
| https://www.awwwards.com | ❌ 未能访问 | 连接被对端重置（curl 35 / `ERR_CONNECTION_RESET`），网络放开为 full 后仍然如此 |
| https://refero.design | ✅ 仅公开首页 | 研究模式与截图库需要登录，未浏览具体案例 |
| https://pageflows.com | ❌ 未能访问 | Cloudflare 人机验证（`cf-mitigated: challenge`），不是网络白名单问题 |
| https://detail.design | ✅ 已访问 | 首页与若干细节页 |
| https://www.motionvault.dev | ✅ 已访问 | 首页（大部分条目的视觉引用显示 "Visual reference unavailable"） |
| https://rive.app | ✅ 已访问 | 首页、状态机文档页 |
| https://motion.dev | ✅ 已访问 | 首页、Transitions / Accessibility / Layout animations 文档 |
| https://www.21st.dev | ✅（跳转） | 308 到 https://21st.dev |
| https://ui.shadcn.com | ✅ 已访问 | 首页、Toggle Group、Sonner 文档 |
| https://www.radix-ui.com | ✅ 已访问 | 首页、Toggle Group / Slider / Accessibility 文档 |
| https://www.framer.com | ✅ 已访问 | 首页 |
| https://www.figma.com/community | ✅ 已访问 | 社区首页（未登录） |
| https://www.designsystems.com | ✅ 已访问 | 首页 |
| Apple（HIG） | ✅ 已访问 | Motion、Dark Mode、Layout、Toolbars、Feedback 五页 |
| Linear | ✅ 已访问 | 官网首页、《How we redesigned the Linear UI (part Ⅱ)》 |
| Raycast | ✅ 已访问 | 官网首页、Blog 列表 |
| Figma 编辑器 | ⚠️ 未使用 | 没有账号，只看了官网；文中关于 Figma 画布交互的内容标注为"产品常识，未在本次访问中验证" |

## 2. 测得的数值（计算样式摘要）

| 站点 | 正文字体 | 背景 / 正文 / 次级文字 | 按钮圆角 | 交互过渡 | 曲线 | reduced-motion 规则数 |
|---|---|---|---|---|---|---|
| Linear | Inter Variable | `rgb(8,9,10)` / `rgb(247,248,248)` / `rgb(138,143,152)` | 导航胶囊 9999px；另有 8 / 4 / 12px | 0.1s（50 处）、0.16s | `cubic-bezier(.25,.46,.45,.94)`、`ease` | 9 |
| Raycast | Inter | `rgb(7,8,10)` / 白 | 8px，按钮带 2px 暗环 + 内高光 | 0.2–0.3s | `ease` | 10 |
| detail.design | Geist | `rgb(9,9,11)` / `rgb(250,250,250)` / `rgb(161,161,170)` | 胶囊 | 0.15s | `cubic-bezier(.4,0,.2,1)` | 1 |
| ObsidianUI | Inter | 纯黑 / `lab(98)` | 999px；卡片 8 / 4 / 10px | 0.15–0.2s | `ease` | 34 |
| shadcn/ui | Geist | 深色 / 白 | 8 / 10 / 18 / 24px | 0.15s、0.2s | `cubic-bezier(.4,0,.2,1)` | 2 |
| Radix | untitledSans | 深色 | 4 / 3 / 6px | — | — | 8 |
| recent.design（原 Godly） | Inter 13px | 白 / `oklch(.15 0 0)` | 9999px，控件高 28px | 0.12s、0.18s | `cubic-bezier(.2,0,0,1)` | 0 |
| MotionVault | Plus Jakarta Sans | 暖白 `rgb(248,247,244)` | 999px 分段导航；卡片 8 / 12px | 0.15s、0.28s | `cubic-bezier(.16,1,.3,1)` | 1 |
| 21st | General Sans | `oklch(.141)` / `oklch(.968)` | 胶囊 / 6 / 12px | 0.15s、0.3s、0.2s | `cubic-bezier(.4,0,.2,1)`、`cubic-bezier(.23,1,.32,1)` | 15 |
| motion.dev | TASA Orbiter | 墨绿黑 / 米白 | 直角 | 0.2s、0.14–0.18s | `ease`、`cubic-bezier(.25,1,.5,1)`、`cubic-bezier(.16,1,.3,1)` | 13 |
| Mobbin | saans | 白 / `rgb(20,20,20)` / `rgb(112,112,112)` | 32 / 20 / 12px | 0.15s | `cubic-bezier(0,0,.2,1)` | 11 |
| Refero | Base | `rgb(16,18,22)` / 白 | 8 / 12 / 24px | 0.2s | `ease` | 3 |
| Figma 官网 | figmaSans | 白 / 黑 | 2 / 9999 / 24px | 0.18s | `ease-out` | 3 |
| Apple HIG | SF Pro | 黑 / `rgb(245,245,247)` / `rgb(134,134,139)` | 卡片 18px | 0.32s | `cubic-bezier(.4,0,.6,1)` | 2 |

## 3. 逐站提炼：有效在哪、适合什么、局限在哪

**展示型 vs 工作台型**：ObsidianUI、Raycast、Framer、motion.dev、Rive、Mobbin 的首屏是营销展示（超大标题、光晕、渐变、品牌色块），目的是"让人停下来"；ANCS 的共看片室是每天反复使用的**工作台**，目的是"让人不分心地改片"。下面只把与工作台相容的规律带进来，展示型手法一律不进产品界面（也违反 v0.4 §29 的禁用项：装饰渐变、霓虹、装饰性模糊）。

1. **Linear（官网 + 改版文章）**
   - 有效：改版文章明确写了三件事——减少应用"外框"（chrome）的视觉噪音、把标签/图标/按钮横竖对齐、提高内容对比（浅色下文字和中性图标更深、深色下更亮）；配色回到"中性、耐看"，限制品牌色在计算里的参与；层级主要靠黑白透明度区分（底、前景、面板、对话框、模态）。
   - 适用：ANCS 顶栏与底部停靠区（dock）就是"外框"；时间带、片段、对话是"内容"。
   - 局限：Linear 用 LCH 从 3 个变量生成全部主题（含高对比主题），我们的 token 是逐值定死并有静态对比测试，暂不引入生成系统。
2. **Raycast**：按钮用"暗环 + 1px 内高光"做出浮起感，深色背景 `rgb(7,8,10)` 接近而非纯黑。→ 深色 `ui.shadow` 采用 1px 内高光 + 暗阴影；不采用其品牌红色光带（展示型）。
3. **detail.design**：收集"小决定"——智能断词（界面要经得起翻译）、点标签聚焦输入框、按住 ⌘ 显示快捷键提示（"列表教一次，按住每次都教"）、按已填内容给占位提示、平台无关的快捷键标签、平滑圆角变形动画。→ 本轮落地：中文禁则断行（`line-break: strict`）、标题 `text-wrap: balance`、正文 `text-wrap: pretty`；快捷键提示列入第二阶段。
4. **ObsidianUI**：深色组件库，胶囊按钮（999px）、`⌘K` 搜索入口、34 条 reduced-motion 规则——说明"动效多"与"可关闭"可以并存。局限：首屏 glow、模糊、超大字号是展示型。
5. **shadcn/ui + Radix**：组件状态通过 `data-state` 暴露、Toggle Group 有完整键盘模型（Tab 进组落在已按下项、方向键移动、Space/Enter 切换、Home/End）。→ 制作规则开关组按 Toggle Group 的语义组织（`role="group"` + `aria-pressed`）；方向键漫游列入第二阶段（目前 Tab 逐个可达）。
6. **motion.dev（文档）**：默认过渡是"动态"的；reduced motion 的正确做法是**保留有教育意义的过渡、去掉大元素位移/视差/自动播放，用透明度替代**。→ 我们的 reduced-motion 把时长 token 归零，脉冲点改为静止。
7. **recent.design（原 Godly）/ MotionVault / Mobbin / Refero（公开页）**：筛选与导航普遍是胶囊 + 分段控件，选中项"浮起"（白底 + 阴影）而不是换色；计数、元数据常用等宽字体（MotionVault 的 "9,617 designs"、Linear 的 "FIG 0.1"）。→ 时间码、刻度改等宽数字；制作规则改为分段浮起样式。
8. **Rive（状态机文档）**：动画由"状态 + 转换"驱动，而不是时间轴脚本。→ AI 状态（聆听 / 处理 / 试改 / 采用 / 撤销）用同一套状态到样式的映射，不为每个状态单写动画。
9. **Apple HIG**：Motion——有目的、短、可打断，频繁交互不要加动效；Feedback——状态信息就近、被动呈现，警告才打断；Dark Mode——深色不是浅色的反相、基础层与浮起层两套底色、自定义颜色对比至少 4.5:1、小字争取 7:1，**沉浸式看媒体的界面可以只用深色**。→ 看片区垫底在浅色主题下仍保持 `ui.media.matte`（与 v0.4 token 一致），但做成内嵌"屏幕"而不是贯穿全宽的黑块。
10. **Framer / Figma 官网 / designsystems.com / 21st**：营销与目录型页面，提供排版与卡片节奏参考；不提供工作台交互依据。Figma 画布的选区、工具状态、对象就近操作属于产品常识，本次没有在其编辑器里验证。

## 4. 汇总成可执行的设计规律

| # | 规律 | 依据（本次访问） | ANCS 落地 |
|---|---|---|---|
| R1 | 反馈过渡 100–200ms，ease-out 族曲线 | Linear 100/160ms、shadcn 150ms、recent 120/180ms、21st 150ms | 保留 120/150/200ms，新增 `--ui-ease-standard/enter/exit` |
| R2 | 层级靠中性明度和阴影，不靠色相 | Linear 改版文章、Apple Dark Mode base/elevated | 深色层级加深 + `--ui-shadow-1/2/3` |
| R3 | 选中 = 浮起（底色 + 阴影 + 文字加深），不是换颜色 | MotionVault 分段导航、shadcn、recent | 制作规则开关组、按下状态 |
| R4 | 数字/时间码用等宽 | MotionVault、Linear、motion.dev | `--ui-font-mono` 用于时钟与刻度 |
| R5 | 动效可关闭，关闭时保留透明度/颜色，去掉位移 | motion.dev Accessibility、各站 reduced-motion 规则 | 时长 token 归零、脉冲静止 |
| R6 | 主题切换瞬时完成 | Apple"不要让人等动画" | 切换外观时暂停过渡两帧 |
| R7 | 外框减噪，内容加对比 | Linear 改版 | 顶栏/停靠区与房间同底；分组与分隔线代替一排同权按钮 |
| R8 | 状态就近、被动；警告才打断 | Apple Feedback | AI 处理中的脉冲点在对话行内；报价卡在对话层级 |
| R9 | 键盘模型可预期 | Radix Toggle Group | 规则开关组语义已就绪；方向键漫游列入下一阶段 |
| R10 | 文字排版要经得起翻译 | detail.design | 中文禁则、平衡标题、`text-wrap: pretty` |

## 5. 参考链接

- Linear 改版文章：https://linear.app/now/how-we-redesigned-the-linear-ui
- Apple HIG：https://developer.apple.com/design/human-interface-guidelines/motion 、…/dark-mode 、…/feedback 、…/toolbars 、…/layout
- Radix Toggle Group：https://www.radix-ui.com/primitives/docs/components/toggle-group
- shadcn Toggle Group：https://ui.shadcn.com/docs/components/toggle-group
- Motion 无障碍：https://motion.dev/docs/react-accessibility ；过渡：https://motion.dev/docs/react-transitions
- Rive 状态机：https://rive.app/docs/editor/state-machine/state-machine
- detail.design：https://detail.design （如 https://detail.design/detail/hold-to-reveal-shortcut-hint ）
- 其余：https://www.obsidianui.dev 、https://recent.design 、https://www.motionvault.dev 、https://mobbin.com 、https://refero.design 、https://21st.dev 、https://www.framer.com 、https://www.figma.com/community 、https://www.designsystems.com 、https://www.raycast.com
