import type { AppearanceMode, UserAppearancePreference } from '@ancs/contracts';
export type { AppearanceMode } from '@ancs/contracts';

export const APPEARANCE_COOKIE = 'ancs-qf-appearance';
const STORAGE_PREFIX = 'ancs-qf-appearance:';

export function parseAppearanceCookie(value: string | undefined): { userId: string; mode: AppearanceMode } | null {
  const match = /^([A-Za-z0-9_-]+)\.(system|light|dark)$/.exec(value ?? '');
  return match ? { userId: match[1]!, mode: match[2] as AppearanceMode } : null;
}

export function initialAppearance(cookieValue: string | undefined, account: UserAppearancePreference | null): AppearanceMode {
  const saved = parseAppearanceCookie(cookieValue);
  return saved && saved.userId === account?.userId ? saved.mode : account?.mode ?? 'system';
}

export function deviceAppearance(userId: string): AppearanceMode | null {
  try {
    const saved = window.localStorage.getItem(STORAGE_PREFIX + userId);
    if (saved === 'system' || saved === 'light' || saved === 'dark') return saved;
  } catch { /* Browser storage can be disabled; the cookie remains the current-device fallback. */ }
  const cookie = document.cookie.split('; ').find((part) => part.startsWith(`${APPEARANCE_COOKIE}=`));
  const saved = parseAppearanceCookie(cookie?.slice(APPEARANCE_COOKIE.length + 1));
  return saved?.userId === userId ? saved.mode : null;
}

export function saveDeviceAppearance(userId: string, mode: AppearanceMode | null): void {
  try {
    if (mode === null) window.localStorage.removeItem(STORAGE_PREFIX + userId);
    else window.localStorage.setItem(STORAGE_PREFIX + userId, mode);
    window.localStorage.removeItem('ancs-qf-theme'); // Legacy unscoped preference has no verifiable owner.
  } catch { /* Cookie still saves the current-device choice. */ }
  document.cookie = mode === null
    ? `${APPEARANCE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`
    : `${APPEARANCE_COOKIE}=${userId}.${mode}; Path=/; Max-Age=31536000; SameSite=Lax`;
}

export function applyAppearance(mode: AppearanceMode): void {
  const systemDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  const body = document.body;
  // Switching appearance is a state change, not motion: hold control transitions (ui-tokens.css) for two frames so every colour flips at once.
  body.dataset['themeSwitching'] = '';
  body.dataset['appearanceMode'] = mode;
  body.classList.toggle('theme-dark', mode === 'dark' || (mode === 'system' && systemDark));
  const release = () => { delete body.dataset['themeSwitching']; };
  if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(() => window.requestAnimationFrame(release));
  else release();
}
