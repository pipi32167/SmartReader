export interface PdfPageInfo {
  pageNum: number;
  text: string;
}

/**
 * 将多页 PDF 文本信息组装为语义化 HTML。
 * 输出结构：
 * <article>
 *   <section>
 *     <h2>第 N 页</h2>
 *     <p>段落1</p>
 *     <p>段落2</p>
 *   </section>
 * </article>
 */
export function buildPdfHtml(pages: PdfPageInfo[]): string {
  if (pages.length === 0) {
    return '<article></article>';
  }

  const sections = pages.map((page) => {
    const paragraphs = page.text
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .map((p) => `<p>${escapeHtml(p)}</p>`)
      .join('\n');

    return `<section>\n<h2>第 ${page.pageNum} 页</h2>\n${paragraphs || '<p></p>'}\n</section>`;
  });

  return `<article>\n${sections.join('\n')}\n</article>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
