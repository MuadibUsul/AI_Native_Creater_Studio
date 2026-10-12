import {
  RENDER_PLAN_AUDIO_RULES,
  compareFractions,
  finalRenderProfileSchema,
  stereoPanCoefficients,
  subtractFractions,
  timeToFraction,
  type FinalRenderProfile,
  type Fraction,
  type MediaTime,
  type RenderPlan,
  type RenderPlanAudioEntry,
  type RenderPlanVideoSegment,
} from '@ancs/contracts';
import { createHash } from 'node:crypto';

/**
 * V5-M4（§13）：RenderPlan → 受限、参数化的 FFmpeg 媒体图（N09-10 媒体部分）。**纯函数**：同一计划 + 档位 + 输入事实
 * 永远得到同一组 argv（`graphHash`），执行器只负责落盘与 spawn。
 *
 * 帧选择（与浏览器 baseline 同一"保持"语义）：输出第 k 帧（T_k = k / fps）显示**源中 PTS ≤ 映射源时刻**的最后一帧。
 * 做法：每段先换到精确公共时基（`settb=1/L`，L 让源时基与全部偏移都是整数），平移到序列时间，
 * 再 `fps=…:round=up`（输入 PTS x 映射到 ceil(x·fps)，最后一个 ≤ T_k 的帧落在 k 上），
 * 最后按**整数帧号** `trim=start_pts:end_pts` 截取 [kStart, kEnd)。基底画布与各段时间戳逐帧相同，叠加不依赖帧同步猜测。
 * 源末尾用 `tpad=stop_mode=clone` 保持最后一帧。
 *
 * 音频：每条可听条目 声道路由+声像（单个 pan 矩阵）→ 绝对源时间 atrim → 增益 → 等功率淡入淡出（`afade curve=qsin`）
 * → 按序列起点整数采样延迟 → amix（不归一化，与 WebAudio 求和一致）→ 补齐/截断到精确采样数。
 *
 * 安全：图中只出现由数值生成的参数与执行器生成的相对文件名；字幕文本**不进入** argv（侧载 SRT/VTT），
 * 输入仅限 `file`/`pipe` 协议。
 */

export interface FfmpegStagedSource {
  assetVersionId: string;
  /** 工作目录内的相对路径（执行器生成，非用户输入） */
  path: string;
  /** 视频流时基（ffprobe stream.time_base）；无视频流为 null */
  videoTimeBase: { num: number; den: number } | null;
  /** 首个音频流声道数；无音频流为 null */
  audioChannels: number | null;
}

export interface FfmpegMediaGraph {
  args: string[];
  filterGraph: string;
  outputFile: string;
  frameCount: bigint;
  sampleCount: bigint;
  /** argv 的 SHA-256（同一计划 + 档位 + 输入事实 → 同一图） */
  graphHash: string;
}

export const FFMPEG_OUTPUT_VIDEO_FILE = 'out/final.mp4';
export const FINAL_AUDIO_SAMPLE_RATE = 48_000;

const gcd = (left: bigint, right: bigint): bigint => {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
};
const lcm = (left: bigint, right: bigint): bigint => (left / gcd(left, right)) * right;
const reduce = (value: Fraction): Fraction => {
  const divisor = gcd(value.num, value.den) || 1n;
  return { num: value.num / divisor, den: value.den / divisor };
};
const floorDiv = (num: bigint, den: bigint): bigint => {
  const quotient = num / den;
  return (num % den !== 0n && (num < 0n) !== (den < 0n)) ? quotient - 1n : quotient;
};
const ceilDiv = (num: bigint, den: bigint): bigint => -floorDiv(-num, den);
const seconds = (time: MediaTime): Fraction => reduce(timeToFraction(time));

/** 秒（有理数）→ 十进制字符串；`direction` 控制舍入（-ss 必须向下，保证"保持帧"被解码）。 */
export function decimalSeconds(value: Fraction, direction: 'floor' | 'nearest', digits = 9): string {
  const scale = 10n ** BigInt(digits);
  const scaled = direction === 'floor' ? floorDiv(value.num * scale, value.den) : floorDiv(value.num * scale * 2n + value.den, value.den * 2n);
  const negative = scaled < 0n;
  const magnitude = negative ? -scaled : scaled;
  const whole = magnitude / scale;
  const fraction = (magnitude % scale).toString().padStart(digits, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole.toString()}${fraction === '' ? '' : `.${fraction}`}`;
}

/** 有限小数格式化（滤镜系数/角度；固定 6 位，避免指数记法进入 argv）。 */
const coef = (value: number): string => {
  if (!Number.isFinite(value)) throw new RangeError('non-finite filter coefficient');
  const fixed = value.toFixed(6);
  return fixed === '-0.000000' ? '0.000000' : fixed;
};

/** 输出帧窗口：T_k = k/fps 落在 [start, end) 内的 k（start/end 为秒）。 */
function frameWindow(range: { start: MediaTime; end: MediaTime }, fps: { num: number; den: number }): { kStart: bigint; kEnd: bigint } {
  const start = seconds(range.start);
  const end = seconds(range.end);
  // k ≥ start·fps ⇔ k ≥ ceil(start.num·fps.num / (start.den·fps.den))
  return {
    kStart: ceilDiv(start.num * BigInt(fps.num), start.den * BigInt(fps.den)),
    kEnd: ceilDiv(end.num * BigInt(fps.num), end.den * BigInt(fps.den)),
  };
}

interface Placement {
  scaleWidth: number;
  scaleHeight: number;
  crop: { width: number; height: number; x: number; y: number } | null;
  rotationRad: number;
  x: number;
  y: number;
}

/**
 * 与 `projectVisualPoint` 同一几何（裁切 → 缩放 → 绕锚点旋转 → 位移；恒等变换时对象完整矩形 = 画布）：
 * 计算缩放尺寸、裁切框与叠加位置（旋转滤镜绕图像中心旋转，故以旋转后的中心反推左上角）。
 */
export function placementOf(segment: Pick<RenderPlanVideoSegment, 'transform' | 'crop'>, canvas: { width: number; height: number }): Placement {
  const { transform, crop } = segment;
  const objectWidth = canvas.width * transform.scale.x;
  const objectHeight = canvas.height * transform.scale.y;
  const scaleWidth = Math.max(2, Math.round(objectWidth / 2) * 2);
  const scaleHeight = Math.max(2, Math.round(objectHeight / 2) * 2);
  const hasCrop = crop.left !== 0 || crop.top !== 0 || crop.right !== 0 || crop.bottom !== 0;
  const cropBox = hasCrop
    ? {
      width: Math.max(2, Math.round((scaleWidth * (1 - crop.left - crop.right)) / 2) * 2),
      height: Math.max(2, Math.round((scaleHeight * (1 - crop.top - crop.bottom)) / 2) * 2),
      x: Math.round(scaleWidth * crop.left),
      y: Math.round(scaleHeight * crop.top),
    }
    : null;
  // 可见矩形中心（对象局部像素，未旋转）
  const centerLocalX = (crop.left + (1 - crop.left - crop.right) / 2) * objectWidth;
  const centerLocalY = (crop.top + (1 - crop.top - crop.bottom) / 2) * objectHeight;
  const anchorX = transform.anchor.x * objectWidth;
  const anchorY = transform.anchor.y * objectHeight;
  const radians = (transform.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const rotatedCenterX = anchorX + (centerLocalX - anchorX) * cos - (centerLocalY - anchorY) * sin + transform.position.x * canvas.width;
  const rotatedCenterY = anchorY + (centerLocalX - anchorX) * sin + (centerLocalY - anchorY) * cos + transform.position.y * canvas.height;
  const visibleWidth = cropBox?.width ?? scaleWidth;
  const visibleHeight = cropBox?.height ?? scaleHeight;
  const rotatedWidth = Math.abs(visibleWidth * cos) + Math.abs(visibleHeight * sin);
  const rotatedHeight = Math.abs(visibleWidth * sin) + Math.abs(visibleHeight * cos);
  const outWidth = radians === 0 ? visibleWidth : Math.ceil(rotatedWidth / 2) * 2;
  const outHeight = radians === 0 ? visibleHeight : Math.ceil(rotatedHeight / 2) * 2;
  return {
    scaleWidth,
    scaleHeight,
    crop: cropBox,
    rotationRad: radians,
    x: Math.round(rotatedCenterX - outWidth / 2),
    y: Math.round(rotatedCenterY - outHeight / 2),
  };
}

export function compileFfmpegMediaGraph(input: {
  plan: RenderPlan;
  profile: FinalRenderProfile;
  sources: readonly FfmpegStagedSource[];
}): FfmpegMediaGraph {
  const plan = input.plan;
  const profile = finalRenderProfileSchema.parse(input.profile);
  const sourceOf = new Map(input.sources.map((source) => [source.assetVersionId, source]));
  const fps = plan.frameRate;
  const duration = seconds(plan.duration);
  const frameCount = ceilDiv(duration.num * BigInt(fps.num), duration.den * BigInt(fps.den));
  const sampleCount = ceilDiv(duration.num * BigInt(FINAL_AUDIO_SAMPLE_RATE), duration.den);
  if (frameCount <= 0n) throw new RangeError('render plan has zero duration');

  const args: string[] = ['-nostdin', '-v', 'error', '-y'];
  const filters: string[] = [];
  let inputIndex = 0;
  const addInput = (path: string, seekSeconds: Fraction): number => {
    const ss = compareFractions(seekSeconds, { num: 0n, den: 1n }) > 0 ? decimalSeconds(seekSeconds, 'floor') : '0';
    // 关键帧向前定位（-noaccurate_seek）：解码起点 ≤ ss ≤ 源入点，保证"保持帧"一定被解码；-copyts 保留绝对源时间
    // 协议白名单是逐输入选项：每个输入都只允许本地文件
    args.push('-protocol_whitelist', 'file,pipe', '-noaccurate_seek', '-ss', ss, '-copyts', '-start_at_zero', '-i', path);
    inputIndex += 1;
    return inputIndex - 1;
  };

  // ── 视频：基底画布 + 自下而上叠加
  filters.push(`color=c=black:s=${String(profile.width)}x${String(profile.height)}:r=${String(fps.num)}/${String(fps.den)},trim=end_frame=${frameCount.toString()},format=yuv420p[base0]`);
  let current = 'base0';
  let layerIndex = 0;
  for (const layer of plan.videoLayers) {
    for (const segment of layer.segments) {
      const source = sourceOf.get(segment.sourceVersionId);
      if (source === undefined || source.videoTimeBase === null) {
        throw new Error(`staged source missing video stream: ${segment.sourceVersionId}`);
      }
      const srcStart = seconds(segment.sourceRange.start);
      const seqStart = seconds(segment.sequenceRange.start);
      const { kStart, kEnd } = frameWindow(segment.sequenceRange, fps);
      if (kEnd <= kStart) continue; // 段短于一帧间隔且不覆盖任何输出帧
      const index = addInput(source.path, srcStart);
      // 公共时基 L：源时基与两个偏移均为整数刻度
      const sourceTb: Fraction = reduce({ num: BigInt(source.videoTimeBase.num), den: BigInt(source.videoTimeBase.den) });
      const L = lcm(lcm(sourceTb.den, srcStart.den), seqStart.den);
      const shift = (seqStart.num * (L / seqStart.den)) - (srcStart.num * (L / srcStart.den));
      const placement = placementOf(segment, profile);
      const chain = [
        `[${String(index)}:v:0]settb=1/${L.toString()}`,
        `setpts=PTS${shift >= 0n ? '+' : ''}${shift.toString()}`,
        'tpad=stop_mode=clone:stop_duration=2',
        `fps=fps=${String(fps.num)}/${String(fps.den)}:round=up`,
        `trim=start_pts=${kStart.toString()}:end_pts=${kEnd.toString()}`,
        `scale=${String(placement.scaleWidth)}:${String(placement.scaleHeight)}:flags=bicubic`,
        ...(placement.crop === null ? [] : [`crop=${String(placement.crop.width)}:${String(placement.crop.height)}:${String(placement.crop.x)}:${String(placement.crop.y)}`]),
        'format=rgba',
        ...(segment.opacity < 1 ? [`colorchannelmixer=aa=${coef(segment.opacity)}`] : []),
        ...(placement.rotationRad === 0 ? [] : [`rotate=a=${coef(placement.rotationRad)}:c=none:ow=rotw(${coef(placement.rotationRad)}):oh=roth(${coef(placement.rotationRad)})`]),
      ];
      const label = `v${String(layerIndex)}`;
      filters.push(`${chain.join(',')}[${label}]`);
      const next = `base${String(layerIndex + 1)}`;
      filters.push(`[${current}][${label}]overlay=x=${String(placement.x)}:y=${String(placement.y)}:eof_action=pass:repeatlast=0:format=auto[${next}]`);
      current = next;
      layerIndex += 1;
    }
  }
  filters.push(`[${current}]format=yuv420p[vout]`);

  // ── 音频
  const audible = plan.audio.filter((entry) => entry.audible);
  const audioLabels: string[] = [];
  audible.forEach((entry, position) => {
    const source = sourceOf.get(entry.sourceVersionId);
    if (source === undefined || source.audioChannels === null) {
      throw new Error(`staged source missing audio stream: ${entry.sourceVersionId}`);
    }
    const srcStart = seconds(entry.sourceRange.start);
    const srcEnd = seconds(entry.sourceRange.end);
    const length = subtractFractions(seconds(entry.sequenceRange.end), seconds(entry.sequenceRange.start));
    const delaySamples = floorDiv(seconds(entry.sequenceRange.start).num * BigInt(FINAL_AUDIO_SAMPLE_RATE) * 2n + seconds(entry.sequenceRange.start).den, seconds(entry.sequenceRange.start).den * 2n);
    const index = addInput(source.path, srcStart);
    const chain = [
      `[${String(index)}:a:0]aresample=${String(FINAL_AUDIO_SAMPLE_RATE)}`,
      panFilter(entry, source.audioChannels),
      `atrim=start=${decimalSeconds(srcStart, 'nearest')}:end=${decimalSeconds(srcEnd, 'nearest')}`,
      'asetpts=PTS-STARTPTS',
      ...(entry.gainDb === 0 ? [] : [`volume=${coef(entry.gainDb)}dB`]),
      ...fadeFilters(entry, length),
      `adelay=delays=${delaySamples.toString()}S:all=1`,
    ];
    const label = `a${String(position)}`;
    filters.push(`${chain.join(',')}[${label}]`);
    audioLabels.push(`[${label}]`);
  });
  if (audioLabels.length === 0) {
    filters.push(`anullsrc=r=${String(FINAL_AUDIO_SAMPLE_RATE)}:cl=stereo,atrim=end_sample=${sampleCount.toString()}[aout]`);
  } else {
    filters.push(`${audioLabels.join('')}amix=inputs=${String(audioLabels.length)}:normalize=0:duration=longest,apad,atrim=end_sample=${sampleCount.toString()}[aout]`);
  }

  const filterGraph = filters.join(';');
  args.push(
    '-filter_complex', filterGraph,
    '-map', '[vout]', '-map', '[aout]',
    '-frames:v', frameCount.toString(),
    '-c:v', 'libx264', '-preset', profile.encoderPreset, '-crf', String(profile.videoCrf), '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', `${String(profile.audioBitrateKbps)}k`, '-ar', String(FINAL_AUDIO_SAMPLE_RATE), '-ac', '2',
    '-map_metadata', '-1', '-movflags', '+faststart',
    FFMPEG_OUTPUT_VIDEO_FILE,
  );
  return {
    args,
    filterGraph,
    outputFile: FFMPEG_OUTPUT_VIDEO_FILE,
    frameCount,
    sampleCount,
    graphHash: createHash('sha256').update(JSON.stringify(args)).digest('hex'),
  };
}

/** 声道路由（channelMapping；缺省 = 单声道复制到双声道 / 立体声直通）与声像合成一个 pan 矩阵。 */
function panFilter(entry: RenderPlanAudioEntry, sourceChannels: number): string {
  // routing[out][in]
  const routing: number[][] = [new Array<number>(sourceChannels).fill(0), new Array<number>(sourceChannels).fill(0)];
  if (entry.channelMapping === null) {
    if (sourceChannels === 1) {
      routing[0]![0] = 1;
      routing[1]![0] = 1;
    } else {
      routing[0]![0] = 1;
      routing[1]![1] = 1;
    }
  } else {
    for (const mapping of entry.channelMapping) {
      if (mapping.sourceChannel >= sourceChannels || mapping.outputChannel > 1) {
        throw new RangeError(`channel mapping ${String(mapping.sourceChannel)}→${String(mapping.outputChannel)} is outside the source/stereo layout`);
      }
      routing[mapping.outputChannel]![mapping.sourceChannel] = 1;
    }
  }
  const pan = stereoPanCoefficients(entry.pan);
  const terms = (out: 0 | 1): string => {
    const row = Array.from({ length: sourceChannels }, (_, channel) => (out === 0
      ? pan.leftFromLeft * routing[0]![channel]! + pan.leftFromRight * routing[1]![channel]!
      : pan.rightFromLeft * routing[0]![channel]! + pan.rightFromRight * routing[1]![channel]!));
    return row.map((value, channel) => `${coef(value)}*c${String(channel)}`).join('+');
  };
  return `pan=stereo|c0=${terms(0)}|c1=${terms(1)}`;
}

/** 等功率淡变：afade `curve=qsin`（淡入 sin(πt/2)，淡出 cos(πt/2)；in² + out² = 1）。 */
function fadeFilters(entry: RenderPlanAudioEntry, length: Fraction): string[] {
  if (RENDER_PLAN_AUDIO_RULES.fadeCurve !== 'EQUAL_POWER') throw new Error('unsupported fade curve');
  const out: string[] = [];
  const fadeIn = seconds(entry.fadeIn);
  const fadeOut = seconds(entry.fadeOut);
  if (fadeIn.num > 0n) out.push(`afade=t=in:st=0:d=${decimalSeconds(fadeIn, 'nearest')}:curve=qsin`);
  if (fadeOut.num > 0n) {
    const start = subtractFractions(length, fadeOut);
    out.push(`afade=t=out:st=${decimalSeconds(start, 'nearest')}:d=${decimalSeconds(fadeOut, 'nearest')}:curve=qsin`);
  }
  return out;
}
