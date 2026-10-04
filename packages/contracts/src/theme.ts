import { z } from 'zod';

/**
 * 主题与设计 tokens（规范 §57 / P01-04）：
 * 每个 Scene Component 不写死颜色/字体，统一由 Token 体系驱动；
 * Creator Profile / Channel 选择并保存 Theme，跨组件保持品牌一致。
 */

export const themeTokensSchema = z.object({
  font: z.object({
    heading: z.string().min(1),
    body: z.string().min(1),
  }),
  color: z.object({
    background: z.string().min(1),
    foreground: z.string().min(1),
    accent: z.string().min(1),
    positive: z.string().min(1),
    negative: z.string().min(1),
  }),
  spacing: z.object({
    sm: z.number().positive(),
    md: z.number().positive(),
    lg: z.number().positive(),
  }),
  radius: z.object({
    sm: z.number().nonnegative(),
    md: z.number().nonnegative(),
    lg: z.number().nonnegative(),
  }),
  motion: z.object({
    durationFastMs: z.number().int().positive(),
    durationBaseMs: z.number().int().positive(),
    easing: z.string().min(1),
  }),
});

export type ThemeTokens = z.infer<typeof themeTokensSchema>;

/** 默认主题（可被 Channel / Brand 覆盖；P05-01 组件协议以此为输入）。 */
export const DEFAULT_THEME_TOKENS: ThemeTokens = {
  font: {
    heading: 'Inter, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif',
    body: 'Inter, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif',
  },
  color: {
    background: '#0B1220',
    foreground: '#F5F8FF',
    accent: '#4F8CFF',
    positive: '#34C77B',
    negative: '#E5484D',
  },
  spacing: { sm: 8, md: 16, lg: 32 },
  radius: { sm: 4, md: 8, lg: 16 },
  motion: { durationFastMs: 200, durationBaseMs: 400, easing: 'ease-out' },
};
