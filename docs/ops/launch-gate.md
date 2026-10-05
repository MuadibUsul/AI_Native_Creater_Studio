# 商业上线门（P09-06 / 规范 §47、§43.3；计划 §8）

> **性质**：本文件是**对外收款与公开注册的放行台账**（fail-closed）。
> - **机器条件**（可由 `scripts/launch-gate-check.mjs --live` 校验，并已在 API 启动时强制）：见下方「机器条件」；
> - **人工条件**（法务/商务/财务）逐条记录于「放行台账」——**状态仅允许 `BLOCKED` / `APPROVED`**，
>   `APPROVED` 必须附**可核对证据**（合同编号/签署日期/发票主体/政策文档版本链接）；
> - **放行规则**：`ANCS_SAAS_MODE=live`（正式收款与公开注册）要求
>   ① 机器条件全部满足 ② 台账全部 `APPROVED`——任一未满足即**拒绝**（脚本 exit 1；API 启动失败）。
> - 现状：**全部人工条件 BLOCKED**（所需外部条件未完成）；默认 `ANCS_SAAS_MODE=internal`（预上线内部使用）。
> - **不假称完成**：本文件任何 `APPROVED` 状态都必须先有外部证据——不得为推进而勾选。

## 机器条件（live 模式，API 启动强制 + 脚本校验）

| 条件 | 口径 | 校验点 |
|---|---|---|
| `ANCS_DEFAULT_PLAN=FREE` | 未订阅工作区不得获得内部不限额度（预上线默认 ENTERPRISE 仅限 internal） | `crossCheckApiEnv`（启动 fail-closed） |
| `ANCS_PAYMENTS_DRIVER=stripe` | mock 渠道无真实扣款能力，不得承载正式收款（真实适配器接入前 live 恒失败） | 同上 |
| `ANCS_STORAGE_DRIVER≠local` | 生产需对象存储（S3/R2 适配器未实现 → live 恒失败——诚实标注） | 同上 |
| `BETTER_AUTH_URL=https://…` | 生产会话基址必须 https | 同上 |
| `ANCS_PLATFORM_ADMINS` 非空 | 运营面不可缺席 | 同上 |
| 公开注册未开启 | 账号经内部 CLI 创建（P01-02）；**无公开注册端点**——与门禁一致 | 代码现状 |

## 放行台账（人工条件；现状全部 BLOCKED）

| ID | 条目（§47/§67 要求） | 要求（证据） | 状态 | 证据 / 阻塞原因 |
|---|---|---|---|---|
| LG-01 | 重核所有 Provider 现行 Terms（§47：不得假定"有 Key=可转售"） | 各 Provider 条款版本 + 复核日期 + 结论（可用/需协议/禁用） | BLOCKED | 需人工（法务）：账号开通后逐家复核；与 REQ-A-01 合并执行 |
| LG-02 | API 嵌入 / 白标 / 最终用户访问许可确认 | 各 Provider 白标条款结论（或协议编号） | BLOCKED | 需人工（法务/商务） |
| LG-03 | 需 Enterprise/Integrated Application 协议的 Provider 签订 | 协议编号 + 签署日期 | BLOCKED | 需人工（商务）；以 LG-01/02 结论为前提 |
| LG-04 | 数字人 / 声音克隆授权与 Consent 流程（用户侧同意 + 我方合规口径） | Consent 文案版本 + 流程截图 + 法务确认 | BLOCKED | 需人工（法务）；P06 真实接入时同步核验 |
| LG-05 | Content Policy 建立（§47） | 政策文档版本（法务签署）+ 上线页面 | BLOCKED | 需人工（法务） |
| LG-06 | Abuse Policy 建立（§47；与 P09-05 标记/限制机制对齐） | 政策文档版本 + 处置流程（对应 abuse_flags/RESTRICTED 操作口径） | BLOCKED | 需人工（法务/运营） |
| LG-07 | Privacy Policy（含 §20.5 口径：No training≠No storage；API≠Zero retention；Delete output≠Delete logs） | 政策文档版本 + 与实现对照表 | BLOCKED | 需人工（法务/隐私）；实现侧对照见 docs/verification/P09-05.md 与 P03-03 记录 |
| LG-08 | Terms of Service | 文档版本 + 上线页面 | BLOCKED | 需人工（法务） |
| LG-09 | DPA（按目标市场，§47） | DPA 模板版本（目标市场清单） | BLOCKED | 需人工（法务） |
| LG-10 | 主体与税务（收款主体/发票/税率） | 主体信息 + 开票方案 + 税务确认 | BLOCKED | 需人工（财务/商务） |
| LG-11 | 正式支付开通（真实渠道账号 + 生产 webhook 配置 + 密钥注入） | 渠道账号 + 生产密钥注入记录（KMS/Secrets）+ 事件回放演练 | BLOCKED | 需人工（商务/工程）；mock 已同构验证（P09-02/P09-03），真实渠道接入 BLOCKED 凭据 |
| LG-12 | Remotion 授权核验（商业使用许可） | 许可证类型/编号 + 适用主体确认 | BLOCKED | 需人工（法务）；附录 A 基线复核项 |
| LG-13 | 政策文档上线（页面 + 版本留档） | 上线 URL + 版本留档（与 LG-05..09 关联） | BLOCKED | 需人工（工程/法务）；依赖 LG-05..09 |
| LG-14 | 数据保留/删除对外说明与实现一致（§20.3/§20.5） | 说明文档 + 与 TTL/回收实现对照 | BLOCKED | 需人工（隐私/工程）；TTL 已由 P02-05 实现 |

## 放行操作（完成全部条件后）

1. 逐条把台账状态改为 `APPROVED` 并填写证据（**先有证据后勾选**）。
2. 运行 `node scripts/launch-gate-check.mjs --live`：要求**零 BLOCKED 且零机器条件问题**（exit 0）。
3. 以 live 运行配置部署（`ANCS_SAAS_MODE=live` + 机器条件），启动前仍会做最后一道 fail-closed 校验。
4. 关闭公开注册之前不得对外投放注册入口（当前无公开注册端点）。

## 校验与引用

- 脚本：`scripts/launch-gate-check.mjs`（默认=信息模式：输出台账与机器条件，CI 执行；`--live`=放行判定，任一未满足 exit 1）。
- 环境校验：`packages/contracts/src/env.ts` 的 `crossCheckApiEnv`（live 机器条件；测试见 `env.test.ts`）。
- 部署 Runbook：`docs/ops/deployment-runbook.md`（"商业上线门"一节）。
