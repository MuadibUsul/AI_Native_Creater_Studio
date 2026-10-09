# ANCS v0.4｜增量开发任务清单

需求权威：`ANCS_AI_Native_v0.4.md`。本文件与总规范§23同源生成，机器索引为`task_index.json`。原有任务与有效实施证据不得重置。

<a id="s23"></a>
# 二十三、细化任务总账

本章与独立 `ANCS_v0.4_Task_Backlog.md` 由 `task_index.json` 的同一任务数据生成。当前文档不宣称任何新功能已实现；任务初始状态均为`TODO`。实施仓库已有的有效证据不得清零，新增验收状态独立记录。

每项执行§22共同完成定义，优先复用现存契约、领域、API、SDK、UI及测试。原126个任务ID、正文、验收及依赖均保留；补充要求显式标注，新依赖加入而不隐式删旧依赖。

## 发布与集成硬门

- 新在线写能力启用前：N13-01/02相关授权和攻击面验证通过。
- 任何真实付费调用前：N13-03/04与N13-10适用账本、预算、幂等、报价和取消／恢复验证通过，且实际账号与预算已授权。
- G0：N03-10（包含N03-16基础播放同步）＋N13相关基础门；**内部真实使用同时要求O0/N15-37**。无生成可不跑真实视频生成smoke，但计量、权限、原件保护不能免除。
- G1：N09-08、N06-09、N07-08、N04-10、N06-11、N07-11/12/13及适用安全门；真实语音N05-08不能被mock取代。
- G2：G1＋N08-08、N10-10/13、N09-11及实际使用生成能力的授权／报价门。混合渲染只有通过新一致性验收才标生产支持。
- G3：G2＋N12-08、N03-14/15、N13-11、N11-13及全部适用专业差项；外部round-trip不计原生完成。
- G4：N13-09及实际目标的N14任务；**对外收费需O1/N15-38**。不要求所有App先完成才能发布Web，但未完成客户端不得标支持。
- O2/N15-40才代表本版详尽运营后台整体完成。策略、身份、模型版本、发布与客户API等模块的治理在对应功能开放前提前验收，不因O2排期豁免。
- D0为N16早期设计地基，D1为完整Web视觉门；新UI同步采用共享规范，设计总门不替代产品或运营测试。N16-12汇总全站完成，不作为所有基础任务前置。
- N13安全、N15运营、N16设计是横切工作流；N14-01/02是旧能力迁移回归，随内核变化及时执行，不等待桌面／商城。

**本版：17个工作流、219项任务、131条需求。** 保留126项，新增93项（上传方案41项＋运营后台40项＋黑白设计12项），显式补充22项旧任务。工作流编号不表示全部串行，也不是日历工期。

| 工作流 | 任务数 | 验收门 | 范围 |
|---|---:|---|---|
| N00 | 7 | G0 | 基线审阅、需求切换与真实验收地基 |
| N01 | 11 | G0 | 统一作品内核与精确时基 |
| N02 | 15 | G0 | 素材入库、代理与媒体理解 |
| N03 | 16 | G0 | 可交付的非破坏性剪辑垂直闭环 |
| N04 | 11 | G1 | 极简共看片室与共同注意力 |
| N05 | 8 | G1 | 实时语音、打断与会话恢复 |
| N06 | 11 | G1 | 持久化提案、确认和创作收敛 |
| N07 | 13 | G1 | AI导演、约束编译与决策记忆 |
| N08 | 10 | G2 | 真实生成、身份、动效与三模式制作 |
| N09 | 11 | G1/G2 | 全片审阅、冻结合成与交付QA |
| N10 | 13 | G2 | 视频类型与导演策略生成器 |
| N11 | 13 | G3 | 专业制作能力第一批 |
| N12 | 8 | G3 | 专业扩展、交换与竞品能力闭合 |
| N13 | 12 | 贯穿G0–G4 | 安全、费用、可靠性与商业生产门 |
| N14 | 8 | G4 | 既有扩展回归与桌面／手机持续演进 |
| N15 | 40 | O0／O1／O2；贯穿G0–G4，不在N14后等待 | 详尽运营后台（横切推进：内部运营、收费治理与完整运营） |
| N16 | 12 | D0／D1；与核心和后台同步，不在所有App后等待 | 苹果式极简黑白设计系统（横切推进：Studio／Workspace／Ops） |

<a id="phase-n00"></a>
## N00｜基线审阅、需求切换与真实验收地基

**验收门：** G0　**优先级：** P0。

**共用失败／回滚规则：** 保留原提交和旧文档；测试不可运行要记录阻塞，不修改生产数据，不把本次方案冒充已实现。

<a id="task-n00-01"></a>
### N00-01 锁定工作区与逐层复核现有实现

**状态：** `TODO`　**依赖：** 无；首先执行。  
**需求：** V03-02, V03-56, V03-59。  
**版本：** v0.3保留。  
**代码落点：** `AGENTS.md`、`README.md`、`ANCS_Plan261004.md`、`docs/requirements/`、`docs/verification/`、根验证脚本。

**实现内容：** 读取 git status、HEAD、分支、全部生效 AGENTS 和最新 handoff；核查本文审阅提交是否落后。按契约→领域→API→SDK→UI→测试记录复用、扩展、替换、待核验项；识别未提交更改并保留。

**验收／负面路径：** 输出基线报告含实际 SHA、包与迁移编号、可复用路径；旧 README 阶段不被误当真实进度；无重建仓库或覆盖未提交代码。

<a id="task-n00-02"></a>
### N00-02 切换需求权威与旧裁决

**状态：** `TODO`　**依赖：** N00-01。  
**需求：** V03-01, V03-02, V03-03, V03-60, V04-01, V04-26。  
**版本：** v0.3保留；v0.4显式补充，旧证据不清零。  
**代码落点：** `AGENTS.md`、`README.md`、`ANCS_Plan261004.md`、`docs/requirements/`、`docs/verification/`、根验证脚本。

**实现内容：** 落地本文、任务与追踪账本；在 AGENTS/README/旧计划入口显著指向 v0.3；记录 Article-only、高级功能排除、时间模型、界面、Audio-First、最后生成等替换裁决。保留旧文档为历史。

**验收／负面路径：** 搜索生效入口无未消解的“只做文章长视频”或“不做专业功能”指令；旧安全、隐私、版本原则仍在；仅文档变化不计为功能完成。

**v0.4增量要求：** 当前生效入口更新为v0.4；v0.3作为历史基线保留，旧N任务ID不重排，执行N00-07处理来源方案编号。

**v0.4追加验收：** 同一请求不被两个版本同时指挥；旧完成证据仍归属原版本。

<a id="task-n00-03"></a>
### N00-03 复跑基线验证并建立缺口账本

**状态：** `TODO`　**依赖：** N00-01。  
**需求：** V03-59, V03-58。  
**版本：** v0.3保留。  
**代码落点：** `AGENTS.md`、`README.md`、`ANCS_Plan261004.md`、`docs/requirements/`、`docs/verification/`、根验证脚本。

**实现内容：** 按现有脚本运行可用基线；记录数据库、浏览器、渲染、Provider 的环境条件。将 contract/e2e 的 PLANNED 单独记录，建新增套件计划。

**验收／负面路径：** 实际命令和日志可复现；已有失败与新回归可区分；没有凭据时未运行 Provider 被标 BLOCKED，而不是 pass。

<a id="task-n00-04"></a>
### N00-04 建立多素材与对照样例集

**状态：** `TODO`　**依赖：** N00-03。  
**需求：** V03-03, V03-11, V03-24, V03-59, V03-60。  
**版本：** v0.3保留。  
**代码落点：** `AGENTS.md`、`README.md`、`ANCS_Plan261004.md`、`docs/requirements/`、`docs/verification/`、根验证脚本。

**实现内容：** 保留原金样，新增授权实拍、手机 VFR、分数帧率、独立音轨、录屏、图形对象、参考片和攻击素材；写 Brief、期望、来源和文件 hash。

**验收／负面路径：** 至少覆盖纯素材、生成、混合、长时序和恶意输入；测试虚构行情显著标 fixture；真实媒体权限可追溯。

<a id="task-n00-05"></a>
### N00-05 功能差项、发布门与开关

**状态：** `TODO`　**依赖：** N00-02, N00-04。  
**需求：** V03-06, V03-60, V03-64。  
**版本：** v0.3保留。  
**代码落点：** `AGENTS.md`、`README.md`、`ANCS_Plan261004.md`、`docs/requirements/`、`docs/verification/`、根验证脚本。

**实现内容：** 建立按平台／版本记录的 PR／剪映功能覆盖表、N 系列验收门和工作区功能开关；把原生支持与外部 round-trip 分开。

**验收／负面路径：** 任一尚未支持的专业能力有任务、限制和证据字段；关闭新功能旧项目仍可读；不继承旧总体完成百分比。

<a id="task-n00-06"></a>
### N00-06 建立新浏览器与媒体验收骨架

**状态：** `TODO`　**依赖：** N00-03, N00-04。  
**需求：** V03-59, V03-58。  
**版本：** v0.3保留。  
**代码落点：** `AGENTS.md`、`README.md`、`ANCS_Plan261004.md`、`docs/requirements/`、`docs/verification/`、根验证脚本。

**实现内容：** 接入真实浏览器启动、授权测试账户、存储 fixture、媒体输出探测与截图／音频证据目录；新增实际会失败的测试，不只新增占位脚本。

**验收／负面路径：** 用一个有意错误的素材路径验证套件会失败；浏览器打开真实项目并播放测试媒体；测试清理不误删其他租户数据。

<a id="task-n00-07"></a>
### N00-07 合并增量术语、来源边界和阶段映射

**状态：** `TODO`　**依赖：** N00-01, N00-02。  
**需求：** V04-01, V04-02, V04-26。  
**版本：** v0.4新增。  
**代码落点：** `AGENTS.md`、`README.md`、现有决策与需求目录。

**实现内容：** 建立§27逐条映射；把新方案P15—P23和T1—T6映射到既有N任务；检查ADR编号后再分配；保留v0.3任务和历史证据，不复制初始化任务。

**验收／负面路径：** 所有来源章节均有处置；无两个生效需求入口；对来源方案“已实现”的表述仍需代码和测试核验。

**增量来源：** 方案§0、§4、§14—§15；合并裁决。


<a id="phase-n01"></a>
## N01｜统一作品内核与精确时基

**验收门：** G0　**优先级：** P0。

**共用失败／回滚规则：** 采用增量 migration 和旧快照读兼容；新项目无法向旧模型无损写回时只读保护，禁止静默舍弃字段。

<a id="task-n01-01"></a>
### N01-01 有理时基、PTS与换算原语

**状态：** `TODO`　**依赖：** N00-02, N00-04。  
**需求：** V03-11, V03-16, V03-56。  
**版本：** v0.3保留。  
**代码落点：** `packages/contracts/src/scene-graph.ts`、`packages/contracts/src/edits.ts`、`packages/domain/src/edits.ts`、`packages/db/`、`packages/sdk/`；新模块名按 §17.5。

**实现内容：** 实现 MediaTime／MediaRange／FrameRate、整数安全校验、比较与舍入、源PTS与序列时间转换；保持旧 ms 映射；规定左闭右开与 drop-frame 仅显示。

**验收／负面路径：** 单测覆盖 24000/1001、30000/1001、60000/1001、48kHz、负源PTS、跨时基比较、溢出和长片无累计漂移。

<a id="task-n01-02"></a>
### N01-02 ProjectDocument与模式约束

**状态：** `TODO`　**依赖：** N01-01。  
**需求：** V03-03, V03-04, V03-55, V03-56。  
**版本：** v0.3保留。  
**代码落点：** `packages/contracts/src/scene-graph.ts`、`packages/contracts/src/edits.ts`、`packages/domain/src/edits.ts`、`packages/db/`、`packages/sdk/`；新模块名按 §17.5。

**实现内容：** 定义统一 ProjectDocument、Brief、ProductionPolicy、语义／合成关联与 schemaVersion；允许无文章、无旁白项目。按能力分开生成许可。

**验收／负面路径：** 纯素材空工程无需 NarrativePlan 即合法；禁用新画面后生成镜头请求被服务端拒绝；旧 SceneGraph 可映射并读取。

<a id="task-n01-03"></a>
### N01-03 序列、轨道、Clip与源范围

**状态：** `TODO`　**依赖：** N01-02。  
**需求：** V03-10, V03-14, V03-15, V03-16。  
**版本：** v0.3保留。  
**代码落点：** `packages/contracts/src/scene-graph.ts`、`packages/contracts/src/edits.ts`、`packages/domain/src/edits.ts`、`packages/db/`、`packages/sdk/`；新模块名按 §17.5。

**实现内容：** 实现多序列、轨道、Clip 的 sourceRange／sequenceRange／timeMapping、AV group、assetVersion 和对象父子引用；防循环嵌套与越界源范围。

**验收／负面路径：** 一个源文件可重复引用两个不同范围；多轨重叠合法；源出点越界、跨租户资产和循环嵌套被拒绝。

<a id="task-n01-04"></a>
### N01-04 图形、效果、字幕与音频对象

**状态：** `TODO`　**依赖：** N01-03。  
**需求：** V03-17, V03-18, V03-21, V03-23, V03-68。  
**版本：** v0.3保留。  
**代码落点：** `packages/contracts/src/scene-graph.ts`、`packages/contracts/src/edits.ts`、`packages/domain/src/edits.ts`、`packages/db/`、`packages/sdk/`；新模块名按 §17.5。

**实现内容：** 为现有组件、文字、overlay、字幕和音轨增加稳定对象ID、局部时基、参数／效果版本及动画绑定；不破坏已有组件输入 schema。

**验收／负面路径：** 组件对象在移动／重排后ID稳定；字幕／音频局部时间正确映射；未支持效果不能被静默忽略。

<a id="task-n01-05"></a>
### N01-05 增量迁移与旧项目兼容适配

**状态：** `TODO`　**依赖：** N01-03, N01-04。  
**需求：** V03-02, V03-56。  
**版本：** v0.3保留。  
**代码落点：** `packages/contracts/src/scene-graph.ts`、`packages/contracts/src/edits.ts`、`packages/domain/src/edits.ts`、`packages/db/`、`packages/sdk/`；新模块名按 §17.5。

**实现内容：** 先检查当前 migration 编号再新增；为旧 Scene、audio、caption、version 生成可验证投影；记录回填状态，采用单写入口切换与功能开关。

**验收／负面路径：** 旧金样迁移前后结构与解码输出在约定容差内；中断回填可重试；旧客户端不覆盖新字段；迁移失败不破坏原记录。

<a id="task-n01-06"></a>
### N01-06 操作注册表与候选状态校验

**状态：** `TODO`　**依赖：** N01-04。  
**需求：** V03-14, V03-29, V03-55。  
**版本：** v0.3保留。  
**代码落点：** `packages/contracts/src/scene-graph.ts`、`packages/contracts/src/edits.ts`、`packages/domain/src/edits.ts`、`packages/db/`、`packages/sdk/`；新模块名按 §17.5。

**实现内容：** 扩展现有 EditOperation 注册表：schema、授权、读写集、前置／后置、失效依赖、补偿数据与支持后端；整批先在候选状态顺序模拟。

**验收／负面路径：** 未知操作 fail closed；A操作创造对象后B可引用；无效B导致整批不落确认状态；前端和AI使用同一执行器。

<a id="task-n01-07"></a>
### N01-07 范围锁与间接影响计算

**状态：** `TODO`　**依赖：** N01-06。  
**需求：** V03-32, V03-33。  
**版本：** v0.3保留。  
**代码落点：** `packages/contracts/src/scene-graph.ts`、`packages/contracts/src/edits.ts`、`packages/domain/src/edits.ts`、`packages/db/`、`packages/sdk/`；新模块名按 §17.5。

**实现内容：** 实现内容／时位／时长／资产／风格／轨道锁及依赖影响集；重排、ripple、全局主题、嵌套修改均检查间接影响；明确解锁独立操作。

**验收／负面路径：** 锁定对象无 sceneId 的批量／重排操作仍不可绕过；内容锁允许的位移与时间锁禁止的位移区别正确；失败整批回滚。

<a id="task-n01-08"></a>
### N01-08 版本、快照与补偿事件扩展

**状态：** `TODO`　**依赖：** N01-05, N01-06, N01-07。  
**需求：** V03-10, V03-33, V03-55。  
**版本：** v0.3保留。  
**代码落点：** `packages/contracts/src/scene-graph.ts`、`packages/contracts/src/edits.ts`、`packages/domain/src/edits.ts`、`packages/db/`、`packages/sdk/`；新模块名按 §17.5。

**实现内容：** 扩展现有版本、EditEvent、Outbox，支持 Clip／Effect／对象完整前后状态与引用；保留补偿式 undo/redo，统一 revision 条件和幂等。

**验收／负面路径：** 撤销源裁剪／关键帧／音轨后真实时间与引用恢复；同字段并发只一方成功；重复写请求不增加重复事件。

<a id="task-n01-09"></a>
### N01-09 工程API、SDK与事件契约

**状态：** `TODO`　**依赖：** N01-08。  
**需求：** V03-05, V03-55, V03-56。  
**版本：** v0.3保留。  
**代码落点：** `packages/contracts/src/scene-graph.ts`、`packages/contracts/src/edits.ts`、`packages/domain/src/edits.ts`、`packages/db/`、`packages/sdk/`；新模块名按 §17.5。

**实现内容：** 新增／扩展工程读取、编辑操作、对象状态与事件，兼容原 API；自动生成或同步 SDK、OpenAPI 与规范错误。业务只在后端。

**验收／负面路径：** SDK↔API真实往返测试覆盖成功、409、权限失败、幂等和未知schema；客户端无法用旧写接口丢掉新工程字段。

<a id="task-n01-10"></a>
### N01-10 MediaSource与ClipInstance单一权威映射

**状态：** `TODO`　**依赖：** N01-03, N01-05。  
**需求：** V04-02。  
**版本：** v0.4新增。  
**代码落点：** 拟增量扩展 `packages/contracts/src/`、`packages/domain/src/`、`packages/db/`、`packages/sdk/`；先复用同语义模块。

**实现内容：** 将MediaSource映射到SourceAssetVersion及其媒体元数据视图，将ClipInstance映射到Clip；版本化原件不可变，proxy／analysis状态通过关联对象更新；给旧SceneGraph提供单向投影与回写适配。

**验收／负面路径：** 同一文件多次剪辑只引用同一原件版本；分析状态更新不改变源hash；旧客户端不能写丢新增字段；不存在双向无事务同步。

**增量来源：** 方案§5；合并裁决。

<a id="task-n01-11"></a>
### N01-11 Edit Operation v2全清单与别名编译

**状态：** `TODO`　**依赖：** N01-06, N01-10。  
**需求：** V04-03, V04-17。  
**版本：** v0.4新增。  
**代码落点：** 拟增量扩展 `packages/contracts/src/`、`packages/domain/src/`、`packages/db/`、`packages/sdk/`；先复用同语义模块。

**实现内容：** 按§13.5登记Clip复制/slip、轨道增删排序、效果与关键帧增改删、音频gain/fade/pan/automation、Marker、字幕段和Region；Preview命令单独归类。已有upsert/set操作可编译别名，统一一个执行器。

**验收／负面路径：** 每个来源操作均标原生／编译别名／待实现，不以空成功代替；GUI、快捷键、Agent同输入产生等价变更；未知操作fail closed。

**增量来源：** 方案§6。


<a id="phase-n02"></a>
## N02｜素材入库、代理与媒体理解

**验收门：** G0　**优先级：** P0。

**共用失败／回滚规则：** 原件不可覆盖；失败任务只清临时分片；媒体解析和转码隔离，生成许可关闭时不调用生成模型。

<a id="task-n02-01"></a>
### N02-01 有界内存的批量分片直传

**状态：** `TODO`　**依赖：** N00-06, N01-02。  
**需求：** V03-08, V03-09, V03-53。  
**版本：** v0.3保留。  
**代码落点：** 现有 `.../assets/page.tsx`、`packages/domain/src/assets.ts`、`packages/providers/`、`apps/worker/`、contracts／db／sdk。

**实现内容：** 扩展 upload intent／SDK，支持多文件、分片、进度、取消、续传和哈希校验；取消整文件 arrayBuffer 路径，按块读取并限制并发。

**验收／负面路径：** 大文件测试峰值内存不随文件大小线性增加；断网恢复不重复上传已确认分片；跨租户 complete、错误checksum和配额超限被拒绝。

<a id="task-n02-02"></a>
### N02-02 媒体探测与格式能力状态

**状态：** `TODO`　**依赖：** N02-01, N01-01。  
**需求：** V03-10, V03-11, V03-57。  
**版本：** v0.3保留。  
**代码落点：** 现有 `.../assets/page.tsx`、`packages/domain/src/assets.ts`、`packages/providers/`、`apps/worker/`、contracts／db／sdk。

**实现内容：** 隔离执行 ffprobe／解码检查，保存各流时基、PTS、旋转、色彩、声道与 VFR 信息；区分上传、解码、预览、导出可用。

**验收／负面路径：** 含旋转／VFR／多声道／损坏文件样例识别准确；伪扩展名不被直接信任；不支持编码返回可处理原因。

<a id="task-n02-03"></a>
### N02-03 代理转码与源时间映射

**状态：** `TODO`　**依赖：** N02-02, N01-03。  
**需求：** V03-11, V03-12。  
**版本：** v0.3保留。  
**代码落点：** 现有 `.../assets/page.tsx`、`packages/domain/src/assets.ts`、`packages/providers/`、`apps/worker/`、contracts／db／sdk。

**实现内容：** 按能力选择代理规格、音频 conform 和原PTS→代理映射；保留原件色彩／几何元数据和checksum；签名播放链接可更新。

**验收／负面路径：** 在开头、中间、结尾与多次seek比较对应源帧／音频；不把平均fps用于VFR映射；代理丢失能重建不动原件。

<a id="task-n02-04"></a>
### N02-04 缩略、波形、镜头与片段索引

**状态：** `TODO`　**依赖：** N02-02。  
**需求：** V03-13, V03-25。  
**版本：** v0.3保留。  
**代码落点：** 现有 `.../assets/page.tsx`、`packages/domain/src/assets.ts`、`packages/providers/`、`apps/worker/`、contracts／db／sdk。

**实现内容：** 生成按源时间寻址的缩略图、音频波形、镜头边界和质量标记；允许渐进就绪并复用索引。

**验收／负面路径：** 点击索引能回放正确源区间；长媒体按页加载；检测失败不影响已可播放原片。

<a id="task-n02-05"></a>
### N02-05 转写、说话人与字幕锚点

**状态：** `TODO`　**依赖：** N02-02, N01-04。  
**需求：** V03-13, V03-23, V03-24。  
**版本：** v0.3保留。  
**代码落点：** 现有 `.../assets/page.tsx`、`packages/domain/src/assets.ts`、`packages/providers/`、`apps/worker/`、contracts／db／sdk。

**实现内容：** 通过ASR Adapter生成词／句／说话人时间锚点，支持纠错、术语字典和版本；记录识别推测，不冒充真实字幕。

**验收／负面路径：** 纠正一个数字只重建相关字幕／索引；说话人未知不伪造姓名；原音无变化；ASR失败有明确待处理状态。

<a id="task-n02-06"></a>
### N02-06 语义素材检索与实际片段查看

**状态：** `TODO`　**依赖：** N02-04, N02-05。  
**需求：** V03-13, V03-28, V03-54。  
**版本：** v0.3保留。  
**代码落点：** 现有 `.../assets/page.tsx`、`packages/domain/src/assets.ts`、`packages/providers/`、`apps/worker/`、contracts／db／sdk。

**实现内容：** 将视觉、音频、转写和用户标签归一到源区间检索；导演可请求实际声画上下文；区分观测和推测，检索按workspace隔离。

**验收／负面路径：** 查询“产品近景”和“第二次回答”返回可播放范围；无结果不编造素材；参考字幕的指令无法触发动作。

<a id="task-n02-07"></a>
### N02-07 来源、许可与媒体生命周期

**状态：** `TODO`　**依赖：** N02-01, N01-03。  
**需求：** V03-10, V03-24, V03-44, V03-52。  
**版本：** v0.3保留。  
**代码落点：** 现有 `.../assets/page.tsx`、`packages/domain/src/assets.ts`、`packages/providers/`、`apps/worker/`、contracts／db／sdk。

**实现内容：** 扩展来源、权利、用户自有声明、署名、允许用途、敏感等级与派生血缘；区分删除引用／删除原件，GC检查冻结引用。

**验收／负面路径：** 其他项目／冻结版仍引用时普通缓存清理不删除原件；明确隐私删除流程有审计和缺失依赖提示；授权到期可阻止新发布。

<a id="task-n02-08"></a>
### N02-08 缺失媒体、重新链接与外部回绑

**状态：** `TODO`　**依赖：** N02-03, N02-07。  
**需求：** V03-12, V03-33, V03-57。  
**版本：** v0.3保留。  
**代码落点：** 现有 `.../assets/page.tsx`、`packages/domain/src/assets.ts`、`packages/providers/`、`apps/worker/`、contracts／db／sdk。

**实现内容：** 复用原 Native Fallback 资产回绑，增加checksum／时长／轨道校验和用户确认；保留离线引用、proxy与source关系。

**验收／负面路径：** 文件同名但内容不同不能静默替换；正确原件恢复后旧裁剪范围仍正确；外部替代形成新版本和审阅要求。

<a id="task-n02-09"></a>
### N02-09 素材输入真实端到端验收

**状态：** `TODO`　**依赖：** N02-01, N02-03, N02-06, N02-07, N02-08。  
**需求：** V03-08, V03-09, V03-12, V03-13, V03-59。  
**版本：** v0.3保留。  
**代码落点：** 现有 `.../assets/page.tsx`、`packages/domain/src/assets.ts`、`packages/providers/`、`apps/worker/`、contracts／db／sdk。

**实现内容：** 用浏览器上传批量真实授权媒体，等待索引、播放、检索、断线续传、回链；同时跑非法文件与越权用例。

**验收／负面路径：** 保留真实测试日志、媒体hash与播放证据；不是 mock 文件列表；没有第三方凭据的ASR单独标未验证。

<a id="task-n02-10"></a>
### N02-10 统一Media Index契约与证据记录

**状态：** `TODO`　**依赖：** N01-03, N02-02。  
**需求：** V04-04, V04-02。  
**版本：** v0.4新增。  
**代码落点：** 现有 `apps/worker/`、`packages/providers/` 与媒体契约／DB／SDK；`media-index`、`media-worker`仅为候选隔离边界。

**实现内容：** 实现§5.7记录schema、源区间与stream引用、tool/model/index版本、观测类型、置信校准状态；记录全类目能力支持和实际覆盖，空、失败、未分析不同。

**验收／负面路径：** 同一素材ASR和视觉结果可用源PTS交叉检索；不存在结果时返回NOT_ANALYZED或EMPTY而非虚构；跨租户source引用拒绝。

**增量来源：** 方案§1.2、§10。

<a id="task-n02-11"></a>
### N02-11 媒体分析分阶段检查点与局部失效

**状态：** `TODO`　**依赖：** N02-10, N02-03。  
**需求：** V04-05。  
**版本：** v0.4新增。  
**代码落点：** 现有 `apps/worker/`、`packages/providers/` 与媒体契约／DB／SDK；`media-index`、`media-worker`仅为候选隔离边界。

**实现内容：** 按Probe/Proxy/Waveform/ASR/Shot/Sampling/Vision/OCR/Audio/Embeddings构建可跳过DAG；每阶段独立checkpoint、预算、失败和取消；改变检测器只重跑依赖阶段，原媒体可播放即允许确定性编辑。

**验收／负面路径：** 停在ASR失败时仍可剪片；worker崩溃从检查点恢复；重复事件不重复扣费；未启用的检测器明确DISABLED；参考分析复用已完成阶段。

**增量来源：** 方案§10；工程细化。

<a id="task-n02-12"></a>
### N02-12 动作、对象、人物轨迹与运动强度索引

**状态：** `TODO`　**依赖：** N02-11。  
**需求：** V04-06, V04-04。  
**版本：** v0.4新增。  
**代码落点：** 现有 `apps/worker/`、`packages/providers/` 与媒体契约／DB／SDK；`media-index`、`media-worker`仅为候选隔离边界。

**实现内容：** 增量接入对象／动作／视觉事件／personTrack与运动强度提取，保留源范围、证据帧和轨迹生命周期；“举起手机”返回候选源段，可人工修正；不做未授权跨项目人脸实名匹配。

**验收／负面路径：** 用含多个举手/持手机干扰片段的授权样例测试；命中可跳转实际画面；未识别不编姓名；遮挡后轨迹不确定显式标出。

**增量来源：** 方案§1.2、§10、P18。

<a id="task-n02-13"></a>
### N02-13 音频事件、节拍和声画时间关联

**状态：** `TODO`　**依赖：** N02-11, N02-05。  
**需求：** V04-07, V04-04。  
**版本：** v0.4新增。  
**代码落点：** 现有 `apps/worker/`、`packages/providers/` 与媒体契约／DB／SDK；`media-index`、`media-worker`仅为候选隔离边界。

**实现内容：** 归一静默、掌声、环境声、音乐区间、beat/downbeat与估测tempo；与视觉动作通过精确时基关联，非音乐场景允许无节拍结果，所有推测保留证据。

**验收／负面路径：** 拍手／动作峰值定位到源区间；tempo变化不被单一BPM覆盖；独立音轨偏移可追溯；分析不修改原音。

**增量来源：** 方案§1.2、§10—§11。

<a id="task-n02-14"></a>
### N02-14 索引纠错覆盖层与删除权限同步

**状态：** `TODO`　**依赖：** N02-10, N02-07。  
**需求：** V04-08, V03-53。  
**版本：** v0.4新增。  
**代码落点：** 现有 `apps/worker/`、`packages/providers/` 与媒体契约／DB／SDK；`media-index`、`media-worker`仅为候选隔离边界。

**实现内容：** 区分模型结果、用户标签和已确认纠错；重分析保留更高优先级纠错及来源；检索先授权再取证据；删除和权限撤销同步主索引、向量、缩略与客户端缓存。

**验收／负面路径：** 修改ASR数字后重跑不恢复错字；撤销成员后旧检索游标不可读取；删除资产后缓存不会重新引入；相似embedding不跨租户去重泄露。

**增量来源：** 方案§10；继承安全要求的工程细化。

<a id="task-n02-15"></a>
### N02-15 共用素材检索与参考证据缓存

**状态：** `TODO`　**依赖：** N02-12, N02-13, N02-14, N02-06。  
**需求：** V04-09, V04-06, V04-07。  
**版本：** v0.4新增。  
**代码落点：** 现有 `apps/worker/`、`packages/providers/` 与媒体契约／DB／SDK；`media-index`、`media-worker`仅为候选隔离边界。

**实现内容：** 使导演、选区解析、参考分析读取同一MediaIndex；key包含源版本、范围、分析配置与权限上下文；必要时按范围读取声画补证，不每轮重分析全片。

**验收／负面路径：** 重复查询复用分析；源版本变化仅使相关记录失效；“举起手机”命中后可选中继续编辑；无权限缓存不返回；记录缓存命中与分析用量。

**增量来源：** 方案§1.2、§10。


<a id="phase-n03"></a>
## N03｜可交付的非破坏性剪辑垂直闭环

**验收门：** G0　**优先级：** P0。

**共用失败／回滚规则：** 先实现真实媒体操作再AI包装；源文件与已确认版本不变；普通CI用合法本地素材与确定性模拟推理，不冒充真实模型测试。

<a id="task-n03-01"></a>
### N03-01 素材到序列的插入／覆盖／追加

**状态：** `TODO`　**依赖：** N01-09, N02-03。  
**需求：** V03-03, V03-14, V03-15。  
**版本：** v0.3保留。  
**代码落点：** `packages/domain/src/edits.ts`、contracts／sdk、`packages/remotion-core/`、`packages/scene-components/`、现有编辑页与render-worker。

**实现内容：** 支持原素材直接建项目和在目标轨插入、覆盖、追加；定义是否保留间隙、轨道目标与AV关联；不依赖文章流程。

**验收／负面路径：** 三种操作对源范围、总时长和重叠关系正确；覆盖锁定区失败；无NarrativePlan能导入播放。

<a id="task-n03-02"></a>
### N03-02 拆分、裁剪、移动、替换与子片段

**状态：** `TODO`　**依赖：** N03-01。  
**需求：** V03-10, V03-14, V03-16。  
**版本：** v0.3保留。  
**代码落点：** `packages/domain/src/edits.ts`、contracts／sdk、`packages/remotion-core/`、`packages/scene-components/`、现有编辑页与render-worker。

**实现内容：** 实现源入出点、拆分、trim、move、duplicate、delete、replace source 和子片段；同步相关音轨／字幕／效果局部时钟。

**验收／负面路径：** 拆分后拼回总时长与源范围不变；越界trim失败；复制不复制二进制原件；替换需检查时长和批准失效。

<a id="task-n03-03"></a>
### N03-03 ripple、roll、slip、slide和J/L cut

**状态：** `TODO`　**依赖：** N03-02, N01-07。  
**需求：** V03-14, V03-15, V03-16, V03-32。  
**版本：** v0.3保留。  
**代码落点：** `packages/domain/src/edits.ts`、contracts／sdk、`packages/remotion-core/`、`packages/scene-components/`、现有编辑页与render-worker。

**实现内容：** 实现明确的精剪操作与影响集，包含关联音轨、同步锁、间隙与转场handles；位置变化向用户报告。

**验收／负面路径：** 每种操作有前后源／目标范围断言与可播放输出；禁止“其他别动”时意外ripple；J/L cut原音连续。

<a id="task-n03-04"></a>
### N03-04 多轨、AV链接与轨道控制

**状态：** `TODO`　**依赖：** N03-02。  
**需求：** V03-15, V03-21。  
**版本：** v0.3保留。  
**代码落点：** `packages/domain/src/edits.ts`、contracts／sdk、`packages/remotion-core/`、`packages/scene-components/`、现有编辑页与render-worker。

**实现内容：** 视频／音频／图形轨道可重排、静音、独奏、隐藏、链接、解链和同步锁；轨道状态进入版本和预览／导出。

**验收／负面路径：** 关闭一轨只影响该轨；解除链接后视频trim不误裁音轨；音轨solo导出与预览一致；undo恢复关联。

<a id="task-n03-05"></a>
### N03-05 可编辑变换与基础关键帧

**状态：** `TODO`　**依赖：** N01-04, N03-02。  
**需求：** V03-17, V03-18, V03-68。  
**版本：** v0.3保留。  
**代码落点：** `packages/domain/src/edits.ts`、contracts／sdk、`packages/remotion-core/`、`packages/scene-components/`、现有编辑页与render-worker。

**实现内容：** 复用标准组件，实现位置／缩放／旋转／裁切／锚点／透明度及线性和保持关键帧；模型可参数化修改。

**验收／负面路径：** 点击后移动对象不重生成镜头；指定关键帧读回一致；裁切／旋转前后命中坐标可检验；旧组件仍工作。

<a id="task-n03-06"></a>
### N03-06 基础混音与原声保护

**状态：** `TODO`　**依赖：** N03-04。  
**需求：** V03-04, V03-21。  
**版本：** v0.3保留。  
**代码落点：** `packages/domain/src/edits.ts`、contracts／sdk、`packages/remotion-core/`、`packages/scene-components/`、现有编辑页与render-worker。

**实现内容：** 实现片段增益、fade、ducking、声道映射与基础crossfade；保留原音和非破坏处理链，不自动重新合成讲话。

**验收／负面路径：** 原声保护模式输出语言内容未改；音量调整只改相应region；处理无削波／意外静音；撤销后源音恢复。

<a id="task-n03-07"></a>
### N03-07 字幕与转写驱动剪辑

**状态：** `TODO`　**依赖：** N02-05, N03-03。  
**需求：** V03-14, V03-23, V03-24。  
**版本：** v0.3保留。  
**代码落点：** `packages/domain/src/edits.ts`、contracts／sdk、`packages/remotion-core/`、`packages/scene-components/`、现有编辑页与render-worker。

**实现内容：** 字幕可编辑、断句、同步、样式及SRT/VTT输出；选择转写范围可定位原片并提出裁剪，不让改字幕自动改原音。

**验收／负面路径：** 删除转写需明确是剪内容还是改字幕；否定词／数字保留测试；字幕跟随ripple且不越界。

<a id="task-n03-08"></a>
### N03-08 多轨媒体预览与真实合成

**状态：** `TODO`　**依赖：** N03-03, N03-04, N03-05, N03-06, N03-07。  
**需求：** V03-03, V03-41, V03-61, V04-10, V04-14。  
**版本：** v0.3保留；v0.4显式补充，旧证据不清零。  
**代码落点：** `packages/domain/src/edits.ts`、contracts／sdk、`packages/remotion-core/`、`packages/scene-components/`、现有编辑页与render-worker。

**实现内容：** 扩展现有composition与render-worker，实际播放源剪辑、音频、图形和字幕；使用同一工程文档，新增能力缺失时报错。

**验收／负面路径：** 真实MP4解码检查源区间／时长／音轨；窗口预览与服务端合成关键帧对照；没有浏览器props之外的隐藏工程。

**v0.4增量要求：** 纳入N03-11的Playback契约；G0可用baseline／受控预渲染，不能将所有视频强制按React逐帧处理；N09-09—11完成正式混合后端。

**v0.4追加验收：** 预览后端类型与支持精度明确；不能用静态截图代替连续播放。

<a id="task-n03-09"></a>
### N03-09 范围编辑指令的最小AI入口

**状态：** `TODO`　**依赖：** N03-08, N02-06。  
**需求：** V03-01, V03-04, V03-28, V03-29。  
**版本：** v0.3保留。  
**代码落点：** `packages/domain/src/edits.ts`、contracts／sdk、`packages/remotion-core/`、`packages/scene-components/`、现有编辑页与render-worker。

**实现内容：** 扩展现有ai-edit，将选中片段、Brief、允许操作和源证据传给规划器；先输出可验证结构化编辑，范围外请求明确说明。

**验收／负面路径：** “去掉前面废话但保留原音”生成实际可执行裁剪；不存在素材不虚构；禁生成时Provider媒体调用计数为零。

<a id="task-n03-10"></a>
### N03-10 G0纯素材交付门

**状态：** `TODO`　**依赖：** N03-09, N01-08, N02-09, N03-16。  
**需求：** V03-03, V03-14, V03-32, V03-33, V03-40, V03-59, V03-61, V04-10, V04-26。  
**版本：** v0.3保留；v0.4显式补充，旧证据不清零。  
**代码落点：** `packages/domain/src/edits.ts`、contracts／sdk、`packages/remotion-core/`、`packages/scene-components/`、现有编辑页与render-worker。

**实现内容：** 在早期已确认状态／快照能力上完成纯素材小金样全程：导入、精剪、基础确认、再改、全片审阅、冻结快照、真实导出。完整提案系统随后接入。

**验收／负面路径：** 两轮修改互不破坏；能撤销和恢复；最终成片无占位，源hash未改；音视频同步、字幕与manifest实际校验通过。

**v0.4增量要求：** G0加入baseline播放同步验收N03-16；T2的无AI素材内核是先行切片，不代表G0全部完成。

**v0.4追加验收：** 有真实源片段/音频及视频导出证据；不要求WebGPU加速已完成才交付基础G0。

<a id="task-n03-11"></a>
### N03-11 PlaybackEngine契约与统一播放快照

**状态：** `TODO`　**依赖：** N01-09, N02-03, N01-11。  
**需求：** V04-10, V04-14。  
**版本：** v0.4新增。  
**代码落点：** 拟新增 `playback-core`逻辑模块，接入现有Web播放器；contracts／SDK与现有 `packages/remotion-core/`。

**实现内容：** 实现loadDocument/play/pause/seek/step/setRange/getClock/getCapabilities/dispose及事件；读取ProjectDocument同版本投影，不在播放器维护第二套编辑状态；先适配现有可用预览后端。

**验收／负面路径：** 切换后端不改变工程；播放事件带requestId、revision与实际presented时间；unknown capability不能被展示为支持；dispose可重复调用。

**增量来源：** 方案§1.4、§13。

<a id="task-n03-12"></a>
### N03-12 标准proxy与HTML媒体／MSE回退路径

**状态：** `TODO`　**依赖：** N03-11, N02-03。  
**需求：** V04-10, V04-11。  
**版本：** v0.4新增。  
**代码落点：** 拟新增 `playback-core`逻辑模块，接入现有Web播放器；contracts／SDK与现有 `packages/remotion-core/`。

**实现内容：** 定义proxy codec/container/GOP/audio profile及manifest；按实际可用能力选择HTMLMediaElement、MSE或局部预渲染；实现Range读取、分段缓存、签名URL更新、错误恢复和有限预取。

**验收／负面路径：** 无WebCodecs/WebGPU仍能看并剪受支持proxy；过期URL刷新不重置选区；冷／热缓存分别测首帧；回退达不到逐帧时明确限制，不虚报frame-accurate。

**增量来源：** 方案§13。

<a id="task-n03-13"></a>
### N03-13 WebAudio主时钟与音画同步调度

**状态：** `TODO`　**依赖：** N03-12, N03-06。  
**需求：** V04-12。  
**版本：** v0.4新增。  
**代码落点：** 拟新增 `playback-core`逻辑模块，接入现有Web播放器；contracts／SDK与现有 `packages/remotion-core/`。

**实现内容：** 以统一媒体时钟调度WebAudio／画面／字幕；处理音频上下文挂起、播放许可、seek epoch、音量淡变、clip边界和速率；无音轨时使用同接口虚拟时钟。

**验收／负面路径：** 连续seek后旧音频不播放；后台恢复不快进或重复音轨；长样例漂移满足§20目标；音频未授权播放时清楚提示。

**增量来源：** 方案§13；工程细化。

<a id="task-n03-14"></a>
### N03-14 WebCodecs加速、可选WASM与帧资源预算

**状态：** `TODO`　**依赖：** N03-12。  
**需求：** V04-11。  
**版本：** v0.4新增。  
**专项门：** G3加速能力门，不阻塞最小G0。  
**代码落点：** 拟新增 `playback-core`逻辑模块，接入现有Web播放器；contracts／SDK与现有 `packages/remotion-core/`。

**实现内容：** 按codec/profile/尺寸实测能力；对压缩包解复用、关键帧查找、目标PTS解码、呈现和释放建立有界队列；WASM仅在证明需要时以固定版本沙箱插件接入。

**验收／负面路径：** 快速拖动时过期seek帧不覆盖新位置；坏包、unsupported codec、decoder reset和内存上限可回退；VideoFrame/AudioData等持有量不随编辑轮数增长。

**增量来源：** 方案§1.4、§13；工程细化。

<a id="task-n03-15"></a>
### N03-15 GPU合成与交互缓存生命周期

**状态：** `TODO`　**依赖：** N03-14, N03-05。  
**需求：** V04-13。  
**版本：** v0.4新增。  
**专项门：** G3加速能力门。  
**代码落点：** 拟新增 `playback-core`逻辑模块，接入现有Web播放器；contracts／SDK与现有 `packages/remotion-core/`。

**实现内容：** 以共享图形顺序和坐标变换实现WebGL／可选WebGPU合成；纹理池、帧缓存、mask与alpha处理有配额；device/context lost保留已确认工程并降级。

**验收／负面路径：** 半透明文字/遮罩/裁切与命中位置一致；失去GPU后有清楚回退且数据不丢；重复切项目无跨租户纹理泄露；不宣称所有设备都有硬件加速。

**增量来源：** 方案§1.4、§13；工程细化。

<a id="task-n03-16"></a>
### N03-16 播放基础矩阵与帧／音频一致性验证

**状态：** `TODO`　**依赖：** N03-12, N03-13, N03-08。  
**需求：** V04-10, V04-11, V04-12, V04-14。  
**版本：** v0.4新增。  
**代码落点：** 拟新增 `playback-core`逻辑模块，接入现有Web播放器；contracts／SDK与现有 `packages/remotion-core/`。

**实现内容：** 建立含VFR、分数帧率、多音轨、字幕、J/L cut和转场的浏览器金样；记录presentedPTS、输出帧、音频偏移、冷／热seek、掉帧和内存；先验证baseline后端。

**验收／负面路径：** 真实浏览器＋真实媒体输出；缓存seek p95与长片漂移按§20阈值；不支持帧级精度不能通过逐帧门；报告区分预渲染与本地实时路径。

**增量来源：** 方案§13、最终验收；工程细化。


<a id="phase-n04"></a>
## N04｜极简共看片室与共同注意力

**验收门：** G1　**优先级：** P0。

**共用失败／回滚规则：** 旧路由保留可用跳转；新的UI不能屏蔽错误与权限；交互空间坐标仅为临时值，稳定对象引用为准。

<a id="task-n04-01"></a>
### N04-01 共看片室壳与项目默认路由

**状态：** `TODO`　**依赖：** N00-05, N03-08。  
**需求：** V03-06, V03-07, V03-65, V04-52, V04-58。  
**版本：** v0.3保留；v0.4显式补充，旧证据不清零。  
**代码落点：** 现有项目 `layout.tsx`、editor页、`apps/web/src/ui/`、`packages/contracts/`、`packages/sdk/`；attention模块拟新增。

**实现内容：** 将默认项目空间改为作品画布、极简头部与播放／语音底栏；素材／历史／专业面板转按需抽屉，维持旧深链接。

**验收／负面路径：** 默认不常驻七标签／props表；同一画布完成查看与编辑；空／上传中／失败／只读各状态可用；旧能力可找到。

**v0.4增量要求：** 新共看片室使用§29黑白语义token，入口不再继承旧蓝色/彩色模板；对接N16的分阶段组件迁移。

**v0.4追加验收：** UI变化不改变视频色彩、工程状态或费用。

<a id="task-n04-02"></a>
### N04-02 结构化对象命中注册

**状态：** `TODO`　**依赖：** N01-04, N03-05, N04-01。  
**需求：** V03-17, V03-25。  
**版本：** v0.3保留。  
**代码落点：** 现有项目 `layout.tsx`、editor页、`apps/web/src/ui/`、`packages/contracts/`、`packages/sdk/`；attention模块拟新增。

**实现内容：** 为标准组件和对象注册稳定ID、几何、z-order、可见范围与参数映射；实现画布变换、letterbox和全屏坐标转换。

**验收／负面路径：** 标题／图表点／人物overlay选择准确；缩放、DPR、旋转、遮挡与父子对象测试；命中不触发内容写入。

<a id="task-n04-03"></a>
### N04-03 点击、悬浮、框选与组合选择

**状态：** `TODO`　**依赖：** N04-02。  
**需求：** V03-25, V03-65。  
**版本：** v0.3保留。  
**代码落点：** 现有项目 `layout.tsx`、editor页、`apps/web/src/ui/`、`packages/contracts/`、`packages/sdk/`；attention模块拟新增。

**实现内容：** 悬浮轻高亮无暂停；点击显式选择；框选对象集合或像素区域；支持清除、修饰键、触控与键盘等价。

**验收／负面路径：** 偶然hover不覆盖明确selection；遮挡多候选能消歧；选择状态改变不会生成收费任务。

<a id="task-n04-04"></a>
### N04-04 时间范围、逐帧和音频目标

**状态：** `TODO`　**依赖：** N04-01, N03-04, N03-07。  
**需求：** V03-21, V03-23, V03-25, V03-31。  
**版本：** v0.3保留。  
**代码落点：** 现有项目 `layout.tsx`、editor页、`apps/web/src/ui/`、`packages/contracts/`、`packages/sdk/`；attention模块拟新增。

**实现内容：** 播放条支持范围拖选、源/序列时间显示、逐帧、说话句段与音乐region选择；空间和时间选择可以组合。

**验收／负面路径：** “这句话／这里的音乐”指向正确对象；seek后选择和时间码一致；分数帧率显示不丢帧。

<a id="task-n04-05"></a>
### N04-05 AttentionSnapshot与事件缓冲

**状态：** `TODO`　**依赖：** N04-03, N04-04, N01-09。  
**需求：** V03-25, V03-26, V03-54, V04-15。  
**版本：** v0.3保留；v0.4显式补充，旧证据不清零。  
**代码落点：** 现有项目 `layout.tsx`、editor页、`apps/web/src/ui/`、`packages/contracts/`、`packages/sdk/`；attention模块拟新增。

**实现内容：** 实现单调时钟、epoch、播放revision、seek、selection和语音sample anchor的有限事件缓冲；服务端验证归属与陈旧目标。

**验收／负面路径：** 选中A后鼠标移B、发话后seek、全屏变化、延迟返回、旧revision输入都有回放测试；不永久上传完整鼠标轨迹。

**v0.4增量要求：** SelectionAnchor是AttentionSnapshot的规范选择子结构，详见N04-09，不新增另一份权威选择状态。

**v0.4追加验收：** 新旧请求兼容，语音与版本时间不得降精度。

<a id="task-n04-06"></a>
### N04-06 指代解析与源视频区域锚点

**状态：** `TODO`　**依赖：** N04-05, N02-06。  
**需求：** V03-19, V03-25, V03-28。  
**版本：** v0.3保留。  
**代码落点：** 现有项目 `layout.tsx`、editor页、`apps/web/src/ui/`、`packages/contracts/`、`packages/sdk/`；attention模块拟新增。

**实现内容：** 结合词段时间、显式选择和观看记录解析这里／刚才；像素内对象先定位源区域，按能力再跟踪，不伪称独立图层。

**验收／负面路径：** 指代不确定时只问必要问题；原视频无法独立改对象时能力说明明确；区域引用在重排后仍绑定源帧。

<a id="task-n04-07"></a>
### N04-07 按需专业控制与直接操作共用协议

**状态：** `TODO`　**依赖：** N04-01, N03-03, N03-05, N01-09。  
**需求：** V03-06, V03-14, V03-18, V03-65, V04-58, V04-62。  
**版本：** v0.3保留；v0.4显式补充，旧证据不清零。  
**代码落点：** 现有项目 `layout.tsx`、editor页、`apps/web/src/ui/`、`packages/contracts/`、`packages/sdk/`；attention模块拟新增。

**实现内容：** 提供可展开时间轴／对象／字幕／音频控制和撤销快捷键；直接拖动最终经同一编辑协议提交，UI不维护第二套权威。

**验收／负面路径：** 鼠标修改后AI能看到正确版本；AI修改后专业面板同步；关闭面板复杂参数不丢；冲突不静默覆盖。

**v0.4增量要求：** 专业参数保留；中性时间轴和Inspector按§29.8设计，选区双描边并提供数值入口。

**v0.4追加验收：** 暗/亮/透明素材可定位，禁止删精确字段换取空白感。

<a id="task-n04-08"></a>
### N04-08 无障碍与真实指点旅程

**状态：** `TODO`　**依赖：** N04-03, N04-04, N04-06, N04-07。  
**需求：** V03-06, V03-25, V03-59, V03-65, V04-53, V04-62, V04-63。  
**版本：** v0.3保留；v0.4显式补充，旧证据不清零。  
**代码落点：** 现有项目 `layout.tsx`、editor页、`apps/web/src/ui/`、`packages/contracts/`、`packages/sdk/`；attention模块拟新增。

**实现内容：** 实现keyboard／screen-reader标签、文字fallback、reduced-motion和移动触控；真实浏览器验证点击对象→输入指令→回放。

**验收／负面路径：** 仅键盘可暂停、选范围、采用／撤销；小屏和全屏均无挡住作品的常驻面板；不以截图静态演示代替交互测试。

**v0.4增量要求：** 增加两主题、200%缩放、长中文、高对比、降低动画和原色保护场景。

**v0.4追加验收：** 设计静态检查不代替媒体交互与键盘真实验收。

<a id="task-n04-09"></a>
### N04-09 SelectionAnchor归一与旧Attention兼容

**状态：** `TODO`　**依赖：** N04-05, N01-10。  
**需求：** V04-15, V04-02。  
**版本：** v0.4新增。  
**代码落点：** 拟增量扩展 `packages/contracts/src/`、`packages/domain/src/`、`packages/db/`、`packages/sdk/`；先复用同语义模块。

**实现内容：** 将SelectionAnchor定义为AttentionSnapshot.selection的规范子结构；支持多clip/track/caption/object、语义refs、归一化rect和源／序列range；兼容旧inline格式但内部只解析一次。

**验收／负面路径：** 旧请求可读，新请求不丢有理时基；指代使用对应发话时间；frameHash不能作为对象身份或授权；过期版本明确STALE/AMBIGUOUS。

**增量来源：** 方案§3.1、§7；合并裁决。

<a id="task-n04-10"></a>
### N04-10 刷新、嵌套与时序变更后的锚点恢复

**状态：** `TODO`　**依赖：** N04-09, N04-06, N03-12。  
**需求：** V04-15。  
**版本：** v0.4新增。  
**代码落点：** 拟新增 `playback-core`逻辑模块，接入现有Web播放器；contracts／SDK与现有 `packages/remotion-core/`。

**实现内容：** 持久保存显式选区及其版本/源range；对移动、ripple、裁切、嵌套进行受验证remap，hover仅短时上下文；恢复画布letterbox和缩放后的几何映射。

**验收／负面路径：** 选中字幕刷新后仍定位同对象；源区间已被删时返回STALE不默选邻片；语音过程中鼠标移走不改变目标；音频锚点不误指画面。

**增量来源：** 方案P16、T4；工程细化。

<a id="task-n04-11"></a>
### N04-11 Smart Timeline与共用命令／Inspector入口

**状态：** `TODO`　**依赖：** N04-07, N01-11。  
**需求：** V04-16, V04-03。  
**版本：** v0.4新增。  
**代码落点：** 现有项目layout／editor路由、UI与SDK；拟增command registry适配。

**实现内容：** 默认薄时间条与画布；点击选中不强制弹出大属性表；按需显示Inspector、可固定专业面板和快捷命令，转写抽屉仅是辅助定位；迁移旧深链接。

**验收／负面路径：** 五个最小操作可由GUI／快捷键直接调用同执行器；关闭面板不丢高级参数；无麦克风可完成；旧Scene Editor只做兼容不再必经。

**增量来源：** 方案§2、§4.2、T3。


<a id="phase-n05"></a>
## N05｜实时语音、打断与会话恢复

**验收门：** G1　**优先级：** P0。

**共用失败／回滚规则：** 停语音不等于撤销编辑或免费取消；敏感录音最小保留；Provider不支持时明确降级，不用mock证明实时质量。

<a id="task-n05-01"></a>
### N05-01 实时会话与短期凭证适配

**状态：** `TODO`　**依赖：** N01-09, N04-05。  
**需求：** V03-26, V03-49, V03-53。  
**版本：** v0.3保留。  
**代码落点：** `packages/providers/`、contracts／domain／api／sdk、`apps/web/src/ui/`；interaction-session拟新增。

**实现内容：** 在Provider层实现Realtime或等效传输、会话权限与有效期；长期Key不下发。工具执行始终回后端，不信任客户端会话配置作为权限依据。

**验收／负面路径：** 主Key不出现在页面／网络响应；无权限用户不能创建会话；过期和撤销会话不可继续执行项目操作。

<a id="task-n05-02"></a>
### N05-02 语音采集、转写与时间对齐

**状态：** `TODO`　**依赖：** N05-01, N04-05。  
**需求：** V03-25, V03-26。  
**版本：** v0.3保留。  
**代码落点：** `packages/providers/`、contracts／domain／api／sdk、`apps/web/src/ui/`；interaction-session拟新增。

**实现内容：** 接入麦克风、ASR增量／最终文本、utterance ID、sample clock及注意力映射；保留文字替代和多语言字段。

**验收／负面路径：** 同一句话的重复事件不重复提交；句首／指代词／句末鼠标不同用例定位正确；中文数字／否定词低置信度被提示。

<a id="task-n05-03"></a>
### N05-03 VAD、回声与用户声源边界

**状态：** `TODO`　**依赖：** N05-02。  
**需求：** V03-26, V03-27, V03-54。  
**版本：** v0.3保留。  
**代码落点：** `packages/providers/`、contracts／domain／api／sdk、`apps/web/src/ui/`；interaction-session拟新增。

**实现内容：** 支持按住说话与显式连续会话、VAD配置、播放ducking和回声处理；片中旁白及AI播报不成为用户授权。

**验收／负面路径：** 片中播放“删除全部”不触发操作；AI说话时用户可打断；拒绝麦克风权限后文字仍可完成编辑。

<a id="task-n05-04"></a>
### N05-04 语音与制作任务分离的取消协议

**状态：** `TODO`　**依赖：** N05-03, N01-09。  
**需求：** V03-27, V03-33, V03-50, V03-51。  
**版本：** v0.3保留。  
**代码落点：** `packages/providers/`、contracts／domain／api／sdk、`apps/web/src/ui/`；interaction-session拟新增。

**实现内容：** 定义stop_speech、cancel_proposal、cancel_job不同动作及反馈；保留外部不支持取消／已计费／晚到结果的状态。

**验收／负面路径：** 暂停AI音频不自动undo；不可取消Provider显示真实状态；旧任务完成不误采用；取消重试不双扣。

<a id="task-n05-05"></a>
### N05-05 会话断网重连与去重恢复

**状态：** `TODO`　**依赖：** N05-02, N05-04。  
**需求：** V03-26, V03-33, V03-34, V03-66。  
**版本：** v0.3保留。  
**代码落点：** `packages/providers/`、contracts／domain／api／sdk、`apps/web/src/ui/`；interaction-session拟新增。

**实现内容：** 从持久确认版、未完成任务、有效提案和笔记恢复；音频item与编辑request各自去重；浏览器刷新不重发昂贵任务。

**验收／负面路径：** 断线于转写中／提交后／结果前均正确恢复；未发完语句不被执行；不同设备会话不会误用过期selection。

<a id="task-n05-06"></a>
### N05-06 AI提问与短回应策略

**状态：** `TODO`　**依赖：** N05-03, N04-06。  
**需求：** V03-01, V03-26, V03-28。  
**版本：** v0.3保留。  
**代码落点：** `packages/providers/`、contracts／domain／api／sdk、`apps/web/src/ui/`；interaction-session拟新增。

**实现内容：** 短回应指出目标与范围；只问方向性或高风险歧义；用户明确选择后直接试改；支持不出声／字幕回应。

**验收／负面路径：** 无歧义标题缩小不重复询问；多方向“高级”给少量样版；片中关键声音不被AI长篇播报覆盖。

<a id="task-n05-07"></a>
### N05-07 实时能力与费用可见性

**状态：** `TODO`　**依赖：** N05-01, N05-04。  
**需求：** V03-26, V03-49, V03-51, V03-58。  
**版本：** v0.3保留。  
**代码落点：** `packages/providers/`、contracts／domain／api／sdk、`apps/web/src/ui/`；interaction-session拟新增。

**实现内容：** 公开会话连接、监听、转写、思考、执行、失效等状态；计入实时音频用量；provider不可用时真实降级说明。

**验收／负面路径：** 录音上传路径不标成流式；账户能力不足时不无限重连；会话退出后麦克风释放且费用任务结清。

<a id="task-n05-08"></a>
### N05-08 真实语音端到端验收

**状态：** `TODO`　**依赖：** N05-05, N05-06, N05-07, N04-08。  
**需求：** V03-25, V03-26, V03-27, V03-59。  
**版本：** v0.3保留。  
**代码落点：** `packages/providers/`、contracts／domain／api／sdk、`apps/web/src/ui/`；interaction-session拟新增。

**实现内容：** 用实际授权Provider与浏览器完成点选、发话、局部指令、打断、重连；记录设备、网络、延迟与失败。

**验收／负面路径：** 语音素材和日志脱敏；单独记录真实调用与mock；无真实凭据不得关闭G1语音门。


<a id="phase-n06"></a>
## N06｜持久化提案、确认和创作收敛

**验收门：** G1　**优先级：** P0。

**共用失败／回滚规则：** 试改可持久化但不改确认版；采用为原子事务；拒绝／超时／旧回调不覆盖新结果，费用和编辑历史各自保存。

<a id="task-n06-01"></a>
### N06-01 Proposal与私有候选分支

**状态：** `TODO`　**依赖：** N01-08, N03-08。  
**需求：** V03-30, V03-33, V04-19。  
**版本：** v0.3保留；v0.4显式补充，旧证据不清零。  
**代码落点：** 现有 `ai-edit.ts`／`edits.ts`、db／contracts／sdk、web对比回放组件；edit-proposals拟新增。

**实现内容：** 实现提案基础版本、候选patch、活动revision、状态与资产引用；允许在前一试改上继续而非每轮从零生成。

**验收／负面路径：** 刷新可恢复试改；未采用确认作品hash不变；跨workspace不可读提案；多次patch保持连续版本。

**v0.4增量要求：** Preview Branch是Proposal的候选状态实现；正式EditEvent和活动/费用/审计日志严格分离。

**v0.4追加验收：** 拒绝不能修改正式历史，也不能抹去已发生的Provider费用。

<a id="task-n06-02"></a>
### N06-02 提案预检与原子采用

**状态：** `TODO`　**依赖：** N06-01, N01-07。  
**需求：** V03-04, V03-29, V03-30, V03-32。  
**版本：** v0.3保留。  
**代码落点：** 现有 `ai-edit.ts`／`edits.ts`、db／contracts／sdk、web对比回放组件；edit-proposals拟新增。

**实现内容：** 整批模拟、模式／锁／授权／预算检查；采用确认版、事件、决定、Outbox同事务；拒绝部分依赖被过滤后伪成功。

**验收／负面路径：** A/B依赖中B不可执行则整批不采用；同一proposal接受两次幂等；采用不重新调用生成模型。

<a id="task-n06-03"></a>
### N06-03 影响集、陈旧提案与rebase

**状态：** `TODO`　**依赖：** N06-02。  
**需求：** V03-32, V03-33。  
**版本：** v0.3保留。  
**代码落点：** 现有 `ai-edit.ts`／`edits.ts`、db／contracts／sdk、web对比回放组件；edit-proposals拟新增。

**实现内容：** 记录字段读写集和依赖版本；非冲突改动验证后rebase，同对象竞争报告冲突；源资产／身份变化触发重新审核。

**验收／负面路径：** 两端改不同片段可受控合并；改同字段409；重排锁间接影响可检测；不能以最新revision强覆盖。

<a id="task-n06-04"></a>
### N06-04 局部试片缓存与依赖失效

**状态：** `TODO`　**依赖：** N06-01, N03-08。  
**需求：** V03-31, V03-39, V03-41, V03-51。  
**版本：** v0.3保留。  
**代码落点：** 现有 `ai-edit.ts`／`edits.ts`、db／contracts／sdk、web对比回放组件；edit-proposals拟新增。

**实现内容：** 按受影响对象和前后上下文生成预览或局部渲染；hash引用包含实际输入／组件／策略版本；未变资产复用。

**验收／负面路径：** 改字幕不重生成人物；预览重复请求幂等；新旁白正确使关联字幕／lip-sync失效，其他部分不变。

<a id="task-n06-05"></a>
### N06-05 采用、继续微调、拒绝与部分采用

**状态：** `TODO`　**依赖：** N06-02, N06-04。  
**需求：** V03-30, V03-31, V03-34。  
**版本：** v0.3保留。  
**代码落点：** 现有 `ai-edit.ts`／`edits.ts`、db／contracts／sdk、web对比回放组件；edit-proposals拟新增。

**实现内容：** UI与语音语义区分“方向对再改”“采用”“后面也这样”；部分采用检查依赖闭包，作用范围明确可见。

**验收／负面路径：** “再慢一点”未提前采用；沉默不确认；多个候选“用这个”无唯一目标时消歧；部分采用不会切断音画依赖。

<a id="task-n06-06"></a>
### N06-06 提案替代、取消与晚到结果

**状态：** `TODO`　**依赖：** N06-01, N06-04。  
**需求：** V03-27, V03-33, V03-50。  
**版本：** v0.3保留。  
**代码落点：** 现有 `ai-edit.ts`／`edits.ts`、db／contracts／sdk、web对比回放组件；edit-proposals拟新增。

**实现内容：** revision与任务绑定；新指令可supersede旧提案；取消标记不丢已有结果；外部晚到产物隔离而非自动绑定。

**验收／负面路径：** 先慢后快两任务逆序完成仍展示最新意图；取消后回调不改变acceptedRevision；孤儿资产按保留策略清理。

<a id="task-n06-07"></a>
### N06-07 已确认内容保护与回归指纹

**状态：** `TODO`　**依赖：** N06-03, N06-05。  
**需求：** V03-32, V03-33, V03-39。  
**版本：** v0.3保留。  
**代码落点：** 现有 `ai-edit.ts`／`edits.ts`、db／contracts／sdk、web对比回放组件；edit-proposals拟新增。

**实现内容：** 实现内容／时位／资产指纹与范围外变化报告；“其他别动”遇总时长改变时先解释或改为等长方案。

**验收／负面路径：** 连续三轮修改后早先认可的开场、声音和产品外观仍引用相同资产与参数；意外移位阻止自动采用。

<a id="task-n06-08"></a>
### N06-08 A/B比较、局部循环与版本恢复

**状态：** `TODO`　**依赖：** N06-04, N06-05, N04-04。  
**需求：** V03-31, V03-33, V03-41。  
**版本：** v0.3保留。  
**代码落点：** 现有 `ai-edit.ts`／`edits.ts`、db／contracts／sdk、web对比回放组件；edit-proposals拟新增。

**实现内容：** 同一画布切换前后、差异标记、音频AB和循环回放；时长不同用内容锚点对齐；恢复沿用补偿事件。

**验收／负面路径：** 回到上一版得到实际资产而非重新生成；相同锚点对照不会错位；恢复音轨和关键帧都准确。

<a id="task-n06-09"></a>
### N06-09 多轮收敛端到端验收

**状态：** `TODO`　**依赖：** N06-06, N06-07, N06-08, N04-08。  
**需求：** V03-30, V03-31, V03-32, V03-33, V03-59。  
**版本：** v0.3保留。  
**代码落点：** 现有 `ai-edit.ts`／`edits.ts`、db／contracts／sdk、web对比回放组件；edit-proposals拟新增。

**实现内容：** 跑E04/E05/E11/E12/E15，覆盖断网、冲突、锁、取消和长提案链；计量范围外误改及资产复用。

**验收／负面路径：** 关键确定性负面断言全通过；真实局部视频可看可听；纯计划摘要不可计为样版完成。

<a id="task-n06-10"></a>
### N06-10 Preview Branch双日志与拒绝语义

**状态：** `TODO`　**依赖：** N06-01, N01-08。  
**需求：** V04-19。  
**版本：** v0.4新增。  
**代码落点：** 拟增量扩展 `packages/contracts/src/`、`packages/domain/src/`、`packages/db/`、`packages/sdk/`；先复用同语义模块。

**实现内容：** 复用Proposal存储branch/base/patches/dependencies；正式EditEvent与候选活动／Job／Cost／Audit分开；拒绝逻辑关闭分支，私有缓存按生命周期清理，不删除费用证据。

**验收／负面路径：** create/patch/reject前后acceptedRevision与正式内容历史相等；活动／审计记录仍可查；另一用户正式编辑不被Reject撤销；原件hash不变。

**增量来源：** 方案§9；合并裁决。

<a id="task-n06-11"></a>
### N06-11 预览采用单事务、重试与并发证明

**状态：** `TODO`　**依赖：** N06-10, N06-02, N06-03, N06-06。  
**需求：** V04-19, V03-33。  
**版本：** v0.4新增。  
**代码落点：** 拟增量扩展 `packages/contracts/src/`、`packages/domain/src/`、`packages/db/`、`packages/sdk/`；先复用同语义模块。

**实现内容：** 采用一次产生一个逻辑提交和新的确认revision，保留子操作及可逆信息；compare-and-swap检查base、锁、权限和作用范围；分支状态、笔记与Outbox同事务提交。

**验收／负面路径：** 重复Accept只有一次提交；并发冲突不半提交；撤销采用恢复全部对象；晚到结果不复活已拒绝分支；历史不被物理squash删除。

**增量来源：** 方案§9；工程细化。


<a id="phase-n07"></a>
## N07｜AI导演、约束编译与决策记忆

**验收门：** G1　**优先级：** P0。

**共用失败／回滚规则：** AI只产出结构化提案和解释性摘要；模型建议不升级为用户事实；规划失败保留确认版，不直接改库。

<a id="task-n07-01"></a>
### N07-01 CreativeBrief与最少提问

**状态：** `TODO`　**依赖：** N01-02, N02-06。  
**需求：** V03-01, V03-07, V03-08, V03-28。  
**版本：** v0.3保留。  
**代码落点：** 现有 `packages/domain/src/ai-edit.ts`、`director.ts`、`content-core.ts`、creator／channel与db／contracts；Brief／notes服务拟新增。

**实现内容：** 统一创意、原素材、文章和参考输入；按USER_CONFIRMED／ASSUMED／MEDIA保存Brief；复用已有身份／规格，不重复问已知信息。

**验收／负面路径：** 仅素材输入也能建Brief；模糊诉求只问重要问题或先样版；假设在UI可见且可纠正。

<a id="task-n07-02"></a>
### N07-02 创作诊断与方案规划

**状态：** `TODO`　**依赖：** N07-01, N06-01。  
**需求：** V03-01, V03-24, V03-28, V03-43。  
**版本：** v0.3保留。  
**代码落点：** 现有 `packages/domain/src/ai-edit.ts`、`director.ts`、`content-core.ts`、creator／channel与db／contracts；Brief／notes服务拟新增。

**实现内容：** 从实际媒体与叙事诊断理解、证据、节奏和情绪问题；先给一个主方案，明显分歧才第二方向；计划关联证据。

**验收／负面路径：** “没说服力”不能一律加转场；证据缺失明确说明；诊断输出可编译为可执行操作而非只有文案。

<a id="task-n07-03"></a>
### N07-03 素材／生成选择与硬约束编译

**状态：** `TODO`　**依赖：** N07-02, N01-06。  
**需求：** V03-03, V03-04, V03-29, V03-49, V03-68。  
**版本：** v0.3保留。  
**代码落点：** 现有 `packages/domain/src/ai-edit.ts`、`director.ts`、`content-core.ts`、creator／channel与db／contracts；Brief／notes服务拟新增。

**实现内容：** 以ProductionPolicy、资产、能力目录和预算编译制作计划；按真实素材、程序化、生成选择；受限模式不隐式重写音频。

**验收／负面路径：** FOOTAGE_EDIT禁止生成新镜头；无可用能力时返回缺口与替代；规划与执行两层都检查限制。

<a id="task-n07-04"></a>
### N07-04 领域工具授权与结果观测

**状态：** `TODO`　**依赖：** N07-03, N06-02。  
**需求：** V03-29, V03-42, V03-54, V03-55, V04-17。  
**版本：** v0.3保留；v0.4显式补充，旧证据不清零。  
**代码落点：** 现有 `packages/domain/src/ai-edit.ts`、`director.ts`、`content-core.ts`、creator／channel与db／contracts；Brief／notes服务拟新增。

**实现内容：** 定义inspect／resolve／preview／propose／generate工具与最小上下文；工具后读取实际文件／状态再声称成功；引用和费用由后端核验。

**验收／负面路径：** 恶意文稿不能调用任意shell或读取Key；失败工具不被模型总结成成功；输出和工具日志可追溯。

**v0.4增量要求：** 补充N07-09的Tool Registry字段和read/propose/commit权限分类；Agent不能自造确认授权。

**v0.4追加验收：** GUI和Agent对同操作得到等价结果和错误。

<a id="task-n07-05"></a>
### N07-05 三层决策笔记与采用绑定

**状态：** `TODO`　**依赖：** N06-05, N07-01。  
**需求：** V03-34, V03-35, V03-39。  
**版本：** v0.3保留。  
**代码落点：** 现有 `packages/domain/src/ai-edit.ts`、`director.ts`、`content-core.ts`、creator／channel与db／contracts；Brief／notes服务拟新增。

**实现内容：** 实现长期／项目／局部记录、suggested／confirmed、scope、版本／提案／utterance来源；接受事务写局部决定；长期升级需明确同意。

**验收／负面路径：** “这条活泼”不改长期风格；未采用方案不进确认笔记；用户可改／撤回；历史版本仍能解释。

<a id="task-n07-06"></a>
### N07-06 上下文编译与会话续作

**状态：** `TODO`　**依赖：** N07-05, N04-05。  
**需求：** V03-25, V03-28, V03-34, V03-55。  
**版本：** v0.3保留。  
**代码落点：** 现有 `packages/domain/src/ai-edit.ts`、`director.ts`、`content-core.ts`、creator／channel与db／contracts；Brief／notes服务拟新增。

**实现内容：** 按选区检索Brief、锁、源证据、已确认决定和候选差异；聊天摘要与工程状态分离，扩大影响范围时补足上下文。

**验收／负面路径：** 长会话截断后仍保留锁定与预算；隔天继续恢复正确对象／资产；无关私密素材不发给模型。

<a id="task-n07-07"></a>
### N07-07 笔记可见性、纠错和删除

**状态：** `TODO`　**依赖：** N07-05, N04-01。  
**需求：** V03-34, V03-52, V03-65。  
**版本：** v0.3保留。  
**代码落点：** 现有 `packages/domain/src/ai-edit.ts`、`director.ts`、`content-core.ts`、creator／channel与db／contracts；Brief／notes服务拟新增。

**实现内容：** 按需抽屉展示已确定／试验中／需判断；纠正笔记生成影响报告；删除记录及检索索引遵循数据政策。

**验收／负面路径：** 删除错误长期偏好后未来规划不再读取；旧冻结manifest所需审计与敏感内容最小化区分；不能有隐藏不可控记忆。

<a id="task-n07-08"></a>
### N07-08 导演与记忆综合回归

**状态：** `TODO`　**依赖：** N07-04, N07-06, N07-07, N06-09, N07-11, N07-12, N07-13。  
**需求：** V03-01, V03-28, V03-34, V03-59, V03-60, V04-18, V04-20。  
**版本：** v0.3保留；v0.4显式补充，旧证据不清零。  
**代码落点：** 现有 `packages/domain/src/ai-edit.ts`、`director.ts`、`content-core.ts`、creator／channel与db／contracts；Brief／notes服务拟新增。

**实现内容：** 建立多意图、多模式与跨会话评估集，检查误解、无关改动、提问数量、恢复与实际输出质量；模型升级跑同集。

**验收／负面路径：** 旧事实／锁／模式被遗忘即失败；分类报告不只一个总分；真实输出与人工判断可追溯。

**v0.4增量要求：** 综合回归加入持久Agent五工具实测和笔记晋升边界；补齐共享MediaIndex上下文后再完成完整G1。

**v0.4追加验收：** 一次plan/apply、文字入口或Mock语音不能冒充持续实时协作。

<a id="task-n07-09"></a>
### N07-09 Agent Tool Registry与可用能力投影

**状态：** `TODO`　**依赖：** N07-04, N01-11。  
**需求：** V04-17, V04-03。  
**版本：** v0.4新增。  
**代码落点：** 现有 `packages/domain/src/ai-edit.ts`及编辑服务；拟拆 `agent-core`逻辑模块、现有API／SDK／Web。

**实现内容：** 建立工具名/版本/input/output schema/targetKinds/readWriteSet/sideEffects/policy/estimate/cancel/resume/evidence/capabilities注册；只向Agent暴露当前可执行工具，GUI读取同能力源。

**验收／负面路径：** 未授权工具无法经模型参数绕过；插件重复注册冲突被拒绝；原生/别名/待实现区分；工具成功必须有实际返回状态与证据。

**增量来源：** 方案§1.1、§8。

<a id="task-n07-10"></a>
### N07-10 持久Conversation Session与有限Agent执行

**状态：** `TODO`　**依赖：** N07-09, N06-11, N04-09, N07-06。  
**需求：** V04-18, V04-17。  
**版本：** v0.4新增。  
**代码落点：** 现有 `packages/domain/src/ai-edit.ts`及编辑服务；拟拆 `agent-core`逻辑模块、现有API／SDK／Web。

**实现内容：** 持久化会话目标、当前分支、attention、actionId与工具执行状态；实施inspect→plan→preview→observe→clarify/accept的有限循环；轮次/token/费用上限和取消检查点明确。

**验收／负面路径：** 刷新能续到同一试改；重复发话不重复执行；工具失败不伪称完成；未采用不触发commit；无新增证据时停止反复试改并说明。

**增量来源：** 方案§8、T5—T6。

<a id="task-n07-11"></a>
### N07-11 五工具交互垂直切片实测

**状态：** `TODO`　**依赖：** N07-10, N03-02, N03-05, N03-07, N06-08, N04-11。  
**需求：** V04-18, V04-16, V03-59。  
**版本：** v0.4新增。  
**代码落点：** 现有 `packages/domain/src/ai-edit.ts`及编辑服务；拟拆 `agent-core`逻辑模块、现有API／SDK／Web。

**实现内容：** 只先闭合trim clip、move clip、split clip、transform、caption position；提供三段原素材＋字幕fixture，先文字后复用N05真实语音；局部回放、再调整、Reject、Accept与Undo全部贯通。

**验收／负面路径：** 指令“缩短这里停顿、字幕上移、其他别动”改对范围；连续两轮不丢前一次结果；Reject正式状态不变；真实语音另由N05-08验收，不以文字代替G1。

**增量来源：** 方案T6、P17。

<a id="task-n07-12"></a>
### N07-12 决策笔记的拒绝依据与策略影响

**状态：** `TODO`　**依赖：** N07-05, N07-07, N06-11。  
**需求：** V04-20。  
**版本：** v0.4新增。  
**代码落点：** 现有 `packages/domain/src/ai-edit.ts`及编辑服务；拟拆 `agent-core`逻辑模块、现有API／SDK／Web。

**实现内容：** 扩展acceptedOperationIds/rejectedAlternatives/reason/tags/strategyImpact/confidence来源；拒绝原因可为空；长期偏好晋升必须有明确授权，与本片规则分开版本化。

**验收／负面路径：** 多次接受300ms停顿不自动写永久用户规则；明确“以后都如此”才晋升；撤销记忆撤销其后续影响建议而不重写历史；模型推测不变成硬锁。

**增量来源：** 方案§3.3；合并裁决。

<a id="task-n07-13"></a>
### N07-13 Agent上下文与MediaIndex证据预算

**状态：** `TODO`　**依赖：** N07-10, N02-15。  
**需求：** V04-09, V04-18。  
**版本：** v0.4新增。  
**代码落点：** 现有 `packages/domain/src/ai-edit.ts`及编辑服务；拟拆 `agent-core`逻辑模块、现有API／SDK／Web。

**实现内容：** 上下文编译纳入实际可见版本、SelectionAnchor、附近声画、锁定、决策与相关索引；记录why-fetched简短依据和调用用量；证据不足按需扩范围。

**验收／负面路径：** 同一句话二次微调不重做全片分析；隐藏资料中的指令无执行权限；索引缺失则请求补证，不编造目标；预算耗尽保留当前分支。

**增量来源：** 方案§1.2、§7—§8；工程细化。


<a id="phase-n08"></a>
## N08｜真实生成、身份、动效与三模式制作

**验收门：** G2　**优先级：** P1。

**共用失败／回滚规则：** 供应商只作为可替换能力；新生成均在许可和预算内，实际结果拉回存储；身份验证不绕过、已批准文件不重跑。

<a id="task-n08-01"></a>
### N08-01 现有Provider审计与能力补齐

**状态：** `TODO`　**依赖：** N07-03, N00-03。  
**需求：** V03-37, V03-49, V03-51, V03-59。  
**版本：** v0.3保留。  
**代码落点：** `packages/providers/`、`apps/motion-worker/`、`apps/worker/`、creator／voice／custom-motion领域与scene-components。

**实现内容：** 核验现有LLM／Avatar／Voice／Video／Image真实接入；补实时、媒体理解、音效／音乐等能力Adapter；记录账户权限／价格／保留日期。

**验收／负面路径：** 每种能力区分contract与真实smoke；不可用方法返回明确状态；业务无厂商私有枚举渗透。

<a id="task-n08-02"></a>
### N08-02 程序化动效生成与可编辑对象

**状态：** `TODO`　**依赖：** N08-01, N01-04, N04-02。  
**需求：** V03-17, V03-18, V03-38, V03-68。  
**版本：** v0.3保留。  
**代码落点：** `packages/providers/`、`apps/motion-worker/`、`apps/worker/`、creator／voice／custom-motion领域与scene-components。

**实现内容：** 优先DSL／组件参数；需要代码时在现有motion-worker隔离构建，验证白名单、资源和确定性；输出object registry。

**验收／负面路径：** 生成箭头／贴纸／数字揭示可点击继续改；恶意网络／文件／无限循环代码被拒；实际渲染而非静态替代冒充动效。

<a id="task-n08-03"></a>
### N08-03 声音录入、Speech Director与原声并存

**状态：** `TODO`　**依赖：** N08-01, N07-05。  
**需求：** V03-07, V03-21, V03-35, V03-39。  
**版本：** v0.3保留。  
**代码落点：** `packages/providers/`、`apps/motion-worker/`、`apps/worker/`、creator／voice／custom-motion领域与scene-components。

**实现内容：** 复用VoiceIdentity／SpeechProfile，补合法录音、质量检测、验证状态、试听、发音词典与段级生成；原片音频和合成旁白并存。

**验收／负面路径：** 未授权声音拒绝克隆；跳过录入可剪原片；改一句仅重做相关音频／alignment；退役声音不破坏已缓存成片。

<a id="task-n08-04"></a>
### N08-04 可选数字人录入与镜头生成

**状态：** `TODO`　**依赖：** N08-01, N07-05。  
**需求：** V03-07, V03-36, V03-39。  
**版本：** v0.3保留。  
**代码落点：** `packages/providers/`、`apps/motion-worker/`、`apps/worker/`、creator／voice／custom-motion领域与scene-components。

**实现内容：** 按真实Provider能力提供托管／BYOK数字人创建或连接、consent、状态、身份快照与可追溯镜头；不强制每条视频有人物。

**验收／负面路径：** 无数字人项目可完成；验证中不显示可用；旧项目换默认身份后不重生成；原始训练文件按最小保留。

<a id="task-n08-05"></a>
### N08-05 图像／视频／音乐／音效局部制作

**状态：** `TODO`　**依赖：** N08-01, N06-04。  
**需求：** V03-04, V03-37, V03-39, V03-51。  
**版本：** v0.3保留。  
**代码落点：** `packages/providers/`、`apps/motion-worker/`、`apps/worker/`、creator／voice／custom-motion领域与scene-components。

**实现内容：** 计划器按语义请求图像、片段、音乐与音效；预算预检、任务幂等、输出持久化与质量检查，失败替代必须可见。

**验收／负面路径：** 改一个音效不重做画面；输出URL到期仍能播放；禁音乐／禁生成模式被遵守；收费重试不会无限循环。

<a id="task-n08-06"></a>
### N08-06 身份、产品和风格连续性

**状态：** `TODO`　**依赖：** N08-03, N08-04, N08-05。  
**需求：** V03-24, V03-39, V03-42。  
**版本：** v0.3保留。  
**代码落点：** `packages/providers/`、`apps/motion-worker/`、`apps/worker/`、creator／voice／custom-motion领域与scene-components。

**实现内容：** 保存人物／产品／环境reference、资产版本、构图／声音要求，生成时校验连续性；新增内容不伪造事实依据。

**验收／负面路径：** 相邻镜头身份错误被标review；已接受人物输出复用；图表缺数据时不生成假曲线。

<a id="task-n08-07"></a>
### N08-07 受控生成式局部修改

**状态：** `TODO`　**依赖：** N08-05, N04-06, N01-07。  
**需求：** V03-04, V03-19, V03-37, V03-42, V04-23, V04-24。  
**版本：** v0.3保留；v0.4显式补充，旧证据不清零。  
**代码落点：** `packages/providers/`、`apps/motion-worker/`、`apps/worker/`、creator／voice／custom-motion领域与scene-components。

**实现内容：** 像素区域编辑需源mask／时间范围、必保区与Provider能力；保留前版并给真实试片，对边界、邻帧与身份做检查。

**验收／负面路径：** 目标外改变触发失败／review；分割成功不等于编辑成功；禁generativeFill时明确不可调用。

**v0.4增量要求：** 局部编辑按N08-09—10的RegenerateRegion协议实现，逐类记录哪些真实能力可用。

**v0.4追加验收：** 新文件必须有受保护范围、原件与报价引用；超范围结果不自动绑定。

<a id="task-n08-08"></a>
### N08-08 三模式真实制作验收

**状态：** `TODO`　**依赖：** N08-02, N08-03, N08-04, N08-05, N08-06, N08-07, N06-09。  
**需求：** V03-03, V03-37, V03-39, V03-59。  
**版本：** v0.3保留。  
**代码落点：** `packages/providers/`、`apps/motion-worker/`、`apps/worker/`、creator／voice／custom-motion领域与scene-components。

**实现内容：** 分别完成真实素材、纯生成、混合项目的局部修改与资产复用；至少一条实际授权Provider链路，mock不作为代替。

**验收／负面路径：** 三个工程可用同一编辑器／版本协议；昂贵生成未跑的模式保持BLOCKED；账本与实际输出一一对应。

<a id="task-n08-09"></a>
### N08-09 RegenerateRegion时空契约与保护区域

**状态：** `TODO`　**依赖：** N08-07, N01-11。  
**需求：** V04-23, V04-24。  
**版本：** v0.4新增。  
**代码落点：** 拟增量扩展 `packages/contracts/src/`、`packages/domain/src/`、`packages/db/`、`packages/sdk/`；先复用同语义模块。

**实现内容：** 定义§14.7时空目标、preserveMask、源及序列映射、身份许可、能力与质量目标；regenerate_region只产生生成提案，replace_region采用已生成派生资产；拒绝模式越界。

**验收／负面路径：** 只剪素材策略下局部补帧/声音重建不能静默启用；mask时间绑定和反向/变速range合法；不存在目标或过期源版本返回错误。

**增量来源：** 方案§1.5、§6、P21。

<a id="task-n08-10"></a>
### N08-10 区域修复报价、异步资产与来源绑定

**状态：** `TODO`　**依赖：** N08-09, N13-10, N13-04。  
**需求：** V04-23, V04-24, V04-25。  
**版本：** v0.4新增。  
**代码落点：** 现有Provider／Jobs／账本／资产与提案服务。

**实现内容：** 将各修复能力路由到可用Provider并生成可接受报价；批准后建Job，结果回收、派生血缘、timeMapping和质量结果绑定到分支；不能直接覆盖clip原件。

**验收／负面路径：** 任务超时先查状态再重试；取消但供应商仍收费时事实可查；结果区域与报价不符不可自动采用；无真实账号保持BLOCKED。

**增量来源：** 方案§8、P21。


<a id="phase-n09"></a>
## N09｜全片审阅、冻结合成与交付QA

**验收门：** G1/G2　**优先级：** P0。

**共用失败／回滚规则：** 冻结后不重新创作；关键资产更换使审批失效；技术／模型／人工QA分开；不把文件生成成功当专业质量。

<a id="task-n09-01"></a>
### N09-01 全片预览与增量缓存依赖

**状态：** `TODO`　**依赖：** N03-10, N06-04。  
**需求：** V03-31, V03-39, V03-41。  
**版本：** v0.3保留。  
**代码落点：** 现有approval／versions／render相关领域、`packages/remotion-core/`、render-worker、web交付区。

**实现内容：** 由同一ProjectDocument拼接完整声画预览，按依赖缓存；所有未就绪资产显式显示；支持低成本草稿与真实审阅视图切换。

**验收／负面路径：** 只改局部不再请求所有资产；边界转场和音频crossfade正确；草稿占位在正式审阅视图不可隐藏。

<a id="task-n09-02"></a>
### N09-02 ReviewSession与批准失效

**状态：** `TODO`　**依赖：** N09-01, N06-07, N07-05。  
**需求：** V03-32, V03-40, V03-67。  
**版本：** v0.3保留。  
**代码落点：** 现有approval／versions／render相关领域、`packages/remotion-core/`、render-worker、web交付区。

**实现内容：** 审阅绑定工程revision、资产指纹与render profile，保留标记和明确批准；高清重生成／替换／内容改动失效相关批准。

**验收／负面路径：** 看过占位不能批准其后来生成的实片；观看覆盖不自动当同意；他人修改后旧批准不能冻结新状态。

<a id="task-n09-03"></a>
### N09-03 FrozenManifest与确定性正式合成

**状态：** `TODO`　**依赖：** N09-02, N01-08。  
**需求：** V03-40, V03-41, V03-55, V03-61。  
**版本：** v0.3保留。  
**代码落点：** 现有approval／versions／render相关领域、`packages/remotion-core/`、render-worker、web交付区。

**实现内容：** 在原子检查后冻结全部实际依赖、主题、组件／策略／字体引用与环境；正式render仅合成，不再导演重写／重新生成素材。

**验收／负面路径：** 同manifest重复渲染解码声画在容差内；缺资产／占位阻止正式输出；原模型下线不影响已缓存素材的合成。

<a id="task-n09-04"></a>
### N09-04 技术QA读真实输出

**状态：** `TODO`　**依赖：** N09-03。  
**需求：** V03-11, V03-21, V03-23, V03-42, V03-59。  
**版本：** v0.3保留。  
**代码落点：** 现有approval／versions／render相关领域、`packages/remotion-core/`、render-worker、web交付区。

**实现内容：** 解码实际文件，检查时长／帧率／音轨／响度／声道／黑帧异常／字幕与安全区；核对manifest、source、许可和锁。

**验收／负面路径：** 损坏MP4、意外静音、错帧率和字幕越界均被捕获；有意黑场不被误判为必错；QA报告绑定输出hash。

<a id="task-n09-05"></a>
### N09-05 声画／叙事模型QA与人工复核

**状态：** `TODO`　**依赖：** N09-04, N07-04。  
**需求：** V03-24, V03-42, V03-51, V03-60。  
**版本：** v0.3保留。  
**代码落点：** 现有approval／versions／render相关领域、`packages/remotion-core/`、render-worker、web交付区。

**实现内容：** 对关键片段读取连续声画和上下文，检查语义、可读性、节奏与一致性；设置预算／停止条件，结合人工校准。

**验收／负面路径：** 静态缩略图不能关闭音画同步项；QA失败不无限自修；模型高分不能覆盖确定性失败和用户否决。

<a id="task-n09-06"></a>
### N09-06 封面、字幕、母版包与多规格

**状态：** `TODO`　**依赖：** N09-03, N03-07。  
**需求：** V03-07, V03-17, V03-61。  
**版本：** v0.3保留。  
**代码落点：** 现有approval／versions／render相关领域、`packages/remotion-core/`、render-worker、web交付区。

**实现内容：** 输出成片、封面、SRT/VTT、标题／说明、来源／章节、manifest与授权可导资产；规格变更保留独立派生版本和审阅。

**验收／负面路径：** 封面沿用品牌且可修改；多比例不裁掉关键内容；私密／无权资产不随包导出；项目包能重新读取。

<a id="task-n09-07"></a>
### N09-07 合成中断恢复与结果验收状态

**状态：** `TODO`　**依赖：** N09-03, N09-04。  
**需求：** V03-33, V03-50, V03-51, V03-58。  
**版本：** v0.3保留。  
**代码落点：** 现有approval／versions／render相关领域、`packages/remotion-core/`、render-worker、web交付区。

**实现内容：** render-worker崩溃／任务重启从冻结依赖恢复；结果发布只在QA通过后更新；保留历史输出，不覆写正在审核版本。

**验收／负面路径：** 同一冻结任务重复提交幂等；失败不产生可交付假链接；晚到旧render不能顶替新成片。

<a id="task-n09-08"></a>
### N09-08 G1/G2完整发布门验证

**状态：** `TODO`　**依赖：** N09-05, N09-06, N09-07, N05-08, N07-08。  
**需求：** V03-01, V03-26, V03-40, V03-41, V03-42, V03-59, V04-14, V04-26。  
**版本：** v0.3保留；v0.4显式补充，旧证据不清零。  
**代码落点：** 现有approval／versions／render相关领域、`packages/remotion-core/`、render-worker、web交付区。

**实现内容：** G1跑纯素材真实语音共看片→多轮采用→全片审阅→正式输出；G2另需N08-08与N10-10通过，不把后者未完成提前算成功。

**验收／负面路径：** 交付真实视频、测试记录与费用／隐私边界；“已生成”的关键画面均在批准时存在；三模式门分别标状态。

**v0.4增量要求：** G1基础路径可先沿用通过N03-16的现有渲染；G2启用混合渲染的声明须再通过N09-11，不能将未来后端已规划写成已上线。

**v0.4追加验收：** 结果声明逐后端区分，未支持效果必须走明确回退或阻止交付。

<a id="task-n09-09"></a>
### N09-09 共享RenderPlan与混合后端分区

**状态：** `TODO`　**依赖：** N01-09, N03-11, N09-03。  
**需求：** V04-14。  
**版本：** v0.4新增。  
**代码落点：** 现有 `apps/render-worker/`、`packages/remotion-core/`、`packages/scene-components/`，拟新增共享RenderPlan契约。

**实现内容：** 从冻结ProjectDocument编译唯一可校验RenderPlan：timeline/source mapping、层序、音频、色彩、效果、资产hash；分区为media、graphics或受控pre-render子图，不生成第二套权威时间轴。

**验收／负面路径：** 同一输入planHash稳定；不支持效果明确阻塞/预渲染提案；变换不重复应用；旧Remotion金样可继续走旧受支持路由。

**增量来源：** 方案§13；工程细化。

<a id="task-n09-10"></a>
### N09-10 FFmpeg媒体图与Remotion图形合成后端

**状态：** `TODO`　**依赖：** N09-09, N09-04, N03-08。  
**需求：** V04-14。  
**版本：** v0.4新增。  
**代码落点：** 现有 `apps/render-worker/`、`packages/remotion-core/`、`packages/scene-components/`，拟新增共享RenderPlan契约。

**实现内容：** 为原视频裁剪、变速、拼接和音频构建受限参数化FFmpeg图；图表/动效由Remotion按共同时间和alpha输出，统一编码；缓存图形层并保留生成文件引用。

**验收／负面路径：** 真实素材+字幕图形+交叉淡化输出正确；透明边缘、色彩、字体、声道和时长匹配；不任意拼接shell；Final不得调用导演重写内容。

**增量来源：** 方案§1.4、§13。

<a id="task-n09-11"></a>
### N09-11 浏览器预览与混合终渲染逐能力对照

**状态：** `TODO`　**依赖：** N09-10, N03-16。  
**需求：** V04-14, V03-41。  
**版本：** v0.4新增。  
**代码落点：** 现有 `apps/render-worker/`、`packages/remotion-core/`、`packages/scene-components/`，拟新增共享RenderPlan契约。

**实现内容：** 同RenderPlan在baseline播放器/加速播放器（启用时）/终渲染逐帧与音频比较；记录支持矩阵、预览降级与真实审阅profile；不以整体截图代表运动同步。

**验收／负面路径：** 已通过效果全部满足预定义容差；不支持后端不静默跳效果；色彩/表情/重生成变化使相关批准失效；报告不无依据宣称bit-exact。

**增量来源：** 方案§13、最终验收；工程细化。


<a id="phase-n10"></a>
## N10｜视频类型与导演策略生成器

**验收门：** G2　**优先级：** P1。

**共用失败／回滚规则：** 参考是数据不是指令；下载／分析权限分开；观测未知保留unknown；包未验证不向普通用户推荐。

<a id="task-n10-01"></a>
### N10-01 类型策略与时间约束契约

**状态：** `TODO`　**依赖：** N07-03, N01-01。  
**需求：** V03-43, V03-46, V03-68。  
**版本：** v0.3保留。  
**代码落点：** 现有domain／providers／extensions／contracts、API／SDK、web按需风格入口；reference／strategy模块拟新增。

**实现内容：** 定义类型、段级角色、全片风格和旁白／对话／节拍／动作／混合时序约束；允许一片多类型，覆盖参考与用户偏好优先级。

**验收／负面路径：** 音乐片无需Master Narration；访谈保留对话；片级统一与段级例外正确；约束冲突可解释。

<a id="task-n10-02"></a>
### N10-02 参考链接／文件获取与授权分级

**状态：** `TODO`　**依赖：** N02-07, N00-06。  
**需求：** V03-44, V03-53, V03-54。  
**版本：** v0.3保留。  
**代码落点：** 现有domain／providers／extensions／contracts、API／SDK、web按需风格入口；reference／strategy模块拟新增。

**实现内容：** 实现ReferenceSource Resolver、支持源白名单、授权与可用性等级、下载限额和SSRF保护；只取元数据时不能进入精细分析。

**验收／负面路径：** 公开URL不自动等于下载许可；私网／重定向攻击阻断；链接不支持时返回上传路径而非伪分析结果。

<a id="task-n10-03"></a>
### N10-03 多模态参考分析与证据覆盖

**状态：** `TODO`　**依赖：** N10-02, N02-04, N02-05。  
**需求：** V03-13, V03-45。  
**版本：** v0.3保留。  
**代码落点：** 现有domain／providers／extensions／contracts、API／SDK、web按需风格入口；reference／strategy模块拟新增。

**实现内容：** 统一镜头、字幕、语音、音乐、关键帧、布局／运动测量；全片粗读后对重要区间加密；记录工具、覆盖与误差。

**验收／负面路径：** 快切／文字动画在低采样遗漏时标不足并补分析；看不清字体／音效来源保持unknown；证据可跳转回放。

<a id="task-n10-04"></a>
### N10-04 剪辑节奏与声画事件对齐

**状态：** `TODO`　**依赖：** N10-03, N01-01。  
**需求：** V03-43, V03-45。  
**版本：** v0.3保留。  
**代码落点：** 现有domain／providers／extensions／contracts、API／SDK、web按需风格入口；reference／strategy模块拟新增。

**实现内容：** 提取镜头长度分布、语义切点、阅读间隔、运动曲线、音效和音乐节拍；区分绝对源时间与事件关系。

**验收／负面路径：** 刻意错一处字幕／节拍的fixture被发现；采样不确定不生成伪精确小数；文本内容仅作为分析数据。

<a id="task-n10-05"></a>
### N10-05 可编辑ReferenceBlueprint

**状态：** `TODO`　**依赖：** N10-04, N01-04。  
**需求：** V03-45, V03-47。  
**版本：** v0.3保留。  
**代码落点：** 现有domain／providers／extensions／contracts、API／SDK、web按需风格入口；reference／strategy模块拟新增。

**实现内容：** 将参考分析编译成带源证据、观测／推测标签、场景与对象结构的蓝图；未知内部图层不伪造为真实工程。

**验收／负面路径：** 蓝图能回放对应参考范围并局部更正；修正重建节点不改原片；明确“等效重建”不是原工程恢复。

<a id="task-n10-06"></a>
### N10-06 可迁移DirectorStrategyPackage

**状态：** `TODO`　**依赖：** N10-05, N10-01。  
**需求：** V03-43, V03-46, V03-49。  
**版本：** v0.3保留。  
**代码落点：** 现有domain／providers／extensions／contracts、API／SDK、web按需风格入口；reference／strategy模块拟新增。

**实现内容：** 提取语义触发、条件、参数schema、能力需求、生成选择、失败替代和适用／禁用条件；不写死供应商与原片文字。

**验收／负面路径：** 换内容后不沿用绝对第8秒逻辑；缺必需输入返回NOT_APPLICABLE；规则schema非法无法发布。

<a id="task-n10-07"></a>
### N10-07 策略编译、覆盖与项目例外

**状态：** `TODO`　**依赖：** N10-06, N07-03, N06-02。  
**需求：** V03-04, V03-32, V03-46, V03-48。  
**版本：** v0.3保留。  
**代码落点：** 现有domain／providers／extensions／contracts、API／SDK、web按需风格入口；reference／strategy模块拟新增。

**实现内容：** 将策略＋新素材／Brief编译为提案；用户约束、身份、模式、锁优先；切换策略显示影响、保存版本快照。

**验收／负面路径：** 新策略不能重做锁定开头；禁音乐被遵守；升级包不改变冻结历史；不同段能应用不同规则。

<a id="task-n10-08"></a>
### N10-08 等效重建与跨内容评估

**状态：** `TODO`　**依赖：** N10-07, N09-04。  
**需求：** V03-45, V03-47, V03-59, V03-60。  
**版本：** v0.3保留。  
**代码落点：** 现有domain／providers／extensions／contracts、API／SDK、web按需风格入口；reference／strategy模块拟新增。

**实现内容：** 授权范围内评估参考重建；另用至少三份结构／时长不同的新内容迁移，分别测相似度、表达、可改性与费用。

**验收／负面路径：** 高度相似但内容看不懂不能过迁移门；单条高播放量不产出因果“爆款规律”；可回放误差位置。

<a id="task-n10-09"></a>
### N10-09 策略库、管理后台与极简选择

**状态：** `TODO`　**依赖：** N10-08, N04-01。  
**需求：** V03-06, V03-48, V03-53, V03-64。  
**版本：** v0.3保留。  
**代码落点：** 现有domain／providers／extensions／contracts、API／SDK、web按需风格入口；reference／strategy模块拟新增。

**实现内容：** 管理端完成导入、证据核对、试片、参数修订、私有／共享发布、回滚／下架；用户端默认一个推荐与少量短样版。

**验收／负面路径：** 未验证策略不进生产推荐；私有策略不跨租户泄露；用户不用浏览庞大商城才能创作。

<a id="task-n10-10"></a>
### N10-10 参考到新片再局部修改闭环

**状态：** `TODO`　**依赖：** N10-09, N06-09, N09-06, N10-13。  
**需求：** V03-43, V03-44, V03-45, V03-46, V03-47, V03-48, V03-59, V04-21, V04-22。  
**版本：** v0.3保留；v0.4显式补充，旧证据不清零。  
**代码落点：** 现有domain／providers／extensions／contracts、API／SDK、web按需风格入口；reference／strategy模块拟新增。

**实现内容：** 用户提供合法参考→生成策略→迁移新素材→点击“这里不像”→定位规则／对象→局部试改确认→正式成片。

**验收／负面路径：** 能解释改了哪条规则，不整片抽奖；保留用户声音与禁用字幕样式；真实试片与许可证据齐全。

**v0.4增量要求：** 加入N10-13共用MediaIndex、Editing DNA/Recipe迁移测试。

**v0.4追加验收：** 来源每个显式语法字段有映射，策略不是仅有自由文本。

<a id="task-n10-11"></a>
### N10-11 Editing DNA显式语法与统计字段

**状态：** `TODO`　**依赖：** N10-06, N02-15。  
**需求：** V04-21。  
**版本：** v0.4新增。  
**代码落点：** 拟增量扩展 `packages/contracts/src/`、`packages/domain/src/`、`packages/db/`、`packages/sdk/`；先复用同语义模块。

**实现内容：** 在DirectorStrategyPackage内增设EditingDNA投影，覆盖hook/chapter、shot分布、pace曲线、talkingHeadRatio、B-roll、caption/motion/transition/music/sfx/color/chart/CTA/exception等；每字段来源、单位、证据区间和unknown定义。

**验收／负面路径：** 全部来源字段有规范位置；帧样本不足不填精确参数；平均镜头长度不被编译成固定切镜间隔；不同内容可调节且可追溯。

**增量来源：** 方案§3.4、§11。

<a id="task-n10-12"></a>
### N10-12 Workflow Recipe条件追问与可执行步骤

**状态：** `TODO`　**依赖：** N10-11, N10-07, N07-09。  
**需求：** V04-22, V04-17。  
**版本：** v0.4新增。  
**代码落点：** 拟增量扩展 `packages/contracts/src/`、`packages/domain/src/`、`packages/db/`、`packages/sdk/`；先复用同语义模块。

**实现内容：** 定义inputs/questions/steps/layoutTokens/outputConstraints/stopConditions；条件追问只问缺失关键项，步骤编译为注册工具和提案；providerPreferences软约束与权限分离。

**验收／负面路径：** 未知工具拒绝上架；用户已有声音/规格不重复询问；缺前提返回明确NEEDS_INPUT；预算/纯素材规则不被recipe覆盖。

**增量来源：** 方案§1.3、§11。

<a id="task-n10-13"></a>
### N10-13 参考与素材共用索引的策略闭环

**状态：** `TODO`　**依赖：** N10-12, N10-03, N10-08。  
**需求：** V04-09, V04-21, V04-22。  
**版本：** v0.4新增。  
**代码落点：** 现有参考分析／策略后台、MediaIndex、Agent与评估fixtures。

**实现内容：** 一支授权参考片复用MediaIndex提取蓝图与DNA/recipe，在三份内容迁移后保存策略版本；局部反馈改规则时先影响报告，已冻结版本不升级。

**验收／负面路径：** 至少三份不同长度/内容测试，分别报告参考特征和清晰度；未取得原媒体不得假报全片分析；二次分析缓存复用；规则变化可撤销。

**增量来源：** 方案§3.4、P19。


<a id="phase-n11"></a>
## N11｜专业制作能力第一批

**验收门：** G3　**优先级：** P1。

**共用失败／回滚规则：** 专业能力逐项实测；不把生成式修复混为传统确定性处理；未支持后端先阻止执行，不能丢效果静默导出。

<a id="task-n11-01"></a>
### N11-01 高级关键帧、路径与嵌套动画

**状态：** `TODO`　**依赖：** N03-05, N06-02。  
**需求：** V03-15, V03-18。  
**版本：** v0.3保留。  
**代码落点：** 统一ProjectDocument／操作注册表、现有渲染与Provider后端、按需专业UI；新效果模块按能力拆分。

**实现内容：** 实现贝塞尔、缓动、曲线、空间路径、关键帧复制与嵌套局部时间；暴露AI可操作参数和按需图形编辑。

**验收／负面路径：** 嵌套缩放时间后父子动画一致；曲线编辑可撤销；浏览器与输出曲线采样对照通过。

<a id="task-n11-02"></a>
### N11-02 完整时间重映射与速度曲线

**状态：** `TODO`　**依赖：** N03-03, N01-01。  
**需求：** V03-11, V03-16, V03-21。  
**版本：** v0.3保留。  
**代码落点：** 统一ProjectDocument／操作注册表、现有渲染与Provider后端、按需专业UI；新效果模块按能力拆分。

**实现内容：** 支持曲线变速、反向、定格、rate stretch、音调策略和可选插帧；明确原素材handles与生成许可。

**验收／负面路径：** 曲线端点／反向／定格无越界；音频同步正确；禁止插帧模式不调用补帧；长段变速无累计漂移。

<a id="task-n11-03"></a>
### N11-03 路径蒙版、分割、跟踪与校正

**状态：** `TODO`　**依赖：** N04-06, N01-04。  
**需求：** V03-19, V03-38。  
**版本：** v0.3保留。  
**代码落点：** 统一ProjectDocument／操作注册表、现有渲染与Provider后端、按需专业UI；新效果模块按能力拆分。

**实现内容：** 实现形状／手绘／羽化／反向／组合蒙版，接入受控分割与跨帧跟踪，支持遮挡后人工校正及版本化。

**验收／负面路径：** 标签／模糊层跟踪目标，不影响其他对象；遮挡失败可见；蒙版源时间随剪辑映射正确。

<a id="task-n11-04"></a>
### N11-04 生成式修复与对象编辑质量门

**状态：** `TODO`　**依赖：** N08-07, N11-03, N09-05。  
**需求：** V03-04, V03-19, V03-24, V03-39, V03-42。  
**版本：** v0.3保留。  
**代码落点：** 统一ProjectDocument／操作注册表、现有渲染与Provider后端、按需专业UI；新效果模块按能力拆分。

**实现内容：** 对修复／抠除／补全提供前后对比和区域外保真、时域一致性检查；事实素材需记录修复性质和授权。

**验收／负面路径：** 脸／产品／字幕被误改即拒收或review；高质量承诺以实际连续帧为证；纯剪辑策略可完全禁用。

<a id="task-n11-05"></a>
### N11-05 多机位同步与漂移模型

**状态：** `TODO`　**依赖：** N03-04, N02-05, N01-01。  
**需求：** V03-11, V03-15, V03-22。  
**版本：** v0.3保留。  
**代码落点：** 统一ProjectDocument／操作注册表、现有渲染与Provider后端、按需专业UI；新效果模块按能力拆分。

**实现内容：** 时间码、音频或人工同步多源；保存offset／drift和置信度，主音轨独立锁定；支持重同步而不破坏已有切点。

**验收／负面路径：** 不同设备录音起点和漂移正确校正；低置信度不强行同步；所有角度源引用可回链。

<a id="task-n11-06"></a>
### N11-06 多机位导演与切角操作

**状态：** `TODO`　**依赖：** N11-05, N10-01, N06-02。  
**需求：** V03-22, V03-28, V03-43。  
**版本：** v0.3保留。  
**代码落点：** 统一ProjectDocument／操作注册表、现有渲染与Provider后端、按需专业UI；新效果模块按能力拆分。

**实现内容：** 按轮次、目光、动作与表达目标建议切角；保留人工快捷切换和切点roll；音频跟随策略明确，不总是随画面切。

**验收／负面路径：** “提问广角回答正面”实际切角；主音轨无跳变；局部换机位不改全片对话节奏。

<a id="task-n11-07"></a>
### N11-07 色彩管理、调色与HDR

**状态：** `TODO`　**依赖：** N02-02, N03-05, N09-03。  
**需求：** V03-20, V03-41, V03-57。  
**版本：** v0.3保留。  
**代码落点：** 统一ProjectDocument／操作注册表、现有渲染与Provider后端、按需专业UI；新效果模块按能力拆分。

**实现内容：** 实现工作／输入／输出色彩空间、LUT／曲线／HSL／白平衡／曝光、镜头匹配、示波器与HDR元数据；不只CSS滤镜。

**验收／负面路径：** 标准色彩样例和跨镜头肤色对照；预览／导出色彩路径一致；不支持HDR显示时告知限制而非误判素材。

<a id="task-n11-08"></a>
### N11-08 专业音频处理与交付

**状态：** `TODO`　**依赖：** N03-06, N01-04, N09-04。  
**需求：** V03-21, V03-35, V03-61。  
**版本：** v0.3保留。  
**代码落点：** 统一ProjectDocument／操作注册表、现有渲染与Provider后端、按需专业UI；新效果模块按能力拆分。

**实现内容：** 增加EQ、压缩、限制、降噪／修复、音量自动化、总线、声像／声道、响度真峰值、分轨输出；处理器版本化。

**验收／负面路径：** 输出检测符合选择的交付profile；取消降噪能恢复；禁止改写原音时不合成新词；分轨和混合长度一致。

<a id="task-n11-09"></a>
### N11-09 专业字幕与跨画幅版式

**状态：** `TODO`　**依赖：** N03-07, N11-01, N09-06。  
**需求：** V03-17, V03-18, V03-23, V03-61, V03-65。  
**版本：** v0.3保留。  
**代码落点：** 统一ProjectDocument／操作注册表、现有渲染与Provider后端、按需专业UI；新效果模块按能力拆分。

**实现内容：** 多语言／双语、中文断行、词级强调、富文本、字体fallback、安全区、滚动字幕与响应式重排；人工局部修正可保留。

**验收／负面路径：** 竖横版不挡脸或裁掉关键数字；fallback可见且可审阅；缺字／溢出QA捕获；SRT/VTT与画面同步。

<a id="task-n11-10"></a>
### N11-10 局部语音替换与原始内容差异审阅

**状态：** `TODO`　**依赖：** N08-10, N08-03, N02-05。  
**需求：** V04-23, V04-24。  
**版本：** v0.4新增。  
**代码落点：** 现有Voice／Speech Director／ASR／alignment与提案服务。

**实现内容：** 对明确选中的话语生成授权声音片段，保留替换文本、原音、来源和对齐；句边保留自然呼吸与声场，更新相关字幕/时序；语义改变突出差异。

**验收／负面路径：** 一句替换不重生成整条旁白；原话禁止改写时服务端拦截；新音越界/声线不一致进入待审；原音可恢复，真实声音测试有授权。

**增量来源：** 方案§1.5、P21。

<a id="task-n11-11"></a>
### N11-11 局部唇形与跳切桥接的连续性修复

**状态：** `TODO`　**依赖：** N11-10, N08-10, N11-03。  
**需求：** V04-23, V04-24。  
**版本：** v0.4新增。  
**代码落点：** 现有Video／Avatar Provider、TrackedRegion与局部预览／QA。

**实现内容：** 分别实现lip-sync修复与jump-cut bridge；明确桥接帧为生成内容，保护人物身份、背景与前后动作；优先最小可用上下文，不更改未批准发言。

**验收／负面路径：** 唇形使用批准音频；接缝/遮挡/身份漂移可检测并退回；bridge不会凭空制造未授权事实动作；失败保留原跳切，可对照恢复。

**增量来源：** 方案§1.5、P21。

<a id="task-n11-12"></a>
### N11-12 画面局部修复、延长、补帧与替换

**状态：** `TODO`　**依赖：** N08-10, N11-03, N11-02。  
**需求：** V04-23, V04-24。  
**版本：** v0.4新增。  
**代码落点：** 现有视频／图像Provider、mask／tracking、时间映射与QA。

**实现内容：** 按不同capability完成背景修复、对象移除、镜头延长、插帧、区域替换及B-roll插入联动；记录目标帧范围、保护区域、派生源映射与未知外推内容。

**验收／负面路径：** 延长不得假读源out以外帧；补帧明确政策与成本；移除仅对授权mask；B-roll是插入新clip不是破坏原件；未支持功能不伪装成功。

**增量来源：** 方案§1.5、P21。

<a id="task-n11-13"></a>
### N11-13 九类生成修复质量与不干扰总门

**状态：** `TODO`　**依赖：** N11-10, N11-11, N11-12, N11-04, N09-11。  
**需求：** V04-23, V04-24, V03-42。  
**版本：** v0.4新增。  
**代码落点：** 现有testing／QA／浏览器E2E及真实Provider smoke。

**实现内容：** 建立九类修复的输入输出、mask、边界帧、相邻音频、身份和语义对照；无变化部分比较解码内容容差，而非压缩文件字节；定义每类accept/needs-review/fail。

**验收／负面路径：** 所有类目各有正向与失败证据；未经授权的语义改变零容忍；Reject正式作品不变；Provider不具备能力时该类保持BLOCKED，不能让总门通过。

**增量来源：** 方案P21、最终验收；工程细化。


<a id="phase-n12"></a>
## N12｜专业扩展、交换与竞品能力闭合

**验收门：** G3　**优先级：** P1/P2。

**共用失败／回滚规则：** 工程交换不承诺任意私有格式无损；所有不支持元素出损失报告，保留原始导入文件；外部绕行不计原生交付。

<a id="task-n12-01"></a>
### N12-01 稳定、追踪运动与重构画幅

**状态：** `TODO`　**依赖：** N11-03, N03-05。  
**需求：** V03-17, V03-19, V03-41。  
**版本：** v0.3保留。  
**代码落点：** 媒体／效果能力目录、Provider/RenderAdapter、ProjectDocument、extensions、按需专业工具；保持现有renderer可复用。

**实现内容：** 实现防抖、运动平滑、追踪图形与目标构图；保存变换与裁切代价，支持原始／处理对比及锁定主体。

**验收／负面路径：** 防抖不偷偷裁掉必保主体；追踪错误可局部修正；竖屏重构关键动作完整且可回放。

<a id="task-n12-02"></a>
### N12-02 绿幕、混合模式、调整层与复杂合成

**状态：** `TODO`　**依赖：** N11-03, N11-07, N11-01。  
**需求：** V03-15, V03-17, V03-19, V03-20, V03-38。  
**版本：** v0.3保留。  
**代码落点：** 媒体／效果能力目录、Provider/RenderAdapter、ProjectDocument、extensions、按需专业工具；保持现有renderer可复用。

**实现内容：** 扩展多层混合、keying、调整层、透明度、遮罩复用和效果栈顺序；每种效果声明preview/render后端支持。

**验收／负面路径：** 调层不影响锁定排除区；透明边缘与预乘语义正确；缺效果能力阻止静默扁平替代。

<a id="task-n12-03"></a>
### N12-03 工程交换与损失可见性

**状态：** `TODO`　**依赖：** N01-03, N01-08, N09-06。  
**需求：** V03-55, V03-56, V03-57, V03-61。  
**版本：** v0.3保留。  
**代码落点：** 媒体／效果能力目录、Provider/RenderAdapter、ProjectDocument、extensions、按需专业工具；保持现有renderer可复用。

**实现内容：** 以OTIO等开放表示先实现可验证子集，再按合法适配支持EDL／XML／AAF等；记录支持矩阵、未映射效果、round-trip范围。

**验收／负面路径：** 导出再导入Clip源范围／轨道／时码一致；不支持效果显式列出；不声称完整读取PR／剪映私有工程格式。

<a id="task-n12-04"></a>
### N12-04 专业容器、编码、图像序列与母版

**状态：** `TODO`　**依赖：** N02-02, N11-07, N11-08, N09-06。  
**需求：** V03-11, V03-20, V03-21, V03-57, V03-61。  
**版本：** v0.3保留。  
**代码落点：** 媒体／效果能力目录、Provider/RenderAdapter、ProjectDocument、extensions、按需专业工具；保持现有renderer可复用。

**实现内容：** 根据实际部署解码器／编码器及许可补中间码、透明通道、高位深、图像序列、多声道、专业容器和受支持RAW路径。

**验收／负面路径：** 每个格式都有真实输入／输出／往返证据；缺编解码能力或许可返回明确限制；不把能上传当完整支持。

<a id="task-n12-05"></a>
### N12-05 特殊制作与空间媒体能力

**状态：** `TODO`　**依赖：** N12-04, N12-02。  
**需求：** V03-15, V03-20, V03-21, V03-57, V03-60。  
**版本：** v0.3保留。  
**代码落点：** 媒体／效果能力目录、Provider/RenderAdapter、ProjectDocument、extensions、按需专业工具；保持现有renderer可复用。

**实现内容：** 将360／立体／空间投影、空间音频、特殊合成与外设工作流列成独立能力子账本；按目标格式逐项实现而非统称“以后支持”。

**验收／负面路径：** 投影／左右眼／空间声道元数据往返正确；不支持项目类型保留原件与缺口；未验证能力不会标生产支持。

<a id="task-n12-06"></a>
### N12-06 多渲染后端与逐能力一致性

**状态：** `TODO`　**依赖：** N12-02, N11-02, N09-03。  
**需求：** V03-41, V03-49, V03-55, V03-57。  
**版本：** v0.3保留。  
**代码落点：** 媒体／效果能力目录、Provider/RenderAdapter、ProjectDocument、extensions、按需专业工具；保持现有renderer可复用。

**实现内容：** 通过RenderAdapter按能力决定现有Remotion、FFmpeg或新增本地／专用渲染后端；统一工程语义与conformance suite。

**验收／负面路径：** 同一已支持操作跨预览／正式后端一致；路由不降级丢效果；不得为不同后端复制另一套项目权威。

<a id="task-n12-07"></a>
### N12-07 效果插件、模板兼容与高级可控入口

**状态：** `TODO`　**依赖：** N12-06, N08-02, N04-07。  
**需求：** V03-18, V03-38, V03-57, V03-65, V03-68。  
**版本：** v0.3保留。  
**代码落点：** 媒体／效果能力目录、Provider/RenderAdapter、ProjectDocument、extensions、按需专业工具；保持现有renderer可复用。

**实现内容：** 扩展版本化效果／模板能力、参数schema、运行权限和沙箱；外部专有插件用明确兼容清单，支持直接调参与AI调用。

**验收／负面路径：** 未签名／超权限组件拒绝；用户可修正AI参数；外部round-trip标清不计原生；插件升级不改变冻结工程。

<a id="task-n12-08"></a>
### N12-08 专业对照与完整差项验收

**状态：** `TODO`　**依赖：** N11-09, N11-06, N12-01, N12-03, N12-04, N12-05, N12-07, N11-13, N13-11。  
**需求：** V03-01, V03-42, V03-59, V03-60, V04-11, V04-13, V04-23, V04-24。  
**版本：** v0.3保留；v0.4显式补充，旧证据不清零。  
**代码落点：** 媒体／效果能力目录、Provider/RenderAdapter、ProjectDocument、extensions、按需专业工具；保持现有renderer可复用。

**实现内容：** 更新按版本／平台的竞品清单，跑同素材Brief下质量盲评、人工时间、误改、成本和格式互通；差项继续编号而非删除。

**验收／负面路径：** 每一声称支持的能力有真实任务与输出；“效果更好”有证据范围；未达到的场景明确LIMITED／TODO。

**v0.4增量要求：** 专业覆盖总门加入GPU加速资源回归与九类修复矩阵；不使用来源方案声称的竞品能力充当本项目测试。

**v0.4追加验收：** N03-14/15、N13-11及N11-13证据齐备；未知Provider能力不计已完成。


<a id="phase-n13"></a>
## N13｜安全、费用、可靠性与商业生产门

**验收门：** 贯穿G0–G4　**优先级：** P0。

**共用失败／回滚规则：** 本阶段从N00起嵌入，不在末尾补安全；真实收费和身份操作需有效授权；备份、恢复和生产环境必须实测。

<a id="task-n13-01"></a>
### N13-01 新实体租户与授权回归

**状态：** `TODO`　**依赖：** N01-03, N00-06。  
**需求：** V03-53, V03-55, V03-67, V04-27, V04-29。  
**版本：** v0.3保留；v0.4显式补充，旧证据不清零。  
**代码落点：** 现有auth／usage／credits／billing／jobs／assets／credentials／admin、infra／CI与所有新增实体。

**实现内容：** 将Clip／Object／Proposal／Session／Strategy与原角色系统关联；补跨表ID、签名URL和权限降级测试。

**验收／负面路径：** 用户A不能读写B的对象、试片、策略与任务；撤销成员后活动会话不能继续采用；管理员入口分离。

**v0.4增量要求：** 平台Ops与Workspace权限域、字段/检索/缓存/导出/内容支持访问也纳入实体授权。

**v0.4追加验收：** N15权限矩阵负例不因拥有平台角色被跳过。

<a id="task-n13-02"></a>
### N13-02 提示注入、URL、媒体与生成代码防护

**状态：** `TODO`　**依赖：** N02-02, N04-05。  
**需求：** V03-38, V03-44, V03-53, V03-54。  
**版本：** v0.3保留。  
**代码落点：** 现有auth／usage／credits／billing／jobs／assets／credentials／admin、infra／CI与所有新增实体。

**实现内容：** 对源文本／转写／参考片／SVG／策略包构建信任层与攻击测试；URL含回调防SSRF，解码与代码隔离。

**验收／负面路径：** 恶意字幕不能发布或删库；私网fetch、超大媒体、沙箱出网失败；新增工具无法绕过源授权。

<a id="task-n13-03"></a>
### N13-03 完整用量与预算预留账本

**状态：** `TODO`　**依赖：** N01-09, N00-03。  
**需求：** V03-04, V03-49, V03-51, V03-64。  
**版本：** v0.3保留。  
**代码落点：** 现有auth／usage／credits／billing／jobs／assets／credentials／admin、infra／CI与所有新增实体。

**实现内容：** 审阅既有usage/credits，补规划LLM、语音、ASR、分析、试片、转码、重试费用；estimate/reserve/reconcile/refund幂等化。

**验收／负面路径：** 并发提案不超总预算；未知Provider账单保留pending非0；重复回调不双扣；BYOK与平台费用分开。

<a id="task-n13-04"></a>
### N13-04 任务公平、恢复与取消一致性

**状态：** `TODO`　**依赖：** N01-09, N13-03。  
**需求：** V03-27, V03-33, V03-50, V03-58。  
**版本：** v0.3保留。  
**代码落点：** 现有auth／usage／credits／billing／jobs／assets／credentials／admin、infra／CI与所有新增实体。

**实现内容：** 按租户／Provider账户限流与优先级，加入lease／heartbeat、崩溃恢复、回调验签、有限重试、supersede和退款边界。

**验收／负面路径：** Worker崩溃后只恢复一次副作用；不同用户不被单大单长期饿死；取消不可用诚实反馈；结果版本不倒退。

<a id="task-n13-05"></a>
### N13-05 配额、引用式回收与灾备恢复

**状态：** `TODO`　**依赖：** N02-07, N01-08。  
**需求：** V03-10, V03-12, V03-52, V03-58, V04-40, V04-48。  
**版本：** v0.3保留；v0.4显式补充，旧证据不清零。  
**代码落点：** 现有auth／usage／credits／billing／jobs／assets／credentials／admin、infra／CI与所有新增实体。

**实现内容：** 按实际引用关系保护原件／接受资产／冻结依赖；实现删除生命周期与备份保留分离；做DB+对象存储恢复演练。

**验收／负面路径：** 缓存到期不删除成片依赖；故障恢复能读相同冻结版本；删除请求及Provider请求有状态和失败记录。

**v0.4增量要求：** 衔接N15-24/25的资产运营与隐私删除；恢复演练重放删除标记。

**v0.4追加验收：** 不能用保留冻结依赖为由无限保留用户有效请求删除的私密内容。

<a id="task-n13-06"></a>
### N13-06 CI、浏览器E2E与部署回滚

**状态：** `TODO`　**依赖：** N00-06, N01-05, N03-10。  
**需求：** V03-56, V03-58, V03-59, V04-48, V04-51。  
**版本：** v0.3保留；v0.4显式补充，旧证据不清零。  
**代码落点：** 现有auth／usage／credits／billing／jobs／assets／credentials／admin、infra／CI与所有新增实体。

**实现内容：** 将真实contract与浏览器E2E纳入实际验证；区分普通CI、媒体渲染、付费smoke；部署支持新旧schema兼容和开关回滚。

**验收／负面路径：** 故意破坏新剪辑旅程会红；PLANNED不算通过；迁移失败阻止发布；已有Packs／CMS等旧路径未被删测逃避。

**v0.4增量要求：** 衔接N15运营路由权限、审批/财务重放/诊断流程测试；生产恢复入口不得跳过领域门。

**v0.4追加验收：** 文档或UI全绿不代替O0/O1实际业务证据。

<a id="task-n13-07"></a>
### N13-07 隐私、身份、服务嵌入与授权上线审查

**状态：** `TODO`　**依赖：** N02-07, N08-01。  
**需求：** V03-35, V03-36, V03-44, V03-49, V03-52, V03-54, V03-64。  
**版本：** v0.3保留。  
**代码落点：** 现有auth／usage／credits／billing／jobs／assets／credentials／admin、infra／CI与所有新增实体。

**实现内容：** 按实际目标市场核对Provider嵌入／转售、素材／字体／编解码授权、身份consent、训练／保留／删除差异和AIGC披露；不在文档硬编码政策结论。

**验收／负面路径：** 每个启用Provider有当前验证记录；未知保留政策不标ZDR；身份删除、用户数据导出和滥用处理有可测试流程。

<a id="task-n13-08"></a>
### N13-08 观测、性能与故障用户体验

**状态：** `TODO`　**依赖：** N04-05, N06-01, N13-03, N13-04。  
**需求：** V03-06, V03-25, V03-50, V03-51, V03-58。  
**版本：** v0.3保留。  
**代码落点：** 现有auth／usage／credits／billing／jobs／assets／credentials／admin、infra／CI与所有新增实体。

**实现内容：** 贯穿trace记录意图→选区→提案→资产→审批→导出，测本地反馈／云延迟／掉帧／费用；错误UI保留可用作品与可执行下一步。

**验收／负面路径：** 参考环境p50/p95真实记录；不得重试刷成本；日志不泄露素材全文／Key；用户能区分未保存、冲突和未完成。

<a id="task-n13-09"></a>
### N13-09 SaaS计费、后台与生产总门

**状态：** `TODO`　**依赖：** N13-01, N13-02, N13-03, N13-04, N13-05, N13-06, N13-07, N13-08, N09-08, N13-10, N13-12, N15-38。  
**需求：** V03-49, V03-51, V03-52, V03-53, V03-58, V03-59, V03-64, V03-67, V04-25, V04-26, V04-50, V04-51。  
**版本：** v0.3保留；v0.4显式补充，旧证据不清零。  
**代码落点：** 现有auth／usage／credits／billing／jobs／assets／credentials／admin、infra／CI与所有新增实体。

**实现内容：** 保留现有Billing／Admin／团队并补提案、策略、身份和成本管理；正式收费前跑真实部署、支付／退账、滥用、备份和人工交付验收。

**验收／负面路径：** 付款webhook幂等，取消订阅与资产保留策略清楚；没有真实线上测试不宣称商业上线；G1/G2各门独立证据可查。

**v0.4增量要求：** 新付费操作必须通过透明报价协议；增量来源/任务/操作覆盖检查纳入商业总门。 对外收费总门需O1（N15-38）；相关策略/模型/身份治理在启用对应功能前完成。

**v0.4追加验收：** 未过N13-10或N13-12不得宣称新版商业支持完成。 未通过O1不能宣称已有可收费运营闭环；O2仍是详尽后台整体完成门。

<a id="task-n13-10"></a>
### N13-10 透明报价、耗时不确定性与重试退款协议

**状态：** `TODO`　**依赖：** N13-03。  
**需求：** V04-25。  
**版本：** v0.4新增。  
**代码落点：** 现有usage／credits／jobs／provider contracts、API／SDK及轻量报价UI。

**实现内容：** 定义CostQuote及绑定源/目标/Provider/policy/预算版本的consent；包括estimatedCost或区间、elapsed/queueEstimate未知、重试收费规则、失败结算、保存/使用权限和到期。

**验收／负面路径：** 未知费用不填零，未知耗时不造倒计时；范围/供应商/价格变化重新授权；同意不含公开发布；失败/取消/编辑撤销三类退款状态区分；真实结算可追查。

**增量来源：** 方案§2.3、§8。

<a id="task-n13-11"></a>
### N13-11 媒体缓存、GPU与分析任务隔离回归

**状态：** `TODO`　**依赖：** N03-15, N02-14, N13-02。  
**需求：** V04-08, V04-11, V04-13。  
**版本：** v0.4新增。  
**代码落点：** 现有安全测试、Web播放器、media worker与存储回收。

**实现内容：** 覆盖解码资源滥用、超大分辨率/包、GPU纹理残留、worker沙箱、URL/缓存授权失效、跨租户索引和生成代码；处理器退出释放并限制资源。

**验收／负面路径：** 恶意文件不能拖垮API或读取secret；切租户后不显旧画面；cache purge有证据；无GPU环境跑回退安全测试，不把skip标为通过。

**增量来源：** 方案§1.4、§10、§13；工程细化。

<a id="task-n13-12"></a>
### N13-12 增量依赖、操作覆盖与阶段门自动校验

**状态：** `TODO`　**依赖：** N00-07, N00-06, N01-11。  
**需求：** V04-01, V04-03, V04-26。  
**版本：** v0.4新增。  
**代码落点：** 现有scripts／docs／CI；拟新增规范／registry一致性检查。

**实现内容：** 把操作注册清单、N任务依赖、P/T别名和新门映射做机器校验；检测同名重复工具、悬空需求、已通过旧验收但缺v0.4证据；不以文档检查替代运行测试。

**验收／负面路径：** 引入一条不存在操作或循环依赖时检查实际失败；原126任务ID全保留；目录/账本一致；文档验证与应用测试输出分别标记。

**增量来源：** 方案§14—§17；工程细化。


<a id="phase-n14"></a>
## N14｜既有扩展回归与桌面／手机持续演进

**验收门：** G4　**优先级：** P2（回归项P0）。

**共用失败／回滚规则：** 先保持旧功能兼容，再增多端；本地执行不绕过权限和项目版本；公开发布仍独立授权，不因创作采用自动执行。

<a id="task-n14-01"></a>
### N14-01 发布、导出交接与多产物回归

**状态：** `TODO`　**依赖：** N01-05, N09-06, N13-06。  
**需求：** V03-61, V03-62, V03-63, V03-67。  
**版本：** v0.3保留。  
**代码落点：** 现有extensions／publishing／cms／analytics／finance／billing与共享sdk；desktop/mobile依原计划基线增量。

**实现内容：** 让现有短片／图文／文字／发布包读取新ProjectDocument和ContentCore关联；重核P1–P4能力，保留官方API与手动Handoff边界。

**验收／负面路径：** 同冻结版本重复publish不重复发帖；无API平台输出完整包；各衍生内容保留来源，不机械裁切误删主体。

<a id="task-n14-02"></a>
### N14-02 CMS／RSS／Analytics／Finance兼容

**状态：** `TODO`　**依赖：** N01-05, N09-03, N13-06。  
**需求：** V03-24, V03-56, V03-63, V03-68。  
**版本：** v0.3保留。  
**代码落点：** 现有extensions／publishing／cms／analytics／finance／billing与共享sdk；desktop/mobile依原计划基线增量。

**实现内容：** 旧文章输入、签名回写、内容版本与发布归因适配新模型；接受分析建议不静默改已锁定作品；保留Finance来源／模板版本。

**验收／负面路径：** CMS重复事件幂等；旧发布用旧冻结版本归因；虚构fixture不标真实行情；新剪辑工程不要求CMS存在。

<a id="task-n14-03"></a>
### N14-03 桌面壳、缓存与可选本地处理

**状态：** `TODO`　**依赖：** N13-09, N12-06。  
**需求：** V03-05, V03-55, V03-66, V04-53, V04-55, V04-63。  
**版本：** v0.3保留；v0.4显式补充，旧证据不清零。  
**代码落点：** 现有extensions／publishing／cms／analytics／finance／billing与共享sdk；desktop/mobile依原计划基线增量。

**实现内容：** 沿原桌面计划复用SDK与UI，增加文件系统／安全凭据／大文件缓存；本地转码或渲染通过执行Adapter，保留云端项目权威。

**验收／负面路径：** 无复制导演／账本服务；断网编辑按允许范围排队并冲突校验；本地文件授权撤销后不继续读取；跨端打开同版一致。

**v0.4增量要求：** 桌面外观复用语义token；字体/系统主题与原生交互按平台适配，不打包Apple字体到Windows。

**v0.4追加验收：** 深浅外观和原媒体颜色分别验证，不将Web截图当桌面验收。

<a id="task-n14-04"></a>
### N14-04 手机共看片室与触控语音

**状态：** `TODO`　**依赖：** N13-09, N05-08, N04-08。  
**需求：** V03-05, V03-25, V03-26, V03-62, V03-65, V03-66, V04-53, V04-56, V04-62。  
**版本：** v0.3保留；v0.4显式补充，旧证据不清零。  
**代码落点：** 现有extensions／publishing／cms／analytics／finance／billing与共享sdk；desktop/mobile依原计划基线增量。

**实现内容：** 移动端实现触控／长按／时间范围、语音、相机素材上传、审阅／采用、任务／推送和发布Handoff；专业能力按端能力渐进开放。

**验收／负面路径：** Web确认内容在手机不漂移；从手机指点修改仍走同事务；后台录音权限与上传续传明确；无假冒自动发布。

**v0.4增量要求：** 手机主题默认跟随系统，明确覆盖优先级；触控命中和低动效适配§29。

**v0.4追加验收：** 无hover也可发现动作，44px命中不与邻近按钮重叠，媒体主题不被UI改变。

<a id="task-n14-05"></a>
### N14-05 团队协作、审阅与企业权限

**状态：** `TODO`　**依赖：** N06-03, N09-02, N13-01。  
**需求：** V03-33, V03-53, V03-64, V03-67, V04-27, V04-33, V04-34。  
**版本：** v0.3保留；v0.4显式补充，旧证据不清零。  
**代码落点：** 现有extensions／publishing／cms／analytics／finance／billing与共享sdk；desktop/mobile依原计划基线增量。

**实现内容：** 协作presence与作品写权限分离；评论／提案／采用／批准／发布分别授权；并发编辑、审阅人、审计导出与企业身份按原计划推进。

**验收／负面路径：** reviewer不能修改Key或越权发布；两人意见不混成单用户长期偏好；撤销权限实时生效；冲突不丢内容。

**v0.4增量要求：** 客户Workspace Admin/Reviewer与平台Ops职责严格区分，结合N15-11/13权限和支持流程。

**v0.4追加验收：** 平台客服不能以客户身份确认作品或公开发布。

<a id="task-n14-06"></a>
### N14-06 策略／效果／输出扩展与商业授权

**状态：** `TODO`　**依赖：** N10-09, N12-07, N13-09。  
**需求：** V03-38, V03-48, V03-57, V03-62, V03-64。  
**版本：** v0.3保留。  
**代码落点：** 现有extensions／publishing／cms／analytics／finance／billing与共享sdk；desktop/mobile依原计划基线增量。

**实现内容：** 在既有Core+Packs上扩展策略／效果／输出插件manifest、签名、scope、额度、版本和收费授权；先官方包，再受控第三方。

**验收／负面路径：** 恶意包不能读其他workspace或自由调用Provider；卸载不破坏冻结产物；订阅授权与计算费用分开。

<a id="task-n14-07"></a>
### N14-07 跨端和完整产品覆盖账本闭合

**状态：** `TODO`　**依赖：** N14-01, N14-02, N14-03, N14-04, N14-05, N14-06, N12-08, N14-08。  
**需求：** V03-01, V03-02, V03-05, V03-59, V03-60, V03-66, V03-67, V04-10, V04-17, V04-26。  
**版本：** v0.3保留；v0.4显式补充，旧证据不清零。  
**代码落点：** 现有extensions／publishing／cms／analytics／finance／billing与共享sdk；desktop/mobile依原计划基线增量。

**实现内容：** 按本文需求矩阵和新竞品差项重算交付覆盖；验证多端、专业、策略、安全和旧功能，不把某阶段通过外推整个产品。

**验收／负面路径：** 每条关闭需求指向真实证据；未完成专业能力有下一任务；同一项目跨端续作与交付复现；无“全部已完成”的无证断言。

**v0.4增量要求：** 多端闭合包含N14-08的新Playback/Agent适配证据，不以旧Web Scene Editor复制当完成。

**v0.4追加验收：** 各端能力、限制及回退有独立实测。

<a id="task-n14-08"></a>
### N14-08 跨端Playback与Agent能力协议复用

**状态：** `TODO`　**依赖：** N14-03, N14-04, N07-09, N03-16, N09-11。  
**需求：** V04-10, V04-17, V04-26。  
**版本：** v0.4新增。  
**代码落点：** 现有共享contracts／sdk，未来desktop／mobile客户端适配层。

**实现内容：** Web新核心稳定后新增Native播放/解码适配；共用ProjectDocument、SelectionAnchor、MediaIndex、Agent工具与编辑操作；端能力差异显式，不要求原封打包Web API。

**验收／负面路径：** 同项目跨端选区/提案/回放/接受语义一致；原生不支持效果走批准的回退；离开客户端任务状态准确；后端无重复导演/权限/账本。

**增量来源：** 方案P22、P23。


<a id="phase-n15"></a>
## N15｜详尽运营后台（横切推进：内部运营、收费治理与完整运营）

**验收门：** O0／O1／O2；贯穿G0–G4，不在N14后等待　**优先级：** P0基础运营／P1收费治理／P2增长与规模。

**共用失败／回滚规则：** 运营动作采用范围预检、审批、幂等与追加式审计。配置回退旧版本；编辑与账本用补偿；外部结果未知先对账。新写能力可关闭，私片、原件、历史与费用记录不得清除。

<a id="task-n15-01"></a>
### N15-01 运营范围、现有后台与权限实体盘点

**状态：** `TODO`　**依赖：** N00-01, N00-07。  
**需求：** V04-27, V04-31, V04-49, V04-50。  
**版本：** v0.4新增。  
**专项门：** O0。  
**代码落点：** 复用现有 `apps/web/src/app/admin/page.tsx`（开工复核）、`apps/api/`、`packages/contracts`／`domain`／`db`／`sdk`；运营子路由与实体为拟新增。

**实现内容：** 盘点现有admin、用户、订阅、ledger、jobs、Provider及权限测试；建立24模块复用/扩展/待实现表。区分平台权限与客户Workspace Owner；输出O0/O1/O2落点和生产开关，先复用现有能力。

**验收／负面路径：** 每个模块有实体/路由/角色/任务映射；未读实现不写已完成；旧管理入口可兼容；没有重建第二个billing或asset模型。

**角色与授权：** 平台Owner、架构负责人。

**接口／动作边界：** 拟增/复用 ops模块注册与访问策略。

**数据对象：** OpsModuleDefinition、模块/路径盘点。

**回退与补偿：** 关闭对应运营写能力；保留追加式证据。已发生副作用按动作类别补偿，不改历史记录。。

**增量来源：** [U02] 用户追加“还需要有一个详尽的运营后台”；本版工程细化。

<a id="task-n15-02"></a>
### N15-02 管理员认证、多因素与生产会话

**状态：** `TODO`　**依赖：** N15-01, N00-03。  
**需求：** V04-27, V04-28, V04-29。  
**版本：** v0.4新增。  
**专项门：** O0。  
**代码落点：** 复用现有 `apps/web/src/app/admin/page.tsx`（开工复核）、`apps/api/`、`packages/contracts`／`domain`／`db`／`sdk`；运营子路由与实体为拟新增。

**实现内容：** 复用现有认证底层，独立管理员授权域与scope；多因素、敏感动作重新验证、会话空闲/绝对期限、撤销、异常登录和环境标识。机器人服务账户不具备人类审批身份。

**验收／负面路径：** 普通客户Owner不能访问ops API；过期/撤销/非管理员token拒绝；退出和移除角色使写请求失效；生产请求不能用测试凭据。

**角色与授权：** SECURITY_ADMIN、管理员本人。

**接口／动作边界：** ops session/reauth/revoke（使用现有Auth适配）。

**数据对象：** AdminPrincipal、AdminSession、RoleGrant。

**回退与补偿：** 关闭对应运营写能力；保留追加式证据。已发生副作用按动作类别补偿，不改历史记录。。

**增量来源：** [U02] 用户追加“还需要有一个详尽的运营后台”；本版工程细化。

<a id="task-n15-03"></a>
### N15-03 运营RBAC/ABAC与职责分离策略

**状态：** `TODO`　**依赖：** N15-02。  
**需求：** V04-29, V04-27, V04-28。  
**版本：** v0.4新增。  
**专项门：** O0。  
**代码落点：** 复用现有 `apps/web/src/app/admin/page.tsx`（开工复核）、`apps/api/`、`packages/contracts`／`domain`／`db`／`sdk`；运营子路由与实体为拟新增。

**实现内容：** 实现角色×动作×环境×租户×资源×金额/时间策略矩阵；客户管理和平台管理权限分开，逐对象校验。独立申请/审批人，平台Owner非内容与密钥万能root；break-glass仅允许限时止损。

**验收／负面路径：** 越权GET/写/搜索/导出均拒绝；多身份别名不能自批；无双人条件的高风险动作禁用；紧急止损不能退款或解锁客户作品。

**角色与授权：** SECURITY_ADMIN、AUDITOR。

**接口／动作边界：** permission decision与ops授权中间件。

**数据对象：** PermissionPolicyVersion、RoleGrant、EmergencyGrant。

**回退与补偿：** 关闭对应运营写能力；保留追加式证据。已发生副作用按动作类别补偿，不改历史记录。。

**增量来源：** [U02] 用户追加“还需要有一个详尽的运营后台”；本版工程细化。

<a id="task-n15-04"></a>
### N15-04 AdminAction预检、审批与幂等执行框架

**状态：** `TODO`　**依赖：** N15-03, N01-08。  
**需求：** V04-29, V04-49, V04-30。  
**版本：** v0.4新增。  
**专项门：** O0。  
**代码落点：** 复用现有 `apps/web/src/app/admin/page.tsx`（开工复核）、`apps/api/`、`packages/contracts`／`domain`／`db`／`sdk`；运营子路由与实体为拟新增。

**实现内容：** 实现DRAFT/预检/审批/执行/对账状态、固定目标集合、scope/impact hash、expectedRevision、有效期、双人复核、逐项结果与补偿引用。命令调用现有domain和Outbox，不开放任意数据库或shell操作。

**验收／负面路径：** dry-run零副作用；审批后改金额/目标/revision则失效；同idempotencyKey只执行一次；外部结果未知进入RECONCILING；批量部分失败可追踪且未执行项可停。

**角色与授权：** 权限内申请人、独立审批人。

**接口／动作边界：** POST ops/actions/dry-run/create/approvals/execute；GET状态。

**数据对象：** AdminAction、Approval、ActionItem、Outbox。

**回退与补偿：** 关闭对应运营写能力；保留追加式证据。已发生副作用按动作类别补偿，不改历史记录。。

**增量来源：** [U02] 用户追加“还需要有一个详尽的运营后台”；本版工程细化。

<a id="task-n15-05"></a>
### N15-05 运营动作与敏感访问追加式审计

**状态：** `TODO`　**依赖：** N15-04。  
**需求：** V04-30, V04-49, V04-29。  
**版本：** v0.4新增。  
**专项门：** O0。  
**代码落点：** 复用现有 `apps/web/src/app/admin/page.tsx`（开工复核）、`apps/api/`、`packages/contracts`／`domain`／`db`／`sdk`；运营子路由与实体为拟新增。

**实现内容：** 记录actor、角色快照、环境、原因/工单、scope、revision、审批、前后hash、外部/费用引用、结果。独立写权限，敏感证据本体最小化；失败尝试和审计导出也记录。

**验收／负面路径：** 管理员不能修改/删除自身审计；审计写入失败时敏感操作fail closed或可靠Outbox待写；无Secret/训练样本/完整prompt入日志；隐私删除不被审计全文副本抵消。

**角色与授权：** SECURITY_ADMIN、AUDITOR。

**接口／动作边界：** GET ops/audit；内部audit append接口不公开任意写。

**数据对象：** AdminAuditEvent、EvidenceRef、retention policy。

**回退与补偿：** 关闭对应运营写能力；保留追加式证据。已发生副作用按动作类别补偿，不改历史记录。。

**增量来源：** [U02] 用户追加“还需要有一个详尽的运营后台”；本版工程细化。

<a id="task-n15-06"></a>
### N15-06 运营台导航、全局检索与详情框架

**状态：** `TODO`　**依赖：** N15-03, N15-05。  
**需求：** V04-31, V04-27, V04-52, V04-59。  
**版本：** v0.4新增；v0.4显式补充，旧证据不清零。  
**专项门：** O0。  
**代码落点：** 复用现有 `apps/web/src/app/admin/page.tsx`（开工复核）、`apps/api/`、`packages/contracts`／`domain`／`db`／`sdk`；运营子路由与实体为拟新增。

**实现内容：** 建设按职责显示的六组导航、24模块入口、表格/详情/时间线/相关对象/动作抽屉；服务端分页、可保存视图、列权限、UTC/本地时区、环境标识、数据新鲜度、空/延迟/失败状态。

**验收／负面路径：** 全局搜索先授权；隐藏列不能从接口和导出读到；大列表不全量加载；无数据不显示零；用户Studio无多余运营面板。

**v0.4增量要求：** 运营台全站沿用§29苹果式极简黑白；表格密度适配而非营销大留白；N16-08迁移共享组件。

**v0.4追加验收：** 生产环境/scope、金额、状态和危险动作无需颜色仍可辨识。

**角色与授权：** 各ops角色按scope。

**接口／动作边界：** GET ops/search与各资源列表/详情。

**数据对象：** SavedView、OpsModuleDefinition、read projections。

**回退与补偿：** 关闭对应运营写能力；保留追加式证据。已发生副作用按动作类别补偿，不改历史记录。。

**增量来源：** [U02] 用户追加“还需要有一个详尽的运营后台”；本版工程细化。

<a id="task-n15-07"></a>
### N15-07 经营与运行指标字典和事实层

**状态：** `TODO`　**依赖：** N15-01, N13-03。  
**需求：** V04-32, V04-39, V04-44。  
**版本：** v0.4新增。  
**专项门：** O0定义/O1经营。  
**代码落点：** 复用现有 `apps/web/src/app/admin/page.tsx`（开工复核）、`apps/api/`、`packages/contracts`／`domain`／`db`／`sdk`；运营子路由与实体为拟新增。

**实现内容：** 定义并版本化事件、去重、时间、分母、测试数据排除、币种和watermark；注册活跃、价值漏斗、成功率、MRR、实收/退款、Credits、成本、质量/留存口径，估计覆盖显式。

**验收／负面路径：** 已知fixture可算出明确结果；延迟事件、重复、取消、一次性充值/赠送、跨币种均不误算MRR/利润；公式版本变化能重算或保留旧快照。

**角色与授权：** 经营分析、财务、AI质量。

**接口／动作边界：** GET ops/metric-definitions和指标查询。

**数据对象：** MetricDefinition、MetricSnapshot、event facts。

**回退与补偿：** 关闭对应运营写能力；保留追加式证据。已发生副作用按动作类别补偿，不改历史记录。。

**增量来源：** [U02] 用户追加“还需要有一个详尽的运营后台”；本版工程细化。

<a id="task-n15-08"></a>
### N15-08 运营总览与异常钻取

**状态：** `TODO`　**依赖：** N15-06, N15-07。  
**需求：** V04-31, V04-32, V04-47。  
**版本：** v0.4新增。  
**专项门：** O0运行/O1经营。  
**代码落点：** 复用现有 `apps/web/src/app/admin/page.tsx`（开工复核）、`apps/api/`、`packages/contracts`／`domain`／`db`／`sdk`；运营子路由与实体为拟新增。

**实现内容：** 汇总待处理任务/工单/审批、Provider故障、预算水位、运行成功/延迟和可用经营指标；每卡有时间窗、freshness、分母及到事件/案件详情的权限内钻取。

**验收／负面路径：** 卡片与明细同过滤下对得上；只有部分成本时标估计；无权访问的租户不从总数/搜索泄露；运行告警可分派而非仅展示。

**角色与授权：** 运营、制作运维、经营分析。

**接口／动作边界：** GET ops/overview。

**数据对象：** MetricSnapshot、action/incident read models。

**回退与补偿：** 关闭对应运营写能力；保留追加式证据。已发生副作用按动作类别补偿，不改历史记录。。

**增量来源：** [U02] 用户追加“还需要有一个详尽的运营后台”；本版工程细化。

<a id="task-n15-09"></a>
### N15-09 增长漏斗、cohort与制作质量分析

**状态：** `TODO`　**依赖：** N15-07, N15-08。  
**需求：** V04-44, V04-32。  
**版本：** v0.4新增。  
**专项门：** O2。  
**代码落点：** 复用现有 `apps/web/src/app/admin/page.tsx`（开工复核）、`apps/api/`、`packages/contracts`／`domain`／`db`／`sdk`；运营子路由与实体为拟新增。

**实现内容：** 按Workspace去重构建获取→导入→有效试改→采用→合格导出→付费/续订；追踪流失原因、模型/产品版本、采用率、纠正轮数及质量样本；查询不默认读取私片全文。

**验收／负面路径：** 导出点击不计为QA成功；迟到、重复、测试租户排除正确；cohort周期/分母固定；小样本明确不足，不把相关性当因果。

**角色与授权：** GROWTH_ANALYST、经营分析。

**接口／动作边界：** GET ops/analytics/funnels/cohorts/quality。

**数据对象：** MetricDefinition、CohortQuery、quality facts。

**回退与补偿：** 关闭对应运营写能力；保留追加式证据。已发生副作用按动作类别补偿，不改历史记录。。

**增量来源：** [U02] 用户追加“还需要有一个详尽的运营后台”；本版工程细化。

<a id="task-n15-10"></a>
### N15-10 用户中心与受控账号生命周期

**状态：** `TODO`　**依赖：** N15-06, N15-04。  
**需求：** V04-33, V04-31。  
**版本：** v0.4新增。  
**专项门：** O0。  
**代码落点：** 复用现有 `apps/web/src/app/admin/page.tsx`（开工复核）、`apps/api/`、`packages/contracts`／`domain`／`db`／`sdk`；运营子路由与实体为拟新增。

**实现内容：** 用户详情连接脱敏身份、Workspace、套餐、工单与关键事件；支持标签/备注/会话撤销/能力限制/暂停恢复，原因、范围、复查与通知完整，账号和账单/资产状态分开。

**验收／负面路径：** 暂停不删除工程或篡改订阅；普通客服不能永久销号；恢复引用原资产；联系方式检索限频并审计；客户可获得适用申诉/服务渠道。

**角色与授权：** SUPPORT_L1/L2、账户运营。

**接口／动作边界：** GET ops/users；typed account admin actions。

**数据对象：** UserState、AccountRestriction、SupportTicket。

**回退与补偿：** 关闭对应运营写能力；保留追加式证据。已发生副作用按动作类别补偿，不改历史记录。。

**增量来源：** [U02] 用户追加“还需要有一个详尽的运营后台”；本版工程细化。

<a id="task-n15-11"></a>
### N15-11 工作区、成员、席位与客户管理入口

**状态：** `TODO`　**依赖：** N15-10, N15-03。  
**需求：** V04-33, V04-27。  
**版本：** v0.4新增。  
**专项门：** O1。  
**代码落点：** 复用现有 `apps/web/src/app/admin/page.tsx`（开工复核）、`apps/api/`、`packages/contracts`／`domain`／`db`／`sdk`；运营子路由与实体为拟新增。

**实现内容：** 完善客户Workspace设置和平台账户详情，处理邀请/角色、最后Owner保护、席位、账单联系人、Owner转移申请、地区政策、用量限制；复用现有团队领域。

**验收／负面路径：** Workspace Admin无跨租户或平台权限；转移需原/新主体授权；最后Owner不能被无替代删除；角色变化会话立即收紧，历史作品不丢。

**角色与授权：** 客户Owner/Admin、账户运营。

**接口／动作边界：** Workspace settings APIs及ops只读投影/审批动作。

**数据对象：** WorkspaceMember、OwnerTransfer、EntitlementSnapshot。

**回退与补偿：** 关闭对应运营写能力；保留追加式证据。已发生副作用按动作类别补偿，不改历史记录。。

**增量来源：** [U02] 用户追加“还需要有一个详尽的运营后台”；本版工程细化。

<a id="task-n15-12"></a>
### N15-12 客服工单、时间线与脱敏诊断包

**状态：** `TODO`　**依赖：** N15-06, N15-10。  
**需求：** V04-34, V04-31。  
**版本：** v0.4新增。  
**专项门：** O0。  
**代码落点：** 复用现有 `apps/web/src/app/admin/page.tsx`（开工复核）、`apps/api/`、`packages/contracts`／`domain`／`db`／`sdk`；运营子路由与实体为拟新增。

**实现内容：** 实现分派、优先级、等待用户/内部、解决/重开、内部备注/客户回复隔离；工单关联项目/Job/账单/事故，生成有字段权限的诊断包，不要求先取得私片访问。

**验收／负面路径：** 内部备注不发客户；同工单关联动作有追踪；诊断包无Key/签名URL/全文prompt；恢复失败仍可升级和保留原错误。

**角色与授权：** SUPPORT_L1/L2。

**接口／动作边界：** GET/POST ops/tickets、diagnostic exports。

**数据对象：** SupportTicket、TicketEvent、DiagnosticBundle。

**回退与补偿：** 关闭对应运营写能力；保留追加式证据。已发生副作用按动作类别补偿，不改历史记录。。

**增量来源：** [U02] 用户追加“还需要有一个详尽的运营后台”；本版工程细化。

<a id="task-n15-13"></a>
### N15-13 限时支持访问与禁止冒充用户

**状态：** `TODO`　**依赖：** N15-12, N15-04, N15-05。  
**需求：** V04-34, V04-29, V04-40。  
**版本：** v0.4新增。  
**专项门：** O0（先默认无内容访问）。  
**代码落点：** 复用现有 `apps/web/src/app/admin/page.tsx`（开工复核）、`apps/api/`、`packages/contracts`／`domain`／`db`／`sdk`；运营子路由与实体为拟新增。

**实现内容：** SupportAccessGrant绑定工单、用途、对象/范围、只读动作、依据、批准人和期限；客户撤销实时生效。访问显示员工身份，无用户cookie impersonation，不授予作品采用/发布/克隆同意。

**验收／负面路径：** 过期/撤销后原片/缩略/流式缓存读失败；范围外文件拒绝；只读授权不能改工程或下载全集；支持生成候选由客户确认。

**角色与授权：** SUPPORT_L2、客户授权者/合规审批人。

**接口／动作边界：** POST/DELETE ops/support-access；media访问复核。

**数据对象：** SupportAccessGrant、ContentAccessEvent。

**回退与补偿：** 关闭对应运营写能力；保留追加式证据。已发生副作用按动作类别补偿，不改历史记录。。

**增量来源：** [U02] 用户追加“还需要有一个详尽的运营后台”；本版工程细化。

<a id="task-n15-14"></a>
### N15-14 项目版本、媒体依赖与故障诊断

**状态：** `TODO`　**依赖：** N15-12, N01-08, N02-07。  
**需求：** V04-34, V04-35, V04-40。  
**版本：** v0.4新增。  
**专项门：** O0。  
**代码落点：** 复用现有 `apps/web/src/app/admin/page.tsx`（开工复核）、`apps/api/`、`packages/contracts`／`domain`／`db`／`sdk`；运营子路由与实体为拟新增。

**实现内容：** 关联Project/Sequence/revision、候选、冻结manifest、素材/索引/生成/渲染依赖、QA和费用；先只读元数据；恢复建议通过统一操作提出，不允许客服改作品JSON。

**验收／负面路径：** 可找到卡住阶段和缺失依赖；锁、模式、冻结对ops同样生效；无访问grant不能看媒体；晚到资产不自动污染当前版本。

**角色与授权：** SUPPORT_L2、PRODUCTION_OPERATOR。

**接口／动作边界：** GET ops/projects/:id/diagnostics。

**数据对象：** ProjectDocument projections、DependencyGraph、QA refs。

**回退与补偿：** 关闭对应运营写能力；保留追加式证据。已发生副作用按动作类别补偿，不改历史记录。。

**增量来源：** [U02] 用户追加“还需要有一个详尽的运营后台”；本版工程细化。

<a id="task-n15-15"></a>
### N15-15 任务DAG、队列和attempt详情

**状态：** `TODO`　**依赖：** N15-06, N13-04。  
**需求：** V04-35, V04-31。  
**版本：** v0.4新增。  
**专项门：** O0。  
**代码落点：** 复用现有 `apps/web/src/app/admin/page.tsx`（开工复核）、`apps/api/`、`packages/contracts`／`domain`／`db`／`sdk`；运营子路由与实体为拟新增。

**实现内容：** 统一导入/转码/索引/Agent/生成/渲染的阶段、lease、心跳、attempt、外部Job、取消/收费状态、错误分类、DLQ及公平配额；跨对象钻取但不返回私密输入。

**验收／负面路径：** queued/running/provider waiting可区分；失败/取消/未知独立；一个逻辑任务多attempt不虚增业务成功数；按环境/租户正确隔离。

**角色与授权：** PRODUCTION_OPERATOR、SUPPORT_L2。

**接口／动作边界：** GET ops/jobs/queues/provider-jobs。

**数据对象：** Job、JobAttempt、Dependency、queue projections。

**回退与补偿：** 关闭对应运营写能力；保留追加式证据。已发生副作用按动作类别补偿，不改历史记录。。

**增量来源：** [U02] 用户追加“还需要有一个详尽的运营后台”；本版工程细化。

<a id="task-n15-16"></a>
### N15-16 幂等任务恢复、取消与死信操作

**状态：** `TODO`　**依赖：** N15-15, N15-04, N15-05, N13-03。  
**需求：** V04-35, V04-47, V04-39。  
**版本：** v0.4新增。  
**专项门：** O0。  
**代码落点：** 复用现有 `apps/web/src/app/admin/page.tsx`（开工复核）、`apps/api/`、`packages/contracts`／`domain`／`db`／`sdk`；运营子路由与实体为拟新增。

**实现内容：** 实现先查询外部状态/补拉结果，再恢复失败阶段；暂停新派发、取消请求、受控优先级、固定批次DLQ重放。所有恢复重查模式、预算、引用/版本、幂等与scope。

**验收／负面路径：** 重复恢复不双扣/重复发布；外部结果未知进RECONCILING；不能取消的任务明确状态；恢复只影响批准范围，纯剪辑禁令与冻结不被绕过。

**角色与授权：** PRODUCTION_OPERATOR。

**接口／动作边界：** AdminAction: recover_stage/query_result/cancel/pause_dispatch/replay_dlq。

**数据对象：** AdminAction、JobAttempt、CostReservation。

**回退与补偿：** 关闭对应运营写能力；保留追加式证据。已发生副作用按动作类别补偿，不改历史记录。。

**增量来源：** [U02] 用户追加“还需要有一个详尽的运营后台”；本版工程细化。

<a id="task-n15-17"></a>
### N15-17 供应商目录、健康与路由配置运营

**状态：** `TODO`　**依赖：** N15-06, N15-04。  
**需求：** V04-36, V04-47, V04-43。  
**版本：** v0.4新增。  
**专项门：** O0。  
**代码落点：** 复用现有 `apps/web/src/app/admin/page.tsx`（开工复核）、`apps/api/`、`packages/contracts`／`domain`／`db`／`sdk`；运营子路由与实体为拟新增。

**实现内容：** 复用现有catalog/router，展示官方声明/账户实测/线上观测、限流、地区/隐私、价格版本与验证时间；配置改动diff、受影响报价预演、测试fixture、审批和灰度发布。

**验收／负面路径：** 停用只对批准scope的新任务生效；BYOK失败不静默平台扣费；路由不跨隐私区；未实测不能标真实可用；旧FrozenManifest不受升级影响。

**角色与授权：** PROVIDER_MANAGER、配置审批人。

**接口／动作边界：** GET ops/providers；AdminAction: provider-config/route-change。

**数据对象：** ProviderCatalogVersion、RoutingPolicyVersion、HealthSnapshot。

**回退与补偿：** 关闭对应运营写能力；保留追加式证据。已发生副作用按动作类别补偿，不改历史记录。。

**增量来源：** [U02] 用户追加“还需要有一个详尽的运营后台”；本版工程细化。

<a id="task-n15-18"></a>
### N15-18 凭据生命周期与write-only轮换

**状态：** `TODO`　**依赖：** N15-17, N15-03, N15-05。  
**需求：** V04-36, V04-28, V04-30。  
**版本：** v0.4新增。  
**专项门：** O0。  
**代码落点：** 复用现有 `apps/web/src/app/admin/page.tsx`（开工复核）、`apps/api/`、`packages/contracts`／`domain`／`db`／`sdk`；运营子路由与实体为拟新增。

**实现内容：** 平台/BYOK凭据仅显示指纹、scope、最后使用、到期/错误；write-only输入轮换、撤销、健康测试与Secret Manager引用，日志脱敏；客户连接修复沿授权流程。

**验收／负面路径：** 任何ops GET/export/错误不得返回完整Key；客服无权取BYOK；旧凭据撤销对任务行为明确；测试有预算、非敏感fixture和审计。

**角色与授权：** SECURITY_ADMIN、Credential Custodian、客户凭据Owner。

**接口／动作边界：** credential管理typed actions；复用现有连接API。

**数据对象：** CredentialRef、RotationAction、SecretAccessAudit。

**回退与补偿：** 关闭对应运营写能力；保留追加式证据。已发生副作用按动作类别补偿，不改历史记录。。

**增量来源：** [U02] 用户追加“还需要有一个详尽的运营后台”；本版工程细化。

<a id="task-n15-19"></a>
### N15-19 套餐、价格、权益和试用规则管理

**状态：** `TODO`　**依赖：** N15-06, N15-04, N13-03。  
**需求：** V04-37, V04-39。  
**版本：** v0.4新增。  
**专项门：** O1。  
**代码落点：** 复用现有 `apps/web/src/app/admin/page.tsx`（开工复核）、`apps/api/`、`packages/contracts`／`domain`／`db`／`sdk`；运营子路由与实体为拟新增。

**实现内容：** Plan/Price/Entitlement版本化；软件、计算、存储、席位、身份/Pack独立；新旧客户、生效周期、老方案保护明确；优惠/赠送/补偿有总额/次数/期限与审批。

**验收／负面路径：** 旧订单引用价格不变；变更预演费用/权益；赠送不算收入，超补贴预算拦截；运营不能更新可变balance替代ledger。

**角色与授权：** 商品运营、财务/配置审批人。

**接口／动作边界：** ops plans/prices/entitlements＋AdminAction发布。

**数据对象：** PlanVersion、PriceVersion、EntitlementSnapshot、PromotionPolicy。

**回退与补偿：** 关闭对应运营写能力；保留追加式证据。已发生副作用按动作类别补偿，不改历史记录。。

**增量来源：** [U02] 用户追加“还需要有一个详尽的运营后台”；本版工程细化。

<a id="task-n15-20"></a>
### N15-20 订单订阅、续费与权益事件运营

**状态：** `TODO`　**依赖：** N15-19, N15-10。  
**需求：** V04-38, V04-37。  
**版本：** v0.4新增。  
**专项门：** O1。  
**代码落点：** 复用现有 `apps/web/src/app/admin/page.tsx`（开工复核）、`apps/api/`、`packages/contracts`／`domain`／`db`／`sdk`；运营子路由与实体为拟新增。

**实现内容：** 订单/订阅/账期/付款状态/权益分离；签名且幂等的支付事件驱动权益，续费/到期/变更/欠费排查、催缴和账单下载；现有billing复用，不假定所有外部能力可用。

**验收／负面路径：** 乱序/重复Webhook不重复授予权益；付款成功权限未开有可查差异；取消续订不误删当前有效内容；未知状态不标成功。

**角色与授权：** BILLING_OPERATOR、客户Billing Manager。

**接口／动作边界：** GET ops/orders/subscriptions；对应批准动作。

**数据对象：** Order、Subscription、PaymentEvent、EntitlementSnapshot。

**回退与补偿：** 关闭对应运营写能力；保留追加式证据。已发生副作用按动作类别补偿，不改历史记录。。

**增量来源：** [U02] 用户追加“还需要有一个详尽的运营后台”；本版工程细化。

<a id="task-n15-21"></a>
### N15-21 Credits、预算预留与用量追账台

**状态：** `TODO`　**依赖：** N15-06, N15-04, N13-03。  
**需求：** V04-39, V04-32。  
**版本：** v0.4新增。  
**专项门：** O0。  
**代码落点：** 复用现有 `apps/web/src/app/admin/page.tsx`（开工复核）、`apps/api/`、`packages/contracts`／`domain`／`db`／`sdk`；运营子路由与实体为拟新增。

**实现内容：** 展示购买/赠送/补偿桶及reserve/capture/release/refund/expire/adjustment事件；按project/proposal/job/attempt追账，预算策略与小额补偿申请，未知实际成本单列。

**验收／负面路径：** 从事件重算余额一致；并发额度调整不超授权；重复回调不双扣；拒绝样片不假退款；不能编辑/删除历史DEBIT。

**角色与授权：** BILLING_OPERATOR、成本运营、财务复核。

**接口／动作边界：** GET ops/usage/ledger/budgets；grant/adjustment typed action。

**数据对象：** UsageLedger、CreditLedger、BudgetPolicyVersion。

**回退与补偿：** 关闭对应运营写能力；保留追加式证据。已发生副作用按动作类别补偿，不改历史记录。。

**增量来源：** [U02] 用户追加“还需要有一个详尽的运营后台”；本版工程细化。

<a id="task-n15-22"></a>
### N15-22 退款、拒付与支付差异对账

**状态：** `TODO`　**依赖：** N15-20, N15-21, N15-04。  
**需求：** V04-38, V04-39, V04-29。  
**版本：** v0.4新增。  
**专项门：** O1。  
**代码落点：** 复用现有 `apps/web/src/app/admin/page.tsx`（开工复核）、`apps/api/`、`packages/contracts`／`domain`／`db`／`sdk`；运营子路由与实体为拟新增。

**实现内容：** 退款申请/可退检查/独立审批/外部提交/查询Webhook/内部冲正/通知闭环；拒付与退款可退金额联动，对账差异有案件和关闭证据。

**验收／负面路径：** 自批/改金额/超额拒绝；超时查外部退款ID不重复退款；部分退款累计正确；真实币种与支付金额可对上；编辑Undo不触发现金退款。

**角色与授权：** BILLING_OPERATOR、BILLING_APPROVER。

**接口／动作边界：** ops refunds/reconciliation；AdminAction: refund/reconcile。

**数据对象：** RefundRequest、ReconciliationCase、ExternalRefundRef。

**回退与补偿：** 已提交外部退款不可假撤销；未知保持核对；内部错误用冲正和新审批，不改历史金额。。

**增量来源：** [U02] 用户追加“还需要有一个详尽的运营后台”；本版工程细化。

<a id="task-n15-23"></a>
### N15-23 全成本、单位经济性与财务导出

**状态：** `TODO`　**依赖：** N15-07, N15-21, N15-22。  
**需求：** V04-39, V04-32, V04-44。  
**版本：** v0.4新增。  
**专项门：** O2。  
**代码落点：** 复用现有 `apps/web/src/app/admin/page.tsx`（开工复核）、`apps/api/`、`packages/contracts`／`domain`／`db`／`sdk`；运营子路由与实体为拟新增。

**实现内容：** 汇总规划/语音/索引/生成/试改/失败/合成/存储/带宽实际与估计；按合格成片分钟、已采用修改、客户和Provider分析，收入/计算销售/补贴/基础设施分摊与会计口径分开。

**验收／负面路径：** 缺失成本标覆盖率；多币种保留原币和换算快照；退款、赠送、重试不错误增利；可追溯允许明细但不泄露私密视频。

**角色与授权：** 财务、经营分析、成本运营。

**接口／动作边界：** GET ops/analytics/economics；受控export。

**数据对象：** CostAllocationVersion、FxSnapshot、MetricSnapshot。

**回退与补偿：** 关闭对应运营写能力；保留追加式证据。已发生副作用按动作类别补偿，不改历史记录。。

**增量来源：** [U02] 用户追加“还需要有一个详尽的运营后台”；本版工程细化。

<a id="task-n15-24"></a>
### N15-24 素材、配额、回收与依赖保护运营

**状态：** `TODO`　**依赖：** N15-06, N15-04, N13-05。  
**需求：** V04-40, V04-35。  
**版本：** v0.4新增。  
**专项门：** O0。  
**代码落点：** 复用现有 `apps/web/src/app/admin/page.tsx`（开工复核）、`apps/api/`、`packages/contracts`／`domain`／`db`／`sdk`；运营子路由与实体为拟新增。

**实现内容：** 资产元数据/引用/生命周期/源与派生/冻结关联可视化；配额调整、孤立检测、回收dry-run、垃圾箱恢复和缺失告警；播放与缩略同权限，不做全站私片内容墙。

**验收／负面路径：** TTL不误删冻结依赖；回收预检数量和hash可对照；跨租户资产不可操作；不拿清缓存当删除原件；大批次部分失败可恢复。

**角色与授权：** 存储运维、PRIVACY_OFFICER。

**接口／动作边界：** GET ops/assets/storage；gc/restore/quota actions。

**数据对象：** AssetVersion、RetentionPolicy、DependencyRefs、GCPlan。

**回退与补偿：** 关闭对应运营写能力；保留追加式证据。已发生副作用按动作类别补偿，不改历史记录。。

**增量来源：** [U02] 用户追加“还需要有一个详尽的运营后台”；本版工程细化。

<a id="task-n15-25"></a>
### N15-25 隐私导出、删除、更正与下游证明

**状态：** `TODO`　**依赖：** N15-24, N15-04, N15-05, N15-13。  
**需求：** V04-40, V04-30, V04-29。  
**版本：** v0.4新增。  
**专项门：** O1。  
**代码落点：** 复用现有 `apps/web/src/app/admin/page.tsx`（开工复核）、`apps/api/`、`packages/contracts`／`domain`／`db`／`sdk`；运营子路由与实体为拟新增。

**实现内容：** 请求身份验证、scope、目标清单、例外审核、执行/补查、下游删除状态；覆盖原件/身份/向量/缓存/Provider/备份，导出有到期/权限和下载审计，恢复时重放删除标记。

**验收／负面路径：** 无授权不能代客户导出全部数据；Provider待删不标已删；备份恢复不复活；证据本体与审计最小化分离；irreversible动作需独立审批。

**角色与授权：** PRIVACY_OFFICER、安全复核。

**接口／动作边界：** ops privacy-requests/exports；approved erase workflow。

**数据对象：** PrivacyRequest、DeletionItem、RetentionException、Tombstone。

**回退与补偿：** 关闭对应运营写能力；保留追加式证据。已发生副作用按动作类别补偿，不改历史记录。。

**增量来源：** [U02] 用户追加“还需要有一个详尽的运营后台”；本版工程细化。

<a id="task-n15-26"></a>
### N15-26 声音、数字人授权与身份运营

**状态：** `TODO`　**依赖：** N15-13, N15-24, N15-04, N08-03, N08-04。  
**需求：** V04-40, V04-41, V04-36。  
**版本：** v0.4新增。  
**专项门：** 启用身份功能前/O1。  
**代码落点：** 复用现有 `apps/web/src/app/admin/page.tsx`（开工复核）、`apps/api/`、`packages/contracts`／`domain`／`db`／`sdk`；运营子路由与实体为拟新增。

**实现内容：** 验证状态、同意证据、Provider ID、身份版本与使用项目；支持验证排查、停新生成、退休、撤销/删除请求和滥用申诉，原样本默认不可浏览。

**验收／负面路径：** 不能后台改verified=true绕过Provider验证；退休不会无理由损坏历史产物；删除三方状态分别显示；未授权克隆/更换声音请求拒绝。

**角色与授权：** 身份审核、PRIVACY_OFFICER。

**接口／动作边界：** ops identities/consents；retire/revoke/delete actions。

**数据对象：** IdentityVersion、ConsentRecord、ProviderDeletionRef。

**回退与补偿：** 关闭对应运营写能力；保留追加式证据。已发生副作用按动作类别补偿，不改历史记录。。

**增量来源：** [U02] 用户追加“还需要有一个详尽的运营后台”；本版工程细化。

<a id="task-n15-27"></a>
### N15-27 内容审核、投诉、限制与申诉

**状态：** `TODO`　**依赖：** N15-13, N15-04, N15-05。  
**需求：** V04-41, V04-40。  
**版本：** v0.4新增。  
**专项门：** O1或对应高风险功能前。  
**代码落点：** 复用现有 `apps/web/src/app/admin/page.tsx`（开工复核）、`apps/api/`、`packages/contracts`／`domain`／`db`／`sdk`；运营子路由与实体为拟新增。

**实现内容：** 建立moderation case、证据范围、模型辅助、人工/重大复核、资产/能力/发布/账号分级处置、通知、申诉和恢复；敏感证据最小范围访问，规则版本保存。

**验收／负面路径：** 审核通过不自动发布；错误封禁可恢复且不丢作品；普通审核员不能批量销毁原片；申诉与原处理人职责分离；举报者信息不泄露。

**角色与授权：** CONTENT_REVIEWER、REVIEW_LEAD。

**接口／动作边界：** ops moderation/appeals；quarantine/restrict/reinstate actions。

**数据对象：** ModerationCase、Appeal、EvidenceGrant。

**回退与补偿：** 关闭对应运营写能力；保留追加式证据。已发生副作用按动作类别补偿，不改历史记录。。

**增量来源：** [U02] 用户追加“还需要有一个详尽的运营后台”；本版工程细化。

<a id="task-n15-28"></a>
### N15-28 策略、组件和Pack审核发布台

**状态：** `TODO`　**依赖：** N15-06, N15-04, N15-27, N10-09。  
**需求：** V04-42, V04-43, V04-40。  
**版本：** v0.4新增。  
**专项门：** 策略/组件对外发布前/O2。  
**代码落点：** 复用现有 `apps/web/src/app/admin/page.tsx`（开工复核）、`apps/api/`、`packages/contracts`／`domain`／`db`／`sdk`；运营子路由与实体为拟新增。

**实现内容：** 展示蓝图/DNA/Recipe、来源授权、代码sandbox、参数schema、测试/三内容迁移、价格/权限及适用范围；草案→验证→审核→灰度→发布→下架/撤销，保留不可变版本和hash。

**验收／负面路径：** 未通过安全或来源验证不能发布；改已发布内容必须新版本；下架不改冻结作品；权利撤销明确阻止未来执行并出影响报告，不自动重生成。

**角色与授权：** STRATEGY_CURATOR、策略复核。

**接口／动作边界：** ops strategies/components/packs；release actions。

**数据对象：** StrategyRelease、ComponentVersion、ReviewEvidence。

**回退与补偿：** 关闭对应运营写能力；保留追加式证据。已发生副作用按动作类别补偿，不改历史记录。。

**增量来源：** [U02] 用户追加“还需要有一个详尽的运营后台”；本版工程细化。

<a id="task-n15-29"></a>
### N15-29 模型、prompt、工具与质量回归台

**状态：** `TODO`　**依赖：** N15-06, N15-04, N07-09, N15-17。  
**需求：** V04-43, V04-42, V04-32。  
**版本：** v0.4新增。  
**专项门：** 线上AI组合版本升级前/O2。  
**代码落点：** 复用现有 `apps/web/src/app/admin/page.tsx`（开工复核）、`apps/api/`、`packages/contracts`／`domain`／`db`／`sdk`；运营子路由与实体为拟新增。

**实现内容：** 管理模型/prompt/工具schema/策略/路由组合版本、固定评测集、实际输出、误改/费用/延迟/采用率；人工与模型评分分离，灰度新调用、守护指标和回滚，拒绝隐式修改活跃候选。

**验收／负面路径：** 便宜模型破坏锁定即不放行；无真实证据不标生产支持；敏感私片不能未经许可进评测集；回滚不删除已付费输出和费用。

**角色与授权：** AI_QUALITY、发布审批人。

**接口／动作边界：** ops ai-releases/evaluations；canary/rollback actions。

**数据对象：** ModelRelease、EvalRun、PolicyVersion。

**回退与补偿：** 关闭对应运营写能力；保留追加式证据。已发生副作用按动作类别补偿，不改历史记录。。

**增量来源：** [U02] 用户追加“还需要有一个详尽的运营后台”；本版工程细化。

<a id="task-n15-30"></a>
### N15-30 配置、功能开关、灰度与实验控制

**状态：** `TODO`　**依赖：** N15-04, N15-05, N15-07。  
**需求：** V04-44, V04-43, V04-48。  
**版本：** v0.4新增。  
**专项门：** O0基本开关/O2实验。  
**代码落点：** 复用现有 `apps/web/src/app/admin/page.tsx`（开工复核）、`apps/api/`、`packages/contracts`／`domain`／`db`／`sdk`；运营子路由与实体为拟新增。

**实现内容：** 版本化配置diff、固定scope、审批、预定生效、灰度、stop/rollback；实验稳定分组、指标/停止规则预登记，优先Workspace分组；安全和费用硬约束不得A/B绕开。

**验收／负面路径：** 开关不替代API授权；旧项目不因全局主题/策略变化漂移；修改scope旧审批无效；小样本结果明确不足；紧急停新调用作用域正确。

**角色与授权：** 发布管理员、配置审批人、GROWTH_ANALYST。

**接口／动作边界：** ops config-changes/flags/experiments。

**数据对象：** ConfigChange、FeatureFlagVersion、ExperimentDefinition。

**回退与补偿：** 关闭对应运营写能力；保留追加式证据。已发生副作用按动作类别补偿，不改历史记录。。

**增量来源：** [U02] 用户追加“还需要有一个详尽的运营后台”；本版工程细化。

<a id="task-n15-31"></a>
### N15-31 通知模板、事务消息与授权触达

**状态：** `TODO`　**依赖：** N15-06, N15-04, N15-12。  
**需求：** V04-45, V04-44, V04-33。  
**版本：** v0.4新增。  
**专项门：** O1事务/O2营销。  
**代码落点：** 复用现有 `apps/web/src/app/admin/page.tsx`（开工复核）、`apps/api/`、`packages/contracts`／`domain`／`db`／`sdk`；运营子路由与实体为拟新增。

**实现内容：** 站内/已接入外部渠道的事务/服务/营销模板、语言、变量schema、预览测试、受众快照、同意/退订、频控、去重、审批和批次取消；客户与内部消息隔离。

**验收／负面路径：** 未接入渠道不报发送成功；重试不重复向已成功用户发送；撤销营销同意不影响必要事务通知且遵循实际政策；取消只停未发送项；模板不可泄漏内部字段。

**角色与授权：** 运营、客服、授权客户Admin。

**接口／动作边界：** ops notifications/templates/campaigns/deliveries。

**数据对象：** NotificationTemplateVersion、AudienceSnapshot、DeliveryEvent。

**回退与补偿：** 关闭对应运营写能力；保留追加式证据。已发生副作用按动作类别补偿，不改历史记录。。

**增量来源：** [U02] 用户追加“还需要有一个详尽的运营后台”；本版工程细化。

<a id="task-n15-32"></a>
### N15-32 发布、CMS、Webhook与授权连接运营

**状态：** `TODO`　**依赖：** N15-15, N15-04, N15-18, N14-01。  
**需求：** V04-46, V04-35, V04-36。  
**版本：** v0.4新增。  
**专项门：** 相应发布/CMS功能启用前/O1。  
**代码落点：** 复用现有 `apps/web/src/app/admin/page.tsx`（开工复核）、`apps/api/`、`packages/contracts`／`domain`／`db`／`sdk`；运营子路由与实体为拟新增。

**实现内容：** 查看scope/expiry/remote account、P1-P4状态、发布/回写/导入分步骤和DLQ；签名事实保留、已验证事件幂等重放；无官方能力输出手工Handoff，不模拟cookie登录。

**验收／负面路径：** 发布超时先核对remote ID不重发；CMS回写失败不重生成；客服不能代用户新批准发布；事件payload不可编辑后冒充原签名；失效连接提示真实恢复入口。

**角色与授权：** 集成支持、客户Admin。

**接口／动作边界：** ops integrations/publications/webhooks；reconcile/replay actions。

**数据对象：** PublicationJob、IntegrationConnection、WebhookEvent。

**回退与补偿：** 关闭对应运营写能力；保留追加式证据。已发生副作用按动作类别补偿，不改历史记录。。

**增量来源：** [U02] 用户追加“还需要有一个详尽的运营后台”；本版工程细化。

<a id="task-n15-33"></a>
### N15-33 告警、事故、成本止损与runbook

**状态：** `TODO`　**依赖：** N15-08, N15-16, N15-17, N15-21。  
**需求：** V04-47, V04-35, V04-39。  
**版本：** v0.4新增。  
**专项门：** O0。  
**代码落点：** 复用现有 `apps/web/src/app/admin/page.tsx`（开工复核）、`apps/api/`、`packages/contracts`／`domain`／`db`／`sdk`；运营子路由与实体为拟新增。

**实现内容：** 阈值/窗口/去重/升级/责任角色与runbook，费用速度、排队、限流、结果过期、账本差异、存储和敏感访问告警；incident影响时间线、停新风险、分批恢复、复盘。

**验收／负面路径：** 成本熔断不删项目或影响合法纯剪辑；已读不算恢复；批量恢复有上限；告警去重不吞新事故；紧急权限只做预定止损并自动到期。

**角色与授权：** PRODUCTION_OPERATOR、事故指挥、SECURITY_ADMIN。

**接口／动作边界：** ops alerts/incidents；pause-scope/recover-batch actions。

**数据对象：** AlertRuleVersion、Incident、RecoveryRun。

**回退与补偿：** 关闭对应运营写能力；保留追加式证据。已发生副作用按动作类别补偿，不改历史记录。。

**增量来源：** [U02] 用户追加“还需要有一个详尽的运营后台”；本版工程细化。

<a id="task-n15-34"></a>
### N15-34 环境、容量、备份与隔离恢复台

**状态：** `TODO`　**依赖：** N15-04, N15-05, N13-05, N13-06。  
**需求：** V04-48, V04-47, V04-40。  
**版本：** v0.4新增。  
**专项门：** O1。  
**代码落点：** 复用现有 `apps/web/src/app/admin/page.tsx`（开工复核）、`apps/api/`、`packages/contracts`／`domain`／`db`／`sdk`；运营子路由与实体为拟新增。

**实现内容：** 环境/部署/schema版本、队列容量和存储水位、备份校验、RPO/RTO目标和真实演练证据；恢复先隔离环境，验证媒体/DB/账本/删除标记，生产审批与回滚预检。

**验收／负面路径：** 测试入口不能恢复生产；仅有备份文件不通过恢复门；演练按实际耗时/缺口记录；恢复已删素材标记仍有效；无裸SQL/shell面板。

**角色与授权：** 可靠性、发布管理员、安全复核。

**接口／动作边界：** ops environments/backups/recovery-runs；approved restore rehearsal。

**数据对象：** DeploymentRecord、BackupRecord、RecoveryEvidence。

**回退与补偿：** 关闭对应运营写能力；保留追加式证据。已发生副作用按动作类别补偿，不改历史记录。。

**增量来源：** [U02] 用户追加“还需要有一个详尽的运营后台”；本版工程细化。

<a id="task-n15-35"></a>
### N15-35 开发者API、客户Key与事件诊断

**状态：** `TODO`　**依赖：** N15-18, N15-32。  
**需求：** V04-46, V04-49, V04-30。  
**版本：** v0.4新增。  
**专项门：** 开放客户API前/O1。  
**代码落点：** 复用现有 `apps/web/src/app/admin/page.tsx`（开工复核）、`apps/api/`、`packages/contracts`／`domain`／`db`／`sdk`；运营子路由与实体为拟新增。

**实现内容：** 复用统一API版本、scope/配额/用量查看，客户Key创建/轮换/撤销和外部回调诊断；Key后续只显指纹，端能力状态、幂等与签名版本可追查。

**验收／负面路径：** API调用不能凭ops角色绕过客户scope；撤销即时有效；导出与错误无明文Key；测试请求隔离生产费用；未支持版本返回明确迁移说明。

**角色与授权：** 客户Admin、集成支持。

**接口／动作边界：** ops developer-integrations/api-usage；key rotation actions。

**数据对象：** ApiCredentialRef、ApiUsageEvent、WebhookVersion。

**回退与补偿：** 关闭对应运营写能力；保留追加式证据。已发生副作用按动作类别补偿，不改历史记录。。

**增量来源：** [U02] 用户追加“还需要有一个详尽的运营后台”；本版工程细化。

<a id="task-n15-36"></a>
### N15-36 后台批量、敏感导出和下载审计

**状态：** `TODO`　**依赖：** N15-06, N15-04, N15-05。  
**需求：** V04-31, V04-30, V04-29, V04-49。  
**版本：** v0.4新增。  
**专项门：** O1。  
**代码落点：** 复用现有 `apps/web/src/app/admin/page.tsx`（开工复核）、`apps/api/`、`packages/contracts`／`domain`／`db`／`sdk`；运营子路由与实体为拟新增。

**实现内容：** 通用批次固定目标ID和字段scope、预检数量/费用、审批、逐项状态、暂停/取消；导出异步权限复核、脱敏、期限、下载日志和CSV公式注入处理，下载前再次校验。

**验收／负面路径：** 执行时新进入筛选的用户不被误操作；部分失败不标全成功；导出字段不能绕过页面权限；过期/撤权后URL访问失败；隐私敏感批量不能自批。

**角色与授权：** 经scope许可操作者、独立审批人。

**接口／动作边界：** ops exports/batches＋AdminAction。

**数据对象：** DataExportJob、BatchTargetSnapshot、DownloadAudit。

**回退与补偿：** 关闭对应运营写能力；保留追加式证据。已发生副作用按动作类别补偿，不改历史记录。。

**增量来源：** [U02] 用户追加“还需要有一个详尽的运营后台”；本版工程细化。

<a id="task-n15-37"></a>
### N15-37 O0最小安全运营台垂直验收

**状态：** `TODO`　**依赖：** N15-02, N15-03, N15-04, N15-05, N15-06, N15-08, N15-10, N15-12, N15-13, N15-14, N15-16, N15-17, N15-18, N15-21, N15-24, N15-33。  
**需求：** V04-50, V04-51, V04-27, V04-35。  
**版本：** v0.4新增。  
**专项门：** O0。  
**代码落点：** 复用现有 `apps/web/src/app/admin/page.tsx`（开工复核）、`apps/api/`、`packages/contracts`／`domain`／`db`／`sdk`；运营子路由与实体为拟新增。

**实现内容：** 以两个租户、两个ops角色与真实失败任务演练：客户工单→脱敏诊断→批准范围恢复→用量核对→结果通知；包含止损和原件/冻结保护，不要求所有专业编辑功能先完成。

**验收／负面路径：** 浏览器/服务端权限和真实文件证据齐备；无需SQL改状态；越权、双扣、原件误删为硬失败；内部使用的未启用功能标明边界。

**角色与授权：** 客服、制作运维、安全验收。

**接口／动作边界：** O0 acceptance runner与ops实际API。

**数据对象：** GateEvidence O0、各模块审计记录。

**回退与补偿：** 关闭对应运营写能力；保留追加式证据。已发生副作用按动作类别补偿，不改历史记录。。

**增量来源：** [U02] 用户追加“还需要有一个详尽的运营后台”；本版工程细化。

<a id="task-n15-38"></a>
### N15-38 O1收费与治理运营验收

**状态：** `TODO`　**依赖：** N15-37, N15-11, N15-19, N15-20, N15-22, N15-25, N15-26, N15-27, N15-30, N15-31, N15-32, N15-34, N15-35, N15-36。  
**需求：** V04-50, V04-51, V04-38, V04-40。  
**版本：** v0.4新增。  
**专项门：** O1。  
**代码落点：** 复用现有 `apps/web/src/app/admin/page.tsx`（开工复核）、`apps/api/`、`packages/contracts`／`domain`／`db`／`sdk`；运营子路由与实体为拟新增。

**实现内容：** 闭合订阅/付款/权益/退款审批对账、隐私导出/删除、账号和审核申诉、事务通知、集成恢复、受控导出和隔离恢复；明确按实际启用渠道/身份/Provider的真实与沙箱证据。

**验收／负面路径：** 重复/乱序财务事件、审批篡改、访问撤销、备份复活删除等负例全覆盖；无真实账号时对应能力不开放，不能把沙箱门当已生产收款。

**角色与授权：** 财务双人、客服、隐私、可靠性。

**接口／动作边界：** O1 acceptance runner与实际ops API。

**数据对象：** GateEvidence O1、Refund/Privacy/Recovery evidence。

**回退与补偿：** 关闭对应运营写能力；保留追加式证据。已发生副作用按动作类别补偿，不改历史记录。。

**增量来源：** [U02] 用户追加“还需要有一个详尽的运营后台”；本版工程细化。

<a id="task-n15-39"></a>
### N15-39 O2增长、策略和AI质量运营验收

**状态：** `TODO`　**依赖：** N15-38, N15-09, N15-23, N15-28, N15-29, N15-30, N15-31。  
**需求：** V04-50, V04-51, V04-42, V04-43, V04-44。  
**版本：** v0.4新增。  
**专项门：** O2。  
**代码落点：** 复用现有 `apps/web/src/app/admin/page.tsx`（开工复核）、`apps/api/`、`packages/contracts`／`domain`／`db`／`sdk`；运营子路由与实体为拟新增。

**实现内容：** 验证完整漏斗/留存与贡献报告，模型/策略草案→回归→灰度→回滚，营销同意/抑制/去重；治理须在相关功能启用前提前落地，不将O2当安全豁免。

**验收／负面路径：** 24模块均有范围/状态/操作证据；价格和模型配置不改旧作品；没有足够样本不造增长结论；未经同意私片不进入评测集。

**角色与授权：** 经营、增长、AI质量、内容运营。

**接口／动作边界：** O2 acceptance runner与模块API。

**数据对象：** GateEvidence O2、Metric/Eval/Release evidence。

**回退与补偿：** 关闭对应运营写能力；保留追加式证据。已发生副作用按动作类别补偿，不改历史记录。。

**增量来源：** [U02] 用户追加“还需要有一个详尽的运营后台”；本版工程细化。

<a id="task-n15-40"></a>
### N15-40 运营全流程角色回归、runbook与最终交接

**状态：** `TODO`　**依赖：** N15-39, N15-36。  
**需求：** V04-51, V04-50, V04-49, V04-30, V04-59, V04-63。  
**版本：** v0.4新增；v0.4显式补充，旧证据不清零。  
**专项门：** O2。  
**代码落点：** 复用现有 `apps/web/src/app/admin/page.tsx`（开工复核）、`apps/api/`、`packages/contracts`／`domain`／`db`／`sdk`；运营子路由与实体为拟新增。

**实现内容：** 逐项跑O-E01—20及24模块清单；记录角色矩阵、实际命令、浏览器证据、日志/输出指纹、生产/测试分界、数据迁移和runbook；由真实操作流程证明后台可运营。

**验收／负面路径：** 任一关键流程需直接改DB或越权才解决则不通过；未支持模块/Provider写明BLOCKED；报告不把O0或mock通过宣称详尽后台完工。

**v0.4增量要求：** 增加24模块主题/密度/状态一致性清单，功能验收与D1视觉验收分别记录，不互相冒充。

**v0.4追加验收：** O2是运营功能完整门，D1是设计完整门；不制造互相依赖死锁。

**角色与授权：** 全部职责验收角色。

**接口／动作边界：** ops end-to-end suite、read-only acceptance report。

**数据对象：** OpsAcceptanceLedger、RunbookIndex、Handoff。

**回退与补偿：** 关闭对应运营写能力；保留追加式证据。已发生副作用按动作类别补偿，不改历史记录。。

**增量来源：** [U02] 用户追加“还需要有一个详尽的运营后台”；本版工程细化。


<a id="phase-n16"></a>
## N16｜苹果式极简黑白设计系统（横切推进：Studio／Workspace／Ops）

**验收门：** D0／D1；与核心和后台同步，不在所有App后等待　**优先级：** P0主题与组件／P1页面与真实验收。

**共用失败／回滚规则：** 按组件和路由增量替换；回退外观不重置项目、权限、选区、账本或已确认资产。

<a id="task-n16-01"></a>
### N16-01 设计基线、语义token和禁用样式盘点

**状态：** `TODO`　**依赖：** N00-01。  
**需求：** V04-52, V04-54, V04-56, V04-63。  
**版本：** v0.4新增。  
**专项门：** D0。  
**代码落点：** 复用现有 `apps/web/src/app/globals.css`、UI组件、前端主题配置与测试；共享token模块为拟新增，先检查现有落点。

**实现内容：** 按§29建立颜色/排版/间距/圆角/密度/动效token；盘点现有硬编码色、组件、路由和残留模板；区分ui和content命名空间，建立渐进替换顺序。

**验收／负面路径：** light/dark语义键一一对应；指定正文/边界对比度静态通过；违规扫描仅针对UI样式不拦媒体颜色；未读页面不标已迁移。

**回退与补偿：** 按组件/路由特性开关回退；保留业务接口、项目状态与用户主题偏好；禁止重置项目或删验收来迁移视觉。。

**增量来源：** [U03] 用户要求苹果式极简白／黑，拒绝花哨设计；本版工程细化。

<a id="task-n16-02"></a>
### N16-02 外观偏好、系统主题与首屏初始化

**状态：** `TODO`　**依赖：** N16-01。  
**需求：** V04-53, V04-54, V04-63。  
**版本：** v0.4新增。  
**专项门：** D0。  
**代码落点：** 复用现有 `apps/web/src/app/globals.css`、UI组件、前端主题配置与测试；共享token模块为拟新增，先检查现有落点。

**实现内容：** 实现system/light/dark、设备覆盖与账号偏好优先级、prefers-color-scheme监听及SSR兼容首屏；系统默认缺失回退light；Native后续映射同语义。

**验收／负面路径：** 刷新和首屏无错色闪烁/hydration问题；两个设备各自遵守system；切主题不改变项目hash、播放epoch、选区和账本；退出不泄露另一用户偏好。

**回退与补偿：** 按组件/路由特性开关回退；保留业务接口、项目状态与用户主题偏好；禁止重置项目或删验收来迁移视觉。。

**增量来源：** [U03] 用户要求苹果式极简白／黑，拒绝花哨设计；本版工程细化。

<a id="task-n16-03"></a>
### N16-03 中文字体、数字排版与合法图标规范

**状态：** `TODO`　**依赖：** N16-01。  
**需求：** V04-55, V04-56, V04-62。  
**版本：** v0.4新增。  
**专项门：** D0。  
**代码落点：** 复用现有 `apps/web/src/app/globals.css`、UI组件、前端主题配置与测试；共享token模块为拟新增，先检查现有落点。

**实现内容：** 采用系统字体回退、正文/标题/表格尺度、tabular numbers和技术ID等宽；复用已许可图标并统一stroke，记录字体图标来源及部署范围。

**验收／负面路径：** Windows/macOS字体回退、长中文/英文/文件名、金额符号完整；无Apple字体文件打包下载；无跨平台未授权图标；200%文本不丢关键字段。

**回退与补偿：** 按组件/路由特性开关回退；保留业务接口、项目状态与用户主题偏好；禁止重置项目或删验收来迁移视觉。。

**增量来源：** [U03] 用户要求苹果式极简白／黑，拒绝花哨设计；本版工程细化。

<a id="task-n16-04"></a>
### N16-04 单色共享组件全状态与键盘支持

**状态：** `TODO`　**依赖：** N16-02, N16-03。  
**需求：** V04-54, V04-56, V04-57, V04-62。  
**版本：** v0.4新增。  
**专项门：** D0。  
**代码落点：** 复用现有 `apps/web/src/app/globals.css`、UI组件、前端主题配置与测试；共享token模块为拟新增，先检查现有落点。

**实现内容：** 增量迁移Button/Input/Select/Switch/Checkbox/Tab/Dialog/Drawer/Toast/Status/Progress/Table/CommandPalette；实现全部状态、双线焦点与无色彩依赖错误。

**验收／负面路径：** light/dark各状态可读；触控命中/键盘顺序/焦点恢复正确；禁用原因可访问；危险操作与录音状态不能仅凭颜色；组件迁移不改权限流程。

**回退与补偿：** 按组件/路由特性开关回退；保留业务接口、项目状态与用户主题偏好；禁止重置项目或删验收来迁移视觉。。

**增量来源：** [U03] 用户要求苹果式极简白／黑，拒绝花哨设计；本版工程细化。

<a id="task-n16-05"></a>
### N16-05 动效约束、降低动画与性能基线

**状态：** `TODO`　**依赖：** N16-04。  
**需求：** V04-61, V04-62。  
**版本：** v0.4新增。  
**专项门：** D0。  
**代码落点：** 复用现有 `apps/web/src/app/globals.css`、UI组件、前端主题配置与测试；共享token模块为拟新增，先检查现有落点。

**实现内容：** 统一短时过渡和reduced-motion；关闭装饰性持续动画/模糊；主题和抽屉不重复挂载解码器；分离UI动画和作品内容动画。

**验收／负面路径：** reduced-motion关闭非必要运动且反馈仍在；暂停/取消不等动效；同段播放开关抽屉不产生额外Provider调用或GPU缓存泄漏。

**回退与补偿：** 按组件/路由特性开关回退；保留业务接口、项目状态与用户主题偏好；禁止重置项目或删验收来迁移视觉。。

**增量来源：** [U03] 用户要求苹果式极简白／黑，拒绝花哨设计；本版工程细化。

<a id="task-n16-06"></a>
### N16-06 共看片室、语音与试改界面迁移

**状态：** `TODO`　**依赖：** N16-04, N16-05, N04-01。  
**需求：** V04-52, V04-58, V04-57, V04-63。  
**版本：** v0.4新增。  
**专项门：** D1-Studio。  
**代码落点：** 复用现有 `apps/web/src/app/globals.css`、UI组件、前端主题配置与测试；共享token模块为拟新增，先检查现有落点。

**实现内容：** 将新Studio壳、空项目、播放条、麦克风、AI短回应、采用/拒绝与全片审阅映射单色组件；选中只显示轻标签，不默认大Inspector。

**验收／负面路径：** 真实素材可导入/播放/试改；黑白主题不盖主体；录音开关和取消持续可达；无彩色波形、装饰卡片；视觉改版不变作品与版本。

**回退与补偿：** 按组件/路由特性开关回退；保留业务接口、项目状态与用户主题偏好；禁止重置项目或删验收来迁移视觉。。

**增量来源：** [U03] 用户要求苹果式极简白／黑，拒绝花哨设计；本版工程细化。

<a id="task-n16-07"></a>
### N16-07 专业时间轴、Inspector与选区样式迁移

**状态：** `TODO`　**依赖：** N16-04, N04-07, N04-09。  
**需求：** V04-58, V04-56, V04-62。  
**版本：** v0.4新增。  
**专项门：** D1-Pro。  
**代码落点：** 复用现有 `apps/web/src/app/globals.css`、UI组件、前端主题配置与测试；共享token模块为拟新增，先检查现有落点。

**实现内容：** 实现中性轨道/片段/波形、双描边选区、清楚playhead/关键帧/曲线与数值；原缩略保色，可选Clip标签不污染全站；浅深与密度统一。

**验收／负面路径：** 暗片/白片/透明片上可定位；精确字段、单位、键盘与拖柄无丢失；关闭高级视图保留效果和关键帧；范围映射不受圆角/缩放影响。

**回退与补偿：** 按组件/路由特性开关回退；保留业务接口、项目状态与用户主题偏好；禁止重置项目或删验收来迁移视觉。。

**增量来源：** [U03] 用户要求苹果式极简白／黑，拒绝花哨设计；本版工程细化。

<a id="task-n16-08"></a>
### N16-08 运营台24模块视觉基础与审批流程迁移

**状态：** `TODO`　**依赖：** N16-04, N15-06。  
**需求：** V04-52, V04-59, V04-57, V04-63。  
**版本：** v0.4新增。  
**专项门：** D1-Ops。  
**代码落点：** 复用现有 `apps/web/src/app/globals.css`、UI组件、前端主题配置与测试；共享token模块为拟新增，先检查现有落点。

**实现内容：** 将六组导航、表格/详情/筛选/批量/审批/审计/危险动作接入同token；加入舒适/紧凑密度；环境/角色/scope/金额信息持续可读。

**验收／负面路径：** 退款、数据删除、重试在黑白中仍有完整预检；无彩色KPI模板残留；表格排序分页金额准确；所有24模块的适用UI覆盖由D1总门巡检。

**回退与补偿：** 按组件/路由特性开关回退；保留业务接口、项目状态与用户主题偏好；禁止重置项目或删验收来迁移视觉。。

**增量来源：** [U03] 用户要求苹果式极简白／黑，拒绝花哨设计；本版工程细化。

<a id="task-n16-09"></a>
### N16-09 Workspace设置、身份录入与付款风格统一

**状态：** `TODO`　**依赖：** N16-04, N15-11。  
**需求：** V04-59, V04-55, V04-57, V04-63。  
**版本：** v0.4新增。  
**专项门：** D1-Settings。  
**代码落点：** 复用现有 `apps/web/src/app/globals.css`、UI组件、前端主题配置与测试；共享token模块为拟新增，先检查现有落点。

**实现内容：** 迁移用户设置、团队、声音/数字人录入、试听、授权验证、套餐与费用页；保留跳过与错误恢复，使用统一字段与章节层级。

**验收／负面路径：** 有/无数字人均能继续；授权与收费信息不藏tooltip；长中文和错误状态不溢出；客户管理无平台权限，样式迁移不改变业务。

**回退与补偿：** 按组件/路由特性开关回退；保留业务接口、项目状态与用户主题偏好；禁止重置项目或删验收来迁移视觉。。

**增量来源：** [U03] 用户要求苹果式极简白／黑，拒绝花哨设计；本版工程细化。

<a id="task-n16-10"></a>
### N16-10 数据可视化单色编码与媒体主题隔离

**状态：** `TODO`　**依赖：** N16-01, N16-02。  
**需求：** V04-54, V04-60, V04-58。  
**版本：** v0.4新增。  
**专项门：** D0。  
**代码落点：** 复用现有 `apps/web/src/app/globals.css`、UI组件、前端主题配置与测试；共享token模块为拟新增，先检查现有落点。

**实现内容：** 统一运营图表的线型/点形/纹理/标签和表格替代；建立UI/content主题隔离检查；保留实际视频、封面、LUT/色轮和用户作品主题。

**验收／负面路径：** 多系列无颜色也能辨识；切UI主题前后原媒体像素/项目hash/生成参数不变；不存在祖先grayscale/invert/brightness；无数据不绘成零。

**回退与补偿：** 按组件/路由特性开关回退；保留业务接口、项目状态与用户主题偏好；禁止重置项目或删验收来迁移视觉。。

**增量来源：** [U03] 用户要求苹果式极简白／黑，拒绝花哨设计；本版工程细化。

<a id="task-n16-11"></a>
### N16-11 跨主题真实浏览器与可访问性设计回归

**状态：** `TODO`　**依赖：** N16-05, N16-06, N16-07, N16-08, N16-09, N16-10, N00-06。  
**需求：** V04-53, V04-54, V04-55, V04-61, V04-62, V04-63。  
**版本：** v0.4新增。  
**专项门：** D1。  
**代码落点：** 复用现有 `apps/web/src/app/globals.css`、UI组件、前端主题配置与测试；共享token模块为拟新增，先检查现有落点。

**实现内容：** 执行D-E01—12：两主题/系统、各状态、Windows/macOS、长中文、200%缩放、键盘/触控、高对比、降低动画和视频原色隔离；记录截图及实际交互。

**验收／负面路径：** 指定色对计算和浏览器结果分开；任何看不清/不可达/改坏作品为失败；不得只跑截图；未测试浏览器明确范围，不无证宣称全站WCAG合规。

**回退与补偿：** 按组件/路由特性开关回退；保留业务接口、项目状态与用户主题偏好；禁止重置项目或删验收来迁移视觉。。

**增量来源：** [U03] 用户要求苹果式极简白／黑，拒绝花哨设计；本版工程细化。

<a id="task-n16-12"></a>
### N16-12 全站视觉迁移账本、模块完整性与设计交接

**状态：** `TODO`　**依赖：** N16-11, N15-40, N12-08。  
**需求：** V04-52, V04-59, V04-63。  
**版本：** v0.4新增。  
**专项门：** D1完整门；随模块推进，不阻塞基础内核。  
**代码落点：** 复用现有 `apps/web/src/app/globals.css`、UI组件、前端主题配置与测试；共享token模块为拟新增，先检查现有落点。

**实现内容：** 逐项覆盖Studio/专业工具/Workspace/24Ops模块及登录付款等辅助页；输出token版本、组件状态矩阵、许可清单、移除旧样式记录和回退说明。

**验收／负面路径：** D0早期基础可独立验收；D1完整设计须功能/角色/交互全覆盖；不能以全部换色但功能缺失结案；Native未测不计支持。

**回退与补偿：** 按组件/路由特性开关回退；保留业务接口、项目状态与用户主题偏好；禁止重置项目或删验收来迁移视觉。。

**增量来源：** [U03] 用户要求苹果式极简白／黑，拒绝花哨设计；本版工程细化。

---

