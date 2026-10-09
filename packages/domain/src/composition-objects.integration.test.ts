import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { legacyMillisecondsToMediaTime } from '@ancs/contracts';
import {
  assets,
  assetVersions,
  compositionEffectInstances,
  createDb,
  redactDatabaseUrl,
  resolveTestDatabaseUrl,
  runMigrations,
  workspaces,
  type DbHandle,
} from '@ancs/db';
import {
  assembleProjectDocument,
  assertEffectExecutionSupported,
  createAnimationBinding,
  createAudioRegion,
  createCaptionSpan,
  createChannel,
  createClip,
  createEffectInstance,
  createProject,
  createRender,
  createSequence,
  createTrack,
  createVisualObject,
  repositionVisualObject,
  type DomainDeps,
} from './index.js';

let handle: DbHandle;
const deps = (): DomainDeps => ({ db: handle.db });
const mt = (milliseconds: number) => legacyMillisecondsToMediaTime(milliseconds);
const range = (start: number, end: number) => ({ start: mt(start), end: mt(end) });
const clipLocal = (clipId: string) => ({ basis: 'CLIP_LOCAL' as const, clipId, semanticCueId: null });
const params = (values: Record<string, unknown> = {}) => ({ schemaVersion: '1.0', values });

beforeAll(async () => {
  const url = resolveTestDatabaseUrl();
  handle = createDb(url);
  try { await handle.pool.query('select 1'); }
  catch (error) {
    await handle.close();
    throw new Error(`Cannot connect to test database ${redactDatabaseUrl(url)}`, { cause: error });
  }
  await runMigrations(handle);
});

afterAll(async () => { await handle.close(); });
beforeEach(async () => { await handle.db.delete(workspaces); });

async function fixture(tag: string) {
  const workspaceId = `ws_${randomUUID()}`;
  await handle.db.insert(workspaces).values({ id: workspaceId, name: `N01-04 ${tag}` });
  const channel = await createChannel(deps(), { workspaceId, input: { name: '对象栏目' } });
  const project = await createProject(deps(), { workspaceId, input: { title: `对象工程 ${tag}`, channelId: channel.id, mode: 'FOOTAGE_EDIT' } });
  const assetId = `ast_${randomUUID()}`;
  const assetVersionId = `av_${randomUUID()}`;
  await handle.db.insert(assets).values({
    id: assetId,
    workspaceId,
    projectId: project.id,
    assetType: 'UPLOADED_VIDEO',
    origin: 'USER_UPLOAD',
    status: 'READY',
    retentionClass: 'PROJECT',
    license: { kind: 'OWNED' },
    currentVersionId: assetVersionId,
  });
  await handle.db.insert(assetVersions).values({
    id: assetVersionId,
    assetId,
    workspaceId,
    versionNumber: 1,
    storageKey: `n01-04/${assetVersionId}.mp4`,
    mimeType: 'video/mp4',
    sizeBytes: 1000,
    checksumSha256: '1'.repeat(64),
    durationMs: 20_000,
    width: 1920,
    height: 1080,
    status: 'READY',
  });
  const sequence = await createSequence(deps(), { workspaceId, projectId: project.id, input: { name: '主序列', frameRate: { num: 30, den: 1 }, duration: mt(30_000) } });
  const video = await createTrack(deps(), { workspaceId, projectId: project.id, sequenceId: sequence.id, input: { kind: 'VIDEO', position: 0, name: 'V1' } });
  const graphic = await createTrack(deps(), { workspaceId, projectId: project.id, sequenceId: sequence.id, input: { kind: 'GRAPHIC', position: 1, name: 'G1' } });
  const caption = await createTrack(deps(), { workspaceId, projectId: project.id, sequenceId: sequence.id, input: { kind: 'CAPTION', position: 2, name: 'C1' } });
  const audio = await createTrack(deps(), { workspaceId, projectId: project.id, sequenceId: sequence.id, input: { kind: 'AUDIO', position: 3, name: 'A1' } });
  const clip = await createClip(deps(), {
    workspaceId,
    projectId: project.id,
    sequenceId: sequence.id,
    input: {
      trackId: video.id,
      assetVersionId,
      sourceStreamId: 'audio-main',
      sourceRange: range(0, 10_000),
      sequenceRange: range(5_000, 15_000),
      timeMapping: { kind: 'LINEAR', rate: { num: 1, den: 1 }, direction: 'FORWARD', preservePitch: true },
    },
  });
  return { workspaceId, projectId: project.id, sequence, video, graphic, caption, audio, clip };
}

describe('N01-04 normalized composition objects', () => {
  it('keeps a component object id stable while moving it and binds versioned effects and keyframes', async () => {
    const f = await fixture('visual');
    const visual = await createVisualObject(deps(), {
      workspaceId: f.workspaceId,
      projectId: f.projectId,
      sequenceId: f.sequence.id,
      input: {
        trackId: f.graphic.id,
        kind: 'COMPONENT',
        parentObjectId: null,
        semanticSceneId: null,
        timeBinding: clipLocal(f.clip.id),
        localRange: range(1_000, 3_000),
        component: { componentId: 'lower-third', componentVersion: '2.1.0' },
        parameters: params({ title: '稳定对象' }),
      },
    });
    expect(visual.sequenceRange).toEqual(range(6_000, 8_000));

    const moved = await repositionVisualObject(deps(), {
      workspaceId: f.workspaceId,
      projectId: f.projectId,
      sequenceId: f.sequence.id,
      objectId: visual.id,
      input: { trackId: f.video.id, timeBinding: clipLocal(f.clip.id), localRange: range(2_000, 4_000) },
    });
    expect(moved.id).toBe(visual.id);
    expect(moved.component).toEqual(visual.component);
    expect(moved.parameters).toEqual(visual.parameters);
    expect(moved.sequenceRange).toEqual(range(7_000, 9_000));

    const effect = await createEffectInstance(deps(), {
      workspaceId: f.workspaceId,
      projectId: f.projectId,
      input: { targetKind: 'VISUAL_OBJECT', targetId: moved.id, effectType: 'TRANSFORM', effectVersion: '1.0', parameters: params({ x: 24 }) },
    });
    let unavailable: unknown;
    try { assertEffectExecutionSupported(effect, new Set()); }
    catch (error) { unavailable = error; }
    expect(unavailable).toMatchObject({ details: { reason: 'EFFECT_EXECUTION_UNAVAILABLE' } });
    expect(() => assertEffectExecutionSupported(effect, new Set([effect.requiredCapability]))).not.toThrow();

    const animation = await createAnimationBinding(deps(), {
      workspaceId: f.workspaceId,
      projectId: f.projectId,
      input: {
        targetKind: 'EFFECT_INSTANCE',
        targetId: effect.id,
        propertyPath: 'transform.x',
        parameterSchemaVersion: '1.0',
        timeBinding: clipLocal(f.clip.id),
        keyframes: [
          { time: mt(2_000), value: 24, interpolation: 'LINEAR' },
          { time: mt(4_000), value: 120, interpolation: 'HOLD' },
        ],
      },
    });
    expect(animation.keyframes.map((item) => item.value)).toEqual([24, 120]);

    const document = await assembleProjectDocument(deps(), { workspaceId: f.workspaceId, projectId: f.projectId });
    expect(document.composition.visualObjects.map((item) => item.id)).toEqual([visual.id]);
    expect(document.composition.effects.map((item) => item.id)).toEqual([effect.id]);
    expect(document.composition.animations.map((item) => item.id)).toEqual([animation.id]);
    await expect(createRender(deps(), {
      workspaceId: f.workspaceId,
      projectId: f.projectId,
      request: { profile: 'STUDIO_1080' },
    })).rejects.toMatchObject({ details: { reason: 'NORMALIZED_COMPOSITION_RENDER_UNAVAILABLE' } });
  });

  it('maps caption and audio clip-local time exactly into sequence time', async () => {
    const f = await fixture('timing');
    const caption = await createCaptionSpan(deps(), {
      workspaceId: f.workspaceId,
      projectId: f.projectId,
      sequenceId: f.sequence.id,
      input: {
        trackId: f.caption.id,
        timeBinding: clipLocal(f.clip.id),
        localRange: range(0, 2_000),
        text: '局部字幕',
        languageTag: 'zh-CN',
        style: params({ align: 'center' }),
        words: [{ text: '局部', range: range(0, 1_000) }, { text: '字幕', range: range(1_000, 2_000) }],
        speechAnchorId: null,
      },
    });
    expect(caption.sequenceRange).toEqual(range(5_000, 7_000));

    const audio = await createAudioRegion(deps(), {
      workspaceId: f.workspaceId,
      projectId: f.projectId,
      sequenceId: f.sequence.id,
      input: {
        trackId: f.audio.id,
        timeBinding: clipLocal(f.clip.id),
        localRange: range(2_000, 6_000),
        sourceStreamId: 'audio-main',
        channelMapping: [{ sourceChannel: 0, outputChannel: 0 }, { sourceChannel: 1, outputChannel: 1 }],
        gainDb: -3,
        pan: 0.25,
        fadeIn: mt(250),
        fadeOut: mt(500),
        parameters: params({ preserveOriginal: true }),
      },
    });
    expect(audio.sequenceRange).toEqual(range(7_000, 11_000));
    expect(audio.gainDb).toBe(-3);

    const document = await assembleProjectDocument(deps(), { workspaceId: f.workspaceId, projectId: f.projectId });
    expect(document.composition.captions.map((item) => item.id)).toEqual([caption.id]);
    expect(document.composition.audioRegions.map((item) => item.id)).toEqual([audio.id]);
  });

  it('rejects unsupported effects, wrong tracks and invalid local ranges instead of silently ignoring them', async () => {
    const f = await fixture('negative');
    await expect(createEffectInstance(deps(), {
      workspaceId: f.workspaceId,
      projectId: f.projectId,
      input: { targetKind: 'CLIP', targetId: f.clip.id, effectType: 'UNKNOWN_MAGIC', effectVersion: '9.9', parameters: params() },
    })).rejects.toMatchObject({ details: { reason: 'UNSUPPORTED_EFFECT' } });
    expect(await handle.db.select().from(compositionEffectInstances)).toHaveLength(0);

    await expect(createCaptionSpan(deps(), {
      workspaceId: f.workspaceId,
      projectId: f.projectId,
      sequenceId: f.sequence.id,
      input: {
        trackId: f.audio.id,
        timeBinding: clipLocal(f.clip.id),
        localRange: range(0, 1_000),
        text: '错误轨道',
        languageTag: 'zh-CN',
        style: params(),
        words: [],
        speechAnchorId: null,
      },
    })).rejects.toMatchObject({ details: { reason: 'TRACK_KIND_MISMATCH' } });

    await expect(createAudioRegion(deps(), {
      workspaceId: f.workspaceId,
      projectId: f.projectId,
      sequenceId: f.sequence.id,
      input: {
        trackId: f.audio.id,
        timeBinding: clipLocal(f.clip.id),
        localRange: range(9_000, 11_000),
        sourceStreamId: 'audio-main',
        channelMapping: [{ sourceChannel: 0, outputChannel: 0 }],
        gainDb: 0,
        pan: 0,
        fadeIn: mt(0),
        fadeOut: mt(0),
        parameters: params(),
      },
    })).rejects.toMatchObject({ details: { reason: 'CLIP_LOCAL_RANGE_OUT_OF_BOUNDS' } });
  });
});
