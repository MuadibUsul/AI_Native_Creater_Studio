import type { ReactElement } from 'react';
import { z } from 'zod';
import { defineComponent, type ComponentRenderInput } from '../protocol.js';
import { fitFontSize, Headline, Placeholder, SceneRoot, SourceLabel } from '../primitives.js';
import { useSceneTheme } from '../theme.js';

/**
 * 图解类组件（P05-02）：CAUSAL_FLOW / CAUSAL_LOOP / MAP_STATIC。
 *
 * 纪律：节点与关系**逐字来自 props**（文本）；MAP_STATIC 不使用虚构地理数据——
 * 位置由作者/AI 显式给出（示意标注），无位置数据时显示占位（不以"地图外观"冒充真实地理）。
 */

/* ---------- CAUSAL_FLOW ---------- */

export const causalFlowPropsSchema = z.object({
  title: z.string().max(120).default(''),
  steps: z.array(z.string().max(120)).default([]),
  sourceLabel: z.string().max(200).nullable().default(null),
});
export type CausalFlowProps = z.infer<typeof causalFlowPropsSchema>;

export function CausalFlowScene({ props }: ComponentRenderInput<CausalFlowProps>): ReactElement {
  const theme = useSceneTheme();
  return (
    <SceneRoot>
      {props.title === '' ? null : <Headline text={props.title} maxFontSize={64} />}
      <div style={{ marginTop: 48, display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%' }}>
        {props.steps.length === 0 ? (
          <Placeholder text="因果链待补充" />
        ) : (
          <div data-role="causal-flow" style={{ display: 'flex', alignItems: 'center', gap: theme.spacing.md, flexWrap: 'wrap', justifyContent: 'center', maxWidth: 1600 }}>
            {props.steps.map((step, index) => (
              <div key={`${String(index)}-${step}`} style={{ display: 'flex', alignItems: 'center', gap: theme.spacing.md }}>
                <div
                  data-role="flow-node"
                  style={{
                    border: `3px solid ${theme.color.accent}`,
                    borderRadius: theme.radius.md,
                    padding: `${String(theme.spacing.md)}px ${String(theme.spacing.lg)}px`,
                    fontFamily: theme.font.heading,
                    fontSize: fitFontSize(step, { max: 40, min: 22, comfortableChars: 12 }),
                    maxWidth: 420,
                    textAlign: 'center',
                  }}
                >
                  {step}
                </div>
                {index < props.steps.length - 1 ? (
                  <div data-role="flow-arrow" style={{ fontSize: 56, color: theme.color.accent, fontFamily: theme.font.heading }}>
                    →
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
        <div style={{ marginTop: theme.spacing.lg }}>
          <SourceLabel label={props.sourceLabel} />
        </div>
      </div>
    </SceneRoot>
  );
}

export const causalFlowComponent = defineComponent({
  type: 'CAUSAL_FLOW',
  version: '1.0.0',
  title: '因果链',
  description: '单向因果/流程链（节点文本逐字来自 props；空链占位）',
  inputSchema: causalFlowPropsSchema,
  defaults: { title: '', steps: [], sourceLabel: null },
  supportedAspectRatios: ['16:9', '9:16', '1:1', '4:5'],
  minDurationMs: 3000,
  maxDurationMs: 25_000,
  previewFixture: {
    props: { title: '通胀为什么会回落', steps: ['供给修复', '需求降温', '通胀回落'], sourceLabel: '示例分析' },
    durationMs: 8000,
    aspectRatio: '16:9',
    note: '正常值：3 步',
  },
  renderer: CausalFlowScene,
});

/* ---------- CAUSAL_LOOP ---------- */

export const causalLoopPropsSchema = z.object({
  title: z.string().max(120).default(''),
  nodes: z.array(z.string().max(80)).default([]),
  loopLabel: z.string().max(80).nullable().default(null),
});
export type CausalLoopProps = z.infer<typeof causalLoopPropsSchema>;

export function CausalLoopScene({ props }: ComponentRenderInput<CausalLoopProps>): ReactElement {
  const theme = useSceneTheme();
  const radius = 300;
  const center = 340;
  return (
    <SceneRoot>
      {props.title === '' ? null : <Headline text={props.title} maxFontSize={60} />}
      <div style={{ marginTop: 24, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        {props.nodes.length === 0 ? (
          <Placeholder text="闭环节点待补充" />
        ) : (
          <svg data-role="causal-loop" viewBox="0 0 680 680" style={{ width: 620, height: 620 }} role="img">
            <circle cx={center} cy={center} r={radius} fill="none" stroke={`${theme.color.accent}55`} strokeWidth={4} strokeDasharray="16 12" />
            {props.nodes.map((node, index) => {
              const angle = (index / props.nodes.length) * Math.PI * 2 - Math.PI / 2;
              const x = center + Math.cos(angle) * radius;
              const y = center + Math.sin(angle) * radius;
              return (
                <g key={`${String(index)}-${node}`} data-role="loop-node">
                  <circle cx={x} cy={y} r={78} fill={theme.color.background} stroke={theme.color.accent} strokeWidth={4} />
                  <text x={x} y={y + 8} textAnchor="middle" fill={theme.color.foreground} fontSize={26} fontFamily={theme.font.heading}>
                    {node.length > 6 ? `${node.slice(0, 6)}…` : node}
                  </text>
                </g>
              );
            })}
            {props.loopLabel !== null ? (
              <text x={center} y={center + 8} textAnchor="middle" fill={theme.color.foreground} fontSize={30} fontFamily={theme.font.body} opacity={0.8}>
                {props.loopLabel}
              </text>
            ) : null}
          </svg>
        )}
      </div>
    </SceneRoot>
  );
}

export const causalLoopComponent = defineComponent({
  type: 'CAUSAL_LOOP',
  version: '1.0.0',
  title: '因果闭环',
  description: '自我强化循环（FEEDBACK_LOOP 语义；节点文本逐字来自 props）',
  inputSchema: causalLoopPropsSchema,
  defaults: { title: '', nodes: [], loopLabel: null },
  supportedAspectRatios: ['16:9', '1:1'],
  minDurationMs: 3000,
  maxDurationMs: 25_000,
  previewFixture: {
    props: { title: '通胀螺旋', nodes: ['工资上涨', '物价上升', '预期上修', '工资再涨'], loopLabel: '自我强化' },
    durationMs: 8000,
    aspectRatio: '16:9',
    note: '正常值：4 节点闭环',
  },
  renderer: CausalLoopScene,
});

/* ---------- MAP_STATIC ---------- */

export const mapStaticPropsSchema = z.object({
  title: z.string().max(120).default(''),
  /** 区域标注（位置由作者/AI 显式给出；无位置 → 占位，不以地图外观冒充真实地理） */
  regions: z
    .array(
      z.object({
        label: z.string().max(60),
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
        note: z.string().max(80).nullable().default(null),
      }),
    )
    .default([]),
  sourceLabel: z.string().max(200).nullable().default(null),
});
export type MapStaticProps = z.infer<typeof mapStaticPropsSchema>;

export function MapStaticScene({ props }: ComponentRenderInput<MapStaticProps>): ReactElement {
  const theme = useSceneTheme();
  return (
    <SceneRoot>
      {props.title === '' ? null : <Headline text={props.title} maxFontSize={60} />}
      <div style={{ marginTop: 24, width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        {props.regions.length === 0 ? (
          <Placeholder text="地理标注待补充" detail="位置需作者/AI 显式给出，不以地图外观冒充真实地理" />
        ) : (
          <div
            data-role="map-schematic"
            style={{
              position: 'relative',
              width: '82%',
              height: 640,
              border: `3px solid ${theme.color.accent}55`,
              borderRadius: theme.radius.lg,
              backgroundColor: `${theme.color.accent}0F`,
            }}
          >
            <div style={{ position: 'absolute', top: 12, right: 20, fontSize: 22, opacity: 0.6 }}>示意位置（非真实地理投影）</div>
            {props.regions.map((region) => (
              <div
                key={region.label}
                data-role="map-region"
                style={{
                  position: 'absolute',
                  left: `${String(region.x * 100)}%`,
                  top: `${String(region.y * 100)}%`,
                  transform: 'translate(-50%, -50%)',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <div style={{ width: 22, height: 22, borderRadius: 999, backgroundColor: theme.color.accent }} />
                <div style={{ fontSize: 30, fontFamily: theme.font.heading }}>{region.label}</div>
                {region.note !== null ? <div style={{ fontSize: 22, opacity: 0.75 }}>{region.note}</div> : null}
              </div>
            ))}
          </div>
        )}
        <div style={{ marginTop: theme.spacing.lg }}>
          <SourceLabel label={props.sourceLabel} />
        </div>
      </div>
    </SceneRoot>
  );
}

export const mapStaticComponent = defineComponent({
  type: 'MAP_STATIC',
  version: '1.0.0',
  title: '静态地图',
  description: '区域标注示意（GEOGRAPHY 语义；位置显式给出并标注"示意"）',
  inputSchema: mapStaticPropsSchema,
  defaults: { title: '', regions: [], sourceLabel: null },
  supportedAspectRatios: ['16:9', '1:1'],
  minDurationMs: 3000,
  maxDurationMs: 25_000,
  previewFixture: {
    props: {
      title: '三大贸易伙伴',
      regions: [
        { label: '美国', x: 0.18, y: 0.42, note: null },
        { label: '欧盟', x: 0.52, y: 0.3, note: null },
        { label: '东盟', x: 0.76, y: 0.66, note: null },
      ],
      sourceLabel: '示例分析',
    },
    durationMs: 8000,
    aspectRatio: '16:9',
    note: '正常值：3 区域',
  },
  renderer: MapStaticScene,
});
