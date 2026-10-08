export type AppearanceMode = 'system' | 'light' | 'dark';

export const APPEARANCE_COOKIE = 'ancs-qf-appearance';
const STORAGE_PREFIX = 'ancs-qf-appearance:';

export function parseAppearanceCookie(value: string | undefined): { userId: string; mode: 'light' | 'dark' } | null {
  const match = /^([A-Za-z0-9_-]+)\.(light|dark)$/.exec(value ?? '');
  return match ? { userId: match[1]!, mode: match[2] as 'light' | 'dark' } : null;
}

export function initialAppearance(cookieValue: string | undefined, sessionUserId: string | null): AppearanceMode {
  const saved = parseAppearanceCookie(cookieValue);
  return saved && saved.userId === sessionUserId ? saved.mode : 'system';
}

export function deviceAppearance(userId: string): AppearanceMode {
  try {
    const saved = window.localStorage.getItem(STORAGE_PREFIX + userId);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch { /* Browser storage can be disabled; the cookie remains the current-device fallback. */ }
  const cookie = document.cookie.split('; ').find((part) => part.startsWith(`${APPEARANCE_COOKIE}=`));
  const saved = parseAppearanceCookie(cookie?.slice(APPEARANCE_COOKIE.length + 1));
  return saved?.userId === userId ? saved.mode : 'system';
}

export function saveDeviceAppearance(userId: string, mode: AppearanceMode): void {
  try {
    if (mode === 'system') window.localStorage.removeItem(STORAGE_PREFIX + userId);
    else window.localStorage.setItem(STORAGE_PREFIX + userId, mode);
    window.localStorage.removeItem('ancs-qf-theme'); // Legacy unscoped preference has no verifiable owner.
  } catch { /* Cookie still saves the current-device choice. */ }
  document.cookie = mode === 'system'
    ? `${APPEARANCE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`
    : `${APPEARANCE_COOKIE}=${userId}.${mode}; Path=/; Max-Age=31536000; SameSite=Lax`;
}

export function applyAppearance(mode: AppearanceMode): void {
  const systemDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  document.body.dataset['appearanceMode'] = mode;
  document.body.classList.toggle('theme-dark', mode === 'dark' || (mode === 'system' && systemDark));
}
