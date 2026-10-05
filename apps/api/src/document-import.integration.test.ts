import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, plans, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, workspaces, type DbHandle } from '@ancs/db';
import { ensureDefaultPlans, recordAudit, type DomainDeps } from '@ancs/domain';
import { HeuristicMalwareScanner } from '@ancs/providers-malware-heuristic';
import { LocalDocumentParser, writeStoredZip } from '@ancs/providers-document-extract';
import { LocalObjectStorage } from '@ancs/providers-storage-local';
import { buildServer } from './server.js';
import { createStorageDeps } from './plugins/storage.js';

/**
 * P10-01 验收（真实 DB + HTTP/SDK + 真实解析器）：
 * - **Markdown**（GFM 表格保留）；**DOCX**（表格保留 + 嵌入图片/对象逐条警告）；
 * - **PDF**（文本层提取；缺页逐页记录）；**扫描件/无文本层 PDF → 422 SCANNED_PDF_NO_TEXT（不伪造成功）**；
 *   损坏 PDF → 422 DOCUMENT_PARSE_FAILED（明确原因）；
 * - **Newsletter**：`.eml`（multipart → text/html；附件列明不提取）与 `.html` 导出件；
 * - 安全姿态一致：文档字节**写入前扫描**（EICAR → 422 未解析）；不支持的扩展名 → 415。
 */

let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let rootDir: string;
let storage: LocalObjectStorage;
const PASSWORD = 'password-1234';

const deps = (): DomainDeps => ({ db: handle.db });

/* ---------- 夹具构造（真实最小 PDF / DOCX；不引第三方生成器） ---------- */

/** 最小 PDF：逐页文字（无压缩内容流 + 正确 xref）；pages[i] = 该页文本行。 */
function buildPdf(pages: string[][]): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let cursor = 0;
  const push = (text: string): void => {
    const bytes = encoder.encode(text);
    chunks.push(bytes);
    cursor += bytes.length;
  };
  const startObject = (id: number): void => {
    offsets[id] = cursor;
    push(`${String(id)} 0 obj\n`);
  };

  push('%PDF-1.4\n');
  const pageIds: number[] = pages.map((_page, index) => 3 + index * 2);
  startObject(1);
  push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  startObject(2);
  push(`<< /Type /Pages /Kids [${pageIds.map((id) => `${String(id)} 0 R`).join(' ')}] /Count ${String(pages.length)} >>\nendobj\n`);
  pages.forEach((lines, index) => {
    const pageId = pageIds[index] ?? 0;
    const contentId = pageId + 1;
    startObject(pageId);
    push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${String(contentId)} 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>\nendobj\n`);
    const content = lines.length === 0 ? '' : `BT /F1 12 Tf 72 720 Td 14 TL ${lines.map((line) => `(${line.replace(/[()\\]/g, ' ')}) Tj T*`).join(' ')} ET`;
    startObject(contentId);
    push(`<< /Length ${String(content.length)} >>\nstream\n${content}\nendstream\nendobj\n`);
  });

  const xrefOffset = cursor;
  const maxId = 3 + pages.length * 2;
  push(`xref\n0 ${String(maxId)}\n0000000000 65535 f \n`);
  for (let id = 1; id < maxId; id += 1) {
    push(`${String(offsets[id] ?? 0).padStart(10, '0')} 00000 n \n`);
  }
  push(`trailer\n<< /Size ${String(maxId)} /Root 1 0 R >>\nstartxref\n${String(xrefOffset)}\n%%EOF\n`);

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(total);
  let position = 0;
  for (const chunk of chunks) {
    result.set(chunk, position);
    position += chunk.length;
  }
  return result;
}

/** 最小 DOCX：标题 + 段落 + 表格 + 嵌入式图片标记。 */
function buildDocx(): Uint8Array {
  const documentXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    '<w:body>',
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>季度增长报告</w:t></w:r></w:p>',
    '<w:p><w:r><w:t>本季度收入增长 32%，主要来自订阅业务。</w:t></w:r></w:p>',
    '<w:p><w:r><w:drawing/></w:r></w:p>',
    '<w:tbl>',
    '<w:tr><w:tc><w:p><w:r><w:t>季度</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>收入（万元）</w:t></w:r></w:p></w:tc></w:tr>',
    '<w:tr><w:tc><w:p><w:r><w:t>Q1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>120</w:t></w:r></w:p></w:tc></w:tr>',
    '<w:tr><w:tc><w:p><w:r><w:t>Q2</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>158</w:t></w:r></w:p></w:tc></w:tr>',
    '</w:tbl>',
    '</w:body>',
    '</w:document>',
  ].join('');
  const coreXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="x" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>季度报告</dc:title></cp:coreProperties>';
  return writeStoredZip([
    { name: '[Content_Types].xml', content: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    { name: 'word/document.xml', content: documentXml },
    { name: 'docProps/core.xml', content: coreXml },
  ]);
}

const MARKDOWN_FIXTURE = [
  '# 平台月报',
  '',
  '本月要点如下（详见表格）。',
  '',
  '## 指标',
  '',
  '| 指标 | 本月 | 上月 |',
  '| --- | --- | --- |',
  '| 活跃创作者 | 1,024 | 968 |',
  '| 完成成片 | 312 | 260 |',
  '',
  '- 第一条要点',
  '- 第二条要点',
  '',
  '> 数据来自平台内部统计（见 [明细](https://example.com/detail)）。',
  '',
  '![趋势图](https://example.com/chart.png)',
].join('\n');

const EML_FIXTURE = [
  'From: news@example.com',
  'To: reader@example.com',
  'Subject: 每周精选 #42',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="BOUNDARY-42"',
  '',
  '--BOUNDARY-42',
  'Content-Type: text/plain; charset=utf-8',
  '',
  '纯文本回退版本。',
  '--BOUNDARY-42',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<html><body><h1>每周精选 #42</h1><p>本期主题：内容流水线自动化。</p><table><tr><td>栏目</td><td>期数</td></tr><tr><td>科技</td><td>12</td></tr></table></body></html>',
  '--BOUNDARY-42',
  'Content-Type: application/pdf; name="附件.pdf"',
  'Content-Disposition: attachment; filename="附件.pdf"',
  '',
  '%PDF-1.4 fake attachment',
  '--BOUNDARY-42--',
].join('\n');

const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}', '$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!', '$H+H*'].join('');

beforeAll(async () => {
  const url = resolveTestDatabaseUrl();
  handle = createDb(url);
  try {
    await handle.pool.query('select 1');
  } catch (error) {
    await handle.close();
    throw new Error(`无法连接测试数据库 ${redactDatabaseUrl(url)}。`, { cause: error });
  }
  await runMigrations(handle);
  rootDir = await mkdtemp(join(tmpdir(), 'ancs-doc-import-'));
  storage = new LocalObjectStorage({ rootDir, publicBaseUrl: 'http://127.0.0.1:0', signingSecret: 'doc-import-storage-secret-0123456789' }); // secrets:check-ignore：测试专用假密钥
  auth = createAuth({ db: handle.db, secret: 'doc-import-secret-0123456789', baseUrl: 'http://localhost:3001' }); // secrets:check-ignore：测试专用假密钥
  app = await buildServer({
    auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
    storage: createStorageDeps(storage, {
      scanner: new HeuristicMalwareScanner(),
      auditSink: async (entry) => {
        await recordAudit({ db: handle.db }, {
          actorKind: 'SYSTEM',
          action: entry.action,
          targetType: 'content_import',
          targetId: entry.key,
          workspaceId: entry.workspaceId,
          details: { filename: entry.filename, findings: entry.findings, scanner: entry.scanner },
        });
      },
    }),
    content: { documentParser: new LocalDocumentParser() },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
  storage.publicBaseUrl = baseUrl;
});

afterAll(async () => {
  await app.close();
  await handle.close();
  await rm(rootDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await handle.db.delete(workspaces);
  await handle.db.delete(plans);
  await ensureDefaultPlans(deps());
});

async function newClient(tag: string): Promise<AncsClient> {
  const email = `${tag}-${randomUUID()}@test.local`;
  await createInternalUser(auth, { email, password: PASSWORD, name: tag });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: PASSWORD });
  return client;
}

async function makeProject(client: AncsClient): Promise<{ workspaceId: string; projectId: string }> {
  const workspace = await client.workspaces.create({ name: `文档-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '栏目' });
  const project = await client.projects.create(workspace.id, { title: '文档项目', channelId: channel.id });
  return { workspaceId: workspace.id, projectId: project.id };
}

async function expectApiError(promise: Promise<unknown>, status: number, reason?: string): Promise<AncsApiError> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AncsApiError);
  const apiError = error as AncsApiError;
  expect(apiError.status).toBe(status);
  if (reason !== undefined) expect((apiError.details as { reason?: string }).reason).toBe(reason);
  return apiError;
}

describe('文档导入（P10-01）', () => {
  it('Markdown：GFM 表格保留（columns/rows）+ 标题/列表/引用 + 出处（内容寻址 URN + 哈希）', async () => {
    const client = await newClient('doc-md');
    const { workspaceId, projectId } = await makeProject(client);
    const record = await client.content.importDocument(workspaceId, projectId, {
      filename: 'monthly-report.md',
      contentType: 'text/markdown',
      data: new TextEncoder().encode(MARKDOWN_FIXTURE),
    });
    expect(record.document.title).toBe('平台月报');
    const table = record.document.blocks.find((block) => block.type === 'table');
    expect(table?.table?.columns).toEqual(['指标', '本月', '上月']);
    expect(table?.table?.rows).toHaveLength(2);
    expect(table?.table?.rows[0]).toEqual(['活跃创作者', '1,024', '968']);
    expect(record.document.blocks.some((block) => block.type === 'list' && block.items?.length === 2)).toBe(true);
    expect(record.document.blocks.some((block) => block.type === 'quote')).toBe(true);
    // 出处：URN + sha256 + 警告（图片/链接）
    const sources = await client.content.sources(workspaceId, projectId);
    expect(sources[0]?.url.startsWith('urn:ancs:document:')).toBe(true);
    expect(sources[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(record.normalization.notes.some((note) => note.includes('documentKind=MARKDOWN'))).toBe(true);
    expect(record.normalization.tables).toBe(1);
  }, 120_000);

  it('DOCX：表格保留；嵌入图片明确警告；dc:title 作为标题提示', async () => {
    const client = await newClient('doc-docx');
    const { workspaceId, projectId } = await makeProject(client);
    const record = await client.content.importDocument(workspaceId, projectId, {
      filename: 'quarterly.docx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      data: buildDocx(),
    });
    const table = record.document.blocks.find((block) => block.type === 'table');
    expect(table?.table?.columns).toEqual(['季度', '收入（万元）']);
    expect(table?.table?.rows).toEqual([['Q1', '120'], ['Q2', '158']]);
    expect(record.document.blocks.some((block) => block.type === 'heading' && block.text === '季度增长报告')).toBe(true);
    expect(record.normalization.notes.some((note) => note.includes('嵌入图片未提取'))).toBe(true);
    expect(record.document.title).toBe('季度增长报告'); // 首个标题优先于 dc:title（更贴近正文）
  }, 120_000);

  it('PDF：文本层提取 + 缺页逐页记录；**扫描件（无文本层）→ 422 SCANNED_PDF_NO_TEXT（不伪造成功）**', async () => {
    const client = await newClient('doc-pdf');
    const { workspaceId, projectId } = await makeProject(client);

    // 有文本 + 第二页无文本 → 抽出段落并记录缺页
    const partial = buildPdf([['Quarterly report', 'Revenue grew 32 percent.'], []]);
    const record = await client.content.importDocument(workspaceId, projectId, { filename: 'report.pdf', contentType: 'application/pdf', data: partial });
    expect(record.document.blocks.filter((block) => block.type === 'paragraph').length).toBeGreaterThanOrEqual(1);
    expect(record.normalization.notes.some((note) => note.includes('无文本页：2'))).toBe(true);
    expect(record.normalization.notes.some((note) => note.includes('PDF 共 2 页'))).toBe(true);

    // 全页无文本（图片型/扫描件）→ 明确 422，绝不返回空文档
    const scanned = buildPdf([[], []]);
    await expectApiError(
      client.content.importDocument(workspaceId, projectId, { filename: 'scanned.pdf', contentType: 'application/pdf', data: scanned }),
      422,
      'SCANNED_PDF_NO_TEXT',
    );

    // 损坏 PDF → 422 DOCUMENT_PARSE_FAILED（明确原因）
    await expectApiError(
      client.content.importDocument(workspaceId, projectId, { filename: 'broken.pdf', contentType: 'application/pdf', data: new TextEncoder().encode('%PDF-1.4 broken without xref') }),
      422,
      'DOCUMENT_PARSE_FAILED',
    );
  }, 120_000);

  it('Newsletter：.eml（multipart → text/html；附件列明不提取）与 .html 导出件', async () => {
    const client = await newClient('doc-news');
    const { workspaceId, projectId } = await makeProject(client);
    const record = await client.content.importDocument(workspaceId, projectId, {
      filename: 'weekly-42.eml',
      contentType: 'message/rfc822',
      data: new TextEncoder().encode(EML_FIXTURE),
    });
    expect(record.document.title).toContain('每周精选 #42');
    expect(record.document.blocks.some((block) => block.type === 'heading' && (block.text ?? '').includes('每周精选'))).toBe(true);
    const table = record.document.blocks.find((block) => block.type === 'table');
    expect(table?.table?.rows[0]).toEqual(['科技', '12']);
    expect(record.normalization.notes.some((note) => note.includes('附件未提取：附件.pdf'))).toBe(true);
    expect(record.normalization.sourceType).toBe('NEWSLETTER_IMPORT');

    const html = await client.content.importDocument(workspaceId, projectId, {
      filename: 'newsletter.html',
      contentType: 'text/html; charset=utf-8',
      data: new TextEncoder().encode('<html><body><h1>导出简报</h1><p>正文段落一。</p></body></html>'),
    });
    expect(html.document.blocks.some((block) => block.type === 'heading')).toBe(true);
    expect(html.normalization.notes.some((note) => note.includes('documentKind=NEWSLETTER_HTML'))).toBe(true);
  }, 120_000);

  it('安全与错误处理：EICAR 文档 → 422（未解析）+ 审计；不支持的扩展名 → 415；空文件 → 400', async () => {
    const client = await newClient('doc-sec');
    const { workspaceId, projectId } = await makeProject(client);

    const infected = EICAR + '\n# 标题\n正文。';
    await expectApiError(
      client.content.importDocument(workspaceId, projectId, { filename: 'notes.md', contentType: 'text/markdown', data: new TextEncoder().encode(infected) }),
      422,
      'MALWARE_DETECTED',
    );

    await expectApiError(
      client.content.importDocument(workspaceId, projectId, { filename: 'archive.xyz', contentType: 'application/octet-stream', data: new Uint8Array([1, 2, 3]) }),
      415,
      'UNKNOWN_DOCUMENT_KIND',
    );

    await expectApiError(
      client.content.importDocument(workspaceId, projectId, { filename: 'empty.md', contentType: 'text/markdown', data: new Uint8Array(0) }),
      400,
      'EMPTY_INPUT',
    );

    // 文档数量不受失败导入影响（markdown 仅成功导入 0 个）
    expect(await client.content.list(workspaceId, projectId)).toHaveLength(0);
  }, 120_000);
});
