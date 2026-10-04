# 0002 arch-check 白名单规则的语义：只约束生产依赖方向

- 状态：生效（2026-10-04，P00-03）
- 背景：`packages/arch-check` 原有规则（R4/R5）对所有 workspace 依赖（含 devDependencies）执行白名单检查。P00-03 需要 `apps/api` 在集成测试中以 **devDependency** 身份引入 `@ancs/sdk`（扮演客户端做真实 HTTP 往返），并新增 R7/R8（api/worker、render-worker 的生产依赖白名单）。若白名单继续覆盖 devDependencies，测试用途的引用会被错误拦截。
- 裁决：**白名单类规则（R4/R5/R7/R8）只检查 `dependencies`（生产依赖）；层间隔离规则（R1 apps↔apps、R2 packages→apps、R3 domain 隔离、R6 悬挂引用）继续检查全部依赖（含 devDependencies）。**
- 理由：依赖方向约束的本质是"运行时架构边界"；devDependencies 仅参与测试与工具链，不进入运行时分发。层间隔离（如 packages 不得依赖 apps）属于组织边界，任何形式都应禁止，因此保持全量检查。
- 影响：
  1. 新增 R7（apps/api|worker 生产依赖 ⊆ domain/contracts/db + packages/providers/*，计划 §3.4）与 R8（apps/render-worker|motion-worker 生产依赖 ⊆ contracts/scene-schema/scene-components/remotion-core）。
  2. `scan.ts` 增加 `prodDeps` 字段；规则测试覆盖"生产依赖违规"与"仅 devDependency 合法"两类场景。
  3. 若未来需要收紧某条 devDependency 边，应在对应任务中新增独立规则并附裁决记录，而不是恢复全量白名单。
- 关联：REQ-49-02；`packages/arch-check/src/rules.ts`；`docs/verification/P00-03.md`。
