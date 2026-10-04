# 0005 Web 客户端依赖边与组件消费

- **日期**：2026-10-04
- **状态**：已生效（P05-03 立项时产出）
- **关联**：计划 §3.1（技术基线）、§3.4（依赖方向）、§8 P05-03/P05-04；规范 §29.2（业务 API 独立于 Next.js）、§37/§38（编辑器）、§92.1（契约不依赖 Web）；REQ-49-02（arch:check）、REQ-29-06、REQ-92-01；arch-check 规则 R5

## 问题

P05-03 起需要 `apps/web`（Dashboard/Script/Storyboard/Scene Editor/Assets/History/Render）。
现有 R5 规定 `apps/web|desktop|mobile` 的**生产 workspace 依赖**仅允许 `@ancs/sdk`、`@ancs/contracts`、`@ancs/ui`；
而编辑器还需要 `@ancs/scene-components`（组件 props schema、注册表目录、缩略预览渲染）——
这与 P05-04（Remotion Player 预览）同源。需要在**不静默放宽架构规则**的前提下给出裁决。

## 裁决

1. **Web 技术基线**按计划 §3.1 固定：Next.js（App Router）+ React + Tailwind；服务端状态用 TanStack Query
   （不复制到独立权威状态库）；Zustand 只保存本地界面状态（选择/面板/拖拽）。测试用 Vitest（jsdom + Testing Library）。
2. **R5 扩展**：`apps/web|desktop|mobile` 生产 workspace 依赖允许
   `@ancs/sdk`、`@ancs/contracts`、`@ancs/ui`、**`@ancs/scene-components`**。
   理由：组件协议/注册表/渲染是预览与编辑的**单一来源**（规范 §11.1、§12）；
   `@ancs/scene-components` 只依赖 `react`、`zod`、`@ancs/contracts`，不访问 Node API、数据库、存储或 Provider 凭据，
   因此不破坏"UI 通过 SDK 调用业务 API"（§3.4）与"Web 不直连数据库/存储/Provider"的边界。
   该扩展同时覆盖 P05-04 的预览装配（`@remotion/player` 属 npm 依赖，不受 R5 的 workspace 白名单限制）。
3. **不创建 `packages/ui`（暂缓）**：在出现第二个消费方（desktop/mobile）前不引入空包
   （计划 §3.1"按实际任务创建包"）。共享界面原语先落在 `apps/web/src/ui/`，需要复用时再提取并更新本条裁决。
4. 业务规则仍只在 domain/API 层（规范 §76）；UI 只做展示、表单与经 SDK 的提交，冲突（409）与幂等由编辑协议契约处理。

## 实施

- `packages/arch-check` 的 `WEB_APP_ALLOWED_WORKSPACE_DEPS` 增加 `@ancs/scene-components`（R5），并更新规则测试；
- `apps/web` 装配按上述基线；页面状态矩阵（空/加载/失败/无权限/冲突）为 P05-03 验收内容。

## 验收关联

- REQ-49-02（arch:check 通过）；REQ-29-06（Web 经 SDK 调用统一 API）；REQ-92-01（契约平台中立，不依赖 Web）；
- P05-03 验收（页面与状态矩阵）；P05-04 验收（预览消费 Graph）。
