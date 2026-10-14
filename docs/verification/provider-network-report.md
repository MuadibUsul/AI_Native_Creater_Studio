# 真实供应商网络诊断（2026-10-14）

用 `node scripts/provider-network-check.mjs --markdown <文件>` 生成（不产生生成费用；密钥只从环境变量读，不打印）。
逐层检查：容器内 DNS → 经代理出网许可（CONNECT：200 放行 / 403 被白名单拦下）→ TLS + HTTP → 免费只读接口鉴权。

## 结果（Claude 云端环境，代理出网）

| 供应商 | 域名 | 密钥 | DNS（容器内） | 出网许可 | TLS + HTTP | 鉴权（免费接口） |
|---|---|---|---|---|---|---|
| Google Gemini（导演 / 视觉 / 讲述 / Veo） | `generativelanguage.googleapis.com` | 已配置 | ✅ | ✅ allowed | ✅ HTTP 404 | ✅ key accepted, 509 ms |
| 火山方舟（Seedance） | `ark.cn-beijing.volces.com` | 已配置 | ⚠️ ENOTFOUND | ❌ blocked by the environment network policy | skipped (no egress) | skipped (no egress) |
| Fish Audio（讲述 / 你的声音） | `api.fish.audio` | 已配置 | ⚠️ ENOTFOUND | ❌ blocked by the environment network policy | skipped (no egress) | skipped (no egress) |
| HeyGen（数字人） | `api.heygen.com` | 已配置 | ⚠️ ENOTFOUND | ❌ blocked by the environment network policy | skipped (no egress) | skipped (no egress) |
| HeyGen 上传 | `upload.heygen.com` | — | ⚠️ ENOTFOUND | ❌ blocked by the environment network policy | skipped (no egress) | skipped (no egress) |
| Deepgram（语音转写） | `api.deepgram.com` | 未配置 | ⚠️ ENOTFOUND | ❌ blocked by the environment network policy | skipped (no egress) | skipped (no egress) |
| Anthropic（Claude 导演） | `api.anthropic.com` | 未配置 | ✅ | ✅ NO_PROXY (direct) | ✅ HTTP 404 | ANTHROPIC_API_KEY not set |
| Runway（已提供密钥，代码尚未接入） | `api.dev.runwayml.com` | 已配置 | ⚠️ ENOTFOUND | ❌ blocked by the environment network policy | skipped (no egress) | skipped (no egress) |
| Gemini 文件下载跳转（候选） | `storage.googleapis.com` | — | ✅ | ✅ allowed | ✅ HTTP 400 | — |
| Gemini 文件下载跳转（候选） | `video-downloads.googleusercontent.com` | — | ⚠️ ENOTFOUND | ❌ blocked by the environment network policy | skipped (no egress) | — |
| 方舟成片对象存储（候选） | `ark-content-generation-v2-cn-beijing.tos-cn-beijing.volces.com` | — | ⚠️ ENOTFOUND | ❌ blocked by the environment network policy | skipped (no egress) | — |
| HeyGen 成片（候选） | `files2.heygen.ai` | — | ⚠️ ENOTFOUND | ❌ blocked by the environment network policy | skipped (no egress) | — |

被拦下的域名在容器内 DNS 也解析不到（`ENOTFOUND`），出网代理对 CONNECT 回 403：**是环境网络白名单拦截，不是密钥或代码问题**。只有 Google（Gemini）与 Anthropic 可达。

## 需要在 Claude 网页端放行的域名

环境菜单 → Edit → Network access → Allowed domains（保留 "Allow package managers"；步骤见 https://code.claude.com/docs/en/cloud-environments#network-access）。改完后新开会话生效。

| 用途 | API 域名（代码里写死的缺省值） | 成片下载域名（以第一次真实任务返回的链接为准） |
|---|---|---|
| Seedance（火山方舟） | `ark.cn-beijing.volces.com` | `*.tos-cn-beijing.volces.com`（或直接 `*.volces.com`） |
| Veo（Gemini，API 已可达） | — | `*.googleusercontent.com`（下载链接可能跳转到这里，当前被拦） |
| Fish Audio | `api.fish.audio` | — |
| HeyGen | `api.heygen.com`、`upload.heygen.com` | `*.heygen.ai`（候选） |
| Deepgram | `api.deepgram.com` | — |
| Runway（代码尚未接入） | `api.dev.runwayml.com` | 待定 |

**先放行下载域名，再做付费测试**：任务已完成但成片下载被拦，平台会记为"已扣费"（钱花了、片没拿到）。

## 真实测试状态

| 项 | 结果 |
|---|---|
| Gemini 鉴权、导演、视觉理解、TTS | ✅ 已真实验证（见 `docs/V06/milestones/gemini-provider.md`） |
| Veo 提交 | ❌ 真实 429：这把 Key 在免费层没有 Veo 配额（没有生成、没有扣费）；需开通 Google Cloud 结算 |
| Veo 轮询 / 下载接口 | ✅ 真实回应：不存在的任务 / 文件回 403 `PERMISSION_DENIED`，平台照常按"查不到状态 → 结果不明""下载失败 → 已扣费"处理 |
| 无效密钥 | ✅ 真实回应 400 "API key not valid"；**已修正**：原来归为请求错误，现在归为鉴权失败 |
| Seedance / Fish / HeyGen / Deepgram / Runway | ❌ 网络被拦，未能发出请求；协议只在本地替身上测过 |
| 成片下载 + FFmpeg 后处理（真实供应商成片） | 未验证：需要第一次真实生成；FFmpeg 后处理已在真实 FFmpeg + 替身成片上测过 |

## 已知问题（待修）

- **网络被拦时提交失败被记为"结果不明"**：经代理时 Node 报 `Proxy response (403) !== 200 when HTTP Tunneling`，请求根本没发出去，但共用的托管视频供应商（Veo / Seedance）把连接失败一律当"可能已开始"，生成会进入"待对账"、预留不释放。TODO（why：网络或 DNS 层失败时不可能扣费，不应占住预算；dependency：无；interface：HTTP 层识别"请求未发出"——代理隧道非 200、`ENOTFOUND`、`ECONNREFUSED`——在错误上标 `neverSent`，`hosted-video-shot.ts` 提交失败时据此归为 `NOT_CHARGED`；连接中途断开或超时仍归为结果不明）。在修好之前，**不要在网络不通的环境里打开 Veo / Seedance 报价**。

## 网络放行后的验证顺序

1. `node scripts/provider-network-check.mjs`：全部"出网 ✅、鉴权 ✅"。
2. 征得同意后各跑一次最低成本的真实生成：`node scripts/provider-smoke.mjs --seedance-generate doubao-seedance-2-5-260628`（5 秒）/ `--veo-generate`（4 秒，需结算）。输出会带上成片链接的真实主机名，按它补放行。
3. 看输出视频（画布、帧率、声音）与供应商账单，记入 `docs/V06/milestones/V6-8.md`。
