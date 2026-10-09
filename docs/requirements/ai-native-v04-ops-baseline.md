# ANCS v0.4 运营后台现状基线（N15-01）

> 2026-10-08；基于 `codex/v04-foundation` 的 `2afb394` 与当时工作树的现存实现。本文是代码与需求对照，不代表 O0/O1/O2 已验收。权威需求为 `docs/V04/ANCS_v0.4_Operations_Backoffice.md` §28，任务边界为 `docs/V04/ANCS_v0.4_Task_Backlog.md` N15-01。后续实施先复核代码与账本最新状态。

## 1. 权限域与现有入口

| 域 | 现状及权威入口 | v0.4 处置 |
|---|---|---|
| Workspace Owner/Admin | `packages/auth/src/authorization.ts` 的 OWNER/ADMIN/EDITOR/REVIEWER/VIEWER 和能力矩阵；`apps/api/src/routes/workspaces.ts` 的成员、邀请、席位检查与 401/404/403 授权入口。客户设置页在 `apps/web/src/app/w/[workspaceId]/settings/page.tsx`。 | 仅能管理所属 workspace。Owner 不是平台管理员；客户入口继续采用 `/w/:workspaceId/settings` 与现有 workspace 领域服务。Billing Manager 是 §28 的目标职责，当前五角色矩阵中尚无该独立角色/授权，归 N15-11。 |
| Platform Admin（旧） | `apps/api/src/plugins/admin.ts` 从 `ANCS_PLATFORM_ADMINS` 解析 user ID 白名单，复用普通登录会话；非管理员即使是 workspace OWNER 也返回 404。`apps/web/src/app/admin/page.tsx` 是旧 `/admin` 单页，调用 `packages/sdk/src/client.ts` 的 `admin` 客户端。 | 保留兼容但不能等同 Platform Ops：缺独立 principal/audience、MFA、细粒度 RBAC/ABAC、职责分离和 AdminAction。N15-02—06 建立平台身份及 `/ops` 语义能力；服务端校验始终是权威。 |
| Platform Ops（目标） | 当前没有独立 `/api/v1/ops/*` 路由或 §28.19 的 AdminPrincipal/RoleGrant/AdminAction/Approval 实体。 | 按角色、环境、对象、租户、风险、时间和审批授权；支持/财务/生产/隐私/审计分别授予。不得用 workspace Owner 或旧布尔式管理员代替。 |

现存 API 统一前缀为 `/api/v1`。下文 `A:` 表示**现存** `/api/v1/admin`，`W:` 表示**现存** `/api/v1/workspaces/:id`；`拟 ops` 表示 §28.19 提议、**尚未实现**的 `/api/v1/ops`。表中的实体为现存表/领域对象或明确标为“待建”的逻辑对象，不能把已有 API 或 DTO 误判为完整运营模块。

## 2. 分层复用清单

| 层 | 已有可复用实现 | 主要差项与证据 |
|---|---|---|
| Contracts/Auth | `packages/contracts/src/ops.ts` 的 overview、alert、审计摘要和仅 `JOB_RETRY` 的旧 `opsAdminActionSchema`；`security-ops.ts` 的管理员摘要、abuse/support DTO；`packages/auth/src/authorization.ts` 的 Workspace RBAC。 | 旧 `opsAdminActionSchema` 只有 action/jobId/reason，**不是** §28.5 的预检、审批、风险、批项与幂等生命周期。平台身份/权限契约待 N15-02—04。 |
| DB | `users/sessions`、`workspaces/members/invitations`、`projects`、`jobs`、`provider_generations/provider_catalog_versions`、`plans/workspace_subscriptions`、`credit_ledger/credit_holds`、`billing_events/workspace_billing_states`、`assets`、`publications`、`audit_log/abuse_flags/support_access_grants` 等现存 schema。 | §28.19 的 AdminPrincipal、RoleGrant、AdminAction、Approval、SupportTicket、MetricDefinition、ReconciliationCase、PrivacyRequest、Incident、DataExportJob 等运营治理对象尚未发现对应专用实体；逐项任务按需要新增，不能预建空表或复制账本/素材模型。 |
| Domain/service | `packages/domain/src/ops.ts` 汇总/任务重试；`security-ops.ts` 脱敏列表、滥用限制、限时支持访问与审计；现有 jobs、billing/credits/payments/plans、assets、providers 服务。 | 旧写入直接由 admin 路由调用领域服务并另记审计，没有统一预检/审批/作用域快照；N15-04/05 要把危险操作编译到 AdminAction，再复用领域命令与 Outbox。 |
| API | `admin.ts` 的 overview/jobs/retry/audit；`admin-security.ts` 的用户、工作区、项目、Provider、存储、积分、滥用、支持访问；`admin-metrics.ts` 的 Prometheus 文本；`plans.ts` 与 `payments.ts` 的旧管理员写入。 | 无 `/ops` 或精细角色路由；旧写入口仍可直接执行。旧 `credits/refund` 是**Credits 账本冲正**，不是外部支付原路退款；后者归 N15-22。 |
| SDK/UI | `packages/sdk/src/client.ts` 的 `admin` 方法；Web `/admin` 与 `SecurityOps.tsx` 可见列表、任务重试、支持授权/滥用按钮；客户 settings/team/billing 路由另存。 | 旧单页缺 §28.3 的列表→详情→影响预检→授权动作→逐项结果、字段权限、全局搜索、环境提示。N15-06 后按职责组织，不把 Studio 权限嫁接给平台。 |
| Tests（只盘点，未运行） | `apps/api/src/admin.integration.test.ts` 覆盖 Owner→404、401、总览/任务重试/指标；`security-ops.integration.test.ts` 覆盖限制、支持访问留痕；`packages/auth/src/rbac.security.test.ts` 覆盖租户/Owner 不变量；Web `admin.test.tsx`、`security-ops.test.tsx`。billing/payments/jobs/credentials 与 worker recovery 另有既存套件。 | 缺独立平台会话/MFA、角色与对象矩阵、AdminAction 双人审批及崩溃恢复、每模块成功/失败/审计/导出权限的 v0.4 验证。现有测试文件存在不等于本次已执行或 O 门已过。 |

## 3. OP01—OP24 模块映射

门列表示**最早必须具备的治理门**，带“前置”者应在相应产品能力启用前验收，即使其归入较晚的 O 总门。角色是 §28 目标角色/职责，尚不是现存授权。每行给出当前实体与路由证据、N15 任务和增量界限。

| 模块／门 | 当前实体与路由；差项 | 目标授权角色 | 任务与复用结论 |
|---|---|---|---|
| OP01 经营与运行总览／O0 运行、O1 经营 | `jobs/renders/provider_generations/credit_ledger`；A:`/overview`, `/metrics` 只有运行聚合，缺版本化 MetricDefinition、水位、实收/MRR 来源。 | 运营、经营分析 | N15-07/08；复用运行事实，经营指标按定义补齐，不以 Credits 扣减冒充收入。 |
| OP02 用户中心／O0 | `users/sessions/abuse_flags`；A:`/users`, `/abuse-flags` 可读摘要及限制，缺受控账号生命周期、字段权限和会话撤销动作。 | SUPPORT_L1/L2、账号运营 | N15-10；复用用户/限制实体，写操作进 AdminAction。 |
| OP03 工作区与团队／O1 | `workspaces/members/invitations/workspace_subscriptions`；A:`/workspaces`，W:`/members`, `/invitations`；缺平台席位/转移工单及客户 Billing Manager。 | 客户 Owner/Admin/Billing Manager 仅本租户；平台账号运营按范围 | N15-11；复用 workspace RBAC/成员服务，平台与客户入口分离。 |
| OP04 客服与支持／O0 最小链 | `support_access_grants/audit_log`；A:`/workspaces/:workspaceId/support-grants`, `/workspaces/:workspaceId/support-view`；无 SupportTicket、SLA、分派/回复/诊断包。 | SUPPORT_L1/L2 | N15-12/13；复用限时 grant 与留痕，不将 grant 当客户授权已完成。 |
| OP05 项目诊断／O0 | `projects/project_versions/jobs/assets`；A:`/projects` 仅摘要；无跨对象脱敏时间线/诊断包。 | SUPPORT_L2、PRODUCTION_OPERATOR | N15-14；复用项目、版本、任务引用，私密内容默认不可见。 |
| OP06 制作任务与队列／O0 | `jobs/job_dependencies/provider_generations`；A:`/jobs`, `/jobs/:jobId/retry`；缺 DAG/attempt 详情、受控取消/死信及 AdminAction。 | PRODUCTION_OPERATOR | N15-15/16；复用 Job lease、退避、恢复和预算约束。 |
| OP07 供应商与凭据／O0 | `provider_catalog_versions/provider_generations` 及 workspace 凭据实体；A:`/provider-status`，W:`/provider-connections`, `/provider-route`；缺平台路由预演、健康/熔断、密钥托管职责与审批。 | PROVIDER_MANAGER、密钥托管角色 | N15-17/18；复用密文/指纹/轮换，不回传 Secret。 |
| OP08 商品套餐权益／O1 | `plans/workspace_subscriptions`；`/plans`, W:`/entitlements`, A:`/workspaces/:workspaceId/plan`；版本化套餐已有，缺草拟、影响预览、审批、生效流程。 | 商品运营、BILLING_OPERATOR/APPROVER | N15-19；复用不可变 Plan 版本和订阅历史，不建第二套套餐。 |
| OP09 订单订阅／O1 | `billing_events/workspace_billing_states/workspace_subscriptions`；W:`/billing`, `/billing/checkout`, `/billing/portal`；缺平台订单/账期/续费排查台。 | BILLING_OPERATOR、账号运营 | N15-20；复用支付事件和现有订阅，不凭估计状态确认实收。 |
| OP10 Credits 用量成本／O0 账本、O1 报告 | `credit_ledger/credit_holds/workspace_budgets/provider_generations`；W:`/billing/ledger`, `/budget`，A:`/workspaces/:workspaceId/credits`；缺跨维追账与成本覆盖标记。 | BILLING_OPERATOR、成本运营 | N15-21/23；现有 append-only 账本为唯一权威，补事实追踪/报表。 |
| OP11 支付退款对账／O1 | `billing_events/credit_ledger`；A:`/workspaces/:workspaceId/credits/refund` 仅 Credits 冲正，W:`/billing/credits/reconcile`；无支付原路退款/拒付/差异案件。 | BILLING_OPERATOR 申请、BILLING_APPROVER 独立批准 | N15-22；复用支付适配器/账本，新增 RefundRequest/ReconciliationCase，不把 Credits refund 当现金退款。 |
| OP12 素材存储／O0 | `assets/asset_versions/upload_intents`；W:`/assets`, `/assets/:assetId/restore`，A:`/storage` 摘要；缺平台依赖保护、配额预演/回收证据。 | 存储运维、PRIVACY_OFFICER | N15-24；复用资产和引用模型，不建第二份素材目录。 |
| OP13 声音数字人授权／能力前置 | `creator_identities`/voice-clone 同意与供应商删除流程；W:`/creator-identities`, `/creator-identities/:creatorIdentityId/voice-clone/consent`, `/creator-identities/:creatorIdentityId/voice-clone/delete-provider-voice`；缺平台授权案件/复核。 | 身份审核、PRIVACY_OFFICER | N15-26；复用已有身份/同意记录，启用相应能力前验收。 |
| OP14 内容安全投诉申诉／能力前置 | `abuse_flags`；A:`/abuse-flags`, `/workspaces/:workspaceId/abuse-state` 是粗粒度限制；无 ModerationCase/Appeal、证据 scope 和复核角色。 | CONTENT_REVIEWER、REVIEW_LEAD | N15-27；复用限制原语，补案件/申诉与职责分离。 |
| OP15 隐私数据请求／O1 | 已有 workspace 隐私档位、资产删除/恢复；无 PrivacyRequest/DeletionItem/RetentionException 或受控导出证明 API。 | PRIVACY_OFFICER、SECURITY_ADMIN | N15-25；复用资产/Provider 删除服务，跟踪原件、派生、向量、备份和保留例外。 |
| OP16 策略组件 Pack 审核／上架前置 | 创作侧策略/Pack 数据以对应领域为准；现无平台发布审核运营路由或 StrategyRelease。 | STRATEGY_CURATOR、内容审核 | N15-28；复用创作侧版本，不另建可绕过版权/sandbox 的策略发布权威。 |
| OP17 Agent 模型质量／升级前置 | Provider 目录与生成记录可供事实；现无 ModelRelease、prompt/tool 评测、灰度/回滚运营路由。 | AI_QUALITY | N15-29；复用 Provider/任务证据，在线升级先有回归治理。 |
| OP18 配置实验发布／O0 基本开关、O2 完整实验 | 部署环境配置存在，尚无 ConfigChange/审批/实验分组 `/ops` 能力。 | 发布管理员、审批人 | N15-30；配置 flag 只控制功能放量，不代替权限检查；危险开关经 AdminAction。 |
| OP19 增长生命周期／O2 | `analytics_events/video_performance/scene_performance` 可作来源；无定义过的全价值漏斗/cohort 平台页面。 | GROWTH_ANALYST | N15-09；复用真实事件，缺失/延迟不可显示为 0。 |
| OP20 通知触达／O1 事务、O2 营销 | `notifications` 存在；未见 NotificationCampaign/AudienceSnapshot 或营销同意/退订运营工作流。 | 客服、运营；营销需授权范围 | N15-31；复用事务通知，营销受众与同意独立审查。 |
| OP21 发布 CMS 开发者集成／功能前置 | `publications`、CMS 摄取/回写目标与尝试；W:`/cms/ingest`, `/cms/writeback-attempts` 等；无统一平台连接诊断/API Key 治理。 | 集成支持；客户 Admin 仅本租户 | N15-32/35；复用发布和 CMS deliveryId 证据，跨租户查看必须平台授权。 |
| OP22 事故告警成本止损／O0 | A:`/overview` 的阈值 alert 与 `/metrics`，任务限制/预算原语；无 Incident/Alert/RecoveryRun 案件、值班和受控止损。 | PRODUCTION_OPERATOR、事故指挥 | N15-33；复用监控事实/预算，停派与恢复走风险动作及审计。 |
| OP23 运营身份审批审计／O0 | `audit_log/support_access_grants`；A:`/audit-log`, `/audit`；旧白名单与普通会话，缺 AdminPrincipal/RoleGrant/Approval、不可篡改证据声明与敏感导出。 | SECURITY_ADMIN、AUDITOR | N15-02/03/04/05/36；复用审计事实，独立会话、双人原则与下载审计待建。 |
| OP24 环境容量恢复／O0 基本、O1 恢复 | 运行指标与现有运维 runbook 可查；无环境/备份/演练状态实体或 `/ops` 恢复动作。 | 可靠性、发布管理员 | N15-34；复用部署/监控证据，生产恢复经隔离演练与审批。 |

横切任务：N15-06 为导航/搜索/详情框架，N15-36 为批量和敏感导出；N15-37、38、39 分别验证 O0、O1、O2，N15-40 做全角色回归。24 模块的最终验收必须分别含读取、授权动作、成功/失败反馈、审计，不因本表“可复用”而视为完成。

## 4. 生产开关、旧入口与迁移约束

1. **现状风险。** `packages/contracts/src/env.ts` live 校验要求 `ANCS_PLATFORM_ADMINS` 非空；清空名单不是可用的生产关闭方案。白名单目前能直接调用 A:`/jobs/:jobId/retry`、套餐指派、Credits 赠送/冲正、滥用限制与支持 grant。这些写路由仍可执行，不能宣称已有审批安全门。
2. **拟实施开关。** N15-02/03 建平台专用 principal/audience、MFA、环境与职责授权；N15-04/05 在 API/domain 设置默认关闭的运营写能力与按动作风险策略，所有有副作用的旧/新入口都进入同一 AdminAction 或明确拒绝。具体配置名、默认值和生产演练由实现任务定稿；本文未新增运行开关。N15-30 的业务 flag 不能替代服务器授权。O0 之前验收应检查旧 POST 也受同一门约束。
3. **兼容路径。** Web `/admin`、SDK `admin` 和 API `/api/v1/admin` 读路由在迁移期保留，按新权限投影到相同领域查询；新 `/ops` 语义路由复用服务。旧写调用在新协议上线时转换为 AdminAction（含预检/审批/状态）或 fail closed，并向旧客户端给出明确迁移错误；不得暗中维持直写旁路。最终移除旧入口需单独兼容性验收。
4. **单一权威。** 套餐/订阅、Credits 账本、支付事件、素材、任务及 Provider 记录继续使用现有 domain 与 DB；运营读模型可聚合/缓存但注明来源和更新时间，写操作通过既有领域命令/Outbox，跨外部支付或 Provider 结果用可恢复工作流。审批前后固定目标 ID、revision、作用域、预算和影响 hash；高风险两名独立操作者，不能自批。

## 5. 后续验证优先级

- N15-02—05 先解决独立身份、精细授权、AdminAction、追加审计；其负面测试应覆盖 workspace OWNER 越权、跨租户枚举、旧写路由旁路、自批、权限变化后执行、生产/测试混用。
- O0 以 N15-37 的依赖和负面测试为准；O1 以 N15-38，O2 以 N15-39/40 为准。高风险策略、身份、模型、发布功能按对应前置治理提前验证。
- 本次只读盘点未运行数据库或浏览器测试，也没有真实 Provider/支付验证。详细命令与界限见 `docs/verification/N15-01.md`。
