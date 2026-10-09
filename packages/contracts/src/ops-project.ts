import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';
import { projectStatusSchema } from './projects.js';

/** Workspace-scoped operations list; project titles and customer content are excluded. */
export const opsProjectSummarySchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  status: projectStatusSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
}).strict();
export type OpsProjectSummary = z.infer<typeof opsProjectSummarySchema>;

export const opsProjectListQuerySchema = z.object({
  workspaceId: opaqueIdSchema,
  status: projectStatusSchema.optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
}).strict();
export type OpsProjectListQuery = z.infer<typeof opsProjectListQuerySchema>;
