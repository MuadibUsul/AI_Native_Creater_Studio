# 面向全球市场：AI 生成标识随导出语言 + 界面语言兜底英文

- **起因：** 所有者 2026-10-22 回答 D-01：面向全球市场，不服务中国大陆用户（`docs/OWNER_ACTION_ITEMS.md` D-01）。
- **状态：** VERIFIED（单元 + 集成 + 真实浏览器；真实 FFmpeg 渲染的成片逐帧目检）。

## 目标

1. 成片含 AI 生成内容时，开头角标不再固定为中文"AI生成"：英文界面与 API 缺省用 "AI-generated"，中文界面仍用"AI生成"。
2. 既非中文也非英文的浏览器（如德语、法语）首次打开时看英文界面，而不是中文。
3. 文档记录 D-01 决定，把只适用于中国大陆的事项（D-10、L-02、L-03、B-02）标为不需要，L-04（欧盟）升为 P1。

## 实现（按 contracts → domain → API/SDK → UI → tests → docs）

- contracts：`CONTENT_LABEL_LANGUAGES`、`contentLabelLanguageSchema`、`AIGC_EXPLICIT_TEXT`（`en: 'AI-generated'`、`zh: 'AI生成'`）；`contentLabelSchema.explicitText` 只接受这两种固定文案；`startCompositionFinalRenderRequestSchema` 新增可选 `labelLanguage`。
- migration：不适用（语言随工作流运行输入保存）。
- domain：`startCompositionFinalRender` 把 `labelLanguage` 存进运行输入；`contentLabelFor` 按语言取文案，缺省英文；元数据（`AIGC` 七个键）与语言无关。
- API / SDK：沿用同一请求契约，无需改代码。
- worker：字体缺失时的报错不再写死"AI生成"（两种文案共用一款中文字体）。
- web：导出时按当前界面语言传 `labelLanguage`；导出面板说明显示实际加上的文案（`data-aigc-label` 为该文案）；`negotiateLocale` 兜底改为英文（`FALLBACK_LOCALE`）。

## 验收与命令

| 命令 | 结果 |
|---|---|
| `pnpm -s typecheck` | 通过 |
| `pnpm -s lint` | 通过 |
| `npx vitest run --project unit packages/domain/src/content-label.test.ts apps/worker/src/render-plan/ffmpeg-graph.test.ts` | 22 / 22 通过 |
| `npx vitest run --project web` | 55 个文件 / 334 个测试通过（新增 `apps/web/src/i18n/locale.test.ts`） |
| `npx vitest run --project integration apps/worker/src/narration.integration.test.ts apps/worker/src/composition-final-render.integration.test.ts`（需 `REMOTION_BROWSER_EXECUTABLE`） | 全部通过；未传语言的导出角标为 "AI-generated"，QA 读回 `AIGC` 元数据 |
| `ANCS_EVIDENCE_DIR=docs/verification/artifacts/global-label node scripts/narration-browser-check.mjs` | 7 / 7 通过：中文界面导出角标"AI生成"，英文界面导出角标 "AI-generated"，两次下载的成片都有 `AIGC` 元数据 Label=1 |

## 证据（`docs/verification/artifacts/global-label/`）

- `05b-export-ai-labelled.png`：中文界面导出完成，说明写明加了"AI生成"。
- `05c-export-frame-1s.png`：中文界面导出的成片第 1 秒，左上角"AI生成"。
- `06b-export-english.png`：英文界面导出完成，说明写明加了 "AI-generated"。
- `06c-export-frame-1s-en.png`：英文界面导出的成片第 1 秒，左上角 "AI-generated"。

## 交接

- 欧盟用户的机器可读标识（C2PA）仍未接入，等所有者按 L-04 取得法务意见与签名证书。
- `ANCS_AIGC_PRODUCER_CODE` 不面向中国大陆时可不配；Worker 生产启动时的一行提示保留（将来进入中国大陆市场时仍有用）。
- 数据存放区域（D-01 剩余部分）待所有者决定。
