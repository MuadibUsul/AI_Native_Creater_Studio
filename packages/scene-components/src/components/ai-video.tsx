import type { ReactElement } from 'react';
import { z } from 'zod';
import { defineComponent, type ComponentRenderInput } from '../protocol.js';
import { Placeholder, SceneRoot, SourceLabel } from '../primitives.js';
import { useSceneTheme } from '../theme.js';

/**
 * AI_VIDEO 场景组件（P06-05 / DEC-04：AI_VIDEO 作为外部视频资产场景在 P06 验收）。
 *
 * 纪律：
 * - **资产驱动**：只渲染已生成/已回收的视频资产（assetId/assetUrl 来自资产系统）；
 *   未生成时显示**明确占位**（"AI 视频待生成"），绝不播放其他素材冒充；
 * - 生成是**显式动作**（由用户在编辑器发起，见 domain 的 requestSceneGeneration）——
 *   组件不触发任何生成；
 * - AI Video 使用边界（§14.4：不得用于数据图表/利率曲线/真实财经数字/来源引用）由
 *   生成请求处门控，组件只负责如实渲染。
 */

export const aiVideoPropsSchema = z.object({
  assetId: z.string().max(120).nullable().default(null),
  assetUrl: z.string().max(1000).nullable().default(null),
  caption: z.string().max(200).nullable().default(null),
  /** AI 生成标注（透明度：画面为 AI 生成时展示） */
  aiDisclosure: z.string().max(120).default('AI 生成画面'),
  sourceLabel: z.string().max(200).nullable().default(null),
  /** 资产封面（视频未就绪/加载前显示的静帧） */
  posterUrl: z.string().max(1000).nullable().default(null),
});

export type AiVideoProps = z.infer<typeof aiVideoPropsSchema>;

export function AiVideoScene({ props }: ComponentRenderInput<AiVideoProps>): ReactElement {
  const theme = useSceneTheme();
  if (props.assetUrl === null) {
    return (
      <SceneRoot>
        <Placeholder
          text="AI 视频待生成"
          detail={props.assetId === null ? '尚未生成：请在编辑器中发起显式生成（不自动提交，避免费用）' : `资产 ${props.assetId} 的播放地址未就绪`}
        />
        <div style={{ position: 'absolute', right: theme.spacing.lg, bottom: theme.spacing.md }}>
          <SourceLabel label={props.sourceLabel} />
        </div>
      </SceneRoot>
    );
  }
  return (
    <SceneRoot padding={0}>
      <div data-role="ai-video-frame" style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
        {/*
          预览/成片同为帧的纯函数；渲染阶段由合成层决定帧（此处 video 元素由宿主页面驱动播放）。
          playsInline + muted 保证自动播放策略下的确定性。
        */}
        <video
          data-role="ai-video"
          src={props.assetUrl}
          poster={props.posterUrl ?? undefined}
          muted
          playsInline
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
        <div
          style={{
            position: 'absolute',
            left: theme.spacing.md,
            top: theme.spacing.md,
            padding: '4px 10px',
            borderRadius: theme.radius.sm,
            backgroundColor: `${theme.color.background}AA`,
            color: theme.color.foreground,
            fontSize: 22,
            fontFamily: theme.font.body,
          }}
          data-role="ai-disclosure"
        >
          {props.aiDisclosure}
        </div>
        {props.caption !== null ? (
          <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: theme.spacing.md, background: `linear-gradient(transparent, ${theme.color.background}CC)` }}>
            <span style={{ fontSize: 34, fontFamily: theme.font.body }}>{props.caption}</span>
          </div>
        ) : null}
      </div>
    </SceneRoot>
  );
}

export const aiVideoComponent = defineComponent({
  type: 'AI_VIDEO',
  version: '1.0.0',
  title: 'AI 视频场景',
  description: 'AI 生成的视频画面（资产驱动；未生成时明确占位并提示显式生成；含 AI 生成标注）',
  inputSchema: aiVideoPropsSchema,
  defaults: { assetId: null, assetUrl: null, caption: null, aiDisclosure: 'AI 生成画面', sourceLabel: null, posterUrl: null },
  supportedAspectRatios: ['16:9', '9:16', '1:1', '4:5'],
  minDurationMs: 2000,
  maxDurationMs: 30_000,
  previewFixture: {
    props: { assetId: 'ast_ai_video', assetUrl: null, caption: '概念性画面', aiDisclosure: 'AI 生成画面', sourceLabel: null, posterUrl: null },
    durationMs: 6000,
    aspectRatio: '16:9',
    note: '占位路径：未生成 → 明确占位（不冒充）',
  },
  renderer: AiVideoScene,
});
