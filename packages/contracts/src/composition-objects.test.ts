import { describe, expect, it } from 'vitest';
import {
  createAnimationBindingRequestSchema,
  createAudioRegionRequestSchema,
  createVisualObjectRequestSchema,
  timeBindingSchema,
} from './composition-objects.js';
import { legacyMillisecondsToMediaTime } from './common/media-time.js';

const mt = (milliseconds: number) => legacyMillisecondsToMediaTime(milliseconds);
const range = (start: number, end: number) => ({ start: mt(start), end: mt(end) });
const clipLocal = { basis: 'CLIP_LOCAL' as const, clipId: 'clp_1', semanticCueId: null };

describe('N01-04 composition object contracts', () => {
  it('requires the identifiers appropriate to each local time basis', () => {
    expect(timeBindingSchema.safeParse({ basis: 'CLIP_LOCAL', clipId: null, semanticCueId: null }).success).toBe(false);
    expect(timeBindingSchema.safeParse({ basis: 'SOURCE', clipId: 'clp_1', semanticCueId: null }).success).toBe(true);
    expect(timeBindingSchema.safeParse({ basis: 'SEMANTIC_CUE', clipId: null, semanticCueId: 'cue_1' }).success).toBe(true);
    expect(timeBindingSchema.safeParse({ basis: 'SEQUENCE', clipId: 'clp_1', semanticCueId: null }).success).toBe(false);
  });

  it('preserves versioned component parameters and rejects non-JSON values', () => {
    const base = {
      trackId: 'trk_1',
      kind: 'COMPONENT' as const,
      parentObjectId: null,
      semanticSceneId: null,
      timeBinding: clipLocal,
      localRange: range(0, 1_000),
      parameters: { schemaVersion: '1.0', values: { title: '标题', position: [0.5, 0.25] } },
    };
    expect(createVisualObjectRequestSchema.parse({ ...base, component: { componentId: 'title', componentVersion: '2.0' } }).parameters.values['title']).toBe('标题');
    expect(createVisualObjectRequestSchema.safeParse({ ...base, component: null }).success).toBe(false);
    expect(createVisualObjectRequestSchema.safeParse({
      ...base,
      component: { componentId: 'title', componentVersion: '2.0' },
      parameters: { schemaVersion: '1.0', values: { callback: () => undefined } },
    }).success).toBe(false);
  });

  it('accepts linear/hold keyframes and rejects unsupported easing or invalid audio bounds', () => {
    const animation = {
      targetKind: 'VISUAL_OBJECT' as const,
      targetId: 'vobj_1',
      propertyPath: 'transform.opacity',
      parameterSchemaVersion: '1.0',
      timeBinding: clipLocal,
      keyframes: [
        { time: mt(0), value: 0, interpolation: 'LINEAR' as const },
        { time: mt(1_000), value: 1, interpolation: 'HOLD' as const },
      ],
    };
    expect(createAnimationBindingRequestSchema.safeParse(animation).success).toBe(true);
    expect(createAnimationBindingRequestSchema.safeParse({
      ...animation,
      keyframes: [{ time: mt(0), value: 0, interpolation: 'BEZIER' }],
    }).success).toBe(false);
    expect(createAudioRegionRequestSchema.safeParse({
      trackId: 'trk_audio',
      timeBinding: clipLocal,
      localRange: range(0, 1_000),
      sourceStreamId: 'main',
      channelMapping: [{ sourceChannel: 0, outputChannel: 0 }],
      gainDb: 25,
      pan: 0,
      fadeIn: mt(0),
      fadeOut: mt(0),
      parameters: { schemaVersion: '1.0', values: {} },
    }).success).toBe(false);
  });
});
