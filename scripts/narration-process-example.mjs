#!/usr/bin/env node
// V6-5 讲述配音"进程驱动"的参考实现（ANCS_NARRATION_DRIVER=process）：照着它把第 2 步换成你的供应商调用即可。
//
// 协议（Worker 每句启动一次本程序）：
//   stdin：一行 JSON {"text": "要读的一句话", "voice": "声音 id（来自 ANCS_NARRATION_VOICES_JSON）", "speed": 1}
//   stdout：这句话的音频（WAV / MP3 / 任何 FFmpeg 能解码的格式）；退出码 0。出错时写 stderr 并以非 0 退出。
// 供应商密钥由本程序自己从环境变量读取（例如 MY_TTS_API_KEY），不要写进仓库。
//
// 配置示例（Worker）：
//   ANCS_NARRATION_DRIVER=process
//   ANCS_NARRATION_EXECUTABLE=node
//   ANCS_NARRATION_ARGS_JSON=["scripts/narration-process-example.mjs"]
//   ANCS_NARRATION_VOICES_JSON=[{"id":"slt","name":"SLT","languages":["en"],"description":"US English, female (flite example)"}]
//
// 这里的第 2 步用 FFmpeg 内置的 flite 合成（只会英文），只为演示协议、可以直接跑通。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString('utf8').trim());
if (typeof request.text !== 'string' || request.text.trim() === '') {
  process.stderr.write('empty text\n');
  process.exit(2);
}

// 第 2 步：合成。换成你的供应商：用 request.text / request.voice / request.speed 调接口，把返回的音频字节写到 stdout。
const voice = /^[a-z0-9]+$/.test(String(request.voice)) ? String(request.voice) : 'slt';
const dir = mkdtempSync(join(tmpdir(), 'narration-example-'));
const textFile = join(dir, 'sentence.txt');
writeFileSync(textFile, request.text, 'utf8');
const child = spawn('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', `flite=textfile='${textFile.replace(/:/g, '\\:')}':voice=${voice}`, '-f', 'wav', 'pipe:1'], { stdio: ['ignore', 'inherit', 'inherit'] });
child.on('close', (code) => { rmSync(dir, { recursive: true, force: true }); process.exit(code ?? 1); });
