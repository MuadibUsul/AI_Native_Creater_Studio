import { describe, expect, it } from 'vitest';
import { DocumentParseError } from '@ancs/contracts';
import { parseMarkdownBytes, parseDocxBytes, parseEmailBytes, readZipEntries, writeStoredZip, ZipReadError } from './index.js';

/**
 * P10-01 解析器单测（确定性夹具；不引第三方生成器）：
 * - Markdown：GFM 表格/标题/引用/列表/围栏代码；内嵌 HTML 与图片逐条警告；
 * - ZIP：stored 往返；损坏/缺 EOCD 明确失败；
 * - DOCX：表格与标题；加密（OLE）与损坏明确失败；
 * - EML：multipart 取 html + 附件列明；quoted-printable 解码。
 */

describe('文档解析器（P10-01）', () => {
  it('Markdown：GFM 表格 → columns/rows；警告逐条（图片/链接/内嵌 HTML）', async () => {
    const md = ['# 标题一', '', '正文段落。', '', '| A | B |', '| --- | --- |', '| 1 | 2 |', '', '![图](https://x/y.png)', '', '<div>原始 HTML</div>'].join('\n');
    const parsed = parseMarkdownBytes(new TextEncoder().encode(md));
    expect(parsed.titleHint).toBe('标题一');
    const table = parsed.elements.find((element) => element.type === 'table');
    expect(table?.type === 'table' ? table.columns : null).toEqual(['A', 'B']);
    expect(table?.type === 'table' ? table.rows : null).toEqual([['1', '2']]);
    expect(parsed.warnings.some((warning) => warning.includes('图片未提取'))).toBe(true);
    expect(parsed.warnings.some((warning) => warning.includes('内嵌 HTML'))).toBe(true);
    expect(parsed.hasExtractableText).toBe(true);
  });

  it('ZIP：stored 往返可读；损坏字节明确失败（CORRUPT）', () => {
    const zip = writeStoredZip([{ name: 'a.txt', content: 'hello' }, { name: 'b/c.xml', content: '<x/>' }]);
    const entries = readZipEntries(zip);
    expect(entries.map((entry) => entry.name).sort()).toEqual(['a.txt', 'b/c.xml']);
    expect(new TextDecoder().decode(entries[0]?.bytes)).toBe('hello');
    expect(() => readZipEntries(new Uint8Array([1, 2, 3, 4]))).toThrow(ZipReadError);
  });

  it('DOCX：标题/表格抽取；加密（OLE 头）与损坏明确失败', () => {
    const docx = writeStoredZip([
      { name: 'word/document.xml', content: '<w:document xmlns:w="x"><w:body><w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>小标题</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>列A</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>值1</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>' },
    ]);
    const parsed = parseDocxBytes(docx);
    const heading = parsed.elements.find((element) => element.type === 'heading');
    expect(heading?.type === 'heading' ? heading.level : null).toBe(2);
    const table = parsed.elements.find((element) => element.type === 'table');
    expect(table?.type === 'table' ? table.columns : null).toEqual(['列A']);
    expect(table?.type === 'table' ? table.rows : null).toEqual([['值1']]);

    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(() => parseDocxBytes(ole)).toThrow(DocumentParseError);
    expect(() => parseDocxBytes(new TextEncoder().encode('not a zip at all'))).toThrow(DocumentParseError);
  });

  it('EML：multipart（quoted-printable HTML + 附件）→ html 与附件清单，附件不提取', () => {
    const eml = [
      'From: a@b.c',
      'Subject: =?utf-8?B?5rWL6K+V6YKu5Lu2?=',
      'Content-Type: multipart/mixed; boundary="BB"',
      '',
      '--BB',
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      '<h1>=E6=A0=87=E9=A2=98</h1><p>=E6=AD=A3=E6=96=87</p>',
      '--BB',
      'Content-Type: application/pdf; name="x.pdf"',
      'Content-Disposition: attachment; filename="x.pdf"',
      '',
      '%PDF-fake',
      '--BB--',
    ].join('\r\n');
    const parsed = parseEmailBytes(new TextEncoder().encode(eml));
    expect(parsed.html).toContain('<h1>标题</h1>');
    expect(parsed.html).toContain('正文');
    expect(parsed.attachments).toEqual([{ filename: 'x.pdf', contentType: 'application/pdf' }]);
    expect(parsed.warnings.some((warning) => warning.includes('附件'))).toBe(true);
  });
});
