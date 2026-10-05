import type { DocumentParser, ParsedDocument, ParsedEmailDocument, ParsedDocument as ParsedDocumentType } from '@ancs/contracts';
import { parseMarkdownBytes } from './markdown.js';
import { parseDocxBytes } from './docx.js';
import { parsePdfBytes } from './pdf.js';
import { parseEmailBytes } from './eml.js';

/**
 * 本地文档解析器（P10-01；实现 contracts 的 `DocumentParser` seam）。
 *
 * - Markdown：GFM 子集（表格/标题/引用/列表/围栏代码；内嵌 HTML/图片逐条警告）；
 * - DOCX：ZIP + document.xml（表格保留 columns/rows；嵌入图片/对象/脚注逐条警告；加密/损坏明确失败）；
 * - PDF：pdfjs-dist 文本层（**扫描件不伪造成功**：hasExtractableText=false → 域层拒绝；缺页逐页记录）；
 * - EML（Newsletter 导出）：multipart 取 text/html，附件列出不提取。
 */

export class LocalDocumentParser implements DocumentParser {
  readonly kind = 'local-document-extract-v1';

  async parseMarkdown(input: { bytes: Uint8Array }): Promise<ParsedDocument> {
    return parseMarkdownBytes(input.bytes);
  }

  async parseDocx(input: { bytes: Uint8Array }): Promise<ParsedDocumentType> {
    return parseDocxBytes(input.bytes);
  }

  async parsePdf(input: { bytes: Uint8Array }): Promise<ParsedDocumentType> {
    return parsePdfBytes(input.bytes);
  }

  async parseEmail(input: { bytes: Uint8Array }): Promise<ParsedEmailDocument> {
    return parseEmailBytes(input.bytes);
  }
}

export { parseMarkdownBytes } from './markdown.js';
export { parseDocxBytes } from './docx.js';
export { parsePdfBytes } from './pdf.js';
export { parseEmailBytes } from './eml.js';
export { readZipEntries, readZipEntry, writeStoredZip, ZipReadError } from './zip.js';
