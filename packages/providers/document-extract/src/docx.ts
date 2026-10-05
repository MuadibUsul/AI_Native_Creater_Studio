import { DocumentParseError, DOCUMENT_PARSE_ERROR_REASONS, parsedDocumentSchema, type ParsedDocument, type ParsedDocumentElement } from '@ancs/contracts';
import { readZipEntries, ZipReadError } from './zip.js';

/**
 * DOCX 解析（P10-01）：ZIP → `word/document.xml` 结构遍历。
 *
 * 保留：标题（Headings/Title 样式）、段落、**表格**（w:tbl → columns/rows）、列表（作为段落前缀保留层级）、
 * 行内链接文本；文档标题取 `docProps/core.xml` 的 dc:title。
 * 明确记录（**逐条警告，不静默**）：嵌入图片（w:drawing/w:pict）、嵌入对象（w:object/w:oleObject）、
 * 脚注/尾注/批注引用（未纳入正文）、页眉页脚（不在 document.xml）。
 * 加密 DOCX（OLE 复合文件）→ ENCRYPTED；非 ZIP/损坏 → CORRUPT/UNSUPPORTED_STRUCTURE（不伪造成功）。
 */

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0];

const decodeXmlEntities = (text: string): string =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');

/** 从段落 XML 提取可见文本（w:t 拼接；w:tab → \t；w:br → \n）。 */
function paragraphText(xml: string): string {
  let result = '';
  const tokenRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>/g;
  let match = tokenRe.exec(xml);
  while (match !== null) {
    if (match[0] === '<w:tab/>' || match[0] === '<w:tab />') result += '\t';
    else if (match[0] === '<w:br/>' || match[0] === '<w:br />') result += '\n';
    else result += decodeXmlEntities(match[1] ?? '');
    match = tokenRe.exec(xml);
  }
  return result;
}

const headingLevelOf = (xml: string): number | null => {
  const style = /<w:pStyle\s+w:val="([^"]+)"/.exec(xml)?.[1] ?? '';
  if (style === 'Title') return 1;
  const heading = /^Heading(\d)$/.exec(style);
  if (heading !== null) return Math.min(6, Math.max(1, Number(heading[1])));
  const outline = /<w:outlineLvl\s+w:val="(\d)"/.exec(xml);
  if (outline !== null) return Math.min(6, Math.max(1, Number(outline[1]) + 1));
  return null;
};

const isListParagraph = (xml: string): boolean => /<w:numPr>/.test(xml);

/** 遍历文档体：按出现顺序切出段落与表格块。 */
function walkDocumentXml(documentXml: string, warnings: string[]): ParsedDocumentElement[] {
  const body = /<w:body>([\s\S]*)<\/w:body>/.exec(documentXml)?.[1] ?? documentXml;
  const elements: ParsedDocumentElement[] = [];
  const blockRe = /<w:tbl(?:\s[^>]*)?>[\s\S]*?<\/w:tbl>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;

  let match = blockRe.exec(body);
  while (match !== null) {
    const block = match[0];
    if (block.startsWith('<w:tbl')) {
      const rows: string[][] = [];
      const rowRe = /<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g;
      let rowMatch = rowRe.exec(block);
      while (rowMatch !== null) {
        const cells: string[] = [];
        const cellRe = /<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g;
        let cellMatch = cellRe.exec(rowMatch[0]);
        while (cellMatch !== null) {
          const paragraphRe = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
          const texts: string[] = [];
          let paragraphMatch = paragraphRe.exec(cellMatch[0]);
          while (paragraphMatch !== null) {
            const text = paragraphText(paragraphMatch[0]).trim();
            if (text !== '') texts.push(text);
            paragraphMatch = paragraphRe.exec(cellMatch[0]);
          }
          cells.push(texts.join('\n'));
          cellMatch = cellRe.exec(rowMatch[0]);
        }
        rows.push(cells);
        rowMatch = rowRe.exec(block);
      }
      if (rows.length > 0) {
        const columnCount = Math.max(...rows.map((row) => row.length));
        const pad = (row: string[]): string[] => {
          const padded = [...row];
          while (padded.length < columnCount) padded.push('');
          return padded;
        };
        const headerRow = rows[0] ?? [];
        // 表头判别（不伪造）：非空且短 → 视为表头；否则首行是数据 → 占位列名
        const firstRowLooksLikeHeader = headerRow.length === columnCount && headerRow.every((cell) => cell !== '' && cell.length <= 40);
        if (firstRowLooksLikeHeader) {
          const columns = pad(headerRow).map((cell, index) => (cell !== '' ? cell : `列${String(index + 1)}`));
          elements.push({ type: 'table', columns, rows: rows.slice(1).map(pad) });
        } else {
          const columns = Array.from({ length: columnCount }, (_value, index) => `列${String(index + 1)}`);
          elements.push({ type: 'table', columns, rows: rows.map(pad) });
          warnings.push('表格首行疑似数据行（无表头）——列名以占位生成');
        }
      }
    } else {
      if (/<w:drawing|<w:pict/.test(block)) warnings.push('DOCX 嵌入图片未提取（作为资产上传）');
      if (/<w:object|<w:oleObject/.test(block)) warnings.push('DOCX 嵌入对象（OLE）未提取');
      if (/<w:footnoteReference|<w:endnoteReference/.test(block)) warnings.push('DOCX 脚注/尾注引用未纳入正文');
      if (/<w:commentReference/.test(block)) warnings.push('DOCX 批注引用未纳入正文');
      if (/<w:hyperlink/.test(block)) warnings.push('DOCX 超链接保留文本（不解析外链目标）');

      const text = paragraphText(block).trim();
      if (text !== '') {
        const level = headingLevelOf(block);
        if (level !== null) elements.push({ type: 'heading', level, text });
        else if (isListParagraph(block)) elements.push({ type: 'list', items: [text] });
        else elements.push({ type: 'paragraph', text });
      }
    }
    match = blockRe.exec(body);
  }
  return elements;
}

/** 合并相邻的单项 list（DOCX 列表项逐段出现）。 */
function coalesceLists(elements: ParsedDocumentElement[]): ParsedDocumentElement[] {
  const result: ParsedDocumentElement[] = [];
  for (const element of elements) {
    const last = result[result.length - 1];
    if (element.type === 'list' && last !== undefined && last.type === 'list') {
      last.items.push(...element.items);
    } else {
      result.push(element);
    }
  }
  return result;
}

export function parseDocxBytes(bytes: Uint8Array): ParsedDocument {
  if (bytes.length >= 4 && OLE_MAGIC.every((byte, index) => bytes[index] === byte)) {
    throw new DocumentParseError(DOCUMENT_PARSE_ERROR_REASONS.ENCRYPTED, 'DOCX 为加密/旧版复合文件（无法提取文本）');
  }
  if (!(bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b)) {
    throw new DocumentParseError(DOCUMENT_PARSE_ERROR_REASONS.UNSUPPORTED_STRUCTURE, 'DOCX 不是 ZIP 容器（文件损坏或格式不符）');
  }

  let entries;
  try {
    entries = readZipEntries(bytes);
  } catch (error) {
    if (error instanceof ZipReadError) {
      throw new DocumentParseError(DOCUMENT_PARSE_ERROR_REASONS.CORRUPT_FILE, `DOCX 容器损坏：${error.message}`);
    }
    throw error;
  }
  const documentEntry = entries.find((entry) => entry.name === 'word/document.xml');
  if (documentEntry === undefined) {
    throw new DocumentParseError(DOCUMENT_PARSE_ERROR_REASONS.UNSUPPORTED_STRUCTURE, 'DOCX 缺少 word/document.xml');
  }

  const warnings: string[] = [];
  const documentXml = new TextDecoder('utf-8', { fatal: false }).decode(documentEntry.bytes);
  const elements = coalesceLists(walkDocumentXml(documentXml, warnings));

  const coreEntry = entries.find((entry) => entry.name === 'docProps/core.xml');
  let titleHint: string | null = null;
  if (coreEntry !== undefined) {
    const core = new TextDecoder('utf-8', { fatal: false }).decode(coreEntry.bytes);
    const title = /<dc:title(?:\s[^>]*)?>([\s\S]*?)<\/dc:title>/.exec(core)?.[1];
    if (title !== undefined && title.trim() !== '') titleHint = decodeXmlEntities(title.trim()).slice(0, 300);
  }
  if (titleHint === null) {
    const firstHeading = elements.find((element) => element.type === 'heading');
    if (firstHeading !== undefined && firstHeading.type === 'heading') titleHint = firstHeading.text;
  }

  const hasExtractableText = elements.some((element) => (element.type === 'table' ? element.rows.length > 0 : true));
  return parsedDocumentSchema.parse({
    elements,
    warnings,
    titleHint,
    pageCount: null,
    pagesWithoutText: [],
    hasExtractableText,
  });
}
