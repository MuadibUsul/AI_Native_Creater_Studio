#!/usr/bin/env node
// 真实供应商的网络诊断（不产生生成费用）：对项目代码里用到的每个供应商域名，逐层检查
//   ① DNS（容器内解析；经代理出网的环境里由代理解析，失败不一定致命）
//   ② 出网许可（经 HTTPS_PROXY 发 CONNECT：200 = 放行，403 = 被网络白名单拦下）
//   ③ TLS + HTTP（对域名根路径发一个不带密钥的 GET，拿到任何 HTTP 状态码即说明 TLS 握手与 HTTP 都通）
//   ④ 鉴权（环境变量里有密钥时，调一个**免费**的只读接口：列模型 / 读额度 / 列任务；不提交任何生成任务）
// 密钥只从环境变量读，不打印、不写文件；输出里如出现密钥原文会被替换成 [redacted]。
//
// 用法：node scripts/provider-network-check.mjs [--json 报告.json] [--markdown 报告.md]
//   在经代理出网的环境里会自动以 NODE_USE_ENV_PROXY=1 重启自己（Node 的 fetch 才走代理）。
// 退出码：0 = 所有配置了密钥的供应商都通过；1 = 有供应商被拦或鉴权失败；2 = 没有任何供应商配置密钥。
import { spawnSync } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { writeFile } from 'node:fs/promises';

const { AbortSignal } = globalThis;

const proxyUrl = process.env.HTTPS_PROXY ?? process.env.https_proxy;
if (proxyUrl && process.env.NODE_USE_ENV_PROXY !== '1') {
  const rerun = spawnSync(process.execPath, process.argv.slice(1), { stdio: 'inherit', env: { ...process.env, NODE_USE_ENV_PROXY: '1', NODE_NO_WARNINGS: '1' } });
  process.exit(rerun.status ?? 1);
}

const args = process.argv.slice(2);
const option = (name) => { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1]; };

const { GEMINI_DEFAULT_BASE_URL } = await import('../packages/providers/gemini/dist/index.js');
const { ARK_DEFAULT_BASE_URL } = await import('../packages/providers/ark/dist/index.js');

// 供应商清单：API 地址取自代码里的缺省值（与 Worker 装配一致）；可被同名环境变量覆盖的照样读取
const providers = [
  { id: 'gemini', name: 'Google Gemini（导演 / 视觉 / 讲述 / Veo）', base: GEMINI_DEFAULT_BASE_URL, keyEnv: 'GEMINI_API_KEY',
    auth: (key) => ({ path: '/models?pageSize=1', headers: { 'x-goog-api-key': key } }) },
  { id: 'ark', name: '火山方舟（Seedance）', base: process.env.ANCS_ARK_BASE_URL ?? ARK_DEFAULT_BASE_URL, keyEnv: 'ARK_API_KEY',
    auth: (key) => ({ path: '/contents/generations/tasks?page_num=1&page_size=1', headers: { authorization: `Bearer ${key}` } }) },
  { id: 'fish', name: 'Fish Audio（讲述 / 你的声音）', base: 'https://api.fish.audio', keyEnv: 'FISH_AUDIO_API_KEY',
    auth: (key) => ({ path: '/model?self=true&page_size=1', headers: { authorization: `Bearer ${key}` } }) },
  { id: 'heygen', name: 'HeyGen（数字人）', base: 'https://api.heygen.com', keyEnv: 'HEYGEN_API_KEY',
    auth: (key) => ({ path: '/v2/user/remaining_quota', headers: { 'x-api-key': key } }) },
  { id: 'heygen-upload', name: 'HeyGen 上传', base: 'https://upload.heygen.com', keyEnv: null, auth: null },
  { id: 'deepgram', name: 'Deepgram（语音转写）', base: 'https://api.deepgram.com', keyEnv: 'DEEPGRAM_API_KEY',
    auth: (key) => ({ path: '/v1/projects', headers: { authorization: `Token ${key}` } }) },
  { id: 'anthropic', name: 'Anthropic（Claude 导演）', base: 'https://api.anthropic.com', keyEnv: 'ANTHROPIC_API_KEY',
    auth: (key) => ({ path: '/v1/models?limit=1', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } }) },
  { id: 'runway', name: 'Runway（已提供密钥，代码尚未接入）', base: 'https://api.dev.runwayml.com', keyEnv: 'RUNWAYML_API_SECRET',
    auth: (key) => ({ path: '/v1/organization', headers: { authorization: `Bearer ${key}`, 'x-runway-version': '2024-11-06' } }) },
];
// 成片下载可能落到的域名（供应商返回的临时链接；只检查能否出网，真实域名以第一次任务返回的链接为准）
const downloadCandidates = [
  { id: 'gemini-files', name: 'Gemini 文件下载跳转（候选）', base: 'https://storage.googleapis.com' },
  { id: 'gemini-usercontent', name: 'Gemini 文件下载跳转（候选）', base: 'https://video-downloads.googleusercontent.com' },
  { id: 'ark-tos', name: '方舟成片对象存储（候选）', base: 'https://ark-content-generation-v2-cn-beijing.tos-cn-beijing.volces.com' },
  { id: 'heygen-files', name: 'HeyGen 成片（候选）', base: 'https://files2.heygen.ai' },
];

const secrets = [...new Set(providers.map((item) => (item.keyEnv ? process.env[item.keyEnv] : undefined)).filter((value) => typeof value === 'string' && value.length >= 8))];
const scrub = (text) => secrets.reduce((current, secret) => current.split(secret).join('[redacted]'), String(text));
const short = (text, limit = 160) => { const clean = scrub(text).replace(/\s+/g, ' ').trim(); return clean.length <= limit ? clean : `${clean.slice(0, limit)}…`; };

const noProxy = (process.env.NO_PROXY ?? process.env.no_proxy ?? '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
const bypassesProxy = (host) => noProxy.some((rule) => host === rule || (rule.startsWith('.') && host.endsWith(rule)) || (rule.startsWith('*.') && host.endsWith(rule.slice(1))));

async function dnsCheck(host) {
  try {
    const { address } = await Promise.race([lookup(host), new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), 8_000))]);
    return { ok: true, detail: address };
  } catch (error) {
    return { ok: false, detail: error.code ?? error.message };
  }
}

function egressCheck(host) {
  if (!proxyUrl) return Promise.resolve({ ok: true, status: null, detail: 'no proxy (direct egress)' });
  if (bypassesProxy(host)) return Promise.resolve({ ok: true, status: null, detail: 'NO_PROXY (direct)' });
  const proxy = new URL(proxyUrl);
  return new Promise((resolve) => {
    const req = httpRequest({ host: proxy.hostname, port: Number(proxy.port || 80), method: 'CONNECT', path: `${host}:443`, headers: { host: `${host}:443` }, timeout: 15_000 });
    req.on('connect', (response, socket) => {
      socket.destroy();
      const status = response.statusCode ?? 0;
      resolve({ ok: status === 200, status, detail: status === 200 ? 'allowed' : status === 403 ? 'blocked by the environment network policy' : `proxy answered ${String(status)}` });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: null, detail: 'proxy timeout' }); });
    req.on('error', (error) => resolve({ ok: false, status: null, detail: error.code ?? error.message }));
    req.end();
  });
}

async function httpCheck(url) {
  try {
    const response = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(20_000) });
    await response.arrayBuffer().catch(() => undefined);
    return { ok: true, status: response.status, detail: `HTTP ${String(response.status)}` };
  } catch (error) {
    return { ok: false, status: null, detail: short(error.cause?.code ?? error.cause?.message ?? error.message) };
  }
}

async function authCheck(provider) {
  const key = provider.keyEnv ? process.env[provider.keyEnv] : undefined;
  if (!provider.auth) return { ok: null, status: null, detail: '—' };
  if (!key) return { ok: null, status: null, detail: `${provider.keyEnv} not set` };
  const { path, headers } = provider.auth(key);
  const started = Date.now();
  try {
    const response = await fetch(`${provider.base.replace(/\/+$/, '')}${path}`, { method: 'GET', headers, signal: AbortSignal.timeout(30_000) });
    const text = await response.text().catch(() => '');
    let reason = '';
    try {
      const body = JSON.parse(text);
      const error = body.error ?? body.err ?? null;
      reason = typeof error === 'string' ? error : error?.code ?? error?.status ?? error?.message ?? body.message ?? '';
    } catch { reason = ''; }
    const ok = response.status >= 200 && response.status < 300;
    const meaning = ok ? 'key accepted' : response.status === 401 || response.status === 403 ? 'key rejected' : response.status === 429 ? 'rate limited / no quota' : response.status === 404 ? 'endpoint not found (auth not confirmed)' : 'unexpected status';
    return { ok, status: response.status, detail: short(`${meaning}${reason ? ` (${String(reason)})` : ''}, ${String(Date.now() - started)} ms`) };
  } catch (error) {
    return { ok: false, status: null, detail: short(error.cause?.code ?? error.message) };
  }
}

const rows = [];
for (const provider of [...providers, ...downloadCandidates]) {
  const host = new URL(provider.base).hostname;
  const dns = await dnsCheck(host);
  const egress = await egressCheck(host);
  const http = egress.ok ? await httpCheck(`https://${host}/`) : { ok: false, status: null, detail: 'skipped (no egress)' };
  const auth = egress.ok && 'auth' in provider ? await authCheck(provider) : { ok: null, status: null, detail: 'auth' in provider ? 'skipped (no egress)' : '—' };
  rows.push({ id: provider.id, name: provider.name, host, keyConfigured: provider.keyEnv ? Boolean(process.env[provider.keyEnv]) : null, dns, egress, http, auth, download: !('auth' in provider) });
  console.log(`${provider.id.padEnd(18)} ${host.padEnd(62)} dns:${dns.ok ? 'ok' : dns.detail}  egress:${egress.ok ? 'ok' : egress.detail}  http:${http.ok ? http.status : http.detail}  auth:${auth.ok === null ? auth.detail : auth.ok ? `ok ${auth.detail}` : `FAIL ${auth.detail}`}`);
}

const blocked = rows.filter((row) => !row.egress.ok);
const authFailures = rows.filter((row) => row.auth.ok === false);
console.log('');
console.log(blocked.length === 0 ? '所有检查的域名都能出网。' : `被网络白名单拦下（需要在 Claude 网页端的环境设置里放行）：${blocked.map((row) => row.host).join('、')}`);
if (authFailures.length > 0) console.log(`鉴权未通过：${authFailures.map((row) => `${row.id}（${row.auth.detail}）`).join('；')}`);

const report = { when: new Date().toISOString(), proxy: proxyUrl ? 'HTTPS_PROXY set' : 'none', rows };
const jsonPath = option('--json');
if (jsonPath) await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
const markdownPath = option('--markdown');
if (markdownPath) {
  const cell = (check) => (check.ok === null ? check.detail : `${check.ok ? '✅' : '❌'} ${check.detail}`);
  const lines = [
    `| 供应商 | 域名 | 密钥 | DNS（容器内） | 出网许可 | TLS + HTTP | 鉴权（免费接口） |`,
    '|---|---|---|---|---|---|---|',
    ...rows.map((row) => `| ${row.name} | \`${row.host}\` | ${row.keyConfigured === null ? '—' : row.keyConfigured ? '已配置' : '未配置'} | ${row.dns.ok ? '✅' : `⚠️ ${row.dns.detail}`} | ${cell(row.egress)} | ${row.http.ok ? `✅ ${row.http.detail}` : row.http.detail} | ${cell(row.auth)} |`),
  ];
  await writeFile(markdownPath, `${lines.join('\n')}\n`);
}

const configured = rows.filter((row) => row.keyConfigured);
process.exitCode = configured.length === 0 ? 2 : configured.some((row) => !row.egress.ok || row.auth.ok === false) ? 1 : 0;
