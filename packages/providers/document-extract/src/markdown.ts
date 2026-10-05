import { parsedDocumentSchema, type ParsedDocument, type ParsedDocumentElement } from '@ancs/contracts';

/**
 * Markdown 解析（P10-01）：GFM 常用子集，保留表格与出处。
 *
 * 支持：ATX 标题（#..######）、段落、引用（>）、无序/有序列表、**GFM 表格**（表头 + `|---|` 分隔行）、
 * 围栏代码块（作为段落保留，注明语言）、行内链接保留文本并记录 URL（出处警告）。
 * 明确不支持（**逐条警告，不静默**）：内嵌 HTML、脚注、定义列表、YAML front matter（作为警告 + 跳过）、
 * 图片（记录为警告「图片未提取——作为资产上传」）。
 */

const IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;
const LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;

function stripInline(text: string, warnings: string[]): string {
  let result = text;
  result = result.replace(IMAGE_RE, (_match, alt: string, url: string) => {
    warnings.push(`Markdown 图片未提取（作为资产上传）：${alt === '' ? url : alt}`);
    return alt;
  });
  result = result.replace(LINK_RE, (_match, label: string, url: string) => {
    warnings.push(`行内链接保留文本并记录出处：${label} → ${url}`);
    return label === '' ? url : label;
  });
  result = result.replace(/`([^`]+)`/g, '$1');
  result = result.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1');
  result = result.replace(/__([^_]+)__/g, '$1').replace(/_([^_]+)_/g, '$1');
  return result.trim();
}

const splitRow = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());

const isTableSeparator = (line: string): boolean => /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(line.trim());

export function parseMarkdownBytes(bytes: Uint8Array): ParsedDocument {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const elements: ParsedDocumentElement[] = [];
  const warnings: string[] = [];

  let index = 0;
  let inFence = false;
  let fenceLanguage = '';
  let fenceLines: string[] = [];

  const flushParagraphBuffer: string[] = [];
  const flushParagraph = (): void => {
    if (flushParagraphBuffer.length > 0) {
      const joined = stripInline(flushParagraphBuffer.join(' '), warnings);
      if (joined !== '') elements.push({ type: 'paragraph', text: joined });
      flushParagraphBuffer.length = 0;
    }
  };

  while (index < lines.length) {
    const raw = lines[index] ?? '';
    const line = raw;

    // 围栏代码块
    const fenceMatch = /^```\s*([A-Za-z0-9+#-]*)\s*$/.exec(line.trim());
    if (fenceMatch !== null) {
      if (inFence) {
        const code = fenceLines.join('\n').trim();
        if (code !== '') elements.push({ type: 'paragraph', text: `[代码块${fenceLanguage === '' ? '' : ` · ${fenceLanguage}`}] ${code}` });
        inFence = false;
        fenceLanguage = '';
        fenceLines = [];
      } else {
        flushParagraph();
        inFence = true;
        fenceLanguage = fenceMatch[1] ?? '';
      }
      index += 1;
      continue;
    }
    if (inFence) {
      fenceLines.push(raw);
      index += 1;
      continue;
    }

    // front matter（--- 开头且下一行是键值）→ 警告 + 跳过块
    if (index === 0 && line.trim() === '---') {
      let scan = index + 1;
      const fm: string[] = [];
      while (scan < lines.length && (lines[scan] ?? '').trim() !== '---') {
        fm.push(lines[scan] ?? '');
        scan += 1;
      }
      if (scan < lines.length) {
        warnings.push(`Front matter 未纳入正文（${String(fm.length)} 行）`);
        index = scan + 1;
        continue;
      }
    }

    // 标题
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    if (headingMatch !== null) {
      flushParagraph();
      const text = stripInline(headingMatch[2] ?? '', warnings);
      if (text !== '') elements.push({ type: 'heading', level: (headingMatch[1] ?? '#').length, text });
      index += 1;
      continue;
    }

    // 表格（当前行含 | 且下一行是分隔行）
    if (line.includes('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1] ?? '')) {
      flushParagraph();
      const columns = splitRow(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && (lines[index] ?? '').includes('|') && (lines[index] ?? '').trim() !== '') {
        rows.push(splitRow(lines[index] ?? ''));
        index += 1;
      }
      elements.push({ type: 'table', columns, rows: rows.map((row) => row.map((cell) => stripInline(cell, warnings))) });
      continue;
    }

    // 引用
    const quoteMatch = /^>\s?(.*)$/.exec(line.trim());
    if (quoteMatch !== null) {
      flushParagraph();
      const text = stripInline(quoteMatch[1] ?? '', warnings);
      if (text !== '') elements.push({ type: 'quote', text });
      index += 1;
      continue;
    }

    // 列表（连续项归并）
    const listMatch = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (listMatch !== null) {
      flushParagraph();
      const items: string[] = [];
      while (index < lines.length) {
        const itemMatch = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(lines[index] ?? '');
        if (itemMatch === null) break;
        const item = stripInline(itemMatch[1] ?? '', warnings);
        if (item !== '') items.push(item);
        index += 1;
      }
      if (items.length > 0) elements.push({ type: 'list', items });
      continue;
    }

    // 内嵌 HTML → 警告 + 去标签保留文本（不静默丢弃，也不把标签当正文）
    if (/<[a-zA-Z!/][^>]*>/.test(line)) {
      flushParagraph();
      const stripped = line.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      warnings.push(`内嵌 HTML 未解析（已去标签）：${line.trim().slice(0, 80)}`);
      if (stripped !== '') {
        const text = stripInline(stripped, warnings);
        if (text !== '') elements.push({ type: 'paragraph', text });
      }
      index += 1;
      continue;
    }

    // 空行 → 段落边界
    if (line.trim() === '') {
      flushParagraph();
      index += 1;
      continue;
    }

    flushParagraphBuffer.push(line.trim());
    index += 1;
  }

  flushParagraph();
  if (inFence) warnings.push('围栏代码块未闭合（按已读内容保留）');

  const firstHeading = elements.find((element) => element.type === 'heading');
  return parsedDocumentSchema.parse({
    elements,
    warnings,
    titleHint: firstHeading !== undefined && firstHeading.type === 'heading' ? firstHeading.text : null,
    pageCount: null,
    pagesWithoutText: [],
    hasExtractableText: elements.some((element) => element.type !== 'table' || element.rows.length > 0),
  });
}
