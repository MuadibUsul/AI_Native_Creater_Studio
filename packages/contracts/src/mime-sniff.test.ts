import { describe, expect, it } from 'vitest';
import { mimeMatches, probeImageDimensions, probeWavDurationMs, sniffMimeType } from './mime-sniff.js';

/**
 * 内容嗅探与探测（P02-04）：伪造 MIME 的判定基础——声明为有签名类型时必须嗅探出兼容签名。
 */

const PNG_1x1 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x02, 0x80, // width = 640
  0x00, 0x00, 0x01, 0x68, // height = 360
  0x08, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

const JPEG_MINIMAL = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const MP4_MINIMAL = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
const QUICKTIME_MINIMAL = new Uint8Array([0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20]);
const M4A_MINIMAL = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]);
const WAV_HEADER = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x64, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
  0x66, 0x6d, 0x74, 0x20, 0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x40, 0x1f, 0x00, 0x00, 0x80, 0x3e, 0x00, 0x00, 0x02, 0x00, 0x10, 0x00,
  0x64, 0x61, 0x74, 0x61, 0x40, 0x1f, 0x00, 0x00,
]);
const TEXT_BYTES = new TextEncoder().encode('这是纯文本，不是任何二进制格式');

describe('MIME 嗅探（魔术字节）', () => {
  it('按签名识别常见容器；无法识别返回 null', () => {
    expect(sniffMimeType(PNG_1x1)).toBe('image/png');
    expect(sniffMimeType(JPEG_MINIMAL)).toBe('image/jpeg');
    expect(sniffMimeType(MP4_MINIMAL)).toBe('video/mp4');
    expect(sniffMimeType(QUICKTIME_MINIMAL)).toBe('video/quicktime');
    expect(sniffMimeType(M4A_MINIMAL)).toBe('audio/mp4');
    expect(sniffMimeType(WAV_HEADER)).toBe('audio/wav');
    expect(sniffMimeType(new TextEncoder().encode('%PDF-1.7'))).toBe('application/pdf');
    expect(sniffMimeType(new Uint8Array([0x49, 0x44, 0x33, 0x03]))).toBe('audio/mpeg');
    expect(sniffMimeType(TEXT_BYTES)).toBeNull();
    expect(sniffMimeType(new Uint8Array())).toBeNull();
  });

  it('伪造 MIME：声明为有签名类型但内容不匹配 → 拒绝', () => {
    // 文本冒充 PNG/JPEG/MP4/PDF
    expect(mimeMatches('image/png', sniffMimeType(TEXT_BYTES))).toBe(false);
    expect(mimeMatches('image/jpeg', sniffMimeType(TEXT_BYTES))).toBe(false);
    expect(mimeMatches('video/mp4', sniffMimeType(TEXT_BYTES))).toBe(false);
    expect(mimeMatches('application/pdf', sniffMimeType(TEXT_BYTES))).toBe(false);
    // 跨类型冒充：JPEG 声明为 PNG
    expect(mimeMatches('image/png', sniffMimeType(JPEG_MINIMAL))).toBe(false);
    // 真身一致 → 通过
    expect(mimeMatches('image/png', sniffMimeType(PNG_1x1))).toBe(true);
    expect(mimeMatches('video/mp4', sniffMimeType(MP4_MINIMAL))).toBe(true);
    expect(mimeMatches('video/quicktime', sniffMimeType(QUICKTIME_MINIMAL))).toBe(true);
    expect(mimeMatches('audio/mp4', sniffMimeType(M4A_MINIMAL))).toBe(true);
    // 别名：audio/mp3 ↔ audio/mpeg
    expect(mimeMatches('audio/mp3', sniffMimeType(new Uint8Array([0x49, 0x44, 0x33, 0x03])))).toBe(true);
  });

  it('无签名类型（text/JSON/SRT/VTT/SVG）不参与比对', () => {
    expect(mimeMatches('text/plain', sniffMimeType(TEXT_BYTES))).toBe(true);
    expect(mimeMatches('application/json', sniffMimeType(TEXT_BYTES))).toBe(true);
    expect(mimeMatches('application/x-subrip', sniffMimeType(TEXT_BYTES))).toBe(true);
    expect(mimeMatches('text/vtt', sniffMimeType(TEXT_BYTES))).toBe(true);
    expect(mimeMatches('image/svg+xml', sniffMimeType(TEXT_BYTES))).toBe(true);
  });

  it('图片尺寸探测（PNG/JPEG/GIF/WEBP）与 WAV 时长探测', () => {
    expect(probeImageDimensions(PNG_1x1, 'image/png')).toEqual({ width: 640, height: 360 });
    expect(probeImageDimensions(TEXT_BYTES, 'text/plain')).toBeNull();

    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x20, 0x03, 0x58, 0x02]);
    expect(probeImageDimensions(gif, 'image/gif')).toEqual({ width: 800, height: 600 });

    // WAV：sampleRate=8000、byteRate=16000、data 8000 字节 → 500ms
    expect(probeWavDurationMs(WAV_HEADER)).toBe(500);
    expect(probeWavDurationMs(PNG_1x1)).toBeNull();
  });
});
