# ANCS 界面精修 2026-10：审计、设计系统、方案与交付

> 背景：项目所有者要求研究一组全球设计资源，在现有 Monochrome 体系内系统性提升视觉与交互（"最终的审美你来定"），并把"黑"的问题解决掉。
> 研究报告：`docs/design/research/2026-10-design-references.md`（访问情况、测得数值、逐站规律、链接）。
> 前后对比证据：`docs/verification/artifacts/ui-refresh/{before,after}/{studio,generation,review}/`（同一套浏览器验收脚本、同一流程、同一数据形状；before 为改动前的 HEAD 构建）。
> 设计语言一句话：**看片的屏幕是唯一的暗处，其余是安静的纸面；选中的东西会浮起来，数字用等宽，所有状态都有文字或形状，不只靠颜色。**

## 1. 现状审计（按优先级）

审计范围：`apps/web` 路由（25 个 `page.tsx`）、共享样式（`quiet-frame.css` 旧底座 + `ui-tokens.css` 语义层 + 各 CSS Module）、共享组件（`components/quiet-frame`、`ui/`、`studio/`、`review/`、`voice/`），以及 V6 主流程（新建 → 共看片室 → 审片 → 导出、付费生成、形象与声音）。证据是改动前的真实浏览器截图（`before/`）。

| 级别 | 问题 | 维度 | 证据 |
|---|---|---|---|
| **P0** | 手机宽度（390 px）下共看片室顶栏的操作挤出屏幕：标题消失，"导出 / 语言 / 主题 / 审片 / 素材"不可达（导出按钮 x=769） | 响应式、操作路径 | `before/studio/17-phone.png`；验收脚本新增的手机步骤在改动前失败 |
| P1 | 浅色主题下看片区是贯穿全宽的黑块，占视口约 65%，与浅色界面割裂（"黑"的问题） | 视觉一致性、布局 | `before/studio/03-empty-studio.png`、`06-first-cut-trial.png` |
| P1 | 顶栏 8 个同权重的幽灵按钮：三项"制作规则"开关看起来像普通操作，开/关只靠文字里的"开/关" | 信息架构、组件一致性 | `before/generation/01-region-quote.png` |
| P1 | 切换浅深色时控件颜色逐个渐变，深色截图里出现半透明、发灰的按钮与片段（本轮引入过渡后才暴露，已在同轮修复） | 交互反馈、动效 | 第 6 节 |
| P1 | 时间带：片段是等权重的描边盒，无悬停反馈；刻度与时钟用比例字体，数字跳动；播放头只有一根线 | 交互反馈、专业编辑 | `before/studio/06-first-cut-trial.png` |
| P1 | 原生 `<select>`（风格选择）样式与系统其余控件不一致 | 组件一致性 | `before/studio/03-empty-studio.png` |
| P1 | 主按钮悬停是一圈次级色内描边，看起来像"被选中"而不是"可按" | 交互状态 | `ui-tokens.css` 旧规则 |
| P1 | 阴影写死在各处（`rgba(0,0,0,.12)`、`.16`），没有层级 token；动效只有时长没有曲线 | 设计系统 | `studio.module.css` 旧规则 |
| P2 | AI 处理中只有一行文字，没有"正在动"的被动提示 | AI 状态 | `StudioConversation.tsx` |
| P2 | 文本选中色是浏览器默认蓝色，与单色体系不一致 | 色彩 | 全站 |
| P2 | 中文断行没有禁则（行首标点），标题孤字 | 排版 | 全站 |
| P2 | 首页（v0.4 Quiet Frame 仪表盘）文案硬编码中文，眉题 "YOUR NEXT GOOD STORY" 英文；四个新建入口并存（输入框、"用素材剪一条视频"、"新建作品"、空状态里的"创建项目"） | i18n、认知负担 | `before/studio/01-home-entry.png`；`app/page.tsx` |
| P2 | 旧底座 `quiet-frame.css` 仍有 249 个硬编码颜色、6 处渐变 / 3 处模糊（已被静态测试冻结为存量债） | 设计系统 | `ui-tokens.test.tsx` 的预算 |
| P3 | 时间带没有缩放；没有快捷键提示层 | 效率 | — |

## 2. 设计系统（本轮落地部分）

权威值在 `docs/V04/ANCS_v0.4_Design_Tokens.json`（运行时 `apps/web/src/app/ui-tokens.css` 由测试逐值比对，静态对比度对全部指定色对通过）。

### 2.1 颜色 token（变化项）

| Token | 浅色 | 深色（旧 → 新） | 理由 |
|---|---|---|---|
| `ui.bg.subtle` | `#F5F5F5` | `#141414 → #111111` | 深色"基础层"更沉，内容区更安静（Apple base/elevated；Linear 中性化） |
| `ui.bg.elevated` | `#FFFFFF` | `#1C1C1C → #171717` | 卡片、弹层与底色拉开但不发灰 |
| `ui.bg.hover` | `#EFEFEF` | `#262626 → #222222` | 跟随层级 |
| `ui.fg.primary` | `#171717` | `#F5F5F5 → #EDEDED` | 大面积白字略收，仍 ≥ 15:1 |
| `ui.border.subtle` | `#E5E5E5` | `#333333 → #262626` | 装饰分隔更轻（只做装饰，控件边界仍用 `border.control`） |
| `ui.action.primary.bg` | `#171717` | `#F5F5F5 → #EDEDED` | 与主文字一致 |
| `ui.action.primary.hover` | **新增** `#383838` | **新增** `#FFFFFF` | 主按钮悬停：浅色变浅、深色变亮，不再用描边冒充悬停 |
| `ui.selection.bg` | `#E8E8E8` | `#303030 → #2A2A2A` | 跟随层级；`fg.muted` 对其 5.68:1，`border.control` 对其 4.27:1 |
| `ui.focus.ring` | `#171717` | `#F5F5F5 → #EDEDED` | 与主文字一致 |

最低对比（全部指定色对）：浅色 `border.control / selection` 3.87:1（要求 3:1），文字类最低 4.69:1；深色 `border.control / selection` 4.27:1，文字类均 ≥ 5.6:1。

### 2.2 非颜色 token（新增）

| Token | 值 | 用途 |
|---|---|---|
| `--ui-ease-standard` | `cubic-bezier(.2, 0, 0, 1)` | 悬停、按下、切换等反馈 |
| `--ui-ease-enter` | `cubic-bezier(.16, 1, .3, 1)` | 抽屉、浮层进入 |
| `--ui-ease-exit` | `cubic-bezier(.4, 0, 1, 1)` | 退出（预留） |
| `--ui-shadow-1/2/3` | 浅色纯黑低透明；深色加 1px 内高光 | 1 = 静止控件与卡片；2 = 浮起/选中与画面框；3 = 浮层、抽屉、对话框 |
| `--ui-font-mono` | `ui-monospace, "SF Mono", …` | 时间码、刻度、计数 |
| `--ui-radius-pill` | `999px` | 徽标、指向标签 |
| `color-scheme` | light / dark | 原生滚动条、表单控件跟随主题 |

时长仍为 `--ui-motion-feedback 120ms / popover 150ms / drawer 200ms`（与研究里 100–200ms 的主流区间一致），`prefers-reduced-motion` 全部归零。

### 2.3 组件与交互状态

| 状态 | 规则（全站） |
|---|---|
| 默认 | 控件边界 `border.control`（≥ 3:1）；装饰分隔才用 `border.subtle` |
| 悬停 | 背景 `bg.hover`；主按钮 `action.primary.hover`；输入框边界加深到 `fg.secondary` |
| 按下 | `scale(.97)`，只在指针按住时 |
| 聚焦 | 2px `focus.ring` + 3px 间隙（键盘可见）；输入框边界同时变为 `fg.primary` |
| 选中 / 开启（`aria-pressed`） | 填充 `selection.bg` 或"浮起"（`bg.elevated` + `shadow-1`）+ 主色字；未开启为次级字。状态同时写在文字里（如"特效：开"），不只靠颜色 |
| 加载 / 处理中 | 文字 + 静默脉冲点（1.2 s 周期，避开 0.2 Hz 敏感频率；reduced motion 下静止） |
| 成功 / 失败 | 文字结论 + 左侧 2px 竖线（失败 `role="alert"`），不靠红绿 |
| 禁用 | 透明度 .55 + `not-allowed`，原因用文字给出（沿用） |
| 选择框 | 统一去掉原生外观，中性 V 形箭头（浅色 `#737373` / 深色 `#8C8C8C`），右侧留 30px |
| 文本选中 | 反相（主文字色底 + 画布色字） |

### 2.4 动效系统

- 反馈：颜色、边框、阴影、位移同一条 `ease-standard` 曲线，`feedback` 时长；**频繁交互不加额外动画**（Apple Motion）。
- 进入：抽屉从右 12px 淡入、浮层上移 4px 淡入（`ease-enter`）；手机上导出面板从底部升起。
- 打断与恢复：所有过渡都是 CSS 过渡，新的交互随时打断；外观切换暂停过渡两帧，颜色一次到位（不让人等动画）。
- 减少动态：时长 token 归零，脉冲点静止；保留颜色/透明度变化（motion.dev Accessibility 的原则）。

### 2.5 无障碍

- 制作规则开关组：`role="group"` + 中英双语组名（"制作规则：这条视频允许 AI 做什么"），每个开关保留 `aria-pressed` 与说明 `title`。
- 焦点可见、触控目标 ≥ 44px（粗指针下强制）、所有颜色组合静态对比通过；时间码等宽避免数字抖动。
- 中文禁则断行、标题平衡换行，降低长中文/中英混排的阅读成本。

### 2.6 响应式

| 宽度 | 共看片室组织方式 |
|---|---|
| > 900 px | 单行顶栏：返回 · 标题 · 已保存 ｜ 用量 · [制作规则组] ｜ 审片 · 素材 ｜ 语言 · 主题 ｜ **导出**（固定在最右，不随操作区滚动） |
| 761–900 px | 同上，隐藏"已保存/用量"等元信息 |
| ≤ 760 px | 两行顶栏：第一行 返回 · 标题 · **导出**；第二行操作区横向滚动（不出现页面级横向滚动）；看片屏幕边距收紧；素材/风格抽屉全屏；导出面板改为底部升起；风格说明换行显示全文 |

## 3. 核心页面方案与本轮实施

每项写明：解决什么 → 参考原则 → 为什么这样做 → 如何验证。

1. **手机顶栏可达（P0）**
   解决：导出等操作被挤出屏幕。参考：Apple Toolbars（窄屏把次要操作折叠、主操作常驻）、R7。做法：导出移出可滚动操作区固定显示；≤ 760 px 时顶栏两行、操作区横向滚动；房间网格列锁为 `minmax(0, 1fr)` 防止被内容撑宽。验证：`studio-browser-check` 新增"手机宽度"步骤——导出按钮必须在 390 px 视口内且页面无横向溢出（改动前失败：x=769；改动后通过：x 304–382）。
2. **看片区从"黑块"变成"屏幕"（P1，"黑"的问题）**
   解决：浅色主题下大面积黑色割裂。参考：Apple Dark Mode（沉浸式看媒体可以保持深色）、v0.4 token（`ui.media.matte` 两个主题都是 `#0A0A0A`，不改视频像素）。做法：保留垫底颜色，但看片区改为四周留边、16px 圆角的内嵌屏幕，加 1px 极淡内描边；画面框加淡描边与投影，让画面边界清楚。验证：前后截图 `03/06/16`；token 测试不变。
3. **顶栏信息架构（P1）**
   解决：同权按钮堆叠、规则开关像操作。参考：Linear"外框减噪"、Radix/shadcn Toggle Group、MotionVault 分段浮起。做法：三项规则收进一个分段组（未开 = 次级字；开 = 浮起白底 + 主色字 + 阴影），组与"审片/素材"、"语言/主题"之间用细分隔线；顶栏、停靠区与房间同底，靠一条细线和内容层级区分。验证：`generation-browser-check` 仍按文字定位并切换"生成：关 → 开"，截图对比 `01-region-quote`。
4. **时间带精度感（P1）**
   解决：数字抖动、片段无反馈、播放头不易抓。参考：R4 等宽、专业剪辑软件常识（播放头把手）。做法：时钟/刻度等宽；刻度加 5px 刻线；片段 500 字重 + `shadow-1` + 悬停底色；播放头加小把手（放在刻度线区域，不压住刻度文字）；轨道加极淡内描边。验证：`studio-browser-check` 的拖动选区、点选片段、局部试改步骤全部通过；截图 `08-pointer-selected`。
5. **AI 状态可感知（P2）**
   解决：处理中只有文字。参考：Apple Feedback（就近、被动）、Rive 状态驱动。做法：处理中文字前加静默脉冲点（reduced motion 静止）；指向标签（"片段 lake.mp4"等）改为胶囊，强调"AI 正在看着哪里"。验证：对话流程步骤通过；单元测试覆盖处理中状态的文字不变。
6. **控件一致性（P1/P2）**：主按钮悬停 token、按下反馈、统一选择框、输入框悬停/聚焦、文本选中反相、中文禁则断行、外观切换不渐变。验证：`ui-tokens.test.tsx`（token 与 JSON 逐值一致、对比度、禁用效果扫描）与前后截图。

未在本轮改动：首页信息架构与 i18n、审片页布局、旧 Quiet Frame 页面（只随全局 token 自然变化）。原因：AGENTS 要求"不擅自重做本轮未影响的已确认界面"，这些列入下一阶段并附方案（第 5 节）。

## 4. AI Native 交互专项（现状与方向）

| 方向 | 现状（已具备） | 本轮 | 下一步 |
|---|---|---|---|
| 鼠标点 / 线 / 面定位 | 时间带拖选区间、点选片段、画面框选区域；指向标签进入输入框 | 指向标签胶囊化 | 画面上直接显示"AI 正在改这里"的框（试改期间） |
| 时间轴定位与选择 | 拖动标尺定位、Esc 清选区、Space 播放 | 等宽刻度、播放头把手；方向键逐帧 / Shift 按秒、Home/End；缩放 1–16×（Ctrl/⌘+滚轮以指针为锚） | 触屏双指缩放、J/K/L 变速 |
| 语音与流式识别 | 语音条：连接中/在听/收尾、实时字幕、共同注意力提示 | — | 语音电平与 AI 处理状态统一视觉 |
| 聆听 → 理解 → 执行 → 预览 → 完成 | 文字状态 + 试改徽标（"试改预览 · 还没采用"）+ 采用/撤回/撤销 | 处理中脉冲点；标尺下沿标出试改改动的区间（服务端对照）+"试改改了 N 处" | 画面上标出"AI 正在改这里"的框 |
| 局部修改、对比、确认、撤销 | 试改不改工程；采用后一键撤销整组 | — | A/B 对照（已有 `CompareReplayPanel` 组件可复用） |
| 长任务与错误恢复 | 付费生成只调用一次、不自动重试、报价卡写明费用与预算 | 报价卡浮起层级；任务中心（素材处理、付费生成、导出、AI 这一轮，跨刷新、只读） | 任务完成时的就近通知 |

原则：AI Native ≠ 聊天框。对话只是"说"的入口；"指"的对象（画面区域、时间区间、片段）始终在画布和时间带上，可见、可清除、随指令一起发送。

## 5. 分阶段任务

- **第一阶段（已完成，提交 6c1aa25）**：token 精修与同步、全局控件状态、共看片室顶栏/看片区/时间带/AI 状态/报价卡/输入框/浮层、手机可达性修复与回归步骤、研究报告与本文。
- **第二阶段（已完成，见第 9 节）**：
  1. 首页与全站侧栏/顶栏中英双语（新增 `shell`、`dashboard` 文案组，顶栏加语言切换）；英文眉题不再出现在中文界面；素材作品从侧栏/快速前往直接进共看片室。入口收敛只做了不改流程的部分（空列表时不显示无意义的排序切换）——删除空状态的快速创建表单会改变已验收的新建流程，留给产品决定。
  2. 制作规则组按 Toggle Group 键盘模型重写为 `StudioRuleGroup`（单一 Tab 停靠点、←/→/↑/↓ 循环、Home/End、跳过禁用项）。
  3. 共看片室快捷键（空格、←/→ 逐帧、Shift+←/→ 一秒、Home/End、M 框选、/ 跟 AI 说、Esc 清除、+/−/0 缩放、? 列表）与"按住 Ctrl/⌘ 显示"的快捷键列表；正在输入、浮层打开或带修饰键时不接管；逐帧用 contracts 的有理 `stepFrames`。
  4. 审片页套用同一规范：内嵌屏幕、等宽时间、批注卡浮起、顶/底栏与页面同底。
- **第四阶段（已完成，见第 10 节）**：旧页面全部中英双语（工作区与作品二级页、新建、登录、欢迎与设计系统页、运营后台，共 30 余个组件）；首页空状态入口收敛；时间带真实音频波形（顺带修正 Worker 的波形算法）；触屏双指缩放；任务结束就近提醒；Firefox / WebKit 跨引擎验证。
- **第三阶段（已完成，见第 9 节）**：时间带缩放（档位 1–16×、Ctrl/⌘+滚轮以指针为锚、播放头自动跟随）与试改改动区间高亮（服务端 A/B 对照的真实区间）；旧 `quiet-frame.css` / `workspace.css` 颜色全部迁到 `ui.*`、装饰渐变与背景模糊全部移除，静态测试预算降为 0；任务中心（素材处理、付费生成、导出、AI 这一轮，跨刷新）。

## 6. 验证与结果

前后对比图在 `docs/verification/artifacts/ui-refresh/compare/`（左 = 改动前，右 = 改动后，同一脚本同一步骤）：

| 对比图 | 看什么 |
|---|---|
| `studio-phone.png` | P0：改动前导出/语言/主题被挤出屏幕、标题消失；改动后两行顶栏，导出常驻 |
| `studio-empty.png`、`studio-trial.png` | 看片区由全宽黑块变为内嵌屏幕；顶栏分组；时间带等宽刻度与把手 |
| `studio-pointer.png` | 指向标签胶囊、片段选中、风格选择框统一外观 |
| `studio-dark.png`、`generation-dark.png` | 深色层级加深、开启的规则浮起、外观切换后无渐变残影 |
| `generation-quote.png` | 报价卡浮起层级、"生成：开"开启态 |
| `review-phone.png`、`review-desktop.png` | 审片页本轮只随全局 token 变化（布局未动），作为回归对照 |

本轮自查发现并当场修复的问题：
- 外观切换时控件按 120 ms 渐变，导致深色截图里按钮/片段半透明发灰 → 外观切换暂停过渡两帧（`lib/appearance.ts` + `body[data-theme-switching]`）。
- 两行顶栏首版仍被内容撑宽 8 px（导出 x 320–398）→ 房间网格列锁定 `minmax(0, 1fr)`；验收脚本失败时会列出越界元素，便于以后定位。
- 播放头把手压住"00:00"刻度文字 → 把手下移到刻线区域。

## 7. 命令与结果

| 命令 | 结果 |
|---|---|
| `pnpm lint` | 通过 |
| `pnpm typecheck` | 通过 |
| `pnpm test:unit` | 114 文件 / 824 测试全部通过（含 `ui-tokens.test.tsx`：token 与 JSON 逐值一致、对比度、禁用效果扫描） |
| `pnpm test:security`（`ANCS_TEST_DATABASE_URL` 指向隔离库） | 5 文件 / 24 测试全部通过 |
| `pnpm secrets:check` / `arch:check` / `spec:check` / `capabilities:check` | 全部通过 |
| `pnpm --filter @ancs/web build` | 通过 |
| `scripts/studio-browser-check.mjs`（改动后） | 12/12（含新增"手机宽度"步骤）；改动前同脚本在手机步骤失败（导出 x=769） |
| `scripts/generation-browser-check.mjs`（改动后） | 6/6 |
| `scripts/review-browser-check.mjs`（改动后） | 9/9 |
| `pnpm test:integration` | 首次全量 134 文件中 5 个失败，原因均为测试环境：队列 e2e 需要 56379 端口的 Redis；特效/讲述/终渲染需要 `REMOTION_BROWSER_EXECUTABLE` 指向 `chrome-headless-shell`（见 `docs/verification/V5-M3.md`）。补齐环境后全量复跑 **134 文件 / 623 测试全部通过**；本轮改动不涉及 Worker、领域或 API 代码 |

第二、三阶段（本节以上为第一阶段的记录）：

| 命令 | 结果 |
|---|---|
| `pnpm lint` | 通过 |
| `pnpm typecheck` | 通过 |
| `pnpm test:unit` | 114 文件 / 824 测试全部通过（`ui-tokens.test.tsx` 的旧颜色预算已降为 0、禁用效果清单为空） |
| `pnpm test:web` | 45 文件 / 252 测试全部通过（新增 `StudioRuleGroup`、`StudioTasks`、快捷键、缩放与改动标记、首页英文用例） |
| `pnpm test:motion` | 4 文件 / 38 测试全部通过 |
| `pnpm secrets:check` / `arch:check` / `spec:check` / `capabilities:check` | 全部通过 |
| `scripts/studio-browser-check.mjs` | 14/14（新增首页英文、局部试改改动标记、任务中心、键盘与缩放步骤）。任务中心步骤首跑失败：导出列表只在进入页面时取一次，导出后抽屉里没有"导出"组 → 开始导出后刷新列表、打开抽屉时再取一次，复跑通过 |
| `scripts/generation-browser-check.mjs` | 6/6 |
| `scripts/review-browser-check.mjs` | 9/9（脚本先编码再登录后） |
| `scripts/quiet-frame-browser-smoke.mjs` | 迁移后 11 个二级路由全部通过。迁移前（旧颜色）的对照轮跑在历史页标题修正之前，前 8 个路由通过后停在历史页（脚本旧文案），对照图取自这 8 个路由 |

证据：`docs/verification/artifacts/ui-refresh/phase3/{studio,generation,review}/`。

浏览器验证环境：隔离 PostgreSQL + 进程内 Fastify/Worker（真实 FFmpeg）+ Next 生产构建 + Chrome for Testing；AI 为脚本导演、生成供应商为 FFmpeg 测试替身（与各里程碑验收相同，界面验证不依赖真实供应商）。

## 8. 仍需改进

- 没有挂载到任何页面的旧组件（`RenderReview`、`PlaybackSurface`、`VoiceCaptureControl`、`CompareReplayPanel`、`CanvasInteractionLayer`、`preview-harness`）仍是中文；哪天重新启用，要先补双语（英文界面冒烟会拦住）。
- 服务端返回的错误信息与业务数据（校验错误、审计记录、发布清单步骤、功能目录的名称与说明）按服务端写入的语言原样显示；要双语需要服务端返回错误码或按 `Accept-Language` 返回文案。
- 写进服务端的默认值随作者当时的界面语言：自动建的栏目名（默认栏目 / Default channel）、默认讲述风格名、素材解绑的编辑意图、重新绑定备注、Finance 预填的许可用途。导演台的编辑意图与发给 AI 的"只改选中分镜"提示仍是中文（记录与提示词，不是界面）。
- 本次修正前已建索引的素材，WAVEFORM 仍是旧算法的读数（接近 0），时间带上画不出来（不会画假波形）；需要对这些素材调一次媒体索引重建接口（`POST /api/v1/workspaces/:id/assets/:assetId/media-index/rebuild`）。处理器版本号没有升级，因为升级会让所有旧索引同时失效、AI 的素材检索暂时为空。
- 首页"只建空项目"保留为次要操作（它是不导入内容就建项目的唯一入口，历史验收脚本 n02-15 也依赖它）；若产品决定彻底去掉，需要同时改 n02-15 的脚本。
- 抖音发布卡的 logo 文字自创建起就是"手动交付"、没有徽标（与 X 卡不同），像是笔误；本轮按原样保留，只加了注释，改它会改变中文页面。
- 没有在 Linear / Figma 等产品内部做交互走查（无账号），相关结论只来自公开页面与文档。
- 跨引擎验证用的是 Linux 上的 Firefox 与 WebKitGTK（WebKit 引擎，与 Safari 同源但不是 Safari 本身）；macOS / iOS Safari 未实测。

## 9. 第二、三阶段实施记录

| 项 | 解决什么 | 参考原则 | 做法 | 验证 |
|---|---|---|---|---|
| 首页与外框中英双语 | 首页、侧栏、顶栏、快速前往、通知面板全是硬编码中文，英文界面下外框仍是中文；中文界面里出现英文眉题 | AGENTS"新界面一律中英双语"；detail.design"界面要经得起翻译" | 新增 `shell` / `dashboard` 文案组（时长、相对时间、阶段名按语言格式化），外框顶栏加语言切换；素材作品从侧栏与快速前往直接进共看片室 | `dashboard.test.tsx` 新增英文用例（页面不含中文字符）；`studio-browser-check` 首页切英文截图 `01b-home-english` |
| 制作规则组键盘模型 | 三个开关各占一个 Tab 停靠点，方向键无效 | Radix Toggle Group 键盘表 | `StudioRuleGroup`：单一停靠点（最近聚焦 → 第一个开启项 → 第一项，跳过禁用）、←/→/↑/↓ 循环、Home/End | `StudioRuleGroup.test.tsx` 2 例 |
| 快捷键与"按住显示" | 编辑操作全靠鼠标；没有可发现的快捷键 | Linear/Raycast 键盘优先；detail.design Hold to Reveal；Apple"不要让人等动画" | 空格、←/→ 逐帧（contracts 有理 `stepFrames`）、Shift 一秒、Home/End、M、/、Esc、+/−/0、?；按住 Ctrl/⌘ 半秒显示列表、松开收起；输入中、浮层打开或带修饰键时不接管；控件标注 `aria-keyshortcuts` | `studio.test.tsx` 快捷键用例；浏览器"键盘"步骤（Shift+→ 到 00:01.0、? 打开列表、截图 `18-shortcuts`） |
| 审片页一致化 | 审片页仍是全宽黑块、比例数字 | 同第一阶段 | 内嵌屏幕、等宽时间码、批注卡浮起、顶/底栏同底 | `review-browser-check` 9/9 |
| 时间带缩放 | 长素材或精细修改时片段太窄，无法精确指认 | Figma/剪辑软件常识（以指针为锚缩放）；Apple"频繁交互不加动画" | 1–16× 档位；内容加宽横向滚动，坐标仍走 contracts 有理视口；Ctrl/⌘+滚轮以指针为锚，其余以播放头为锚；播放头移出可见区自动跟随；刻度在放大时细到 0.1 秒 | `studio.test.tsx` 缩放用例；浏览器"键盘"步骤 `+` 两次到 2×、可横向滚动、截图 `18b-zoom` |
| 试改改了哪里 | 试改后看不出改动位置，只能整段重看 | AI Native：结果对比与确认要就近；不虚构数据 | 调服务端只读 A/B 对照（`compareProposal`，轴：内容/素材/时长，单纯被挤后的位移不算），把改动片段区间画在标尺下沿，播放条旁写"试改改了 N 处" | `studio.test.tsx` 改动标记用例；浏览器局部试改步骤记录"试改改了 2 处（标尺 2 处标记）" |
| 旧样式颜色债 | `quiet-frame.css` 249 处偏绿的硬编码颜色、6 处装饰渐变、3 处背景模糊，与单色体系不一致 | v0.4 §29 禁用项；Linear"中性、耐看" | 按用途映射到 `ui.*`（文字 / 底色 / 边界 / 焦点，按浅深主题分别取值；半透明色转中性 rgba）；渐变与模糊全部换成实色；媒体内容（封面、示意画）保留原色 | `ui-tokens.test.tsx` 预算降为 0、效果清单清空；`quiet-frame-browser-smoke` 前后各跑一遍逐路由截图对比 |
| 任务中心 | 素材处理、付费生成、导出、AI 轮次分散在各处，刷新后要自己找 | Apple Feedback（状态就近、被动呈现）；只读已授权投影 | 顶栏"任务"按钮（进行中数量 + 未成功提示点），抽屉按组列出，状态写成文字胶囊；数据全部来自服务端（工作室状态、导出运行列表、对话轮次），不发起、不重试任何任务 | `StudioTasks.test.tsx`；浏览器导出后打开任务中心看到"完成" |

第二、三阶段验证中顺带修复的验收脚本问题（均为脚本过时，不是产品回归）：
- `quiet-frame-browser-smoke`：不读 `ANCS_BROWSER_EXECUTABLE`（其余脚本都读）→ 补齐；作品表现页空状态文案在 `b9044ef` 已改、历史页标题在 `3a41a0a` 已改为"版本历史"，脚本仍按旧文案等待 → 按现文案更新。改动后 11 个二级路由全部通过。
- `review-browser-check`：登录后先花数秒编码测试素材，Node 服务端 keep-alive 超时关掉空闲连接，复用时 `ECONNRESET`（较慢的机器上稳定复现）→ 先编码再登录。
- `studio-browser-check`：新增的"时间带缩放"组名包含"时间带"，按名称取时间带时匹配到两处 → 改为精确匹配。
- `studio-browser-check`：抽屉进场动画（200 ms）未结束就截图，证据图里抽屉半透明 → 截图前等有限时长的动画结束（无限循环的"处理中"脉冲不等，最多 2 秒）。

旧页面颜色迁移的前后对比：`compare/legacy-{settings,billing,analytics,identity,workspace-assets,team}.png`（左 = 迁移前，右 = 迁移后）。主要控件此前已被 `ui-tokens.css` 覆盖，所以迁移后的可见变化集中在残留的偏绿底色与边线、装饰渐变与背景模糊；布局与文字不变。

## 10. 第四阶段实施记录

| 项 | 解决什么 | 做法 | 验证 |
|---|---|---|---|
| 旧页面中英双语 | 素材库、身份、团队、设置、扩展、额度与账单、作品表现、渲染、发布、脚本、分镜/编辑导演台、版本历史、新建、登录、欢迎与设计系统页、运营后台仍是硬编码单语 | 按页面分 5 组文案文件（`i18n/pages/{asset-library,project-flow,workspace-admin,delivery,entry}.ts`，中文与改造前逐字一致，英文由类型检查保证覆盖同一结构），30 余个组件改为读文案；模块级标签表挪进文案；日期/数字按界面语言格式化；根布局的 `<html lang>`、跳转链接、页面描述与本地错误兜底文案随界面语言 | 每个页面组件补英文用例（断言关键英文文案且界面文字不含中文）；`quiet-frame-browser-smoke` 新增英文轮：顶栏切英文后逐页检查 15 个路由的界面文字与无障碍属性，页面从 `/api/v1/` 读到的服务端数据与脚本自己写入的中文数据不算界面文字 |
| 首页空状态入口 | 两个主按钮（"开始创作"与空状态里的"创建项目"）同时争夺注意力 | "只建空项目"保留为次要按钮，空状态说明指向上方主入口与共看片室 | `dashboard.test.tsx`；截图 |
| 时间带真实音频波形 | 声音片段只有灰条；而媒体索引里的 WAVEFORM 并不是响度（Worker 把音频重采样到 100 Hz 后取样本值，低通滤掉 50 Hz 以上，−6 dBFS 正弦只读到约 0.009） | Worker 改为流式读取 16 kHz 单声道 PCM、每 10 ms 取绝对值峰值（不缓存整段音频）；时间带按片段的源区间读素材自己的索引（按资产版本对应），按分贝刻度显示（−54 dBFS 到 0）；没有测量值、索引属于别的版本、试改里内容有改动的片段都不画 | Worker 集成用例（−6 dBFS 正弦读数约 500、静音为 0）；`studio-waveform.test.ts`（拼接、取峰、倒放、未知不插值、分贝刻度）；组件用例；浏览器"采用试改"步骤断言声音轨 3 段实测波形 |
| 触屏双指缩放 | 手机/平板上时间带只能点按钮缩放 | 捕获阶段跟踪触点：两指捏合按档位缩放（以两指中点为锚），两指平移横向滚动；第二根手指落下时取消单指选择 | 组件用例；浏览器经 CDP 真实触摸输入：两指 80 → 200 px 缩放到 3×、播放头不动（截图 `18c-pinch`） |
| 任务结束就近提醒 | 长任务结束要自己去任务中心看 | 只提醒这次打开页面后看着结束的任务（素材处理完、付费生成完成/没成功、导出完成/没成功；AI 这一轮就在对话里不另提醒），在任务按钮下方浮出、读屏礼貌播报（常驻播报区）、8 秒收起、点一下打开任务；渲染在顶栏的横向滚动容器之外、按按钮位置固定定位，压在抽屉与浮层之上 | `finishedTasks` 纯函数用例；组件用例；浏览器上传步骤断言"… · 完成"出现且中心点最上层就是它本身——首版放在顶栏按钮旁，被顶栏 `overflow-x: auto` 的滚动容器裁掉（Playwright 的"可见"不管裁切，是这条中心点断言抓到的），改为容器外固定定位后通过 |
| 跨引擎验证 | 只在 Chromium 上验证过 | 新增零依赖脚本 `scripts/cross-engine-check.mjs`：Firefox 走 WebDriver BiDi（Node 22 自带 WebSocket），WebKit 走 WebKitWebDriver（W3C WebDriver）；准备一条真实素材的已采用作品，中英 × 1440/390 px × 首页/共看片室/审片/设置逐页检查 | 见下表 |

第四阶段命令与结果：

| 命令 | 结果 |
|---|---|
| `pnpm lint` / `pnpm typecheck` | 通过 |
| `pnpm test:unit` | 114 文件 / 824 测试全部通过 |
| `pnpm test:web` | 50 文件 / 296 测试全部通过 |
| Worker 媒体索引集成测试 | 3/3（含新增峰值用例） |
| `pnpm secrets:check` / `arch:check` / `spec:check` / `capabilities:check` | 全部通过 |
| `scripts/studio-browser-check.mjs` | 15/15（新增：采用后声音轨 3 段实测波形；素材处理完时任务按钮旁出现"完成"且没被遮挡；CDP 真实触摸两指捏合缩放到 3×、播放头不动） |
| `scripts/review-browser-check.mjs` | 9/9 |
| `scripts/generation-browser-check.mjs` | 6/6 |
| `scripts/quiet-frame-browser-smoke.mjs` | 中文 11 个二级路由 + 英文 15 个路由全部通过（英文轮首跑发现两处脚本判定问题：英文界面里切回中文的按钮本就写"中文"、分镜页没有 `h1`——已调整判定，不是产品问题） |
| `scripts/cross-engine-check.mjs`（Firefox 158 + WebKitGTK 2.52，Xvfb） | 33/33：两种引擎 × 中英 × 1440/390 px × 首页/共看片室/审片/设置，均无横向溢出、`<html lang>` 正确、共看片室片段与波形出现且导出按钮在屏幕内、英文界面无中文残留；两种引擎都支持 `text-wrap: balance` 与 `scrollbar-color` |

证据：`docs/verification/artifacts/ui-refresh/phase4/{studio,review,generation,legacy-en}/`、`docs/verification/artifacts/ui-refresh/cross-engine/`（含 `summary.json`）。

跨引擎环境说明：这台 Linux 容器里的 Firefox 来自 Mozilla 官方压缩包、WebKitGTK 与 Xvfb 来自 Ubuntu 软件源（都不进仓库，也没有运行 `playwright install`）；WebKitGTK 播放 H.264 需要 GStreamer 的 libav 插件：首跑时容器里没有，WebKit 截图的视频画面为黑；装上后复跑，画面正常（截图 `cross-engine/webkit-*-studio.png`）。WebKitGTK 与 Safari 同为 WebKit 引擎，但不是 Safari 本身。

子任务里需要说明的取舍：
- 写进服务端的默认值随作者当时的界面语言（见第 8 节）；导演台的编辑意图与发给 AI 的提示仍为中文。
- 设置页的标签页与扩展页的"图文与短文"卡改用稳定的内部键，不再拿中文文案比较；素材筛选的内部键改为英文（`data-preview-kind` 的值随之变化，仓库内没有使用者）。
- 中文界面的金额与 Credits 也按语言格式化，1000 以上带千分位（`12,000`）。
- 英文界面里少数原本就是英文的眉题（如 `CREATOR STUDIO / EDITORIAL`）保持不变。
