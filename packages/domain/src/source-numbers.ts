/**
 * 数据图解的数字来源校验（V6-5；AGENTS.md：数据图表不得使用虚构数值）。纯函数，无 I/O。
 *
 * 图解参数里出现的每个数字都必须在来源文字（文章）里出现过：比较的是数值本身
 * （"1,200" 与 "1200"、"3.50" 与 "3.5" 视为同一个数；全角数字按半角处理），
 * 不认可换算、四舍五入或推算出来的新数字。
 */

const FULL_WIDTH_DIGITS = /[０-９．，]/g;

function halfWidth(text: string): string {
  return text.replace(FULL_WIDTH_DIGITS, (char) => {
    if (char === '．') return '.';
    if (char === '，') return ',';
    return String.fromCharCode(char.charCodeAt(0) - 0xfee0);
  });
}

/** 文字里的数（规范化后的十进制文本，去重保序）。 */
export function numbersIn(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of halfWidth(text).match(/\d[\d,]*(?:\.\d+)?/g) ?? []) {
    // 千分位逗号（1,200 / 12,345.6）去掉；其他逗号当作分隔（"3,5" → 3 与 5）
    const pieces = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(token) ? [token.replace(/,/g, '')] : token.split(',').filter((piece) => piece.length > 0);
    for (const piece of pieces) {
      const value = Number(piece);
      if (!Number.isFinite(value)) continue;
      const canonical = String(value);
      if (!seen.has(canonical)) { seen.add(canonical); out.push(canonical); }
    }
  }
  return out;
}

/** 在来源里找不到的数（按出现顺序）；空数组 = 全部有出处。 */
export function numbersMissingFromSource(texts: readonly string[], source: string): string[] {
  const available = new Set(numbersIn(source));
  const missing: string[] = [];
  for (const text of texts) {
    for (const number of numbersIn(text)) {
      if (!available.has(number) && !missing.includes(number)) missing.push(number);
    }
  }
  return missing;
}
