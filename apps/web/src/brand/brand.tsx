import { useId } from 'react';

/**
 * 产品品牌（D-02 待所有者确认）：缺省名 Kinora，改名只改这里（另有 app/manifest.ts、app/icon.svg、public/icons、文案里的产品名）。
 * 标志：竖笔是时间线播放头，两臂张开成"K"，臂间一道声波——会听的剪辑师。源文件与用法见 docs/brand/。
 * 颜色写在 SVG 里（品牌内容，不是界面 token）；界面配色仍只用中性 token（ADR 0019）。
 */
export const BRAND_NAME = 'Kinora';

const GRADIENT_STOPS = [['0', '#B9A6FF'], ['0.5', '#7C5CFF'], ['1', '#4FD8FF']] as const;

/** 全彩标志：竖笔用当前文字色（深浅主题自动适配），两臂与声波用品牌渐变。 */
export function BrandMark({ size = 24, title }: { size?: number; title?: string }) {
  const id = useId().replaceAll(':', '');
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" role={title === undefined ? undefined : 'img'} aria-hidden={title === undefined ? true : undefined} aria-label={title}>
      <defs>
        <linearGradient id={`kg${id}`} x1="20" y1="8" x2="56" y2="58" gradientUnits="userSpaceOnUse">
          {GRADIENT_STOPS.map(([offset, color]) => <stop key={offset} offset={offset} stopColor={color} />)}
        </linearGradient>
      </defs>
      <rect x="11" y="7" width="7" height="50" rx="3.5" fill="currentColor" />
      <path d="M48 9 23.5 33 49 57" stroke={`url(#kg${id})`} strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M40.5 23.5a19 19 0 0 1 0 19" stroke={`url(#kg${id})`} strokeWidth="4.5" strokeLinecap="round" />
    </svg>
  );
}

/** 应用图标：渐变圆角方块里的白色标志（侧栏、收藏夹图标、主屏幕图标同一造型）。 */
export function BrandTile({ size = 32 }: { size?: number }) {
  const id = useId().replaceAll(':', '');
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={`kt${id}`} x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
          {GRADIENT_STOPS.map(([offset, color]) => <stop key={offset} offset={offset} stopColor={color} />)}
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="20" fill={`url(#kt${id})`} />
      <rect x="15" y="12" width="6" height="40" rx="3" fill="#fff" />
      <path d="M44 14 25.5 32 45 50" stroke="#fff" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M38 25.5a14 14 0 0 1 0 13" stroke="#fff" strokeWidth="4" strokeLinecap="round" opacity="0.85" />
    </svg>
  );
}
