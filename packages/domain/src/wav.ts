/**
 * WAV（PCM16）编解码（P06-03 / 域内纯函数；mock-tts 与对齐服务共用，避免两处实现）。
 */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(44 + index * 2, Math.round(clamped * 32767), true);
  }
  return new Uint8Array(buffer);
}

export interface ParsedWavPcm16 {
  sampleRate: number;
  channels: number;
  dataOffset: number;
  dataLength: number;
}

export function parseWavPcm16(bytes: Uint8Array): ParsedWavPcm16 | null {
  if (bytes.length < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset: number, length: number): string =>
    Array.from({ length }, (_, index) => String.fromCharCode(view.getUint8(offset + index))).join('');
  if (ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE' || ascii(12, 4) !== 'fmt ') return null;
  if (view.getUint16(20, true) !== 1) return null;
  if (view.getUint16(34, true) !== 16) return null;
  const channels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = ascii(offset, 4);
    const size = view.getUint32(offset + 4, true);
    if (id === 'data') return { sampleRate, channels, dataOffset: offset + 8, dataLength: Math.min(size, bytes.length - offset - 8) };
    offset += 8 + size + (size % 2);
  }
  return null;
}
