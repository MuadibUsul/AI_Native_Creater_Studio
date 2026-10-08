import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';

/** Workspace-only storage usage. No asset names, paths, keys or other tenants. */
export const opsWorkspaceStorageSummarySchema = z.object({
  workspaceId: opaqueIdSchema,
  bytesUsed: z.number().int().nonnegative(),
  assetCount: z.number().int().nonnegative(),
}).strict();

export type OpsWorkspaceStorageSummary = z.infer<typeof opsWorkspaceStorageSummarySchema>;
