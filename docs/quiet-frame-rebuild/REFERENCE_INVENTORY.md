# Quiet Frame 参考包盘点

审查日期：2026-10-07。本文记录原始设计交付物的实盘结果，不代表现有 Web 已完成重构或通过视觉验收。

## 来源、完整性与只读副本

| 项目 | 核验结果 |
|---|---|
| 项目根目录 | `仓库根目录` |
| 原始 ZIP | `docs/ANCS_Quiet_Frame_Design_Package.zip`，9,575,868 字节；保留原件，未修改 |
| ZIP SHA-256 | `a04a074c62f03dcb09f9aa94aa22f2861740a808e9872312501dd8871cb2ed4a` |
| ZIP 完整性 | Python `zipfile.testzip()` 返回 `None`；33 个文件条目、总展开大小 9,962,387 字节；无目录穿越、绝对路径、符号链接或大小写重名路径 |
| 包内交付清单 | `handoff/DELIVERY_MANIFEST.json` 列出的其他 32 个文件均存在，SHA-256 全部一致；清单自身未列入自身 |
| 独立参考目录 | `docs/design-reference/quiet-frame/a04a074c62f0/ANCS_Quiet_Frame/`；33 个解压文件均标为 Windows 只读 |
| 原型入口 | `docs/design-reference/quiet-frame/a04a074c62f0/ANCS_Quiet_Frame/index.html`；浏览器 hash 路由，静态服务只需提供本目录 |
| 审查时 Git 基线 | `main @ 2fa881db7a9d024a03b5077f197f7cedbbeea194`；原始 ZIP 为未跟踪文件。此项只记录审查时状态，后续以实时 `git status` 为准 |

文件分类：20 张 PNG（18 张状态截图、2 张总览）、5 个 JSON、4 个 Markdown、2 个 Python 参考脚本、1 个 HTML 原型、1 个 CSS token 文件。原型的样式、行为及 SVG 图形主要内嵌于 `index.html`；没有独立生产素材、字体文件、视频、音频或独立 SVG 文件。包内 `handoff/capture_screens.py` 与 `handoff/verify_prototype.py` 是旧原型脚本，盘点时未执行。

预期名称核对：`DESIGN_REVIEW_AND_SPEC.zh-CN.md`、`handoff/IMPLEMENTATION_HANDOFF.md`、`screens/`、`handoff/` 均存在。`ANCS_Quiet_Frame_Prototype.html` 不存在；实际可用原型名为 `index.html`，不可创建同名替身。

## 页面和原始截图

原始对应关系以 `handoff/SCREEN_MANIFEST.json` 为准。桌面截图来自 **1600 × 1000 CSS px、DPR 1.5**；手机截图来自 **390 × 844 CSS px、DPR 2**。截图为全页输出，物理像素高度可大于视口。以下均位于参考目录的 `screens/` 下。

| ID | 页面或状态 | 原型入口/状态 | 原始截图 | PNG 物理尺寸 |
|---|---|---|---|---|
| QF-01 | 创作台 | `index.html#home` | `01-workspace.png` | 2400 × 1521 |
| QF-02 | 新建作品 | `index.html#new` | `02-new-project.png` | 2400 × 1500 |
| QF-03 | 脚本与来源 | `index.html#script` | `03-script.png` | 2400 × 1601 |
| QF-04 | 导演工作台 | `index.html#editor` | `04-director.png` | 2400 × 1500 |
| QF-05 | 素材库 | `index.html#assets` | `05-assets.png` | 2400 × 1721 |
| QF-06 | 创作者身份 | `index.html#identity` | `06-identity.png` | 2400 × 1500 |
| QF-07 | 成片与审核 | `index.html#render` | `07-review.png` | 2400 × 1608 |
| QF-08 | 交付与发布 | `index.html#publish` | `08-publishing.png` | 2400 × 1539 |
| QF-09 | 作品表现 | `index.html#analytics` | `09-analytics.png` | 2400 × 1658 |
| QF-10 | 扩展工具 | `index.html#extensions` | `10-extensions.png` | 2400 × 1500 |
| QF-11 | 服务与设置 | `index.html#settings` | `11-settings.png` | 2400 × 1679 |
| QF-12 | 产品首页 | `index.html#welcome` | `12-landing.png` | 2400 × 1635 |
| QF-13 | 设计系统 | `index.html#system` | `13-design-system.png` | 2400 × 1721 |
| QF-14 | AI 修改差异与确认抽屉 | `index.html#editor` + 抽屉 | `14-ai-diff.png` | 2400 × 1500 |
| QF-15 | 手机创作台 | `index.html#home`，390 × 844 | `15-mobile-workspace.png` | 780 × 3674 |
| QF-16 | 手机导演工作台 | `index.html#editor`，390 × 844 | `16-mobile-director.png` | 780 × 1746 |
| QF-17 | 手机成片审核 | `index.html#render`，390 × 844 | `17-mobile-review.png` | 780 × 3264 |
| QF-18 | 深色创作台 | `index.html#home` + dark | `18-dark-workspace.png` | 2400 × 1521 |

另外两张总览是 `ANCS_Quiet_Frame_Overview.png`（2400 × 1390）和 `ANCS_Mobile_Overview.png`（1500 × 1250）；它们是排版后的概览，不可代替逐页原始截图。

### 原始截图未覆盖的可交互状态

- 弹窗/抽屉：命令搜索、工作区切换、通知、版本历史、来源、素材详情、版本冲突、添加分镜、生成成本确认、规格选择、审核退回、导出闸门、发布能力、手机交接、声音授权和样本要求、品牌外观、服务配置、设置子页、扩展启用。AI 差异抽屉有 QF-14 截图，其余没有独立原图。
- 响应式：手机原图只覆盖创作台、导演工作台和成片审核；其余 10 个主页面的手机状态、平板与中间断点没有原图。包内旧 QA 声称检查 320、390、768、1280、1600 宽度，需重新运行并自行拍摄基准。
- 主题：深色原图只有创作台。其他 12 个主页面以及弹层的深色状态没有原图。
- 业务状态：加载、空、失败、未登录、无权限、只读/锁定、版本冲突、费用不足、Provider 不可用、渲染失败、QA 阻断、发布结果未知等在设计说明中提出；大多数没有单独静帧。实现时需明确标为“参考未提供的适配状态”，不能伪称逐图还原。
- hover、focus-visible、disabled、selected、expanded、拖拽等微状态没有独立截图，须从原型 CSS 与实际交互获取。

## 原型交互与真实业务边界

可运行原型含 13 个 hash 页面。主路径为创作台 → 新建 → 脚本 → 导演 → 成片审核 → 交付。可操作项包括两级导航、Ctrl/⌘+K 搜索、Esc/焦点返回、移动导航、深浅色切换；URL/粘贴/本地 `.txt` 或 `.md` 导入标签；脚本锁定、来源抽屉与 AI 差异确认；场景选择、检查器、轻时间线、冲突弹窗；素材筛选/搜索/详情；声音试听与授权说明；规格、成本确认、QA/批准或退回；交付能力分级与导出闸门；作品表现建议；扩展与设置弹层。

静态审查确认：`index.html` 只有一个内嵌 `<style>` 和一个内嵌 `<script>`，没有外链 JS/CSS、iframe、外部图片或网络请求代码；CSS 使用本地 data URI SVG，图形还含内联 SVG。页面会把输入、作品名、脚本、主题与演示批准状态存到浏览器 `localStorage` 的 `ancs-quiet-frame` 键。文件选择仅在本地读取不超过 2 MiB 的 `.txt/.md`；浏览器系统语音用于试听；示例下载通过本地 Blob 生成 TXT。静态预览服务宜仅监听 `127.0.0.1`，且不要在原型中输入敏感资料。

原型项目、指标、图形、声音选项、成片和版本均为明确标注的演示内容。它不接真实 API，不生成视频，不抓取输入的 URL，不运行真实 QA/付费生成/OAuth/发布。原型的本地批准、上传、扩展安装及设置反馈不得搬入真实产品冒充成功。

## 视觉变量和冲突

精确还原时优先取对应状态的 `index.html` CSS/DOM 与原始截图。`handoff/tokens.json`、`handoff/tokens.css` 是设计变量建议，不应覆盖原型中不同的实际值。

| 类别 | 浅色设计值 |
|---|---|
| 背景 / 面板 / 导航 | `#F6F6F4` / `#FFFFFF` / `#EEEFED` |
| 主文 / 次文 / 分隔线 | `#202322` / `#646B68` / `#E1E4E0` |
| 强调 / 浅强调 | `#1768B2` / `#EAF3FC` |
| 成功 / 警告 / 危险 | `#34735B` / `#8B641E` / `#A23A3A` |
| 字体栈 | `-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif`；未附字体文件 |
| 字号层级 | 标题 36/1.25/600，分区 23/1.4/600，正文 14/1.7，辅助 12/1.6；营销标题另按原型 CSS |
| 间距与圆角 | 4/8/12/16/24/32/40/48/64 px；控件 8、面板 16、对话框 18 px |
| 布局 | 桌面导航 208、分镜栏 198、检查器 277、桌面边距约 48、手机边距约 22 px |
| 动效 | 反馈约 160 ms、抽屉约 220 ms、`cubic-bezier(.2,.7,.2,1)`；遵守 `prefers-reduced-motion` |
| 原型 CSS 断点 | 1800、1250、1050、760、360 px，另有 1101 px 特定规则；以 CSS 实际选择器为准 |

**包内冲突 A：深色 token 与可运行原型不同。** `handoff/tokens.css` 的深色背景/面板/导航/强调色为 `#171D19` / `#202923` / `#1D261F` / `#9DC8F1`；`index.html` 的 `.theme-dark` 为 `#1E2320` / `#272E28` / `#171E18` / `#91BFEA`。深色视觉基准应先用原型实际 CSS 与 `screens/18-dark-workspace.png`，并在差异记录中登记此冲突，不能直接导入 handoff token 后称为 1:1。

## 现有验证报告的适用范围

包内 `handoff/QA_REPORT.md/json` 报告的是旧原型检查：28 项行为/完整性检查、13 页面 × 5 宽度的 65 组布局检查。它们只是设计交付物的历史证据，**不是本次在 ANCS Web、真实 API 或 Worker 上执行的结果**。本次视觉截图、业务回归与命令退出码须在重构过程中另行生成和记录。
