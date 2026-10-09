import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createProcessMediaVisualAnalysisAdapter } from './visual-analysis-process.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('process visual analysis adapter', () => {
  it('parses a bounded child-process response and preserves anonymous uncertainty evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ancs-visual-process-')); roots.push(root);
    const script = join(root, 'adapter.mjs');
    const result = { schemaVersion: '1.0', processorVersion: 'source-visual-analysis-v1', adapter: 'process-fixture', modelVersion: 'fixture-v1', sampledFrameCount: 2, durationMs: 1000, objectTracks: [], personTracks: [{ id: 'p1', label: 'person', identityState: 'UNKNOWN', confidencePermille: 600, lifecycle: 'OCCLUDED', keyframes: [{ pts: '10', box: [0, 0, 0.5, 1], state: 'UNCERTAIN', confidencePermille: 400 }], evidenceFrames: [{ pts: '10', timeBase: { numerator: 1, denominator: 1000 }, frameRef: 'f10' }], sourceStartPts: '0', sourceEndPts: '1000', timeBase: { numerator: 1, denominator: 1000 } }], actionEvents: [], visualEvents: [], motionIntensity: [] };
    await writeFile(script, `console.log(${JSON.stringify(JSON.stringify(result))});`);
    const parsed = await createProcessMediaVisualAnalysisAdapter({ executable: process.execPath, args: [script], timeoutMs: 5000 }).analyze({ sourcePath: join(root, 'source.mp4') });
    expect(parsed.personTracks[0]).toMatchObject({ identityState: 'UNKNOWN', lifecycle: 'OCCLUDED' });
  });

  it('rejects an invalid or identity-bearing response', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ancs-visual-process-')); roots.push(root);
    const script = join(root, 'invalid.mjs');
    await writeFile(script, `console.log(JSON.stringify({schemaVersion:'1.0',personTracks:[{displayName:'张三'}]}));`);
    await expect(createProcessMediaVisualAnalysisAdapter({ executable: process.execPath, args: [script], timeoutMs: 5000 }).analyze({ sourcePath: 'source.mp4' })).rejects.toThrow('VISUAL_ANALYSIS_INVALID_RESPONSE');
  });
});
