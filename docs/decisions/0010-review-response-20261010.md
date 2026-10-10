# 0010 · 外部评审响应（2026-10-10）

**背景：** 收到一份基于仓库说明快照的外部评审（`ANCS-改进建议.md`），含 P0—P3 共约 50 条。本文逐条记录**核实结论**（评审自己标注"需核实"，且其快照未必等于本分支）、**已落地修复（带证据）**、**剩余项（带精确落点）**与**需用户决策项**。

**核实方式：** 三条独立只读调查（沙箱隔离 / 密钥与仓库卫生 / 媒体管线与 Web 加固）+ 本机复现。凡"属实"均可在下述 `文件:行` 复核。

---

## 一、逐条核实结论

| # | 评审断言 | 核实结论 | 证据 |
|---|---|---|---|
| P0-4 / §3.2 | `resolveProposalDisposition` 子串匹配把「特别好，就用这个」判成**丢弃** | **属实（本机复现）** | 旧实现用单字标记 `别`/`再`：`别`⊂`特别`、`再`⊂`就这样吧，再好不过了`。8 条复现用例 6 条失败 |
| P0-1 / §7① | 动效沙箱子进程继承**全部**环境变量 | **属实** | `apps/motion-worker/src/sandbox.ts:72` `env: { ...process.env }`；同模式还有 `apps/worker/src/motion-validator-process.ts:61` |
| P0-1 / §7① | 依赖 `node:vm` 作安全边界，静态词法门可被绕过 | **属实** | `apps/motion-worker/src/sandbox-child.ts:131`；`analysis.ts:55` 只覆盖 `['constructor']`，**漏 `.constructor` 点号形式**（宿主注入了 `React`，`React.createElement.constructor('return process')()` 不命中任何规则） |
| P0-1 / §7① | AI 代码可能同源在浏览器执行（存储型 XSS） | **不属实（当前）** | `apps/web/src` 无 `iframe`/`srcdoc`/`dangerouslySetInnerHTML`；`CUSTOM_MOTION` 不在标准类型里 → 渲染为"未注册"占位。**但** `next.config.mjs` 无任何 CSP 头，属**潜在**缺口（靠"功能未实现"而非防护） |
| P0-2 / §7② | 凭据密钥回退派生自 `BETTER_AUTH_SECRET`，一把密钥管会话/签名 URL/凭据 | **部分属实（骨架成立）** | 回退属实（`packages/providers/credential-vault-local/src/index.ts:97-104`）；`BETTER_AUTH_SECRET` 同时派生会话（`apps/api/src/index.ts:41`）、签名 URL（`:66`）、运维指纹（`:188`）。**无 AAD**、**无 HKDF**、**无生产强制**均属实 |
| P0-3 / §5 | `secrets:check` 只扫工作区，不扫历史；公开仓库历史泄露面 | **属实** | `scripts/check-secrets.mjs:42-46` 用 `git ls-files -co`（=下一次提交的内容）；CI 仅 `pnpm verify`（`.github/workflows/ci.yml`），无历史扫描 |
| P0-3 / §5 | 文档含本机绝对路径；Agent 模板未禁止 | **属实（14 个文件）** | `E:\Codes\ANCS\…` 见 `ANCS_Plan261004.md:11`、`docs/handoffs/{NEXT_SESSION_PROMPT,SESSION-HANDOFF-261006,RUNNING_DELIVERY}.md`、`docs/verification/N02-01…07.md` 等；`AGENTS.md` 原无此规则 |
| P0-3 / §5 | 根 LICENSE 是 UNLICENSED | **表述不准，实质成立** | **不存在 LICENSE 文件**；`package.json:4-6` 为 `private:true, license:"UNLICENSED"`，而仓库公开 |
| P1 / §5 | 提交了 `.tmp-*.py` 临时脚本 | **属实** | 三个脚本在 `main` 与本分支均被跟踪（`09eee72` 等提交引入）；`.gitignore` 只忽略 `*.tmp`/`tmp/`，漏 `.tmp-*` |
| P1 / §5 | 存在陈旧分支 `codex/quiet-frame-rebuild`、`docs/ai-native-studio-v03-*` | **部分属实** | `codex/quiet-frame-rebuild` 存在且未合并（领先 main 3 个提交）；`docs/ai-native-studio-v03-*` **不存在** |
| P1 / §8 | FFmpeg/ffprobe 未限制协议、无分辨率/时长上限 | **属实（时段与输出上限存在）** | 全仓无 `-protocol_whitelist`；探针/索引/转码共 10 处输入点。已有 5–30 分钟墙钟超时与 8/32 MiB **输出**上限 |
| P1 / §7 | `articleFetcher` 无 SSRF 防护 | **不属实（基本已有）** | `apps/api/src/plugins/article-fetcher.ts` 有 `assertSafeUrl` + **逐跳复检** + 5 MiB/15 s 上限；`content-extract.ts:20-105` 拦私网/元数据地址。**残留真实缺口**：无 DNS 解析后复检 → **DNS rebinding 未防**，且 `content-extract.ts:76` 注释谎称由抓取器负责 |
| P1 / §7 | 文档解析无限制 | **部分属实** | 输入 25 MiB 上限、EML 仅一层嵌套已有；**缺**：ZIP 解压比/总量/条目数上限（`document-extract/src/zip.ts:77` 先分配后校验）、PDF 页数上限、无进程隔离 |
| P1 / §7 | Web 面缺限流/CORS/CSRF/上传限制 | **混合** | 限流**缺**、无 CORS 策略、CSRF 靠 Better Auth `SameSite=Lax` 默认；上传**大小**已限（5 GiB/64 MiB/25 MiB）但**类型**无白名单；**签名 URL 已短时效+最小权限（该断言不属实）** |
| P1 / §7 | 恶意扫描只有启发式 | **属实** | `packages/providers/malware-heuristic/src/index.ts`，生产注入同一实现（`apps/api/src/index.ts:76`）；无 ClamAV/云扫描 |
| P1 / §9·§6 | 一本台账、双维度状态（Mock vs 真实）、规格摘要 ≤30 KB | **属实（流程类）** | 三本台账 + 逐任务计数靠手写，已出现漂移（同一会话内 436/471/480/494 四个口径） |
| P1 / §6 | 无 AI 质量评测（1233 个测试全是确定性逻辑） | **属实** | 无 accuracy/误采纳率类指标 |

> 时间口径说明：评审引用的 `53/219`、`1233 个测试` 是当时的快照；本分支现为 **53/219**、`pnpm verify` **1265**。其余断言与当前代码一致（已逐条核对）。

---

## 二、已落地修复（本分支，带证据）

| 修复 | 文件 | 证据 / 验证 |
|---|---|---|
| **意图识别重写**：短语级标记（**无单字标记**）、紧邻否定词护栏、惯用语例外（`不要紧`/`别客气`）、**明确采纳先于泛化微调**、**复合意图**（`dispositions[]`）一律要求确认、`confidence` + `evidence` | `packages/contracts/src/proposal-disposition.ts` | 8 条评审复现用例全绿（`proposal-disposition.test.ts`）；`pnpm test:unit` 507 项通过 |
| **意图评测集**（102 用例：采纳/微调/后面也这样/拒绝/沉默/否定/惯用语/复合/ASR 噪声/多候选/UI 动作）+ **准确率 100%、误采纳率 0%、误丢弃 0** 指标；独立 `pnpm test:eval` 套件（不进 verify 强门，只观察趋势） | `packages/contracts/src/proposal-disposition.eval.ts`、`vitest.config.ts`（新增 `eval` 项目）、`package.json`（`test:eval`） | `pnpm test:eval` → 5 项全绿 |
| **沙箱环境隔离**：`sandboxEnv()` 白名单（仅 `PATH`/`SystemRoot`/`TEMP` 等 Node 启动必需项 + `NODE_OPTIONS=''`），显式 `cwd=os.tmpdir()`；不再透传 `DATABASE_URL`/`BETTER_AUTH_SECRET`/`PLATFORM_PROVIDER_KEYS`/`OBJECT_STORAGE_*` | `apps/motion-worker/src/sandbox.ts` | `apps/motion-worker/src/sandbox-hardening.test.ts`（2 例断言哨兵变量不入子进程）；`pnpm test:motion` 25/25 |
| **词法门补漏**：新增 `.constructor` 点号形式、`Reflect.construct/getPrototypeOf/apply`、`setPrototypeOf`；精确化以免误伤合法 `class { constructor() {} }` | `apps/motion-worker/src/analysis.ts` | 同测试文件（4 例：点号/反射/原形式不回归/正常代码不误伤） |
| **凭据密钥生产强制**：生产环境缺 `ANCS_CREDENTIAL_KEYS` 即**启动失败**（不再悄悄派生）；非生产派生改为 **HKDF** 并打印告警；环境 schema 与跨字段校验同步声明；`.env.example` 补文档 | `packages/providers/credential-vault-local/src/index.ts`、`packages/contracts/src/env.ts`、`.env.example` | `vault.test.ts` 新增"生产必须显式配置"用例（4 断言）；`pnpm test:unit` 通过 |
| **FFmpeg 协议收敛**：10 处输入点统一加 `-protocol_whitelist file,pipe`（禁止 demuxer 自动跟随 playlist/`file://`/`http(s)://` 子引用） | `apps/worker/src/source-media-{probe,transcoder,indexer}-process.ts` | 真实 ffmpeg 集成套件 3 文件 **7/7 通过**（探测/索引/转码功能未受影响） |
| **仓库卫生**：删除 3 个已提交的 `.tmp-*.py`；`.gitignore` 补 `.tmp-*`；**14 个文件**的本机绝对路径改为机器无关表述（复核：已跟踪文件零命中） | `.tmp-*.py`、`.gitignore`、14 个文档 | `git ls-files` + `grep` 复核无残留 |
| **代理规则**：`AGENTS.md` 禁止事项新增三条（禁本机路径与 `.tmp-*` 入库 / 凭据密钥不得与会话密钥共用 / 沙箱 spawn 必须白名单 env） | `AGENTS.md` | — |

---

## 三、剩余项（已定位，未做）

### 需要本机/工具才能扫（我无法替代）
- **全历史密钥扫描**：评审要求对公开仓库全历史跑 gitleaks/trufflehog。本机未装该工具，且**一旦命中需要你做轮换/改写的决策**。建议 CI 增独立 job：`gitleaks detect --log-opts=--all`（或 `trufflehog git file://. --only-verified`）。

### 代码已定位、可直接排期（按价值排序）
1. **`articleFetcher` DNS rebinding**（P1，真实缺口）：`apps/api/src/plugins/article-fetcher.ts` 在 `assertSafeUrl` 后与每跳后 `dns.promises.lookup(host,{all:true})`，对全部解析 IP 跑 `isBlockedAddress`，并用自定义 `lookup` 固定已解析 IP（防 TOCTOU）；同时改正 `packages/domain/src/content-extract.ts:76` 那句不实的注释。
2. **文档解析资源上限**（P1）：`packages/providers/document-extract/src/zip.ts:52-84` 增加条目数/解压总量/解压比上限（先限流再 inflate）；`pdf.ts:65` 加页数上限；解析移入受时限的子进程。
3. **Web 面**（P1）：`apps/api/src/server.ts` 注册限流与显式 CORS 白名单；`apps/api/src/routes/storage.ts:44` 与 `content.ts:120` 增 MIME/扩展名白名单；确认 Better Auth `trustedOrigins`/SameSite 策略（需人确认前端域）。
4. **媒体管线的 OS 级隔离**（P1 部署项）：容器无出网 + 只读文件系统 + cgroup 内存/CPU 上限；`-max_pixels`/时长上限；`infra/` 目前只有 dev compose，**无 Dockerfile**。
5. **CSP 头与跨源预览约束**（潜在 XSS）：`apps/web/next.config.mjs` 增 `headers()`；若将来要在浏览器预览 AI 代码，必须跨源 sandboxed iframe + 严格 CSP，禁止与主站同源。
6. **编辑内核抽象 / 文件拆分**（P2，重构）：`domain` 直连 Drizzle、`edits.ts` 3.2k 行；建议拆 `kernel`（纯函数 `apply/validate/invert`）+ `application`（用例 + repository 端口），收益是可做属性测试与客户端乐观预览。
7. **台账双维度状态**：把 `VERIFIED` 拆成 `VERIFIED_MOCK` / `VERIFIED_REAL`（当前**全部 53 项都是 MOCK 证据**，无一项真实 Provider 验证），G 门只认 REAL。

### 我的判断：现在**不应**做（与评审部分建议不同）
- **冻结 P 系列 / 转向"口播转写剪辑"单一楔子**、**暂停商业化与运营面**：这是**产品战略决策**，属于你，不属于工程实现；评审自己也把它列为"需人工决策"。工程侧我能做的是把 G0 的真实薄切片路径打通（但受 N03-16 与真实凭据阻塞，见下）。
- **G0 用 FFmpeg 智能渲染（未改动片段流拷贝）**：方向正确，但**当前 G0 被 N03-16（基线播放同步，未交付）与真实凭据阻塞**，且"未改动片段流拷贝"在存在变换/关键帧/AV 同步时并不平凡——属 N09 共享 RenderPlan 的范畴，不宜提前声称完成。

---

## 四、需你决策（工程无法单方决定）

| 事项 | 需要什么 |
|---|---|
| **全历史密钥扫描的后果处理** | 若 gitleaks/trufflehog 命中：是否轮换凭据、是否改写公开历史（不可逆 + force push）。 |
| **LICENSE** | 公开仓库要么加明确许可证（如 Apache-2.0/MIT），要么有意保持 all-rights-reserved；请确认意图后我改 `package.json` 并加 `LICENSE`。 |
| **陈旧分支 `codex/quiet-frame-rebuild`** | 其 3 个提交是否已被 v0.4 Quiet Frame 工作取代？确认后我删本地与 `origin` 上的分支（远端删除不可逆）。 |
| **供应商选型与预算** | ASR/VAD/LLM/视觉：每类 1 主 1 备 + 月度上限，才能把 `VERIFIED_MOCK` 推进到 `VERIFIED_REAL`、并产出真实延迟/成本报告。 |
| **Web 域与 CSRF/CORS 策略** | 前端正式域名（决定 CORS 白名单与 Better Auth `trustedOrigins`）、是否上反向代理（决定限流放应用层还是网关）。 |
| **部署形态** | 是否现在投 OS 级沙箱与媒体隔离（容器/gVisor）——需要第一个 Dockerfile + 接近生产的 compose。 |

---

## 五、评审质量评价（供参考）

- **强项**：P0 抓得准（沙箱 env、密钥耦合、意图误判确为真问题，且给了我**可复现的输入**）；"误采纳代价高于误丢弃"的对齐判断很专业；对本仓库真正的病理（文档重、计数漂移、后端先于产品长出来）判断准确；多数条目给了"需核实"的诚实标注。
- **弱项**：部分断言基于说明快照而**未读源码**，核实后有两处明显偏差（`articleFetcher` 的 SSRF 其实已实现；签名 URL 已短时效最小权限），一处前提错误（LICENSE 文件并不存在）；覆盖面过宽（约 50 条），其中相当比例是**产品/商业决策**而非工程修复；个别建议技术上过于简化（"未改动片段流拷贝"、每 worker 克隆测试库）。
- **结论**：作为**投研级 triage** 质量很高，适合当"假设清单"逐条验证后执行——**不应**整包照做（其中转楔子、冻结 P 系列、上全家桶运维属需要你拍板且可能过早的动作）。
