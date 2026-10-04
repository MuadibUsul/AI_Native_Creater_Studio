# 0003 api/worker 生产依赖白名单加入 @ancs/auth

- 状态：生效（2026-10-04，P01-02）
- 背景：R7 白名单（计划 §3.4 "api/worker → domain/contracts/db/providers"）未包含 `packages/auth`，而规范 §3.3 明确 `api/` 的职责是"HTTP、认证接入、请求授权、应用服务入口"，且计划 §3.1 规定认证采用 Better Auth + Drizzle Adapter 并置于独立包。P01-02 需要 `apps/api` 在生产依赖上引用 `@ancs/auth`。
- 裁决：R7 的允许集合扩展为 `{@ancs/contracts, @ancs/domain, @ancs/db, @ancs/auth}` + `packages/providers/*`。
- 理由：认证接入是 API 应用层的固有职责（规范 §3.3 明文列举）；把 auth 放在 provider 白名单之外会造成"要么违反 §3.4 字面、要么把认证逻辑塞进 api 本地"的两难，后者与"packages/auth 认证集成及授权规则"（§3.3）冲突。
- 影响：
  1. `packages/arch-check/src/rules.ts` 更新白名单与注释；
  2. 规则测试补 `@ancs/auth` 允许用例；
  3. 后续如需从 api/worker 引用更多共享包（storage/usage 等），仍按本流程逐条扩展并附裁决记录——不恢复"通配"。
- 关联：REQ-49-02；裁决 0002（白名单只查生产依赖）；`docs/verification/P01-02.md`。
