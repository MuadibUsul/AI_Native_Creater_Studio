import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MEDIA_AUDIO_ANALYSIS_PROCESSOR_VERSION } from '@ancs/contracts';
import { createProcessMediaAudioAnalysisAdapter } from './audio-analysis-process.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe('process media audio analysis adapter', () => {
  it('passes the source path and validates the structured result', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ancs-audio-process-test-')); directories.push(directory);
    const script = join(directory, 'adapter.cjs');
    await writeFile(script, `process.stdout.write(JSON.stringify({schemaVersion:'1.0',processorVersion:'${MEDIA_AUDIO_ANALYSIS_PROCESSOR_VERSION}',adapter:'fixture',modelVersion:'v1',durationMs:1000,audioEvents:[],musicBeats:[]}));`);
    const result = await createProcessMediaAudioAnalysisAdapter({ executable: process.execPath, args: [script], timeoutMs: 5_000 }).analyze({ sourcePath: join(directory, 'source.mp4') });
    expect(result).toMatchObject({ adapter: 'fixture', audioEvents: [], musicBeats: [] });
  });

  it('rejects an invalid response without exposing stderr', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ancs-audio-process-test-')); directories.push(directory);
    const script = join(directory, 'adapter.cjs');
    await writeFile(script, `process.stderr.write('private-path'); process.stdout.write('{}');`);
    await expect(createProcessMediaAudioAnalysisAdapter({ executable: process.execPath, args: [script], timeoutMs: 5_000 }).analyze({ sourcePath: 'source.mp4' })).rejects.toThrow('AUDIO_ANALYSIS_INVALID_RESPONSE');
  });
});
