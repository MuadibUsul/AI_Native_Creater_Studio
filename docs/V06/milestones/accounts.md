# 账号自助：邮箱注册、验证、找回密码与内测邀请（D-04）

- **起因：** 所有者 2026-10-22 决定首轮内测仅限受邀（`docs/OWNER_ACTION_ITEMS.md` D-04），并要求三种注册方式都做成配置。
- **状态：** VERIFIED（单元 + 集成 + HTTP + 真实浏览器；邮件经真实 SMTP 驱动投递到本机收信服务）。真实发信服务商的投递待所有者提供 SMTP 账号（B-03）后实测——Mock / 本机通过 ≠ 真实服务商通过。

## 目标

1. 不再只能用命令建账号：用户可以自己注册、验证邮箱、找回密码。
2. 注册方式是配置：`closed`（缺省）、`invite`（上线用）、`open`。
3. 内测邀请可操作：运营发邀请、对方收到邮件、凭邀请注册；工作区邀请也寄邮件，被邀请人注册后能在首页接受。
4. 安全：答复不透露邮箱是否已注册；验证 / 重设链接有时效、一次性；重设后其他会话下线；同一收件人限频；生产禁用会把链接写进日志的驱动。

## 实现（contracts → migration → service → API → SDK → UI → tests → docs）

- **contracts**：`ANCS_SIGNUP_MODE`、发信配置（`ANCS_EMAIL_DRIVER` / `ANCS_SMTP_URL` / `ANCS_EMAIL_FROM` / `ANCS_PUBLIC_WEB_URL` / `ANCS_PRODUCT_NAME`）及跨字段规则（invite / open 必须配发信；生产禁 log 驱动、链接必须 https）；
  账号请求与答复（sign-up、verify-email、resend、request reset、reset）、`ACCOUNT_ERROR_REASONS`、`/capabilities` 的 `accounts`；邮件端口 `EmailSender`；邀请请求可带 `locale`。
- **migration**：`0099_signup_invitations`（平台内测邀请；同一邮箱至多一条有效邀请）。手写迁移（drizzle 快照自 0085 起不再维护，`drizzle-kit generate` 会生成全量建表，不能用）。
- **service（packages/auth）**：Better Auth 接上发信钩子（要求邮箱验证、验证即登录、重设后撤销会话并视为已验证、已注册邮箱再注册只给主人发提醒）；
  `accounts.ts`（三种注册方式、邀请资格 = 有效平台邀请或工作区邀请、平台邀请增删查）；邮件模板中英双语、插入值转义；邮件语言经异步上下文从请求传入；运营建号视为已验证且不发信。
- **provider**：`packages/providers/email-smtp`（nodemailer 10.0.15：连接 / 读写超时、启动自检、错误描述不含地址与密码；开发用 log 驱动）。
- **API**：`/auth/sign-up`、`/auth/verify-email`、`/auth/resend-verification`、`/auth/request-password-reset`、`/auth/reset-password`；登录对未验证邮箱返回 403 `EMAIL_NOT_VERIFIED`；
  工作区邀请创建后寄邮件；同一收件人同类邮件限频（连发 3 封后约每 5 分钟 1 封，有 Redis 时多机共用）；CLI `invite:signup add | list | revoke`。
- **SDK**：`auth.signUp / verifyEmail / resendVerification / requestPasswordReset / resetPassword`。
- **Web**：`/sign-up`、`/verify-email`、`/forgot-password`、`/reset-password`；登录页按能力显示"创建账号""忘记密码？"与"邮箱还没确认"；首页"你有新的邀请"。全部中英双语。

## 验收与命令

| 命令 | 结果 |
|---|---|
| `pnpm -s typecheck` / `pnpm -s lint` / `arch:check` / `spec:check` / `secrets:check` / `capabilities:check` | 通过 |
| `npx vitest run --project unit` | 通过（含新增发信与注册方式配置规则 5 项） |
| `npx vitest run --project web` | 通过（新增 `account-pages.test.tsx` 10 项） |
| `npx vitest run --project integration packages/providers/email-smtp` | 4 / 4：真实 SMTP 协议（登录、投递、中文主题编码、纯文本 + HTML、密码错误、连不上） |
| `npx vitest run --project integration packages/auth` | 26 / 26（新增 `accounts.integration.test.ts` 11 项：三种注册方式、验证、防枚举、找回、限频、运营建号、模板） |
| `npx vitest run --project integration apps/api/src/accounts.integration.test.ts` | 3 / 3：invite 开站完整 HTTP 路径、工作区邀请邮件 → 注册 → 接受、closed 缺省 |
| `node scripts/account-browser-check.mjs` | 8 / 8，6 封邮件经真实 SMTP 驱动投递：登录页入口、未受邀被拒、凭邀请注册、验证前不能登录、点链接即登录、找回密码、工作区邀请（中文）、手机宽度深色 |
| `node apps/api/dist/cli/signup-invite.js add / list / revoke` | 邀请、顺延、列出、撤销；生产配 log 驱动或 http 链接时启动失败 |

## 证据（`docs/verification/artifacts/accounts/`）

`01` 登录页入口 · `02` 未受邀被拒 · `03` 邀请链接预填邮箱 · `04` 请查收邮件 · `05` 邮箱还没确认 · `06` 邮箱已确认 · `07` 验证后进入创作台 ·
`08` 重设链接已发 · `09` 设置新密码 · `10` 中文注册 · `11` 首页待接受邀请 · `12` 接受后进入工作区 · `13` 手机宽度深色注册页。

## 交接

- 👤 B-03：发信服务商账号、`ANCS_SMTP_URL`、发件人与 SPF / DKIM / DMARC；配好后跑一次真实注册即完成真实服务商验收。
- 第三方登录（Google / Apple）、手机号登录未做（D-04 的剩余部分，所有者以后再定）。
- 运营后台还没有邀请管理界面（目前用 CLI）；需要时按 AdminAction 流程补。
- 邮件为请求内异步投递（不经队列）：进程在投递中途退出会丢这一封，用户可"重新发送"；量大以后可改成经工作流投递。
