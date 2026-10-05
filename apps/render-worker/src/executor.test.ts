import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseMedia } from '@remotion/media-parser';
import { nodeReader } from '@remotion/media-parser/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_THEME_TOKENS,
  masterNarrationSchema,
  projectVersionSnapshotSchema,
  renderExecutionResultSchema,
  renderManifestSchema,
  renderRecordSchema,
} from '@ancs/contracts';
import { buildRenderExecutionSpec } from '@ancs/domain';
import { MockTtsAdapter } from '@ancs/providers-mock-tts';
import { executeRenderSpec, resolveBrowserExecutable } from './executor.js';

/**
 * P07-04 执行器验收（**真实 Remotion 服务端渲染**，非 mock）：
 * - 由 domain 的 buildRenderExecutionSpec 以 fixture 快照构建 spec（画面 + 场景素材 + BGM + 字幕）；
 * - 真实 bundle + renderMedia 出 MP4（解析元数据校验 1280×720 / 30fps / 时长 / **音轨存在**）；
 * - SRT/VTT/Manifest/result 产物 + manifest_hash 复核（= manifest.json 字节 SHA-256）。
 * 说明：档位选择 DRAFT_720 控制渲染时长；1920×1080（STUDIO_1080）的端到端验收在
 * apps/worker 的集成套件经生产任务链路（spawn CLI）覆盖。
 */

const WORKSPACE = 'ws_exec';
const PROJECT = 'prj_exec';
const NARRATION_TEXT_1 = '第一章：利率与通胀的关系';
const NARRATION_TEXT_2 = '联邦基金利率维持不变。';

// 1×1 红色 PNG（fixture 素材；仅验证 staging → 组件素材解析链路可渲染）
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let workDir: string;
let tts: MockTtsAdapter;

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'ancs-executor-'));
  tts = new MockTtsAdapter();
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('executeRenderSpec（真实渲染）', () => {
  it(
    '画面 + 旁白/BGM 音轨 + 字幕烧录 → MP4 1280×720/30fps/音轨/时长正确；SRT/VTT/Manifest 产物齐全',
    { timeout: 600_000 },
    async () => {
      // 1) 真实 TTS（Mock 适配器输出真实 WAV PCM16 16kHz；确定性时长）
      const narration1 = await tts.synthesize({ text: NARRATION_TEXT_1, voiceRef: { voiceIdentityId: null, provider: null, providerVoiceId: null, languageProfile: null }, speed: 1, styleInstruction: null });
      const narration2 = await tts.synthesize({ text: NARRATION_TEXT_2, voiceRef: { voiceIdentityId: null, provider: null, providerVoiceId: null, languageProfile: null }, speed: 1, styleInstruction: null });
      const music = await tts.synthesize({ text: 'BGM', voiceRef: { voiceIdentityId: null, provider: null, providerVoiceId: null, languageProfile: null }, speed: 1, styleInstruction: null });
      const totalDurationMs = narration1.durationMs + narration2.durationMs;

      // 2) fixture 快照（2 场景：章节标题 + 全屏图（绑定 visual 素材））+ 一条 MUSIC 轨（ducking）
      const snapshot = projectVersionSnapshotSchema.parse({
        schemaVersion: '0.1',
        graph: {
          schemaVersion: 'scene-graph-v1',
          projectId: PROJECT,
          projectRevision: 1,
          channelSnapshot: { channelId: 'chn_1', channelStyleVersion: 'v1' },
          identitySnapshot: {},
          format: { width: 1280, height: 720, fps: 30, aspectRatio: '16:9' },
          timeline: { durationMs: totalDurationMs, masterAudioAssetId: null },
          scenes: [
            {
              id: 'scn_1',
              revision: 1,
              position: 0,
              startMs: 0,
              durationMs: 3000,
              semanticType: 'HOST_STATEMENT',
              sceneType: 'CHAPTER_TITLE',
              props: { title: '利率周报', subtitle: 'P07-04 渲染证据', index: 1 },
              componentVersion: null,
              assetBindings: [],
              transition: { in: null, out: null },
              status: 'READY',
            },
            {
              id: 'scn_2',
              revision: 1,
              position: 1,
              startMs: 3000,
              durationMs: Math.max(2000, totalDurationMs - 3000),
              semanticType: 'IMAGE_EVIDENCE',
              sceneType: 'IMAGE_FULL',
              props: { assetId: null, assetUrl: null, caption: '素材已绑定（staging 链路）', headline: null },
              componentVersion: null,
              assetBindings: [{ assetId: 'ast_img', role: 'visual' }],
              transition: { in: null, out: null },
              status: 'READY',
            },
          ],
          captions: [],
          audioTracks: [{ id: 'atr_bgm', kind: 'MUSIC', assetId: 'ast_music', volume: 0.6, fadeInMs: 400, fadeOutMs: 400, ducking: true }],
          overlays: [],
          sourceReferences: [{ sourceId: 'src_1', datasetIds: [] }],
        },
        meta: { themeTokens: DEFAULT_THEME_TOKENS },
      });

      const render = renderRecordSchema.parse({
        id: 'rnd_exec_1',
        workspaceId: WORKSPACE,
        projectId: PROJECT,
        profile: 'DRAFT_720',
        status: 'QUEUED',
        input: {
          projectVersionId: 'pv_exec_1',
          masterNarrationId: 'mna_exec_1',
          assetVersionIds: ['av_img', 'av_music'],
          format: { width: 1280, height: 720, fps: 30 },
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const master = masterNarrationSchema.parse({
        id: 'mna_exec_1',
        workspaceId: WORKSPACE,
        projectId: PROJECT,
        narrativePlanId: 'npl_exec_1',
        narrativePlanRevision: 1,
        assetId: 'ast_narration',
        assetVersionId: 'av_narration',
        mimeType: 'audio/wav',
        sizeBytes: narration1.bytes.byteLength + narration2.bytes.byteLength,
        totalDurationMs,
        alignmentMethod: 'PROVIDER_TIMESTAMPS',
        segments: [
          { narrationBlockId: 'nrg_1', text: NARRATION_TEXT_1, charCount: [...NARRATION_TEXT_1].length, startMs: 0, durationMs: narration1.durationMs, endMs: narration1.durationMs, words: [], cacheKey: 'c1', reused: false },
          {
            narrationBlockId: 'nrg_2',
            text: NARRATION_TEXT_2,
            charCount: [...NARRATION_TEXT_2].length,
            startMs: narration1.durationMs,
            durationMs: narration2.durationMs,
            endMs: totalDurationMs,
            words: [],
            cacheKey: 'c2',
            reused: false,
          },
        ],
        cues: [
          { narrationBlockId: 'nrg_1', startMs: 0, durationMs: narration1.durationMs },
          { narrationBlockId: 'nrg_2', startMs: narration1.durationMs, durationMs: narration2.durationMs },
        ],
        voice: { voiceIdentityId: null, voiceIdentityVersion: null },
        cacheStats: { segments: 2, reused: 0, synthesized: 2 },
        warnings: [],
        createdAt: new Date().toISOString(),
      });

      const { spec, staging } = buildRenderExecutionSpec({
        render,
        snapshot,
        versionNumber: 1,
        master,
        assetVersionRows: [
          { id: 'av_narration', assetId: 'ast_narration', storageKey: 'x/narration.wav', mimeType: 'audio/wav' },
          { id: 'av_img', assetId: 'ast_img', storageKey: 'x/image.png', mimeType: 'image/png' },
          { id: 'av_music', assetId: 'ast_music', storageKey: 'x/music.wav', mimeType: 'audio/wav' },
        ],
      });
      expect(spec.format).toEqual({ width: 1280, height: 720, fps: 30, aspectRatio: '16:9' });

      // 3) 编排层产物：把"冻结素材"落盘（此处直接写 fixture 字节，替代存储取回）
      const assetsDir = path.join(workDir, 'assets');
      await mkdir(assetsDir, { recursive: true });
      for (const entry of staging) {
        if (entry.role === 'narration') {
          await writeFile(path.join(assetsDir, entry.fileName), Buffer.concat([Buffer.from(narration1.bytes), Buffer.from(narration2.bytes)]));
        } else if (entry.role === 'music') {
          await writeFile(path.join(assetsDir, entry.fileName), music.bytes);
        } else {
          await writeFile(path.join(assetsDir, entry.fileName), PNG_1X1);
        }
      }
      await writeFile(path.join(workDir, 'spec.json'), JSON.stringify(spec, null, 2), 'utf8');

      // 4) 真实渲染
      const result = await executeRenderSpec({ spec, workDir, browserExecutable: resolveBrowserExecutable() });
      expect(result.format).toEqual({ width: 1280, height: 720, fps: 30 });
      expect(result.durationMs).toBeGreaterThan(0);
      expect(result.files.map((file) => file.kind).sort()).toEqual(['MANIFEST', 'SUBTITLE_SRT', 'SUBTITLE_VTT', 'THUMBNAIL', 'VIDEO']);

      // 5) 产物落盘 + 回执一致性
      const outDir = path.join(workDir, 'out');
      for (const file of result.files) {
        const info = await stat(path.join(outDir, file.fileName));
        expect(info.size, `${file.fileName} 应有非空字节`).toBeGreaterThan(0);
        const bytes = await readFile(path.join(outDir, file.fileName));
        expect(createHash('sha256').update(bytes).digest('hex'), `${file.fileName} sha256`).toBe(file.sha256);
      }
      const resultJson = renderExecutionResultSchema.parse(JSON.parse(await readFile(path.join(outDir, 'result.json'), 'utf8')));
      expect(resultJson.manifestHash).toBe(result.manifestHash);
      expect(resultJson.renderId).toBe('rnd_exec_1');

      // 6) Manifest：哈希 = 字节 SHA-256；产物清单（不含 Manifest 自身）；REQ-28-01 基线字段
      const manifestBytes = await readFile(path.join(outDir, 'manifest.json'));
      expect(createHash('sha256').update(manifestBytes).digest('hex')).toBe(result.manifestHash);
      const manifest = renderManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
      expect(manifest.outputs.map((output) => output.kind).sort()).toEqual(['SUBTITLE_SRT', 'SUBTITLE_VTT', 'THUMBNAIL', 'VIDEO']);
      // P10-05 封面：真实 PNG（帧位来自 spec.thumbnail——规则同源）
      expect(spec.thumbnail).not.toBeNull();
      expect(spec.thumbnail?.atMs).toBeGreaterThanOrEqual(0);
      const thumbnailFile = result.files.find((file) => file.kind === 'THUMBNAIL');
      expect(thumbnailFile?.fileName).toBe('thumbnail.png');
      expect(thumbnailFile?.mimeType).toBe('image/png');
      expect(manifest.projectVersionId).toBe('pv_exec_1');
      expect(manifest.masterAudio?.masterNarrationId).toBe('mna_exec_1');
      expect(manifest.sceneAssets).toEqual([{ sceneId: 'scn_2', assetId: 'ast_img', assetVersionId: 'av_img', role: 'visual' }]);
      expect(manifest.renderSettings.audio.musicTrackCount).toBe(1);
      expect(manifest.renderSettings.captions.burnIn).toBe(true);

      // 7) 字幕产物（SRT/VTT；cue 数与 Alignment 一致）
      const srt = await readFile(path.join(outDir, 'subtitles.srt'), 'utf8');
      const vtt = await readFile(path.join(outDir, 'subtitles.vtt'), 'utf8');
      expect(srt.match(/-->/g)).toHaveLength(2);
      expect(srt).toContain('00:00:00,000 -->');
      expect(srt).toContain('利率');
      expect(vtt.startsWith('WEBVTT')).toBe(true);
      expect(vtt.match(/-->/g)).toHaveLength(2);

      // 8) MP4 元数据（真实解析）：分辨率/fps/时长/音轨
      const media = await parseMedia({
        src: path.join(outDir, 'final.mp4'),
        reader: nodeReader,
        // 内部开发用途；商业上线前的 Remotion 授权核验见计划 P09-06（REQ-47-01）
        acknowledgeRemotionLicense: true,
        fields: { dimensions: true, durationInSeconds: true, fps: true, audioCodec: true, tracks: true },
      });
      expect(media.dimensions).toEqual({ width: 1280, height: 720 });
      expect(media.fps).toBe(30);
      expect(media.audioCodec).not.toBeNull();
      expect(media.tracks.some((track) => track.type === 'audio')).toBe(true);
      const expectedSeconds = spec.durationMs / 1000;
      expect(media.durationInSeconds).toBeGreaterThan(expectedSeconds - 0.35);
      expect(media.durationInSeconds).toBeLessThan(expectedSeconds + 0.35);

      // 9) 无"组件未注册/校验失败"占位（画面内容真实渲染）
      expect(existsSync(path.join(outDir, 'final.mp4'))).toBe(true);
      expect(result.warnings.filter((warning) => warning.includes('未注册'))).toHaveLength(0);
    },
  );
});
