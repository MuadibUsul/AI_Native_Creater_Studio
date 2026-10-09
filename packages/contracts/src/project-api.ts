import { z } from 'zod';
import { editEventSchema } from './history.js';
import { objectLockSchema } from './object-locks.js';
import { projectDocumentSchema } from './project-document.js';
import { clipInstanceViewSchema, mediaSourceViewSchema } from './media-source.js';

export const PROJECT_API_SCHEMA_VERSION = '1.0' as const;

export const projectStateSchema = z.object({
  schemaVersion: z.literal(PROJECT_API_SCHEMA_VERSION),
  document: projectDocumentSchema,
  locks: z.array(objectLockSchema),
  mediaSources: z.array(mediaSourceViewSchema),
  clipInstances: z.array(clipInstanceViewSchema),
  eventSeq: z.number().int().nonnegative(),
}).strict();

export const projectEditEventSchema = editEventSchema.extend({
  seq: z.number().int().positive(),
}).strict();

export const projectEditEventPageSchema = z.object({
  schemaVersion: z.literal(PROJECT_API_SCHEMA_VERSION),
  items: z.array(projectEditEventSchema),
  nextAfterSeq: z.number().int().positive().nullable(),
}).strict();

export type ProjectState = z.infer<typeof projectStateSchema>;
export type ProjectEditEvent = z.infer<typeof projectEditEventSchema>;
export type ProjectEditEventPage = z.infer<typeof projectEditEventPageSchema>;
