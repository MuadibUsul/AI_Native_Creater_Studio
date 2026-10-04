import type { CSSProperties, ReactElement, ReactNode } from 'react';
import { stageStyle, useSceneTheme } from './theme.js';

/**
 * 共享排版原语（P05-02："基础绘图可复用，类型行为独立验收"）。
 *
 * 纪律：
 * - 所有颜色/字体/间距/圆角来自主题 tokens（§57）；
 * - **空值一律显示明确占位**（`Placeholder`，带 data-role="placeholder"）——绝不编造内容（§10.3）；
 * - 长文本用 `fitFontSize` 逐级降字号（不裁切、不省略号吞掉关键信息）；
 * - 内容型原语均带 `data-role` 标记，供单元测试与验收断言。
 */

/** 字号自适应：按字符数分档降级（中英混排按 1.6 权重估算视觉宽度）。 */
export function fitFontSize(text: string, options: { max: number; min: number; comfortableChars: number }): number {
  const visualLength = [...text].reduce((sum, char) => sum + (/[\u4e00-\u9fff]/.test(char) ? 1.6 : 1), 0);
  if (visualLength <= options.comfortableChars) return options.max;
  const ratio = options.comfortableChars / visualLength;
  return Math.max(options.min, Math.round(options.max * Math.max(ratio, options.min / options.max)));
}

/** 场景根容器（主题背景/前景/字体 + 内边距）。 */
export function SceneRoot({ children, padding }: { children: ReactNode; padding?: number }): ReactElement {
  const theme = useSceneTheme();
  return <div style={stageStyle(theme, padding)}>{children}</div>;
}

/** 空值占位（数据缺失时的诚实降级；不得用编造内容填充）。 */
export function Placeholder({ text = '数据待补充', detail }: { text?: string; detail?: string | null }): ReactElement {
  const theme = useSceneTheme();
  return (
    <div
      data-role="placeholder"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.spacing.sm,
        border: `3px dashed ${theme.color.foreground}44`,
        borderRadius: theme.radius.lg,
        padding: theme.spacing.lg,
        color: theme.color.foreground,
        opacity: 0.75,
      }}
    >
      <span style={{ fontSize: 44, fontFamily: theme.font.heading }}>{text}</span>
      {detail !== null && detail !== undefined && detail !== '' ? (
        <span style={{ fontSize: 26, opacity: 0.8 }} data-role="placeholder-detail">
          {detail}
        </span>
      ) : null}
    </div>
  );
}

/** 顶部小标签（栏目/类型提示）。 */
export function Kicker({ text, color }: { text: string; color?: string }): ReactElement | null {
  const theme = useSceneTheme();
  if (text === '') return null;
  return (
    <div
      data-role="kicker"
      style={{
        fontSize: 26,
        letterSpacing: 4,
        textTransform: 'uppercase',
        color: color ?? theme.color.accent,
        fontFamily: theme.font.heading,
        marginBottom: theme.spacing.md,
      }}
    >
      {text}
    </div>
  );
}

/** 大标题（长文本自动降字号）。 */
export function Headline({ text, maxFontSize = 96 }: { text: string; maxFontSize?: number }): ReactElement {
  const theme = useSceneTheme();
  const fontSize = fitFontSize(text, { max: maxFontSize, min: Math.round(maxFontSize * 0.32), comfortableChars: 18 });
  return (
    <div
      data-role="headline"
      style={{ fontFamily: theme.font.heading, fontWeight: 700, fontSize, lineHeight: 1.18, textAlign: 'center' }}
    >
      {text}
    </div>
  );
}

/** 正文段落（长文本降字号；comfortableChars 由调用方按可用宽度给提示）。 */
export function BodyText({
  text,
  maxFontSize = 40,
  comfortableChars = 90,
}: {
  text: string;
  maxFontSize?: number;
  comfortableChars?: number;
}): ReactElement {
  const theme = useSceneTheme();
  const fontSize = fitFontSize(text, { max: maxFontSize, min: 20, comfortableChars });
  return (
    <div data-role="body" style={{ fontFamily: theme.font.body, fontSize, lineHeight: 1.6, opacity: 0.92 }}>
      {text}
    </div>
  );
}

/** 来源标注（§10.3 / REQ-10-04：关键图表可选显示 source label）。 */
export function SourceLabel({ label }: { label: string | null }): ReactElement | null {
  const theme = useSceneTheme();
  if (label === null || label === '') return null;
  return (
    <div data-role="source" style={{ fontSize: 24, opacity: 0.66, fontFamily: theme.font.body }}>
      来源：{label}
    </div>
  );
}

/** 卡片外壳（Source/Quote/Document 等证据卡共用）。 */
export function CardShell({ children, style }: { children: ReactNode; style?: CSSProperties }): ReactElement {
  const theme = useSceneTheme();
  return (
    <div
      data-role="card"
      style={{
        backgroundColor: `${theme.color.foreground}0D`,
        border: `2px solid ${theme.color.accent}66`,
        borderRadius: theme.radius.lg,
        padding: theme.spacing.lg,
        display: 'flex',
        flexDirection: 'column',
        gap: theme.spacing.md,
        maxWidth: 1400,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
