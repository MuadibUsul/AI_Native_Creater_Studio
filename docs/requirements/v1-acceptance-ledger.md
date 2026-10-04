# V1 验收账本（§77 / §78 / 附录 C / §96）

- 任务：P00-01（计划 §12 覆盖索引要求"验收清单 附录 C、96 → P00 逐项建账，阶段门逐项关闭"）
- 用途：G4（内部生产可用）与 G8（全规范覆盖）的逐项关闭清单；P08-06 对账依据。
- 规则：
  1. 每项初始 `TODO`；关闭时须有可执行证据（测试、脚本输出、账号截图、人工评审记录），记录在 `docs/verification/`。
  2. Mock 验证通过不等于真实 Provider 验证通过；接口存在不等于功能交付。
  3. 阶段门（G0—G4）关闭时逐项核验；任一项未关闭不得称"V1 可内部生产使用"。
- 关联文件：`docs/requirements/traceability.md`（REQ 编号与任务映射）、`ANCS_Plan261004.md` §11.4。

## 1. §77 Definition of Done — Web MVP（24 项）

| ID | 条目 | 关联 REQ | 任务（阶段） | 状态 |
|---|---|---|---|---|
| LED-77-01 | 用户可以登录并进入 Workspace | REQ-30-01/REQ-22-01 | P01-02/P01-03（P01） | VERIFIED（2026-10-04：登录 → 创建/列出/进入 Workspace（含 OWNER 自动成员）全链路测试） |
| LED-77-02 | 可以创建 Channel / Creator Profile | REQ-6-01/REQ-6-02 | P01-04（P01） | TODO |
| LED-77-03 | 可以从 URL 或粘贴文本创建 Project | REQ-4-01 | P04-01（P04） | TODO |
| LED-77-04 | 系统生成 Narrative Script | REQ-8-01 | P04-03（P04） | TODO |
| LED-77-05 | 系统生成结构化 Scene Graph | REQ-12-01/REQ-12-02 | P02-01/P04-05（P02/P04） | TODO |
| LED-77-06 | 至少 15 个高质量 Standard Scene Components 可工作（本计划交付 20 个，DEC-04） | REQ-65-01/REQ-64-02 | P05-02（P05） | TODO |
| LED-77-07 | Remotion Player 可实时 Preview | REQ-38-01 | P05-04（P05） | TODO |
| LED-77-08 | 用户可自然语言要求修改 Scene/Storyboard | REQ-37-01 | P05-06（P05） | TODO |
| LED-77-09 | 用户可手动 reorder/trim/delete/replace Scene | REQ-3-05/REQ-5-07 | P05-05（P05） | TODO |
| LED-77-10 | 有 Lite Timeline | REQ-5-07 | P05-05（P05） | TODO |
| LED-77-11 | 有 Undo / History / Version | REQ-5-08/REQ-23-03 | P02-03（P02） | VERIFIED（2026-10-04：服务端 Undo/Redo（补偿事件、LIFO、新编辑结束重做分支）/项目版本快照/整项目与单 Scene Restore 全链路测试；恢复产生新 revision 且旧版本与账本逐字节不变；History UI 属 P05-03） |
| LED-77-12 | 有资产上传和 Object Storage | REQ-26-02/REQ-22-04 | P02-04（P02） | VERIFIED（2026-10-04：真实本地对象存储驱动端到端——意图→签名直传→真实探测确认→Signed URL 下载回读；伪造 MIME/越权对象/不完整上传不可 Ready；S3/R2 云适配器待真实凭据，§13.5-8） |
| LED-77-13 | 有至少一个真实 Avatar Provider | REQ-64-04/REQ-14-02 | P06-04（P06） | TODO（前置：Mock Provider 与故障矩阵已就位（P03-07）；真实账号待 P06-04） |
| LED-77-14 | 有至少一个真实 Voice Provider | REQ-6-07/REQ-14-03 | P06-02（P06） | TODO |
| LED-77-15 | 有至少一个真实 AI Video Provider（默认 Veo，DEC-05） | REQ-64-04/DEC-05 | P06-05（P06） | TODO |
| LED-77-16 | 外部任务异步执行并显示状态 | REQ-2-05/REQ-29-06 | P03-01/P02-06（P03/P02） | TODO（进度：任务系统（状态机/依赖/租约/Worker）与 job.* 事件已就位（P03-01）；真实外部生成任务的端到端执行随 P03-06/P06/P07） |
| LED-77-17 | Provider 结果会回收到自己的 Storage | REQ-45-02/REQ-26-01 | P03-06（P03） | VERIFIED（2026-10-04：通用回收链路——下载（大小上限/超时）→ 校验（大小/魔术字节嗅探/校验和）→ 写入自有存储 → 落 Asset；测试含「Provider URL 失效后已完成资产仍可用」（AC-10）与「下载失败不重生成、只重试回收」（AC-09）） |
| LED-77-18 | 能输出 1080p 完整 MP4 | REQ-4-04 | P07-04（P07） | TODO |
| LED-77-19 | 能输出字幕（SRT/VTT） | REQ-58-01 | P06-06（P06） | TODO |
| LED-77-20 | 能生成 Project Manifest | REQ-28-01 | P07-04（P07） | TODO |
| LED-77-21 | 有 per-generation cost 记录 | REQ-25-01 | P03-05（P03） | TODO（进度：provider_generations 表（含估算/实际成本、延迟、重试、凭证模式）+ 幂等记录原语已就位（P03-05）；真实成本数值待 P06 实测写入） |
| LED-77-22 | 有 Workspace 数据隔离测试 | REQ-43-01/REQ-51-06 | P01-03（P01） | TODO（进度：跨 workspace 读/写拒绝 + Signed URL scope + 资产侧凭据隔离（P02-04，security 19 项）；Provider 凭据隔离待 P03-04） |
| LED-77-23 | 后端 API 可独立于 Web 被调用 | REQ-29-02 | P01-05（P01） | VERIFIED（2026-10-04：示例与 CI 均在不启动 Web 下完成授权读写） |
| LED-77-24 | Shared SDK 可以被未来 Native Client 使用 | REQ-29-04/REQ-63-01 | P01-05（P01） | TODO |

## 2. §78 Definition of Done — Multi-Client Readiness（11 项）

| ID | 条目 | 关联 REQ | 任务（阶段） | 状态 |
|---|---|---|---|---|
| LED-78-01 | 所有业务能力有 REST API | REQ-32-01 | P01-05 起各阶段（P01+） | TODO |
| LED-78-02 | API 有版本 | REQ-29-03（DEC-01：/api/v1） | P01-05（P01） | VERIFIED（2026-10-04：全路由 /api/v1 + 客户端标头） |
| LED-78-03 | Auth 可以支持 Native token flow | REQ-30-03 | P01-02（P01） | TODO |
| LED-78-04 | 所有 DTO 有 shared schema | REQ-29-04 | P01-01（P01） | VERIFIED（2026-10-04：全部 DTO 位于 @ancs/contracts，api/sdk/testing 共用） |
| LED-78-05 | Asset 上传流程不依赖 browser-only logic | REQ-26-02 | P02-04（P02） | TODO |
| LED-78-06 | Job progress 有通用事件协议 | REQ-29-06 | P02-06（P02） | TODO |
| LED-78-07 | Project/Scene 使用 server revision | REQ-29-05 | P02-02（P02） | TODO |
| LED-78-08 | Business logic 不依赖 Next.js | REQ-29-02/REQ-49-02 | P00-02/P01-05（P00/P01） | TODO |
| LED-78-09 | Provider logic 不依赖 Web | REQ-49-02/REQ-15-01 | P03-03（P03） | TODO |
| LED-78-10 | Render 在 server/cloud | REQ-39-01 | P07-04（P07） | TODO |
| LED-78-11 | Notification 由 backend event 产生 | REQ-61-01 | P02-06（P02） | TODO |

## 3. 附录 C 首批工程验收清单（49 项）

### 3.1 Architecture（8）

| ID | 条目 | 关联 REQ | 任务（阶段） | 状态 |
|---|---|---|---|---|
| LED-C-ARCH-01 | Monorepo exists | REQ-49-01 | P00-02（P00） | VERIFIED（2026-10-04，证据：docs/verification/P00-02.md） |
| LED-C-ARCH-02 | Web and API are separate apps | REQ-29-02 | P00-02/P01-05（P00/P01） | TODO |
| LED-C-ARCH-03 | Shared contracts package exists | REQ-29-04 | P01-01（P01） | VERIFIED（2026-10-04：@ancs/contracts 正式化，被 api/sdk/testing 共用；证据：docs/verification/P01-01.md） |
| LED-C-ARCH-04 | OpenAPI generated | REQ-29-04/REQ-33-02 | P01-01（P01） | VERIFIED（2026-10-04 机制已核：/openapi.json 由同一份 Zod 契约生成并被测试断言；内容随 P01 扩展。证据：docs/verification/P00-03.md） |
| LED-C-ARCH-05 | SDK usable independently | REQ-29-02 | P01-05（P01） | VERIFIED（2026-10-04：全量 SDK + 独立客户端示例实跑 + CI 工作流测试；证据：docs/verification/P01-05.md） |
| LED-C-ARCH-06 | PostgreSQL migration system works | REQ-34-01 | P00-02 起（P00/P02） | TODO |
| LED-C-ARCH-07 | Redis/BullMQ works | REQ-19-05 | P03-01（P03） | TODO |
| LED-C-ARCH-08 | Object Storage direct upload works | REQ-26-02 | P02-04（P02） | TODO |

### 3.2 Domain（10）

| ID | 条目 | 关联 REQ | 任务（阶段） | 状态 |
|---|---|---|---|---|
| LED-C-DOM-01 | Workspace | REQ-22-01 | P01-03（P01） | VERIFIED（2026-10-04：workspaces/workspace_members + 迁移 0001 + 服务与授权；证据：docs/verification/P01-03.md） |
| LED-C-DOM-02 | Channel | REQ-6-01/REQ-22-02 | P01-04（P01） | VERIFIED（2026-10-04：channels + 不可变样式版本 + 快照语义测试；证据：docs/verification/P01-04.md） |
| LED-C-DOM-03 | Creator Profile | REQ-6-02 | P01-04（P01） | VERIFIED（2026-10-04：CreatorIdentity + 独立版本化子身份（Avatar/Voice/Brand）+ SpeechProfile；证据：docs/verification/P01-04.md） |
| LED-C-DOM-04 | Project | REQ-22-02 | P02-01（P02） | VERIFIED（2026-10-04：projects 表 + Channel 快照 FK + revision；证据：docs/verification/P02-01.md） |
| LED-C-DOM-05 | Scene | REQ-22-03 | P02-01（P02） | VERIFIED（2026-10-04：scenes 规范化表 + 独立 revision + Graph 组装） |
| LED-C-DOM-06 | Asset | REQ-22-04 | P02-04（P02） | TODO |
| LED-C-DOM-07 | Version | REQ-23-03 | P02-03（P02） | TODO |
| LED-C-DOM-08 | Edit Event | REQ-23-02 | P02-02（P02） | VERIFIED（2026-10-04：edit_events 全字段 + base/result revision + 同事务 Outbox；证据：docs/verification/P02-02.md） |
| LED-C-DOM-09 | Job | REQ-19-01 | P03-01（P03） | TODO |
| LED-C-DOM-10 | Provider Generation | REQ-25-01 | P03-05（P03） | TODO（进度：模型就位（provider_generations，P03-05）；生成链路写入随 P03-06/P06） |

### 3.3 AI（6）

| ID | 条目 | 关联 REQ | 任务（阶段） | 状态 |
|---|---|---|---|---|
| LED-C-AI-01 | ContentDocument schema | REQ-7-01 | P04-01（P04） | TODO |
| LED-C-AI-02 | NarrativePlan schema | REQ-8-01 | P04-03（P04） | TODO |
| LED-C-AI-03 | SceneGraph schema | REQ-12-01 | P01-01/P02-01（P01/P02） | VERIFIED（2026-10-04：契约就绪（P01-01）+ DB 状态组装为合法 Graph（P02-01）） |
| LED-C-AI-04 | Visual Grammar mapping | REQ-10-01 | P04-04（P04） | TODO |
| LED-C-AI-05 | Director structured output | REQ-9-02/REQ-52-01 | P04-05（P04） | TODO |
| LED-C-AI-06 | AI Edit change plan | REQ-37-01 | P05-06（P05） | TODO |

### 3.4 Video（7）

| ID | 条目 | 关联 REQ | 任务（阶段） | 状态 |
|---|---|---|---|---|
| LED-C-VID-01 | Remotion Player | REQ-38-01 | P05-04（P05） | TODO |
| LED-C-VID-02 | Standard Scene library | REQ-11-01/REQ-65-01 | P05-02（P05） | TODO |
| LED-C-VID-03 | Draft preview | REQ-38-01/REQ-18-01 | P05-04（P05） | TODO |
| LED-C-VID-04 | Master narration | REQ-13-01 | P06-03（P06） | TODO |
| LED-C-VID-05 | Subtitle timing | REQ-13-02/REQ-58-01 | P06-03/P06-06（P06） | TODO |
| LED-C-VID-06 | Final render | REQ-39-01/REQ-64-05 | P07-04（P07） | TODO |
| LED-C-VID-07 | Manifest | REQ-28-01 | P07-04（P07） | TODO |

### 3.5 Reliability（6）

| ID | 条目 | 关联 REQ | 任务（阶段） | 状态 |
|---|---|---|---|---|
| LED-C-REL-01 | idempotency | REQ-33-01/REQ-69-01 | P02-02/P03-05（P02/P03） | TODO（进度：API/编辑协议幂等（AC-03，P02-02）；幂等键 TTL 清理（P02-05）；Provider 凭据操作幂等（P03-04）；**账本结算幂等（回调重放只结算一次）+ 用量记录唯一键重放（P03-05）**；生成指纹与"先查 succeeded"随 P03-06/P06） |
| LED-C-REL-02 | retry policy | REQ-19-03/REQ-71-01 | P03-02（P03） | TODO |
| LED-C-REL-03 | provider concurrency limiter | REQ-19-03/REQ-19-04 | P03-01/P03-03（P03） | TODO |
| LED-C-REL-04 | result persistence | REQ-45-02/REQ-71-01 | P03-06（P03） | TODO |
| LED-C-REL-05 | failure fallback | REQ-55-01 | P04-05/P03-02（P04/P03） | TODO |
| LED-C-REL-06 | cost ledger | REQ-25-01/REQ-35-02 | P03-05（P03） | VERIFIED（2026-10-04：credit_ledger 只追加（余额为条目效果推论）+ 预算/原子预留/结算幂等/退款（HOLD_RELEASE 释放）全链路测试；Provider 成本数值随 P06 实测写入） |

### 3.6 Security（6）

| ID | 条目 | 关联 REQ | 任务（阶段） | 状态 |
|---|---|---|---|---|
| LED-C-SEC-01 | tenant isolation tests | REQ-43-01/REQ-51-06 | P01-03（P01） | VERIFIED（2026-10-04：test:security 真实套件 14 项含跨租户全拒绝；资源维度随 P02 扩充） |
| LED-C-SEC-02 | KMS secret encryption | REQ-17-03/REQ-43-06 | P03-04（P03） | TODO |
| LED-C-SEC-03 | signed upload | REQ-26-02 | P02-04（P02） | TODO |
| LED-C-SEC-04 | SSRF protection | REQ-43-02 | P04-01（P04） | TODO |
| LED-C-SEC-05 | no secrets in logs | REQ-17-03/REQ-44-02 | P03-04/P08-03（P03/P08） | TODO |
| LED-C-SEC-06 | custom motion sandbox design | REQ-11-03/REQ-43-05 | P07-01（P07） | TODO |

### 3.7 Multi-client readiness（6）

| ID | 条目 | 关联 REQ | 任务（阶段） | 状态 |
|---|---|---|---|---|
| LED-C-MC-01 | no domain logic in web-only components | REQ-2-06/REQ-49-02 | P00-02/P01-05（P00/P01） | TODO |
| LED-C-MC-02 | auth flow supports native clients | REQ-30-03 | P01-02（P01） | VERIFIED（2026-10-04：PKCE S256 + 轮换令牌全流程真实测试；证据：docs/verification/P01-02.md） |
| LED-C-MC-03 | revision-based edits | REQ-23-04/REQ-29-05 | P02-02（P02） | VERIFIED（2026-10-04：条件更新 + 409 刷新信息，服务与 HTTP 双层锁定） |
| LED-C-MC-04 | realtime event protocol | REQ-29-06 | P02-06（P02） | TODO |
| LED-C-MC-05 | shared SDK | REQ-29-04 | P01-05（P01） | VERIFIED（2026-10-04：@ancs/sdk 全量资源面，双认证模式） |
| LED-C-MC-06 | no browser-only asset model | REQ-26-02/REQ-63-01 | P02-04（P02） | TODO |

## 4. §96 v0.2 增量验收清单（21 项）

### 4.1 Scope（3）

| ID | 条目 | 关联 REQ | 任务（阶段） | 状态 |
|---|---|---|---|---|
| LED-96-SCOPE-01 | V1 明确只以 Article → Professional Long Video 为主链路 | REQ-1-01 | P00/P08-06（P00/P08） | TODO |
| LED-96-SCOPE-02 | Shorts / Social / Publishing / Newsletter 不阻塞 V1 | REQ-1-01/REQ-4-06 | P00（范围裁决） | TODO |
| LED-96-SCOPE-03 | Extension contracts 不依赖 Web 前端 | REQ-92-01 | P01-06（P01） | VERIFIED（2026-10-04：R3 机械强制平台中立包（contracts/extensions 禁 Web 框架）；裁决 0004） |

### 4.2 Creator Identity / Voice（6）

| ID | 条目 | 关联 REQ | 任务（阶段） | 状态 |
|---|---|---|---|---|
| LED-96-VOICE-01 | CreatorIdentity / AvatarIdentity / VoiceIdentity 数据模型存在 | REQ-6-02/REQ-6-03/REQ-6-04 | P01-04/P06-02（P01/P06） | TODO |
| LED-96-VOICE-02 | VoiceProvider 不绑死 ElevenLabs/HeyGen | REQ-6-04/REQ-14-03 | P06-02（P06） | TODO |
| LED-96-VOICE-03 | 支持 Platform Managed 与 BYOK Voice 路由 | REQ-6-07/REQ-17-02 | P06-02（P06） | TODO |
| LED-96-VOICE-04 | 保存 Voice ownership / verification metadata | REQ-95-01 | P06-02（P06） | TODO |
| LED-96-VOICE-05 | SpeechProfile / Speech Director schema 已定义 | REQ-6-08/REQ-94-01 | P04-06（P04） | TODO |
| LED-96-VOICE-06 | Master Narration timestamp 仍是最终 Timeline timing 基础 | REQ-13-01/REQ-94-02 | P06-03（P06） | TODO |

### 4.3 Commercial（4）

| ID | 条目 | 关联 REQ | 任务（阶段） | 状态 |
|---|---|---|---|---|
| LED-96-COM-01 | Software plan 与 AI compute ledger 分离 | REQ-73-01/REQ-35-02 | P03-05（P03） | TODO |
| LED-96-COM-02 | 不存在"无限 Managed AI Generation"硬编码套餐 | REQ-73-01 | P03-05/P09-01（P03/P09） | TODO |
| LED-96-COM-03 | Final Render 前可估算 Credits / provider cost | REQ-73-05/REQ-9-02 | P03-05/P07-03（P03/P07） | TODO |
| LED-96-COM-04 | BYOK 用户可以绕过平台托管 Provider 用量，但仍通过统一 Router/Adapter | REQ-17-02/REQ-73-04 | P03-04/P06-02（P03/P06） | TODO |

### 4.4 Publishing（5）

| ID | 条目 | 关联 REQ | 任务（阶段） | 状态 |
|---|---|---|---|---|
| LED-96-PUB-01 | DistributionProvider 有 capability registry | REQ-42-02/REQ-42-03 | P01-06（P01）契约；P13-01 实现 | VERIFIED（2026-10-04：契约级——DistributionProvider 接口 + ExtensionRegistry 持有分发 Provider；真实平台接入 P13-01。证据：docs/verification/P01-06.md） |
| LED-96-PUB-02 | 支持 P1/P2/P3/P4 体验（V1=能力分级类型与协议；完整体验 P13-04） | REQ-42-02/REQ-42-04 | P01-06（契约）；P13-04 完整 | VERIFIED（2026-10-04：契约级——P1—P4 分级类型与协议就位；完整体验 P13-04） |
| LED-96-PUB-03 | P4 可生成 Export Package | REQ-42-04 | P13-04（P13） | TODO |
| LED-96-PUB-04 | 核心产品不以 browser automation 作为可靠发布能力 | REQ-42-06 | 全期；P13-01 审计 | TODO |
| LED-96-PUB-05 | Mobile Handoff 协议已预留 | REQ-42-05/REQ-42-03 | P01-06（P01）契约；P15-06 完整 | VERIFIED（2026-10-04：HandoffDescriptor 契约（状态机/限时/artifacts）就位；完整实现 P15-06） |

### 4.5 Plugin Readiness（3）

| ID | 条目 | 关联 REQ | 任务（阶段） | 状态 |
|---|---|---|---|---|
| LED-96-PLUGIN-01 | OutputPlugin / Pack registry contract 已定义 | REQ-92-01/REQ-92-03 | P01-06（P01） | VERIFIED（2026-10-04：OutputPlugin 接口 + PackManifest + registry 就位并测试） |
| LED-96-PLUGIN-02 | Core 业务没有对 XHS/YouTube/Newsletter 等输出类型硬编码分支 | REQ-92-02 | P11-03 审计（P11） | TODO |
| LED-96-PLUGIN-03 | ContentDocument / Narrative 可向 ContentCore 演进 | REQ-93-01 | P11-01（P11） | TODO |

## 汇总

| 来源 | 条目数 | 初始状态 |
|---|---|---|
| §77 Web MVP DoD | 24 | 全部 TODO |
| §78 Multi-Client Readiness | 11 | 全部 TODO |
| 附录 C | 49 | 全部 TODO |
| §96 增量验收 | 21 | 全部 TODO |
| 合计 | 105 | — |

本账本与 `traceability.md` 的"状态"列同步维护；关闭动作记录在 `docs/verification/` 对应阶段文件中。
