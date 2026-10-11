import { and, eq } from 'drizzle-orm';
import {
  ApiFailure,
  EDIT_OPERATION_V2_INPUT_SCHEMAS,
  EDIT_OPERATION_V2_REGISTRY,
  ERROR_CODES,
  compareMediaTime,
  editOperationSchema,
  editOperationV2EntrypointSchema,
  keyframeSchema,
  keyframeSourceOperationSchema,
  setAudioAutomationSourceOperationSchema,
  setAudioFadeSourceOperationSchema,
  setAudioGainSourceOperationSchema,
  setAudioPanSourceOperationSchema,
  setClipSpeedSourceOperationSchema,
  type EditOperation,
  type EditOperationV2Entrypoint,
  type EditRequest,
  type SourceEditOperationType,
} from '@ancs/contracts';
import { compositionAnimationBindings } from '@ancs/db';
import type { DomainDeps } from './deps.js';
import { processEdits, type ProcessEditsInput, type ProcessEditsResult } from './edits.js';

export const EDIT_OPERATION_V2_ERROR_REASONS = {
  UNKNOWN: 'UNKNOWN_EDIT_OPERATION_V2',
  PLANNED: 'EDIT_OPERATION_V2_NOT_IMPLEMENTED',
  INVALID_INPUT: 'EDIT_OPERATION_V2_INVALID_INPUT',
  ANIMATION_TARGET_MISMATCH: 'EDIT_OPERATION_V2_ANIMATION_TARGET_MISMATCH',
  KEYFRAME_EXISTS: 'EDIT_OPERATION_V2_KEYFRAME_EXISTS',
  KEYFRAME_MISSING: 'EDIT_OPERATION_V2_KEYFRAME_MISSING',
  EMPTY_KEYFRAMES_UNSUPPORTED: 'EDIT_OPERATION_V2_EMPTY_KEYFRAMES_UNSUPPORTED',
} as const;

interface AnimationState {
  id: string;
  targetKind: 'VISUAL_OBJECT' | 'EFFECT_INSTANCE' | 'AUDIO_REGION';
  targetId: string;
  keyframes: ReturnType<typeof keyframeSchema.parse>[];
}

const operationName = (raw: unknown): string | null => {
  if (typeof raw !== 'object' || raw === null || !('op' in raw)) return null;
  return typeof (raw as { op?: unknown }).op === 'string' ? (raw as { op: string }).op : null;
};

const fail = (
  code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES],
  message: string,
  reason: string,
  status: number,
  details: Record<string, unknown> = {},
): never => {
  throw new ApiFailure(code, message, status, { reason, ...details });
};

const sortedKeyframes = (keyframes: AnimationState['keyframes']): AnimationState['keyframes'] =>
  [...keyframes].sort((left, right) => compareMediaTime(left.time, right.time));

export async function compileEditOperationsV2(
  deps: DomainDeps,
  input: {
    workspaceId: string;
    projectId: string;
    entrypoint: EditOperationV2Entrypoint;
    operations: readonly unknown[];
  },
): Promise<EditOperation[]> {
  editOperationV2EntrypointSchema.parse(input.entrypoint);
  if (input.operations.length === 0) {
    fail(ERROR_CODES.VALIDATION_FAILED, 'edit operation batch must not be empty', EDIT_OPERATION_V2_ERROR_REASONS.INVALID_INPUT, 422);
  }
  const animationCache = new Map<string, AnimationState>();
  const loadAnimation = async (animationId: string): Promise<AnimationState> => {
    const cached = animationCache.get(animationId);
    if (cached) return cached;
    const rows = await deps.db.select().from(compositionAnimationBindings).where(and(
      eq(compositionAnimationBindings.id, animationId),
      eq(compositionAnimationBindings.workspaceId, input.workspaceId),
      eq(compositionAnimationBindings.projectId, input.projectId),
    )).limit(1);
    const row = rows[0];
    if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'animation binding not found', 404);
    const state: AnimationState = {
      id: row.id,
      targetKind: row.targetKind as AnimationState['targetKind'],
      targetId: row.targetId,
      keyframes: keyframeSchema.array().min(1).parse(row.keyframes),
    };
    animationCache.set(animationId, state);
    return state;
  };
  const compiled: EditOperation[] = [];

  for (const raw of input.operations) {
    const name = operationName(raw);
    const registration = name === null ? undefined : EDIT_OPERATION_V2_REGISTRY[name as SourceEditOperationType];
    const definition = registration ?? fail(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'unknown Edit Operation v2 operation', EDIT_OPERATION_V2_ERROR_REASONS.UNKNOWN, 501, { operation: name });
    const parsed = EDIT_OPERATION_V2_INPUT_SCHEMAS[definition.operation].safeParse(raw);
    if (!parsed.success) {
      fail(ERROR_CODES.VALIDATION_FAILED, 'invalid Edit Operation v2 input', EDIT_OPERATION_V2_ERROR_REASONS.INVALID_INPUT, 422, {
        operation: definition.operation,
        issues: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
      });
    }
    if (definition.resolution === 'PLANNED') {
      fail(ERROR_CODES.CAPABILITY_UNAVAILABLE, `operation ${definition.operation} is planned and has no executable handler`, EDIT_OPERATION_V2_ERROR_REASONS.PLANNED, 501, {
        operation: definition.operation,
        category: definition.category,
        plannedTask: definition.plannedTask,
      });
    }
    if (definition.resolution === 'NATIVE') {
      const native = editOperationSchema.safeParse(raw);
      if (!native.success) {
        fail(ERROR_CODES.VALIDATION_FAILED, 'native operation does not match the canonical schema', EDIT_OPERATION_V2_ERROR_REASONS.INVALID_INPUT, 422, { operation: definition.operation });
      }
      compiled.push(editOperationSchema.parse(raw));
      continue;
    }

    let operation: EditOperation | null = null;
    switch (definition.operation) {
      case 'set_clip_speed': {
        const value = setClipSpeedSourceOperationSchema.parse(raw);
        operation = { op: 'update_clip', clipId: value.clipId, changes: {
          timeMapping: value.timeMapping,
          ...(value.sourceRange === undefined ? {} : { sourceRange: value.sourceRange }),
          ...(value.sequenceRange === undefined ? {} : { sequenceRange: value.sequenceRange }),
        } };
        break;
      }
      case 'set_audio_gain': {
        const value = setAudioGainSourceOperationSchema.parse(raw);
        operation = { op: 'update_audio_region', audioRegionId: value.audioRegionId, changes: { gainDb: value.gainDb } };
        break;
      }
      case 'set_audio_fade': {
        const value = setAudioFadeSourceOperationSchema.parse(raw);
        operation = { op: 'update_audio_region', audioRegionId: value.audioRegionId, changes: {
          ...(value.fadeIn === undefined ? {} : { fadeIn: value.fadeIn }),
          ...(value.fadeOut === undefined ? {} : { fadeOut: value.fadeOut }),
        } };
        break;
      }
      case 'set_audio_pan': {
        const value = setAudioPanSourceOperationSchema.parse(raw);
        operation = { op: 'update_audio_region', audioRegionId: value.audioRegionId, changes: { pan: value.pan } };
        break;
      }
      case 'set_audio_automation': {
        const value = setAudioAutomationSourceOperationSchema.parse(raw);
        const state = await loadAnimation(value.animationId);
        if (state.targetKind !== 'AUDIO_REGION' || state.targetId !== value.audioRegionId) {
          fail(ERROR_CODES.PRECONDITION_FAILED, 'audio automation target does not match the stored animation', EDIT_OPERATION_V2_ERROR_REASONS.ANIMATION_TARGET_MISMATCH, 409, { animationId: value.animationId });
        }
        state.keyframes = value.keyframes;
        operation = { op: 'update_animation', animationId: state.id, targetKind: state.targetKind, targetId: state.targetId, keyframes: state.keyframes };
        break;
      }
      case 'add_keyframe':
      case 'update_keyframe':
      case 'remove_keyframe': {
        const value = keyframeSourceOperationSchema.parse(raw);
        const state = await loadAnimation(value.animationId);
        if (state.targetKind !== value.targetKind || state.targetId !== value.targetId) {
          fail(ERROR_CODES.PRECONDITION_FAILED, 'keyframe target does not match the stored animation', EDIT_OPERATION_V2_ERROR_REASONS.ANIMATION_TARGET_MISMATCH, 409, { animationId: value.animationId });
        }
        if (value.op === 'add_keyframe') {
          if (state.keyframes.some((item) => item.id === value.keyframe.id)) fail(ERROR_CODES.PRECONDITION_FAILED, 'keyframe id already exists', EDIT_OPERATION_V2_ERROR_REASONS.KEYFRAME_EXISTS, 409, { keyframeId: value.keyframe.id });
          state.keyframes = keyframeSchema.array().min(1).parse(sortedKeyframes([...state.keyframes, value.keyframe]));
        } else if (value.op === 'update_keyframe') {
          const index = state.keyframes.findIndex((item) => item.id === value.keyframe.id);
          if (index < 0) fail(ERROR_CODES.NOT_FOUND, 'keyframe does not exist', EDIT_OPERATION_V2_ERROR_REASONS.KEYFRAME_MISSING, 404, { keyframeId: value.keyframe.id });
          state.keyframes = keyframeSchema.array().min(1).parse(sortedKeyframes(state.keyframes.map((item, itemIndex) => itemIndex === index ? value.keyframe : item)));
        } else {
          if (!state.keyframes.some((item) => item.id === value.keyframeId)) fail(ERROR_CODES.NOT_FOUND, 'keyframe does not exist', EDIT_OPERATION_V2_ERROR_REASONS.KEYFRAME_MISSING, 404, { keyframeId: value.keyframeId });
          const remaining = state.keyframes.filter((item) => item.id !== value.keyframeId);
          if (remaining.length === 0) fail(ERROR_CODES.PRECONDITION_FAILED, 'removing the final keyframe requires removing the animation binding', EDIT_OPERATION_V2_ERROR_REASONS.EMPTY_KEYFRAMES_UNSUPPORTED, 409, { keyframeId: value.keyframeId });
          state.keyframes = remaining;
        }
        operation = { op: 'update_animation', animationId: state.id, targetKind: state.targetKind, targetId: state.targetId, keyframes: state.keyframes };
        break;
      }
      default:
        fail(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'Edit Operation v2 alias has no compiler', EDIT_OPERATION_V2_ERROR_REASONS.PLANNED, 501, { operation: definition.operation });
    }
    if (operation === null) fail(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'Edit Operation v2 compiler produced no operation', EDIT_OPERATION_V2_ERROR_REASONS.PLANNED, 501, { operation: definition.operation });
    const canonical = editOperationSchema.safeParse(operation);
    if (!canonical.success) {
      fail(ERROR_CODES.VALIDATION_FAILED, 'compiled operation violates the canonical edit schema', EDIT_OPERATION_V2_ERROR_REASONS.INVALID_INPUT, 422, {
        operation: definition.operation,
        issues: canonical.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
      });
    }
    compiled.push(editOperationSchema.parse(operation));
  }
  return compiled;
}

export interface ProcessEditsV2Input extends Omit<ProcessEditsInput, 'request'> {
  entrypoint: EditOperationV2Entrypoint;
  request: Omit<EditRequest, 'operations'> & { operations: unknown[] };
}

/** All GUI, shortcut, Agent and legacy aliases converge on the existing transactional executor. */
export async function processEditsV2(deps: DomainDeps, input: ProcessEditsV2Input): Promise<ProcessEditsResult> {
  const { entrypoint, request, ...execution } = input;
  const operations = await compileEditOperationsV2(deps, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    entrypoint,
    operations: request.operations,
  });
  return processEdits(deps, { ...execution, request: { ...request, operations } });
}
