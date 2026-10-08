import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createProcessSpeechRecognitionAdapter } from './speech-recognition-process.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('process speech recognition adapter', () => {
  it('accepts bounded strict JSON from an isolated executable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ancs-asr-process-')); roots.push(root);
    const script = join(root, 'asr.mjs');
    await writeFile(script, `console.log(JSON.stringify({schemaVersion:'1.0',processorVersion:'source-transcript-v1',provider:'fixture',model:'v1',language:'zh-CN',speakers:[],terminology:[],words:[{ordinal:0,text:'测试',speakerId:null,confidencePermille:900,sourceStartPts:'0',sourceEndPts:'1000',timeBase:{numerator:1,denominator:1000}}],segments:[{id:'mts_test',ordinal:0,text:'测试',speakerId:null,wordStartOrdinal:0,wordEndOrdinal:0,evidence:'ASR_INFERENCE',reviewState:'UNREVIEWED',sourceStartPts:'0',sourceEndPts:'1000',timeBase:{numerator:1,denominator:1000}}]}));`);
    const result = await createProcessSpeechRecognitionAdapter({ executable: process.execPath, args: [script], timeoutMs: 5000 }).transcribe({ sourcePath: join(root, 'source.mp4') });
    expect(result).toMatchObject({ provider: 'fixture', segments: [{ evidence: 'ASR_INFERENCE' }] });
  });

  it('returns a stable error without exposing child stderr', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ancs-asr-process-')); roots.push(root);
    const script = join(root, 'bad.mjs');
    await writeFile(script, `console.error('provider-secret-value'); process.exit(2);`);
    await expect(createProcessSpeechRecognitionAdapter({ executable: process.execPath, args: [script], timeoutMs: 5000 }).transcribe({ sourcePath: 'source.mp4' })).rejects.toThrow('ASR_PROCESS_FAILED');
  });
});
