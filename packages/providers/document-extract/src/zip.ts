import { inflateRawSync } from 'node:zlib';

/**
 * 最小 ZIP 读取器（P10-01；DOCX = ZIP + XML）。
 *
 * 只做 DOCX 需要的事：从**中央目录**读取条目（标准且可靠——本地头可能用数据描述符），
 * 支持 stored(0) 与 deflate(8)；其余压缩方法明确拒绝（UNSUPPORTED）。
 * 不处理 zip64（DOCX > 4GB 不现实；遇到则明确失败）。
 */

export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

export class ZipReadError extends Error {
  constructor(
    readonly code: 'CORRUPT' | 'UNSUPPORTED' | 'MISSING_ENTRY',
    message: string,
  ) {
    super(message);
    this.name = 'ZipReadError';
  }
}

/** 读取 ZIP 的全部条目（名称 → 解压字节）。 */
export function readZipEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // 从尾部向前找 EOCD（注释最多 64KB）
  let eocd = -1;
  const minStart = Math.max(0, bytes.length - 22 - 65535);
  for (let index = bytes.length - 22; index >= minStart; index -= 1) {
    if (view.getUint32(index, true) === EOCD_SIGNATURE) {
      eocd = index;
      break;
    }
  }
  if (eocd === -1) throw new ZipReadError('CORRUPT', '未找到 ZIP 结束记录（EOCD）');

  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  if (offset === 0xffffffff || entryCount === 0xffff) {
    throw new ZipReadError('UNSUPPORTED', 'zip64 不受支持（DOCX 不应出现）');
  }

  const entries: ZipEntry[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== CENTRAL_SIGNATURE) {
      throw new ZipReadError('CORRUPT', `中央目录条目 ${String(index)} 非法`);
    }
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder('utf-8').decode(bytes.subarray(offset + 46, offset + 46 + nameLength));

    if (view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) {
      throw new ZipReadError('CORRUPT', `条目 ${name} 本地头非法`);
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);

    let data: Uint8Array;
    if (method === 0) {
      data = compressed;
    } else if (method === 8) {
      data = new Uint8Array(inflateRawSync(compressed));
    } else {
      throw new ZipReadError('UNSUPPORTED', `条目 ${name} 的压缩方法 ${String(method)} 不受支持`);
    }
    if (data.byteLength !== uncompressedSize) {
      throw new ZipReadError('CORRUPT', `条目 ${name} 解压大小不一致（声明 ${String(uncompressedSize)}，实际 ${String(data.byteLength)}）`);
    }
    entries.push({ name, bytes: data });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** 读取单个条目（不存在 → MISSING_ENTRY 明确失败）。 */
export function readZipEntry(bytes: Uint8Array, name: string): Uint8Array {
  const entry = readZipEntries(bytes).find((item) => item.name === name);
  if (entry === undefined) throw new ZipReadError('MISSING_ENTRY', `ZIP 中缺少条目 ${name}`);
  return entry.bytes;
}

/* ---------- 写入（stored；仅供测试夹具与工具生成最小 DOCX） ---------- */

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 生成 ZIP 字节（stored 无压缩；测试夹具/工具用——DOCX 无压缩包 Word 亦接受）。 */
export function writeStoredZip(files: { name: string; content: string }[]): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const data = encoder.encode(file.content);
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, LOCAL_SIGNATURE, true);
    localView.setUint16(4, 20, true); // version needed
    localView.setUint16(6, 0, true); // flags
    localView.setUint16(8, 0, true); // stored
    localView.setUint32(14, crc, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);

    const centralEntry = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralEntry.buffer);
    centralView.setUint32(0, CENTRAL_SIGNATURE, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0, true);
    centralView.setUint16(10, 0, true); // stored
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint32(42, offset, true);
    centralEntry.set(nameBytes, 46);

    chunks.push(local, data);
    central.push(centralEntry);
    offset += local.length + data.length;
  }

  const centralSize = central.reduce((sum, entry) => sum + entry.length, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, EOCD_SIGNATURE, true);
  eocdView.setUint16(8, files.length, true);
  eocdView.setUint16(10, files.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, offset, true);

  const total = offset + centralSize + eocd.length;
  const result = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of [...chunks, ...central, eocd]) {
    result.set(chunk, cursor);
    cursor += chunk.length;
  }
  return result;
}
