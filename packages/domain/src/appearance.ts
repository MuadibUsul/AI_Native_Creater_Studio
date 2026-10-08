import { eq } from 'drizzle-orm';
import { userAppearancePreferences } from '@ancs/db';
import type { AppearanceMode, UserAppearancePreference } from '@ancs/contracts';
import type { DomainDeps } from './channels.js';

/** An absent row has the same meaning as an explicit synced `system` preference. */
export async function getUserAppearance(deps: DomainDeps, userId: string): Promise<UserAppearancePreference> {
  const [row] = await deps.db.select().from(userAppearancePreferences)
    .where(eq(userAppearancePreferences.userId, userId)).limit(1);
  return { userId, mode: (row?.mode as AppearanceMode | undefined) ?? 'system', updatedAt: row?.updatedAt.toISOString() ?? null };
}

export async function setUserAppearance(deps: DomainDeps, userId: string, mode: AppearanceMode): Promise<UserAppearancePreference> {
  const [row] = await deps.db.insert(userAppearancePreferences)
    .values({ userId, mode, updatedAt: new Date() })
    .onConflictDoUpdate({ target: userAppearancePreferences.userId, set: { mode, updatedAt: new Date() } })
    .returning();
  return { userId, mode: row!.mode as AppearanceMode, updatedAt: row!.updatedAt.toISOString() };
}
