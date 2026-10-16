#!/usr/bin/env node
// 从 Pexels 下载免费视频素材，用于本地测试与初剪评测（Pexels License：可免费使用，需注明来源；不要把视频提交进仓库）。
//
// 需要：环境变量 PEXELS_API_KEY（在 https://www.pexels.com/api/ 免费申请；只放在环境变量里，不写进仓库或聊天）。
// 在云端会话里还需要允许访问 api.pexels.com 与 videos.pexels.com，并用 NODE_USE_ENV_PROXY=1 运行（Node 内置 fetch 默认不走代理）。
//
// 用法：
//   node scripts/fetch-pexels-footage.mjs --query "iceland road trip" --count 6 [--orientation landscape|portrait|square] [--max-height 1080]
// 结果：Videos/pexels/<查询词>/pexels-<id>.mp4、credits.json（作者、原链接、许可说明）、eval-set.json（可直接用于
//   node scripts/eval-first-cut.mjs --set Videos/pexels/<查询词>/eval-set.json）。Videos/ 已在 .gitignore 中。
import { createWriteStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    query: { type: 'string' },
    count: { type: 'string', default: '6' },
    orientation: { type: 'string', default: 'landscape' },
    'max-height': { type: 'string', default: '1080' },
    'min-seconds': { type: 'string', default: '4' },
    'max-seconds': { type: 'string', default: '40' },
    locale: { type: 'string', default: 'zh-CN' },
  },
});

const apiKey = process.env.PEXELS_API_KEY;
if (!apiKey) {
  console.error('缺少环境变量 PEXELS_API_KEY（在 https://www.pexels.com/api/ 免费申请；只放在环境变量里）。');
  process.exit(2);
}
if (!values.query) {
  console.error('用法：node scripts/fetch-pexels-footage.mjs --query "iceland road trip" [--count 6]');
  process.exit(2);
}
if (!['landscape', 'portrait', 'square'].includes(values.orientation)) {
  console.error('--orientation 只能是 landscape | portrait | square');
  process.exit(2);
}

const count = Math.min(Math.max(Number(values.count) || 6, 1), 30);
const maxHeight = Number(values['max-height']) || 1080;
const minSeconds = Number(values['min-seconds']) || 0;
const maxSeconds = Number(values['max-seconds']) || 600;
const slug = values.query.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'footage';
const outDir = resolve('Videos', 'pexels', slug);

const url = new URL('https://api.pexels.com/videos/search');
url.searchParams.set('query', values.query);
url.searchParams.set('per_page', String(Math.min(count * 3, 80)));
url.searchParams.set('orientation', values.orientation);
const response = await fetch(url, { headers: { Authorization: apiKey } }).catch((error) => {
  console.error(`连不上 Pexels（${error.cause?.code ?? error.message}）。云端会话需要允许 api.pexels.com / videos.pexels.com 并用 NODE_USE_ENV_PROXY=1 运行。`);
  process.exit(1);
});
if (!response.ok) {
  // 不打印请求头或密钥
  console.error(`Pexels 返回 ${String(response.status)}${response.status === 401 ? '（密钥无效）' : response.status === 429 ? '（超出频率限制，稍后再试）' : ''}`);
  process.exit(1);
}
const result = await response.json();

/** 选不超过 maxHeight 的最大 mp4 文件（太大的原片对测试没有帮助，只会拖慢处理）。 */
function pickFile(video) {
  const files = (video.video_files ?? []).filter((file) => file.file_type === 'video/mp4' && typeof file.link === 'string' && Number(file.height) > 0);
  const fitting = files.filter((file) => Number(file.height) <= maxHeight).sort((left, right) => Number(right.height) - Number(left.height));
  return fitting[0] ?? files.sort((left, right) => Number(left.height) - Number(right.height))[0] ?? null;
}

await mkdir(outDir, { recursive: true });
const credits = [];
for (const video of result.videos ?? []) {
  if (credits.length >= count) break;
  if (video.duration < minSeconds || video.duration > maxSeconds) continue;
  const file = pickFile(video);
  if (file === null) continue;
  const target = join(outDir, `pexels-${String(video.id)}.mp4`);
  const exists = await stat(target).then((info) => info.size > 0, () => false);
  if (!exists) {
    const download = await fetch(file.link);
    if (!download.ok || download.body === null) { console.warn(`跳过 ${String(video.id)}：下载失败 ${String(download.status)}`); continue; }
    await pipeline(Readable.fromWeb(download.body), createWriteStream(target));
  }
  credits.push({
    id: video.id,
    file: relative(process.cwd(), target),
    duration: video.duration,
    width: file.width,
    height: file.height,
    pexelsUrl: video.url,
    author: video.user?.name ?? null,
    authorUrl: video.user?.url ?? null,
  });
  console.log(`${exists ? '已有' : '下载'} ${relative(process.cwd(), target)}（${String(video.duration)} s，${String(file.width)}×${String(file.height)}，作者 ${video.user?.name ?? '未知'}）`);
}
if (credits.length === 0) {
  console.error('没有找到合适的视频，换个关键词或放宽 --min-seconds / --max-seconds。');
  process.exit(1);
}

await writeFile(join(outDir, 'credits.json'), `${JSON.stringify({
  source: 'Pexels', license: 'Pexels License (https://www.pexels.com/license/) — free to use; credit the authors; do not redistribute the files as-is.',
  query: values.query, fetchedAt: new Date().toISOString(), videos: credits,
}, null, 2)}\n`);

const total = credits.reduce((sum, item) => sum + item.duration, 0);
const target = Math.max(10, Math.min(60, Math.round(total * 0.35)));
const aspectRatio = values.orientation === 'portrait' ? '9:16' : values.orientation === 'square' ? '1:1' : '16:9';
const zh = values.locale !== 'en';
await writeFile(join(outDir, 'eval-set.json'), `${JSON.stringify({
  id: `pexels-${slug}`,
  description: `Pexels「${values.query}」${String(credits.length)} 段素材（不入库，见 credits.json）。以不选策略的用例为主。`,
  cases: [
    {
      id: 'general', title: `${values.query} · 不选策略`, aspectRatio, locale: values.locale,
      footage: credits.map((item) => ({ path: item.file })),
      request: zh ? `用这些素材剪一条 ${String(target)} 秒左右的短片，开头要抓人。` : `Cut a ${String(target)}-second video from this footage with a strong opening.`,
      targetSeconds: target, strategy: null,
    },
  ],
}, null, 2)}\n`);
console.log(`\n${String(credits.length)} 段素材 → ${relative(process.cwd(), outDir)}；评测：node scripts/eval-first-cut.mjs --set ${relative(process.cwd(), join(outDir, 'eval-set.json'))}`);
