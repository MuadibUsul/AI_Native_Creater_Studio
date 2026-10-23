import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveTestDatabaseUrl } from '@ancs/db';

/**
 * V5-M3：进程入口的 fail-closed 装配守卫（真实启动构建产物 dist/*.js）。
 * - Worker：ASR 驱动显式选择，Deepgram 缺密钥启动失败；配置后装配为真实驱动并按清单报告；
 *   生产缺显式存储/凭据密钥启动失败；
 * - API：生产进程装配 Mock 驱动且未显式许可 → 启动失败并列出全部 Mock 驱动；
 *   生产缺省不装配旧 V4 流水线（没有任何 Mock），不需要许可即可启动。
 * 错误输出不得包含任何密钥值。
 */

const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
const sessionSecret = 'startup-guard-session-secret-0123456789'; // secrets:check-ignore：测试专用假值
const fakeDeepgramKey = 'dg-fake-key-startup-guard-0123456789'; // secrets:check-ignore：测试专用假值
let storageDir: string;

beforeAll(async () => { storageDir = await mkdtemp(join(tmpdir(), 'ancs-startup-')); });
afterAll(async () => { await rm(storageDir, { recursive: true, force: true }); });

function run(entry: string, env: Record<string, string>, timeoutMs = 60_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [entry], {
      cwd: repoRoot,
      env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${entry} did not exit within ${String(timeoutMs)}ms\n${stdout}\n${stderr}`)); }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolvePromise({ code, stdout, stderr }); });
  });
}

const workerEntry = join(repoRoot, 'apps', 'worker', 'dist', 'main.js');
const apiEntry = join(repoRoot, 'apps', 'api', 'dist', 'index.js');
const baseEnv = (): Record<string, string> => ({
  DATABASE_URL: resolveTestDatabaseUrl(),
  BETTER_AUTH_SECRET: sessionSecret,
  ANCS_STORAGE_LOCAL_DIR: storageDir,
});

describe('V5-M3 入口装配守卫', () => {
  it('Worker：ANCS_ASR_DRIVER=deepgram 缺 DEEPGRAM_API_KEY → 启动失败（不回退 Mock）', async () => {
    const result = await run(workerEntry, { ...baseEnv(), ANCS_ASR_DRIVER: 'deepgram', ANCS_DISABLE_RENDER: '1' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('DEEPGRAM_API_KEY');
    expect(result.stderr).not.toContain(sessionSecret);
  });

  it('Worker：配置 Deepgram 后作为真实 ASR 驱动装配（单轮执行后正常退出），密钥不出现在任何输出', async () => {
    const result = await run(workerEntry, { ...baseEnv(), ANCS_ASR_DRIVER: 'deepgram', DEEPGRAM_API_KEY: fakeDeepgramKey, ANCS_DISABLE_RENDER: '1', ANCS_WORKER_ONCE: '1' });
    expect(result.stderr).not.toContain('启动失败');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('asr=deepgram:REAL');
    expect(`${result.stdout}${result.stderr}`).not.toContain(fakeDeepgramKey);
  });

  it('Worker：生产缺显式存储签名密钥与凭据密钥 → 一次列出全部问题', async () => {
    const result = await run(workerEntry, { ...baseEnv(), NODE_ENV: 'production', ANCS_DISABLE_RENDER: '1' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('ANCS_STORAGE_SECRET');
    expect(result.stderr).toContain('ANCS_CREDENTIAL_KEYS');
    expect(result.stderr).toContain('ANCS_AI_MONTHLY_CAP_USD');
  });

  it('Worker：设了月度 AI 上限而导演 / 视觉模型没有单价 → 启动时列出缺单价的模型；补上 ANCS_MODEL_PRICES_JSON 后不再提示（不连数据库，不认领任务）', async () => {
    const env = {
      ...baseEnv(),
      // 不可达的数据库：启动日志之后第一轮就退出，不会用假密钥去执行测试库里遗留的任务
      DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:9/none',
      ANCS_DISABLE_RENDER: '1', ANCS_WORKER_ONCE: '1', ANCS_AI_MONTHLY_CAP_USD: '20',
      ANCS_AGENT_DRIVER: 'deepseek', DEEPSEEK_API_KEY: 'ds-fake-key-startup-guard-0123', // secrets:check-ignore：测试专用假值
      ANCS_VISUAL_ANALYSIS_DRIVER: 'elorian', ELORIAN_API_KEY: 'el-fake-key-startup-guard-0123', // secrets:check-ignore：测试专用假值
    };
    const missing = await run(workerEntry, env);
    expect(missing.stderr).toContain('没有单价：deepseek-v4-pro、deepseek-flash、elorian-1-agent');
    expect(`${missing.stdout}${missing.stderr}`).not.toContain('fake-key-startup-guard');
    const priced = await run(workerEntry, { ...env, ANCS_MODEL_PRICES_JSON: JSON.stringify({ 'deepseek-v4-pro': { input: 1, output: 2 }, 'deepseek-flash': { input: 1, output: 2 }, 'elorian-1-agent': { input: 1, output: 2 } }) });
    expect(priced.stderr).not.toContain('没有单价');
    expect(priced.stdout).toContain('agent_model=deepseek:REAL');
  });

  const productionApiEnv = (): Record<string, string> => ({
    ...baseEnv(),
    NODE_ENV: 'production',
    ANCS_OPS_ENVIRONMENT: 'PRODUCTION',
    ANCS_CREDENTIAL_KEYS: `v1:${Buffer.alloc(32, 7).toString('base64')}`, // secrets:check-ignore：测试专用假值
    ANCS_STORAGE_SECRET: 'startup-guard-storage-secret-0123', // secrets:check-ignore：测试专用假值
    ANCS_AI_MONTHLY_CAP_USD: '20',
  });

  it('API：生产进程装配 Mock 驱动且未显式许可 → 启动失败并列出 Mock 驱动', async () => {
    // 生产缺省不装配旧流水线；显式改成 mock 才会装配测试替身，此时守卫必须拦下
    const result = await run(apiEntry, { ...productionApiEnv(), ANCS_LEGACY_PIPELINE: 'mock', PORT: '39999' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('ANCS_ALLOW_MOCK_PROVIDERS');
    expect(result.stderr).toContain('llm=mock:MOCK');
    expect(result.stderr).not.toContain(sessionSecret);
  });

  it('API：生产缺省（旧 V4 流水线 off）不装配任何 Mock，无需许可即可启动；能力清单如实报告', async () => {
    const child = spawn(process.execPath, [apiEntry], {
      cwd: repoRoot,
      env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', ...productionApiEnv(), PORT: '39998' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    try {
      let capabilities: { legacyPipeline?: string; providers?: unknown[] } | null = null;
      for (let attempt = 0; attempt < 120 && capabilities === null; attempt += 1) {
        if (child.exitCode !== null) throw new Error(`API exited early (${String(child.exitCode)}):\n${output}`);
        capabilities = await fetch('http://127.0.0.1:39998/api/v1/capabilities').then((response) => response.json() as Promise<{ legacyPipeline?: string; providers?: unknown[] }>).catch(() => null);
        if (capabilities === null) await new Promise((done) => setTimeout(done, 250));
      }
      expect(capabilities).toMatchObject({ legacyPipeline: 'off', providers: [] });
      expect(output).toContain('旧 V4 流水线 = off');
      expect(output).not.toContain(sessionSecret);
    } finally {
      child.kill('SIGTERM');
    }
  });
});
