import { describe, expect, it } from 'vitest';
import { ApiFailure, MAX_ARTICLE_CHARS, type ArticleFetcher } from '@ancs/contracts';
import { fetchStudioArticle } from './content.js';
import type { DomainDeps } from './deps.js';

/**
 * 从链接导入文章（V6 文章讲述的起点）：抓取 → 抽正文 → 给用户核对；不写库。
 * 只读文本块（标题、段落、引用、列表），表格与图片不进讲述原文；过长按段截断并如实标出。
 */
const fetcherWith = (contentType: string | null, body: string, finalUrl = 'https://news.example/final'): ArticleFetcher => ({
  kind: 'scripted',
  fetch: async () => ({ finalUrl, contentType, bytes: new TextEncoder().encode(body) }),
});
const deps = (fetcher: ArticleFetcher): DomainDeps => ({ articleFetcher: fetcher } as unknown as DomainDeps);

describe('fetchStudioArticle', () => {
  it('HTML → 标题 + 正文（段落、引用、列表逐行；表格、图片、脚本不进原文），带最终来源与站点', async () => {
    const html = `<html><head><title>站点标题</title><script>var x = 1;</script></head><body>
      <h1>中美谈判背后潜藏的机会</h1>
      <p>第一段：双方在 2027 年前的关税安排。</p>
      <blockquote>一句引用。</blockquote>
      <ul><li>要点一</li><li>要点二</li></ul>
      <table><tr><td>表格</td></tr></table><img src="x.png" alt="图">
    </body></html>`;
    const draft = await fetchStudioArticle(deps(fetcherWith('text/html; charset=utf-8', html)), { url: 'https://news.example/a' });
    expect(draft.title).toBe('中美谈判背后潜藏的机会');
    expect(draft.text.split('\n\n')).toEqual(['中美谈判背后潜藏的机会', '第一段：双方在 2027 年前的关税安排。', '一句引用。', '· 要点一', '· 要点二']);
    expect(draft.text).not.toContain('var x');
    expect(draft.text).not.toContain('表格');
    expect(draft.sourceUrl).toBe('https://news.example/final');
    expect(draft.publisher).toBe('news.example');
    expect(draft.paragraphs).toBe(5);
    expect(draft.truncated).toBe(false);
  });

  it('正文里没有标题时取网页 <title>', async () => {
    const draft = await fetchStudioArticle(deps(fetcherWith('text/html', '<html><head><title>Fresh water &amp; ice</title></head><body><p>Only 2.5 percent of all water is fresh.</p></body></html>')), { url: 'https://news.example/w' });
    expect(draft.title).toBe('Fresh water & ice');
    expect(draft.text).toBe('Only 2.5 percent of all water is fresh.');
  });

  it('超过文章上限：按段截断（不截半段），并标出 truncated', async () => {
    const paragraph = '这是一段很长的正文。'.repeat(200);
    const text = Array.from({ length: 40 }, () => paragraph).join('\n\n');
    const draft = await fetchStudioArticle(deps(fetcherWith('text/plain', text)), { url: 'https://news.example/long' });
    expect(draft.truncated).toBe(true);
    expect(draft.text.length).toBeLessThanOrEqual(MAX_ARTICLE_CHARS);
    expect(draft.text.split('\n\n').every((line) => line === paragraph)).toBe(true);
  });

  it('明确结果：内网地址被拦（SSRF）、不是文章、空正文、没装抓取器', async () => {
    const reason = async (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => (error instanceof ApiFailure ? [error.httpStatus, error.details['reason'] ?? null] : String(error)));
    expect(await reason(fetchStudioArticle(deps(fetcherWith('text/html', '<p>x</p>')), { url: 'http://127.0.0.1/a' }))).toEqual([403, 'BLOCKED_TARGET']);
    expect(await reason(fetchStudioArticle(deps(fetcherWith('image/png', 'x')), { url: 'https://news.example/p.png' }))).toEqual([415, 'UNSUPPORTED_CONTENT_TYPE']);
    expect(await reason(fetchStudioArticle(deps(fetcherWith('text/html', '<html><body><img src="a.png"></body></html>')), { url: 'https://news.example/e' }))).toEqual([422, 'EMPTY_CONTENT']);
    expect(await reason(fetchStudioArticle({} as DomainDeps, { url: 'https://news.example/a' }))).toEqual([500, null]);
  });
});
