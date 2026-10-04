import { createContext, useContext, type CSSProperties, type ReactNode } from 'react';
import { DEFAULT_THEME_TOKENS, type ThemeTokens } from '@ancs/contracts';

/**
 * 主题上下文（P05-01 / 规范 §57）：
 * 组件**不得写死颜色/字体**——一律经 `useSceneTheme()` 读取 tokens；
 * 主题来源 = Channel/Brand 的 themeTokens（Scene Graph 快照，跨组件品牌一致）。
 */

const SceneThemeContext = createContext<ThemeTokens>(DEFAULT_THEME_TOKENS);

export interface SceneThemeProviderProps {
  theme?: Partial<ThemeTokens> | undefined;
  children: ReactNode;
}

const mergeTheme = (override: Partial<ThemeTokens> | undefined): ThemeTokens => {
  if (override === undefined) return DEFAULT_THEME_TOKENS;
  return {
    font: { ...DEFAULT_THEME_TOKENS.font, ...override.font },
    color: { ...DEFAULT_THEME_TOKENS.color, ...override.color },
    spacing: { ...DEFAULT_THEME_TOKENS.spacing, ...override.spacing },
    radius: { ...DEFAULT_THEME_TOKENS.radius, ...override.radius },
    motion: { ...DEFAULT_THEME_TOKENS.motion, ...override.motion },
  };
};

export function SceneThemeProvider({ theme, children }: SceneThemeProviderProps) {
  return <SceneThemeContext.Provider value={mergeTheme(theme)}>{children}</SceneThemeContext.Provider>;
}

export const useSceneTheme = (): ThemeTokens => useContext(SceneThemeContext);

/** 主题 → 舞台基础样式（背景/前景/字体/内边距；组件在其上排版）。 */
export const stageStyle = (theme: ThemeTokens, padding = theme.spacing.lg * 2): CSSProperties => ({
  backgroundColor: theme.color.background,
  color: theme.color.foreground,
  fontFamily: theme.font.body,
  padding,
  boxSizing: 'border-box',
  position: 'relative',
  width: '100%',
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'center',
  alignItems: 'center',
  overflow: 'hidden',
});
