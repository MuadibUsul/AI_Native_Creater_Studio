import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';

/**
 * 标准场景种子（P00-03）：BIG_NUMBER（属 V1 20 个标准类型，详见 DEC-04）。
 * 完整组件协议（ComponentDefinition/主题 tokens/props schema）在 P05-01/P05-02 落地，
 * 本组件仅用于验证 Remotion 预览与服务器渲染管线。
 */
// 使用 type 而非 interface：Remotion Composition 要求 props 兼容 Record<string, unknown>，
// interface 不带隐式索引签名会导致不兼容。
export type BigNumberSceneProps = {
  label: string;
  value: string;
  unit?: string;
  source: string;
  accentColor: string;
};

export const bigNumberSceneDefaultProps: BigNumberSceneProps = {
  label: '法国与德国 10 年期国债利差',
  value: '140',
  unit: 'bp',
  source: 'Source: ECB · 2026-09',
  accentColor: '#4F8CFF',
};

const FONT_STACK = 'Inter, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif';

export function BigNumberScene({ label, value, unit, source, accentColor }: BigNumberSceneProps) {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const enter = spring({ frame, fps, config: { damping: 200 } });
  const exit = interpolate(frame, [durationInFrames - 12, durationInFrames], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const opacity = enter * exit;
  const translateY = interpolate(enter, [0, 1], [24, 0]);
  const accentWidth = interpolate(enter, [0, 1], [0, 14]);

  return (
    <AbsoluteFill style={{ backgroundColor: '#0B1220', fontFamily: FONT_STACK }}>
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: accentWidth,
          backgroundColor: accentColor,
        }}
      />
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          height: '100%',
          paddingLeft: 180,
          paddingRight: 180,
          opacity,
          transform: `translateY(${translateY}px)`,
        }}
      >
        <div style={{ color: '#9FB0C9', fontSize: 44, letterSpacing: 2, marginBottom: 24 }}>{label}</div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 18 }}>
          <span style={{ color: '#F5F8FF', fontSize: 200, fontWeight: 700, lineHeight: 1 }}>{value}</span>
          {unit ? <span style={{ color: accentColor, fontSize: 96, fontWeight: 600 }}>{unit}</span> : null}
        </div>
      </div>
      <div style={{ position: 'absolute', left: 180, bottom: 96, color: '#6E8099', fontSize: 34 }}>{source}</div>
    </AbsoluteFill>
  );
}
