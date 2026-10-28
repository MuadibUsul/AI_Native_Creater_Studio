# DeepSeek 服务端导演接入（V6-1）

日期：2026-10-15。接入状态：**VERIFIED_REAL（连接、工具往返、看帧与浏览器轮次范围）**。
完整初剪质量与导出评测不在本次验证范围，不据此标记整项 V6-1 完成。

## 交付与边界

- contracts：Worker 驱动增加 deepseek，密钥配置缺失时 fail-closed。
- migration：不适用，继续使用已有 agent_turns / agent_turn_messages 用量和会话记录。
- provider：`@ancs/providers-deepseek` 实现现有 AgentModelAdapter，使用 Node fetch，无新增外部 SDK。
- domain/service：不适用，沿用统一工具目录、工作流、提案确认与用量账本。
- Worker：入口注入密钥与模型，声明 `agent_model=deepseek:REAL`；适配器不自动重试，工作流保留已有有界重试。
- API / SDK / UI：不适用，复用现有共看片室入口和交互，不增加页面、规则或第二套状态。
- tests：配置缺失、并行工具回放、思考内容回放、图像关联与路由、缓存 token 拆分、错误分类、无自动重试与凭据不反射。

导演缺省为 `deepseek-v4-pro`；请求历史含图片时改用支持图像的 `deepseek-flash`。响应记录实际模型，用量不混为 Pro。
工具消息先全部返回，再以 user 消息发送关联调用 id 的图片，遵守 DeepSeek 的图像消息限制。
历史消息保留原文；思考内容以供应商专有 opaque 块存储回放，兼容无思考内容的旧工具消息。

## 验证证据

命令及实际结果：

| 检查 | 命令 / 结果 |
|---|---|
| 单元与配置 | `pnpm exec vitest run --project unit packages/providers/deepseek/src/index.test.ts packages/contracts/src/env.test.ts`：2 文件，37 项通过 |
| 构建 | `pnpm --filter @ancs/contracts run build`、`pnpm --filter @ancs/providers-deepseek run build`、`pnpm --filter @ancs/worker run build`：通过 |
| 类型 | `pnpm --filter @ancs/providers-deepseek run typecheck`：通过 |
| Lint | 对新增 provider、env、Worker main、vitest 配置执行 ESLint：通过 |
| 架构 | `pnpm arch:check`：33 包，R1—R12 通过 |
| 密钥 | `node scripts/check-secrets.mjs`：通过；真实值仅在未跟踪 `.env`，文档/日志不记录 |
| 模型列表 | 真实 `GET /models`：200，返回 deepseek-flash / deepseek-v4-pro |
| 工具往返 | 真实 Pro 接受默认目录 17 个工具，调用 list_footage，回放结果和思考后正常中文回答 |
| 浏览器 | Playwright 驱动现有本地 Web + API + Worker，新建独立“DeepSeek 导演接入验证”项目，发出只读请求；调用 list_footage → 回复没有素材 → COMPLETED，无提案、无工程编辑 |
| 真实用量持久化 | 浏览器轮次两次模型调用均记录 deepseek-v4-pro：首次输入 9310 / 输出 74 / 缓存 0；第二次输入 57 / 输出 29 / 缓存 9344；unpriced_calls=2，cost_micros=null |
| 视觉探测 | Pro 对纯红测试图回答“未知”，不计视觉验证；Flash 直传测试图回答“红”；工具返回测试图经关联 user 消息回放后回答“主色是红色” |

浏览器截图：`docs/verification/artifacts/deepseek/director-connected.png`（已目检）。
一次性验证脚本以 `.tmp-deepseek-*` 命名并被 Git 忽略；未执行全量 pnpm verify。

## 成本与限制

本次执行了真实付费模型调用，token 用量已记录；没有核对账单金额，不把未知价格记为免费。
沿用未定价调用提示，后续需按可核对的供应商价格补计价。
未运行真实素材的完整初剪、视觉质量评测或最终视频导出，不作剪辑质量承诺。
独立测试项目没有上传用户素材，没有执行视频生成。

## 运维与回退

配置由 Worker 启动读取，改动后重启 Worker。API / Web 无需密钥。
回退时把 `ANCS_AGENT_DRIVER` / `ANCS_AGENT_MODEL` 改回原供应商并重启 Worker；移除 DeepSeek 密钥即可撤销本地配置。
无需回滚数据库；已记录轮次与用量保留。

协议依据：[Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)、[Vision](https://api-docs.deepseek.com/guides/vision/)。
