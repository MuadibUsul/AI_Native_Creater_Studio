import { parsedEmailDocumentSchema, type ParsedEmailDocument } from '@ancs/contracts';

/**
 * EML（Newsletter 导出）解析（P10-01）：最小 MIME 解析。
 *
 * 支持：头部（Subject/From）、multipart（按 boundary 拆分，取第一个 text/html；否则 text/plain）、
 * Content-Transfer-Encoding: quoted-printable / base64 / 7bit/8bit、字符集（charset 声明；未知则 utf-8 尽力）。
 * 明确记录（**逐条警告**）：附件（文件名 + 类型，**不提取内容**）、多个候选正文部件（取第一个 text/html）、
 * 无法解码的部件（列出）、嵌套 multipart（仅一层，其余列出）。
 */

const decodeQuotedPrintable = (input: string, charset: string): string => {
  const normalized = input.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index] ?? '';
    if (char === '=' && index + 2 < normalized.length) {
      const hex = normalized.slice(index + 1, index + 3);
      const value = Number.parseInt(hex, 16);
      if (!Number.isNaN(value)) {
        bytes.push(value);
        index += 2;
        continue;
      }
    }
    bytes.push(char.charCodeAt(0));
  }
  try {
    return new TextDecoder(charset).decode(new Uint8Array(bytes));
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes));
  }
};

const decodePart = (body: string, encoding: string | null, charset: string): string => {
  const normalizedEncoding = (encoding ?? '7bit').toLowerCase();
  if (normalizedEncoding === 'base64') {
    try {
      return new TextDecoder(charset).decode(Uint8Array.from(Buffer.from(body.replace(/\s+/g, ''), 'base64')));
    } catch {
      return new TextDecoder('utf-8', { fatal: false }).decode(Uint8Array.from(Buffer.from(body.replace(/\s+/g, ''), 'base64')));
    }
  }
  if (normalizedEncoding === 'quoted-printable') return decodeQuotedPrintable(body, charset);
  return new TextDecoder('utf-8', { fatal: false }).decode(new TextEncoder().encode(body));
};

const charsetOf = (contentType: string): string => /charset="?([A-Za-z0-9._-]+)"?/i.exec(contentType)?.[1] ?? 'utf-8';
const encodingOf = (headers: string): string | null => /content-transfer-encoding:\s*([A-Za-z0-9-]+)/i.exec(headers)?.[1] ?? null;

/** 拆出头部与正文；返回原始头部文本与内容。 */
function splitMessage(raw: string): { headers: string; body: string; headerMap: Map<string, string> } {
  const separator = /\r?\n\r?\n/.exec(raw);
  const headers = separator === null ? raw : raw.slice(0, separator.index);
  const body = separator === null ? '' : raw.slice(separator.index + separator[0].length);
  // 头部折行（continuation lines 以空白开头）合并
  const unfolded = headers.replace(/\r?\n[ \t]+/g, ' ');
  const headerMap = new Map<string, string>();
  for (const line of unfolded.split(/\r?\n/)) {
    const match = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (match !== null) headerMap.set((match[1] ?? '').toLowerCase(), match[2] ?? '');
  }
  return { headers, body, headerMap };
}

const attachmentFilename = (partHeaders: Map<string, string>): string => {
  const disposition = partHeaders.get('content-disposition') ?? '';
  const encoded = /filename\*=([^;]+)/i.exec(disposition)?.[1];
  if (encoded !== undefined) {
    const cleaned = encoded.replace(/^[^']*'[^']*'/, '').trim();
    try {
      return decodeURIComponent(cleaned);
    } catch {
      return cleaned;
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(disposition)?.[1];
  return plain?.trim() ?? '（未命名附件）';
};

export function parseEmailBytes(bytes: Uint8Array): ParsedEmailDocument {
  const raw = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const { headers, body, headerMap } = splitMessage(raw);
  const warnings: string[] = [];
  const contentTypeHeader = headerMap.get('content-type') ?? 'text/plain; charset=utf-8';

  const result: ParsedEmailDocument = {
    html: null,
    text: null,
    subject: headerMap.get('subject')?.trim() ?? null,
    from: headerMap.get('from')?.trim() ?? null,
    attachments: [],
    warnings,
  };

  if (/multipart\//i.test(contentTypeHeader)) {
    const boundary = /boundary="?([^";]+)"?/i.exec(contentTypeHeader)?.[1];
    if (boundary === undefined) {
      warnings.push('EML 无 boundary（multipart 头缺失）——按纯文本处理');
      result.text = body;
      return parsedEmailDocumentSchema.parse(result);
    }
    const parts = body.split(`--${boundary}`).slice(1, -1);
    let htmlCandidate: string | null = null;
    let textCandidate: string | null = null;
    for (const part of parts) {
      const { body: partBody, headerMap: partHeaders } = splitMessage(part.replace(/^\r?\n/, ''));
      const partType = partHeaders.get('content-type') ?? 'text/plain';
      const disposition = partHeaders.get('content-disposition') ?? '';
      if (/attachment/i.test(disposition) || /name="/i.test(disposition)) {
        result.attachments.push({ filename: attachmentFilename(partHeaders), contentType: partType.split(';')[0]?.trim() ?? null });
        continue;
      }
      if (/multipart\//i.test(partType)) {
        warnings.push('EML 嵌套 multipart 未展开（仅一层）');
        continue;
      }
      const charset = charsetOf(partType);
      const encoding = partHeaders.get('content-transfer-encoding') ?? null;
      if (/text\/html/i.test(partType) && htmlCandidate === null) {
        htmlCandidate = decodePart(partBody, encoding, charset);
      } else if (/text\/plain/i.test(partType) && textCandidate === null) {
        textCandidate = decodePart(partBody, encoding, charset);
      } else {
        warnings.push(`EML 部件未纳入正文：${partType.split(';')[0] ?? partType}`);
      }
    }
    if (htmlCandidate !== null) {
      result.html = htmlCandidate;
      if (textCandidate !== null) warnings.push('EML 同时含 text/html 与 text/plain——取 text/html，纯文本忽略');
    } else {
      result.text = textCandidate;
    }
  } else if (/text\/html/i.test(contentTypeHeader)) {
    result.html = decodePart(body, encodingOf(headers), charsetOf(contentTypeHeader));
  } else {
    result.text = decodePart(body, encodingOf(headers), charsetOf(contentTypeHeader));
  }

  if (result.attachments.length > 0) {
    warnings.push(`EML 附件 ${String(result.attachments.length)} 个未提取（如需附件内容请作为资产上传）`);
  }
  return parsedEmailDocumentSchema.parse(result);
}
