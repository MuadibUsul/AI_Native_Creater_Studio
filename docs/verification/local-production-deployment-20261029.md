# 本地生产构建部署（2026-10-29）

范围：在本地 Windows 机器上用 ANCS 仓库自身的构建产物启动完整服务（API / Worker / Web / Realtime），不走 Veynod 部署门，也不涉及 darely.xyz。**配置为开发环境（`NODE_ENV` 未设为 production、`ANCS_OPS_ENVIRONMENT=DEVELOPMENT`），不是对外生产实例。**

## 基线

- 仓库：`codex/v04-foundation`，HEAD `d43947e`（与 origin 同步）。
- 数据库：容器 `ancs-local-db`（PostgreSQL 16），`127.0.0.1:54500`；Redis `ancs-dev-redis`（`127.0.0.1:56379`）。
- 构建：`pnpm build`（部署演练期间生成）；Web 额外以 `ANCS_CSP_EXTRA_ORIGINS=http://localhost:3001`、`NEXT_PUBLIC_ANCS_REALTIME_URL=ws://localhost:3002/realtime/v1/voice` 重新构建（签名 URL 直传/播放需要，且该值在构建期固化）。
- 迁移：对 `ancs_dev` 执行 `runMigrations`（幂等，148 张表）。

## 启动的进程

| 服务 | 命令 | 地址 |
|---|---|---|
| API | `node --env-file=.env apps/api/dist/index.js` | `http://localhost:3001` |
| Worker | `node --env-file=.env apps/worker/dist/main.js` | 无监听（轮询 DB 队列） |
| Web | `ANCS_CSP_EXTRA_ORIGINS=http://localhost:3001 pnpm --filter @ancs/web start` | `http://localhost:3000` |
| Realtime Gateway | `node --env-file=.env apps/realtime/dist/main.js` | `http://localhost:3002`（`/realtime/v1/voice`） |

## 验证结果

| 检查 | 结果 |
|---|---|
| `GET http://localhost:3001/api/v1/health` | 200 `{"status":"ok","service":"ancs-api"}` |
| `GET http://localhost:3000/` | 200 |
| Web CSP | `connect-src 'self' http://localhost:3001`（直传/媒体可用） |
| `GET http://localhost:3002/health` | `{"ok":true,"asr":"deepgram","tts":"NOT_CONFIGURED"}` |
| Worker 启动清单 | `asr=deepgram:REAL、agent_model=deepseek:REAL、visual_analysis=elorian:REAL` |
| 端口 | 3000 / 3001 / 3002 均在监听 |

## 已知边界

- **开发配置**：`NODE_ENV` 未设 production、运营面为 `DEVELOPMENT`；未配置 `ANCS_CREDENTIAL_KEYS`（从 `BETTER_AUTH_SECRET` 派生，仅限非生产）。
- **AI 语音回应未配置**（`ANCS_REALTIME_TTS_DRIVER` 空）：实时语音使用浏览器朗读；识别为 Deepgram。
- **Elorian 画面理解**已装配，但账户余额 $0，实际分析会返回不可重试的 429（见 REQ-03）。
- **本地存储**（`.storage/`，已 gitignore）；本机 ffmpeg 缺 `flite`，讲述相关能力在此环境不可用。
- **未部署到 darely.xyz**：需要生产机 SSH 凭据；本机（Windows 与 WSL）现有密钥均被拒绝，另行处理。

## 停止

停止对应的后台进程即可（API/Worker/Web/Realtime）；数据库与 Redis 容器保持运行：

```bash
docker stop ancs-local-db ancs-dev-redis
```
