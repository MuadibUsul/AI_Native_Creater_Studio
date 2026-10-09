import type { MediaRange } from './common/media-time.js';

/**
 * N03-07 字幕文本的纯函数（平台中立）。
 *
 * 纪律（V03-23／V03-24）：
 * - 字幕文本由**词条**重建，词条是权威；任何"删词/断句"操作都只改动词条，
 *   不准顺手改写保留词的文字 —— 否定词与数字必须逐字保留；
 * - CJK 词之间不加空格，拉丁词之间补一个空格，标点随词条保留（不在重建时重排）。
 */

export interface CaptionWord {
  id: string;
  text: string;
  range: MediaRange;
}

/** 词条是否以 CJK 字符结尾/开头（决定重建文本时是否补空格）。 */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

const isCjkBoundary = (left: string, right: string): boolean => {
  const leftChar = left.slice(-1);
  const rightChar = right.slice(0, 1);
  if (leftChar === '' || rightChar === '') return false;
  // 任一侧是 CJK 都不补空格（中文与数字/拉丁混排按原样贴合）
  if (CJK.test(leftChar) || CJK.test(rightChar)) return false;
  if (/^[\s。，、！？；：）」』】》”’]/.test(rightChar)) return false;
  if (/[\s（「『【《“‘]$/.test(leftChar)) return false;
  return true;
};

/** 由词条重建字幕文本（保持词内文字原样，含否定词与数字）。 */
export function captionTextFromWords(words: readonly CaptionWord[]): string {
  let text = '';
  for (const word of words) {
    if (text === '') {
      text = word.text;
      continue;
    }
    text += isCjkBoundary(text, word.text) ? ` ${word.text}` : word.text;
  }
  return text;
}

/** 否定词／否定语气标记（用于"否定词保留"断言与写前提示）。 */
export const NEGATION_MARKERS = ['没有', '不是', '不要', '不能', '不会', '不', '没', '无', '别', '非', '未', 'no', 'not', "n't", 'never', 'without'] as const;

export function containsNegation(text: string): boolean {
  const lower = text.toLowerCase();
  return NEGATION_MARKERS.some((marker) => lower.includes(marker));
}

export function containsDigits(text: string): boolean {
  return /\d/.test(text);
}

/** 文本中的数字与否定词集合（写前/写后比对，确保不被改写掉）。 */
export function preservationTokens(text: string): { negations: string[]; digits: string[] } {
  const lower = text.toLowerCase();
  return {
    negations: NEGATION_MARKERS.filter((marker) => lower.includes(marker)),
    digits: text.match(/\d+/g) ?? [],
  };
}

/** 删除词条区间（半开区间）后剩余的词条；保留词条的文字**原样不动**。 */
export function removeWordRange(words: readonly CaptionWord[], fromIndex: number, toIndex: number): CaptionWord[] {
  if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex) || fromIndex < 0 || toIndex > words.length || fromIndex >= toIndex) {
    throw new RangeError('removeWordRange requires a non-empty index range inside the word list');
  }
  return words.filter((_, index) => index < fromIndex || index >= toIndex);
}

/** 在词条边界断句：返回 [left, right]，两侧文字都按词条重建（不改词）。 */
export function splitWordsAt(words: readonly CaptionWord[], atIndex: number): { left: CaptionWord[]; right: CaptionWord[] } {
  if (!Number.isInteger(atIndex) || atIndex <= 0 || atIndex >= words.length) {
    throw new RangeError('split index must fall strictly inside the word list');
  }
  return { left: words.slice(0, atIndex), right: words.slice(atIndex) };
}
