import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';
import { supportGrantStatusSchema } from './security-ops.js';

/** Ticket-scoped support grant metadata. The reason and operator identities stay private. */
export const opsSupportGrantSummarySchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  scope: z.literal('SUMMARY_READ'),
  status: supportGrantStatusSchema,
  createdAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
}).strict();
export type OpsSupportGrantSummary = z.infer<typeof opsSupportGrantSummarySchema>;

export const opsSupportGrantListQuerySchema = z.object({
  ticketId: z.string().min(1).max(128),
}).strict();
