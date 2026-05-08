import { describe, it, expect } from 'vitest';
import { buildPdfHtml, type PdfPageInfo } from './pdf-to-html';

describe('buildPdfHtml', () => {
  it('将单页文本组装为包含 h2 和 p 的 HTML', () => {
    const pages: PdfPageInfo[] = [
      { pageNum: 1, text: 'Hello world\n\nThis is a test.' },
    ];
    const html = buildPdfHtml(pages);
    expect(html).toContain('<h2>第 1 页</h2>');
    expect(html).toContain('<p>Hello world</p>');
    expect(html).toContain('<p>This is a test.</p>');
    expect(html).toContain('<article>');
    expect(html).toContain('</article>');
  });

  it('空页面数组返回最小合法 HTML', () => {
    const html = buildPdfHtml([]);
    expect(html).toBe('<article></article>');
  });

  it('多页输入包含多个 section', () => {
    const pages: PdfPageInfo[] = [
      { pageNum: 1, text: 'Page one content' },
      { pageNum: 2, text: 'Page two content' },
    ];
    const html = buildPdfHtml(pages);
    expect(html).toContain('<h2>第 1 页</h2>');
    expect(html).toContain('<h2>第 2 页</h2>');
    const sectionCount = (html.match(/<section>/g) || []).length;
    expect(sectionCount).toBe(2);
  });

  it('转义 HTML 特殊字符', () => {
    const pages: PdfPageInfo[] = [
      { pageNum: 1, text: '5 < 10 && 10 > 5\n\nUse "quotes" & ampersand' },
    ];
    const html = buildPdfHtml(pages);
    expect(html).toContain('&lt;');
    expect(html).toContain('&gt;');
    expect(html).toContain('&quot;');
    expect(html).toContain('&amp;');
    expect(html).not.toContain('5 < 10');
  });

  it('单换行不拆分段落，双换行才拆分', () => {
    const pages: PdfPageInfo[] = [
      { pageNum: 1, text: 'Line one\nLine two\n\nParagraph two' },
    ];
    const html = buildPdfHtml(pages);
    expect(html).toContain('<p>Line one\nLine two</p>');
    expect(html).toContain('<p>Paragraph two</p>');
  });

  it('空文本段落被过滤', () => {
    const pages: PdfPageInfo[] = [
      { pageNum: 1, text: 'A\n\n\n\nB' },
    ];
    const html = buildPdfHtml(pages);
    const pMatches = html.match(/<p>/g) || [];
    expect(pMatches.length).toBe(2);
  });
});
