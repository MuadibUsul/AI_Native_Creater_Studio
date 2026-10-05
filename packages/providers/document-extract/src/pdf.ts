import { DocumentParseError, DOCUMENT_PARSE_ERROR_REASONS, parsedDocumentSchema, type ParsedDocument, type ParsedDocumentElement } from '@ancs/contracts';

/**
 * PDF 解析（P10-01）：pdfjs-dist（legacy 构建，Node 无 worker）文本层提取。
 *
 * - **扫描件处理（不伪造提取成功）**：逐页取文本；无文本页记入 `pagesWithoutText`；
 *   **全部页无文本 → `hasExtractableText=false`**（域层拒绝并给出 SCANNED_PDF_NO_TEXT）；
 * - 缺页/空页：逐页记录警告（页码 1 基）；
 * - 加密 PDF：pdfjs 触发 PasswordException → ENCRYPTED；
 * - 损坏文件：解析异常 → CORRUPT_FILE；
 * - 页面含图片：按页记录警告（图片未提取——文本层不含图片内容）；
 * - 表格：PDF 无可靠表格结构，按文本行保留（段落），并入警告说明。
 */

interface PdfTextItem {
  str?: string;
  hasEOL?: boolean;
}

interface PdfPageLike {
  getTextContent(options: { normalizeWhitespace: boolean; disableCombineTextItems: boolean }): Promise<{ items: PdfTextItem[] }>;
  getOperatorList(): Promise<{ fnArray: number[] }>;
  cleanup?: () => void;
}

export async function parsePdfBytes(bytes: Uint8Array): Promise<ParsedDocument> {
  // 动态 import：pdfjs 体积大，仅在真正解析 PDF 时加载
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as {
    getDocument: (input: { data: Uint8Array; isEvalSupported?: boolean; useSystemFonts?: boolean; disableFontFace?: boolean }) => { promise: Promise<PdfDocumentLike> };
    OPS: Record<string, number>;
  };
  const imageOps = new Set([pdfjs.OPS['paintImageXObject'], pdfjs.OPS['paintJpegXObject'], pdfjs.OPS['paintInlineImageXObject'], pdfjs.OPS['paintImageMaskXObject']].filter((value) => typeof value === 'number'));

  let document: PdfDocumentLike;
  try {
    const task = pdfjs.getDocument({
      data: bytes,
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
    });
    document = await task.promise;
  } catch (error) {
    const name = (error as { name?: string }).name ?? '';
    if (name === 'PasswordException') {
      throw new DocumentParseError(DOCUMENT_PARSE_ERROR_REASONS.ENCRYPTED, 'PDF 已加密（需要密码）');
    }
    throw new DocumentParseError(DOCUMENT_PARSE_ERROR_REASONS.CORRUPT_FILE, `PDF 解析失败：${(error as Error).message.slice(0, 200)}`);
  }

  const warnings: string[] = [];
  const elements: ParsedDocumentElement[] = [];
  const pagesWithoutText: number[] = [];
  const pageCount = document.numPages;
  let titleHint: string | null = null;

  try {
    const metadata = await document.getMetadata().catch(() => null);
    const infoTitle = (metadata?.info as { Title?: unknown } | undefined)?.Title;
    if (typeof infoTitle === 'string' && infoTitle.trim() !== '') titleHint = infoTitle.trim().slice(0, 300);
  } catch {
    // 元数据缺失不阻断解析
  }

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    let page: PdfPageLike;
    try {
      page = await document.getPage(pageNumber);
    } catch (error) {
      warnings.push(`第 ${String(pageNumber)} 页无法读取（缺页/损坏）：${(error as Error).message.slice(0, 120)}`);
      pagesWithoutText.push(pageNumber);
      continue;
    }
    const content = await page.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false });
    // 图片检测（尽力而为；失败不阻断——检测失败保持无图，但不报错）
    let hasImages = false;
    try {
      const operators = await page.getOperatorList();
      hasImages = operators.fnArray.some((fn) => imageOps.has(fn));
    } catch {
      // 保持 hasImages=false
    }

    let pageText = '';
    for (const item of content.items) {
      if (typeof item.str === 'string') pageText += item.str;
      if (item.hasEOL === true) pageText += '\n';
    }
    const paragraphs = pageText
      .split(/\n+/)
      .map((line) => line.trim())
      .filter((line) => line !== '');

    if (paragraphs.length === 0) {
      pagesWithoutText.push(pageNumber);
      warnings.push(`第 ${String(pageNumber)} 页无可提取文本（空白页或扫描页）`);
    } else {
      for (const paragraph of paragraphs) {
        elements.push({ type: 'paragraph', text: paragraph, page: pageNumber });
      }
    }
    if (hasImages) warnings.push(`第 ${String(pageNumber)} 页含图片（未提取——如需图片请作为资产上传）`);
    page.cleanup?.();
  }

  await document.destroy();

  if (elements.length === 0) {
    // 全部页无文本 = 扫描件：明确失败由域层给出（这里如实标记）
    return parsedDocumentSchema.parse({
      elements: [],
      warnings: [...warnings, 'PDF 无文本层（疑似扫描件/图片型 PDF）——需 OCR（后续/人工）'],
      titleHint,
      pageCount,
      pagesWithoutText,
      hasExtractableText: false,
    });
  }

  warnings.push('PDF 表格以文本行保留（结构不可靠，不做表格重建）');
  return parsedDocumentSchema.parse({
    elements,
    warnings,
    titleHint,
    pageCount,
    pagesWithoutText,
    hasExtractableText: true,
  });
}

interface PdfDocumentLike {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageLike>;
  getMetadata(): Promise<{ info?: unknown }>;
  destroy(): Promise<void>;
}
