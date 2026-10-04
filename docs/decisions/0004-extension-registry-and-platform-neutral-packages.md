# 0004 扩展注册表接入 API；R3 覆盖平台中立包

- 状态：生效（2026-10-04，P01-06）
- 背景：
  1. 规范 §92.3 要求 V1 定义 contracts 与 registry；计划 P01-06 的验收要求"未安装能力明确返回不支持"。把这套机制落到可用形态需要一个真实装配点：API 进程在启动时构造内置注册表并暴露 `/api/v1/capabilities`。因此 `apps/api` 的生产依赖需要加入 `@ancs/extensions`（R7 白名单原为 contracts/domain/db/auth + providers）。
  2. 规范 §92.1 要求 Extension contracts 不依赖 Web 前端（REQ-92-01 / LED-96-SCOPE-03）。原 R3 只约束 `packages/domain`；`packages/contracts` 与 `packages/extensions` 同属必须平台中立的契约层，缺少机械强制。
- 裁决：
  1. R7 允许集合扩展为 `{@ancs/contracts, @ancs/domain, @ancs/db, @ancs/auth, @ancs/extensions}` + `packages/providers/*`；
  2. R3 覆盖扩展为"平台中立包"清单 `{packages/domain, packages/contracts, packages/extensions}`：均不得依赖 next/react/react-dom/@remotion/*；`packages/domain` 额外不得依赖 `packages/providers/*`（原语义保留）。
- 理由：注册表是扩展架构的装配点而非业务能力；契约层平台中立是 §92.1 的 MUST，且"契约不依赖 Web"的验收需要机械检查而非口头承诺。两者都是收紧/必要的边界扩展，不放松既有约束。
- 影响：
  1. `packages/arch-check/src/rules.ts`：`SERVER_APP_ALLOWED_PROD_DEPS` 增加 `@ancs/extensions`；新增 `PLATFORM_NEUTRAL_PACKAGE_DIRS` 常量并改写 R3 逻辑；
  2. 规则测试补充 contracts/extensions 反例；`docs/verification/P01-06.md` 记录本条为"契约不依赖 Web"的执行证据；
  3. 后续新增平台中立包（如未来的 content-core 契约）应**显式**加入该清单并附裁决记录。
- 关联：REQ-49-02、REQ-92-01、REQ-92-03；裁决 0002（白名单只查生产依赖）、0003（R7 加入 auth）。
