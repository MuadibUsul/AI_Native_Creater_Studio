import { describe, expect, it } from 'vitest';
import { parseByteRange } from './routes/storage.js';

/** 本地存储下载端点的字节范围解析（视频拖动进度依赖它）。 */
describe('parseByteRange', () => {
  it('单段范围、开放结尾、后缀范围；终点越界截到对象末尾', () => {
    expect(parseByteRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
    expect(parseByteRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 });
    expect(parseByteRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseByteRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 });
    expect(parseByteRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 });
  });

  it('起点越界或空后缀 → 416；没有/多段/其他单位/格式错误 → 整份返回', () => {
    expect(parseByteRange('bytes=1000-', 1000)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=-0', 1000)).toBe('unsatisfiable');
    expect(parseByteRange(undefined, 1000)).toBeNull();
    expect(parseByteRange('bytes=0-1,5-6', 1000)).toBeNull();
    expect(parseByteRange('items=0-1', 1000)).toBeNull();
    expect(parseByteRange('bytes=5-2', 1000)).toBeNull();
    expect(parseByteRange('bytes=-', 1000)).toBeNull();
  });
});
