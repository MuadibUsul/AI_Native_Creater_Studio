# 原型检查报告

日期：2026-10-07。对象：本包 `index.html`，**不是原 GitHub 仓库**。

## 实际结果

28项行为/完整性检查通过；13个页面在320、390、768、1280、1600五种宽度下共65组检查，没有整页横向溢出。检查期间没有JavaScript未处理异常，也没有网络请求。

| 检查 | 结果 |
|---|---|
| 13 页面 × 5 视口，无整页横向溢出 | PASS |
| 已有项目时仍有新建入口 | PASS |
| 首页正文导入保留输入 | PASS |
| 无效 URL 不进入生成流程 | PASS |
| 有效 URL 只记录，不伪造抓取 | PASS |
| 生成入口明确打开预置示例 | PASS |
| 脚本锁定成为只读 | PASS |
| 锁定脚本拒绝应用 AI 修改 | PASS |
| 确认 AI 修改后写入本地脚本 | PASS |
| 脚本确认进入分镜 | PASS |
| 拒绝或关闭 AI 修改不改变旁白 | PASS |
| AI 差异确认后改变旁白 | PASS |
| 轻时间线按需展开 | PASS |
| 锁定分镜拒绝应用 | PASS |
| 未勾选审核不能批准 | PASS |
| 确认后进入交付演示 | PASS |
| 仅下载真实存在的 TXT 样例，不伪造 MP4 | PASS |
| 编辑使本地批准状态失效 | PASS |
| 未批准时导出被拦截 | PASS |
| 授权确认框未勾选不能继续 | PASS |
| 授权流程不假装创建真实克隆 | PASS |
| 命令搜索筛选页面 | PASS |
| Esc 关闭对话层 | PASS |
| 原型没有收集 API Key 的输入框 | PASS |
| 深浅主题可切换 | PASS |
| 手机导航可展开 | PASS |
| 没有 JavaScript 未处理异常 | PASS |
| 没有外部网络请求 | PASS |

## 检查方法

使用容器内 Chromium 与 Playwright，以 `page.set_content` 装载完整 HTML。场景切换、键盘、点击、输入、审批闸门与下载使用浏览器实际事件。PNG 由同一 HTML 渲染，不是用于冒充网页的图片拼接。总览图另对完整截图进行缩略排版。

## 未验证与限制

未运行生产仓库的 lint/build/单元/集成/e2e 测试；没有连接真实数据库或供应商；没有验证模型、真实QA、渲染、计费、OAuth、声音克隆或发布。

未验证真实来源下 localStorage 的跨刷新持久性；没有完整 WCAG 审计、屏幕阅读器测试或 Safari/Firefox/实体手机认证。无横向溢出不等于全部交互或所有断点都已完全验收；范围仅限列出的页面、视口与用例。

第一次检查发现320px下首页按钮和设计系统示例横向溢出，已调整布局并复查。测试脚本早期因弹窗与底页具有同名操作导致定位等待，已改为优先选择弹窗内按钮；最终结果对应修正后的脚本与原型。

## 重跑

安装 Python Playwright 与 Chromium 后：

```bash
python handoff/verify_prototype.py --chromium /path/to/chromium
python handoff/capture_screens.py --chromium /path/to/chromium
```

Windows 请将 `--chromium` 设为本机 Chrome/Edge 的可执行文件路径。脚本不需要真实凭据，不会调用收费服务。
