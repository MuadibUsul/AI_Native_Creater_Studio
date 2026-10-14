#!/usr/bin/env node
// V6-7 / V6-8 付费生成"进程驱动"的参考实现（ANCS_GENERATION_DRIVER=process）：照着它把第 2 步换成你的供应商调用即可。
//
// 协议（Worker 每次生成启动一次本程序；只调用一次，不会自动重试）：
//   stdin：一行 JSON
//     { "kind": "AVATAR_CLIP" | "VIDEO_SHOT" | "VIDEO_REGION",
//       "prompt": "…" | null,            // 生成镜头 / 选区重绘：要生成什么
//       "script": "…" | null,            // 数字人：要说的话
//       "language": "en" | null,         // 数字人：讲稿语言
//       "seconds": 4, "maxSeconds": 5.2, // 目标时长；产物不得超过 maxSeconds（报价按它算上限）
//       "width": 1280, "height": 720, "fps": 30,
//       "outputPath": "/tmp/…/output.mp4", // 把生成的视频写到这里（MP4/MOV，FFmpeg 能解码即可）
//       "likenessPath": "…" | null,      // 数字人：参考照片（已从自有存储取到本地）
//       "voicePath": "…" | null,         // 数字人：声音样本
//       "sourcePath": "…" | null,        // 选区重绘：被重绘的片段（已按源时间裁好、适配到 width×height、无声）
//       "region": { "x": 0.5, "y": 0, "width": 0.5, "height": 0.4 } | null }  // 选区重绘：0–1，原点左上；圈外必须保持原样
//   退出码 0 = 成功：stdout 最后一行 JSON {"providerJobId": "…", "costMicros": 123456, "model": "…"}
//            costMicros 是供应商报告的实际费用（微美元）；不知道就省略，平台按报价上限结算并标明。
//   退出码 2 = 失败：stdout 最后一行 JSON {"error": "原因", "costMicros": 0, "providerJobId": "…"}；
//            costMicros > 0 表示失败但已扣费（平台按它结算），否则释放预留。
//   其他退出码 / 超时 / 崩溃 = 结果不明：平台不会再次调用，预留保持，等人工与供应商对账。
// 供应商密钥由本程序自己从环境变量读取；子进程只拿到白名单变量 + ANCS_GENERATION_PASS_ENV 里列出的变量，不要写进仓库。
//
// 配置示例（Worker）：
//   ANCS_GENERATION_DRIVER=process
//   ANCS_GENERATION_EXECUTABLE=node
//   ANCS_GENERATION_ARGS_JSON=["scripts/generation-process-example.mjs"]
//   ANCS_GENERATION_OFFERS_JSON=[{"kind":"VIDEO_SHOT","providerId":"example","implementation":"REAL","model":"ffmpeg-example","perSecondMicros":{"min":50000,"max":400000},"maxSeconds":8}]
//   ANCS_GENERATION_PASS_ENV=MY_VENDOR_API_KEY
//
// 这里的第 2 步用 FFmpeg 生成一段渐变画面（只支持 VIDEO_SHOT），只为演示协议、可以直接跑通；它不是供应商。
// 参数 --fail 演示"失败未扣费"（退出码 2），--crash 演示"结果不明"（退出码 3）。
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString('utf8').trim());
const done = (code, body) => { process.stdout.write(`${JSON.stringify(body)}\n`); process.exit(code); };

if (process.argv.includes('--fail')) done(2, { error: 'the example provider refused this request', costMicros: 0 });
if (process.argv.includes('--crash')) { process.stderr.write('connection reset while waiting for the provider\n'); process.exit(3); }
if (request.kind !== 'VIDEO_SHOT') done(2, { error: `the example only supports VIDEO_SHOT, not ${String(request.kind)}`, costMicros: 0 });

// 第 2 步：生成。换成你的供应商：用 request.prompt / seconds / width / height 调接口，等任务完成，
// 把视频下载到 request.outputPath（供应商的临时链接不能当永久文件，平台会把这个文件拉回自有存储）。
const seconds = Math.min(Number(request.seconds), Number(request.maxSeconds));
const args = ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', `gradients=s=${String(request.width)}x${String(request.height)}:r=${String(request.fps)}:d=${seconds.toFixed(3)}`,
  '-vf', 'format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', request.outputPath];
const child = spawn(process.env.ANCS_FFMPEG_PATH ?? 'ffmpeg', args, { stdio: ['ignore', 'ignore', 'inherit'] });
child.on('close', (code) => {
  if (code !== 0) done(2, { error: `ffmpeg exited with ${String(code)}`, costMicros: 0 });
  // 第 3 步：报告费用（按供应商账单/响应；这里按 0.1 美元/秒演示）
  done(0, { providerJobId: `example-${randomUUID()}`, costMicros: Math.round(seconds * 100_000), model: 'ffmpeg-example' });
});
