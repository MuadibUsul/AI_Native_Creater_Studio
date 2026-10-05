import { z } from 'zod';

/**
 * 文档解析 seam（P10-01 / 规范 §4、§84—85、§62）。
 *
 * 定位（与 render-executor / motion-validator 同一范式）：
 * - 契约只定义**字节 → 结构化元素 + 明确警告**的接口与结果，不含任何解析实现；
 * - 实现位于 providers（`@ancs/providers-document-extract`：Markdown/DOCX/PDF/EML）；
 * - **不伪造提取成功**：扫描件 PDF（无文本层）→ `hasExtractableText=false`（域层拒绝）；
 *   缺页/嵌入对象/未知构造 → 明确 `warnings`（逐条记录，不静默丢弃）；
 * - Newsletter（HTML）：直接走域层既有 HTML 抽取；EML 由解析器返回 html/text 部件与附件清单。
 */

export const DOCUMENT_KINDS = ['MARKDOWN', 'PDF', 'DOCX', 'EMAIL'] as const;
export const documentKindSchema = z.enum(DOCUMENT_KINDS);
export type DocumentKind = z.infer<typeof documentKindSchema>;

/** 结构化元素（域层映射为 ContentBlock；表格保留 columns/rows） */
export const parsedDocumentElementSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('heading'), level: z.number().int().min(1).max(6), text: z.string().min(1), page: z.number().int().positive().optional() }),
  z.object({ type: z.literal('paragraph'), text: z.string().min(1), page: z.number().int().positive().optional() }),
  z.object({ type: z.literal('quote'), text: z.string().min(1) }),
  z.object({ type: z.literal('list'), items: z.array(z.string().min(1)).min(1) }),
  z.object({ type: z.literal('table'), columns: z.array(z.string()).min(1), rows: z.array(z.array(z.string())), page: z.number().int().positive().optional() }),
]);

export type ParsedDocumentElement = z.infer<typeof parsedDocumentElementSchema>;

export const parsedDocumentSchema = z.object({
  elements: z.array(parsedDocumentElementSchema),
  /** 明确警告（缺页/嵌入对象/未知构造/截断等；逐条可读） */
  warnings: z.array(z.string()),
  /** 标题提示（文档元数据/首个标题；null = 无——域层回退到文件名） */
  titleHint: z.string().max(300).nullable(),
  /** PDF：页数（非 PDF 为 null） */
  pageCount: z.number().int().positive().nullable(),
  /** PDF：无文本层的页（1 基）；全部无文本 = 扫描件 */
  pagesWithoutText: z.array(z.number().int().positive()),
  /** 是否存在可提取文本（PDF 扫描件 = false；域层据此拒绝，不伪造成功） */
  hasExtractableText: z.boolean(),
});

export type ParsedDocument = z.infer<typeof parsedDocumentSchema>;

/** EML/Newsletter 解析结果（正文部件 + 附件清单） */
export const parsedEmailDocumentSchema = z.object({
  html: z.string().nullable(),
  text: z.string().nullable(),
  subject: z.string().nullable(),
  from: z.string().nullable(),
  /** 附件（文件名 + 类型；**不提取内容**——明确列出，不静默丢弃） */
  attachments: z.array(z.object({ filename: z.string().min(1), contentType: z.string().nullable() })),
  warnings: z.array(z.string()),
});

export type ParsedEmailDocument = z.infer<typeof parsedEmailDocumentSchema>;

export const DOCUMENT_PARSE_ERROR_REASONS = {
  /** 文件损坏/结构非法（解析器无法继续） */
  CORRUPT_FILE: 'CORRUPT_FILE',
  /** 加密（带密码） */
  ENCRYPTED: 'ENCRYPTED',
  /** 结构不受支持（如 DOCX 非 zip / PDF 无 xref） */
  UNSUPPORTED_STRUCTURE: 'UNSUPPORTED_STRUCTURE',
} as const;

export type DocumentParseErrorReason = (typeof DOCUMENT_PARSE_ERROR_REASONS)[keyof typeof DOCUMENT_PARSE_ERROR_REASONS];

/** 解析失败（明确原因；域层转 ApiFailure，绝不吞掉后返回空文档） */
export class DocumentParseError extends Error {
  constructor(
    readonly reason: DocumentParseErrorReason,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'DocumentParseError';
  }
}

/** 文档解析器（providers 实现；域层注入） */
export interface DocumentParser {
  readonly kind: string;
  parseMarkdown(input: { bytes: Uint8Array }): Promise<ParsedDocument>;
  parseDocx(input: { bytes: Uint8Array }): Promise<ParsedDocument>;
  parsePdf(input: { bytes: Uint8Array }): Promise<ParsedDocument>;
  parseEmail(input: { bytes: Uint8Array }): Promise<ParsedEmailDocument>;
}

/** 文档导入的服务端上限（字节；域层强制，客户端声明不可信） */
export const DOCUMENT_IMPORT_MAX_BYTES = 25 * 1024 * 1024;
