import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';

/** UI appearance only; never changes project content or rendered media. */
export const APPEARANCE_MODES = ['system', 'light', 'dark'] as const;
export const appearanceModeSchema = z.enum(APPEARANCE_MODES);
export type AppearanceMode = z.infer<typeof appearanceModeSchema>;

export const userAppearancePreferenceSchema = z.object({
  userId: opaqueIdSchema,
  mode: appearanceModeSchema,
  updatedAt: isoDateTimeSchema.nullable(),
});
export type UserAppearancePreference = z.infer<typeof userAppearancePreferenceSchema>;

export const setUserAppearancePreferenceRequestSchema = z.object({ mode: appearanceModeSchema }).strict();
export type SetUserAppearancePreferenceRequest = z.infer<typeof setUserAppearancePreferenceRequestSchema>;
