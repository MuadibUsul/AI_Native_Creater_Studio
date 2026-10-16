# 0015 Edge 安全层：限流、CORS/Origin 白名单、安全头与全历史密钥扫描

- 状态：生效（2026-10-11，V5-M4 第一部分）
- 前一裁决编号：`0014-config-provider-gateway-and-capability-ledger.md`
- 来源：`docs/V05/ANCS_v0.5_Architecture.md` §15（边缘层、供应链）；代码审查 `docs/reviews/v04-code-review-20261011.md` §5（0010 遗留：限流/CORS、Web CSP、全历史密钥扫描）

## 决定

1. **API Edge 中间件**（`apps/api/src/plugins/edge.ts`，无新增依赖）：
   - **限流**：令牌桶，键为"端点类别 × 客户端 IP"。类别：`auth`（认证写，20/分）、`expensive`（叙事/AI 编辑/导演/生成/配音/多语言/声音克隆/素材/渲染等付费或重计算写，60/分）、`write`（600/分）、`read`（3000/分）；健康检查、预检与 Provider 回调豁免。超限 429 `RATE_LIMITED` + `Retry-After`。每进程内存（多实例部署为每实例上限），桶数量有上限并淘汰最久未用。
   - **客户端 IP**：只信任 `ANCS_TRUST_PROXY_HOPS` 跳代理（缺省 0 = 不信任 `X-Forwarded-For`），否则伪造头即可绕过按 IP 限流。
   - **CORS 白名单**：只对白名单 Origin 回显 `Access-Control-Allow-Origin`（带凭据）并应答预检（请求头按安全列表过滤）；其他来源不给 CORS 头、预检 403。
   - **Origin 校验（CSRF 纵深防御）**：带 Cookie 的写请求若携带不在白名单、也非本服务自身的 `Origin` → 403 `ORIGIN_NOT_ALLOWED`；无 `Origin` 的服务端/原生/回调请求不受影响（Cookie 本身另有 SameSite 保护）。
   - **安全头**：所有 API 响应 `nosniff`、`no-referrer`、`X-Frame-Options: DENY`、`CSP: default-src 'none'; frame-ancestors 'none'`；生产 HSTS。未配置 Edge 的 `buildServer`（测试）也有安全头。
   - 配置：`ANCS_ALLOWED_ORIGINS`（缺省 = `BETTER_AUTH_URL` 的 origin，非生产另加本地 Web 端口）、`ANCS_TRUST_PROXY_HOPS`、`ANCS_RATE_LIMIT`（生产不得为 `off`）。origin 解析用平台中立的 `originOf`（contracts 不依赖全局 `URL`）。
2. **Web 安全头**（`apps/web/src/lib/security-headers.mjs`，经 `next.config.mjs` 的 `headers()`）：CSP（`default-src 'self'`、`frame-ancestors 'none'`、`object-src 'none'`、`base-uri`/`form-action` 限本源，生产无 `unsafe-eval`）、`X-Frame-Options`、`nosniff`、`Permissions-Policy`（麦克风仅本源）、生产 HSTS。签名 URL 直达的存储/API 来源由 `ANCS_CSP_EXTRA_ORIGINS` 在**构建期**放行（Next 在构建时固化 headers）。
3. **Zod 在浏览器中关闭 JIT**：Zod 4 构造对象 schema 时以 `new Function('')` 探测 eval，被 CSP 记为违规。`apps/web/src/instrumentation-client.ts`（先于任何应用代码）直接 `config({ jitless: true })`；不得从 `@ancs/contracts` 导入后再配置——导入即构造全部 schema，探测已发生（浏览器验证实测）。
4. **全历史密钥扫描**：`pnpm secrets:history`（`check-secrets.mjs --history`）扫描全部提交新增行，与工作树扫描同一规则与豁免标记；CI 新增独立 `secrets-history` 作业（`fetch-depth: 0`，不装依赖）。历史中的已审查误报登记在 `scripts/secrets-history-allowlist.json`（提交 + 文件 + 原因，缺原因即失败；只作用于历史扫描）。首次全量扫描 246 个提交：3 处命中均为误报（环境变量名、测试夹具），已登记。

## 未纳入（明确的后续工作）

- Web CSP 的脚本仍需 `'unsafe-inline'`（外观引导脚本与 Next 内联数据脚本）；改为 nonce 需中间件逐请求生成并让页面动态渲染，属后续工作。
- 限流为每进程内存；多实例共享上限需 Redis 等共享存储。按用户/工作区的配额由套餐额度在服务层执行，不在 Edge。
- 上传类型：资产类型 MIME 白名单与内容嗅探已存在（`ASSET_MIME_ALLOWLIST`、`mimeMatches`），本次未改。
- `v5-m4-web-security.mjs` 浏览器验证为手动执行的验证脚本（与既有 N15/N16 浏览器脚本一致），收编进 `test:e2e` 属 M4 后续部分。
