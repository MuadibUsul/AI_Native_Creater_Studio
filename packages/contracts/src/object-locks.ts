import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';

export const OBJECT_LOCK_DIMENSIONS = ['CONTENT', 'POSITION', 'DURATION', 'ASSET', 'STYLE', 'TRACK'] as const;
export const objectLockDimensionSchema = z.enum(OBJECT_LOCK_DIMENSIONS);
export const OBJECT_LOCK_KINDS = ['PROJECT', 'SCENE', 'SEQUENCE', 'TRACK', 'CLIP', 'VISUAL_OBJECT', 'CAPTION', 'AUDIO_REGION'] as const;
export const objectLockKindSchema = z.enum(OBJECT_LOCK_KINDS);

export const objectLockSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  objectKind: objectLockKindSchema,
  objectId: opaqueIdSchema,
  dimensions: z.array(objectLockDimensionSchema).min(1),
  reason: z.string().max(500).nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
}).strict();

export const setObjectLockOperationSchema = z.object({
  op: z.literal('set_object_lock'),
  objectKind: objectLockKindSchema,
  objectId: opaqueIdSchema,
  dimensions: z.array(objectLockDimensionSchema).min(1),
  locked: z.boolean(),
  reason: z.string().max(500).nullable().optional(),
}).strict();

export type ObjectLockDimension = z.infer<typeof objectLockDimensionSchema>;
export type ObjectLockKind = z.infer<typeof objectLockKindSchema>;
export type ObjectLock = z.infer<typeof objectLockSchema>;
