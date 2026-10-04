import type { AssetType } from './assets.js';

/**
 * 上传内容嗅探（P02-04 / 规范 §26；"伪造 MIME 不可 Ready"）。
 *
 * 仅依据**魔术字节/容器签名**判定，不信任客户端声明；文本类（text/*、JSON、SRT/VTT）
 * 无签名可嗅探，按"无法嗅探 → 不参与比对"处理（该局限记录在验证文档中）。
 */

const startsWith = (bytes: Uint8Array, signature: readonly number[] | string): boolean => {
  const sig = typeof signature === 'string' ? [...signature].map((char) => char.charCodeAt(0)) : signature;
  if (bytes.length < sig.length) return false;
  return sig.every((byte, index) => bytes[index] === byte);
};

const asciiAt = (bytes: Uint8Array, offset: number, text: string): boolean => {
  if (bytes.length < offset + text.length) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
};

/** 返回嗅探到的 MIME；无法判定时 null。 */
export function sniffMimeType(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return null;
  // 图片
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (asciiAt(bytes, 0, 'GIF87a') || asciiAt(bytes, 0, 'GIF89a')) return 'image/gif';
  if (asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WEBP')) return 'image/webp';
  // 音频/视频容器
  if (asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WAVE')) return 'audio/wav';
  if (asciiAt(bytes, 4, 'ftyp')) {
    if (asciiAt(bytes, 8, 'qt  ')) return 'video/quicktime';
    if (asciiAt(bytes, 8, 'M4A ') || asciiAt(bytes, 8, 'M4B ')) return 'audio/mp4';
    return 'video/mp4';
  }
  if (asciiAt(bytes, 0, 'ID3')) return 'audio/mpeg';
  if (bytes[0] === 0xff && (bytes[1] ?? 0) >= 0xe0) return 'audio/mpeg';
  if (asciiAt(bytes, 0, 'OggS')) return 'audio/ogg';
  if (asciiAt(bytes, 0, 'fLaC')) return 'audio/flac';
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';
  // 文档
  if (asciiAt(bytes, 0, '%PDF')) return 'application/pdf';
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return 'application/zip';
  return null;
}

/** 声明 MIME 与嗅探结果的兼容关系（别名/家族归一）。 */
const MIME_EQUIVALENCE: Readonly<Record<string, readonly string[]>> = {
  'audio/mpeg': ['audio/mpeg', 'audio/mp3'],
  'audio/mp3': ['audio/mpeg', 'audio/mp3'],
  'video/mp4': ['video/mp4'],
  'audio/mp4': ['audio/mp4'],
  'video/quicktime': ['video/quicktime'],
  'application/zip': ['application/zip', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
};

/**
 * "有签名可嗅探"的声明类型：必须命中真实签名且与声明兼容（否则视为伪造 MIME）。
 * 其余类型（text/*、JSON、SRT/VTT、SVG）无可靠签名——按"无法嗅探 → 不参与比对"处理。
 */
const SIGNATURE_REQUIRED_DECLARATIONS = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/mp4',
  'audio/ogg',
  'audio/flac',
  'application/pdf',
  'application/zip',
]);

export function mimeMatches(declared: string, sniffed: string | null): boolean {
  const accepted = MIME_EQUIVALENCE[declared] ?? [declared];
  if (SIGNATURE_REQUIRED_DECLARATIONS.has(declared)) {
    // 声明为有签名类型：必须嗅探出签名且兼容（null = 内容无此签名 → 伪造）
    return sniffed !== null && accepted.includes(sniffed);
  }
  // 无签名类型（text/*、JSON、SRT/VTT、SVG 等）：不参与比对
  return true;
}

/** 资产类型 → 允许声明的 MIME 白名单（上传意图阶段即拒绝不支持的组合）。 */
export const ASSET_MIME_ALLOWLIST: Readonly<Record<AssetType, readonly string[]>> = {
  SOURCE_DOCUMENT: ['application/pdf', 'text/plain', 'text/markdown', 'application/json'],
  SOURCE_IMAGE: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  USER_UPLOAD: [
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'video/mp4',
    'video/quicktime',
    'audio/mpeg',
    'audio/wav',
    'audio/mp4',
    'audio/ogg',
    'application/pdf',
    'text/plain',
    'text/markdown',
  ],
  AVATAR_CLIP: ['video/mp4', 'video/quicktime'],
  VOICE_AUDIO: ['audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/ogg'],
  MUSIC: ['audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/ogg', 'audio/flac'],
  GENERATED_IMAGE: ['image/png', 'image/jpeg', 'image/webp'],
  GENERATED_VIDEO: ['video/mp4', 'video/quicktime', 'video/webm'],
  CHART_RENDER: ['image/png', 'image/svg+xml'],
  CUSTOM_MOTION_RENDER: ['video/mp4', 'image/png'],
  SUBTITLE: ['text/vtt', 'application/x-subrip', 'text/plain'],
  DRAFT_RENDER: ['video/mp4'],
  FINAL_VIDEO: ['video/mp4'],
  SHORT_VIDEO: ['video/mp4'],
  THUMBNAIL: ['image/png', 'image/jpeg', 'image/webp'],
  MANIFEST: ['application/json'],
};

/** 图片尺寸探测（真实解析头部字节；失败返回 null）。 */
export function probeImageDimensions(bytes: Uint8Array, mimeType: string | null): { width: number; height: number } | null {
  const readUint32BE = (offset: number): number =>
    ((bytes[offset] ?? 0) << 24) | ((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);
  const readUint16BE = (offset: number): number => ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
  const readUint16LE = (offset: number): number => (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);

  if (mimeType === 'image/png' && bytes.length >= 24 && asciiAt(bytes, 12, 'IHDR')) {
    return { width: readUint32BE(16), height: readUint32BE(20) };
  }
  if (mimeType === 'image/gif' && bytes.length >= 10) {
    return { width: readUint16LE(6), height: readUint16LE(8) };
  }
  if (mimeType === 'image/jpeg') {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1] ?? 0;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: readUint16BE(offset + 5), width: readUint16BE(offset + 7) };
      }
      const segmentLength = readUint16BE(offset + 2);
      if (segmentLength < 2) return null;
      offset += 2 + segmentLength;
    }
    return null;
  }
  if (mimeType === 'image/webp' && bytes.length >= 30 && asciiAt(bytes, 12, 'VP8')) {
    if (asciiAt(bytes, 12, 'VP8 ')) {
      return { width: readUint16LE(26) & 0x3fff, height: readUint16LE(28) & 0x3fff };
    }
    if (asciiAt(bytes, 12, 'VP8L')) {
      const bits = (bytes[21] ?? 0) | ((bytes[22] ?? 0) << 8) | ((bytes[23] ?? 0) << 16) | ((bytes[24] ?? 0) << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return null;
  }
  return null;
}

/** WAV 时长探测（data 块大小 / 字节率）；失败返回 null。 */
export function probeWavDurationMs(bytes: Uint8Array): number | null {
  if (!(asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WAVE'))) return null;
  const readUint32LE = (offset: number): number =>
    (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16) | ((bytes[offset + 3] ?? 0) << 24);
  let offset = 12;
  let byteRate = 0;
  let dataSize = 0;
  while (offset + 8 <= bytes.length) {
    const chunkId = String.fromCharCode(bytes[offset] ?? 0, bytes[offset + 1] ?? 0, bytes[offset + 2] ?? 0, bytes[offset + 3] ?? 0);
    const chunkSize = readUint32LE(offset + 4);
    if (chunkId === 'fmt ' && offset + 8 + 16 <= bytes.length) {
      byteRate = readUint32LE(offset + 8 + 8);
    }
    if (chunkId === 'data') {
      dataSize = chunkSize;
      break;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  if (byteRate <= 0 || dataSize <= 0) return null;
  return Math.round((dataSize / byteRate) * 1000);
}
