import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SourceMediaProbe } from '@ancs/contracts';
import { createProcessEffectRenderer, effectChildError } from './effect-renderer-process.js';

/**
 * 特效渲染子进程失败时交回的错误必须说清原因：过去只取 stderr 最后一行，
 * 子进程未捕获的异常（如没配 Remotion 浏览器、去联网下载失败）只剩 "Node.js v22.x"。
 */

const NODE_CRASH = [
  'Downloading Chrome Headless Shell https://www.remotion.dev/chrome-headless-shell',
  'node:internal/process/promises:394',
  '    triggerUncaughtException(err, true /* fromPromise */);',
  '    ^',
  '',
  'Error: getaddrinfo ENOTFOUND remotion.media',
  '    at GetAddrInfoReqWrap.onlookupall [as oncomplete] (node:dns:122:26) {',
  "  code: 'ENOTFOUND',",
  '}',
  '',
  'Node.js v22.22.0',
].join('\n');

describe('effectChildError：子进程失败原因', () => {
  it('子进程自己报的一行 JSON：取 message（之后的杂项输出不影响）', () => {
    expect(effectChildError('Memory reported by Node: 1 MB\n{"ok":false,"error":"EFFECT_RENDER_FAILED","message":"ffmpeg exited with 1"}\n')).toBe('ffmpeg exited with 1');
  });

  it('Node 未捕获的异常：取抛出的那一行，不是 "Node.js vX"', () => {
    expect(effectChildError(NODE_CRASH)).toBe('Error: getaddrinfo ENOTFOUND remotion.media');
    expect(effectChildError('TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must be of type string\n\nNode.js v22.22.0')).toBe('TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must be of type string');
  });

  it('都不是：最后一行原样；空输出为空串', () => {
    expect(effectChildError('something odd\nKilled\n')).toBe('Killed');
    expect(effectChildError('')).toBe('');
  });
});

describe('createProcessEffectRenderer：真实子进程崩溃', () => {
  let dir: string;
  let script: string;
  const probe: SourceMediaProbe = { kind: 'unused', probe: () => Promise.reject(new Error('not reached')) };
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ancs-effect-crash-'));
    script = path.join(dir, 'crash.mjs');
    // 与 Remotion 联网下载失败同类：Promise 拒绝没人接，Node 打印堆栈后以 "Node.js vX" 收尾退出
    await writeFile(script, "await new Promise((resolve) => setTimeout(resolve, 10));\nPromise.reject(new Error('getaddrinfo ENOTFOUND remotion.media'));\n");
  });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it('错误里带上真正的原因', async () => {
    const renderer = createProcessEffectRenderer({ probe, command: [process.execPath, script], timeoutMs: 20_000 });
    const failure = renderer.render({ code: '', params: {}, seed: 's', width: 64, height: 64, fps: 30, durationInFrames: 1 });
    await expect(failure).rejects.toThrow('特效渲染失败：Error: getaddrinfo ENOTFOUND remotion.media');
  });
});
