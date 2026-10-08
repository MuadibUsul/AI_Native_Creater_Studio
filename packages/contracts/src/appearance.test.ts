import { describe, expect, it } from 'vitest';
import { appearanceModeSchema, setUserAppearancePreferenceRequestSchema, userAppearancePreferenceSchema } from './appearance.js';

describe('N16-02 外观偏好契约', () => {
  it('只接受 system/light/dark 并保留当前用户身份', () => {
    for (const mode of ['system', 'light', 'dark']) {
      expect(appearanceModeSchema.parse(mode)).toBe(mode);
      expect(setUserAppearancePreferenceRequestSchema.parse({ mode })).toEqual({ mode });
      expect(userAppearancePreferenceSchema.parse({ userId: 'usr_a', mode, updatedAt: null }).userId).toBe('usr_a');
    }
    expect(appearanceModeSchema.safeParse('auto').success).toBe(false);
    expect(setUserAppearancePreferenceRequestSchema.safeParse({ mode: 'dark', userId: 'usr_other' }).success).toBe(false);
  });
});
