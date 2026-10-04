import type { ReactElement } from 'react';
import { z } from 'zod';
import { defineComponent, type ComponentRenderInput } from '../protocol.js';
import { fitFontSize, Placeholder } from '../primitives.js';
import { stageStyle, useSceneTheme } from '../theme.js';

/**
 * BIG_NUMBER（P05-01 协议参考组件；P05-02 起与其余 19 类一同扩容）。
 *
 * 纪律：
 * - 数值**逐字来自 Scene.props（来自 Claim 文本，可追溯）**；组件不做任何计算或补全，
 *   空值显示占位而不是编造（§10.3）；
 * - 颜色/字体全部来自主题 tokens（§57）。
 */

export const bigNumberPropsSchema = z.object({
  /** 主数值（字符串承载：保留原文单位与格式，如 "5.25%"） */
  value: z.string().min(1).nullable().default(null),
  /** 数值说明（如 "联邦基金利率"） */
  label: z.string().max(120).default(''),
  /** 方向（着色依据；null=中性） */
  direction: z.enum(['UP', 'DOWN', 'FLAT']).nullable().default(null),
  /** 来源标注（§10.3 图表/数值建议显示 source label） */
  sourceLabel: z.string().max(200).nullable().default(null),
  /** 空值占位文案（数据缺失时的诚实降级） */
  placeholder: z.string().max(80).default('数据待补充'),
});

export type BigNumberProps = z.infer<typeof bigNumberPropsSchema>;

export function BigNumberScene({ props }: ComponentRenderInput<BigNumberProps>): ReactElement {
  const theme = useSceneTheme();
  const valueColor =
    props.direction === 'UP' ? theme.color.positive : props.direction === 'DOWN' ? theme.color.negative : theme.color.accent;

  return (
    <div style={stageStyle(theme)} data-component="BIG_NUMBER">
      <div
        style={{ fontFamily: theme.font.heading, fontSize: fitFontSize(props.label, { max: 28, min: 16, comfortableChars: 30 }), opacity: 0.72, letterSpacing: 2 }}
        data-role="label"
      >
        {props.label}
      </div>
      {props.value === null ? (
        <div style={{ marginTop: theme.spacing.md }}>
          <Placeholder text={props.placeholder} detail="数值必须来自可追溯事实；缺失时不得编造" />
        </div>
      ) : (
        <div
          data-role="value"
          style={{
            fontFamily: theme.font.heading,
            fontSize: 168,
            fontWeight: 700,
            lineHeight: 1.05,
            color: valueColor,
            marginTop: theme.spacing.md,
          }}
        >
          {props.value}
        </div>
      )}
      {props.sourceLabel !== null ? (
        <div
          data-role="source"
          style={{
            position: 'absolute',
            bottom: theme.spacing.lg,
            right: theme.spacing.lg,
            fontSize: 22,
            opacity: 0.66,
            fontFamily: theme.font.body,
          }}
        >
          来源：{props.sourceLabel}
        </div>
      ) : null}
    </div>
  );
}

export const bigNumberComponent = defineComponent({
  type: 'BIG_NUMBER',
  version: '1.0.0',
  title: '大字报数',
  description: '单一关键数值全屏呈现（数值必须来自可追溯事实；空值显示占位，绝不编造）',
  inputSchema: bigNumberPropsSchema,
  defaults: { value: null, label: '', direction: null, sourceLabel: null, placeholder: '数据待补充' },
  supportedAspectRatios: ['16:9', '9:16', '1:1', '4:5'],
  minDurationMs: 1500,
  maxDurationMs: 20_000,
  previewFixture: {
    props: { value: '5.25%', label: '联邦基金利率', direction: 'FLAT', sourceLabel: '美联储利率决议（示例）' },
    durationMs: 6_000,
    aspectRatio: '16:9',
    note: 'P05-01 协议验收 fixture：正常值 + 来源标注',
  },
  renderer: BigNumberScene,
});
