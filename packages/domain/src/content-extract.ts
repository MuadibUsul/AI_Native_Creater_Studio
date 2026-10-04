import { createHash } from 'node:crypto';
import {
  ApiFailure,
  CONTENT_INPUT_ERROR_REASONS,
  ERROR_CODES,
  contentBlockSchema,
  type ContentBlock,
} from '@ancs/contracts';

/**
 * 输入归一化的确定性部分（P04-01）：SSRF 守卫、编码解码、HTML/文本抽取、稳定块 ID。
 *
 * 全部为**纯函数**（无 I/O、无 LLM），因此可独立测试且行为可预期（计划 §7 的确定性优先）。
 * 网络抓取由宿主注入的 ArticleFetcher 完成（domain 不直接访问网络）。
 */

const MAX_URL_LENGTH = 2048;

/** SSRF 防护：仅允许公网 http/https（逐跳校验；抓取器每次重定向都要调用）。 */
export function assertSafeUrl(rawUrl: string): URL {
  if (rawUrl.length > MAX_URL_LENGTH) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'URL 过长', 400, { reason: CONTENT_INPUT_ERROR_REASONS.INVALID_URL });
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'URL 形态非法（无法解析）', 400, {
      reason: CONTENT_INPUT_ERROR_REASONS.INVALID_URL,
      url: rawUrl,
    });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, '仅允许 http/https URL', 400, {
      reason: CONTENT_INPUT_ERROR_REASONS.INVALID_URL,
      protocol: url.protocol,
    });
  }
  if (url.hostname === '') {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'URL 缺少主机名', 400, { reason: CONTENT_INPUT_ERROR_REASONS.INVALID_URL });
  }
  const host = url.hostname.toLowerCase();
  const blockedHostnames = ['localhost', 'localhost.localdomain', 'metadata.google.internal'];
  if (blockedHostnames.includes(host) || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new ApiFailure(ERROR_CODES.FORBIDDEN, '安全限制：拒绝访问内网/本地主机', 403, {
      reason: CONTENT_INPUT_ERROR_REASONS.BLOCKED_TARGET,
      host,
    });
  }
  // 单标签主机名（无点、非 IP 字面量）→ 拒绝：内网服务名/元数据端点常用此形态（如 http://metadata/）
  const isIpLiteral = host.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  if (!host.includes('.') && !isIpLiteral) {
    throw new ApiFailure(ERROR_CODES.FORBIDDEN, '安全限制：拒绝单标签主机名（可能是内网服务名）', 403, {
      reason: CONTENT_INPUT_ERROR_REASONS.BLOCKED_TARGET,
      host,
    });
  }
  const port = url.port === '' ? (url.protocol === 'https:' ? '443' : '80') : url.port;
  const allowedPorts = ['80', '443', '8080', '8443'];
  if (!allowedPorts.includes(port)) {
    throw new ApiFailure(ERROR_CODES.FORBIDDEN, '安全限制：端口不在允许列表', 403, {
      reason: CONTENT_INPUT_ERROR_REASONS.BLOCKED_TARGET,
      port,
      allowedPorts,
    });
  }
  if (isBlockedAddress(host)) {
    throw new ApiFailure(ERROR_CODES.FORBIDDEN, '安全限制：拒绝访问内网/回环/元数据地址', 403, {
      reason: CONTENT_INPUT_ERROR_REASONS.BLOCKED_TARGET,
      host,
    });
  }
  return url;
}

/** IPv4/IPv6 私网、回环、链路本地与元数据地址判定（字面量地址；DNS 解析后的复检由抓取器负责）。 */
export function isBlockedAddress(host: string): boolean {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;

  // IPv4 字面量
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
  if (ipv4 !== null) {
    const octets = ipv4.slice(1, 5).map(Number);
    if (octets.some((octet) => octet > 255)) return true; // 非法形态一律拒绝
    const [a = 0, b = 0] = octets;
    if (a === 0 || a === 10 || a === 127) return true; // 0/8, 10/8, 127/8
    if (a === 169 && b === 254) return true; // 链路本地（含云元数据 169.254.169.254）
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    if (a >= 224) return true; // 组播/保留
    return false;
  }

  // IPv6 字面量
  const lower = bare.toLowerCase();
  if (lower.includes(':')) {
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd')) return true; // 链路本地/唯一本地
    if (lower.startsWith('ff')) return true; // 组播
    if (lower.startsWith('::ffff:')) return isBlockedAddress(lower.slice('::ffff:'.length)); // IPv4 映射
    return false;
  }
  return false;
}

const CHARSET_ALIASES: Readonly<Record<string, string>> = {
  utf8: 'utf-8',
  utf_8: 'utf-8',
  'utf-8': 'utf-8',
  'gb2312': 'gbk',
  'gb-2312': 'gbk',
  gb18030: 'gb18030',
  gbk: 'gbk',
  big5: 'big5',
  latin1: 'latin1',
  'iso-8859-1': 'latin1',
  'windows-1252': 'windows-1252',
  'shift_jis': 'shift_jis',
  'shift-jis': 'shift_jis',
};

export function normalizeCharset(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const key = raw.trim().toLowerCase().replace(/^["']|["']$/g, '');
  return CHARSET_ALIASES[key] ?? key;
}

/** 从 Content-Type 头与 HTML meta 提示推断 charset（头优先，其次 meta，最后 UTF-8）。 */
export function resolveCharset(contentType: string | null, htmlHeadSample: string): { charset: string; source: 'header' | 'meta' | 'default' } {
  const headerMatch = contentType === null ? null : /charset=\s*([A-Za-z0-9_-]+)/i.exec(contentType);
  const header = normalizeCharset(headerMatch?.[1] ?? null);
  if (header !== null) return { charset: header, source: 'header' };

  const metaCharset = /<meta[^>]+charset=["']?([A-Za-z0-9_-]+)/i.exec(htmlHeadSample);
  const metaHttpEquiv = /<meta[^>]+http-equiv=["']content-type["'][^>]+content=["'][^"']*charset=([A-Za-z0-9_-]+)/i.exec(htmlHeadSample);
  const meta = normalizeCharset(metaCharset?.[1] ?? metaHttpEquiv?.[1] ?? null);
  if (meta !== null) return { charset: meta, source: 'meta' };
  return { charset: 'utf-8', source: 'default' };
}

/** 解码字节流；未知/不可解码 charset → 明确失败（ENCODING_UNSUPPORTED）。 */
export function decodeContentBytes(bytes: Uint8Array, contentType: string | null): { text: string; charset: string; charsetSource: 'header' | 'meta' | 'default' } {
  const head = Buffer.from(bytes.subarray(0, 2048)).toString('latin1'); // meta 探测的字节视图
  const { charset, source } = resolveCharset(contentType, head);

  // BOM 优先（UTF-8/UTF-16）
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), charset: 'utf-8', charsetSource: 'header' };
  }

  try {
    const decoder = new TextDecoder(charset, { fatal: false });
    const text = decoder.decode(bytes);
    // 替换字符占比过高 = 解码很可能失败（例如用 UTF-8 解 GBK）
    const replacementCount = (text.match(/\uFFFD/g) ?? []).length;
    if (replacementCount > 0 && replacementCount / Math.max(text.length, 1) > 0.001) {
      throw new Error('decoded with too many replacement characters');
    }
    return { text, charset, charsetSource: source };
  } catch (error) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, '编码无法解析（未知或与内容不符的 charset）', 400, {
      reason: CONTENT_INPUT_ERROR_REASONS.ENCODING_UNSUPPORTED,
      charset,
      charsetSource: source,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

const HTML_ENTITY_MAP: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
};

export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const code = entity.startsWith('#x') || entity.startsWith('#X') ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return HTML_ENTITY_MAP[entity.toLowerCase()] ?? match;
  });
}

const stripTags = (html: string): string => decodeHtmlEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** 稳定块 ID：同一 (type, text) 重复出现时追加出现序号（重抽取/编辑后可稳定引用）。 */
export function stableBlockId(type: string, text: string, occurrence = 0): string {
  const digest = createHash('sha1').update(`${type}\u0000${text}`).digest('hex').slice(0, 16);
  return occurrence === 0 ? `blk_${digest}` : `blk_${digest}_${String(occurrence)}`;
}

function makeBlock(type: ContentBlock['type'], payload: Partial<ContentBlock> & { text?: string }): ContentBlock {
  return contentBlockSchema.parse({ id: stableBlockId(type, payload.text ?? JSON.stringify(payload.table ?? payload.items ?? '')), type, ...payload });
}

/** HTML → 块序列（标题/段落/引用/列表/代码→段落/表格/图片；忽略 script/style/nav/footer 噪声）。 */
export function extractBlocksFromHtml(html: string): ContentBlock[] {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const blocks: ContentBlock[] = [];
  const seen = new Map<string, number>();
  const push = (block: ContentBlock): void => {
    const count = seen.get(block.id) ?? 0;
    seen.set(block.id, count + 1);
    if (count > 0) {
      blocks.push({ ...block, id: `${block.id}_${String(count)}` });
    } else {
      blocks.push(block);
    }
  };

  // 表格与图片先抽出（避免被段落规则二次消费）
  const tableRegex = /<table[\s\S]*?<\/table>/gi;
  const imageRegex = /<img\b[^>]*>/gi;
  const tablesFound: { raw: string; block: ContentBlock }[] = [];
  let tableMatch: RegExpExecArray | null;
  while ((tableMatch = tableRegex.exec(cleaned)) !== null) {
    const rows: string[][] = [];
    const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch: RegExpExecArray | null;
    let headerRow: string[] | null = null;
    while ((rowMatch = rowRegex.exec(tableMatch[0])) !== null) {
      const cellRegex = /<(th|td)\b[^>]*>([\s\S]*?)<\/\1>/gi;
      const cells: string[] = [];
      let cellMatch: RegExpExecArray | null;
      while ((cellMatch = cellRegex.exec(rowMatch[1] ?? '')) !== null) {
        cells.push(stripTags(cellMatch[2] ?? ''));
      }
      if (cells.length === 0) continue;
      if (headerRow === null && /<th\b/i.test(rowMatch[1] ?? '')) {
        headerRow = cells;
      } else {
        rows.push(cells);
      }
    }
    const columns = headerRow ?? rows.shift() ?? ['value'];
    const block = makeBlock('table', { table: { columns, rows } });
    tablesFound.push({ raw: tableMatch[0], block });
  }

  // 图片
  const imagesFound: { raw: string; block: ContentBlock }[] = [];
  let imageMatch: RegExpExecArray | null;
  while ((imageMatch = imageRegex.exec(cleaned)) !== null) {
    const alt = /alt=["']([^"']*)["']/i.exec(imageMatch[0])?.[1] ?? '';
    const src = /src=["']([^"']*)["']/i.exec(imageMatch[0])?.[1] ?? '';
    imagesFound.push({ raw: imageMatch[0], block: makeBlock('image', { text: decodeHtmlEntities(alt.trim()), note: src.trim() }) });
  }

  // 正文结构：标题/段落/引用/列表/代码块（其余噪声标签剥除后按顺序抽取）
  const bodyHtml = cleaned
    .replace(tableRegex, ' ')
    .replace(imageRegex, ' ')
    .replace(/<(nav|header|footer|aside|form|iframe|svg)[\s\S]*?<\/\1>/gi, ' ');
  const structuralRegex = /<(h[1-6]|p|blockquote|ul|ol|pre|figure)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = structuralRegex.exec(bodyHtml)) !== null) {
    const tag = (match[1] ?? '').toLowerCase();
    const inner = match[2] ?? '';
    if (tag.startsWith('h')) {
      const text = stripTags(inner);
      if (text !== '') push(makeBlock('heading', { text, level: Number(tag.slice(1)) }));
      continue;
    }
    if (tag === 'blockquote') {
      const text = stripTags(inner);
      if (text !== '') push(makeBlock('quote', { text }));
      continue;
    }
    if (tag === 'ul' || tag === 'ol') {
      const items: string[] = [];
      const itemRegex = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
      let itemMatch: RegExpExecArray | null;
      while ((itemMatch = itemRegex.exec(inner)) !== null) {
        const text = stripTags(itemMatch[1] ?? '');
        if (text !== '') items.push(text);
      }
      if (items.length > 0) push(makeBlock('list', { items, text: items.join(' ') }));
      continue;
    }
    // p / pre / figure → 段落
    const text = stripTags(inner);
    if (text !== '') push(makeBlock('paragraph', { text }));
  }

  // 合并顺序：正文结构块 → 表格 → 图片（表格/图片按原文出现的相对位置插回近似位置：追加在正文之后，
  // 由 note 记录原始位置信息；V1 的块顺序满足"可解释"要求，精确 DOM 顺序随后续解析器升级）
  for (const table of tablesFound) push(table.block);
  for (const image of imagesFound) push(image.block);
  return blocks;
}

/** 纯文本/手写脚本 → 块序列（Markdown 风格轻量解析；MANUAL_SCRIPT 每行一段）。 */
export function extractBlocksFromText(text: string, mode: 'PASTED_TEXT' | 'MANUAL_SCRIPT'): ContentBlock[] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const blocks: ContentBlock[] = [];
  const seen = new Map<string, number>();
  const push = (block: ContentBlock): void => {
    const count = seen.get(block.id) ?? 0;
    seen.set(block.id, count + 1);
    blocks.push(count > 0 ? { ...block, id: `${block.id}_${String(count)}` } : block);
  };

  if (mode === 'MANUAL_SCRIPT') {
    for (const line of normalized.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      push(makeBlock('paragraph', { text: trimmed }));
    }
    return blocks;
  }

  const lines = normalized.split('\n');
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();
    if (trimmed === '') {
      index += 1;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading !== null) {
      push(makeBlock('heading', { text: heading[2] ?? '', level: (heading[1] ?? '#').length }));
      index += 1;
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(trimmed);
    if (quote !== null) {
      push(makeBlock('quote', { text: quote[1] ?? '' }));
      index += 1;
      continue;
    }
    const listItem = /^([-*+]|\d+\.)\s+(.*)$/.exec(trimmed);
    if (listItem !== null) {
      const items: string[] = [];
      while (index < lines.length) {
        const candidate = /^([-*+]|\d+\.)\s+(.*)$/.exec((lines[index] ?? '').trim());
        if (candidate === null) break;
        items.push(candidate[2] ?? '');
        index += 1;
      }
      push(makeBlock('list', { items, text: items.join(' ') }));
      continue;
    }
    // 表格（连续以 | 分隔的行）
    if (/^\|.*\|$/.test(trimmed)) {
      const rows: string[][] = [];
      while (index < lines.length && /^\|.*\|$/.test((lines[index] ?? '').trim())) {
        const cells = (lines[index] ?? '')
          .trim()
          .slice(1, -1)
          .split('|')
          .map((cell) => cell.trim());
        if (!cells.every((cell) => /^:?-{2,}:?$/.test(cell))) rows.push(cells);
        index += 1;
      }
      if (rows.length > 0) {
        const columns = rows.shift() ?? ['value'];
        push(makeBlock('table', { table: { columns, rows } }));
        continue;
      }
    }
    // 段落（连续非空行合并）
    const paragraph: string[] = [];
    while (index < lines.length) {
      const candidate = (lines[index] ?? '').trim();
      if (
        candidate === '' ||
        /^#{1,6}\s+/.test(candidate) ||
        /^>\s?/.test(candidate) ||
        /^([-*+]|\d+\.)\s+/.test(candidate) ||
        /^\|.*\|$/.test(candidate)
      ) {
        break;
      }
      paragraph.push(candidate);
      index += 1;
    }
    if (paragraph.length > 0) push(makeBlock('paragraph', { text: paragraph.join(' ') }));
  }
  return blocks;
}

/** 语言推断（中文/日文/韩文/其他拉丁）：用于 ContentDocument.language 的默认值。 */
export function detectLanguage(text: string): string {
  const sample = text.slice(0, 4000);
  const cjk = (sample.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const kana = (sample.match(/[\u3040-\u30ff]/g) ?? []).length;
  const hangul = (sample.match(/[\uac00-\ud7af]/g) ?? []).length;
  const latin = (sample.match(/[A-Za-z]/g) ?? []).length;
  const total = Math.max(sample.length, 1);
  if (kana / total > 0.05) return 'ja';
  if (hangul / total > 0.05) return 'ko';
  if (cjk / total > 0.1) return 'zh';
  if (latin / total > 0.3) return 'en';
  return 'unknown';
}
