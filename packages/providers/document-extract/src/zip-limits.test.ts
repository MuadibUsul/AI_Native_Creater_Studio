import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ZIP_LIMITS, ZipReadError, readZipEntries } from './zip.js';

/**
 * 2026-10 外部评审核实后新增的**解压资源上限**验证。
 * 关键：拦截要发生在**分配之前**（用中央目录的声明值判定），而不是"先解压几百 MB 再报错"。
 */

interface RawEntry { name: string; data: Uint8Array; method?: 0 | 8; declaredUncompressed?: number; declaredCompressed?: number }

/** 手写最小 ZIP（本地头 + 中央目录 + EOCD），用于精确构造"声明值与实际不符"的恶意输入。 */
function buildZip(entries: RawEntry[]): Uint8Array {
  const chunks: number[] = [];
  const push = (bytes: number[]): void => { chunks.push(...bytes); };
  const u16 = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff];
  const u32 = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];

  const central: { name: string; method: number; compressed: number; uncompressed: number; offset: number }[] = [];
  for (const entry of entries) {
    const nameBytes = [...Buffer.from(entry.name, 'utf8')];
    const method = entry.method ?? 8;
    const payload = method === 8 ? new Uint8Array(deflateRawSync(Buffer.from(entry.data))) : entry.data;
    const offset = chunks.length;
    push(u32(0x04034b50)); push(u16(20)); push(u16(0)); push(u16(method)); push(u16(0)); push(u16(0));
    push(u32(0)); push(u32(payload.byteLength)); push(u32(entry.declaredUncompressed ?? entry.data.byteLength));
    push(u16(nameBytes.length)); push(u16(0));
    push(nameBytes); push([...payload]);
    central.push({
      name: entry.name, method,
      compressed: entry.declaredCompressed ?? payload.byteLength,
      uncompressed: entry.declaredUncompressed ?? entry.data.byteLength,
      offset,
    });
  }
  const centralStart = chunks.length;
  for (const item of central) {
    const nameBytes = [...Buffer.from(item.name, 'utf8')];
    push(u32(0x02014b50)); push(u16(20)); push(u16(20)); push(u16(0)); push(u16(item.method)); push(u16(0)); push(u16(0));
    push(u32(0)); push(u32(item.compressed)); push(u32(item.uncompressed));
    push(u16(nameBytes.length)); push(u16(0)); push(u16(0)); push(u16(0)); push(u16(0)); push(u32(0));
    push(u32(item.offset)); push(nameBytes);
  }
  const centralSize = chunks.length - centralStart;
  push(u32(0x06054b50)); push(u16(0)); push(u16(0)); push(u16(central.length)); push(u16(central.length));
  push(u32(centralSize)); push(u32(centralStart)); push(u16(0));
  return new Uint8Array(chunks);
}

const TIGHT = { ...ZIP_LIMITS, maxEntryUncompressedBytes: 1_000, maxTotalUncompressedBytes: 1_500, maxCompressionRatio: 200 } as const;

const expectZipError = (bytes: Uint8Array, pattern: RegExp, limits: typeof ZIP_LIMITS = ZIP_LIMITS): void => {
  try {
    readZipEntries(bytes, limits);
    throw new Error('期望抛出 ZipReadError，但没有');
  } catch (error) {
    expect(error).toBeInstanceOf(ZipReadError);
    expect((error as Error).message).toMatch(pattern);
  }
};

describe('ZIP 解压上限（压缩炸弹）', () => {
  it('正常 DOCX 形态（多个小 deflate 条目）仍可读取', () => {
    const bytes = buildZip([
      { name: '[Content_Types].xml', data: new Uint8Array(Buffer.from('<Types/>')) },
      { name: 'word/document.xml', data: new Uint8Array(Buffer.from('<w:document><w:body/></w:document>')) },
    ]);
    const entries = readZipEntries(bytes);
    expect(entries.map((entry) => entry.name)).toEqual(['[Content_Types].xml', 'word/document.xml']);
    expect(new TextDecoder().decode(entries[1]!.bytes)).toContain('w:document');
  });

  it('压缩比超限：声明 500MB / 实际 20 字节 → 在解压前就拒绝（不分配）', () => {
    const bytes = buildZip([
      { name: 'bomb.bin', data: new Uint8Array(20), declaredUncompressed: 500 * 1024 * 1024, declaredCompressed: 20 },
    ]);
    expectZipError(bytes, /压缩比|解压大小/);
  });

  it('单条目解压大小超上限 → 拒绝（用收紧后的上限，数据真实一致）', () => {
    const data = new Uint8Array(2_000); // 真实 2000 字节 > 收紧上限 1000
    const bytes = buildZip([{ name: 'big.bin', data }]);
    expectZipError(bytes, /超过条目上限/, TIGHT);
  });

  it('累计解压量超上限 → 拒绝（多条目累加，而非只看单条）', () => {
    // 每条 900 字节（单条不超 1000），两条累加 1800 > 累计上限 1500
    const bytes = buildZip([
      { name: 'a.bin', data: new Uint8Array(900) },
      { name: 'b.bin', data: new Uint8Array(900) },
    ]);
    expectZipError(bytes, /累计解压大小/, TIGHT);
  });

  it('注入上限后正常小文件仍可读（不误伤）', () => {
    const bytes = buildZip([{ name: 'small.xml', data: new Uint8Array(Buffer.from('<a/>')) }]);
    expect(readZipEntries(bytes, TIGHT).map((entry) => entry.name)).toEqual(['small.xml']);
  });

  it('条目数超上限 → 拒绝', () => {
    const many: RawEntry[] = [];
    for (let index = 0; index < ZIP_LIMITS.maxEntries + 1; index += 1) {
      many.push({ name: `f${String(index)}.xml`, data: new Uint8Array(0) });
    }
    expectZipError(buildZip(many), /条目数/);
  });
});
