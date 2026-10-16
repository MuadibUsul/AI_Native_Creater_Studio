import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex, utf8Bytes } from './hash.js';

/**
 * V5-M4：内核纯 SHA-256 / 规范 JSON。
 * 期望值由平台实现（Node `crypto.createHash('sha256')` 与 `Buffer.from(text, 'utf8')`）离线生成后固化：
 * 内核测试与内核源码一样不依赖 node 类型，在浏览器环境下也应给出同一结果。
 */

describe('sha256Hex', () => {
  it('FIPS 180-4 标准向量', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('跨块边界（55/56/63/64/65/119/120/1000 字节）与平台实现一致', () => {
    const expected: Record<number, string> = {
      55: '9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318',
      56: 'b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a',
      63: '7d3e74a05d7db15bce4ad9ec0658ea98e3f06eeecf16b4c6fff2da457ddc2f34',
      64: 'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb',
      65: '635361c48bb9eab14198e76ea8ab7f1a41685d6ad62aa9146d301d4f17eb0ae0',
      119: '31eba51c313a5c08226adf18d4a359cfdfd8d2e816b13f4af952f7ea6584dcfb',
      120: '2f3d335432c70b580af0e8e1b3674a7c020d683aa5f73aaaedfdc55af904c21c',
      1000: '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3',
    };
    for (const [length, hash] of Object.entries(expected)) expect(sha256Hex('a'.repeat(Number(length)))).toBe(hash);
  });

  it('多字节字符按 UTF-8 计算', () => {
    expect(sha256Hex('剪掉前面的废话')).toBe('8f7ed34d4a879e0ccfb00a7731d9e79cccd82e300ffcc73e3d4d6d9219329ae4');
    expect(sha256Hex('emoji 🎬🎞️ mix')).toBe('97639d05e862e8fe7a907824c142747fdba4eb935abdf5e6cc5681932a912145');
    expect(sha256Hex('\u0000\u007f\u0080߿ࠀ￿')).toBe('3f7a5cdf8c5a5c437d8652301d3a61ad024f7e47f2b298c72a84539589c15a48');
  });

  it('UTF-8 编码与平台一致；孤立代理项编码为 U+FFFD', () => {
    const cases: [string, number[]][] = [
      ['ascii', [97, 115, 99, 105, 105]],
      ['é', [195, 169]],
      ['中文', [228, 184, 173, 230, 150, 135]],
      ['😀', [240, 159, 152, 128]],
      ['a\ud800b', [97, 239, 191, 189, 98]],
      ['\udc00', [239, 191, 189]],
    ];
    for (const [text, bytes] of cases) expect([...utf8Bytes(text)]).toEqual(bytes);
  });
});

describe('canonicalJson', () => {
  it('键序无关、省略 undefined、数组保序', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: 'x' }, z: undefined })).toBe('{"a":{"c":"x","d":[3,{"x":2,"y":1}]},"b":1}');
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    expect(canonicalJson([1, undefined, null])).toBe('[1,null,null]');
  });

  it('拒绝非有限数字与不支持的类型（权威时间必须是字符串 ticks）', () => {
    expect(() => canonicalJson({ value: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ value: 1n })).toThrow(TypeError);
  });
});
