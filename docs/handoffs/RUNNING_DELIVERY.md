# 持续交付与接手总表（RUNNING DELIVERY）

> 用途：**每次完成一部分就在这里追加一条**；上下文窗口切换、换人接手、或定时任务接手时，先读本文件即可知道"做到哪、下一步做什么、怎么验证"。
> 详细证据仍在 `docs/verification/<taskId>.md`，交接细节在 `docs/handoffs/<taskId>.md`；本文件只做**总览与续跑指令**。

**最后更新：** 2026-10-10（N04-09 主体 + 持续交付文档建立）
**分支：** `codex/v04-foundation`（不推 main）
**当前 HEAD：** 见文末"提交序列"最后一行
**账本：** `docs/requirements/ai-native-v04-acceptance-ledger.md`（唯一进度口径）
**迁移：** 到 0079（`selection_anchors`）

---

## 一、当前状态速览

| 维度 | 值 |
|---|---|
| 已完成任务 | N00 7/7、N01 11/11、N02 15/15、**N03-01…09（9/16）**、**N04-09**、N15-01/02、N16-01/02 = **47/219（21.46%）** |
| 剩余 | 172 项 |
| 本地 `pnpm verify` | **14/14，1141/1141**（2026-10-10 实测；unit 436 / integration 471） |
| 未通过的总门 | G0—G4、O0、D0/D1 全部未过（任务项完成 ≠ 可交付） |
| 增量设计（关键需求） | 设计 + 差距映射已就绪；首批契约已落地；垂直切片尚未闭合 |

---

## 二、本轮连续交付（按时间倒序追加）

### 2026-10-10 · N04-09 SelectionAnchor 归一与旧 Attention 兼容
- **内容：** 规范 `SelectionAnchor`（几何 × 时间 × 轨道 × 属性 × 区域模式 × 发话时间 + 目标顺序引用与版本 + 解析状态/证据/重映射历史/指纹）持久化为**追加式修订日志**（迁移 0079，行主键 = workspace+project+anchorId+revision）；旧 inline 选择（分镜/片段/字幕/素材范围/像素区域）经适配器**解析一次**且不丢有理时基；越权与"帧哈希当身份"被拒；重映射把失效选择标成 FAILED／PARTIAL／AMBIGUOUS（附候选证据）／STALE 并记 `remapHistory`；保存锚点**不改工程**（不写 edit_events、不动 revision）。
- **证据：** `docs/verification/N04-09.md`（4 项集成用例）· `docs/handoffs/N04-09.md`
- **提交：** `d7aacea`　**verify：** 14/14（Unit 436 / Web 170 / Motion 19 / Integration 471 / Security 24 / Render 6 / Golden 15 ⇒ **1141/1141**）

### 2026-10-10 · 增量设计首批契约（N04-09-s1）
- **内容：** `packages/contracts/src/selection.ts`：`GeometrySelection`（点/线/矩形/多边形/笔刷 × 用途）、`SelectionAnchor` 增量、`IntentRevision` 状态机、`legacySelection` 适配器、指纹输入纯函数；8 项契约单测。
- **证据：** `docs/verification/N04-09-s1.md`

### 2026-10-10 · 新需求扫描与差距映射
- **内容：** 读 `docs/V04/ANCS_v04_Mouse_Voice_Incremental_Design_20261010.md` + 提示词，产出 `docs/design/mouse-voice-gap-map.md`（逐条要求 → 现有实现 → N04/N05/N06 目标任务 → 状态，含 13 个新增子任务与推进次序）。

### 2026-10-10 · CI 修复（解除 GitHub 合并阻塞）
- **内容：** 真实媒体用例（探测/索引/转码）从 unit 移到 integration（unit 定义 = 无外部依赖），CI verify 作业安装 FFmpeg。**不放宽断言、不静默跳过。**
- **提交：** `a76dc66`

### 2026-10-10 · N03-09 范围编辑指令的最小 AI 入口
- **内容：** `planRangeEdit`（选中片段 + 允许操作清单 + 源证据 → 五道校验后的可执行操作；越界逐条 `outOfScope` 说明；零写库、零 Provider 媒体调用）+ API `POST /ai-edit/range-plan` + SDK `client.narrative.rangeEditPlan` + 三个确定性 Mock 脚本模式。
- **证据：** `docs/verification/N03-09.md`（4 项）· **提交：** `7881bf9`

### 2026-10-09 · N03-01 … N03-08（时间线全链路）
- **内容：** 插入/覆盖/追加 → 拆分·裁剪·移动·复制·替换源 → 精剪（ripple/roll/slip/slide/J-L cut）→ 多轨·AV 链接·轨道控制 → 可编辑变换与关键帧 → 基础混音与原声保护 → 字幕与转写驱动剪辑 → 多轨媒体预览与真实合成（播放快照 + 服务端合成计划）。
- **提交：** `06c887b`、`17d431a`、`4a4607a`、`66faa91`、`e49a411`、`ad6ccdf`、`f4c27cc`、`6a2dd16`
- **证据：** `docs/verification/N03-01.md` … `N03-08.md`（含 9 个实测抓出的真实缺陷与修法）

---

## 三、下一步（按优先级，来自 gap map §4）

1. **N05-01-s1 流式语音会话骨架**（增量设计的关键路径）：浏览器侧持续采集 + 服务端会话 + 转写修订事件；`IntentRevision` 未 `SEALED` 前只允许只读准备/可撤销预备；把 `range-edit` 计划路径接到 `IntentRevision`，不新建第二套协议。缺真实 ASR/VAD 凭据时用确定性本地夹具**只验证协议与状态机**，保持 `UNVERIFIED_CREDENTIALS_REQUIRED` 并写清回放路径。
2. **N04-02-s1 / N04-04-s1 画布与横向时间带**：保留 `apps/web/src/ui/LiteTimeline.tsx`（场景制）并扩展为片段/轨道 + 播放头 + **独立时间选区**；画布原生对象命中（用 N03-05 的 `hitTestVisualObject`）；两者可并行、互不共享文件。
3. **N06-01-s1 / N06-02-s1 / N06-04-s1**：私有候选（把 v2 注册表里 `create_preview_branch` 等 PLANNED 落成实现）→ 确定性试改 → 原子采用（绑定 `baseProjectRevision + intentRevision + selectionFingerprint + operationsHash + assetVersionRefs + proposalRevision` 后服务端重验）。
4. **N04-05（AttentionSnapshot 本体）与 N04-10（锚点自动恢复）**；**N05-03-s1/N05-04-s1**（改口/打断/三类取消/晚到隔离）。
5. **增量设计未覆盖时回主线**：下一项 **N03-10 G0 纯素材交付门** → N03-11 PlaybackEngine → … → N16。

---

## 四、续跑指令（换窗口/换人必读）

```bash
# 环境
cd /e/Codes/ANCS                       # 分支 codex/v04-foundation
docker compose -f infra/docker-compose.dev.yml up -d   # ancs-dev-db / ancs-dev-redis
export ANCS_TEST_DATABASE_URL='postgres://ancs:ancs@localhost:55432/ancs_quiet_frame_test_261007'  # 库名必须含 test

# 单项目验证（跑得快，先做这个）
pnpm exec vitest run --project integration apps/api/src/<task>.integration.test.ts

# 完整验证（提交前必跑）
pnpm verify                            # 14 步；若遇环境抖动（FFmpeg 启动失败 / 未处理 Promise 拒绝）单独复跑该套件并如实记录，不改阈值
```

**每项任务的完成定义（逐项、不跳步）**：contracts → migration（`cd packages/db && pnpm run db:generate`）→ domain/service → API/SDK → UI（用户可见功能先写 `docs/design/features/<taskId>.md` 交付卡）→ tests → docs；写 `docs/verification/<taskId>.md`（实际改动文件 + 命令 + 退出码 + 真实浏览器/媒体证据 + 失败与剩余缺口）与 `docs/handoffs/<taskId>.md`；同步三个账本；**本项提交并推送后才开始下一项**；**完成一部分就回到本文件追加一条**。

**纪律（违反即返工）**：
- 不删断言、不放宽阈值、不静默跳过、不伪造日志与性能数字；**没跑过的测试不许写成通过**。
- 源素材与已确认版本不可变；越界/无法保真一律 fail-closed 并在文档写明依赖任务。
- 真实 Provider 未验证就标 `UNVERIFIED_CREDENTIALS_REQUIRED` 并写回放路径；不触发未授权费用。
- 选择/语音等新能力必须复用既有权威层（ProjectDocument、SelectionAnchor、Edit Operation v2、权限/锁/影响集/版本/预算），**不新建第二套状态**。

**已知坑（都踩过）**：
- 轨道重排必须**两阶段写入**（先偏移再落位），否则 `(sequence_id, position)` 唯一索引瞬时冲突 → 500。
- 补偿路径（undo/redo）必须豁免策略类守卫，否则撤不回去。
- 修改 `@ancs/sdk` 后，apps/api 的类型检查读 `src`、运行读 `dist`，**改完要 `pnpm --filter @ancs/sdk build`**。
- 改账本的 python 脚本里别混入直引号（会 SyntaxError 静默不落盘）；写完必须 `grep` 复核计数。
- 字幕文本以**词条**为权威；`trim_clip` 遇到本地区域超出新时长的音频区域会 409（区域级时钟重算属 N03-06）。
- CI 已装 FFmpeg；**unit 套件不放需要 ffmpeg/DB 的用例**（用 `*.integration.test.ts`）。
- 测试库安全门用**库名含 test** 判据（本地 `ancs_quiet_frame_test_261007`、CI `ancs_test` 都可），
  不要把守卫写成"必须等于某个固定库名"，否则 CI 会因库名不同整文件失败。
- 真实媒体夹具在 `packages/testing/fixtures/media-v04/`；worker 测试用 `createFfmpegSourceMediaProbe`；工程夹具经 domain 的 `createChannel` 建通道。
- **不要并发跑两个 verify/integration 实例**（共用同一个测试库）：会互相清理数据，表现为大量无关套件报
  `projects_workspace_id_workspaces_id_fk` 之类的假失败。被中断的 verify 若进程仍在，先确认没有残留再重跑；
  确认方法：单独重跑失败套件（本文档 2026-10-10 曾因此误判 28 个文件失败，单独重跑 5 个文件 42 项全绿）。

---

## 五、提交序列（最新在下）

```
06c887b  feat(n03-01) 插入／覆盖／追加
17d431a  feat(n03-02) 拆分／裁剪／移动／复制／替换源
4a4607a  feat(n03-03) 精剪 ripple/roll/slip/slide/J-L cut
66faa91  feat(n03-04) 多轨、AV 链接与轨道控制
e49a411  feat(n03-05) 可编辑变换与基础关键帧
ad6ccdf  feat(n03-06) 基础混音与原声保护
f4c27cc  feat(n03-07) 字幕与转写驱动剪辑
6a2dd16  feat(n03-08) 多轨媒体预览与真实合成
a76dc66  fix(ci) CI 安装 FFmpeg + 真实媒体用例归 integration
7881bf9  feat(n03-09) 范围编辑最小 AI 入口 + 差距映射
ec20a44  feat(n04-09-s1) 点线面 × 时间 × 意图统一契约
969fe13  test(n04-09-s1) 修正集合级校验用例类型
d7aacea  feat(n04-09) SelectionAnchor 归一/持久化/兼容/重映射 + CI 测试库守卫修正
         （同批新增 docs/handoffs/RUNNING_DELIVERY.md 本文件）
```
