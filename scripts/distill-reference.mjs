#!/usr/bin/env node
// V6-6 蒸馏器命令行：不用数据库、不登录，直接测量几条参考视频的剪辑手法，打印剪辑 DNA 与规则版风格说明。
// 与 Studio 里的"从参考视频学风格"用同一套代码（apps/worker 的 FFmpeg 测量 + 链接抓取，packages/domain 的统计与撰写）。
//
// 用法（先 pnpm build）：
//   node scripts/distill-reference.mjs [--name 风格名] [--json 输出.json] [--locale zh-CN|en] <文件或链接> [...最多 5 条]
// 链接：
//   - 直接的视频文件链接（https://…/clip.mp4）直接下载（拒绝内网地址，限制大小）；
//   - 平台页面链接（如 YouTube 视频页）需要配置下载命令 ANCS_REFERENCE_FETCH_CMD（必须含 {url} 与 {output}），
//     例如 ANCS_REFERENCE_FETCH_CMD='yt-dlp --no-playlist -f mp4/bestvideo*+bestaudio/best -o {output} {url}'；
//     没配置时明确报错，请下载后传文件路径。下载命令只继承代理与证书相关的环境变量。
// 参考视频的版权由使用者负责；这里只测量手法，不保存视频。
// 撰写说明只用规则版（不调用模型）；模型版说明在 Worker 配置了导演模型（ANCS_AGENT_DRIVER）后由 Studio 里的蒸馏工作流写。
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { MAX_DISTILL_REFERENCES, MAX_REFERENCE_ANALYSIS_SECONDS, ReferenceFetchError } from '../packages/contracts/dist/index.js';
import { composeStrategyFromStats, distillStats, editingDnaFromStats } from '../packages/domain/dist/index.js';
import { createFfmpegReferenceAnalyzer } from '../apps/worker/dist/reference-analyzer-process.js';
import { createReferenceFetcher } from '../apps/worker/dist/reference-fetcher.js';

const args = process.argv.slice(2);
const option = (flag) => {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  const [, value] = args.splice(index, 2);
  if (value === undefined) throw new Error(`${flag} needs a value`);
  return value;
};
const name = option('--name');
const jsonOut = option('--json');
const locale = option('--locale') ?? 'zh-CN';
const inputs = args.filter((value) => value.trim() !== '');
if (inputs.length === 0 || inputs.length > MAX_DISTILL_REFERENCES || args.includes('--help')) {
  console.error(`usage: node scripts/distill-reference.mjs [--name NAME] [--json OUT.json] [--locale zh-CN|en] <file-or-url> [... up to ${String(MAX_DISTILL_REFERENCES)}]`);
  process.exit(inputs.length === 0 || args.includes('--help') ? 2 : 1);
}

const command = process.env.ANCS_REFERENCE_FETCH_CMD?.trim();
const maxBytes = Number(process.env.ANCS_REFERENCE_MAX_MB ?? 1024) * 1024 * 1024;
const fetcher = createReferenceFetcher(command ? { downloadCommand: command.split(/\s+/) } : {});
const analyzer = createFfmpegReferenceAnalyzer({ timeoutMs: 20 * 60_000 });
const workRoot = await mkdtemp(join(tmpdir(), 'ancs-distill-cli-'));
const round = (value, digits = 2) => (value === null || value === undefined ? '—' : String(Math.round(value * 10 ** digits) / 10 ** digits));

try {
  const measurements = [];
  const sources = [];
  for (const [index, input] of inputs.entries()) {
    const isUrl = /^https?:\/\//i.test(input);
    let filePath = resolve(input);
    let label = basename(input);
    if (isUrl) {
      console.log(`[${String(index + 1)}/${String(inputs.length)}] 获取 ${input}`);
      const workDir = join(workRoot, `ref-${String(index)}`);
      try {
        const fetched = await fetcher.fetch({ url: input, workDir, maxBytes });
        filePath = fetched.filePath;
        label = fetched.title ?? new URL(fetched.finalUrl).pathname.split('/').pop() ?? input;
      } catch (error) {
        if (error instanceof ReferenceFetchError || error?.name === 'ReferenceFetchError') {
          console.error(`  无法获取（${error.failure}）：${error.message}`);
          if (error.failure === 'NOT_CONFIGURED') console.error('  平台页面链接需要 ANCS_REFERENCE_FETCH_CMD（见脚本头部说明），或先下载视频再传文件路径。');
          process.exitCode = 1;
          continue;
        }
        throw error;
      }
    } else {
      await stat(filePath);
    }
    console.log(`[${String(index + 1)}/${String(inputs.length)}] 测量 ${label}`);
    const measurement = await analyzer.analyze({ filePath, label, maxSeconds: MAX_REFERENCE_ANALYSIS_SECONDS });
    measurements.push(measurement);
    sources.push({ label, url: isUrl ? input : null, assetId: null });
    const minutes = measurement.analyzedSeconds / 60;
    console.log([
      `  时长 ${round(measurement.durationSeconds, 1)} s（分析 ${round(measurement.analyzedSeconds, 1)} s），${String(measurement.width)}×${String(measurement.height)} @ ${round(measurement.frameRate, 2)} fps`,
      `  硬切 ${String(measurement.cuts.length)} 次（每分钟 ${round(measurement.cuts.length / Math.max(minutes, 1e-9), 1)}），黑场 ${String(measurement.blackDips.length)} 次，画面活跃度 ${round(measurement.sceneActivity)}`,
      measurement.beats === null ? '  节拍：没有稳定节拍' : `  节拍：${round(measurement.beats.bpm, 1)} BPM（置信度 ${round(measurement.beats.confidence)}）`,
      measurement.color === null ? '  色彩：—' : `  色彩：亮度 ${round(measurement.color.luma)}，饱和度 ${round(measurement.color.saturation)}，对比 ${round(measurement.color.contrast)}，冷暖 ${round(measurement.color.warmth)}`,
      measurement.audio === null ? '  声音：没有音轨' : `  声音：${round(measurement.audio.integratedLufs, 1)} LUFS，响度范围 ${round(measurement.audio.loudnessRange, 1)} LU，静音占比 ${round(measurement.audio.silenceRatio)}`,
    ].join('\n'));
  }
  if (measurements.length === 0) throw new Error('没有可测量的参考视频');

  const stats = distillStats(measurements);
  const dna = editingDnaFromStats(stats);
  const pack = composeStrategyFromStats({ stats, dna, sources, name });
  console.log(`\n风格：${pack.name[locale]}\n${pack.summary[locale]}\n`);
  console.log([
    `镜头时长：中位 ${round(dna.shotSeconds.median)} s（多在 ${round(dna.shotSeconds.typical.min, 1)}–${round(dna.shotSeconds.typical.max, 1)} s）`,
    `剪辑频率：每分钟 ${round(dna.cutsPerMinute, 1)} 次；节奏曲线（10 段）：${dna.pacing === null ? '—' : dna.pacing.map((value) => round(value, 0)).join(' / ')}`,
    `卡点：${dna.beatCutRatio === null ? '没有稳定节拍' : `${round(dna.beatCutRatio * 100, 0)}% 的剪点在节拍上（随机约 ${round((stats.beatChanceRatio ?? 0) * 100, 0)}%）`}`,
    `黑场过渡：每分钟 ${round(dna.transitionsPerMinute, 1)} 次；开场钩子：${dna.hookSeconds === null ? '—' : `${round(dna.hookSeconds, 1)} s`}`,
    `色调：${dna.colorTendency ?? '—'}`,
    `声音：${dna.soundHabits ?? '—'}`,
    `测量依据：${String(dna.measured?.references ?? 0)} 条，${round((dna.measured?.analyzedSeconds ?? 0) / 60, 1)} 分钟，${String(dna.measured?.shots ?? 0)} 个镜头${stats.truncated ? '（有视频超过 15 分钟，只分析了前 15 分钟）' : ''}`,
    `可调：${pack.knobs.map((knob) => knob.label[locale]).join('、') || '—'}`,
    `可信度：${pack.source?.confidenceNote ?? '—'}`,
  ].join('\n'));
  if (jsonOut !== null) {
    await writeFile(resolve(jsonOut), `${JSON.stringify({ measurements, stats, pack }, null, 2)}\n`);
    console.log(`\n已写入 ${jsonOut}`);
  }
} finally {
  await rm(workRoot, { recursive: true, force: true });
}
