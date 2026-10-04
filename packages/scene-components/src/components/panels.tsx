import type { ReactElement } from 'react';
import { z } from 'zod';
import { defineComponent, type ComponentRenderInput } from '../protocol.js';
import { BodyText, CardShell, fitFontSize, Headline, Kicker, Placeholder, SceneRoot, SourceLabel } from '../primitives.js';
import { useSceneTheme } from '../theme.js';

/**
 * 结构/证据/时间类组件（P05-02）：
 * CHAPTER_TITLE / SUMMARY / NEWS_HEADLINE / SOURCE_CARD / QUOTE_CARD / DOCUMENT_HIGHLIGHT / TIMELINE。
 *
 * 纪律：证据类（Source/Quote/Document/News）内容逐字来自 props（来源可追溯）；空内容 → 占位。
 */

/* ---------- CHAPTER_TITLE ---------- */

export const chapterTitlePropsSchema = z.object({
  title: z.string().max(80).default(''),
  subtitle: z.string().max(160).nullable().default(null),
  index: z.number().int().positive().nullable().default(null),
});
export type ChapterTitleProps = z.infer<typeof chapterTitlePropsSchema>;

export function ChapterTitleScene({ props }: ComponentRenderInput<ChapterTitleProps>): ReactElement {
  const theme = useSceneTheme();
  if (props.title === '') {
    return (
      <SceneRoot>
        <Placeholder text="章节标题待补充" />
      </SceneRoot>
    );
  }
  return (
    <SceneRoot>
      <div style={{ width: '72%', display: 'flex', flexDirection: 'column', gap: theme.spacing.md }}>
        {props.index !== null ? <Kicker text={`第 ${String(props.index)} 章`} /> : null}
        <div
          data-role="headline"
          style={{ fontFamily: theme.font.heading, fontWeight: 700, fontSize: fitFontSize(props.title, { max: 104, min: 44, comfortableChars: 12 }), lineHeight: 1.15 }}
        >
          {props.title}
        </div>
        <div style={{ height: 6, width: 220, backgroundColor: theme.color.accent, borderRadius: theme.radius.sm }} />
        {props.subtitle !== null ? <BodyText text={props.subtitle} maxFontSize={40} /> : null}
      </div>
    </SceneRoot>
  );
}

export const chapterTitleComponent = defineComponent({
  type: 'CHAPTER_TITLE',
  version: '1.0.0',
  title: '章节标题',
  description: '章节转场结构场景（TRANSITION 语义；无旁白）',
  inputSchema: chapterTitlePropsSchema,
  defaults: { title: '', subtitle: null, index: null },
  supportedAspectRatios: ['16:9', '9:16', '1:1', '4:5'],
  minDurationMs: 1500,
  maxDurationMs: 6000,
  previewFixture: { props: { title: '开场与核心事实', subtitle: '利率为什么决定一切', index: 1 }, durationMs: 2500, aspectRatio: '16:9', note: '正常值' },
  renderer: ChapterTitleScene,
});

/* ---------- SUMMARY ---------- */

export const summaryPropsSchema = z.object({
  title: z.string().max(80).default(''),
  points: z.array(z.string().max(200)).default([]),
});
export type SummaryProps = z.infer<typeof summaryPropsSchema>;

export function SummaryScene({ props }: ComponentRenderInput<SummaryProps>): ReactElement {
  const theme = useSceneTheme();
  return (
    <SceneRoot>
      <div style={{ width: '78%', display: 'flex', flexDirection: 'column', gap: theme.spacing.lg }}>
        <Headline text={props.title === '' ? '小结' : props.title} maxFontSize={72} />
        {props.points.length === 0 ? (
          <Placeholder text="要点待补充" />
        ) : (
          <ol data-role="summary-points" style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: theme.spacing.md }}>
            {props.points.map((point, index) => (
              <li key={`${String(index)}-${point}`} data-role="summary-point" style={{ display: 'flex', gap: theme.spacing.md, alignItems: 'flex-start' }}>
                <span style={{ fontFamily: theme.font.heading, fontSize: 44, color: theme.color.accent, fontWeight: 700 }}>{String(index + 1)}</span>
                <BodyText text={point} maxFontSize={34} comfortableChars={40} />
              </li>
            ))}
          </ol>
        )}
      </div>
    </SceneRoot>
  );
}

export const summaryComponent = defineComponent({
  type: 'SUMMARY',
  version: '1.0.0',
  title: '总结卡',
  description: '结论要点列表（TEXTUAL_EXPLANATION 降级的渲染载体；空要点占位）',
  inputSchema: summaryPropsSchema,
  defaults: { title: '', points: [] },
  supportedAspectRatios: ['16:9', '9:16', '1:1', '4:5'],
  minDurationMs: 2500,
  maxDurationMs: 30_000,
  previewFixture: {
    props: { title: '三个观察变量', points: ['通胀路径决定降息节奏', '期限利差尚未倒挂修复', '就业数据是下一步关键'] },
    durationMs: 9000,
    aspectRatio: '16:9',
    note: '正常值：3 条要点',
  },
  renderer: SummaryScene,
});

/* ---------- NEWS_HEADLINE ---------- */

export const newsHeadlinePropsSchema = z.object({
  headline: z.string().max(200).default(''),
  outlet: z.string().max(80).nullable().default(null),
  publishedAt: z.string().max(40).nullable().default(null),
  sourceLabel: z.string().max(200).nullable().default(null),
});
export type NewsHeadlineProps = z.infer<typeof newsHeadlinePropsSchema>;

export function NewsHeadlineScene({ props }: ComponentRenderInput<NewsHeadlineProps>): ReactElement {
  const theme = useSceneTheme();
  if (props.headline === '') {
    return (
      <SceneRoot>
        <Placeholder text="标题待补充" detail="新闻标题必须逐字来自来源" />
      </SceneRoot>
    );
  }
  return (
    <SceneRoot>
      <div style={{ width: '80%', display: 'flex', flexDirection: 'column', gap: theme.spacing.md }}>
        <Kicker text={props.outlet === null ? '报道' : props.outlet} />
        <div
          data-role="headline"
          style={{ fontFamily: theme.font.heading, fontWeight: 700, fontSize: fitFontSize(props.headline, { max: 84, min: 26, comfortableChars: 22 }), lineHeight: 1.2 }}
        >
          {props.headline}
        </div>
        {props.publishedAt !== null ? <div style={{ fontSize: 28, opacity: 0.7 }}>{props.publishedAt}</div> : null}
        <SourceLabel label={props.sourceLabel} />
      </div>
    </SceneRoot>
  );
}

export const newsHeadlineComponent = defineComponent({
  type: 'NEWS_HEADLINE',
  version: '1.0.0',
  title: '新闻标题卡',
  description: '报道标题逐字呈现（含来源/时间；空标题占位）',
  inputSchema: newsHeadlinePropsSchema,
  defaults: { headline: '', outlet: null, publishedAt: null, sourceLabel: null },
  supportedAspectRatios: ['16:9', '9:16', '1:1', '4:5'],
  minDurationMs: 2500,
  maxDurationMs: 20_000,
  previewFixture: {
    props: { headline: '美联储维持联邦基金利率不变', outlet: '示例财经日报', publishedAt: '2026-10-01', sourceLabel: 'news.example/rates' },
    durationMs: 6000,
    aspectRatio: '16:9',
    note: '正常值',
  },
  renderer: NewsHeadlineScene,
});

/* ---------- SOURCE_CARD ---------- */

export const sourceCardPropsSchema = z.object({
  title: z.string().max(160).default(''),
  url: z.string().max(300).nullable().default(null),
  publishedAt: z.string().max(40).nullable().default(null),
  excerpt: z.string().max(400).nullable().default(null),
});
export type SourceCardProps = z.infer<typeof sourceCardPropsSchema>;

export function SourceCardScene({ props }: ComponentRenderInput<SourceCardProps>): ReactElement {
  const theme = useSceneTheme();
  if (props.title === '' && props.url === null && props.excerpt === null) {
    return (
      <SceneRoot>
        <Placeholder text="来源卡（待绑定）" detail="来源信息必须来自 Citation/Source，不得编造" />
      </SceneRoot>
    );
  }
  return (
    <SceneRoot>
      <CardShell>
        <Kicker text="来源" />
        <div
          data-role="headline"
          style={{ fontFamily: theme.font.heading, fontSize: fitFontSize(props.title, { max: 60, min: 24, comfortableChars: 24 }), fontWeight: 700 }}
        >
          {props.title}
        </div>
        {props.publishedAt !== null ? <div style={{ fontSize: 28, opacity: 0.7 }}>{props.publishedAt}</div> : null}
        {props.excerpt !== null ? <BodyText text={props.excerpt} maxFontSize={36} /> : null}
        {props.url !== null ? (
          <div data-role="source-url" style={{ fontSize: 26, color: theme.color.accent, wordBreak: 'break-all', fontFamily: theme.font.body }}>
            {props.url}
          </div>
        ) : null}
      </CardShell>
    </SceneRoot>
  );
}

export const sourceCardComponent = defineComponent({
  type: 'SOURCE_CARD',
  version: '1.0.0',
  title: '来源卡',
  description: '来源可追溯卡（§10.3 降级载体；内容来自 Citation/Source，不编造）',
  inputSchema: sourceCardPropsSchema,
  defaults: { title: '', url: null, publishedAt: null, excerpt: null },
  supportedAspectRatios: ['16:9', '9:16', '1:1', '4:5'],
  minDurationMs: 2500,
  maxDurationMs: 25_000,
  previewFixture: {
    props: { title: '美联储利率决议原文', url: 'news.example/rates/2026-10', publishedAt: '2026-10-01', excerpt: '联邦基金利率目标区间维持不变。' },
    durationMs: 7000,
    aspectRatio: '16:9',
    note: '正常值',
  },
  renderer: SourceCardScene,
});

/* ---------- QUOTE_CARD ---------- */

export const quoteCardPropsSchema = z.object({
  quote: z.string().max(400).default(''),
  attribution: z.string().max(120).nullable().default(null),
  sourceLabel: z.string().max(200).nullable().default(null),
});
export type QuoteCardProps = z.infer<typeof quoteCardPropsSchema>;

export function QuoteCardScene({ props }: ComponentRenderInput<QuoteCardProps>): ReactElement {
  const theme = useSceneTheme();
  if (props.quote === '') {
    return (
      <SceneRoot>
        <Placeholder text="引文待补充" detail="引文必须逐字来自原文" />
      </SceneRoot>
    );
  }
  return (
    <SceneRoot>
      <div style={{ width: '80%', display: 'flex', flexDirection: 'column', gap: theme.spacing.md }}>
        <div style={{ fontSize: 120, color: theme.color.accent, fontFamily: theme.font.heading, lineHeight: 1 }} aria-hidden>
          “
        </div>
        <div
          data-role="quote"
          style={{ fontFamily: theme.font.heading, fontSize: fitFontSize(props.quote, { max: 72, min: 24, comfortableChars: 26 }), fontStyle: 'italic', lineHeight: 1.3 }}
        >
          {props.quote}
        </div>
        {props.attribution !== null ? (
          <div data-role="attribution" style={{ fontSize: 32, opacity: 0.75 }}>
            —— {props.attribution}
          </div>
        ) : null}
        <SourceLabel label={props.sourceLabel} />
      </div>
    </SceneRoot>
  );
}

export const quoteCardComponent = defineComponent({
  type: 'QUOTE_CARD',
  version: '1.0.0',
  title: '引文卡',
  description: '引文逐字呈现（QUOTE 语义；含出处；§10.3 降级载体）',
  inputSchema: quoteCardPropsSchema,
  defaults: { quote: '', attribution: null, sourceLabel: null },
  supportedAspectRatios: ['16:9', '9:16', '1:1', '4:5'],
  minDurationMs: 2500,
  maxDurationMs: 25_000,
  previewFixture: {
    props: { quote: '通胀压力已经明显缓解。', attribution: '示例分析师', sourceLabel: 'news.example/rates' },
    durationMs: 6000,
    aspectRatio: '16:9',
    note: '正常值',
  },
  renderer: QuoteCardScene,
});

/* ---------- DOCUMENT_HIGHLIGHT ---------- */

export const documentHighlightPropsSchema = z.object({
  documentTitle: z.string().max(160).default(''),
  highlightedText: z.string().max(400).default(''),
  sourceLabel: z.string().max(200).nullable().default(null),
});
export type DocumentHighlightProps = z.infer<typeof documentHighlightPropsSchema>;

export function DocumentHighlightScene({ props }: ComponentRenderInput<DocumentHighlightProps>): ReactElement {
  const theme = useSceneTheme();
  if (props.highlightedText === '') {
    return (
      <SceneRoot>
        <Placeholder text="待高亮内容" detail="文档片段必须来自已验证来源" />
      </SceneRoot>
    );
  }
  return (
    <SceneRoot>
      <CardShell style={{ maxWidth: 1300 }}>
        <Kicker text={props.documentTitle === '' ? '文档' : props.documentTitle} />
        <div
          data-role="highlight"
          style={{
            fontFamily: theme.font.body,
            fontSize: fitFontSize(props.highlightedText, { max: 52, min: 22, comfortableChars: 40 }),
            lineHeight: 1.5,
            backgroundColor: `${theme.color.accent}22`,
            borderLeft: `8px solid ${theme.color.accent}`,
            padding: theme.spacing.lg,
            borderRadius: theme.radius.sm,
          }}
        >
          {props.highlightedText}
        </div>
        <SourceLabel label={props.sourceLabel} />
      </CardShell>
    </SceneRoot>
  );
}

export const documentHighlightComponent = defineComponent({
  type: 'DOCUMENT_HIGHLIGHT',
  version: '1.0.0',
  title: '文档高亮',
  description: '文档片段高亮（内容逐字来自来源文档）',
  inputSchema: documentHighlightPropsSchema,
  defaults: { documentTitle: '', highlightedText: '', sourceLabel: null },
  supportedAspectRatios: ['16:9', '9:16', '1:1', '4:5'],
  minDurationMs: 2500,
  maxDurationMs: 25_000,
  previewFixture: {
    props: { documentTitle: '利率周报', highlightedText: '分析师预计 2025 年可能降息 2 个百分点。', sourceLabel: 'news.example/rates' },
    durationMs: 7000,
    aspectRatio: '16:9',
    note: '正常值',
  },
  renderer: DocumentHighlightScene,
});

/* ---------- TIMELINE ---------- */

export const timelinePropsSchema = z.object({
  title: z.string().max(120).default(''),
  events: z
    .array(z.object({ date: z.string().max(40), description: z.string().max(200) }))
    .default([]),
  sourceLabel: z.string().max(200).nullable().default(null),
});
export type TimelineProps = z.infer<typeof timelinePropsSchema>;

export function TimelineScene({ props }: ComponentRenderInput<TimelineProps>): ReactElement {
  const theme = useSceneTheme();
  return (
    <SceneRoot>
      {props.title === '' ? null : <Headline text={props.title} maxFontSize={64} />}
      <div style={{ marginTop: 40, width: '86%' }}>
        {props.events.length === 0 ? (
          <Placeholder text="时间线待补充" />
        ) : (
          <div data-role="timeline" style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: theme.spacing.lg }}>
            <div style={{ position: 'absolute', left: 180, top: 8, bottom: 8, width: 4, backgroundColor: `${theme.color.accent}66` }} />
            {props.events.map((event, index) => (
              <div key={`${event.date}-${String(index)}`} data-role="timeline-event" style={{ display: 'flex', gap: theme.spacing.lg, alignItems: 'flex-start' }}>
                <div style={{ width: 156, textAlign: 'right', fontFamily: theme.font.heading, fontSize: 36, color: theme.color.accent, fontWeight: 700 }}>
                  {event.date}
                </div>
                <div style={{ width: 16, height: 16, borderRadius: 999, backgroundColor: theme.color.accent, marginTop: 12, marginLeft: 8 }} />
                <BodyText text={event.description} maxFontSize={38} />
              </div>
            ))}
          </div>
        )}
      </div>
      <div style={{ marginTop: theme.spacing.lg }}>
        <SourceLabel label={props.sourceLabel} />
      </div>
    </SceneRoot>
  );
}

export const timelineComponent = defineComponent({
  type: 'TIMELINE',
  version: '1.0.0',
  title: '时间线',
  description: '事件时间线（日期逐字来自事实；空事件占位）',
  inputSchema: timelinePropsSchema,
  defaults: { title: '', events: [], sourceLabel: null },
  supportedAspectRatios: ['16:9', '9:16', '1:1', '4:5'],
  minDurationMs: 3000,
  maxDurationMs: 30_000,
  previewFixture: {
    props: {
      title: '政策路径回顾',
      events: [
        { date: '2023-07', description: '加息至 5.25%' },
        { date: '2024-09', description: '首次降息 50bp' },
        { date: '2025-06', description: '维持利率不变' },
      ],
      sourceLabel: '示例数据集',
    },
    durationMs: 9000,
    aspectRatio: '16:9',
    note: '正常值：3 个事件',
  },
  renderer: TimelineScene,
});
