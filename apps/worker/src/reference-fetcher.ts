import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ReferenceFetchError, type ReferenceFetcher } from '@ancs/contracts';
import { childProcessEnv } from './child-env.js';

/**
 * 参考链接抓取（V6-6 蒸馏器，V6 §6.7；版权由项目所有者负责，系统只记录来源）：
 * - **直接的媒体链接**（返回 video/*）：受限 HTTP 下载——只允许 http(s)、拒绝内网/回环/链路本地地址（每一跳重定向都校验）、
 *   大小上限、超时；
 * - **平台页面**（YouTube、B 站、抖音……返回网页）：交给部署方配置的下载命令（`ANCS_REFERENCE_FETCH_CMD`，
 *   例如 `yt-dlp -f mp4/best -o {output} {url}`），以白名单环境（含代理变量、不含任何密钥）在工作目录里运行，硬超时；
 *   没有配置时明确失败（NOT_CONFIGURED），界面提示"下载后上传文件"。
 * 链接只作为参数传给命令（不经 shell），且必须以 http(s):// 开头（不会被当作命令选项）。
 */

export interface ReferenceFetcherOptions {
  /** 平台页面下载命令（argv；占位符 {url} {output}），缺省不配置 */
  downloadCommand?: string[];
  timeoutMs?: number;
  /** 仅测试：允许回环/内网地址 */
  allowPrivateNetwork?: boolean;
}

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv']);
const CONTENT_TYPES: Record<string, string> = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska' };
/** 下载命令可继承的环境：平台启动项 + 代理设置（不含连接串与密钥） */
const DOWNLOAD_ENV = { keys: ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE'] };

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const lower = address.toLowerCase();
  return lower === '::1' || lower === '::' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80') || lower.startsWith('::ffff:127.') || lower.startsWith('::ffff:10.') || lower.startsWith('::ffff:192.168.');
}

async function assertPublic(url: URL, allowPrivate: boolean): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ReferenceFetchError('BLOCKED', '只支持 http(s) 链接');
  if (url.username !== '' || url.password !== '') throw new ReferenceFetchError('BLOCKED', '链接里不能带账号密码');
  if (allowPrivate) return;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) !== 0 ? [host] : (await lookup(host, { all: true }).catch(() => { throw new ReferenceFetchError('FAILED', `无法解析域名 ${host}`); })).map((entry) => entry.address);
  if (addresses.some(isPrivateAddress)) throw new ReferenceFetchError('BLOCKED', '链接指向内网或本机地址，已拒绝');
}

function runDownload(command: string[], url: string, workDir: string, timeoutMs: number): Promise<void> {
  const output = path.join(workDir, 'download.%(ext)s');
  const argv = command.map((part) => part.replaceAll('{url}', url).replaceAll('{output}', output));
  const executable = argv[0];
  if (executable === undefined) throw new ReferenceFetchError('NOT_CONFIGURED', '下载命令为空');
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argv.slice(1), { cwd: workDir, env: childProcessEnv(process.env, DOWNLOAD_ENV), stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new ReferenceFetchError('FAILED', `下载超时（${String(Math.round(timeoutMs / 1000))} 秒）`)); }, timeoutMs);
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-4000); });
    child.on('error', (error) => { clearTimeout(timer); reject(new ReferenceFetchError('NOT_CONFIGURED', `下载命令无法启动：${error.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new ReferenceFetchError('FAILED', `下载失败（平台可能限制了抓取）：${stderr.trim().split('\n').at(-1)?.slice(0, 300) ?? `code ${String(code)}`}`));
    });
  });
}

async function downloadedFile(workDir: string, maxBytes: number): Promise<{ filePath: string; contentType: string }> {
  const entries = (await readdir(workDir)).filter((name) => name.startsWith('download.') && !name.endsWith('.part'));
  const video = entries.find((name) => VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase()));
  if (video === undefined) throw new ReferenceFetchError('NOT_VIDEO', '下载结果不是常见视频格式（mp4/mov/webm/mkv）');
  const filePath = path.join(workDir, video);
  if ((await stat(filePath)).size > maxBytes) { await rm(filePath, { force: true }); throw new ReferenceFetchError('TOO_LARGE', `视频超过 ${String(Math.round(maxBytes / 1024 / 1024))} MB 上限`); }
  return { filePath, contentType: CONTENT_TYPES[path.extname(video).toLowerCase()] ?? 'video/mp4' };
}

export function createReferenceFetcher(options: ReferenceFetcherOptions = {}): ReferenceFetcher {
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  const allowPrivate = options.allowPrivateNetwork === true;
  return {
    implementation: 'REAL',
    async fetch(input) {
      let url: URL;
      try { url = new URL(input.url); } catch { throw new ReferenceFetchError('BLOCKED', '链接格式不正确'); }
      // 直接链接：最多跟随 5 次重定向，每一跳都校验地址
      for (let hop = 0; hop < 6; hop += 1) {
        await assertPublic(url, allowPrivate);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let response: Response;
        try {
          response = await fetch(url, { redirect: 'manual', signal: controller.signal, headers: { 'user-agent': 'ANCS-reference-fetcher/1.0' } });
        } catch (error) {
          clearTimeout(timer);
          throw new ReferenceFetchError('FAILED', `无法访问链接：${error instanceof Error ? error.message : String(error)}`);
        }
        if (response.status >= 300 && response.status < 400 && response.headers.get('location') !== null) {
          clearTimeout(timer);
          await response.body?.cancel();
          url = new URL(response.headers.get('location')!, url);
          continue;
        }
        if (!response.ok) { clearTimeout(timer); await response.body?.cancel(); throw new ReferenceFetchError('FAILED', `链接返回 HTTP ${String(response.status)}`); }
        const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
        const extension = path.extname(url.pathname).toLowerCase();
        const isVideo = contentType.startsWith('video/') || (contentType === 'application/octet-stream' && VIDEO_EXTENSIONS.has(extension));
        if (!isVideo) {
          clearTimeout(timer);
          await response.body?.cancel();
          // 平台页面：交给下载命令
          if (options.downloadCommand === undefined || options.downloadCommand.length === 0) {
            throw new ReferenceFetchError('NOT_CONFIGURED', '这是网页而不是视频文件；平台链接需要服务端配置下载命令（ANCS_REFERENCE_FETCH_CMD），或者下载后上传文件');
          }
          await runDownload(options.downloadCommand, input.url, input.workDir, timeoutMs);
          const file = await downloadedFile(input.workDir, input.maxBytes);
          return { ...file, title: null, finalUrl: url.toString() };
        }
        const declared = Number(response.headers.get('content-length') ?? '0');
        if (Number.isFinite(declared) && declared > input.maxBytes) { clearTimeout(timer); await response.body?.cancel(); throw new ReferenceFetchError('TOO_LARGE', `视频超过 ${String(Math.round(input.maxBytes / 1024 / 1024))} MB 上限`); }
        const filePath = path.join(input.workDir, `download${VIDEO_EXTENSIONS.has(extension) ? extension : '.mp4'}`);
        let received = 0;
        try {
          if (response.body === null) throw new ReferenceFetchError('FAILED', '链接没有返回内容');
          const limited = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>).on('data', (chunk: Buffer) => {
            received += chunk.byteLength;
            if (received > input.maxBytes) controller.abort();
          });
          await pipeline(limited, createWriteStream(filePath));
        } catch (error) {
          await rm(filePath, { force: true });
          if (received > input.maxBytes) throw new ReferenceFetchError('TOO_LARGE', `视频超过 ${String(Math.round(input.maxBytes / 1024 / 1024))} MB 上限`);
          if (error instanceof ReferenceFetchError) throw error;
          throw new ReferenceFetchError('FAILED', `下载中断：${error instanceof Error ? error.message : String(error)}`);
        } finally {
          clearTimeout(timer);
        }
        const name = decodeURIComponent(path.basename(url.pathname)) || null;
        return { filePath, contentType: contentType.startsWith('video/') ? contentType : CONTENT_TYPES[extension] ?? 'video/mp4', title: name, finalUrl: url.toString() };
      }
      throw new ReferenceFetchError('FAILED', '重定向次数过多');
    },
  };
}
