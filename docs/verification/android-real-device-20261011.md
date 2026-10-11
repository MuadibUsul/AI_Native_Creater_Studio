# 真机验证｜Android（2026-10-11）

**结论：** 用 `adb` **全自动**在真实安卓设备上完成了首轮真机检查：应用可加载、落地页与登录页渲染正确、鉴权门生效、**且失败态被明确呈现（不静默）**。**未验证**：横竖屏切换（`user_rotation` 指令未生效）、登录后的工作台/画布/时间带、以及 §20 第 263 行要求的"切换后选区仍对应同一对象"。

## 设备与环境（§20.4 要求记录硬件与浏览器）

| 项 | 值 |
|---|---|
| 设备 | OnePlus **LE2110**（OnePlus 9） |
| 系统 | **Android 14** |
| 物理分辨率 | **1080×2400** |
| 浏览器 | 系统浏览器（Chrome 内核） |
| 连接与转发 | USB + `adb reverse tcp:3000 tcp:3000`（手机 `localhost:3000` → 本机 Web 服务） |
| 服务端 | Web `next dev`（本机 3000）+ API `node apps/api/dist/index.js`（本机 3001，dev 库 `ancs_dev` 已迁移 91 表） |

**自动化方式（可复现，全程无人值守）：**
```bash
adb reverse tcp:3000 tcp:3000
adb shell am start -a android.intent.action.VIEW -d "http://localhost:3000/"
adb exec-out screencap -p > shot.png
adb shell input tap <x> <y>           # 触摸交互
adb shell settings put system user_rotation 1   # 横屏（本次未生效）
```

## 已验证（附截图）

| # | 场景 | 结果 | 证据 |
|---|---|---|---|
| 1 | **API 未启动时**访问首页 | 页面**明确报错**：「失败 / 会话暂不可用 / HTTP 500（响应不符合统一错误信封）」+「重试」按钮；**没有白屏、没有静默失败** | `artifacts/android-real-device/01-session-error-api-down.png` |
| 2 | API 启动后访问首页 | 正常渲染落地页 `/welcome`：中文标题「一个好想法。一部好作品。」、两个 CTA、「先看草稿，再确认生成 · 不自动发布」、导演工作台预览卡；**中文排版/层级/黑白设计系统正确** | `artifacts/android-real-device/02-welcome-api-up.png` |
| 3 | 点击「体验导演工作台」 | **跳到 `/sign-in`**：未登录不会进入编辑器，**鉴权门生效**；登录页（邮箱/密码/登录）渲染正确 | `artifacts/android-real-device/03-signin-after-cta-tap.png` |

**这几条对应规范：**
- **N04 共用失败／回滚规则**：「新的 UI 不能屏蔽错误与权限」—— #1 与 #3 正是这条的正向证据（错误与权限都被显式呈现）。
- **§20.4**：性能/证据必须注明硬件与浏览器 —— 本文件已记录设备型号、系统版本、分辨率、浏览器内核。
- **§20 第 263 行**（移动触控、横竖屏切换后选区仍对应同一对象）—— **未验证**（见下）。

## 未验证 / 剩余缺口

1. **横竖屏切换**：`adb shell settings put system user_rotation 1` 执行后截图与竖屏**字节完全相同**，说明设备未按预期旋转（OnePlus/Android 14 对 `user_rotation` 的处理或需前台应用重绘）。**故不声称通过**；需改用真手旋转或 `adb shell wm size` 模拟分辨率再验。
2. **登录后的工作台/画布/时间带**：需要账号（仓库有 `createInternalUser`，dev 库可建测试账号，但手机端输入账号密码需 `adb shell input text` 逐字段执行）。**未进入**，因此 N04 的画布与时间带仍未在真机看过。
3. **§20 第 263 行的"选区跨旋转/缩放仍对应同一对象"**：依赖 (2)，未验。
4. **触摸手势的细粒度验证**（缩放/框选/拖拽）未做。
5. **iOS/Safari**：无设备，未验（规范未点名 Safari，见 N03-16 验证文档的口径校正）。

## 复现注意

- 本机 `.env` 含 **dev 专用占位值**（`BETTER_AUTH_SECRET` 等），非真实密钥；`.env` 已被 `.gitignore` 忽略且未被 git 跟踪（`pnpm secrets:check` 通过）。
- 真机检查需要 **Web（3000）+ API（3001）** 同时运行；只起 Web 会得到场景 #1 的报错卡（该报错本身也是有用的验证证据）。
