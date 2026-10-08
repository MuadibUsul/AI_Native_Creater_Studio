# v0.4 专业制作能力差项与发布门

**状态：** N00-05 基础设施 `VERIFIED`；建立于 2026-10-08。权威范围为 [`ANCS_AI_Native_v0.4.md`](../V04/ANCS_AI_Native_v0.4.md) §6、§21 和任务 N00-05。本表是实施与验收索引，不把竞品功能、代码入口或外部工程往返计作 ANCS 已交付能力。N00-05 已交付差项账本、服务端发布门和工作区偏好；各专业能力及 G0—G4 仍按各自任务证据推进。

## 记录规则

- 能力状态使用规范 §6.3 的 `PLANNED`、`PROTOTYPE`、`INTERNAL_VALIDATED`、`PRODUCTION_SUPPORTED`。没有“底层执行、直接控制、预览、撤销、导出”五项证据时，不升为后两级。
- 每条按 **ANCS 版本、平台、输入、限制、执行后端、样例、证据** 维护。当前目标是 `ANCS v0.4 / Web`；Desktop、Mobile 留独立行，不能继承 Web 状态。
- `Nxx-yy` 指负责补齐的任务，不表示任务已验证。真实状态以 [`ai-native-v04-acceptance-ledger.md`](ai-native-v04-acceptance-ledger.md) 为准。
- Premiere、剪映／CapCut 的下方链接是 **2026-10-08 官方在线文档抽样**，不是安装指定构建号后的跨平台实测。网页没有统一的产品构建号，故版本记录为“在线文档，具体构建号未核”；不据此断言所有平台或订阅层级。

## 官方文档抽样与平台/版本边界

| 参考产品 | 文档所指平台、版本 | 此次有官方文档证据的行为 | 官方来源 |
|---|---|---|---|
| Adobe Premiere | Desktop；页面更新 2025-10-19，构建号未核 | 多机位目标序列、播放中切换机位 | [创建与编辑多机位目标序列](https://helpx.adobe.com/ie/premiere/desktop/edit-projects/set-up-multi-camera-sequences-for-editing/create-and-edit-a-multi-camera-target-sequence.html) |
| Adobe Premiere | Desktop；页面更新 2026-01-07，构建号未核 | 建立并挂接代理、原片与低分辨率代理切换 | [代理工作流](https://helpx.adobe.com/premiere/desktop/organize-media/ingest-proxy-workflow/ingest-and-proxy-workflow.html) |
| Adobe Premiere | Desktop；页面更新 2026-01-07，构建号未核 | 时间重映射速度关键帧与 Bézier 过渡 | [时间重映射](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-speed/change-clip-speed-and-duration-using-time-remapping.html) |
| Adobe Premiere | Desktop；页面更新 2026-03-17，构建号未核 | 蒙版跟踪 | [跟踪蒙版](https://helpx.adobe.com/in/premiere/desktop/add-video-effects/work-with-masks/track-masks.html) |
| CapCut | Desktop；在线指南，构建号未核 | 关键帧、蒙版、HSL/曲线、曲线变速、导出 | [桌面编辑指南](https://www.capcut.com/resource/how-to-use-capcut) |

这五条只建立对照起点；其他专业域目前仍由 v0.4 §6 作为目标范围，竞品分平台/版本证据待 N12 持续补齐。尤其不能将 CapCut Desktop 网页结论复制到移动端或 Web。

## ANCS v0.4 / Web 差项索引

下面的“目前等级”审慎标记为 `PLANNED`，意为 **尚无该专业目标的五项联合验收证据**，不否认旧版本存在局部接口或 UI。具体单项通过时在同一行加入输入、限制、执行后端和验证文件，再改等级。

| 专业目标 | 目前等级 | 主要实现任务 | 必须补齐的验收证据 |
|---|---|---|---|
| 批量素材、代理、回链、索引、集合 | IN_PROGRESS | N02-01/02/03/04/06/10、N12-06 | N02-01 已验证批量分片直传、会话内恢复和原件 hash；N02-02 已验证真实探测；N02-03 已验证标准代理、PTS 映射、原件回退与代理丢失重建；N02-04 已验证源时间缩略、波形、镜头/质量索引、分页和失败隔离；语义检索、统一索引与集合仍待后续任务 |
| 原素材片段插入、覆盖、追加、拆分、裁剪与 Undo | PLANNED | N01-03/06/08、N03-01/02/07 | 真实源片的片段范围、预览、撤销、导出一致 |
| ripple、roll、slip、slide、吸附、逐帧、J/L cut | PLANNED | N03-03、N04-07、N11-01 | 边界编辑、原声同步和失败回滚；无范围外改动 |
| 多视频/音频轨、目标轨、嵌套、组与锁定 | PLANNED | N01-03、N03-04、N11-01、N12-05 | 多轨冲突、锁定保护、预览与导出一致 |
| 变换、裁切、锚点、透视、画中画 | PLANNED | N03-05、N11-01/09 | 参数可直接控制；多画幅预览/导出一致 |
| 线性、保持、Bézier、路径与语义关键帧 | PLANNED | N03-05、N08-02、N11-09 | 可编辑曲线、撤销及确定性输出 |
| 恒速/曲线变速、倒放、定格、补帧许可 | PLANNED | N01-01/03、N11-02 | VFR/分数帧率/音频策略与无累计漂移；缺许可拒绝 |
| 字幕转写、逐词、双语、SRT/VTT 与独立开关 | PLANNED | N02-05、N03-06、N11-04 | 时间锚、编辑、字幕开关及可读导出 |
| 蒙版、绿幕、混合模式、调整层与局部效果 | PLANNED | N04-06、N11-03、N12-01/02 | 选区边缘、局部有效、范围外像素保留 |
| 对象分割与跨帧跟踪 | PLANNED | N04-02/06、N11-03 | 目标丢失/遮挡可修正，失败不污染正式版本 |
| 生成式局部移除、补全、替换与一致性 | PLANNED | N08-07/09/10、N11-10/13 | 授权/报价/可撤销/不干扰及真实 Provider 证据 |
| 色彩、LUT、曲线、示波器、镜头匹配与 HDR | PLANNED | N11-07、N12-02/04/05 | 色彩空间声明、画面原色保护与输出对照 |
| 原音保护、淡变、混音与 ducking | PLANNED | N03-04/06、N09-04 | 独立音轨同步、响度/削波及导出试听 |
| EQ、压缩、降噪、真峰值、总线与 stems | PLANNED | N11-08、N12-04/05 | 参数、波形/试听与分轨导出一致 |
| 多机位同步、漂移修正、机位切换 | PLANNED | N11-05/06 | 多相机真实源、主音频锁定、长时漂移及导出 |
| 中间码、图像序列、高位深/多声道/RAW | IN_PROGRESS | N02-02、N12-04/05 | N02-02 已验证容器内容探测、旋转、VFR 与 48 kHz 5.1 并显式区分能力；中间码、图像序列、高位深/RAW、许可及真实导出/再导入仍待后续任务 |
| 360/空间视频与扩展合成 | PLANNED | N12-05/07 | 投影/声场保持与插件隔离、失败回退 |
| 多画幅、批量交付、版本与工程交换 | PLANNED | N09-06、N12-03、N14-01/02 | 真实产物、manifest、版本恢复及损失可见性 |

**外部往返：** 如未来借助 Premiere/剪映完成任何一行，应另记 `EXTERNAL_ROUND_TRIP` 路径、格式损失和再导入结果，不改该行的 ANCS 原生等级。没有外部软件实测时也不能把此路径标为可用。

## 发布门与工作区功能开关

| 门 | 必须成立的任务/证据 | 当前状态 |
|---|---|---|
| G0 素材剪辑 | N03-10，含 N03-16 基础播放/同步；内部真实使用还需 O0/N15-37 | 未通过 |
| G1 AI 共看片室 | N04-10、N06-11、N07-11/12/13 与真实语音门 | 未通过 |
| G2 三模式与策略 | N10-13、N09-11、适用真实生成报价/授权门 | 未通过 |
| G3 专业能力 | N03-14/15、N13-11、N11-13，逐项差项证据 | 未通过 |
| G4 对外/多端 | 安全、账本、真实 Provider、可靠性、目标端；对外收费至少 O1/N15-38 | 未通过 |
| D0/D1 设计 | N16-01—05/10 地基及 N16-11/12 真实浏览器/全页面 | 未通过 |

稳定能力键与服务端语义已经实现：

| 能力键 | 发布门 | 当前有效状态上限 |
|---|---|---|
| `V04_MEDIA_EDITING` | G0 | `READ_ONLY` |
| `V04_AI_COWATCH` | G1 | `READ_ONLY` |
| `V04_THREE_MODES` | G2 | `READ_ONLY` |
| `V04_PRO_TOOLS` | G3 | `READ_ONLY` |
| `V04_EXTERNAL_DELIVERY` | G4 | `READ_ONLY` |

偏好默认关闭；未选择为 `OFF`，已选择但发布门未过为 `READ_ONLY`，只有服务端注册表明确将对应门标记为通过后才返回 `ENABLED`。domain 的 `assertWorkspaceFeatureWriteAllowed` 负责真实写入和报价入口的固定拒绝，API/SDK 只传达服务端状态，UI 不自行授权。真实隔离库回归已经证明选择、关闭或发布门阻塞都不影响旧项目读取，跨租户读取和更新统一 404。回滚只需保持发布门阻塞或隐藏入口，不能删除版本、媒体、项目、偏好或已有授权。

当前五个门均为“未通过”，所以本表任何专业能力仍不得因为用户选择开关而升级等级。生产开关审批、灰度、观察和回滚由 N15-30 继续实现。
