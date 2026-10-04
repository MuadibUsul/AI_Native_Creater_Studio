# 独立客户端示例（P01-05）

不启动 Web，仅用 `@ancs/sdk` 完成"授权后的项目读写"（本阶段资源：租户 / 栏目 / 身份 / 风格）。

## 运行

```bash
# 1) 构建 SDK
pnpm build

# 2) 启动本地依赖与 API（另开终端）
docker compose -f infra/docker-compose.dev.yml up -d
DATABASE_URL=postgres://ancs:ancs@localhost:55432/ancs_dev \
BETTER_AUTH_SECRET=<你的开发密钥，≥16 字符> \
  pnpm --filter @ancs/api run start

# 3) 创建内部账号（首期账号由内部管理创建）
DATABASE_URL=postgres://ancs:ancs@localhost:55432/ancs_dev \
BETTER_AUTH_SECRET=<同一密钥> \
  pnpm --filter @ancs/auth run create-user -- --email demo@example.com --password 'strong-pass-1' --name 示范

# 4) 运行示例
ANCS_API_URL=http://127.0.0.1:3001 ANCS_EMAIL=demo@example.com ANCS_PASSWORD='strong-pass-1' \
  node examples/standalone-client/run.mjs
```

示例会依次演示 Cookie 会话全流程与原生 PKCE → Bearer 流程，并验证"修改 Channel 后旧快照不变"。

> CI 中的等价验收由 `apps/api/src/sdk-workflow.integration.test.ts` 承担（真实数据库 + 真实 HTTP）。
