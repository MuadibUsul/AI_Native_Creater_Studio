import { describe, expect, it } from 'vitest';
import {
  assertSafeUrl,
  decodeContentBytes,
  detectLanguage,
  extractBlocksFromHtml,
  extractBlocksFromText,
  isBlockedAddress,
  resolveCharset,
  stableBlockId,
} from './content-extract.js';

/**
 * 输入归一化的确定性部分（P04-01 单元验收）：
 * SSRF 守卫、编码解码（含错误编码的明确失败）、HTML/文本抽取、稳定块 ID、语言推断。
 */

describe('SSRF 守卫（安全限制有明确结果）', () => {
  it('拒绝非 http(s) 协议、非法 URL、缺主机名', () => {
    expect(() => assertSafeUrl('ftp://example.com/a')).toThrow(/http\/https/);
    expect(() => assertSafeUrl('javascript:alert(1)')).toThrow(/http\/https/);
    expect(() => assertSafeUrl('not a url')).toThrow(/形态非法/);
    // https:///path 会被 WHATWG 解析为 host=path（单标签）→ 由单标签规则拒绝
    expect(() => assertSafeUrl('https:///path')).toThrow(/单标签|安全限制/);
    expect(() => assertSafeUrl(`https://example.com/${'a'.repeat(3000)}`)).toThrow(/过长/);
  });

  it('拒绝回环/私网/链路本地/元数据地址与非允许端口', () => {
    for (const host of ['127.0.0.1', 'localhost', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0']) {
      expect(() => assertSafeUrl(`http://${host}/article`)).toThrow(/安全限制/);
    }
    expect(() => assertSafeUrl('http://metadata/a')).toThrow(/单标签/); // 常见内网服务名/元数据端点形态
    expect(() => assertSafeUrl('http://[::1]/a')).toThrow(/安全限制/);
    expect(() => assertSafeUrl('http://[fd00::1]/a')).toThrow(/安全限制/);
    expect(() => assertSafeUrl('http://example.com:22/a')).toThrow(/端口/);
    expect(() => assertSafeUrl('http://example.com:6379/a')).toThrow(/端口/);
    // 允许：公网 http(s) 与白名单端口
    expect(assertSafeUrl('https://example.com/news/1').hostname).toBe('example.com');
    expect(assertSafeUrl('http://example.com:8080/a').port).toBe('8080');
  });

  it('isBlockedAddress 边界：组播/保留段/非法形态视为不可信', () => {
    expect(isBlockedAddress('224.0.0.1')).toBe(true);
    expect(isBlockedAddress('999.1.1.1')).toBe(true);
    expect(isBlockedAddress('8.8.8.8')).toBe(false);
    expect(isBlockedAddress('::ffff:192.168.0.1')).toBe(true);
    expect(isBlockedAddress('2001:4860:4860::8888')).toBe(false);
  });
});

describe('编码解码（错误编码有明确结果）', () => {
  it('Content-Type 头 charset 优先；其次 meta；最后 UTF-8 默认', () => {
    expect(resolveCharset('text/html; charset=GBK', '<meta charset="utf-8">')).toMatchObject({ charset: 'gbk', source: 'header' });
    expect(resolveCharset('text/html', '<head><meta charset="Big5"></head>')).toMatchObject({ charset: 'big5', source: 'meta' });
    expect(resolveCharset('text/html', '<head><meta http-equiv="Content-Type" content="text/html; charset=gb2312"></head>')).toMatchObject({ charset: 'gbk', source: 'meta' });
    expect(resolveCharset('text/html', '<html></html>')).toMatchObject({ charset: 'utf-8', source: 'default' });
  });

  it('UTF-8 与 GBK 正确解码；未知 charset → ENCODING_UNSUPPORTED', () => {
    const utf8 = Buffer.from('<p>你好，世界</p>', 'utf8');
    expect(decodeContentBytes(new Uint8Array(utf8), 'text/html; charset=utf-8').text).toBe('<p>你好，世界</p>');

    // GBK 字节（"中文" = D6 D0 CE C4）
    const gbk = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]);
    const decodedGbk = decodeContentBytes(gbk, 'text/html; charset=gb2312');
    expect(decodedGbk.text).toBe('中文');
    expect(decodedGbk.charset).toBe('gbk');

    // 用 UTF-8 解 GBK 字节：替换字符占比过高 → 明确失败（而不是静默输出乱码）
    const failure = (() => {
      try {
        decodeContentBytes(gbk, 'text/html; charset=utf-8');
        return null;
      } catch (error) {
        return error as { details?: { reason?: string } };
      }
    })();
    expect(failure?.details?.reason).toBe('ENCODING_UNSUPPORTED');

    // 完全未知 charset → 明确失败
    const unknown = (() => {
      try {
        decodeContentBytes(new Uint8Array([0x41, 0x42]), 'text/html; charset=x-unknown-9');
        return null;
      } catch (error) {
        return error as { details?: { reason?: string; charset?: string } };
      }
    })();
    expect(unknown?.details).toMatchObject({ reason: 'ENCODING_UNSUPPORTED', charset: 'x-unknown-9' });
  });
});

describe('HTML 抽取（结构 → 块）', () => {
  const html = `<!doctype html><html><head><title>标题</title><script>var x=1;</script><style>.a{}</style></head>
  <body>
    <nav>导航噪声</nav>
    <h1>美联储的决定</h1>
    <p>这是第一段 <strong>重要</strong> 内容。</p>
    <p>&nbsp;第二段&mdash;带实体</p>
    <blockquote>引用的话</blockquote>
    <ul><li>要点一</li><li>要点二</li></ul>
    <table>
      <thead><tr><th>年份</th><th>利率</th></tr></thead>
      <tbody><tr><td>2024</td><td>5.25%</td></tr><tr><td>2025</td><td>4.50%</td></tr></tbody>
    </table>
    <figure><img src="https://img.example/chart.png" alt="利率走势图"><figcaption>图 1</figcaption></figure>
    <footer>页脚噪声</footer>
  </body></html>`;

  it('抽取标题/段落/引用/列表/表格/图片，且剥离 script/style/nav/footer 噪声', () => {
    const blocks = extractBlocksFromHtml(html);
    const types = blocks.map((block) => block.type);
    expect(types).toContain('heading');
    expect(types).toContain('paragraph');
    expect(types).toContain('quote');
    expect(types).toContain('list');
    expect(types).toContain('table');
    expect(types).toContain('image');
    expect(JSON.stringify(blocks)).not.toContain('导航噪声');
    expect(JSON.stringify(blocks)).not.toContain('页脚噪声');
    expect(JSON.stringify(blocks)).not.toContain('var x=1');

    const heading = blocks.find((block) => block.type === 'heading');
    expect(heading).toMatchObject({ text: '美联储的决定', level: 1 });
    const paragraph = blocks.find((block) => block.type === 'paragraph' && block.text?.includes('第一段'));
    expect(paragraph?.text).toBe('这是第一段 重要 内容。');
    const quote = blocks.find((block) => block.type === 'quote');
    expect(quote?.text).toBe('引用的话');
    const list = blocks.find((block) => block.type === 'list');
    expect(list?.items).toEqual(['要点一', '要点二']);
    const table = blocks.find((block) => block.type === 'table');
    expect(table?.table).toEqual({ columns: ['年份', '利率'], rows: [['2024', '5.25%'], ['2025', '4.50%']] });
    const image = blocks.find((block) => block.type === 'image');
    expect(image).toMatchObject({ text: '利率走势图', note: 'https://img.example/chart.png' });
  });

  it('实体解码与重复块 ID 稳定', () => {
    const blocks = extractBlocksFromHtml('<p>同一段</p><p>同一段</p>');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.id).not.toBe(blocks[1]?.id); // 重复内容追加序号
    expect(blocks[0]?.id.startsWith('blk_')).toBe(true);
    // 稳定：同样输入两次 → 相同 ID
    const again = extractBlocksFromHtml('<p>同一段</p><p>同一段</p>');
    expect(again.map((block) => block.id)).toEqual(blocks.map((block) => block.id));
    expect(stableBlockId('heading', 'x')).toBe(stableBlockId('heading', 'x'));
  });

  it('空正文（只有噪声）→ 无块（上层给出 EMPTY_CONTENT）', () => {
    expect(extractBlocksFromHtml('<html><head><script>x</script></head><body><nav>菜单</nav></body></html>')).toHaveLength(0);
  });
});

describe('文本/手写脚本抽取', () => {
  it('PASTED_TEXT：Markdown 风格标题/引用/列表/表格/段落', () => {
    const text = `# 大标题

第一段内容。

- 列表项 A
- 列表项 B

> 引用

| 年份 | 数值 |
| --- | --- |
| 2024 | 5.25 |
| 2025 | 4.50 |

结尾段落。`;
    const blocks = extractBlocksFromText(text, 'PASTED_TEXT');
    expect(blocks.map((block) => block.type)).toEqual(['heading', 'paragraph', 'list', 'quote', 'table', 'paragraph']);
    expect(blocks[0]).toMatchObject({ text: '大标题', level: 1 });
    expect(blocks.find((block) => block.type === 'table')?.table).toEqual({
      columns: ['年份', '数值'],
      rows: [['2024', '5.25'], ['2025', '4.50']],
    });
  });

  it('MANUAL_SCRIPT：每非空行一段（保持作者分行意图）', () => {
    const blocks = extractBlocksFromText('开场：讲个故事\n\n第一幕\n第二幕', 'MANUAL_SCRIPT');
    expect(blocks).toHaveLength(3);
    expect(blocks.map((block) => block.text)).toEqual(['开场：讲个故事', '第一幕', '第二幕']);
  });

  it('语言推断（zh/ja/ko/en/unknown）', () => {
    expect(detectLanguage('这是一篇中文文章，讨论利率与市场。')).toBe('zh');
    expect(detectLanguage('これは日本語の文章です。')).toBe('ja');
    expect(detectLanguage('이것은 한국어 문장입니다.')).toBe('ko');
    expect(detectLanguage('This is an English article about markets.')).toBe('en');
    expect(detectLanguage('12345 !@#$%')).toBe('unknown');
  });
});
