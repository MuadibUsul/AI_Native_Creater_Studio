# N15-03 预研：运营 RBAC/ABAC 与职责分离候选矩阵

**性质：只读代码审计与设计候选；未实现、未验证，不改变 N15-03 的 `TODO` 状态。** 2026-10-08。依据 `docs/V04/ANCS_AI_Native_v0.4.md` §28.4—28.5、§28.19，`docs/V04/ANCS_v0.4_Task_Backlog.md` N15-03，以及现有 API、契约和领域代码。N15-02 的全量验收与活账本关闭由主协调任务处理。

## 当前安全边界

- N15-02 已引入独立 ops principal、TOTP 会话、环境绑定和角色变更失效。`requirePlatformAdmin` 尚无逐动作／逐对象授权。生产旧 `/api/v1/admin/*` **全部读写返回 403**，独立 `/api/v1/ops/session`、重验与本人会话撤销保留；TEST 旧路由只用于历史回归。下表是后续开放候选，不是当前授权承诺。
- 角色只是一层模板。最终许可必须同时检查当前环境、有效 grant、workspace／案件／对象、字段投影、金额或时限、工单、风险与审批。缺任一条件默认拒绝；前端隐藏按钮不构成授权。
- `PLATFORM_OWNER` 治理人员和配置，不天然读取客户内容、明文密钥或修改账本。`SERVICE_ACCOUNT` 只允许单用途非交互授权；`GROWTH_ANALYST` 不能借运营总览读取原始媒体、支付细节或身份样本。

以下路由均以 `/api/v1` 为前缀。角色与 action 名是**候选**；对象 ID 必须由服务端查询并核对其真实 workspace，不信任路径或请求体自报的作用域。平台级聚合需显式平台 scope；不带 `workspaceId` 不等于任意租户通行。

## 14 个现存 GET：候选 action、角色及投影

| 路由 | 候选 action／角色 | 对象、字段与生产开放条件 |
|---|---|---|
| `/admin/overview` | `ops.overview.read`；`PRODUCTION_OPERATOR`、受限 `PLATFORM_OWNER` | 平台聚合；只给真实计数、阈值与时间水位，不含客户内容。须先完成聚合字段审查。 |
| `/admin/metrics` | `ops.metrics.read`；`PRODUCTION_OPERATOR`、显式范围 `AUDITOR` | 平台运行指标；限制导出受众、标签与抓取凭据，不让任意 ops 角色读取。 |
| `/admin/jobs` | `ops.job.list`；`PRODUCTION_OPERATOR`，工单内 `SUPPORT_L2` | 先按授权 workspace／任务类型过滤。现有 Job DTO 原样返回 `input/result/error` 任意 JSON；在安全投影前生产继续拒绝。 |
| `/admin/audit` | `ops.audit.read`；`AUDITOR`、`SECURITY_ADMIN` | 按明确审计范围、分页与字段白名单。现有 Outbox `details` 与摘要含自由文本，不能直接放行。 |
| `/admin/users` | `ops.user.list`；`SUPPORT_L1/L2`，安全案件内 `SECURITY_ADMIN` | 先限制客户／工单范围；L1 默认脱敏。现有 DTO 含完整 email/name，需按角色投影并限制搜索。 |
| `/admin/workspaces` | `ops.workspace.list`；`SUPPORT_L1/L2`、`BILLING_OPERATOR`、`PRODUCTION_OPERATOR` | 各职责需要不同字段；现有一个 DTO 混合名称、隐私档位、余额、用量和风控状态，需先拆投影并按 scope 过滤。 |
| `/admin/projects` | `ops.project.list`；工单内 `SUPPORT_L2`／`PRODUCTION_OPERATOR`，案件内 `CONTENT_REVIEWER` | 逐 workspace／项目授权；项目标题视客户内容敏感。现有全局标题搜索在范围前发生，生产继续拒绝。 |
| `/admin/provider-status` | `ops.provider.status.read`；`PROVIDER_MANAGER`、`PRODUCTION_OPERATOR` | 平台 Provider 聚合，只保留状态／错误类别；不得返回 Secret、原始错误正文或客户 Key。 |
| `/admin/storage` | `ops.storage.summary.read`；`PRODUCTION_OPERATOR`、`PRIVACY_OFFICER` | 显式平台或 workspace 范围；只返回用量和限额事实，避免泄露资产名称／存储键。 |
| `/admin/workspaces/:workspaceId/credits` | `ops.credit.statement.read`；`BILLING_OPERATOR`、`BILLING_APPROVER`，受限 `AUDITOR` | 服务端按该 workspace 授权；账本详情做财务字段投影，不把客户 Owner 权限当平台权限。 |
| `/admin/audit-log` | `ops.audit.log.read`；`AUDITOR`、`SECURITY_ADMIN` | workspace／动作／时间范围和分页；现有 `details` 是任意 JSON，须白名单与敏感值清洗。导出另设许可。 |
| `/admin/abuse-flags` | `ops.abuse.flag.list`；`CONTENT_REVIEWER`、`REVIEW_LEAD`，安全案件内 `SECURITY_ADMIN` | 按分配案件／workspace 过滤；`note` 和 `resolutionNote` 为自由文本，按案件需要投影。 |
| `/admin/workspaces/:workspaceId/support-grants` | `ops.support.grant.list`；`SUPPORT_L2`、`SECURITY_ADMIN`、`PRIVACY_OFFICER` | 指定 workspace／工单；L2 只看与自身申请或使用相关的授权，安全／隐私管理员按治理范围查看。 |
| `/admin/workspaces/:workspaceId/support-view` | `ops.support.view`；被授权的 `SUPPORT_L2` | 每次核对当前 principal、workspace、只读字段 scope、用途／工单、有效期与撤销状态，继续记录访问和客户可见事件。现有领域仅检查该 workspace 存在**任意** ACTIVE grant，尚未绑定访问者，生产不得开放。 |

## 9 个现存 POST：候选职责与执行门

所有现存写路由在 N15-04 的 AdminAction 预检、审批、幂等执行接线前，生产一律保持 403。以下“申请／批准”是未来职责分离，不表示当前直写路由可继续执行。

| 路由 | 候选 action／申请与批准角色 | 对象、金额／时间、风险门 |
|---|---|---|
| `/admin/jobs/:jobId/retry` | `ops.job.retry`；`PRODUCTION_OPERATOR` 申请 | 从 jobId 反查 workspace、项目模式、任务类型及成本；校验预算、重试上限、目标 revision 和近期 MFA。高成本或生产恢复进入审批。 |
| `/admin/workspaces/:workspaceId/abuse-flags` | `ops.abuse.flag.create`；案件内 `CONTENT_REVIEWER` | 只针对分配案件／workspace；原因与证据留痕，HIGH 风险后续由独立复核人处理。 |
| `/admin/abuse-flags/:flagId/resolve` | `ops.abuse.flag.resolve`；`REVIEW_LEAD` | 从 flagId 反查案件及 workspace；HIGH 案件申请人与复核人必须独立，不能自结。 |
| `/admin/workspaces/:workspaceId/abuse-state` | `ops.abuse.restrict`／`ops.abuse.restore`；止损由 `PRODUCTION_OPERATOR`／`SECURITY_ADMIN`，恢复由独立复核人 | `RESTRICTED` 可作为**限时止损候选**，需原因、时限、告警、事后复核；`NORMAL` 恢复不能使用同一 break-glass。现有状态无到期机制，不得把旧接口称为已实现紧急授权。 |
| `/admin/workspaces/:workspaceId/support-grants` | `ops.support.grant.request/approve`；`SUPPORT_L2` 申请，`SECURITY_ADMIN`／`PRIVACY_OFFICER` 独立批准 | 必须保存受益 principal、workspace、工单／用途、只读字段 scope 与期限；24 小时只是合同硬上限，实际政策可更短。当前 POST 立即生效，生产保持关闭。 |
| `/admin/support-grants/:grantId/revoke` | `ops.support.grant.revoke`；`SECURITY_ADMIN`／`PRIVACY_OFFICER`，可考虑本人放弃授权 | 从 grantId 反查对象和受益者；撤销即时失效并追加审计，不允许撤销别的租户授权。 |
| `/admin/workspaces/:workspaceId/credits/grant` | `ops.credit.grant`；`BILLING_OPERATOR` 申请、`BILLING_APPROVER` 独立批准 | 按 workspace、Credits 数额、时间窗和累计额度决策；当前请求上限 1,000,000 只是输入合法性，不是角色授权阈值。账本仍只追加。 |
| `/admin/workspaces/:workspaceId/credits/refund` | `ops.credit.refund_of`；`BILLING_OPERATOR` 申请、`BILLING_APPROVER` 独立批准 | 从 `entryId` 查询原 CREDIT 的 workspace、金额、状态和已冲正情况；这是 Credits 扣回，**不是**外部支付原路退款。真实货币退款属于 N15-22 的独立高风险工作流。 |
| `/admin/workspaces/:workspaceId/plan` | `ops.plan.assign`；`BILLING_OPERATOR` 申请、`BILLING_APPROVER` 独立批准 | 固定 workspace、PlanVersion、权益／Credits 影响、时间与旧订阅 revision；影响预演后批准，订阅历史保持 append-only。 |

## 现存缺口与默认拒绝

1. `apps/api/src/plugins/admin.ts` 的守卫只核 ops 会话和近期重验；TEST 可进入全部旧路由，尚无 action 策略。生产全旧路由关闭是当前安全阀，不是 N15-03 验收。
2. `packages/domain/src/ops.ts` 的跨租户 Job 列表直接返回 `input/result/error`，旧审计视图直接返回 Outbox payload；`packages/domain/src/security-ops.ts` 的 audit-log 返回任意 `details`。这些字段不能用“已认证”替代安全投影。
3. `getSupportView` 当前只查 workspace 的任意有效支持 grant，未检查 `requestedByUserId`／受益 principal、工单或字段 scope；当前 grant 模型也没有明确的受益操作者。必须修改查询与数据模型，不能只在 UI 限制。
4. `admin_role_grants` 目前只有角色及撤销时间，活动唯一键仅 `(principal_id, role)`；没有 tenant／对象／工单／金额／生效期 scope，也无 `PermissionPolicyVersion` 和 `EmergencyGrant`。`environment`、`role` DB 列仍是 text，后续迁移需加约束并处理既有数据。
5. 现有独立 principal 以 user ID 区分，不能证明两个账号不是同一自然人的别名。高风险双人审批在可信操作者身份关联未建立前须禁用；同一 principal、user 或已知别名组均不能自批。
6. 旧 POST 直接调用领域写服务，部分审计在副作用之后单独写入；N15-04/05 必须统一 AdminAction、重查 revision／授权和追加式证据。不能让新 `/ops` 安全而旧 `/admin` 旁路仍直写。
7. 现无运营搜索／敏感导出路由。新增时须在查询前做 scope 过滤，导出需独立字段、行数、时限与下载审计权限；“接口不存在”不算正面验收。

## 最小可执行切片（待 N15-02 全量验收后实施）

1. Contracts：定义封闭的 `OpsAction` 枚举、资源与环境／scope 输入、`PermissionDecision` 原因；列出全部 23 个旧路由的 action 映射，并给新增 `/ops` 语义路由同一决策入口。默认拒绝未知动作。
2. Migration：在当前最新迁移之后，为 RoleGrant 增加可验证的 workspace／资源／工单／时间／金额 scope，固化环境和角色 CHECK；记录政策版本与受限 EmergencyGrant。权限变化继续使运营会话失效。主体别名关系未获可信配置时，高风险批准保持关闭。
3. Domain/auth 与 API：做一次服务端权限决策；通过对象 ID 反查真实 workspace 后校验，列表／搜索先按 scope 过滤。为用户、工作区、项目、Job、审计、支持视图建立字段白名单。所有旧 GET/POST 都显式标记 action；尚无安全投影或 AdminAction 的路由仍返回 403。
4. SDK/UI：仅暴露已获准的查询／动作和明确拒绝原因；不把前端角色判断作为安全边界。运营页显示服务端环境，禁用状态须与 API 一致。
5. Tests/docs：矩阵测试覆盖普通 Workspace Owner、每个 ops 角色、跨环境与跨租户、ID 反查、字段越界、金额上限、过期／撤销、同人或别名自批、紧急 grant 越界；结构检查覆盖 14 GET + 9 POST，验证新旧入口没有未声明 action。未配置双人身份时高风险写持续拒绝。新建 N15-03 验证与正式交接并更新活账本，只在测试和全量门通过后标 `VERIFIED`。

**需用户随后确定的运营参数：** 真实生产操作者与独立复核者、别名／同人识别依据、金额和批量阈值、支持访问期限、break-glass 止损范围及通知通道。在这些参数未可信配置前，以拒绝高风险动作为可执行默认值。
