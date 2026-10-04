import type { ReactElement } from 'react';
import { z } from 'zod';
import { defineComponent, type ComponentRenderInput } from '../protocol.js';
import { BodyText, Kicker, Placeholder, SceneRoot, SourceLabel } from '../primitives.js';
import { useSceneTheme } from '../theme.js';

/**
 * 主持与媒体类组件（P05-02）：HOST_FULL / HOST_SIDE / IMAGE_FULL / REAL_BROLL。
 *
 * 纪律：
 * - **素材必须显式绑定**（assetId/assetUrl 来自资产系统，P02-04）：未绑定时显示**明确标识的占位**
 *   （Draft 占位策略，P05-04 验收点），绝不渲染"看似真实"的假素材；
 * - 不在 props 里保存 Provider output URL 当永久地址（资产 URL 由资产系统签发）；本组件只消费给定 URL；
 * - 真实素材（REAL_BROLL）不得以 AI 画面冒充（素材来源由资产元数据保证，组件层只如实渲染）。
 */

const mediaCommon = {
  /** 资产系统引用（可追溯；与 Scene.assetBindings 对应） */
  assetId: z.string().max(120).nullable().default(null),
  /** 预览/渲染用地址（由资产系统签发；不得当作永久文件） */
  assetUrl: z.string().max(1000).nullable().default(null),
  caption: z.string().max(200).nullable().default(null),
  sourceLabel: z.string().max(200).nullable().default(null),
  /** 画面缩放与位移（crop/framing 的 Lite 参数；1/0/0 = 原始构图） */
  scale: z.number().min(0.1).max(4).default(1),
  offsetX: z.number().min(-100).max(100).default(0),
  offsetY: z.number().min(-100).max(100).default(0),
};

/** 媒体画面变换（scale/offset；在组件协议内、由 props 驱动，预览与成片一致）。 */
const mediaTransform = (props: { scale: number; offsetX: number; offsetY: number }): string =>
  props.scale === 1 && props.offsetX === 0 && props.offsetY === 0
    ? 'none'
    : `scale(${String(props.scale)}) translate(${String(props.offsetX)}%, ${String(props.offsetY)}%)`;

const MediaImage = ({ url, alt, fit, transform }: { url: string | null; alt: string; fit: 'cover' | 'contain'; transform?: string }): ReactElement | null =>
  url === null ? null : (
    <div data-role="media-frame" style={{ width: '100%', height: '100%', overflow: 'hidden' }}>
      <img
        data-role="media-image"
        src={url}
        alt={alt}
        style={{ width: '100%', height: '100%', objectFit: fit, transform: transform ?? 'none' }}
      />
    </div>
  );

/* ---------- HOST_FULL ---------- */

export const hostFullPropsSchema = z.object({
  ...mediaCommon,
  /** 主持人口播文本（与旁白一致；预览用于字幕对位） */
  lines: z.string().max(600).default(''),
  presenterName: z.string().max(60).nullable().default(null),
});
export type HostFullProps = z.infer<typeof hostFullPropsSchema>;

export function HostFullScene({ props }: ComponentRenderInput<HostFullProps>): ReactElement {
  const theme = useSceneTheme();
  return (
    <SceneRoot padding={0}>
      {props.assetUrl === null ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: theme.spacing.md }}>
          <Placeholder
            text="主持画面（待绑定素材）"
            detail={props.assetId === null ? '未绑定 Avatar 资产：Draft 占位，不冒充真实出镜' : `资产 ${props.assetId} 的预览地址未就绪`}
          />
          {props.lines !== '' ? (
            <div style={{ width: '70%' }}>
              <BodyText text={props.lines} maxFontSize={36} />
            </div>
          ) : null}
        </div>
      ) : (
        <div style={{ position: 'relative', width: '100%', height: '100%' }}>
          <MediaImage url={props.assetUrl} alt={props.presenterName ?? '主持人'} fit="cover" transform={mediaTransform(props)} />
          {props.presenterName !== null ? (
            <div style={{ position: 'absolute', left: theme.spacing.lg, bottom: theme.spacing.lg }}>
              <Kicker text={props.presenterName} />
            </div>
          ) : null}
        </div>
      )}
      <div style={{ position: 'absolute', right: theme.spacing.lg, bottom: theme.spacing.md }}>
        <SourceLabel label={props.sourceLabel} />
      </div>
    </SceneRoot>
  );
}

export const hostFullComponent = defineComponent({
  type: 'HOST_FULL',
  version: '1.0.0',
  title: '主持全屏',
  description: '真人主持全屏（Avatar 驱动；未绑定素材时明确占位）',
  inputSchema: hostFullPropsSchema,
  defaults: { assetId: null, assetUrl: null, caption: null, sourceLabel: null, scale: 1, offsetX: 0, offsetY: 0, lines: '', presenterName: null },
  supportedAspectRatios: ['16:9', '9:16', '1:1', '4:5'],
  minDurationMs: 2000,
  maxDurationMs: 25_000,
  previewFixture: {
    props: { assetId: 'ast_demo_host', assetUrl: null, caption: null, sourceLabel: null, lines: '利率为什么决定一切？', presenterName: '主播甲' },
    durationMs: 6000,
    aspectRatio: '16:9',
    note: '占位路径：assetUrl=null → 明确标识的 Draft 占位',
  },
  renderer: HostFullScene,
});

/* ---------- HOST_SIDE ---------- */

export const hostSidePropsSchema = z.object({
  ...mediaCommon,
  side: z.enum(['LEFT', 'RIGHT']).default('LEFT'),
  /** 侧栏区承载的内容文本（与旁白一致） */
  lines: z.string().max(600).default(''),
  presenterName: z.string().max(60).nullable().default(null),
});
export type HostSideProps = z.infer<typeof hostSidePropsSchema>;

export function HostSideScene({ props }: ComponentRenderInput<HostSideProps>): ReactElement {
  const theme = useSceneTheme();
  const hostFirst = props.side === 'LEFT';
  const hostPane = (
    <div data-role="host-pane" style={{ width: '38%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: `${theme.color.foreground}0A` }}>
      {props.assetUrl === null ? (
        <Placeholder text="主持画面（待绑定素材）" detail="Draft 占位，不冒充真实出镜" />
      ) : (
        <MediaImage url={props.assetUrl} alt={props.presenterName ?? '主持人'} fit="cover" transform={mediaTransform(props)} />
      )}
    </div>
  );
  const contentPane = (
    <div data-role="content-pane" style={{ flex: 1, height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: theme.spacing.lg * 2, gap: theme.spacing.md }}>
      {props.presenterName !== null ? <Kicker text={props.presenterName} /> : null}
      <BodyText text={props.lines} maxFontSize={44} />
      <SourceLabel label={props.sourceLabel} />
    </div>
  );
  return (
    <SceneRoot padding={0}>
      <div style={{ display: 'flex', width: '100%', height: '100%' }}>
        {hostFirst ? hostPane : contentPane}
        {hostFirst ? contentPane : hostPane}
      </div>
    </SceneRoot>
  );
}

export const hostSideComponent = defineComponent({
  type: 'HOST_SIDE',
  version: '1.0.0',
  title: '主持侧栏',
  description: '主持人在侧、内容在另一侧（未绑定素材时明确占位）',
  inputSchema: hostSidePropsSchema,
  defaults: { assetId: null, assetUrl: null, caption: null, sourceLabel: null, scale: 1, offsetX: 0, offsetY: 0, side: 'LEFT', lines: '', presenterName: null },
  supportedAspectRatios: ['16:9', '9:16', '1:1', '4:5'],
  minDurationMs: 2000,
  maxDurationMs: 25_000,
  previewFixture: {
    props: { assetId: 'ast_demo_host', assetUrl: null, caption: null, sourceLabel: null, side: 'LEFT', lines: '先看结论：利率路径取决于通胀。', presenterName: '主播甲' },
    durationMs: 7000,
    aspectRatio: '16:9',
    note: '占位路径',
  },
  renderer: HostSideScene,
});

/* ---------- IMAGE_FULL ---------- */

export const imageFullPropsSchema = z.object({
  ...mediaCommon,
  headline: z.string().max(120).nullable().default(null),
});
export type ImageFullProps = z.infer<typeof imageFullPropsSchema>;

export function ImageFullScene({ props }: ComponentRenderInput<ImageFullProps>): ReactElement {
  const theme = useSceneTheme();
  if (props.assetUrl === null) {
    return (
      <SceneRoot>
        <Placeholder
          text="画面（待绑定素材）"
          detail={props.assetId === null ? '未绑定图像资产：可上传或生成（不得凭空绘制）' : `资产 ${props.assetId} 的预览地址未就绪`}
        />
        {props.headline !== null ? <div style={{ marginTop: theme.spacing.lg }}><BodyText text={props.headline} maxFontSize={40} /></div> : null}
      </SceneRoot>
    );
  }
  return (
    <SceneRoot padding={0}>
      <MediaImage url={props.assetUrl} alt={props.caption ?? props.headline ?? '画面'} fit="cover" transform={mediaTransform(props)} />
      {props.headline !== null ? (
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            padding: `${String(theme.spacing.lg)}px ${String(theme.spacing.lg * 2)}px`,
            background: `linear-gradient(transparent, ${theme.color.background}CC)`,
          }}
        >
          <BodyText text={props.headline} maxFontSize={48} />
        </div>
      ) : null}
      <div style={{ position: 'absolute', right: theme.spacing.lg, top: theme.spacing.md }}>
        <SourceLabel label={props.sourceLabel} />
      </div>
    </SceneRoot>
  );
}

export const imageFullComponent = defineComponent({
  type: 'IMAGE_FULL',
  version: '1.0.0',
  title: '全屏画面',
  description: '全屏图片（AI 生成或作者上传；未绑定素材时明确占位）',
  inputSchema: imageFullPropsSchema,
  defaults: { assetId: null, assetUrl: null, caption: null, sourceLabel: null, scale: 1, offsetX: 0, offsetY: 0, headline: null },
  supportedAspectRatios: ['16:9', '9:16', '1:1', '4:5'],
  minDurationMs: 2000,
  maxDurationMs: 25_000,
  previewFixture: {
    props: { assetId: 'ast_demo_image', assetUrl: null, caption: null, sourceLabel: null, headline: '利率与通胀的关系' },
    durationMs: 6000,
    aspectRatio: '16:9',
    note: '占位路径：未绑定素材',
  },
  renderer: ImageFullScene,
});

/* ---------- REAL_BROLL ---------- */

export const realBrollPropsSchema = z.object({
  ...mediaCommon,
  /** 素材出处（真实素材必须可追溯；不得以 AI 画面冒充） */
  footageCredit: z.string().max(160).nullable().default(null),
});
export type RealBrollProps = z.infer<typeof realBrollPropsSchema>;

export function RealBrollScene({ props }: ComponentRenderInput<RealBrollProps>): ReactElement {
  const theme = useSceneTheme();
  if (props.assetUrl === null) {
    return (
      <SceneRoot>
        <Placeholder
          text="真实素材（待导入）"
          detail="B-roll 必须来自真实拍摄/授权素材；不得用 AI 画面冒充"
        />
      </SceneRoot>
    );
  }
  return (
    <SceneRoot padding={0}>
      <MediaImage url={props.assetUrl} alt={props.caption ?? '真实素材'} fit="cover" transform={mediaTransform(props)} />
      <div style={{ position: 'absolute', left: theme.spacing.lg, bottom: theme.spacing.md, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {props.footageCredit !== null ? <div style={{ fontSize: 24, opacity: 0.85 }}>素材：{props.footageCredit}</div> : null}
        <SourceLabel label={props.sourceLabel} />
      </div>
    </SceneRoot>
  );
}

export const realBrollComponent = defineComponent({
  type: 'REAL_BROLL',
  version: '1.0.0',
  title: '真实素材',
  description: '真实拍摄/授权素材（未导入时明确占位；不得以 AI 冒充真实画面）',
  inputSchema: realBrollPropsSchema,
  defaults: { assetId: null, assetUrl: null, caption: null, sourceLabel: null, scale: 1, offsetX: 0, offsetY: 0, footageCredit: null },
  supportedAspectRatios: ['16:9', '9:16', '1:1', '4:5'],
  minDurationMs: 2000,
  maxDurationMs: 25_000,
  previewFixture: {
    props: { assetId: 'ast_demo_broll', assetUrl: null, caption: null, sourceLabel: null, footageCredit: '示例素材库' },
    durationMs: 6000,
    aspectRatio: '16:9',
    note: '占位路径：未导入素材',
  },
  renderer: RealBrollScene,
});
