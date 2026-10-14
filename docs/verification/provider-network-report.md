# 真实供应商网络诊断

用 `node scripts/provider-network-check.mjs --markdown <文件>` 生成（不产生生成费用；密钥只从环境变量读，不打印）。
逐层检查：容器内 DNS → 经代理出网许可（CONNECT：200 放行 / 403 被白名单拦下）→ TLS + HTTP（对域名根路径发不带密钥的 GET）→ 免费只读接口鉴权。

## 第二次检查（2026-10-14，白名单更新后）

| 供应商 | 域名 | 密钥 | DNS（容器内） | 出网许可 | TLS + HTTP | 鉴权（免费接口） |
|---|---|---|---|---|---|---|
| Google Gemini（导演 / 视觉 / 讲述 / Veo） | `generativelanguage.googleapis.com` | 已配置 | ✅ | ✅ allowed | ✅ HTTP 404 | ✅ key accepted, 421 ms |
| 火山方舟（Seedance） | `ark.cn-beijing.volces.com` | 已配置 | ⚠️ ENOTFOUND | ✅ allowed | ✅ HTTP 401 | ✅ key accepted, 1445 ms |
| Fish Audio（讲述 / 你的声音） | `api.fish.audio` | 已配置 | ⚠️ ENOTFOUND | ✅ allowed | ✅ HTTP 404 | ✅ key accepted, 744 ms |
| HeyGen（数字人） | `api.heygen.com` | 已配置 | ⚠️ ENOTFOUND | ✅ allowed | ✅ HTTP 404 | ✅ key accepted, 1181 ms |
| HeyGen 上传 | `upload.heygen.com` | — | ⚠️ ENOTFOUND | ✅ allowed | ✅ HTTP 404 | — |
| Deepgram（语音转写） | `api.deepgram.com` | 未配置 | ⚠️ ENOTFOUND | ✅ allowed | ✅ HTTP 404 | DEEPGRAM_API_KEY not set |
| Anthropic（Claude 导演） | `api.anthropic.com` | 未配置 | ✅ | ✅ NO_PROXY (direct) | ✅ HTTP 404 | ANTHROPIC_API_KEY not set |
| Runway（选区重绘 gen4_aleph） | `api.dev.runwayml.com` | 已配置 | ⚠️ ENOTFOUND | ✅ allowed | ✅ HTTP 401 | ✅ key accepted, 437 ms |
| Gemini 文件下载跳转（候选） | `storage.googleapis.com` | — | ✅ | ✅ allowed | ✅ HTTP 400 | — |
| Gemini 文件下载跳转（候选） | `video-downloads.googleusercontent.com` | — | ⚠️ ENOTFOUND | ✅ allowed | ✅ HTTP 400 | — |
| 方舟成片对象存储（候选） | `ark-content-generation-v2-cn-beijing.tos-cn-beijing.volces.com` | — | ⚠️ ENOTFOUND | ✅ allowed | ✅ HTTP 403 | — |
| HeyGen 成片（候选） | `files2.heygen.ai` | — | ⚠️ ENOTFOUND | ✅ allowed | ✅ HTTP 403 | — |

- **DNS 一列的 `ENOTFOUND` 是预期的**：这个环境经代理出网（`CLAUDE_CODE_PROXY_RESOLVES_HOSTS`），域名由代理解析；CONNECT 成功即说明代理侧解析通过。
- TLS + HTTP 一列的 401 / 403 / 404 是对"不带密钥访问根路径"的正常回应，说明 TLS 握手与 HTTP 都通。

### 账户状态（免费只读接口）

| 服务 | 结果 |
|---|---|
| Gemini / Veo | 能看到 `veo-3.1-generate-preview` / `-fast-` / `-lite-`；这把 Key 在免费层**没有 Veo 配额**（此前提交真实 429，未扣费） |
| 火山方舟 | 鉴权通过（任务列表 0 条）；余额无法用 API Key 查询，以方舟控制台为准 |
| Fish Audio | 鉴权通过；**API 余额 0** |
| HeyGen | 鉴权通过；**API 额度 0**（另有少量网页端免费额度，不能用于 API 生成） |
| Runway | 鉴权通过（经平台适配器 463 ms）；可用模型含 `gen4_aleph`（平台选区重绘所用）、`gen4_turbo`、`veo3.1`、`seedance2_5` 等 69 个；**credits 余额 0** |
| Deepgram | 网络通；**没有提供 `DEEPGRAM_API_KEY`**，鉴权未测 |

## 第一次检查（白名单更新前）

只有 Google 与 Anthropic 可达；火山方舟、Fish Audio、HeyGen（API 与上传）、Deepgram、Runway 以及成片下载候选域名都被出网代理拒绝（CONNECT 403）。

## 真实错误处理（免费、不生成）

| 项 | 结果 |
|---|---|
| Gemini 无效密钥 | 真实回应 400 "API key not valid"；**已修正**为鉴权失败（原来归为请求错误） |
| Veo 轮询 / 下载不存在的任务 / 文件 | 真实回应 403 `PERMISSION_DENIED`；平台按"查不到状态 → 结果不明""下载失败 → 已扣费"处理 |
| 网络被拦时提交生成 | 真实回应：出网代理拒绝建立隧道（`Proxy response (403) !== 200 when HTTP Tunneling`）。**已修正**：原来被记为"结果不明"（预留不释放、进入待对账），现在识别为"请求没发出去"→ 不扣费；在真实被拦的网络上复测：`Seedance request failed: Ark connection failed (ark.cn-beijing.volces.com; the request was never sent)`，结局 `NOT_CHARGED` |

## 有余额 / 有配额的先测（2026-10-14，项目所有者同意）

| 服务 | 结果 |
|---|---|
| 火山方舟 Seedance（第二次，项目所有者说可以再试） | 8 个目录模型逐个提交：2.5 / 2.0 / 2.0-mini / 2.0-fast / 1.0-pro-fast 仍是 `ModelNotOpen`，1.0-lite-t2v / 1.0-pro / 1.5-pro 是 `InvalidEndpointOrModel.NotFound`（已下线或无权限）；都在提交时被拒，未扣费。开通后如需用"推理接入点"，把接入点 id（`ep-…`）当作模型 id 传入即可 |
| 火山方舟 Seedance | 按"最便宜优先、首个开通即停"试了 5 个模型（`doubao-seedance-2-5-260628`、`-2-0-mini-260615`、`-2-0-fast-260128`、`-1-0-pro-fast-251015`、`-2-0-260128`，5 秒 / 480p / 无声）：**全部 `ModelNotOpen`（账户没有开通该模型服务）**，提交即被拒，没有生成、没有扣费，平台归为"不扣费"（真实回应，非替身）。`GET /api/v3/models` 可列出 135 个模型目录，但目录不代表已开通 |
| Gemini（免费层） | 模型列表 442 ms、导演工具调用 514 ms 通过；`gemini-3.8-flash-lite-tts` 当天 10 次免费配额已用完（如实失败、未重试），**换 `gemini-3.8-flash-tts`（各模型配额独立）通过**：一句中英测试 4.16 秒音频 / 2.3 s；再走平台讲述管线（逐句合成 → FFmpeg 拼接 → 语速 1.1 → 句界）：两句（中 + 英）9.04 s，句界 0–4666 ms、4916–9042 ms（句间 250 ms），24 kHz 单声道 WAV，探测 READY；**用 Gemini 转写回来与讲述稿逐字一致** |
| Fish Audio TTS | 真实 402 "Insufficient API credit"（开发者 API 余额独立于平台余额，为 0），未扣费 |
| Runway / HeyGen / Fish Audio | 余额 0，未测生成 |
| Veo | 免费层无配额，未测生成 |

## 还没验证的（需要付费生成，等你同意 + 账户有余额）

| 服务 | 最低成本的真实测试 | 前提 |
|---|---|---|
| Seedance | `ANCS_SEEDANCE_RESOLUTION=480p ANCS_SEEDANCE_GENERATE_AUDIO=0 node scripts/provider-smoke.mjs --seedance-generate <已开通的模型 id>`（5 秒） | 在方舟控制台"开通管理"里开通任一 Seedance 模型（最便宜的是 `doubao-seedance-2-0-mini-260615`），账户有余额 |
| Veo | `node scripts/provider-smoke.mjs --veo-generate`（4 秒） | Google Cloud 开通结算 |
| Runway | `node scripts/provider-smoke.mjs --runway-generate`（改写 2 秒测试原片） | 充值 credits |
| HeyGen | `node scripts/provider-smoke.mjs --heygen-generate 照片 声音`（约 2 秒） | HeyGen API 额度 + Fish 余额 |
| Fish Audio | `node scripts/provider-smoke.mjs`（合成一句话，按字节计费） | Fish **开发者 API** 余额（https://fish.audio/app/developers，与平台余额分开） |
| Deepgram | 上传一条有人声的素材 | 提供 `DEEPGRAM_API_KEY` |

每次真实生成都会验证：任务提交 → 状态轮询 → 成片下载（输出里打印成片链接的真实主机名）→ FFmpeg 统一到项目画布与帧率；失败按"不扣费 / 已扣费 / 结果不明"如实归类，不自动重试。

## 建议的配置调整

- 免费层 Gemini 讲述：`ANCS_GEMINI_TTS_MODEL=gemini-3.8-flash-tts`（缺省的 `-lite-tts` 免费配额每天 10 次，很快用完；两者配额独立）。正式使用请开通付费层。
